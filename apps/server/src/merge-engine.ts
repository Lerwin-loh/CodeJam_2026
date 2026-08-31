import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentRunner,
  AgentCheckpoint,
  ChangedFiles,
  ConversationCommit,
  AgentRun,
  Message,
  MergeCombinedDecision,
  MergePreview,
  MergeProvenance,
  MergeResolution,
  MergeResult,
  MergeSide,
  WorkspaceManifest,
  WorkspaceSnapshot,
} from "./types.js";
import { WorkspaceHistory } from "./workspace-history.js";

const execFileAsync = promisify(execFile);

export interface MergeAiResolver {
  chooseWorkspace?(input: { preview: MergePreview; path: string; targetContent: string | null; sourceContent: string | null; baseContent: string | null }): Promise<MergeWorkspaceDecision | "target" | "source">;
  summarizeOutcome?(input: { outcome: MergeSide["outcome"] }): Promise<string>;
}

export type MergeWorkspaceDecision =
  | { choice: "target" | "source"; explanation: string; satisfiesAllCriteria?: boolean }
  | ({ choice: "combined" } & MergeCombinedDecision);

export interface MergeResolutionResult {
  conversation: ConversationCommit[];
  context: Record<string, "target" | "source" | "combined">;
  workspace: Record<string, "target" | "source" | "combined">;
  combinedContent: Record<string, string>;
  combined: Record<string, MergeCombinedDecision>;
  aiDecisions: Record<string, string>;
  provenance: MergeProvenance[];
}

export function conversationCommits(messages: Message[], runs: AgentRun[], checkpoints: AgentCheckpoint[] = []): ConversationCommit[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const assistants = new Map<string, Message>();
  for (const message of messages) {
    if (message.kind !== "merge" && message.role === "assistant") assistants.set(message.runId, message);
  }
  return messages
    .filter((message) => message.kind !== "merge" && message.role === "user")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((message) => {
      const run = runById.get(message.runId);
      const response = assistants.get(message.runId);
      const checkpoint = run?.checkpointId ? checkpointById.get(run.checkpointId) : undefined;
      return {
        id: message.runId,
        runId: message.runId,
        branchId: message.branchId,
        prompt: message.content,
        response: response?.content ?? run?.output ?? null,
        createdAt: message.createdAt,
        changedPaths: checkpoint ? changedFilePaths(checkpoint.changedFiles) : [],
      };
    });
}

/** Uses a throwaway runner request; it deliberately bypasses AgentService persistence. */
export function createIsolatedMergeAiResolver(runner: AgentRunner): MergeAiResolver {
  return {
    async summarizeOutcome(input) {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "launchpad-merge-summary-"));
      try {
        const result = await runner.run({
          agentId: "merge-summary-" + randomUUID(),
          workspacePath,
          threadId: null,
          prompt: [
            "You are summarizing a completed software change for a merge review.",
            "Write 2–5 concise bullet points in your own words describing what the change now does.",
            "Describe the resulting behavior and important integrations, not the request, file list, setup instructions, or conversational filler.",
            "Do not begin with All set, Here's what was built, Created, Files, or Here's what was changed.",
            "Return only the bullet points.",
            JSON.stringify(input.outcome),
          ].join("\n\n"),
        });
        return cleanSummary(result.output);
      } finally {
        await rm(workspacePath, { recursive: true, force: true });
      }
    },
    async chooseWorkspace(input) {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "launchpad-merge-ai-"));
      try {
        const result = await runner.run({
          agentId: "merge-resolver-" + randomUUID(),
          workspacePath,
          threadId: null,
          prompt: [
            "You are an isolated merge resolver. Do not edit files. Return JSON with exactly this shape: {\"choice\":\"TARGET\", \"SOURCE\", or \"COMBINED\", \"satisfiesAllCriteria\":true/false, \"content\":\"required and complete for COMBINED\", \"mergePrompt\":\"required for COMBINED\", \"explanation\":\"one concise sentence\"}.",
            "Check every combined acceptance criterion against the actual TARGET and SOURCE implementations before choosing. TARGET or SOURCE is legal only when that exact implementation satisfies every criterion; set satisfiesAllCriteria true only in that case.",
            "If either implementation misses even one criterion, or the criteria are split across both implementations, COMBINED is mandatory. Never choose a side just because it satisfies more criteria.",
            "For COMBINED, return the complete merged file content, not a patch, and a concise human-readable instruction describing how the two implementations were combined.",
            "Choose the implementation that best satisfies the complete acceptance criteria and preserves downstream dependencies.",
            "Prefer an identity implementation that supports verification, recovery, and existing integrations over one that removes those capabilities.",
            "Evaluate this file independently. The final merge may keep some files from TARGET and other files from SOURCE; never choose a side merely to keep one branch intact.",
            JSON.stringify(input.preview),
            "Workspace conflict: " + input.path,
            "TARGET IMPLEMENTATION:\n" + (input.targetContent ?? "<deleted>"),
            "BASE IMPLEMENTATION:\n" + (input.baseContent ?? "<deleted>"),
            "SOURCE IMPLEMENTATION:\n" + (input.sourceContent ?? "<deleted>"),
          ].join("\n\n"),
        });
        return parseAiDecision(result.output);
      } finally {
        await rm(workspacePath, { recursive: true, force: true });
      }
    },
  };
}

export class MergeConflictError extends Error {
  constructor(public readonly preview: MergePreview) {
    super("Resolve every merge conflict before applying the merge.");
  }
}

/** Reusable, pairwise, side-effect-free preview and atomic workspace merge engine. */
export class MergeEngine {
  constructor(private readonly history: WorkspaceHistory, private readonly aiResolver?: MergeAiResolver) {}

  async preview(target: MergeSide, source: MergeSide): Promise<MergePreview> {
    const targetManifest = await this.history.manifest(target.workspacePath);
    const sourceManifest = await this.history.manifest(source.workspacePath);
    const baseManifest = target.baseSnapshot?.manifest ?? source.baseSnapshot?.manifest ?? null;
    const paths = new Set([
      ...targetManifest.files.map((file) => file.path),
      ...sourceManifest.files.map((file) => file.path),
      ...(baseManifest?.files.map((file) => file.path) ?? []),
    ]);
    const changedFiles: ChangedFiles = { created: [], modified: [], deleted: [] };
    const conflicts: MergePreview["workspaceConflicts"] = [];
    const combinedFiles: MergePreview["combinedFiles"] = [];
    for (const filePath of [...paths].sort()) {
      // AGENTS.md is platform-managed and must never be merged from a branch.
      if (filePath === "AGENTS.md") continue;
      const targetContent = await this.read(target.workspacePath, filePath);
      const sourceContent = await this.read(source.workspacePath, filePath);
      const baseContent = baseManifest ? await this.history.readSnapshotFile(target.baseSnapshot ?? source.baseSnapshot!, filePath) : null;
      const targetChanged = !same(targetContent, baseContent);
      const sourceChanged = !same(sourceContent, baseContent);
      if (targetChanged || sourceChanged) {
        const category = baseContent === null && (targetContent !== null || sourceContent !== null) ? "created" : baseContent !== null && targetContent === null && sourceContent === null ? "deleted" : "modified";
        changedFiles[category].push(filePath);
      }
      if (targetChanged && sourceChanged && !same(targetContent, sourceContent)) {
        const merged = baseContent !== null && targetContent !== null && sourceContent !== null
          ? await gitThreeWayMerge(baseContent, targetContent, sourceContent)
          : { content: null, conflict: true };
        if (merged.conflict) {
          conflicts.push({ path: filePath, targetContent, sourceContent, baseContent });
        } else if (merged.content !== null && merged.content !== targetContent && merged.content !== sourceContent) {
          combinedFiles.push({ path: filePath, targetPrompts: [], sourcePrompts: [] });
        }
      }
    }
    const baseConversation = (target.baseConversation ?? source.baseConversation ?? []).map((commit) => ({ ...commit, origin: "base" as const }));
    const targetConversation = target.conversation.map((commit) => ({ ...commit, origin: "target" as const }));
    const sourceConversation = source.conversation.map((commit) => ({ ...commit, origin: "source" as const }));
    const targetChangedPaths = changedPaths(targetManifest, baseManifest);
    const sourceChangedPaths = changedPaths(sourceManifest, baseManifest);
    const actualConflictPaths = conflicts
      .map((conflict) => conflict.path)
      .filter((filePath) => !filePath.startsWith("semantic:"));
    const targetPaths = await this.identityPaths(target.workspacePath, targetChangedPaths);
    const sourcePaths = await this.identityPaths(source.workspacePath, sourceChangedPaths);
    const hasActualIdentityConflict = actualConflictPaths.some((filePath) =>
      targetPaths.includes(filePath) && sourcePaths.includes(filePath),
    );
    // Semantic identity checks are supplemental to a real file-level merge
    // conflict. Never manufacture a prompt conflict merely because two
    // unrelated files mention email and username.
    if (hasActualIdentityConflict) {
      const targetContent = await this.readMany(target.workspacePath, targetPaths);
      const sourceContent = await this.readMany(source.workspacePath, sourcePaths);
      if (hasLoginIdentityCodeConflict(targetContent, sourceContent)) {
        conflicts.push({ path: "semantic:login-identity", targetContent, sourceContent, baseContent: null, targetPaths, sourcePaths });
      }
    }
    for (const combined of combinedFiles) {
      combined.targetPrompts = promptContributors(targetConversation, baseConversation, [combined.path]);
      combined.sourcePrompts = promptContributors(sourceConversation, baseConversation, [combined.path]);
    }
    const contextConflicts = linkPromptConflicts(conflicts, targetConversation, sourceConversation, baseConversation, target.id, source.id);
    const targetOutcome = await summarizeOutcome(target.outcome, this.aiResolver);
    const sourceOutcome = await summarizeOutcome(source.outcome, this.aiResolver);
    return {
      target: targetOutcome,
      source: sourceOutcome,
      targetPrompts: target.prompts,
      sourcePrompts: source.prompts,
      baseConversation,
      targetConversation,
      sourceConversation,
      acceptanceCriteria: combineAcceptanceCriteria(targetOutcome, sourceOutcome),
      changedFiles,
      workspaceConflicts: conflicts,
      contextConflicts,
      combinedFiles,
    };
  }

  async resolve(preview: MergePreview, resolution: MergeResolution): Promise<MergeResolutionResult> {
    const missingWorkspace = preview.workspaceConflicts.some((conflict) => !resolution.workspace[conflict.path]);
    if (missingWorkspace) throw new MergeConflictError(preview);
    const context: Record<string, "target" | "source" | "combined"> = {};
    const combinedContent: Record<string, string> = {};
    const combined: Record<string, MergeCombinedDecision> = {};
    const aiDecisions: Record<string, string> = {};
    const combinedInstructions: Record<string, string> = {};
    const workspace: Record<string, "target" | "source" | "combined"> = {};
    for (const [path, choice] of Object.entries(resolution.workspace)) {
      if (choice !== "ai") {
        workspace[path] = choice;
        if (choice === "combined") {
          const decision = resolution.combined?.[path];
          if (!decision) throw new MergeConflictError(preview);
          validateCombinedDecision(decision, preview);
          combined[path] = decision;
          combinedContent[path] = decision.content;
          combinedInstructions[path] = decision.mergePrompt;
        }
      }
    }
    for (const conflict of preview.workspaceConflicts) {
      if (resolution.workspace[conflict.path] === "ai") {
        const aiChoice = await this.aiResolver?.chooseWorkspace?.({ preview, path: conflict.path, targetContent: conflict.targetContent, sourceContent: conflict.sourceContent, baseContent: conflict.baseContent }) ?? "target";
        const decision = normalizeWorkspaceDecision(aiChoice);
        if (decision.choice === "combined" && conflict.path.startsWith("semantic:")) {
          workspace[conflict.path] = "target";
          aiDecisions["workspace:" + conflict.path] = "AI selected the target implementation for the grouped semantic conflict.";
        } else {
          if (decision.choice === "combined") validateCombinedDecision(decision, preview);
          workspace[conflict.path] = decision.choice;
          if (decision.choice === "combined") {
            combined[conflict.path] = decision;
            combinedContent[conflict.path] = decision.content;
            combinedInstructions[conflict.path] = decision.mergePrompt;
          }
          aiDecisions["workspace:" + conflict.path] = decision.explanation;
        }
      }
    }
    const semantic = preview.workspaceConflicts.find((conflict) => conflict.path.startsWith("semantic:"));
    if (semantic && (workspace[semantic.path] === "target" || workspace[semantic.path] === "source")) {
      const relatedPaths = new Set([...(semantic.targetPaths ?? []), ...(semantic.sourcePaths ?? [])]);
      for (const conflict of preview.workspaceConflicts) {
        if (relatedPaths.has(conflict.path) && resolution.workspace[conflict.path] === "ai" && workspace[conflict.path] !== "combined") {
          workspace[conflict.path] = workspace[semantic.path]!;
        }
      }
    }
    for (const conflict of preview.contextConflicts) {
      const choices = new Set(conflict.paths.map((path) => workspace[path] ?? "target"));
      context[conflict.id] = choices.size === 1 && !choices.has("combined")
        ? [...choices][0] as "target" | "source"
        : "combined";
    }
    const provenance: MergeProvenance[] = preview.combinedFiles
      .filter((item) => item.targetPrompts.length > 0 && item.sourcePrompts.length > 0)
      .map((item) => ({
        id: "merge:auto:" + item.path,
        paths: [item.path],
        targetPrompts: item.targetPrompts,
        sourcePrompts: item.sourcePrompts,
        mergePrompt: `Combine the non-conflicting changes from the target and source implementations of ${item.path}.`,
        explanation: "The three-way merge retained compatible code from both sides.",
        mode: "automatic",
      }));
    for (const conflict of preview.contextConflicts.filter((item) => context[item.id] === "combined")) {
      const instructions = conflict.paths.map((path) => combinedInstructions[path]).filter(Boolean);
      provenance.push({
        id: "merge:combined:" + conflict.id,
        paths: conflict.paths,
        targetPrompts: conflict.targetCommits ?? [conflict.target],
        sourcePrompts: conflict.sourceCommits ?? [conflict.source],
        mergePrompt: instructions[0] ?? buildCombinedMergePrompt(conflict),
        explanation: instructions.length > 0 ? aiDecisions["workspace:" + conflict.paths.find((path) => combinedInstructions[path])!] ?? "AI combined both implementations." : "The selected file decisions use code from both sides.",
        mode: instructions.length > 0 ? "ai" : "automatic",
      });
    }
    const mergedConversation = buildConversationMerge(
      preview.baseConversation,
      preview.targetConversation,
      preview.sourceConversation,
      preview.contextConflicts,
    ).merge((conflict) => context[conflict.id] ?? "combined");
    return { conversation: mergedConversation, context, workspace, combinedContent, combined, aiDecisions, provenance };
  }

  async apply(target: MergeSide, source: MergeSide, resolution: MergeResolution, persist: (manifest: WorkspaceManifest, conversation: ConversationCommit[], provenance: MergeProvenance[]) => Promise<WorkspaceSnapshot | null>): Promise<MergeResult> {
    const preview = await this.preview(target, source);
    const resolved = await this.resolve(preview, resolution);
    const staging = path.join(path.dirname(target.workspacePath), ".merge-staging-" + randomUUID());
    const backup = path.join(path.dirname(target.workspacePath), ".merge-backup-" + randomUUID());
    let swapped = false;
    await cp(target.workspacePath, staging, { recursive: true });
    try {
      const targetManifest = await this.history.manifest(target.workspacePath);
      const sourceManifest = await this.history.manifest(source.workspacePath);
      const baseManifest = target.baseSnapshot?.manifest ?? source.baseSnapshot?.manifest ?? null;
      const paths = new Set([...targetManifest.files.map((file) => file.path), ...sourceManifest.files.map((file) => file.path), ...(baseManifest?.files.map((file) => file.path) ?? [])]);
      for (const filePath of paths) {
        if (filePath === "AGENTS.md") continue;
        const targetContent = await this.read(target.workspacePath, filePath);
        const sourceContent = await this.read(source.workspacePath, filePath);
        const baseContent = baseManifest ? await this.history.readSnapshotFile(target.baseSnapshot ?? source.baseSnapshot!, filePath) : null;
        const targetChanged = !same(targetContent, baseContent);
        const sourceChanged = !same(sourceContent, baseContent);
        const conflict = preview.workspaceConflicts.find((item) => item.path === filePath);
        const merged = !conflict && baseContent !== null && targetContent !== null && sourceContent !== null && targetChanged && sourceChanged && !same(targetContent, sourceContent)
          ? await gitThreeWayMerge(baseContent, targetContent, sourceContent)
          : null;
        if (conflict && !resolved.workspace[filePath]) throw new MergeConflictError(preview);
        const combinedValue = resolved.combinedContent[filePath];
        if (conflict && resolved.workspace[filePath] === "combined" && combinedValue === undefined) {
          throw new MergeConflictError(preview);
        }
        const value: string | null = conflict
          ? resolved.workspace[filePath] === "combined"
            ? combinedValue!
            : resolved.workspace[filePath] === "source" ? sourceContent : targetContent
          : merged && !merged.conflict ? merged.content : sourceChanged ? sourceContent : targetContent;
        if (!targetChanged && !sourceChanged) continue;
        const destination = path.join(staging, filePath);
        if (value === null) await rm(destination, { force: true });
        else { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, value, "utf8"); }
      }
      for (const conflict of preview.workspaceConflicts.filter((item) => item.targetPaths && item.sourcePaths)) {
        const choice = resolved.workspace[conflict.path] === "source" ? "source" : "target";
        const targetPaths = new Set(conflict.targetPaths ?? []);
        const sourcePaths = new Set(conflict.sourcePaths ?? []);
        const removePaths = choice === "source"
          ? [...targetPaths].filter((filePath) => !sourcePaths.has(filePath))
          : [...sourcePaths].filter((filePath) => !targetPaths.has(filePath));
        for (const filePath of removePaths) await rm(path.join(staging, filePath), { force: true });
      }
      const manifest = await this.history.manifest(staging);
      await rename(target.workspacePath, backup);
      await rename(staging, target.workspacePath);
      swapped = true;
      const snapshot = await persist(manifest, resolved.conversation, resolved.provenance);
      await rm(backup, { recursive: true, force: true });
      return { preview, conversation: resolved.conversation, provenance: resolved.provenance, snapshot };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (swapped) {
        await rm(target.workspacePath, { recursive: true, force: true });
        await rename(backup, target.workspacePath).catch(() => undefined);
      } else if (await exists(backup)) {
        await rename(backup, target.workspacePath).catch(() => undefined);
      }
      throw error;
    }
  }

  private async read(workspacePath: string, filePath: string): Promise<string | null> {
    try { return await readFile(path.join(workspacePath, filePath), "utf8"); } catch { return null; }
  }

  private async readMany(workspacePath: string, filePaths: string[]): Promise<string> {
    return (await Promise.all(filePaths.map(async (filePath) => "--- " + filePath + "\n" + (await this.read(workspacePath, filePath) ?? "<deleted>")))).join("\n");
  }

  private async identityPaths(workspacePath: string, filePaths: string[]): Promise<string[]> {
    const paths = await Promise.all(filePaths.map(async (filePath) => {
      const content = await this.read(workspacePath, filePath);
      return /login|auth|sign.?in|verify|verification|identity|credential/i.test(filePath)
        || /\b(?:email|username|user.?name|verification|verify|password)\b/i.test(content ?? "")
        ? filePath
        : null;
    }));
    return paths.filter((filePath): filePath is string => filePath !== null);
  }
}

async function gitThreeWayMerge(base: string, target: string, source: string): Promise<{ content: string | null; conflict: boolean }> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "launchpad-git-merge-"));
  const basePath = path.join(workspacePath, "base");
  const targetPath = path.join(workspacePath, "target");
  const sourcePath = path.join(workspacePath, "source");
  try {
    await Promise.all([writeFile(basePath, base), writeFile(targetPath, target), writeFile(sourcePath, source)]);
    try {
      const result = await execFileAsync("git", ["merge-file", "-p", targetPath, basePath, sourcePath], { maxBuffer: 10 * 1024 * 1024 });
      return { content: result.stdout, conflict: false };
    } catch (error) {
      const exitCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
      return { content: null, conflict: exitCode === 1 || exitCode === "1" };
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

function same(left: string | null, right: string | null): boolean { return left === right; }
async function exists(filePath: string): Promise<boolean> { try { await lstat(filePath); return true; } catch { return false; } }
async function summarizeOutcome(outcome: MergeSide["outcome"], resolver?: MergeAiResolver): Promise<MergeSide["outcome"]> {
  if (!resolver?.summarizeOutcome) return { ...outcome, summary: cleanSummary(outcome.summary) };
  try {
    const summary = await resolver.summarizeOutcome({ outcome });
    const bullets = summaryBullets(summary);
    return bullets.length ? { ...outcome, summary: bullets[0]!, details: bullets } : { ...outcome, summary: cleanSummary(summary) };
  } catch {
    return { ...outcome, summary: cleanSummary(outcome.summary) };
  }
}
function cleanSummary(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").replace(/^\s*(?:all set[.!:]?|here(?:'|’)s what was built\s*:?[.!]?|here(?:'|’)s what was changed\s*:?[.!]?|created\s+[^.]+\s+in the workspace\s*:?[.!]?)\s*/i, "").trim();
  return cleaned || "The completed changes are ready to merge.";
}
function summaryBullets(value: string): string[] {
  return value.replace(/\s+-\s+/g, "\n").split(/\r?\n/).map((line) => line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim())
    .filter((line) => line && !/^(?:all set|here(?:'|’)s what was built|here(?:'|’)s what was changed|files|how it works|to actually|want me to)\b/i.test(line))
    .map(cleanSummary)
    .filter(Boolean)
    .slice(0, 5);
}
function parseAiDecision(output: string): MergeWorkspaceDecision {
  const json = output.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as { choice?: unknown; satisfiesAllCriteria?: unknown; content?: unknown; mergePrompt?: unknown; explanation?: unknown };
      const normalized = String(parsed.choice ?? "").toLowerCase();
      const choice = normalized === "source" ? "source" : normalized === "combined" ? "combined" : "target";
      const explanation = typeof parsed.explanation === "string" && parsed.explanation.trim()
        ? parsed.explanation.trim()
        : `AI kept the ${choice} implementation based on the combined merge criteria.`;
      if (choice === "combined") {
        const content = typeof parsed.content === "string" ? parsed.content : "";
        const mergePrompt = typeof parsed.mergePrompt === "string" ? parsed.mergePrompt.trim() : "";
        const combinedExplanation = typeof parsed.explanation === "string" ? parsed.explanation.trim() : "";
        return { choice, content, mergePrompt, explanation: combinedExplanation };
      }
      if (parsed.satisfiesAllCriteria !== true) {
        return { choice: "combined", content: "", mergePrompt: "", explanation: "AI did not verify that one implementation satisfies every acceptance criterion." };
      }
      return { choice, explanation, satisfiesAllCriteria: true };
    } catch { /* fall through to safe token parsing */ }
  }
  const decision = output.trim().match(/^(TARGET|SOURCE|COMBINED)\b/i)?.[1] ?? output.match(/(?:^|\n)\s*(TARGET|SOURCE|COMBINED)\s*(?:$|\n)/i)?.[1];
  const choice = decision?.toLowerCase() === "source" ? "source" : decision?.toLowerCase() === "combined" ? "combined" : "target";
  if (choice === "combined") {
    return { choice, content: "", mergePrompt: "", explanation: "AI requested a combined file but did not return a valid complete file body." };
  }
  return { choice, explanation: `AI kept the ${choice} implementation based on the combined merge criteria.` };
}
function normalizeWorkspaceDecision(decision: MergeWorkspaceDecision | "target" | "source"): MergeWorkspaceDecision {
  if (typeof decision === "string") return { choice: decision, explanation: `AI kept the ${decision} implementation based on the combined merge criteria.` };
  return decision;
}

function validateCombinedDecision(decision: MergeCombinedDecision, preview: MergePreview): void {
  if (!decision.content.trim() || decision.content.length > 200_000 || !decision.mergePrompt.trim() || !decision.explanation.trim()) {
    throw new MergeConflictError(preview);
  }
}

function combineAcceptanceCriteria(target: MergeSide["outcome"], source: MergeSide["outcome"]): string[] {
  const requirements = [...target.details, ...source.details].map((item) => item.trim()).filter(Boolean);
  return [...new Set([
    target.summary.trim(),
    source.summary.trim(),
    ...requirements,
    "All non-conflicting changes from the target and source outcomes are present.",
    "Every workspace and context conflict is explicitly resolved.",
  ])].filter(Boolean);
}

function changedPaths(manifest: WorkspaceManifest, base: WorkspaceManifest | null): string[] {
  if (!base) return manifest.files.map((file) => file.path).filter((filePath) => filePath !== "AGENTS.md");
  const before = new Map(base.files.map((file) => [file.path, file]));
  const changed = manifest.files.filter((file) => {
    const previous = before.get(file.path);
    return !previous || previous.sha256 !== file.sha256 || previous.mode !== file.mode;
  }).map((file) => file.path);
  const deleted = base.files.filter((file) => !manifest.files.some((current) => current.path === file.path)).map((file) => file.path);
  return [...new Set([...changed, ...deleted])].filter((filePath) => filePath !== "AGENTS.md");
}

function changedFilePaths(changed: ChangedFiles): string[] {
  return [...new Set([...changed.created, ...changed.modified, ...changed.deleted])]
    .filter((filePath) => filePath !== "AGENTS.md")
    .sort();
}

function promptContributors(
  commits: ConversationCommit[],
  base: ConversationCommit[],
  paths: string[],
): ConversationCommit[] {
  const baseIds = new Set(base.map((commit) => commit.id));
  const wanted = new Set(paths);
  return commits.filter((commit) => !baseIds.has(commit.id) && (commit.changedPaths ?? []).some((filePath) => wanted.has(filePath)));
}

function conflictPaths(conflict: MergePreview["workspaceConflicts"][number]): string[] {
  return conflict.path.startsWith("semantic:")
    ? [...new Set([...(conflict.targetPaths ?? []), ...(conflict.sourcePaths ?? [])])]
    : [conflict.path];
}

function linkPromptConflicts(
  workspaceConflicts: MergePreview["workspaceConflicts"],
  target: ConversationCommit[],
  source: ConversationCommit[],
  base: ConversationCommit[],
  targetSideId: string,
  sourceSideId: string,
): MergePreview["contextConflicts"] {
  const byPair = new Map<string, MergePreview["contextConflicts"][number]>();
  for (const workspaceConflict of workspaceConflicts) {
    const paths = conflictPaths(workspaceConflict);
    const targetCommits = promptContributors(target, base, paths);
    const sourceCommits = promptContributors(source, base, paths);
    if (targetCommits.length === 0 || sourceCommits.length === 0) continue;
    const key = [...targetCommits.map((commit) => "t:" + commit.id), ...sourceCommits.map((commit) => "s:" + commit.id)].sort().join(":");
    const current = byPair.get(key);
    if (current) {
      current.paths = [...new Set([...current.paths, ...paths])];
      continue;
    }
    byPair.set(key, {
      id: "prompt:" + targetSideId + ":" + sourceSideId + ":" + byPair.size,
      target: targetCommits[0]!,
      source: sourceCommits[0]!,
      targetCommits,
      sourceCommits,
      paths: [...paths],
      targetSideId,
      sourceSideId,
    });
  }
  return [...byPair.values()];
}

function hasLoginIdentityCodeConflict(target: string, source: string): boolean {
  const targetEmail = /\bemail\b/i.test(target);
  const targetUsername = /\buser(?:name|_name)\b/i.test(target);
  const sourceEmail = /\bemail\b/i.test(source);
  const sourceUsername = /\buser(?:name|_name)\b/i.test(source);
  return (targetEmail && !targetUsername && sourceUsername && !sourceEmail)
    || (targetUsername && !targetEmail && sourceEmail && !sourceUsername);
}

function buildCombinedMergePrompt(conflict: MergePreview["contextConflicts"][number]): string {
  const files = conflict.paths.join(", ");
  return `Combine the target and source code changes for ${files}, preserving compatible behavior from both implementations.`;
}

interface ConversationMergeResult {
  conflicts: MergePreview["contextConflicts"];
  merge: (choice: (conflict: MergePreview["contextConflicts"][number]) => "target" | "source" | "combined") => ConversationCommit[];
}

function buildConversationMerge(
  base: ConversationCommit[],
  target: ConversationCommit[],
  source: ConversationCommit[],
  suppliedConflicts: MergePreview["contextConflicts"] = [],
): ConversationMergeResult {
  const baseIds = new Set(base.map((commit) => commit.id));
  const targetById = new Map(target.map((commit) => [commit.id, commit]));
  const sourceById = new Map(source.map((commit) => [commit.id, commit]));
  const conflicts: MergePreview["contextConflicts"] = suppliedConflicts;
  const conflictByTarget = new Map<string, MergePreview["contextConflicts"][number]>();
  const conflictBySource = new Map<string, MergePreview["contextConflicts"][number]>();

  for (const conflict of conflicts) {
    for (const commit of conflict.targetCommits ?? [conflict.target]) conflictByTarget.set(commit.id, conflict);
    for (const commit of conflict.sourceCommits ?? [conflict.source]) conflictBySource.set(commit.id, conflict);
  }

  const additions = (commits: ConversationCommit[]) => {
    const result = new Map<string, ConversationCommit[]>();
    let anchor = "__start__";
    for (const commit of commits) {
      if (baseIds.has(commit.id)) {
        anchor = commit.id;
      } else {
        const list = result.get(anchor) ?? [];
        list.push(commit);
        result.set(anchor, list);
      }
    }
    return result;
  };
  const targetAdditions = additions(target);
  const sourceAdditions = additions(source);
  return {
    conflicts,
    merge: (choice) => {
      const result: ConversationCommit[] = [];
      const emitAnchor = (anchor: string) => {
        const targetCommits = targetAdditions.get(anchor) ?? [];
        const sourceCommits = sourceAdditions.get(anchor) ?? [];
        const emitted = new Set<string>();
        for (const targetCommit of targetCommits) {
          const conflict = conflictByTarget.get(targetCommit.id);
          if (conflict) {
            const selectedChoice = choice(conflict);
            if (selectedChoice !== "source" && !emitted.has(targetCommit.id)) {
              result.push(targetCommit);
              emitted.add(targetCommit.id);
            }
          } else if (!emitted.has(targetCommit.id)) {
            result.push(targetCommit);
            emitted.add(targetCommit.id);
          }
        }
        for (const sourceCommit of sourceCommits) {
          const conflict = conflictBySource.get(sourceCommit.id);
          if (conflict && choice(conflict) === "target") continue;
          if (!emitted.has(sourceCommit.id)) {
            result.push(sourceCommit);
            emitted.add(sourceCommit.id);
          }
        }
      };
      emitAnchor("__start__");
      for (const baseCommit of base) {
        const targetCommit = targetById.get(baseCommit.id);
        const sourceCommit = sourceById.get(baseCommit.id);
        if (targetCommit && sourceCommit) {
          if (sameConversationCommit(targetCommit, baseCommit)) result.push({ ...targetCommit, origin: "base" });
          else {
            result.push(targetCommit);
            if (!sameConversationCommit(sourceCommit, baseCommit) && sourceCommit.id !== targetCommit.id) result.push(sourceCommit);
          }
        } else if (targetCommit ?? sourceCommit) {
          const selected = targetCommit ?? sourceCommit!;
          result.push(sameConversationCommit(selected, baseCommit) ? { ...selected, origin: "base" } : selected);
        }
        emitAnchor(baseCommit.id);
      }
      return result;
    },
  };
}

function sameConversationCommit(left: ConversationCommit, right: ConversationCommit): boolean {
  return left.prompt === right.prompt && left.response === right.response;
}

export function outcomeDetails(runOutput: string, fileSummary: string): string[] {
  const lines = runOutput.split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9])/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").replace(/`/g, "").trim()).filter(Boolean);
  const details = lines.length ? lines : [];
  if (fileSummary) details.push("Files: " + fileSummary);
  return details.length ? [...new Set(details)] : ["No file changes recorded."];
}

export function outcomeSummary(runOutput: string, fileSummary: string): string {
  const first = runOutput.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (first) {
    const summary = first.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").replace(/`/g, "").replace(/[.!?]+$/, "");
    return (summary.length > 180 ? summary.slice(0, 177).trimEnd() + "…" : summary) + ".";
  }
  return fileSummary ? "Workspace changes are ready to merge." : "No file changes recorded.";
}

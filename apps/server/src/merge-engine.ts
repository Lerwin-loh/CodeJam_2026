import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentRunner,
  ChangedFiles,
  ConversationCommit,
  AgentRun,
  Message,
  MergePreview,
  MergeResolution,
  MergeResult,
  MergeSide,
  WorkspaceManifest,
  WorkspaceSnapshot,
} from "./types.js";
import { WorkspaceHistory } from "./workspace-history.js";

const execFileAsync = promisify(execFile);

export interface MergeAiResolver {
  choosePrompt(input: { preview: MergePreview; conflictId: string; target: ConversationCommit; source: ConversationCommit }): Promise<"target" | "source" | { choice: "target" | "source"; explanation: string }>;
  chooseWorkspace?(input: { preview: MergePreview; path: string; targetContent: string | null; sourceContent: string | null }): Promise<"target" | "source" | { choice: "target" | "source"; explanation: string }>;
  summarizeOutcome?(input: { outcome: MergeSide["outcome"] }): Promise<string>;
}

export function conversationCommits(messages: Message[], runs: AgentRun[]): ConversationCommit[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const assistants = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "assistant") assistants.set(message.runId, message);
  }
  return messages
    .filter((message) => message.role === "user")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((message) => {
      const run = runById.get(message.runId);
      const response = assistants.get(message.runId);
      return {
        id: message.runId,
        runId: message.runId,
        branchId: message.branchId,
        prompt: message.content,
        response: response?.content ?? run?.output ?? null,
        createdAt: message.createdAt,
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
    async choosePrompt(input) {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "launchpad-merge-ai-"));
      try {
        const result = await runner.run({
          agentId: "merge-resolver-" + randomUUID(),
          workspacePath,
          threadId: null,
          prompt: [
            "You are an isolated merge resolver. Do not edit files. Return JSON with exactly this shape: {\"choice\":\"TARGET\" or \"SOURCE\",\"explanation\":\"one concise sentence\"}.",
            "Choose the prompt that best satisfies the complete combined acceptance criteria and workspace outcomes.",
            "Evaluate this conflict independently. The final merge may keep some prompts from TARGET and other prompts from SOURCE; never choose a side merely to keep one branch intact.",
            JSON.stringify(input.preview),
            "Conflict " + input.conflictId,
            "TARGET COMMIT:\n" + JSON.stringify(input.target),
            "SOURCE COMMIT:\n" + JSON.stringify(input.source),
          ].join("\n\n"),
        });
        return parseAiDecision(result.output);
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
            "You are an isolated merge resolver. Do not edit files. Return JSON with exactly this shape: {\"choice\":\"TARGET\" or \"SOURCE\",\"explanation\":\"one concise sentence\"}.",
            "Choose the implementation that best satisfies the complete acceptance criteria and preserves downstream dependencies.",
            "Prefer an identity implementation that supports verification, recovery, and existing integrations over one that removes those capabilities.",
            "Evaluate this file independently. The final merge may keep some files from TARGET and other files from SOURCE; never choose a side merely to keep one branch intact.",
            JSON.stringify(input.preview),
            "Workspace conflict: " + input.path,
            "TARGET IMPLEMENTATION:\n" + (input.targetContent ?? "<deleted>"),
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
        if (merged.conflict) conflicts.push({ path: filePath, targetContent, sourceContent, baseContent });
      }
    }
    const baseConversation = (target.baseConversation ?? source.baseConversation ?? []).map((commit) => ({ ...commit, origin: "base" as const }));
    const targetConversation = target.conversation.map((commit) => ({ ...commit, origin: "target" as const }));
    const sourceConversation = source.conversation.map((commit) => ({ ...commit, origin: "source" as const }));
    const conversationMerge = buildConversationMerge(
      baseConversation,
      targetConversation,
      sourceConversation,
      target.id,
      source.id,
    );
    const targetChangedPaths = changedPaths(targetManifest, baseManifest);
    const sourceChangedPaths = changedPaths(sourceManifest, baseManifest);
    if (conversationMerge.conflicts.some((conflict) => hasLoginIdentityConflict(conflict.target.prompt, conflict.source.prompt))) {
      const targetPaths = await this.identityPaths(target.workspacePath, targetChangedPaths);
      const sourcePaths = await this.identityPaths(source.workspacePath, sourceChangedPaths);
      if (targetPaths.length > 0 && sourcePaths.length > 0) {
        const targetContent = await this.readMany(target.workspacePath, targetPaths);
        const sourceContent = await this.readMany(source.workspacePath, sourcePaths);
        conflicts.push({ path: "semantic:login-identity", targetContent, sourceContent, baseContent: null, targetPaths, sourcePaths });
      }
    }
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
      contextConflicts: conversationMerge.conflicts,
    };
  }

  async resolve(preview: MergePreview, resolution: MergeResolution): Promise<{ conversation: ConversationCommit[]; context: Record<string, "target" | "source">; workspace: Record<string, "target" | "source">; aiDecisions: Record<string, string> }> {
    const missingWorkspace = preview.workspaceConflicts.some((conflict) => !resolution.workspace[conflict.path]);
    const missingContext = preview.contextConflicts.some((conflict) => !resolution.context[conflict.id]);
    if (missingWorkspace || missingContext) throw new MergeConflictError(preview);
    const context: Record<string, "target" | "source"> = {};
    const aiDecisions: Record<string, string> = {};
    for (const conflict of preview.contextConflicts) {
      const aiChoice = resolution.context[conflict.id] === "ai"
        ? await this.aiResolver?.choosePrompt({ preview, conflictId: conflict.id, target: conflict.target, source: conflict.source }) ?? "target"
        : null;
      const choice: "target" | "source" = aiChoice ? decisionChoice(aiChoice) : resolution.context[conflict.id] === "source" ? "source" : "target";
      if (aiChoice && typeof aiChoice !== "string") aiDecisions["context:" + conflict.id] = aiChoice.explanation;
      context[conflict.id] = choice;
    }
    const workspace: Record<string, "target" | "source"> = {};
    for (const [path, choice] of Object.entries(resolution.workspace)) {
      if (choice !== "ai") workspace[path] = choice;
    }
    const loginPrompt = preview.contextConflicts.find((conflict) => hasLoginIdentityConflict(conflict.target.prompt, conflict.source.prompt));
    const manualLoginChoice: "target" | "source" | null = loginPrompt && resolution.context[loginPrompt.id] !== "ai"
      ? resolution.context[loginPrompt.id] === "source" ? "source" : "target"
      : null;
    const semantic = preview.workspaceConflicts.find((conflict) => conflict.path.startsWith("semantic:login-identity"));
    if (manualLoginChoice && semantic) {
      const relatedPaths = new Set([semantic.path, ...(manualLoginChoice === "target" ? semantic.targetPaths ?? [] : semantic.sourcePaths ?? [])]);
      for (const conflict of preview.workspaceConflicts) {
        if (relatedPaths.has(conflict.path) && resolution.workspace[conflict.path] === "ai") workspace[conflict.path] = manualLoginChoice;
      }
    }
    for (const conflict of preview.workspaceConflicts) {
      if (resolution.workspace[conflict.path] === "ai") {
        const aiChoice = await this.aiResolver?.chooseWorkspace?.({ preview, path: conflict.path, targetContent: conflict.targetContent, sourceContent: conflict.sourceContent }) ?? "target";
        workspace[conflict.path] = decisionChoice(aiChoice);
        if (typeof aiChoice !== "string") aiDecisions["workspace:" + conflict.path] = aiChoice.explanation;
      }
    }
    const mergedConversation = buildConversationMerge(
      preview.baseConversation,
      preview.targetConversation,
      preview.sourceConversation,
      preview.target.id,
      preview.source.id,
    ).merge((conflict) => context[conflict.id] ?? "target");
    return { conversation: mergedConversation, context, workspace, aiDecisions };
  }

  async apply(target: MergeSide, source: MergeSide, resolution: MergeResolution, persist: (manifest: WorkspaceManifest, conversation: ConversationCommit[]) => Promise<WorkspaceSnapshot | null>): Promise<MergeResult> {
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
        const value = conflict ? (resolved.workspace[filePath] === "source" ? sourceContent : targetContent) : merged && !merged.conflict ? merged.content : sourceChanged ? sourceContent : targetContent;
        if (conflict && !resolved.workspace[filePath]) throw new MergeConflictError(preview);
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
      const snapshot = await persist(manifest, resolved.conversation);
      await rm(backup, { recursive: true, force: true });
      return { preview, conversation: resolved.conversation, snapshot };
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
function parseAiDecision(output: string): { choice: "target" | "source"; explanation: string } {
  const json = output.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as { choice?: unknown; explanation?: unknown };
      const choice = String(parsed.choice ?? "").toLowerCase() === "source" ? "source" : "target";
      const explanation = typeof parsed.explanation === "string" && parsed.explanation.trim()
        ? parsed.explanation.trim()
        : `AI kept the ${choice} implementation based on the combined merge criteria.`;
      return { choice, explanation };
    } catch { /* fall through to safe token parsing */ }
  }
  const decision = output.trim().match(/^(TARGET|SOURCE)\b/i)?.[1] ?? output.match(/(?:^|\n)\s*(TARGET|SOURCE)\s*(?:$|\n)/i)?.[1];
  const choice = decision?.toLowerCase() === "source" ? "source" : "target";
  return { choice, explanation: `AI kept the ${choice} implementation based on the combined merge criteria.` };
}
function decisionChoice(decision: "target" | "source" | { choice: "target" | "source"; explanation: string }): "target" | "source" {
  return typeof decision === "string" ? decision : decision.choice;
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

interface ConversationMergeResult {
  conflicts: MergePreview["contextConflicts"];
  merge: (choice: (conflict: MergePreview["contextConflicts"][number]) => "target" | "source") => ConversationCommit[];
}

function buildConversationMerge(
  base: ConversationCommit[],
  target: ConversationCommit[],
  source: ConversationCommit[],
  targetSideId: string,
  sourceSideId: string,
): ConversationMergeResult {
  const baseIds = new Set(base.map((commit) => commit.id));
  const targetById = new Map(target.map((commit) => [commit.id, commit]));
  const sourceById = new Map(source.map((commit) => [commit.id, commit]));
  const conflicts: MergePreview["contextConflicts"] = [];
  const conflictByTarget = new Map<string, MergePreview["contextConflicts"][number]>();
  const conflictBySource = new Map<string, MergePreview["contextConflicts"][number]>();
  const conflictByBase = new Map<string, MergePreview["contextConflicts"][number]>();

  const addConflict = (targetCommit: ConversationCommit, sourceCommit: ConversationCommit, options: { targetDeleted?: boolean; sourceDeleted?: boolean } = {}) => {
    const conflict = {
      id: "prompt:" + targetSideId + ":" + sourceSideId + ":" + conflicts.length,
      target: targetCommit,
      source: sourceCommit,
      targetSideId,
      sourceSideId,
      ...options,
    };
    conflicts.push(conflict);
    conflictByTarget.set(targetCommit.id, conflict);
    conflictBySource.set(sourceCommit.id, conflict);
    conflictByBase.set(targetCommit.id, conflict);
  };

  for (const baseCommit of base) {
    const targetCommit = targetById.get(baseCommit.id);
    const sourceCommit = sourceById.get(baseCommit.id);
    if (targetCommit && sourceCommit && !sameConversationCommit(targetCommit, sourceCommit)) addConflict(targetCommit, sourceCommit);
    else if (!targetCommit && sourceCommit && !sameConversationCommit(baseCommit, sourceCommit)) addConflict(baseCommit, sourceCommit, { targetDeleted: true });
    else if (targetCommit && !sourceCommit && !sameConversationCommit(baseCommit, targetCommit)) addConflict(targetCommit, baseCommit, { sourceDeleted: true });
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
  const anchors = new Set(["__start__", ...base.map((commit) => commit.id)]);
  for (const anchor of [...anchors]) {
    const targetCommits = targetAdditions.get(anchor) ?? [];
    const sourceCommits = sourceAdditions.get(anchor) ?? [];
    if (targetCommits.length === 0 || sourceCommits.length === 0) continue;

    const pairedCount = Math.min(targetCommits.length, sourceCommits.length);
    for (let index = 0; index < pairedCount; index += 1) {
      const targetCommit = targetCommits[index]!;
      const sourceCommit = sourceCommits[index]!;
      if (!sameConversationCommit(targetCommit, sourceCommit)) {
        const sameTurnIntent = isSameConversationIntent(targetCommit, sourceCommit);
        if (sameTurnIntent) addConflict(targetCommit, sourceCommit);
      }
    }

    if (targetCommits.length > pairedCount && sourceCommits.length > pairedCount) {
      for (let index = pairedCount; index < targetCommits.length; index += 1) {
        const targetCommit = targetCommits[index]!;
        const sourceCommit = sourceCommits[index - pairedCount] ?? sourceCommits[sourceCommits.length - 1]!;
        if (isSameConversationIntent(targetCommit, sourceCommit)) {
          addConflict(targetCommit, sourceCommit);
        }
      }
    }
  }

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
            const selectingSource = choice(conflict) === "source";
            if ((selectingSource && conflict.sourceDeleted) || (!selectingSource && conflict.targetDeleted)) continue;
            const selected = selectingSource ? conflict.source : conflict.target;
            if (!emitted.has(selected.id)) {
              result.push(selected);
              emitted.add(selected.id);
            }
          } else if (!emitted.has(targetCommit.id)) {
            result.push(targetCommit);
            emitted.add(targetCommit.id);
          }
        }
        for (const sourceCommit of sourceCommits) {
          if (conflictBySource.has(sourceCommit.id)) continue;
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
        const conflict = conflictByBase.get(baseCommit.id);
        if (conflict) {
          if (conflict) {
            const selectingSource = choice(conflict) === "source";
            if ((selectingSource && conflict.sourceDeleted) || (!selectingSource && conflict.targetDeleted)) continue;
            result.push(selectingSource ? conflict.source : conflict.target);
          }
        } else if (targetCommit && sourceCommit) {
          result.push(sameConversationCommit(targetCommit, baseCommit) ? { ...targetCommit, origin: "base" } : targetCommit);
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

function isSameConversationIntent(left: ConversationCommit, right: ConversationCommit): boolean {
  const leftPrompt = (left.prompt ?? "").trim().toLowerCase();
  const rightPrompt = (right.prompt ?? "").trim().toLowerCase();
  if (!leftPrompt || !rightPrompt) return false;
  if (leftPrompt === rightPrompt) return true;
  const leftWords = new Set(leftPrompt.split(/\W+/).filter(Boolean));
  const rightWords = new Set(rightPrompt.split(/\W+/).filter(Boolean));
  const overlap = [...leftWords].filter((word) => word.length > 2 && rightWords.has(word));
  return overlap.length > 0 && overlap.length >= Math.min(leftWords.size, rightWords.size) * 0.5;
}

function hasLoginIdentityConflict(targetPrompt: string, sourcePrompt: string): boolean {
  const combined = (targetPrompt + " " + sourcePrompt).toLowerCase();
  return /login|sign.?in|authentication|auth/.test(combined) && ((targetPrompt.toLowerCase().includes("email") && sourcePrompt.toLowerCase().includes("username")) || (targetPrompt.toLowerCase().includes("username") && sourcePrompt.toLowerCase().includes("email")));
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

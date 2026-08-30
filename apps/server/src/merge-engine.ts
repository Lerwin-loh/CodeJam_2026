import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentRunner,
  ChangedFiles,
  MergePreview,
  MergeResolution,
  MergeResult,
  MergeSide,
  WorkspaceManifest,
  WorkspaceSnapshot,
} from "./types.js";
import { WorkspaceHistory } from "./workspace-history.js";

export interface MergeAiResolver {
  choosePrompt(input: { preview: MergePreview; conflictId: string; targetPrompt: string; sourcePrompt: string }): Promise<"target" | "source">;
  chooseWorkspace?(input: { preview: MergePreview; path: string; targetContent: string | null; sourceContent: string | null }): Promise<"target" | "source">;
}

/** Uses a throwaway runner request; it deliberately bypasses AgentService persistence. */
export function createIsolatedMergeAiResolver(runner: AgentRunner): MergeAiResolver {
  return {
    async choosePrompt(input) {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "launchpad-merge-ai-"));
      try {
        const result = await runner.run({
          agentId: "merge-resolver-" + randomUUID(),
          workspacePath,
          threadId: null,
          prompt: [
            "You are an isolated merge resolver. Do not edit files. Return exactly TARGET or SOURCE.",
            "Choose the prompt that best satisfies the complete combined acceptance criteria and workspace outcomes.",
            JSON.stringify(input.preview),
            "Conflict " + input.conflictId,
            "TARGET PROMPT: " + input.targetPrompt,
            "SOURCE PROMPT: " + input.sourcePrompt,
          ].join("\n\n"),
        });
        return resolverDecision(result.output);
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
            "You are an isolated merge resolver. Do not edit files. Return exactly TARGET or SOURCE.",
            "Choose the implementation that best satisfies the complete acceptance criteria and preserves downstream dependencies.",
            "Prefer an identity implementation that supports verification, recovery, and existing integrations over one that removes those capabilities.",
            JSON.stringify(input.preview),
            "Workspace conflict: " + input.path,
            "TARGET IMPLEMENTATION:\n" + (input.targetContent ?? "<deleted>"),
            "SOURCE IMPLEMENTATION:\n" + (input.sourceContent ?? "<deleted>"),
          ].join("\n\n"),
        });
        return resolverDecision(result.output);
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
        conflicts.push({ path: filePath, targetContent, sourceContent, baseContent });
      }
    }
    const promptPair = findPromptConflict(target.prompts, source.prompts);
    const contextConflicts = promptPair
      ? [{ id: "prompt:" + target.id + ":" + source.id, targetPrompt: promptPair.target, sourcePrompt: promptPair.source, targetSideId: target.id, sourceSideId: source.id }]
      : [];
    const targetChangedPaths = changedPaths(targetManifest, baseManifest);
    const sourceChangedPaths = changedPaths(sourceManifest, baseManifest);
    if (contextConflicts.length > 0 && hasLoginIdentityConflict(contextConflicts[0]!.targetPrompt, contextConflicts[0]!.sourcePrompt)) {
      const targetPaths = await this.identityPaths(target.workspacePath, targetChangedPaths);
      const sourcePaths = await this.identityPaths(source.workspacePath, sourceChangedPaths);
      if (targetPaths.length > 0 && sourcePaths.length > 0) {
        const targetContent = await this.readMany(target.workspacePath, targetPaths);
        const sourceContent = await this.readMany(source.workspacePath, sourcePaths);
        conflicts.push({ path: "semantic:login-identity", targetContent, sourceContent, baseContent: null, targetPaths, sourcePaths });
      }
    }
    return {
      target: target.outcome,
      source: source.outcome,
      acceptanceCriteria: combineAcceptanceCriteria(target.outcome, source.outcome),
      changedFiles,
      workspaceConflicts: conflicts,
      contextConflicts,
    };
  }

  async resolve(preview: MergePreview, resolution: MergeResolution): Promise<{ keptPrompts: string[]; workspace: Record<string, "target" | "source"> }> {
    const missingWorkspace = preview.workspaceConflicts.some((conflict) => !resolution.workspace[conflict.path]);
    const missingContext = preview.contextConflicts.some((conflict) => !resolution.context[conflict.id]);
    if (missingWorkspace || missingContext) throw new MergeConflictError(preview);
    const keptPrompts: string[] = [];
    for (const conflict of preview.contextConflicts) {
      const choice = resolution.context[conflict.id] === "ai"
        ? await this.aiResolver?.choosePrompt({ preview, conflictId: conflict.id, targetPrompt: conflict.targetPrompt, sourcePrompt: conflict.sourcePrompt }) ?? "target"
        : resolution.context[conflict.id];
      keptPrompts.push(choice === "source" ? conflict.sourcePrompt : conflict.targetPrompt);
    }
    const workspace: Record<string, "target" | "source"> = {};
    for (const [path, choice] of Object.entries(resolution.workspace)) {
      if (choice !== "ai") workspace[path] = choice;
    }
    for (const conflict of preview.workspaceConflicts) {
      if (resolution.workspace[conflict.path] === "ai") {
        workspace[conflict.path] = await this.aiResolver?.chooseWorkspace?.({ preview, path: conflict.path, targetContent: conflict.targetContent, sourceContent: conflict.sourceContent }) ?? "target";
      }
    }
    return { keptPrompts, workspace };
  }

  async apply(target: MergeSide, source: MergeSide, resolution: MergeResolution, persist: (manifest: WorkspaceManifest, keptPrompts: string[]) => Promise<WorkspaceSnapshot | null>): Promise<MergeResult> {
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
        const value = conflict ? (resolved.workspace[filePath] === "source" ? sourceContent : targetContent) : sourceChanged ? sourceContent : targetContent;
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
      const snapshot = await persist(manifest, resolved.keptPrompts);
      await rm(backup, { recursive: true, force: true });
      return { preview, keptPrompts: resolved.keptPrompts, snapshot };
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

function same(left: string | null, right: string | null): boolean { return left === right; }
async function exists(filePath: string): Promise<boolean> { try { await lstat(filePath); return true; } catch { return false; } }
function resolverDecision(output: string): "target" | "source" {
  const decision = output.trim().match(/^(TARGET|SOURCE)$/i)?.[1] ?? output.match(/(?:^|\n)\s*(TARGET|SOURCE)\s*(?:$|\n)/i)?.[1];
  return decision?.toLowerCase() === "source" ? "source" : "target";
}

function combineAcceptanceCriteria(target: MergeSide["outcome"], source: MergeSide["outcome"]): string[] {
  const requirements = [...target.details, ...source.details, ...target.requestedFeatures, ...source.requestedFeatures].map((item) => item.trim()).filter(Boolean);
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

function promptsConflict(targetPrompts: string[], sourcePrompts: string[]): boolean {
  const target = targetPrompts.join(" ").toLowerCase();
  const source = sourcePrompts.join(" ").toLowerCase();
  const contradictoryPairs: Array<[string, string]> = [["username", "email"], ["python", "java"], ["rest", "graphql"], ["sql", "nosql"], ["local", "remote"]];
  return contradictoryPairs.some(([left, right]) => (target.includes(left) && source.includes(right)) || (target.includes(right) && source.includes(left)));
}

function findPromptConflict(targetPrompts: string[], sourcePrompts: string[]): { target: string; source: string } | null {
  const target = targetPrompts.map((prompt) => prompt.trim()).filter(Boolean);
  const source = sourcePrompts.map((prompt) => prompt.trim()).filter(Boolean);
  const contradictory = target.flatMap((targetPrompt) => source.map((sourcePrompt) => ({ target: targetPrompt, source: sourcePrompt })))
    .find((pair) => promptsConflict([pair.target], [pair.source]));
  if (contradictory) return contradictory;
  const firstDifferent = target.flatMap((targetPrompt) => source.map((sourcePrompt) => ({ target: targetPrompt, source: sourcePrompt })))
    .find((pair) => pair.target !== pair.source);
  return firstDifferent ?? null;
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

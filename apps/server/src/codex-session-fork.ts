import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationCommit } from "./types.js";

export interface SessionOffset {
  /** Path to the rollout jsonl file, relative to CODEX_HOME (e.g. "sessions/2026/08/29/rollout-....jsonl"). */
  rolloutRelativePath: string;
  /** Number of lines in the rollout file at the moment this checkpoint was captured. */
  lineOffset: number;
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  source: string;
  model_provider: string;
  cwd: string;
  title: string;
  sandbox_policy: string;
  approval_mode: string;
  cli_version: string;
  first_user_message: string;
  memory_mode: string;
  has_user_event: number;
}

// Codex CLI names its session index "state_<schema-version>.sqlite"; the numeric
// suffix can change between CLI versions, so it must be discovered rather than hardcoded.
function findStateDbPath(codexHome: string): string | null {
  if (!existsSync(codexHome)) return null;
  const candidates = readdirSync(codexHome).filter((name) => /^state_\d+\.sqlite$/.test(name));
  candidates.sort();
  const latest = candidates.at(-1);
  return latest ? path.join(codexHome, latest) : null;
}

function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // Multiple agent containers share this one file; avoid failing immediately on lock contention.
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function relativeRolloutPath(rolloutPathFromDb: string): string | null {
  const marker = "sessions" + path.sep;
  const normalized = rolloutPathFromDb.replaceAll("/", path.sep);
  const index = normalized.indexOf(marker);
  if (index === -1) return null;
  return normalized.slice(index);
}

/**
 * Captures how much of the current Codex thread's rollout transcript exists right now,
 * so a later branch created from this checkpoint can fork only up to this point.
 */
export function captureSessionOffset(codexHome: string, threadId: string | null): SessionOffset | null {
  if (!threadId) return null;
  const dbPath = findStateDbPath(codexHome);
  if (!dbPath) return null;
  try {
    const db = openDb(dbPath);
    try {
      const row = db
        .prepare("SELECT rollout_path FROM threads WHERE id = ?")
        .get(threadId) as { rollout_path: string } | undefined;
      if (!row) return null;
      const relative = relativeRolloutPath(row.rollout_path);
      if (!relative) return null;
      const absolute = path.join(codexHome, relative);
      if (!existsSync(absolute)) return null;
      const lines = readFileLines(absolute);
      return { rolloutRelativePath: relative, lineOffset: lines.length };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readFileLines(absolutePath: string): string[] {
  const raw = readFileSync(absolutePath, "utf8");
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Duplicates a Codex thread's rollout transcript up to a recorded checkpoint offset,
 * registers it as a brand-new resumable thread, and returns the new thread id.
 * Returns null if the fork cannot be performed (missing files, schema mismatch, etc.),
 * in which case callers should fall back to starting a fresh, context-free thread.
 */
export async function forkSessionAtOffset(
  codexHome: string,
  sourceThreadId: string,
  offset: SessionOffset,
): Promise<string | null> {
  const dbPath = findStateDbPath(codexHome);
  if (!dbPath) return null;
  const sourceAbsolute = path.join(codexHome, offset.rolloutRelativePath);
  if (!existsSync(sourceAbsolute)) return null;

  try {
    const raw = await readFile(sourceAbsolute, "utf8");
    const allLines = raw.split("\n");
    if (allLines.at(-1) === "") allLines.pop();
    const truncated = allLines.slice(0, offset.lineOffset);
    if (truncated.length === 0) return null;

    const firstLine = truncated[0];
    if (!firstLine) return null;
    const metaLine = JSON.parse(firstLine) as { type: string; payload?: Record<string, unknown> };
    if (metaLine.type !== "session_meta" || !metaLine.payload) return null;

    const newThreadId = randomUUID();
    metaLine.payload.id = newThreadId;
    truncated[0] = JSON.stringify(metaLine);

    const forkedFilename = "rollout-fork-" + newThreadId + ".jsonl";
    const forkedAbsolute = path.join(path.dirname(sourceAbsolute), forkedFilename);
    await writeFile(forkedAbsolute, truncated.join("\n") + "\n", "utf8");

    const db = openDb(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT rollout_path, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version, first_user_message, memory_mode, has_user_event FROM threads WHERE id = ?",
        )
        .get(sourceThreadId) as ThreadRow | undefined;
      if (!row) return null;

      const newRolloutPath = row.rollout_path.replace(path.basename(row.rollout_path), forkedFilename);
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, cli_version, first_user_message, memory_mode, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)`,
      ).run(
        newThreadId,
        newRolloutPath,
        now,
        now,
        row.source,
        row.model_provider,
        row.cwd,
        row.title,
        row.sandbox_policy,
        row.approval_mode,
        row.has_user_event,
        row.cli_version,
        row.first_user_message,
        row.memory_mode,
      );
      return newThreadId;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export interface MergeSessionSide {
  threadId: string | null;
  rolloutRelativePath: string | null;
  baseLineOffset: number | null;
  baseThreadId?: string | null;
}

/**
 * Creates a new main session from the main transcript at the merge base and
 * appends the selected post-base turn blocks from the target/source rollouts.
 * It is deliberately best-effort: callers can clear the stored thread ID when
 * session files are unavailable, leaving the persisted application timeline intact.
 */
export async function rebuildSessionFromTimeline(
  codexHome: string,
  target: MergeSessionSide,
  source: MergeSessionSide,
  timeline: ConversationCommit[],
): Promise<string | null> {
  const targetPath = target.rolloutRelativePath ? path.join(codexHome, target.rolloutRelativePath) : null;
  const sourcePath = source.rolloutRelativePath ? path.join(codexHome, source.rolloutRelativePath) : null;
  const hasTargetSession = Boolean(target.threadId && targetPath && existsSync(targetPath));
  const hasSourceSession = Boolean(source.threadId && sourcePath && existsSync(sourcePath));
  if (!hasTargetSession && !hasSourceSession) return null;
  if (hasTargetSession && target.baseThreadId && target.baseThreadId !== target.threadId) return null;

  const targetLines = hasTargetSession ? readFileLines(targetPath!) : null;
  const sourceLines = hasSourceSession ? readFileLines(sourcePath!) : null;
  const targetBaseLineOffset = target.baseLineOffset ?? 1;
  if (targetLines && (targetBaseLineOffset < 1 || targetBaseLineOffset > targetLines.length)) return null;

  // Prefer the target session metadata so the merged thread keeps the main
  // agent's model/workspace settings. If main has never run, the source
  // session is the only valid registration template.
  const templateThreadId = hasTargetSession ? target.threadId! : source.threadId!;
  const templateLines = targetLines ?? sourceLines!;
  const templateMetaLine = templateLines[0];
  const mergedLines = targetLines ? targetLines.slice(0, targetBaseLineOffset) : templateLines.slice(0, 1);
  const alreadyIncluded = new Set<string>();
  for (const commit of timeline) {
    if (commit.origin === "base") {
      alreadyIncluded.add(commit.id);
      continue;
    }
    const lines = commit.origin === "source" ? sourceLines : targetLines;
    const startAt = commit.origin === "source" ? 1 : targetBaseLineOffset;
    if (!lines) return null;
    const block = transcriptTurnBlock(lines, commit.prompt, startAt);
    if (!block) return null;
    if (alreadyIncluded.has(commit.id)) continue;
    mergedLines.push(...block);
    alreadyIncluded.add(commit.id);
  }
  return writeRegisteredFork(codexHome, templateThreadId, templateMetaLine, mergedLines);
}

function transcriptTurnBlock(lines: string[], prompt: string, startAt: number): string[] | null {
  const start = lines.findIndex((line, index) => index >= startAt && lineContainsText(line, prompt));
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && isUserMessageLine(line));
  return lines.slice(start, next < 0 ? lines.length : next);
}

function lineContainsText(line: string, text: string): boolean {
  if (line.includes(text)) return true;
  try { return JSON.stringify(JSON.parse(line)).includes(text); } catch { return false; }
}

function isUserMessageLine(line: string): boolean {
  try {
    const value = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string }; message?: { role?: string } };
    return value.type === "user_message" || value.payload?.type === "user_message" || value.payload?.role === "user" || value.message?.role === "user";
  } catch { return line.includes("user_message"); }
}

function writeRegisteredFork(
  codexHome: string,
  sourceThreadId: string,
  sourceMetaLine: string | undefined,
  lines: string[],
): string | null {
  if (!sourceMetaLine) return null;
  const dbPath = findStateDbPath(codexHome);
  if (!dbPath) return null;
  let createdAbsolute: string | null = null;
  try {
    const meta = JSON.parse(sourceMetaLine) as { type?: string; payload?: Record<string, unknown> };
    if (meta.type !== "session_meta" || !meta.payload) return null;
    const newThreadId = randomUUID();
    meta.payload.id = newThreadId;
    lines[0] = JSON.stringify(meta);
    const sourceRowDb = openDb(dbPath);
    try {
      const row = sourceRowDb.prepare("SELECT rollout_path, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version, first_user_message, memory_mode, has_user_event FROM threads WHERE id = ?").get(sourceThreadId) as ThreadRow | undefined;
      if (!row) return null;
      const relativeSource = relativeRolloutPath(row.rollout_path);
      if (!relativeSource) return null;
      const newFilename = "rollout-merge-" + newThreadId + ".jsonl";
      const newAbsolute = path.join(codexHome, path.dirname(relativeSource), newFilename);
      writeFileSync(newAbsolute, lines.join("\n") + "\n");
      createdAbsolute = newAbsolute;
      const newRolloutPath = row.rollout_path.replace(path.basename(row.rollout_path), newFilename);
      const now = Math.floor(Date.now() / 1000);
      sourceRowDb.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, cli_version, first_user_message, memory_mode, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)`).run(newThreadId, newRolloutPath, now, now, row.source, row.model_provider, row.cwd, row.title, row.sandbox_policy, row.approval_mode, row.has_user_event, row.cli_version, row.first_user_message, row.memory_mode);
      return newThreadId;
    } finally {
      sourceRowDb.close();
    }
  } catch {
    if (createdAbsolute) {
      try { unlinkSync(createdAbsolute); } catch { /* best-effort cleanup */ }
    }
    return null;
  }
}

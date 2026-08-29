import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

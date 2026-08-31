import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { captureSessionOffset, forkSessionAtOffset, rebuildSessionFromTimeline } from "./codex-session-fork.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeCodexHome(): Promise<{ codexHome: string; threadId: string; rolloutAbsolutePath: string }> {
  const codexHome = await mkdtemp(path.join(tmpdir(), "codex-home-test-"));
  temporaryDirectories.push(codexHome);
  const threadId = "11111111-1111-1111-1111-111111111111";
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "29");
  await mkdir(sessionsDir, { recursive: true });
  const rolloutAbsolutePath = path.join(sessionsDir, "rollout-test-" + threadId + ".jsonl");

  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      memory_mode TEXT NOT NULL DEFAULT 'enabled'
    )
  `);
  db.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version, first_user_message, memory_mode)
     VALUES (?, ?, ?, ?, 'exec', 'volcengine_ark', '/workspace', 'test thread', '{"type":"danger-full-access"}', 'never', '0.111.0', 'hello', 'enabled')`,
  ).run(threadId, rolloutAbsolutePath, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  db.close();

  return { codexHome, threadId, rolloutAbsolutePath };
}

function turnLines(turnNumber: number): string[] {
  return [
    JSON.stringify({ type: "task_started", turn_id: "turn-" + turnNumber }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "turn " + turnNumber } }),
  ];
}

describe("codex session forking", () => {
  it("captures the current line offset for a thread and forks a truncated copy", async () => {
    const { codexHome, threadId, rolloutAbsolutePath } = await makeCodexHome();

    const metaLine = JSON.stringify({ type: "session_meta", payload: { id: threadId } });
    const turn1 = turnLines(1);
    const turn2 = turnLines(2);
    await writeFile(rolloutAbsolutePath, [metaLine, ...turn1].join("\n") + "\n", "utf8");

    // Checkpoint 1 is captured after only the first turn has been written.
    const offsetAfterTurn1 = captureSessionOffset(codexHome, threadId);
    expect(offsetAfterTurn1).not.toBeNull();
    expect(offsetAfterTurn1?.lineOffset).toBe(1 + turn1.length);

    // A later turn appends more history to the SAME rollout file, simulating
    // further prompts on the same thread after the checkpoint was captured.
    await writeFile(rolloutAbsolutePath, [metaLine, ...turn1, ...turn2].join("\n") + "\n", "utf8");

    const forkedThreadId = await forkSessionAtOffset(codexHome, threadId, offsetAfterTurn1!);
    expect(forkedThreadId).not.toBeNull();
    expect(forkedThreadId).not.toBe(threadId);

    // The forked rollout file must only contain turn 1 — turn 2 must not leak in.
    const forkedDb = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    const row = forkedDb
      .prepare("SELECT rollout_path FROM threads WHERE id = ?")
      .get(forkedThreadId) as { rollout_path: string } | undefined;
    forkedDb.close();
    expect(row).toBeDefined();

    const forkedContent = await readFile(row!.rollout_path, "utf8");
    expect(forkedContent).toContain("turn 1");
    expect(forkedContent).not.toContain("turn 2");
    expect(forkedContent.split("\n").filter(Boolean)).toHaveLength(offsetAfterTurn1!.lineOffset);

    const forkedMeta = JSON.parse(forkedContent.split("\n")[0]);
    expect(forkedMeta.payload.id).toBe(forkedThreadId);
  });

  it("returns null when the thread has no recorded session", () => {
    expect(captureSessionOffset("/nonexistent/path", "some-id")).toBeNull();
    expect(captureSessionOffset("/nonexistent/path", null)).toBeNull();
  });

  it("rebuilds and registers a resolved main transcript from base plus selected units", async () => {
    const { codexHome, threadId, rolloutAbsolutePath } = await makeCodexHome();
    const metaLine = JSON.stringify({ type: "session_meta", payload: { id: threadId } });
    const turn1 = turnLines(1);
    const turn2 = turnLines(2);
    await writeFile(rolloutAbsolutePath, [metaLine, ...turn1, ...turn2].join("\n") + "\n", "utf8");
    const mergedThreadId = await rebuildSessionFromTimeline(
      codexHome,
      { threadId, rolloutRelativePath: "sessions/2026/08/29/rollout-test-" + threadId + ".jsonl", baseLineOffset: 1 + turn1.length, baseThreadId: threadId },
      { threadId, rolloutRelativePath: "sessions/2026/08/29/rollout-test-" + threadId + ".jsonl", baseLineOffset: 1 + turn1.length },
      [
        { id: "base", runId: "base", branchId: null, prompt: "turn 1", response: "base", createdAt: "2026-01-01", origin: "base" },
        { id: "selected", runId: "selected", branchId: "branch", prompt: "turn 2", response: "selected", createdAt: "2026-01-01", origin: "source" },
      ],
    );
    expect(mergedThreadId).not.toBeNull();
    const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(mergedThreadId) as { rollout_path: string } | undefined;
    db.close();
    expect(row).toBeDefined();
    const mergedContent = await readFile(row!.rollout_path, "utf8");
    expect(mergedContent).toContain("turn 1");
    expect(mergedContent).toContain("turn 2");
    expect(mergedContent.match(/turn 1/g)).toHaveLength(1);
    expect(JSON.parse(mergedContent.split("\n")[0]!).payload.id).toBe(mergedThreadId);
  });

  it("can create the first main session from a source session", async () => {
    const { codexHome, threadId, rolloutAbsolutePath } = await makeCodexHome();
    const metaLine = JSON.stringify({ type: "session_meta", payload: { id: threadId } });
    const turn = turnLines(1);
    await writeFile(rolloutAbsolutePath, [metaLine, ...turn].join("\n") + "\n", "utf8");

    const mergedThreadId = await rebuildSessionFromTimeline(
      codexHome,
      { threadId: null, rolloutRelativePath: null, baseLineOffset: null },
      { threadId, rolloutRelativePath: "sessions/2026/08/29/rollout-test-" + threadId + ".jsonl", baseLineOffset: null },
      [{ id: "source", runId: "source", branchId: "branch", prompt: "turn 1", response: "source", createdAt: "2026-01-01", origin: "source" }],
    );

    expect(mergedThreadId).not.toBeNull();
    const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(mergedThreadId) as { rollout_path: string } | undefined;
    db.close();
    expect(row).toBeDefined();
    const mergedContent = await readFile(row!.rollout_path, "utf8");
    expect(mergedContent).toContain("turn 1");
    expect(JSON.parse(mergedContent.split("\n")[0]!).payload.id).toBe(mergedThreadId);
  });
});

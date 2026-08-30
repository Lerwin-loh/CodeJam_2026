import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

/** A stable owner id for tests that do not care about identity. */
async function ownerId(service: AgentService): Promise<string> {
  return (await service.createUser("owner")).id;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" }, await ownerId(service));
    expect(service.listAgents(await ownerId(service))).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents(await ownerId(service))).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" }, await ownerId(service));
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(service.getCheckpoints(agent.id)).toEqual([]);
    expect(service.getTrace(agent.id).map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
    expect(service.getTrace(agent.id)[0]?.metadata.explanation).toContain("began processing");
  });

  it("streams runner events to live trace subscribers", async () => {
    let release!: () => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      release = () => resolve({ output: "done", threadId: "live-thread", usage: null });
    });
    const service = await makeService({
      run: async (request) => {
        request.onEvent?.({
          type: "command_execution",
          metadata: { command: "npm test", status: "in_progress" },
        });
        return pending;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Live trace" });
    const { run } = await service.sendMessage(agent.id, "run tests");
    const received: string[] = [];
    const subscription = service.subscribeToRunTrace(run.id, (event) => received.push(event.type));

    await expect.poll(() => service.getTrace(agent.id).filter((event) => event.runId === run.id).length).toBe(2);
    await expect.poll(() => received).toContain("codex.event");
    expect(service.getTrace(agent.id).find((event) => event.type === "codex.event")?.metadata.explanation)
      .toBe("Codex started running: npm test");
    release();
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    subscription.unsubscribe();
  });

  it("automatically checkpoints meaningful workspace mutations", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "created.txt"), "created by Codex\n");
        return { output: "created a file", threadId: "mutating-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Mutating" }, await ownerId(service));
    const { run } = await service.sendMessage(agent.id, "create a file");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const checkpoints = service.getCheckpoints(agent.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.runId).toBe(run.id);
    expect(checkpoints[0]?.changedFiles).toEqual({
      created: ["created.txt"],
      modified: [],
      deleted: [],
    });
    expect(service.getRun(run.id).checkpointId).toBe(checkpoints[0]?.id);
    expect(service.getTrace(agent.id).map((event) => event.type)).toContain("checkpoint.created");
  });

  it("saves an explicit user-named checkpoint from the current workspace", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "feature.txt"), "v1\n");
        return { output: "added feature", threadId: "explicit-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Namer" }, await ownerId(service));
    const { run } = await service.sendMessage(agent.id, "add a feature");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const auto = service.getCheckpoints(agent.id);
    expect(auto).toHaveLength(1);

    // Unchanged workspace still saves a named marker, reusing the last snapshot.
    const marker = await service.createExplicitCheckpoint(agent.id, "  Working baseline  ");
    expect(marker.reason).toBe("explicit");
    expect(marker.label).toBe("Working baseline");
    expect(marker.status).toBe("complete");
    expect(marker.snapshotId).toBe(auto[0]?.snapshotId);
    expect(marker.parentCheckpointId).toBe(auto[0]?.id);
    expect(marker.changedFiles).toEqual({ created: [], modified: [], deleted: [] });

    // A real change produces its own snapshot.
    await writeFile(path.join(agent.workspacePath, "feature.txt"), "v2\n");
    const changed = await service.createExplicitCheckpoint(agent.id, "after tweak");
    expect(changed.snapshotId).not.toBe(marker.snapshotId);
    expect(changed.changedFiles.modified).toContain("feature.txt");

    const checkpoints = service.getCheckpoints(agent.id);
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0]?.id).toBe(changed.id);
    expect(checkpoints[0]?.parentCheckpointId).toBe(marker.id);

    const details = service.getCheckpointDetails(changed.id);
    expect(details.snapshot.manifest.files.some((file) => file.path === "feature.txt")).toBe(true);
    expect(service.getTrace(agent.id).filter((event) => event.type === "checkpoint.created")).toHaveLength(3);
  });

  it("rejects an explicit checkpoint before the Agent has run", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Fresh" }, await ownerId(service));
    await expect(
      service.createExplicitCheckpoint(agent.id, "nothing yet"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("exposes checkpoint details and a parent comparison", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "details.txt"), "details\n");
        return { output: "saved details", threadId: "details-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Inspectable" }, await ownerId(service));
    const { run } = await service.sendMessage(agent.id, "save details");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const checkpoint = service.getCheckpoints(agent.id)[0];
    expect(checkpoint).toBeDefined();
    if (!checkpoint) return;

    const details = service.getCheckpointDetails(checkpoint.id);
    expect(details.context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(details.trace.some((event) => event.type === "workspace.changed")).toBe(true);
    expect((await service.getCheckpointDiff(checkpoint.id)).changedFiles.created).toContain("details.txt");
  });

  it("restores a checkpoint into an independent workspace", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "restore-me.txt"), "checkpoint state\n");
        return { output: "saved", threadId: "restore-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Restorable" });
    const { run } = await service.sendMessage(agent.id, "save a file");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const checkpoint = service.getCheckpoints(agent.id)[0];
    expect(checkpoint).toBeDefined();
    if (!checkpoint) return;

    await writeFile(path.join(agent.workspacePath, "restore-me.txt"), "later state\n");
    const restored = await service.restoreCheckpoint(checkpoint.id);
    expect(await readFile(path.join(restored.workspacePath, "restore-me.txt"), "utf8")).toBe("checkpoint state\n");
    expect(restored.workspaceHash).toBe(checkpoint.workspaceHash);
    expect(await readFile(path.join(agent.workspacePath, "restore-me.txt"), "utf8")).toBe("later state\n");
  });

  it("creates an independent branch workspace and records branch provenance", async () => {
    const service = await makeService({
      run: async (request) => {
        if (request.prompt === "main change") {
          await writeFile(path.join(request.workspacePath, "main.txt"), "main\n");
        }
        if (request.prompt === "branch change") {
          await writeFile(path.join(request.workspacePath, "branch.txt"), "branch\n");
        }
        return { output: "done", threadId: request.threadId ?? "branch-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Branches" });
    const mainRun = await service.sendMessage(agent.id, "main change");
    await expect.poll(() => service.getRun(mainRun.run.id).status).toBe("completed");
    const checkpoint = service.getCheckpoints(agent.id)[0];
    expect(checkpoint).toBeDefined();
    if (!checkpoint) return;

    const branch = await service.createBranchFromCheckpoint(agent.id, checkpoint.id, "try-alternative");
    expect(branch.workspacePath).toBe(path.join(agent.workspacePath, "branches", branch.id));
    expect(service.getMessages(agent.id, branch.id).map((message) => message.content)).toContain("main change");
    expect(service.getRuns(agent.id, branch.id).map((run) => run.id)).toContain(mainRun.run.id);
    const branchRun = await service.sendMessage(agent.id, "branch change", branch.id);
    await expect.poll(() => service.getRun(branchRun.run.id).status).toBe("completed");

    expect(service.getRun(branchRun.run.id).branchId).toBe(branch.id);
    expect(await readFile(path.join(branch.workspacePath, "main.txt"), "utf8")).toBe("main\n");
    expect(await readFile(path.join(branch.workspacePath, "branch.txt"), "utf8")).toBe("branch\n");
    await expect(readFile(path.join(agent.workspacePath, "branch.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" }, await ownerId(service));
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" }, await ownerId(service));
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Multi-user identity", () => {
  it("finds or creates a user by name and resolves it by token", async () => {
    const service = await makeService();
    const first = await service.createUser("  Ada  ");
    expect(first.name).toBe("Ada");
    const again = await service.createUser("ada");
    expect(again.id).toBe(first.id);
    expect(again.token).toBe(first.token);
    expect(service.getUserByToken(first.token)?.id).toBe(first.id);
    expect(service.getUserByToken("not-a-real-token")).toBeNull();
    await expect(service.createUser("   ")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("scopes agents to their owner and denies cross-user access", async () => {
    const service = await makeService();
    const alice = await service.createUser("Alice");
    const bob = await service.createUser("Bob");
    const agent = await service.createAgent({ name: "Alice Agent" }, alice.id);

    expect(service.listAgents(alice.id).map((item) => item.id)).toEqual([agent.id]);
    expect(service.listAgents(bob.id)).toEqual([]);

    await expect(
      service.assertAgentAccess(agent.id, alice, "agent.read"),
    ).resolves.toMatchObject({ id: agent.id });
    await expect(
      service.assertAgentAccess(agent.id, bob, "agent.read"),
    ).rejects.toMatchObject({ statusCode: 403 });

    const bobLog = service.listAudit(bob);
    expect(
      bobLog.some((entry) => entry.decision === "deny" && entry.agentId === agent.id),
    ).toBe(true);
    // Alice, as owner, also sees the denied attempt on her Agent.
    expect(
      service
        .listAudit(alice)
        .some((entry) => entry.decision === "deny" && entry.userName === "Bob"),
    ).toBe(true);
  });

  it("migrates owner-less agents to a demo user on initialize", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "db.json");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "Legacy",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: path.join(root, "workspaces", "legacy"),
            codexThreadId: null,
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [],
        traces: [],
        snapshots: [],
        contexts: [],
        checkpoints: [],
      }),
      "utf8",
    );

    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(databasePath),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
    );
    await service.initialize();

    const demo = await service.createUser("demo");
    expect(service.listAgents(demo.id).map((item) => item.name)).toEqual(["Legacy"]);
  });
});

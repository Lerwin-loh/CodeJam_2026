import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { ProjectService } from "./project-service.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { WorkspaceManager } from "./workspace.js";

const noopRunner: AgentRunner = {
  run: async (request) => ({ output: "ok in " + request.workspacePath, threadId: "t", usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeStack(runner: AgentRunner = noopRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-project-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const history = new WorkspaceHistory(path.join(root, "data", "branchpoint"));
  const projects = new ProjectService(store, workspaces, history);
  const agents = new AgentService(config, store, workspaces, runner, history);
  await agents.initialize();
  return { root, config, store, workspaces, history, projects, agents };
}

describe("Part 1 — projects & membership", () => {
  it("creates a project with a parent agent and a head snapshot", async () => {
    const { projects, agents, store } = await makeStack();
    const owner = await agents.createUser("Owner");

    const project = await projects.createProject("Ticketing App", owner.id);
    expect(project.name).toBe("Ticketing App");
    expect(project.ownerId).toBe(owner.id);

    const db = store.snapshot();
    const parent = db.agents.find((a) => a.id === project.parentAgentId);
    expect(parent?.kind).toBe("parent");
    expect(parent?.projectId).toBe(project.id);
    expect(parent?.ownerId).toBe(owner.id);
    expect(db.snapshots.some((s) => s.id === project.headSnapshotId)).toBe(true);
    expect(projects.listProjects(owner.id).map((p) => p.id)).toEqual([project.id]);
  });

  it("adds a member with their own full-copy workspace and child agent", async () => {
    const { projects, agents, store } = await makeStack();
    const owner = await agents.createUser("Owner");
    const dana = await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);

    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });
    expect(member.role).toBe("Frontend");

    const db = store.snapshot();
    const child = db.agents.find((a) => a.id === member.childAgentId);
    expect(child?.kind).toBe("child");
    expect(child?.ownerId).toBe(dana.id);
    expect(child?.memberId).toBe(member.id);
    expect(child?.projectId).toBe(project.id);

    expect(await readFile(path.join(member.workspacePath, "README.md"), "utf8")).toContain("App");
    expect(await readFile(path.join(member.workspacePath, "AGENTS.md"), "utf8")).toContain("Frontend");
  });

  it("rejects adding an unknown user, the owner, or a duplicate member", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);

    await expect(projects.addMember(project.id, owner, { userName: "Ghost", role: "QA" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(projects.addMember(project.id, owner, { userName: "Owner", role: "QA" })).rejects.toMatchObject({ statusCode: 409 });
    await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });
    await expect(projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updates a member's role and keeps the child agent instructions in sync", async () => {
    const { projects, agents, store } = await makeStack();
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const updated = await projects.updateMember(project.id, member.id, { role: "Full-stack" });
    expect(updated.role).toBe("Full-stack");
    const child = store.snapshot().agents.find((a) => a.id === member.childAgentId);
    expect(child?.instructions).toContain("Full-stack");
  });

  it("removes a member and their child agent", async () => {
    const { projects, agents, store } = await makeStack();
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    await projects.removeMember(project.id, member.id);
    const db = store.snapshot();
    expect(db.projectMembers).toHaveLength(0);
    expect(db.agents.some((a) => a.id === member.childAgentId)).toBe(false);
  });

  it("deletes a project, archives its workspaces, and removes linked metadata", async () => {
    const { projects, agents, store } = await makeStack();
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, {
      userName: "Dana",
      role: "Frontend",
    });
    const timestamp = new Date().toISOString();
    const runId = "11111111-1111-4111-8111-111111111111";
    const branchId = "22222222-2222-4222-8222-222222222222";
    const contextId = "33333333-3333-4333-8333-333333333333";
    const checkpointId = "44444444-4444-4444-8444-444444444444";
    const snapshot = store.snapshot().snapshots.find((item) => item.agentId === member.childAgentId)!;

    await store.mutate((db) => {
      db.branches.push({
        id: branchId,
        agentId: member.childAgentId,
        name: "work",
        parentBranchId: null,
        parentCheckpointId: null,
        workspacePath: member.workspacePath + "/branches/" + branchId,
        codexThreadId: null,
        status: "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      db.runs.push({
        id: runId,
        agentId: member.childAgentId,
        branchId,
        status: "completed",
        prompt: "test",
        output: "done",
        error: null,
        usage: null,
        startedAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
        beforeWorkspaceHash: null,
        afterWorkspaceHash: null,
        checkpointId,
      });
      db.messages.push({
        id: "55555555-5555-4555-8555-555555555555",
        agentId: member.childAgentId,
        runId,
        branchId,
        role: "user",
        content: "test",
        createdAt: timestamp,
      });
      db.traces.push({
        id: "66666666-6666-4666-8666-666666666666",
        runId,
        agentId: member.childAgentId,
        branchId,
        type: "run.completed",
        timestamp,
        metadata: {},
      });
      db.contexts.push({
        id: contextId,
        agentId: member.childAgentId,
        runId,
        agentName: "Child",
        agentDescription: "",
        instructions: "",
        messages: [],
        sourceThreadId: null,
        sessionRolloutPath: null,
        sessionLineOffset: null,
        createdAt: timestamp,
      });
      db.checkpoints.push({
        id: checkpointId,
        agentId: member.childAgentId,
        branchId,
        runId,
        parentCheckpointId: null,
        snapshotId: snapshot.id,
        contextId,
        workspaceHash: snapshot.manifest.workspaceHash,
        changedFiles: { created: [], modified: [], deleted: [] },
        status: "complete",
        reason: "explicit",
        label: "test",
        createdAt: timestamp,
      });
    });

    const result = await projects.deleteProject(project.id, owner);
    expect(result.archivedWorkspace).not.toBeNull();
    expect(result.archivedSnapshots).toBeGreaterThan(0);
    expect(
      await readFile(path.join(result.archivedWorkspace!, "main", "README.md"), "utf8"),
    ).toContain("App");

    const db = store.snapshot();
    expect(db.projects.some((item) => item.id === project.id)).toBe(false);
    expect(db.projectMembers.some((item) => item.projectId === project.id)).toBe(false);
    expect(db.agents.some((item) => item.projectId === project.id)).toBe(false);
    expect(db.branches.some((item) => item.agentId === member.childAgentId)).toBe(false);
    expect(db.messages.some((item) => item.agentId === member.childAgentId)).toBe(false);
    expect(db.runs.some((item) => item.agentId === member.childAgentId)).toBe(false);
    expect(db.traces.some((item) => item.agentId === member.childAgentId)).toBe(false);
    expect(db.snapshots.some((item) => item.agentId === member.childAgentId)).toBe(false);
    expect(db.contexts.some((item) => item.agentId === member.childAgentId)).toBe(false);
    expect(db.checkpoints.some((item) => item.agentId === member.childAgentId)).toBe(false);
    expect(db.audit.some((item) => item.action === "project.delete")).toBe(true);
  });

  it("deletes an orphaned project whose workspace folder is already missing", async () => {
    const { projects, agents, store, workspaces } = await makeStack();
    const owner = await agents.createUser("Owner");
    const project = await projects.createProject("Orphaned", owner.id);
    await rm(workspaces.projectPath(project.id), { recursive: true, force: true });

    const result = await projects.deleteProject(project.id, owner);
    expect(result.archivedWorkspace).toBeNull();
    expect(store.snapshot().projects).toEqual([]);
  });
});

describe("Part 1 — permission model", () => {
  it("enforces the owner / member / member-own floor in assertProjectAccess", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    const dana = await agents.createUser("Dana");
    const sam = await agents.createUser("Sam");
    const stranger = await agents.createUser("Stranger");
    const project = await projects.createProject("App", owner.id);
    const danaMember = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });
    const samMember = await projects.addMember(project.id, owner, { userName: "Sam", role: "Backend" });

    await expect(projects.assertProjectAccess(project.id, dana, "project.read")).resolves.toMatchObject({ role: "member" });
    await expect(projects.assertProjectAccess(project.id, dana, "file.read")).resolves.toBeTruthy();
    await expect(projects.assertProjectAccess(project.id, dana, "parent.read")).resolves.toBeTruthy();

    await expect(projects.assertProjectAccess(project.id, dana, "parent.query")).rejects.toMatchObject({ statusCode: 403 });
    await expect(projects.assertProjectAccess(project.id, dana, "member.manage")).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      projects.assertProjectAccess(project.id, dana, "child.query", { memberId: danaMember.id }),
    ).resolves.toBeTruthy();
    await expect(
      projects.assertProjectAccess(project.id, dana, "child.query", { memberId: samMember.id }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(projects.assertProjectAccess(project.id, owner, "member.manage")).resolves.toMatchObject({ role: "owner" });
    await expect(projects.assertProjectAccess(project.id, owner, "child.query", { memberId: samMember.id })).resolves.toBeTruthy();
    await expect(projects.assertProjectAccess(project.id, stranger, "project.read")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("shows the owner the full roster and a member only names + roles", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    const dana = await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const ownerView = projects.getProject(project.id, owner);
    expect(ownerView.role).toBe("owner");
    expect((ownerView.members[0] as { childAgentId: string }).childAgentId).toBeTruthy();

    const memberView = projects.getProject(project.id, dana);
    expect(memberView.role).toBe("member");
    expect(memberView.members[0]).toEqual({ userId: dana.id, name: "Dana", role: "Frontend" });
    expect((memberView.members[0] as Record<string, unknown>).childAgentId).toBeUndefined();
  });
});

describe("Part 1 — read-all file access", () => {
  it("lists and reads main files and blocks path traversal", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    const project = await projects.createProject("App", owner.id);

    const files = await projects.getMainTree(project.id);
    expect(files).toContain("README.md");

    const content = await projects.readMainFile(project.id, "README.md");
    expect(content).toContain("App");

    await expect(projects.readMainFile(project.id, "../../../etc/passwd")).rejects.toMatchObject({ statusCode: 400 });
    await expect(projects.readMainFile(project.id, "nope.txt")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Part 1 — agent access across the project", () => {
  it("lets a member reach their own child agent, the owner reach any child, and no one reach another member's", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    const dana = await agents.createUser("Dana");
    const sam = await agents.createUser("Sam");
    const project = await projects.createProject("App", owner.id);
    const danaMember = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });
    const samMember = await projects.addMember(project.id, owner, { userName: "Sam", role: "Backend" });

    await expect(agents.assertAgentAccess(danaMember.childAgentId, dana, "child.query")).resolves.toMatchObject({ id: danaMember.childAgentId });
    await expect(agents.assertAgentAccess(samMember.childAgentId, owner, "child.query")).resolves.toBeTruthy();
    await expect(agents.assertAgentAccess(samMember.childAgentId, dana, "child.query")).rejects.toMatchObject({ statusCode: 403 });

    await expect(agents.assertAgentAccess(project.parentAgentId, dana, "agent.run")).rejects.toMatchObject({ statusCode: 403 });
    await expect(agents.assertAgentAccess(project.parentAgentId, owner, "agent.run")).resolves.toBeTruthy();

    expect(agents.listAgents(dana.id)).toEqual([]);
    expect(agents.listAgents(sam.id)).toEqual([]);
  });

  it("scans a member workspace, files a commit request, and lets the owner decide", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    const dana = await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    // seed a risky file in the member's workspace
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(member.workspacePath, "src"), { recursive: true });
    await writeFile(
      path.join(member.workspacePath, "src/app.ts"),
      'const password = "hunter2hunter";\nexport const run = (x) => eval(x);\n',
      "utf8",
    );

    const check = await projects.runSecurityCheck(project.id, member.id);
    expect(check.findings.map((f) => f.rule).sort()).toEqual(["hardcoded-secret", "use-of-eval"]);

    const request = await projects.submitCommitRequest(project.id, member.id, { title: "add app" });
    expect(request.status).toBe("pending");
    expect(request.changedFiles.created).toContain("src/app.ts");
    expect(request.securityCheck?.findings).toHaveLength(2);

    // a member cannot decide; the owner can
    expect(projects.listCommitRequests(project.id, member)).toHaveLength(1);
    await expect(
      projects.assertProjectAccess(project.id, dana, "commit.request.decide"),
    ).rejects.toMatchObject({ statusCode: 403 });

    const decided = await projects.decideCommitRequest(request.id, "approved", owner);
    expect(decided.status).toBe("approved");
    await expect(
      projects.decideCommitRequest(request.id, "rejected", owner),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a commit request with no changes", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });
    await expect(
      projects.submitCommitRequest(project.id, member.id, {}),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("runs a member's child agent in its own workspace without fencing changes", async () => {
    const { projects, agents } = await makeStack({
      run: async (request) => {
        const { writeFile, mkdir } = await import("node:fs/promises");
        await mkdir(path.join(request.workspacePath, "anywhere"), { recursive: true });
        await writeFile(path.join(request.workspacePath, "anywhere/file.ts"), "ok\n");
        return { output: "done", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const { run } = await agents.sendMessage(member.childAgentId, "make a file anywhere");
    await expect.poll(() => agents.getRun(run.id).status).toBe("completed");

    const checkpoint = agents.getCheckpoints(member.childAgentId)[0];
    expect(checkpoint?.changedFiles.created).toEqual(["anywhere/file.ts"]);
    expect(await readFile(path.join(member.workspacePath, "anywhere/file.ts"), "utf8")).toBe("ok\n");
  });
});

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { ProjectService } from "./project-service.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, OwaspStatus } from "./types.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { WorkspaceManager } from "./workspace.js";

const noopRunner: AgentRunner = {
  run: async (request) => ({ output: "ok in " + request.workspacePath, threadId: "t", usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

const OWASP_TEST_IDS = [
  ["A01:2021", "Broken Access Control"],
  ["A02:2021", "Cryptographic Failures"],
  ["A03:2021", "Injection"],
  ["A04:2021", "Insecure Design"],
  ["A05:2021", "Security Misconfiguration"],
  ["A06:2021", "Vulnerable and Outdated Components"],
  ["A07:2021", "Identification and Authentication Failures"],
  ["A08:2021", "Software and Data Integrity Failures"],
  ["A09:2021", "Security Logging and Monitoring Failures"],
  ["A10:2021", "Server-Side Request Forgery (SSRF)"],
] as const;

function owaspFence(overrides: Record<string, OwaspStatus> = {}): string {
  const rows = OWASP_TEST_IDS.map(([id, name]) => {
    const status = overrides[id] ?? "pass";
    return status === "fail"
      ? {
          id,
          name,
          status,
          detail: "issue found",
          file: "src/app.ts",
          evidence: "const q = `SELECT * FROM u WHERE id=${req.query.id}`;",
          remediation: "Use a parameterized query.",
        }
      : { id, name, status, detail: "checked" };
  });
  return "Analysis complete.\n\n```json\n" + JSON.stringify(rows, null, 2) + "\n```\n";
}

/** Stub for the direct OWASP classifier — returns a canned verdict, counts calls. */
function owaspClassify(overrides: Record<string, OwaspStatus> = {}) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return owaspFence(overrides);
  };
  return Object.defineProperty(fn, "calls", { get: () => calls }) as typeof fn & {
    readonly calls: number;
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeStack(
  runner: AgentRunner = noopRunner,
  classify: (prompt: string) => Promise<string> = owaspClassify(),
) {
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
  const projects = new ProjectService(store, workspaces, history, classify);
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

  it("stores parent and member branches inside their respective project workspaces", async () => {
    const { projects, agents, store, workspaces } = await makeStack({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "branch-source.txt"), request.prompt + "\n");
        return { output: "ok", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });
    const parent = agents.getAgent(project.parentAgentId);
    const child = agents.getAgent(member.childAgentId);

    const parentRun = await agents.sendMessage(parent.id, "parent checkpoint");
    const childRun = await agents.sendMessage(child.id, "child checkpoint");
    await expect.poll(() => agents.getRun(parentRun.run.id).status).toBe("completed");
    await expect.poll(() => agents.getRun(childRun.run.id).status).toBe("completed");

    const parentCheckpoint = agents.getCheckpoints(parent.id)[0];
    const childCheckpoint = agents.getCheckpoints(child.id)[0];
    expect(parentCheckpoint).toBeDefined();
    expect(childCheckpoint).toBeDefined();
    if (!parentCheckpoint || !childCheckpoint) return;

    const parentBranch = await agents.createBranchFromCheckpoint(parent.id, parentCheckpoint.id, "parent branch");
    const childBranch = await agents.createBranchFromCheckpoint(child.id, childCheckpoint.id, "child branch");

    expect(parentBranch.workspacePath).toBe(path.join(project.mainWorkspacePath, "branches", parentBranch.id));
    expect(childBranch.workspacePath).toBe(path.join(member.workspacePath, "branches", childBranch.id));
    expect(store.snapshot().branches.map((branch) => branch.workspacePath)).toEqual(
      expect.arrayContaining([parentBranch.workspacePath, childBranch.workspacePath]),
    );

    // Older production builds used workspaces/<agent-id>/branches. Startup migrates those records and files.
    const legacyParentPath = path.join(workspaces.workspacePath(parent.id), "branches", parentBranch.id);
    await mkdir(path.dirname(legacyParentPath), { recursive: true });
    await rename(parentBranch.workspacePath, legacyParentPath);
    await store.mutate((database) => {
      const branch = database.branches.find((item) => item.id === parentBranch.id);
      if (branch) branch.workspacePath = legacyParentPath;
    });
    await agents.initialize();
    expect(agents.getBranch(parentBranch.id).workspacePath).toBe(parentBranch.workspacePath);
    expect(await readFile(path.join(parentBranch.workspacePath, "branch-source.txt"), "utf8")).toBe("parent checkpoint\n");
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

  it("gates a commit request on a passing OWASP verdict, then lets the owner decide", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    const dana = await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(member.workspacePath, "src"), { recursive: true });
    await writeFile(path.join(member.workspacePath, "src/app.ts"), "export const run = 1;\n", "utf8");

    // no analysis on file yet -> commit blocked
    await expect(
      projects.submitCommitRequest(project.id, member.id, { title: "add app" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await projects.getMemberSecurity(project.id, member.id)).reason).toBe("never-run");

    // one direct model call -> all pass -> commit unlocked
    const security = await projects.runSecurityGate(project.id, member.id);
    expect(security.canCommit).toBe(true);
    expect(security.analysis?.points).toHaveLength(10);
    expect(security.analysis?.passed).toBe(true);

    const request = await projects.submitCommitRequest(project.id, member.id, { title: "add app" });
    expect(request.status).toBe("pending");
    expect(request.changedFiles.created).toContain("src/app.ts");
    expect(request.securityAnalysis?.passed).toBe(true);

    // a member may file more requests while an earlier one is still pending
    const second = await projects.submitCommitRequest(project.id, member.id, { title: "add app v2" });
    expect(second.status).toBe("pending");
    expect(second.id).not.toBe(request.id);
    expect(projects.listCommitRequests(project.id, member)).toHaveLength(2);
    await expect(
      projects.assertProjectAccess(project.id, dana, "commit.request.decide"),
    ).rejects.toMatchObject({ statusCode: 403 });

    const decided = await projects.decideCommitRequest(request.id, "approved", owner);
    expect(decided.status).toBe("approved");
  });

  it("keeps the commit gate closed on a failing OWASP point", async () => {
    const { projects, agents } = await makeStack(noopRunner, owaspClassify({ "A03:2021": "fail" }));
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(member.workspacePath, "app.ts"), "export const x = 1;\n", "utf8");

    const security = await projects.runSecurityGate(project.id, member.id);
    expect(security.canCommit).toBe(false);
    expect(security.reason).toBe("failed");
    const failed = security.analysis?.points.find((p) => p.id === "A03:2021");
    expect(failed?.status).toBe("fail");
    // the fail carries the flagged code + remediation for the "View & fix" popup
    expect(failed?.file).toBe("src/app.ts");
    expect(failed?.evidence).toContain("SELECT * FROM");
    expect(failed?.remediation).toContain("parameterized");
    // passing points don't carry those fields
    expect(security.analysis?.points.find((p) => p.id === "A01:2021")?.evidence).toBeUndefined();

    await expect(
      projects.submitCommitRequest(project.id, member.id, {}),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("invalidates a passing verdict once the branch changes again", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(member.workspacePath, "a.ts"), "export const a = 1;\n", "utf8");

    expect((await projects.runSecurityGate(project.id, member.id)).canCommit).toBe(true);

    // member keeps coding -> the branch no longer matches the analyzed state
    await writeFile(path.join(member.workspacePath, "b.ts"), "export const b = 2;\n", "utf8");
    const stale = await projects.getMemberSecurity(project.id, member.id);
    expect(stale.canCommit).toBe(false);
    expect(stale.reason).toBe("branch-changed");
    await expect(
      projects.submitCommitRequest(project.id, member.id, {}),
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

  it("runSecurityGate skips the model call when it can, and scopes it when it can't", async () => {
    const classify = owaspClassify();
    const { projects, agents } = await makeStack(noopRunner, classify);
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });
    const { writeFile } = await import("node:fs/promises");

    // 1. nothing changed vs main -> passing, no model call
    const noChange = await projects.runSecurityGate(project.id, member.id);
    expect(noChange.canCommit).toBe(true);
    expect(classify.calls).toBe(0);

    // 2. a changed file with a lexical hit -> failed, still no model call
    await writeFile(
      path.join(member.workspacePath, "login.js"),
      'const apiKey = "sk-live-abc123def456";\nel.innerHTML = user.name;\n',
      "utf8",
    );
    const staticHit = await projects.runSecurityGate(project.id, member.id);
    expect(classify.calls).toBe(0);
    expect(staticHit.canCommit).toBe(false);
    expect(staticHit.reason).toBe("failed");
    expect(staticHit.analysis?.points.find((p) => p.id === "A02:2021")?.status).toBe("fail");
    expect(staticHit.analysis?.points.find((p) => p.id === "A03:2021")?.status).toBe("fail");
    expect(staticHit.analysis?.points.find((p) => p.id === "A02:2021")?.remediation).toBeTruthy();

    // 3. a clean changed file -> one model call, prompt inlines just that file
    await writeFile(path.join(member.workspacePath, "login.js"), "export const ok = 1;\n", "utf8");
    const gate = await projects.buildSecurityGate(project.id, member.id);
    expect(gate.kind).toBe("needs-llm");
    if (gate.kind === "needs-llm") {
      expect(gate.prompt).toContain("--- login.js ---");
      expect(gate.prompt).toContain("export const ok = 1;");
      expect(gate.prompt).not.toContain("README.md"); // unchanged files are out of scope
    }
    const clean = await projects.runSecurityGate(project.id, member.id);
    expect(classify.calls).toBe(1);
    expect(clean.canCommit).toBe(true);
  });

  it("auto-fixes a flagged file with one model call, no agent run", async () => {
    const original = '<html><body><script>let token = "abcdef1234";</script></body></html>\n';
    const rewritten = "<html><body><script>/* secret removed */</script></body></html>\n";
    let fixCalls = 0;
    const classify = async (prompt: string) => {
      if (prompt.includes("Rewrite the file below")) {
        fixCalls += 1;
        return rewritten;
      }
      return JSON.stringify(
        OWASP_TEST_IDS.map(([id, name]) =>
          id === "A02:2021" && fixCalls === 0
            ? {
                id,
                name,
                status: "fail",
                detail: "hardcoded token",
                file: "index.html",
                evidence: 'let token = "abcdef1234";',
                remediation: "Load the token server-side.",
              }
            : { id, name, status: "pass", detail: "ok" },
        ),
      );
    };
    const { projects, agents } = await makeStack(noopRunner, classify);
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(member.workspacePath, "index.html"), original, "utf8");

    const scanned = await projects.runSecurityGate(project.id, member.id);
    expect(scanned.canCommit).toBe(false);
    expect(scanned.analysis?.points.find((p) => p.id === "A02:2021")?.status).toBe("fail");

    const after = await projects.applySecurityFixes(project.id, member.id, null);
    expect(fixCalls).toBe(1); // one call for the one affected file
    expect(await readFile(path.join(member.workspacePath, "index.html"), "utf8")).toContain(
      "secret removed",
    );
    // recorded as a turn in the child agent's chat
    const messages = agents.getMessages(member.childAgentId);
    expect(
      messages.some((m) => m.role === "assistant" && m.content.includes("index.html")),
    ).toBe(true);
    // still blocked on the stale verdict — the caller re-scans the fixed file next
    expect(after.canCommit).toBe(false);
    const rescan = await projects.runSecurityGate(project.id, member.id);
    expect(rescan.canCommit).toBe(true); // A02 fixed, everything else passes
  });

  it("freezes every write once the project is archived and thaws on unarchive", async () => {
    const { projects, agents } = await makeStack();
    const owner = await agents.createUser("Owner");
    const dana = await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    // only the owner may archive
    await expect(projects.setProjectArchived(project.id, dana, true)).rejects.toMatchObject({
      statusCode: 403,
    });

    const archived = await projects.setProjectArchived(project.id, owner, true);
    expect(archived.archivedAt).not.toBeNull();

    // reads still work for owner and member
    await expect(projects.assertProjectAccess(project.id, dana, "project.read")).resolves.toBeTruthy();
    await expect(projects.assertProjectAccess(project.id, owner, "parent.read")).resolves.toBeTruthy();

    // writes are frozen for everyone, including the owner
    await expect(
      projects.assertProjectAccess(project.id, owner, "member.manage"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      projects.assertProjectAccess(project.id, dana, "commit.request.create", { memberId: member.id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      agents.assertAgentAccess(project.parentAgentId, owner, "agent.run"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      agents.assertAgentAccess(member.childAgentId, dana, "agent.run"),
    ).rejects.toMatchObject({ statusCode: 409 });

    // lifecycle actions stay open while archived
    await expect(
      projects.assertProjectAccess(project.id, owner, "project.delete"),
    ).resolves.toMatchObject({ role: "owner" });

    const restored = await projects.setProjectArchived(project.id, owner, false);
    expect(restored.archivedAt).toBeNull();
    await expect(
      projects.assertProjectAccess(project.id, owner, "member.manage"),
    ).resolves.toMatchObject({ role: "owner" });
    await expect(
      agents.assertAgentAccess(member.childAgentId, dana, "agent.run"),
    ).resolves.toBeTruthy();
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

  it("merges selected sub-branches into the trunk workspace and deletes them", async () => {
    const { projects, agents } = await makeStack({
      run: async (request) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(request.workspacePath, "feature.ts"), "v1\n");
        return { output: "done", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    // a run creates a checkpoint on the trunk
    const { run } = await agents.sendMessage(member.childAgentId, "add feature");
    await expect.poll(() => agents.getRun(run.id).status).toBe("completed");
    const checkpoint = agents.getCheckpoints(member.childAgentId)[0]!;

    // fork two branches off it and edit them directly
    const { writeFile, rm } = await import("node:fs/promises");
    const b1 = await agents.createBranchFromCheckpoint(member.childAgentId, checkpoint.id, "exp");
    await writeFile(path.join(b1.workspacePath, "feature.ts"), "v2-from-b1\n"); // modify
    await writeFile(path.join(b1.workspacePath, "added-by-b1.ts"), "new\n"); // add
    const b2 = await agents.createBranchFromCheckpoint(member.childAgentId, checkpoint.id, "exp2");
    await rm(path.join(b2.workspacePath, "feature.ts")); // delete

    expect(agents.getBranches(member.childAgentId)).toHaveLength(2);

    const result = await agents.mergeBranches(member.childAgentId, [b1.id, b2.id]);
    expect(result.mergedBranchIds.sort()).toEqual([b1.id, b2.id].sort());
    expect(result.changedFiles).toContain("added-by-b1.ts");

    // b2 was created after b1, so its delete of feature.ts wins
    await expect(readFile(path.join(member.workspacePath, "feature.ts"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(member.workspacePath, "added-by-b1.ts"), "utf8")).toBe("new\n");

    // branches gone from the store and disk
    expect(agents.getBranches(member.childAgentId)).toHaveLength(0);
    await expect(readFile(path.join(b1.workspacePath, "added-by-b1.ts"), "utf8")).rejects.toThrow();

    // merging an unknown branch id is a 404
    await expect(
      agents.mergeBranches(member.childAgentId, ["00000000-0000-4000-8000-000000000000"]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("still removes a branch whose workspace folder is already gone", async () => {
    const { projects, agents } = await makeStack({
      run: async (request) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(request.workspacePath, "feature.ts"), "v1\n");
        return { output: "done", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const owner = await agents.createUser("Owner");
    await agents.createUser("Dana");
    const project = await projects.createProject("App", owner.id);
    const member = await projects.addMember(project.id, owner, { userName: "Dana", role: "Frontend" });

    const { run } = await agents.sendMessage(member.childAgentId, "add feature");
    await expect.poll(() => agents.getRun(run.id).status).toBe("completed");
    const checkpoint = agents.getCheckpoints(member.childAgentId)[0]!;
    const branch = await agents.createBranchFromCheckpoint(member.childAgentId, checkpoint.id, "stale");

    const trunkBefore = await readFile(path.join(member.workspacePath, "feature.ts"), "utf8");
    const { rm } = await import("node:fs/promises");
    await rm(branch.workspacePath, { recursive: true, force: true }); // simulate an old/missing branch dir

    const result = await agents.mergeBranches(member.childAgentId, [branch.id]);
    expect(result.mergedBranchIds).toEqual([branch.id]);
    expect(result.changedFiles).toEqual([]); // nothing to fold in
    expect(agents.getBranches(member.childAgentId)).toHaveLength(0); // record gone
    // trunk untouched
    expect(await readFile(path.join(member.workspacePath, "feature.ts"), "utf8")).toBe(trunkBefore);
  });
});

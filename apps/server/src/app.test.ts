import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ProjectService } from "./project-service.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { WorkspaceHistory } from "./workspace-history.js";

const validUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tester",
  token: "valid-user-token",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const service = {
  systemInfo: async () => ({}),
  getUserByToken: (token: string) =>
    token === validUser.token ? validUser : null,
  createUser: async (name: string) => ({ ...validUser, name }),
} as unknown as AgentService;

const projectsStub = {
  listProjects: () => [],
  listPendingInvitations: () => [],
} as unknown as ProjectService;

describe("HTTP boundary", () => {
  it("rejects API requests without a valid user token", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, projectsStub);
    const denied = await app.inject({ method: "GET", url: "/api/projects" });
    expect(denied.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrongToken.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer valid-user-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("lets anyone create or resume a user without a token", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, projectsStub);
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "Ada" }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user).toMatchObject({ name: "Ada", token: "valid-user-token" });
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, projectsStub);
    const headers = { "content-type": "application/json" };
    const malformed = await app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

const realRunner: AgentRunner = {
  run: async () => ({ output: "ok", threadId: "t", usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Project access enforcement (end to end)", () => {
  it("scopes projects per user, denies cross-user access to project agents, and records the decision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-test-"));
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
    const service = new AgentService(config, store, workspaces, realRunner, history);
    await service.initialize();
    const app = await createApp(config, service, projects);

    const makeUser = async (name: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ name }),
      });
      expect(response.statusCode).toBe(201);
      return response.json().user.token as string;
    };
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const asAlice = { authorization: "Bearer " + alice, "content-type": "application/json" };
    const asBob = { authorization: "Bearer " + bob };

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: asAlice,
      payload: JSON.stringify({ name: "Alice Project" }),
    });
    expect(created.statusCode).toBe(201);
    const project = created.json().project as { id: string; parentAgentId: string };

    // Bob is not on the project — he sees nothing and cannot reach its agents.
    const bobList = await app.inject({ method: "GET", url: "/api/projects", headers: asBob });
    expect(bobList.json().projects).toEqual([]);

    const aliceList = await app.inject({ method: "GET", url: "/api/projects", headers: asAlice });
    expect(aliceList.json().projects.map((p: { id: string }) => p.id)).toEqual([project.id]);

    const bobReadsProject = await app.inject({
      method: "GET",
      url: "/api/projects/" + project.id,
      headers: asBob,
    });
    expect(bobReadsProject.statusCode).toBe(403);

    const bobReadsParentAgent = await app.inject({
      method: "GET",
      url: "/api/agents/" + project.parentAgentId,
      headers: asBob,
    });
    expect(bobReadsParentAgent.statusCode).toBe(403);

    const bobMessagesParentAgent = await app.inject({
      method: "POST",
      url: "/api/agents/" + project.parentAgentId + "/messages",
      headers: { authorization: "Bearer " + bob, "content-type": "application/json" },
      payload: JSON.stringify({ content: "do something" }),
    });
    expect(bobMessagesParentAgent.statusCode).toBe(403);

    // Standalone agents remain scoped to their owner and power Individual mode.
    const standalone = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: asAlice,
      payload: JSON.stringify({ name: "loose agent" }),
    });
    expect(standalone.statusCode).toBe(201);
    const standaloneId = standalone.json().agent.id as string;

    const aliceAgents = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: asAlice,
    });
    expect(aliceAgents.statusCode).toBe(200);
    expect(aliceAgents.json().agents.map((agent: { name: string }) => agent.name)).toEqual([
      "loose agent",
    ]);

    const bobAgents = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: asBob,
    });
    expect(bobAgents.statusCode).toBe(200);
    expect(bobAgents.json().agents).toEqual([]);

    const bobUpgradesAgent = await app.inject({
      method: "POST",
      url: "/api/agents/" + standaloneId + "/upgrade-to-project",
      headers: { authorization: "Bearer " + bob, "content-type": "application/json" },
      payload: JSON.stringify({ projectName: "Stolen Project" }),
    });
    expect(bobUpgradesAgent.statusCode).toBe(403);

    const aliceUpgradesAgent = await app.inject({
      method: "POST",
      url: "/api/agents/" + standaloneId + "/upgrade-to-project",
      headers: asAlice,
      payload: JSON.stringify({ projectName: "Upgraded Project" }),
    });
    expect(aliceUpgradesAgent.statusCode).toBe(201);
    expect(aliceUpgradesAgent.json()).toMatchObject({
      project: { name: "Upgraded Project", parentAgentId: standaloneId },
      parentAgent: { id: standaloneId, kind: "parent" },
    });
    const upgradedProjectId = aliceUpgradesAgent.json().project.id as string;
    const agentsAfterUpgrade = await app.inject({ method: "GET", url: "/api/agents", headers: asAlice });
    expect(agentsAfterUpgrade.json().agents).toEqual([]);

    const auditAsAlice = await app.inject({ method: "GET", url: "/api/audit", headers: asAlice });
    const entries = auditAsAlice.json().entries as Array<{
      decision: string;
      userName: string;
      action: string;
    }>;
    expect(
      entries.some((entry) => entry.decision === "deny" && entry.userName === "Bob"),
    ).toBe(true);

    const bobDeletesProject = await app.inject({
      method: "DELETE",
      url: "/api/projects/" + project.id,
      headers: { authorization: "Bearer " + bob },
    });
    expect(bobDeletesProject.statusCode).toBe(403);

    const aliceDeletesProject = await app.inject({
      method: "DELETE",
      url: "/api/projects/" + project.id,
      headers: { authorization: "Bearer " + alice },
    });
    expect(aliceDeletesProject.statusCode).toBe(200);
    expect(aliceDeletesProject.json()).toMatchObject({ archivedSnapshots: 1 });

    const projectsAfterDelete = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: asAlice,
    });
    expect(projectsAfterDelete.json().projects.map((item: { id: string }) => item.id)).toEqual([
      upgradedProjectId,
    ]);
    const deletesUpgradedProject = await app.inject({
      method: "DELETE",
      url: "/api/projects/" + upgradedProjectId,
      headers: { authorization: "Bearer " + alice },
    });
    expect(deletesUpgradedProject.statusCode).toBe(200);

    await app.close();
  });

  it("deletes an account and its dependent Agents, projects, memberships, and history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-account-delete-test-"));
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
    const accountService = new AgentService(config, store, workspaces, realRunner, history);
    await accountService.initialize();
    const app = await createApp(config, accountService, projects);

    const alice = await accountService.createUser("Account Alice");
    const bob = await accountService.createUser("Account Bob");
    const standalone = await accountService.createAgent({ name: "Alice standalone" }, alice.id);
    const standaloneRun = await accountService.sendMessage(standalone.id, "remember this");
    await expect.poll(() => accountService.getRun(standaloneRun.run.id).status).toBe("completed");

    const aliceProject = await projects.createProject("Alice owned", alice.id);
    const bobOnAliceProject = await projects.addMember(aliceProject.id, alice, {
      userName: bob.name,
      role: "Backend",
    });
    const bobProject = await projects.createProject("Bob owned", bob.id);
    const aliceOnBobProject = await projects.addMember(bobProject.id, bob, {
      userName: alice.name,
      role: "Frontend",
    });

    const before = store.snapshot();
    const deletedAgentIds = new Set([
      standalone.id,
      aliceProject.parentAgentId,
      bobOnAliceProject.childAgentId,
      aliceOnBobProject.childAgentId,
    ]);
    expect(before.agents.filter((agent) => deletedAgentIds.has(agent.id))).toHaveLength(4);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/users/me",
      headers: { authorization: "Bearer " + alice.token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deletedUserId: alice.id,
      deletedProjects: 1,
      deletedMemberships: 2,
      deletedAgents: 4,
      archivedWorkspaces: 3,
      archivedSnapshots: 3,
    });

    expect(accountService.getUserByToken(alice.token)).toBeNull();
    expect(accountService.getUserByToken(bob.token)?.id).toBe(bob.id);
    const after = store.snapshot();
    expect(after.users.map((user) => user.id)).toEqual([bob.id]);
    expect(after.projects.map((project) => project.id)).toEqual([bobProject.id]);
    expect(after.projectMembers).toEqual([]);
    expect(after.agents.map((agent) => agent.id)).toEqual([bobProject.parentAgentId]);
    expect(after.branches.some((branch) => deletedAgentIds.has(branch.agentId))).toBe(false);
    expect(after.messages.some((message) => deletedAgentIds.has(message.agentId))).toBe(false);
    expect(after.runs.some((run) => deletedAgentIds.has(run.agentId))).toBe(false);
    expect(after.traces.some((event) => deletedAgentIds.has(event.agentId))).toBe(false);
    expect(after.snapshots.some((snapshot) => deletedAgentIds.has(snapshot.agentId))).toBe(false);
    expect(after.contexts.some((context) => deletedAgentIds.has(context.agentId))).toBe(false);
    expect(after.checkpoints.some((checkpoint) => deletedAgentIds.has(checkpoint.agentId))).toBe(false);
    expect(after.audit.some((entry) => entry.userId === alice.id)).toBe(false);

    const oldToken = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer " + alice.token },
    });
    expect(oldToken.statusCode).toBe(401);
    const bobProjects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer " + bob.token },
    });
    expect(bobProjects.statusCode).toBe(200);
    expect(bobProjects.json().projects.map((project: { id: string }) => project.id))
      .toEqual([bobProject.id]);

    await app.close();
  });
});

describe("BranchPoint API authorization (end to end)", () => {
  it("protects branch, run, trace, and restore resources and resumes a branch thread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-branch-api-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const observedThreads: Array<{ prompt: string; threadId: string | null }> = [];
    const runner: AgentRunner = {
      run: async (request) => {
        observedThreads.push({ prompt: request.prompt, threadId: request.threadId });
        await writeFile(
          path.join(request.workspacePath, request.prompt.replaceAll(" ", "-") + ".txt"),
          request.prompt + "\n",
        );
        return {
          output: "ok",
          threadId: request.threadId ?? (request.prompt === "seed main" ? "main-thread" : "branch-thread"),
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const history = new WorkspaceHistory(path.join(root, "data", "branchpoint"));
    const projects = new ProjectService(store, workspaces, history);
    const branchService = new AgentService(config, store, workspaces, runner, history);
    await branchService.initialize();
    const app = await createApp(config, branchService, projects);

    const createUser = async (name: string): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url: "/api/users",
        payload: { name },
      });
      expect(response.statusCode).toBe(201);
      return response.json().user.token as string;
    };
    const aliceToken = await createUser("Branch Alice");
    const bobToken = await createUser("Branch Bob");
    const alice = { authorization: "Bearer " + aliceToken };
    const bob = { authorization: "Bearer " + bobToken };

    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: alice,
      payload: { name: "Branch API Agent" },
    });
    expect(createdAgent.statusCode).toBe(201);
    const agentId = createdAgent.json().agent.id as string;

    const seeded = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: alice,
      payload: { content: "seed main" },
    });
    expect(seeded.statusCode).toBe(202);
    const mainRunId = seeded.json().run.id as string;
    await expect.poll(() => branchService.getRun(mainRunId).status).toBe("completed");
    const checkpoint = branchService.getCheckpoints(agentId)[0];
    expect(checkpoint).toBeDefined();
    if (!checkpoint) return;

    const bobCreatesBranch = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/branches",
      headers: bob,
      payload: { checkpointId: checkpoint.id, name: "stolen branch" },
    });
    expect(bobCreatesBranch.statusCode).toBe(403);

    const createdBranch = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/branches",
      headers: alice,
      payload: { checkpointId: checkpoint.id, name: "experiment" },
    });
    expect(createdBranch.statusCode).toBe(201);
    const branchId = createdBranch.json().branch.id as string;

    const firstBranchTurn = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: alice,
      payload: { content: "branch turn one", branchId },
    });
    expect(firstBranchTurn.statusCode).toBe(202);
    const firstBranchRunId = firstBranchTurn.json().run.id as string;
    await expect.poll(() => branchService.getRun(firstBranchRunId).status).toBe("completed");

    const secondBranchTurn = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: alice,
      payload: { content: "branch turn two", branchId },
    });
    expect(secondBranchTurn.statusCode).toBe(202);
    await expect.poll(() => branchService.getRun(secondBranchTurn.json().run.id).status).toBe("completed");
    expect(observedThreads.find((item) => item.prompt === "branch turn two")?.threadId).toBe("branch-thread");

    const ownerDetails = await app.inject({ method: "GET", url: "/api/runs/" + mainRunId + "/details", headers: alice });
    expect(ownerDetails.statusCode).toBe(200);
    const deniedDetails = await app.inject({ method: "GET", url: "/api/runs/" + mainRunId + "/details", headers: bob });
    expect(deniedDetails.statusCode).toBe(403);

    const ownerTrace = await app.inject({ method: "GET", url: "/api/runs/" + mainRunId + "/trace/stream", headers: alice });
    expect(ownerTrace.statusCode).toBe(200);
    expect(ownerTrace.body).toContain("run.completed");
    const deniedTrace = await app.inject({ method: "GET", url: "/api/runs/" + mainRunId + "/trace/stream", headers: bob });
    expect(deniedTrace.statusCode).toBe(403);

    const deniedRestore = await app.inject({ method: "POST", url: "/api/checkpoints/" + checkpoint.id + "/restore", headers: bob });
    expect(deniedRestore.statusCode).toBe(403);
    const ownerRestore = await app.inject({ method: "POST", url: "/api/checkpoints/" + checkpoint.id + "/restore", headers: alice });
    expect(ownerRestore.statusCode).toBe(200);
    expect(ownerRestore.json().workspaceHash).toBe(checkpoint.workspaceHash);
    expect(ownerRestore.json().activeWorkspacePath).toBe(
      branchService.getAgent(agentId).workspacePath,
    );

    const deniedDelete = await app.inject({
      method: "DELETE",
      url: "/api/agents/" + agentId + "/branches/" + branchId,
      headers: bob,
    });
    expect(deniedDelete.statusCode).toBe(403);
    expect(branchService.getBranch(branchId).id).toBe(branchId);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: "/api/agents/" + agentId + "/branches/" + branchId,
      headers: alice,
    });
    expect(ownerDelete.statusCode).toBe(200);
    expect(ownerDelete.json().branchId).toBe(branchId);
    expect(ownerDelete.json().archivedWorkspace).toContain(".deleted");
    expect(branchService.getBranches(agentId)).toEqual([]);
    const deletedRunDetails = await app.inject({
      method: "GET",
      url: "/api/runs/" + firstBranchRunId + "/details",
      headers: alice,
    });
    expect(deletedRunDetails.statusCode).toBe(404);

    await app.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
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
    expect(projectsAfterDelete.json().projects).toEqual([]);

    await app.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const validUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tester",
  token: "valid-user-token",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  getUserByToken: (token: string) =>
    token === validUser.token ? validUser : null,
  createUser: async (name: string) => ({ ...validUser, name }),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("rejects API requests without a valid user token", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrongToken.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer valid-user-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("lets anyone create or resume a user without a token", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
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
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const headers = {
      authorization: "Bearer valid-user-token",
      "content-type": "application/json",
    };
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
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

describe("Ownership enforcement (end to end)", () => {
  it("scopes Agents per user, denies cross-user access, and records the decision", async () => {
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
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      realRunner,
    );
    await service.initialize();
    const app = await createApp(config, service);

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
      url: "/api/agents",
      headers: asAlice,
      payload: JSON.stringify({ name: "Alice Agent" }),
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;

    const bobList = await app.inject({ method: "GET", url: "/api/agents", headers: asBob });
    expect(bobList.json().agents).toEqual([]);

    const aliceList = await app.inject({ method: "GET", url: "/api/agents", headers: asAlice });
    expect(aliceList.json().agents.map((agent: { id: string }) => agent.id)).toEqual([agentId]);

    const denied = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId,
      headers: asBob,
    });
    expect(denied.statusCode).toBe(403);

    const bobMessage = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: { authorization: "Bearer " + bob, "content-type": "application/json" },
      payload: JSON.stringify({ content: "do something" }),
    });
    expect(bobMessage.statusCode).toBe(403);

    const auditAsAlice = await app.inject({ method: "GET", url: "/api/audit", headers: asAlice });
    const entries = auditAsAlice.json().entries as Array<{
      decision: string;
      userName: string;
      action: string;
      agentId: string | null;
    }>;
    expect(
      entries.some(
        (entry) =>
          entry.decision === "deny" &&
          entry.userName === "Bob" &&
          entry.agentId === agentId,
      ),
    ).toBe(true);
    expect(
      entries.some((entry) => entry.decision === "allow" && entry.action === "agent.create"),
    ).toBe(true);

    await app.close();
  });
});

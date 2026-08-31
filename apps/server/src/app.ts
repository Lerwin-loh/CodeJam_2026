import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { User } from "./types.js";
import { createProjectZip } from "./project-export.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
}

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const checkpointIdParams = z.object({ id: z.string().uuid() });
const createUserBody = z.object({
  name: z.string().trim().min(1).max(60),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const branchBody = z.object({
  checkpointId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
});
const branchMessageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  branchId: z.string().uuid().nullable().optional(),
});
const branchQuery = z.object({ branchId: z.string().uuid().optional() });
const createCheckpointBody = z.object({
  label: z.string().trim().min(1).max(120),
});

const publicPaths = new Set(["/api/health", "/api/auth"]);

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const path = request.url.split("?")[0] ?? request.url;
    if (publicPaths.has(path)) return;
    // The iframe cannot attach a bearer header, so preview routes authenticate
    // with their short-lived query token in the route below.
    if (path.includes("/preview/") || path.includes("/preview-image")) return;
    if (path === "/api/users" && request.method === "POST") return;
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const user = service.getUserByToken(token);
    if (!user) {
      return reply.code(401).send({ error: "Sign in to continue" });
    }
    request.user = user;
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ mode: "user" }));

  app.post("/api/users", async (request, reply) => {
    const body = createUserBody.parse(request.body);
    const user = await service.createUser(body.name);
    return reply
      .code(201)
      .send({ user: { id: user.id, name: user.name, token: user.token } });
  });

  app.get("/api/users", async () => ({ users: service.listUsers() }));

  app.get("/api/me", async (request) => ({
    user: { id: request.user.id, name: request.user.name },
  }));

  app.get("/api/audit", async (request) => ({
    entries: service.listAudit(request.user),
  }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({
    agents: service.listAgents(request.user.id),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, request.user.id);
    await service.recordAudit({
      user: request.user,
      agentId: agent.id,
      action: "agent.create",
      resource: "agent:" + agent.id,
      decision: "allow",
      reason: "Owner created the Agent",
    });
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const agent = await service.assertAgentAccess(id, request.user, "agent.read");
    return { agent };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.update");
    const body = updateAgentBody.parse(request.body);
    const agent = await service.updateAgent(id, body);
    await service.recordAudit({
      user: request.user,
      agentId: id,
      action: "agent.update",
      resource: "agent:" + id,
      decision: "allow",
      reason: "Owner updated Agent configuration",
    });
    return { agent };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.delete");
    const result = await service.deleteAgent(id);
    await service.recordAudit({
      user: request.user,
      agentId: id,
      action: "agent.delete",
      resource: "agent:" + id,
      decision: "allow",
      reason: "Owner deleted the Agent",
    });
    return result;
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.start");
    const agent = await service.startAgent(id);
    await service.recordAudit({
      user: request.user,
      agentId: id,
      action: "agent.start",
      resource: "agent:" + id,
      decision: "allow",
      reason: "Owner started the Agent",
    });
    return { agent };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.stop");
    const agent = await service.stopAgent(id);
    await service.recordAudit({
      user: request.user,
      agentId: id,
      action: "agent.stop",
      resource: "agent:" + id,
      decision: "allow",
      reason: "Owner stopped the Agent",
    });
    return { agent };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.messages.read");
    const { branchId } = branchQuery.parse(request.query);
    return { messages: service.getMessages(id, branchId ?? null) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.runs.read");
    const { branchId } = branchQuery.parse(request.query);
    return { runs: service.getRuns(id, branchId ?? null) };
  });

  app.get("/api/agents/:id/checkpoints", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.checkpoints.read");
    const { branchId } = branchQuery.parse(request.query);
    return { checkpoints: service.getCheckpoints(id, branchId ?? null) };
  });

  app.get("/api/agents/:id/branches", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.branches.read");
    return { branches: service.getBranches(id) };
  });

  app.post("/api/agents/:id/branches", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "branch.create");
    const body = branchBody.parse(request.body);
    const branch = await service.createBranchFromCheckpoint(id, body.checkpointId, body.name);
    return reply.code(201).send({ branch });
  });

  app.post("/api/agents/:id/checkpoints", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "checkpoint.create");
    const body = createCheckpointBody.parse(request.body);
    const checkpoint = await service.createExplicitCheckpoint(id, body.label);
    await service.recordAudit({
      user: request.user,
      agentId: id,
      action: "checkpoint.create",
      resource: "agent:" + id,
      decision: "allow",
      reason: "Owner saved a named checkpoint",
    });
    return reply.code(201).send({ checkpoint });
  });

  app.get("/api/agents/:id/trace", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.trace.read");
    const { branchId } = branchQuery.parse(request.query);
    return { events: service.getTrace(id, branchId ?? null) };
  });

  app.get("/api/agents/:id/preview-status", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { branchId } = branchQuery.parse(request.query);
    await service.assertAgentAccess(id, request.user, "workspace.preview.read");
    return { preview: await service.getWorkspacePreview(id, branchId ?? null) };
  });

  app.get("/api/agents/:id/export", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const agent = await service.assertAgentAccess(id, request.user, "workspace.export");
    const archive = await createProjectZip(agent);
    const filename = agent.name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "agent-project";
    return reply
      .type("application/zip")
      .header("content-disposition", `attachment; filename="${filename}.zip"`)
      .send(archive);
  });

  app.get("/api/agents/:id/preview-image", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const query = request.query as { token?: string; url?: string };
    const user = service.getUserByToken(query.token ?? "");
    if (!user) return reply.code(401).send({ error: "Preview session expired" });
    await service.assertAgentAccess(id, user, "workspace.preview.read");
    if (!query.url || !/^https:\/\/picsum\.photos\//i.test(query.url)) {
      return reply.code(400).send({ error: "Unsupported preview image" });
    }
    try {
      const upstream = await fetch(query.url);
      if (!upstream.ok) return reply.code(404).send({ error: "Preview image not found" });
      const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
      return reply.header("cache-control", "public, max-age=3600").type(contentType).send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      return reply.code(502).send({ error: "Preview image unavailable" });
    }
  });

  app.get("/api/agents/:id/preview/*", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const query = request.query as { token?: string; branchId?: string };
    const referer = request.headers.referer ?? request.headers.referrer ?? "";
    const refererToken = referer ? new URL(referer).searchParams.get("token") ?? "" : "";
    const user = service.getUserByToken(query.token ?? refererToken);
    if (!user) return reply.code(401).send({ error: "Preview session expired" });
    await service.assertAgentAccess(id, user, "workspace.preview.read");
    const directory = service.getWorkspaceDirectory(id, query.branchId ?? null);
    const relative = String((request.params as { "*": string })["*"] || "index.html");
    const requested = path.resolve(directory, relative);
    if (requested !== directory && !requested.startsWith(directory + path.sep)) {
      return reply.code(400).send({ error: "Invalid preview path" });
    }
    try {
      let body = await readFile(requested);
      const extension = path.extname(requested).toLowerCase();
      const contentType = extension === ".html" ? "text/html; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : extension === ".js" ? "text/javascript; charset=utf-8" : extension === ".json" ? "application/json" : "application/octet-stream";
      if (extension === ".html") {
        const tokenQuery = "?token=" + encodeURIComponent(query.token ?? "") + (query.branchId ? "&branchId=" + encodeURIComponent(query.branchId) : "");
        const html = body.toString("utf8").replace(/((?:href|src)=[\"'])(?!https?:|data:|#|\/)([^\"']+)([\"'])/gi, (_match, start: string, asset: string, end: string) => {
          const separator = asset.includes("?") ? "&" : "?";
          return start + asset + separator + tokenQuery.slice(1) + end;
        }).replace(/((?:href|src)=[\"'])\/(?!api\/)([^\"']+)([\"'])/gi, (_match, start: string, asset: string, end: string) => {
          const entryDirectory = path.posix.dirname(relative);
          const previewPath = entryDirectory === "." ? asset : entryDirectory + "/" + asset;
          return start + "/api/agents/" + id + "/preview/" + previewPath + tokenQuery + end;
        });
        body = Buffer.from(html, "utf8");
      } else if (extension === ".js" || extension === ".mjs") {
        const tokenQuery = "?token=" + encodeURIComponent(query.token ?? "") + (query.branchId ? "&branchId=" + encodeURIComponent(query.branchId) : "");
        const script = body.toString("utf8").replace(/https:\/\/picsum\.photos\/[^\"'`\\]+/gi, (imageUrl) => {
          return "/api/agents/" + id + "/preview-image?url=" + encodeURIComponent(imageUrl) + tokenQuery;
        });
        body = Buffer.from(script, "utf8");
      }
      return reply.type(contentType).send(body);
    } catch {
      return reply.code(404).send({ error: "Preview file not found" });
    }
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.run");
    const body = branchMessageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, body.branchId ?? null);
    await service.recordAudit({
      user: request.user,
      agentId: id,
      action: "agent.run",
      resource: "agent:" + id,
      decision: "allow",
      reason: "Owner sent an instruction to the Agent",
    });
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const run = service.getRun(id);
    await service.assertAgentAccess(run.agentId, request.user, "run.read");
    return { run };
  });

  app.get("/api/runs/:id/trace/stream", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe: () => void = () => {};
    let finished = false;
    const write = (event: import("./types.js").TraceEvent) => {
      if (!reply.raw.destroyed) {
        reply.raw.write("event: trace\ndata: " + JSON.stringify(event) + "\n\n");
        if (["run.completed", "run.error"].includes(event.type)) {
          finished = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          reply.raw.end();
        }
      }
    };
    const subscription = service.subscribeToRunTrace(id, write);
    unsubscribe = subscription.unsubscribe;
    for (const event of subscription.events) write(event);
    if (!finished && !reply.raw.destroyed) reply.raw.write(": connected\n\n");
    if (!finished) heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      subscription.unsubscribe();
    });
  });

  app.get("/api/runs/:id/details", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return service.getRunDetails(id);
  });

  app.get("/api/checkpoints/:id", async (request) => {
    const { id } = checkpointIdParams.parse(request.params);
    const checkpoint = service.getCheckpoint(id);
    await service.assertAgentAccess(
      checkpoint.agentId,
      request.user,
      "checkpoint.read",
    );
    return { checkpoint };
  });

  app.get("/api/checkpoints/:id/details", async (request) => {
    const { id } = checkpointIdParams.parse(request.params);
    const checkpoint = service.getCheckpoint(id);
    await service.assertAgentAccess(
      checkpoint.agentId,
      request.user,
      "checkpoint.read",
    );
    return service.getCheckpointDetails(id);
  });

  app.get("/api/checkpoints/:id/diff", async (request) => {
    const { id } = checkpointIdParams.parse(request.params);
    const checkpoint = service.getCheckpoint(id);
    await service.assertAgentAccess(
      checkpoint.agentId,
      request.user,
      "checkpoint.read",
    );
    return { diff: await service.getCheckpointDiff(id) };
  });

  app.post("/api/checkpoints/:id/restore", async (request) => {
    const { id } = checkpointIdParams.parse(request.params);
    return await service.restoreCheckpoint(id);
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}

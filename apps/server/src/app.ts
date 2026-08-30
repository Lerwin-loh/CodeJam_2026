import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { ProjectService } from "./project-service.js";
import type { User } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
}

const agentIdParams = z.object({ id: z.string().uuid() });
const agentBranchParams = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
});
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
const mergeBranchesBody = z.object({
  branchIds: z.array(z.string().uuid()).min(1).max(50),
});
const securityFixBody = z.object({
  pointIds: z.array(z.string().max(20)).max(10).optional(),
});
const branchQuery = z.object({ branchId: z.string().uuid().optional() });
const createCheckpointBody = z.object({
  label: z.string().trim().min(1).max(120),
});

const projectIdParams = z.object({ id: z.string().uuid() });
const memberParams = z.object({
  id: z.string().uuid(),
  memberId: z.string().uuid(),
});
const createProjectBody = z.object({ name: z.string().trim().min(1).max(120) });
const updateProjectBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, "Nothing to update");
const transferProjectBody = z.object({ toUserId: z.string().uuid() });
const upgradeAgentBody = z.object({ projectName: z.string().trim().min(1).max(120) });
const addMemberBody = z.object({
  userName: z.string().trim().min(1).max(60),
  role: z.string().trim().min(1).max(60),
});
const updateMemberBody = z.object({ role: z.string().trim().min(1).max(60) });
const filePathQuery = z.object({ path: z.string().min(1).max(400) });
const commitRequestBody = z.object({
  title: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional(),
});
const decideCommitBody = z.object({ decision: z.enum(["approved", "rejected"]) });
const commitRequestParams = z.object({ id: z.string().uuid() });

const publicPaths = new Set(["/api/health", "/api/auth"]);

export async function createApp(
  config: AppConfig,
  service: AgentService,
  projects: ProjectService,
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

  app.post("/api/agents/:id/upgrade-to-project", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "agent.upgrade-to-project");
    const body = upgradeAgentBody.parse(request.body);
    const result = await projects.upgradeStandaloneAgent(id, body.projectName, request.user);
    return reply.code(201).send(result);
  });

  // Standalone Agents use the collection routes above. Project parent and child
  // Agents are created through project routes and share these per-Agent routes.

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

  app.post("/api/agents/:id/branches/merge", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "branch.merge");
    const { branchIds } = mergeBranchesBody.parse(request.body);
    return service.mergeBranches(id, branchIds);
  });

  app.delete("/api/agents/:id/branches/:branchId", async (request) => {
    const { id, branchId } = agentBranchParams.parse(request.params);
    await service.assertAgentAccess(id, request.user, "branch.delete");
    const result = await service.deleteBranch(id, branchId);
    await service.recordAudit({
      user: request.user,
      agentId: id,
      action: "branch.delete",
      resource: "branch:" + branchId,
      decision: "allow",
      reason: "Owner deleted an idle leaf branch",
    });
    return result;
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
    const run = service.getRun(id);
    await service.assertAgentAccess(run.agentId, request.user, "run.trace.read");
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
    const run = service.getRun(id);
    await service.assertAgentAccess(run.agentId, request.user, "run.details.read");
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
    const checkpoint = service.getCheckpoint(id);
    await service.assertAgentAccess(
      checkpoint.agentId,
      request.user,
      "checkpoint.restore",
    );
    return await service.restoreCheckpoint(id);
  });

  // --- Collaboration projects (Part 1: RBAC) ----------------------------------

  app.post("/api/projects", async (request, reply) => {
    const body = createProjectBody.parse(request.body);
    const project = await projects.createProject(body.name, request.user.id);
    return reply.code(201).send({ project });
  });

  app.get("/api/projects", async (request) => ({
    projects: projects.listProjects(request.user.id),
    invitations: projects.listPendingInvitations(request.user.id),
  }));

  app.get("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    return projects.getProject(id, request.user);
  });

  app.patch("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "project.update");
    const body = updateProjectBody.parse(request.body);
    return { project: await projects.updateProject(id, request.user, body) };
  });

  app.post("/api/projects/:id/transfer", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "project.transfer");
    const { toUserId } = transferProjectBody.parse(request.body);
    return { project: await projects.transferOwnership(id, request.user, toUserId) };
  });

  app.post("/api/projects/:id/leave", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "project.leave");
    await projects.leaveProject(id, request.user);
    return { ok: true };
  });

  app.post("/api/projects/:id/invitation/accept", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "invitation.respond");
    return { member: await projects.acceptInvitation(id, request.user) };
  });

  app.post("/api/projects/:id/invitation/decline", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "invitation.respond");
    await projects.declineInvitation(id, request.user);
    return { ok: true };
  });

  app.get("/api/projects/:id/activity", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "activity.read");
    return { activity: projects.getActivity(id) };
  });

  app.delete("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "project.delete");
    for (const agentId of projects.projectAgentIds(id)) {
      await service.stopAgent(agentId);
    }
    return projects.deleteProject(id, request.user);
  });

  app.post("/api/projects/:id/archive", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "project.archive");
    for (const agentId of projects.projectAgentIds(id)) {
      await service.stopAgent(agentId);
    }
    const project = await projects.setProjectArchived(id, request.user, true);
    return { project };
  });

  app.post("/api/projects/:id/unarchive", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "project.unarchive");
    const project = await projects.setProjectArchived(id, request.user, false);
    return { project };
  });

  app.get("/api/projects/:id/tree", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "project.tree.read");
    return { files: await projects.getMainTree(id) };
  });

  app.get("/api/projects/:id/file", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const { path: filePath } = filePathQuery.parse(request.query);
    await projects.assertProjectAccess(id, request.user, "file.read");
    return { path: filePath, content: await projects.readMainFile(id, filePath) };
  });

  app.get("/api/projects/:id/members", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const { role } = await projects.assertProjectAccess(id, request.user, "members.read");
    return { members: projects.listMembers(id, role === "owner") };
  });

  app.post("/api/projects/:id/members", async (request, reply) => {
    const { id } = projectIdParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "member.manage");
    const body = addMemberBody.parse(request.body);
    const member = await projects.inviteMember(id, request.user, body);
    return reply.code(201).send({ member });
  });

  app.patch("/api/projects/:id/members/:memberId", async (request) => {
    const { id, memberId } = memberParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "member.manage");
    const body = updateMemberBody.parse(request.body);
    const member = await projects.updateMember(id, memberId, request.user, body);
    return { member };
  });

  app.delete("/api/projects/:id/members/:memberId", async (request) => {
    const { id, memberId } = memberParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "member.manage");
    await projects.removeMember(id, memberId, request.user);
    return { ok: true };
  });

  app.get("/api/projects/:id/parent-agent", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const { project } = await projects.assertProjectAccess(id, request.user, "parent.read");
    const agent = service.getAgent(project.parentAgentId);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        kind: agent.kind,
      },
      messages: service.getMessages(agent.id),
      trace: service.getTrace(agent.id),
      checkpoints: service.getCheckpoints(agent.id),
    };
  });

  app.get("/api/projects/:id/my-agent", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const { member } = await projects.assertProjectAccess(id, request.user, "child.read");
    if (!member) {
      throw new HttpError(403, "Only project members have a child agent");
    }
    const agent = service.getAgent(member.childAgentId);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        kind: agent.kind,
      },
      messages: service.getMessages(agent.id),
      trace: service.getTrace(agent.id),
      checkpoints: service.getCheckpoints(agent.id),
      security: await projects.getMemberSecurity(id, member.id),
    };
  });

  // Part 1B: the pre-commit OWASP gate, cheapest-path-first —
  //  1. only the branch-vs-main diff is in scope (no full-tree scan);
  //  2. a fast static pass runs with zero tokens; if it finds issues we stop there;
  //  3. otherwise ONE direct model call over just the changed files (no agent,
  //     no tools, no conversation history).
  app.post("/api/projects/:id/members/:memberId/security-analysis", async (request) => {
    const { id, memberId } = memberParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "security.check", { memberId });
    return { security: await projects.runSecurityGate(id, memberId) };
  });

  // Auto-fix flagged OWASP findings — one direct model call per affected file,
  // no agent run. `pointIds` optional: omit to fix every flagged finding.
  app.post("/api/projects/:id/members/:memberId/security-fix", async (request) => {
    const { id, memberId } = memberParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "security.check", { memberId });
    const { pointIds } = securityFixBody.parse(request.body ?? {});
    return { security: await projects.applySecurityFixes(id, memberId, pointIds ?? null) };
  });

  app.post("/api/projects/:id/members/:memberId/commit-request", async (request, reply) => {
    const { id, memberId } = memberParams.parse(request.params);
    await projects.assertProjectAccess(id, request.user, "commit.request.create", { memberId });
    const body = commitRequestBody.parse(request.body);
    const created = await projects.submitCommitRequest(id, memberId, body);
    return reply.code(201).send({ request: created });
  });

  app.get("/api/projects/:id/commit-requests", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const { role, member } = await projects.assertProjectAccess(
      id,
      request.user,
      "commit.request.read",
    );
    return {
      requests: projects.listCommitRequests(id, role === "owner" ? null : member),
    };
  });

  app.post("/api/commit-requests/:id/decide", async (request) => {
    const { id } = commitRequestParams.parse(request.params);
    const existing = projects.getCommitRequest(id);
    await projects.assertProjectAccess(
      existing.projectId,
      request.user,
      "commit.request.decide",
    );
    const body = decideCommitBody.parse(request.body);
    const updated = await projects.decideCommitRequest(id, body.decision, request.user);
    return { request: updated };
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

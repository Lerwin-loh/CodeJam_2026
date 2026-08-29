import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  AgentCheckpoint,
  AuditDecision,
  AuditEntry,
  CheckpointDetails,
  CheckpointDiff,
  CreateAgentInput,
  Message,
  RunnerEvent,
  AgentContextSnapshot,
  TraceEvent,
  TraceEventType,
  RunDetails,
  User,
  WorkspaceManifest,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { WorkspaceHistory } from "./workspace-history.js";

const now = () => new Date().toISOString();

function buildDiffHunks(
  before: string | null,
  after: string | null,
): Array<{
  oldStart: number;
  newStart: number;
  lines: Array<{ type: "context" | "added" | "removed"; content: string }>;
}> {
  const oldLines = (before ?? "").split("\n");
  const newLines = (after ?? "").split("\n");
  if (before === null) {
    return [{ oldStart: 0, newStart: 1, lines: newLines.map((content) => ({ type: "added" as const, content })) }];
  }
  if (after === null) {
    return [{ oldStart: 1, newStart: 0, lines: oldLines.map((content) => ({ type: "removed" as const, content })) }];
  }
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  if (prefix === oldLines.length && prefix === newLines.length) return [];
  const context = 3;
  const start = Math.max(0, prefix - context);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + context);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + context);
  const lines: Array<{ type: "context" | "added" | "removed"; content: string }> = [];
  for (let index = start; index < prefix; index += 1) lines.push({ type: "context", content: oldLines[index] ?? "" });
  for (let index = prefix; index < oldLines.length - suffix; index += 1) lines.push({ type: "removed", content: oldLines[index] ?? "" });
  for (let index = prefix; index < newLines.length - suffix; index += 1) lines.push({ type: "added", content: newLines[index] ?? "" });
  for (let index = oldLines.length - suffix; index < oldEnd && index < oldLines.length; index += 1) lines.push({ type: "context", content: oldLines[index] ?? "" });
  return [{ oldStart: start + 1, newStart: start + 1, lines }];
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly traceListeners = new Map<string, Set<(event: TraceEvent) => void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly history = new WorkspaceHistory(path.join(config.dataDirectory, "branchpoint")),
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.history.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
      const orphans = database.agents.filter((agent) => !agent.ownerId);
      if (orphans.length > 0) {
        let demo = database.users.find(
          (user) => user.name.toLowerCase() === "demo",
        );
        if (!demo) {
          demo = {
            id: randomUUID(),
            name: "demo",
            token: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
            createdAt: now(),
          };
          database.users.push(demo);
        }
        for (const agent of orphans) agent.ownerId = demo.id;
      }
    });
  }

  listUsers(): Array<Pick<User, "id" | "name" | "createdAt">> {
    return this.store
      .snapshot()
      .users.map(({ id, name, createdAt }) => ({ id, name, createdAt }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getUserByToken(token: string): User | null {
    const trimmed = token.trim();
    if (!trimmed) return null;
    return (
      this.store.snapshot().users.find((user) => user.token === trimmed) ?? null
    );
  }

  async createUser(name: string): Promise<User> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new HttpError(400, "Enter a name to continue.");
    }
    if (trimmed.length > 60) {
      throw new HttpError(400, "Name must be 60 characters or fewer.");
    }
    return this.store.mutate((database) => {
      const existing = database.users.find(
        (user) => user.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (existing) return structuredClone(existing);
      const user: User = {
        id: randomUUID(),
        name: trimmed,
        token: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
        createdAt: now(),
      };
      database.users.push(user);
      return structuredClone(user);
    });
  }

  async recordAudit(entry: {
    user: User;
    agentId: string | null;
    action: string;
    resource: string;
    decision: AuditDecision;
    reason: string;
  }): Promise<void> {
    await this.store.mutate((database) => {
      database.audit.push({
        id: randomUUID(),
        userId: entry.user.id,
        userName: entry.user.name,
        agentId: entry.agentId,
        action: entry.action,
        resource: entry.resource,
        decision: entry.decision,
        reason: entry.reason,
        timestamp: now(),
      });
      if (database.audit.length > 2_000) {
        database.audit.splice(0, database.audit.length - 2_000);
      }
    });
  }

  listAudit(user: User): AuditEntry[] {
    const database = this.store.snapshot();
    const ownedAgentIds = new Set(
      database.agents
        .filter((agent) => agent.ownerId === user.id)
        .map((agent) => agent.id),
    );
    return database.audit
      .filter(
        (entry) =>
          entry.userId === user.id ||
          (entry.agentId !== null && ownedAgentIds.has(entry.agentId)),
      )
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 200);
  }

  async assertAgentAccess(
    agentId: string,
    user: User,
    action: string,
  ): Promise<Agent> {
    const database = this.store.snapshot();
    const agent = database.agents.find((item) => item.id === agentId);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    if (agent.ownerId === user.id) {
      return agent;
    }
    // The owner of a project may reach every Agent inside it (parent and children).
    if (agent.projectId) {
      const project = database.projects.find((item) => item.id === agent.projectId);
      if (project && project.ownerId === user.id) {
        return agent;
      }
    }
    await this.recordAudit({
      user,
      agentId: agent.id,
      action,
      resource: "agent:" + agent.id,
      decision: "deny",
      reason: "Agent belongs to a different user",
    });
    throw new HttpError(403, "You do not have access to this Agent");
  }

  /** Standalone Agents only. Project Agents are reached through the project routes. */
  listAgents(ownerId: string): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.ownerId === ownerId && agent.projectId === null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput, ownerId: string): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      ownerId,
      projectId: null,
      kind: "standalone",
      memberId: null,
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  private async updateRunWorkspace(
    runId: string,
    beforeWorkspaceHash: string | null,
    afterWorkspaceHash: string | null,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) return;
      run.beforeWorkspaceHash = beforeWorkspaceHash;
      run.afterWorkspaceHash = afterWorkspaceHash;
    });
  }

  private async captureCheckpoint(
    agent: Agent,
    run: AgentRun,
    before: WorkspaceManifest,
    status: "complete" | "partial",
    output: string | null,
    threadId: string | null,
  ): Promise<AgentCheckpoint | null> {
    try {
      const after = await this.history.manifest(agent.workspacePath);
      const changedFiles = this.history.diff(before, after);
      const hasChanges =
        changedFiles.created.length +
          changedFiles.modified.length +
          changedFiles.deleted.length >
        0;
      await this.updateRunWorkspace(run.id, before.workspaceHash, after.workspaceHash);
      if (!hasChanges) return null;

      const snapshot = await this.history.createSnapshot(
        agent.id,
        run.id,
        agent.workspacePath,
        after,
      );
      const messages = this.getMessages(agent.id, run.branchId);
      if (output) {
        messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          branchId: run.branchId,
          role: "assistant",
          content: output,
          createdAt: now(),
        });
      }
      const context: AgentContextSnapshot = {
        id: randomUUID(),
        agentId: agent.id,
        runId: run.id,
        agentName: agent.name,
        agentDescription: agent.description,
        instructions: agent.instructions,
        messages,
        sourceThreadId: threadId,
        createdAt: now(),
      };
      const parentCheckpointId = this.store
        .snapshot()
        .checkpoints
        .filter((checkpoint) => checkpoint.agentId === agent.id && checkpoint.branchId === run.branchId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.id ?? null;
      const checkpoint: AgentCheckpoint = {
        id: randomUUID(),
        agentId: agent.id,
        branchId: run.branchId,
        runId: run.id,
        parentCheckpointId,
        snapshotId: snapshot.id,
        contextId: context.id,
        workspaceHash: after.workspaceHash,
        changedFiles,
        status,
        reason: "auto-mutation",
        label: null,
        createdAt: now(),
      };
      await this.store.mutate((database) => {
        database.snapshots.push(snapshot);
        database.contexts.push(context);
        database.checkpoints.push(checkpoint);
      });
      await this.trace(run, "workspace.changed", { ...changedFiles });
      await this.trace(run, "checkpoint.created", {
        checkpointId: checkpoint.id,
        snapshotId: snapshot.id,
        status,
        workspaceHash: after.workspaceHash,
      });
      return checkpoint;
    } catch (error) {
      await this.trace(run, "run.error", {
        stage: "checkpoint",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async trace(
    run: AgentRun,
    type: TraceEventType,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const event = await this.store.mutate((database) => {
      const traceEvent: TraceEvent = {
        id: randomUUID(),
        runId: run.id,
        agentId: run.agentId,
        branchId: run.branchId,
        type,
        timestamp: now(),
        metadata: {
          explanation: this.traceExplanation(type),
          ...metadata,
        },
      };
      database.traces.push(traceEvent);
      return traceEvent;
    });
    for (const listener of this.traceListeners.get(run.id) ?? []) listener(event);
  }

  private traceExplanation(type: TraceEventType): string {
    switch (type) {
      case "run.started":
        return "The Agent began processing the user instruction.";
      case "codex.event":
        return "Codex reported an observable tool or model activity.";
      case "workspace.changed":
        return "The Agent changed files in its workspace.";
      case "checkpoint.created":
        return "A recoverable snapshot was created from the workspace mutation.";
      case "run.completed":
        return "The Agent finished successfully.";
      case "run.error":
        return "The Run ended with an error or cancellation.";
    }
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  private branchHistoryLimits(database: import("./types.js").Database, agentId: string, branchId: string | null): Map<string | null, string> {
    if (!branchId) return new Map([[null, "\uffff"]]);
    const limits = new Map<string | null, string>([[branchId, "\uffff"]]);
    let current = database.branches.find((branch) => branch.id === branchId);
    while (current) {
      const checkpoint = database.checkpoints.find((item) => item.id === current?.parentCheckpointId);
      const checkpointRun = checkpoint ? database.runs.find((run) => run.id === checkpoint.runId) : null;
      const cutoff = checkpointRun?.completedAt ?? checkpoint?.createdAt ?? "";
      const sourceBranchId = current.parentBranchId;
      const previous = limits.get(sourceBranchId);
      if (!previous || cutoff < previous) limits.set(sourceBranchId, cutoff);
      current = sourceBranchId
        ? database.branches.find((branch) => branch.id === sourceBranchId)
        : undefined;
    }
    return limits;
  }

  private visibleOnBranch(database: import("./types.js").Database, agentId: string, branchId: string | null, itemBranchId: string | null, createdAt: string): boolean {
    if (branchId === null) return itemBranchId === null;
    if (itemBranchId === branchId) return true;
    const limit = this.branchHistoryLimits(database, agentId, branchId).get(itemBranchId);
    return limit !== undefined && createdAt <= limit;
  }

  getMessages(agentId: string, branchId: string | null = null): Message[] {
    this.getAgent(agentId);
    const database = this.store.snapshot();
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .filter((message) => this.visibleOnBranch(database, agentId, branchId, message.branchId, message.createdAt))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRunDetails(runId: string): RunDetails {
    const database = this.store.snapshot();
    const run = database.runs.find((item) => item.id === runId);
    if (!run) throw new HttpError(404, "Run not found");
    return {
      run,
      trace: database.traces
        .filter((event) => event.runId === runId)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    };
  }

  getRuns(agentId: string, branchId: string | null = null): AgentRun[] {
    this.getAgent(agentId);
    const database = this.store.snapshot();
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .filter((run) => this.visibleOnBranch(database, agentId, branchId, run.branchId, run.createdAt))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getBranches(agentId: string): import("./types.js").AgentBranch[] {
    this.getAgent(agentId);
    return this.store.snapshot().branches
      .filter((branch) => branch.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getBranch(id: string): import("./types.js").AgentBranch {
    const branch = this.store.snapshot().branches.find((item) => item.id === id);
    if (!branch) throw new HttpError(404, "Branch not found");
    return branch;
  }

  async createBranchFromCheckpoint(
    agentId: string,
    checkpointId: string,
    name: string,
  ): Promise<import("./types.js").AgentBranch> {
    const agent = this.getAgent(agentId);
    const database = this.store.snapshot();
    const checkpoint = database.checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint || checkpoint.agentId !== agentId) throw new HttpError(404, "Checkpoint not found");
    const snapshot = database.snapshots.find((item) => item.id === checkpoint.snapshotId);
    if (!snapshot) throw new HttpError(500, "Checkpoint snapshot is missing");
    const branchId = randomUUID();
    const branch: import("./types.js").AgentBranch = {
      id: branchId,
      agentId,
      name: name.trim(),
      parentBranchId: checkpoint.branchId,
      parentCheckpointId: checkpointId,
      workspacePath: this.workspaces.branchWorkspacePath(agentId, branchId),
      codexThreadId: null,
      status: "ready",
      createdAt: now(),
      updatedAt: now(),
    };
    await mkdir(path.dirname(branch.workspacePath), { recursive: true });
    await this.history.restoreSnapshot(snapshot, branch.workspacePath);
    await this.store.mutate((next) => next.branches.push(branch));
    return branch;
  }

  getCheckpoints(agentId: string, branchId: string | null = null): AgentCheckpoint[] {
    this.getAgent(agentId);
    const database = this.store.snapshot();
    return this.store
      .snapshot()
      .checkpoints
      .filter((checkpoint) => checkpoint.agentId === agentId)
      .filter((checkpoint) => this.visibleOnBranch(database, agentId, branchId, checkpoint.branchId, checkpoint.createdAt))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getCheckpoint(id: string): AgentCheckpoint {
    const checkpoint = this.store.snapshot().checkpoints.find((item) => item.id === id);
    if (!checkpoint) throw new HttpError(404, "Checkpoint not found");
    return checkpoint;
  }

  async createExplicitCheckpoint(
    agentId: string,
    label: string,
  ): Promise<AgentCheckpoint> {
    const agent = this.getAgent(agentId);
    if (agent.status === "busy") {
      throw new HttpError(
        409,
        "This Agent has a run in progress. Wait for it to finish, then save the checkpoint.",
      );
    }
    const name = label.trim();
    if (!name) {
      throw new HttpError(400, "Enter a name for the checkpoint.");
    }

    const database = this.store.snapshot();
    const latestRun = database.runs
      .filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    if (!latestRun) {
      throw new HttpError(
        409,
        "Send the Agent at least one instruction before saving a checkpoint. Checkpoints snapshot the workspace produced by a run.",
      );
    }
    const latestCheckpoint = database.checkpoints
      .filter((checkpoint) => checkpoint.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    const parentSnapshot = latestCheckpoint
      ? database.snapshots.find((item) => item.id === latestCheckpoint.snapshotId) ?? null
      : null;

    const after = await this.history.manifest(agent.workspacePath);
    const baseline: WorkspaceManifest = parentSnapshot?.manifest ?? {
      workspaceHash: "",
      files: [],
      createdAt: now(),
    };
    const changedFiles = this.history.diff(baseline, after);
    // An explicit checkpoint is a user-intent marker: always save it. When the
    // workspace is identical to the last checkpoint, reuse its snapshot instead
    // of copying the same files again.
    const unchanged =
      parentSnapshot !== null &&
      changedFiles.created.length +
        changedFiles.modified.length +
        changedFiles.deleted.length ===
        0;
    const snapshot = unchanged
      ? null
      : await this.history.createSnapshot(
          agent.id,
          latestRun.id,
          agent.workspacePath,
          after,
        );
    const snapshotId = snapshot?.id ?? parentSnapshot!.id;
    const context: AgentContextSnapshot = {
      id: randomUUID(),
      agentId: agent.id,
      runId: latestRun.id,
      agentName: agent.name,
      agentDescription: agent.description,
      instructions: agent.instructions,
      messages: this.getMessages(agent.id),
      sourceThreadId: agent.codexThreadId,
      createdAt: now(),
    };
    const checkpoint: AgentCheckpoint = {
      id: randomUUID(),
      agentId: agent.id,
      branchId: latestRun.branchId,
      runId: latestRun.id,
      parentCheckpointId: latestCheckpoint?.id ?? null,
      snapshotId,
      contextId: context.id,
      workspaceHash: after.workspaceHash,
      changedFiles,
      status: "complete",
      reason: "explicit",
      label: name,
      createdAt: now(),
    };
    await this.store.mutate((db) => {
      if (snapshot) db.snapshots.push(snapshot);
      db.contexts.push(context);
      db.checkpoints.push(checkpoint);
    });
    await this.trace(latestRun, "checkpoint.created", {
      checkpointId: checkpoint.id,
      snapshotId,
      status: "complete",
      workspaceHash: after.workspaceHash,
      reason: "explicit",
      label: name,
    });
    return checkpoint;
  }

  getCheckpointDetails(id: string): CheckpointDetails {
    const database = this.store.snapshot();
    const checkpoint = database.checkpoints.find((item) => item.id === id);
    if (!checkpoint) throw new HttpError(404, "Checkpoint not found");
    const run = database.runs.find((item) => item.id === checkpoint.runId);
    const context = database.contexts.find((item) => item.id === checkpoint.contextId);
    const snapshot = database.snapshots.find((item) => item.id === checkpoint.snapshotId);
    if (!run || !context || !snapshot) {
      throw new HttpError(500, "Checkpoint metadata is incomplete");
    }
    return {
      checkpoint,
      run,
      context,
      snapshot,
      trace: database.traces
        .filter((event) => event.runId === checkpoint.runId)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    };
  }

  async getCheckpointDiff(id: string): Promise<CheckpointDiff> {
    const database = this.store.snapshot();
    const checkpoint = database.checkpoints.find((item) => item.id === id);
    if (!checkpoint) throw new HttpError(404, "Checkpoint not found");
    const snapshot = database.snapshots.find((item) => item.id === checkpoint.snapshotId);
    const parent = checkpoint.parentCheckpointId
      ? database.checkpoints.find((item) => item.id === checkpoint.parentCheckpointId)
      : null;
    const parentSnapshot = parent
      ? database.snapshots.find((item) => item.id === parent.snapshotId)
      : null;
    if (!snapshot) throw new HttpError(500, "Checkpoint snapshot is missing");
    const changedFiles = parentSnapshot
      ? this.history.diff(parentSnapshot.manifest, snapshot.manifest)
      : checkpoint.changedFiles;
    const paths = [
      ...changedFiles.created,
      ...changedFiles.modified,
      ...changedFiles.deleted,
    ];
    const files = await Promise.all(paths.map(async (filePath) => {
      const before = parentSnapshot
        ? await this.history.readSnapshotFile(parentSnapshot, filePath)
        : null;
      const after = await this.history.readSnapshotFile(snapshot, filePath);
      return {
        path: filePath,
        status: changedFiles.created.includes(filePath)
          ? ("created" as const)
          : changedFiles.deleted.includes(filePath)
            ? ("deleted" as const)
            : ("modified" as const),
        hunks: buildDiffHunks(before, after),
      };
    }));
    return {
      checkpointId: id,
      parentCheckpointId: checkpoint.parentCheckpointId,
      changedFiles,
      files,
    };
  }

  async restoreCheckpoint(checkpointId: string): Promise<{ checkpoint: AgentCheckpoint; workspacePath: string; workspaceHash: string }> {
    const checkpoint = this.getCheckpoint(checkpointId);
    const snapshot = this.store
      .snapshot()
      .snapshots.find((item) => item.id === checkpoint.snapshotId);
    if (!snapshot) {
      throw new HttpError(500, "Checkpoint snapshot is missing");
    }
    const restoreRoot = path.join(this.config.dataDirectory, "branchpoint", "restores");
    await mkdir(restoreRoot, { recursive: true });
    const workspacePath = path.join(restoreRoot, checkpoint.id + "-" + Date.now());
    await this.history.restoreSnapshot(snapshot, workspacePath);
    return {
      checkpoint,
      workspacePath,
      workspaceHash: snapshot.manifest.workspaceHash,
    };
  }

  getTrace(agentId: string, branchId: string | null = null): TraceEvent[] {
    this.getAgent(agentId);
    const database = this.store.snapshot();
    return this.store
      .snapshot()
      .traces
      .filter((event) => event.agentId === agentId)
      .filter((event) => this.visibleOnBranch(database, agentId, branchId, event.branchId, event.timestamp))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  subscribeToRunTrace(
    runId: string,
    listener: (event: TraceEvent) => void,
  ): { events: TraceEvent[]; unsubscribe: () => void } {
    const run = this.getRun(runId);
    const listeners = this.traceListeners.get(runId) ?? new Set<(event: TraceEvent) => void>();
    listeners.add(listener);
    this.traceListeners.set(runId, listeners);
    const events = this.store.snapshot().traces
      .filter((event) => event.runId === runId)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return {
      events,
      unsubscribe: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.traceListeners.delete(runId);
      },
    };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    branchId: string | null = null,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const branch = branchId ? this.getBranch(branchId) : null;
    if (branch && branch.agentId !== agentId) throw new HttpError(404, "Branch not found");
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      branchId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      beforeWorkspaceHash: null,
      afterWorkspaceHash: null,
      checkpointId: null,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      branchId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (!branchId && storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      const storedBranch = branchId
        ? database.branches.find((item) => item.id === branchId && item.agentId === agentId)
        : null;
      if (branchId && (!storedBranch || storedBranch.status === "busy")) {
        throw new HttpError(409, storedBranch ? "This branch is already running" : "Branch not found");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      if (storedBranch) {
        storedBranch.status = "busy";
        storedBranch.updatedAt = timestamp;
      } else {
        storedAgent.status = "busy";
        storedAgent.lastError = null;
      }
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    const executionKey = branchId ?? agentId;
    this.activeExecutions.set(executionKey, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(executionKey) === execution) {
          this.activeExecutions.delete(executionKey);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const branch = run.branchId ? this.getBranch(run.branchId) : null;
    const executionAgent = branch
      ? { ...agentAtStart, workspacePath: branch.workspacePath, codexThreadId: branch.codexThreadId }
      : agentAtStart;
    const runnerAgentId = branch?.id ?? agentAtStart.id;
    let before: WorkspaceManifest | null = null;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    await this.trace(run, "run.started", { workspacePath: executionAgent.workspacePath });
    try {
      if (this.cancellationRequests.has(runnerAgentId)) {
        throw new RunCancelledError();
      }
      before = await this.history.manifest(executionAgent.workspacePath);
      await this.updateRunWorkspace(run.id, before.workspaceHash, null);
      let streamedRunnerEvents = 0;
      const result = await this.runner.run({
        agentId: runnerAgentId,
        workspacePath: executionAgent.workspacePath,
        prompt: run.prompt,
        threadId: executionAgent.codexThreadId,
        onEvent: (event) => {
          streamedRunnerEvents += 1;
          void this.trace(run, "codex.event", {
            eventType: event.type,
            ...event.metadata,
          });
        },
      });
      if (streamedRunnerEvents === 0) {
        for (const event of result.events ?? []) {
          await this.trace(run, "codex.event", {
            eventType: event.type,
            ...event.metadata,
          });
        }
      }
      const checkpoint = before
        ? await this.captureCheckpoint(executionAgent, run, before, "complete", result.output, result.threadId)
        : null;
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        const branchRecord = run.branchId ? database.branches.find((item) => item.id === run.branchId) : null;
        if (!storedRun || !agent || (run.branchId && !branchRecord)) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        storedRun.afterWorkspaceHash = checkpoint?.workspaceHash ?? before?.workspaceHash ?? null;
        storedRun.checkpointId = checkpoint?.id ?? null;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          branchId: run.branchId,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        if (branchRecord) {
          branchRecord.status = "ready";
          branchRecord.codexThreadId = result.threadId;
          branchRecord.updatedAt = completedAt;
        } else {
          agent.status = "ready";
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
        }
        agent.updatedAt = completedAt;
      });
      await this.trace(run, "run.completed", {
        checkpointId: checkpoint?.id ?? null,
        workspaceChanged: checkpoint !== null,
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const checkpoint = before
        ? await this.captureCheckpoint(
            executionAgent,
            run,
            before,
            "partial",
            null,
            agentAtStart.codexThreadId,
          )
        : null;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        const branchRecord = run.branchId ? database.branches.find((item) => item.id === run.branchId) : null;
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.afterWorkspaceHash = checkpoint?.workspaceHash ?? before?.workspaceHash ?? null;
          storedRun.checkpointId = checkpoint?.id ?? null;
        }
        if (branchRecord) {
          branchRecord.status = cancelled ? "ready" : "error";
          branchRecord.updatedAt = completedAt;
        } else if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      await this.trace(run, "run.error", {
        error: message,
        status: cancelled ? "cancelled" : "failed",
        checkpointId: checkpoint?.id ?? null,
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

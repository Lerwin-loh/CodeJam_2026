export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface User {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export type AuditDecision = "allow" | "deny";

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  agentId: string | null;
  action: string;
  resource: string;
  decision: AuditDecision;
  reason: string;
  timestamp: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  beforeWorkspaceHash: string | null;
  afterWorkspaceHash: string | null;
  checkpointId: string | null;
}

export type TraceEventType =
  | "run.started"
  | "codex.event"
  | "workspace.changed"
  | "checkpoint.created"
  | "run.completed"
  | "run.error";

export interface TraceEvent {
  id: string;
  runId: string;
  agentId: string;
  type: TraceEventType;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface WorkspaceManifest {
  workspaceHash: string;
  files: WorkspaceFile[];
  createdAt: string;
}

export interface WorkspaceSnapshot {
  id: string;
  agentId: string;
  runId: string | null;
  directory: string;
  manifest: WorkspaceManifest;
  createdAt: string;
}

export interface AgentContextSnapshot {
  id: string;
  agentId: string;
  runId: string | null;
  agentName: string;
  agentDescription: string;
  instructions: string;
  messages: Message[];
  sourceThreadId: string | null;
  createdAt: string;
}

export interface ChangedFiles {
  created: string[];
  modified: string[];
  deleted: string[];
}

export interface AgentCheckpoint {
  id: string;
  agentId: string;
  runId: string;
  parentCheckpointId: string | null;
  snapshotId: string;
  contextId: string;
  workspaceHash: string;
  changedFiles: ChangedFiles;
  status: "complete" | "partial";
  reason: "auto-mutation" | "explicit";
  label: string | null;
  createdAt: string;
}

export interface CheckpointDiff {
  checkpointId: string;
  parentCheckpointId: string | null;
  changedFiles: ChangedFiles;
  files: Array<{
    path: string;
    status: "created" | "modified" | "deleted";
    hunks: Array<{
      oldStart: number;
      newStart: number;
      lines: Array<{ type: "context" | "added" | "removed"; content: string }>;
    }>;
  }>;
}

export interface CheckpointDetails {
  checkpoint: AgentCheckpoint;
  run: AgentRun;
  context: AgentContextSnapshot;
  trace: TraceEvent[];
  snapshot: WorkspaceSnapshot;
}

export interface Database {
  version: 1;
  users: User[];
  audit: AuditEntry[];
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  traces: TraceEvent[];
  snapshots: WorkspaceSnapshot[];
  contexts: AgentContextSnapshot[];
  checkpoints: AgentCheckpoint[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  events?: RunnerEvent[];
}

export interface RunnerEvent {
  type: string;
  metadata: Record<string, unknown>;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

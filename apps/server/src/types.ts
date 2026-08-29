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

/** Where an Agent sits in the project structure. */
export type AgentKind = "standalone" | "parent" | "child";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
  /** null for a standalone Agent; the owning Project otherwise. */
  projectId: string | null;
  kind: AgentKind;
  /** For a child Agent: the ProjectMember it belongs to. */
  memberId: string | null;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A collaboration project: one canonical `main` tree, one owner, many members. */
export interface Project {
  id: string;
  name: string;
  ownerId: string;
  mainWorkspacePath: string;
  parentAgentId: string;
  /** Snapshot id of the current canonical `main` tree. */
  headSnapshotId: string;
  createdAt: string;
  updatedAt: string;
}

/** A human on a project. The owner is implicit (Project.ownerId) and has no row. */
export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  /** Free-text label the owner assigns, e.g. "Frontend", "Backend". */
  role: string;
  childAgentId: string;
  workspacePath: string;
  lastSecurityCheck: SecurityCheckResult | null;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityFinding {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

export interface SecurityCheckResult {
  ranAt: string;
  filesScanned: number;
  findings: SecurityFinding[];
}

export type CommitRequestStatus = "pending" | "approved" | "rejected" | "merged";

/** A member asking for their current work to be pushed to main. */
export interface CommitRequest {
  id: string;
  projectId: string;
  memberId: string;
  memberName: string;
  role: string;
  childAgentId: string;
  title: string;
  note: string;
  status: CommitRequestStatus;
  changedFiles: ChangedFiles;
  securityCheck: SecurityCheckResult | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AgentBranch {
  id: string;
  agentId: string;
  name: string;
  parentBranchId: string | null;
  parentCheckpointId: string | null;
  workspacePath: string;
  codexThreadId: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  branchId: string | null;
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
  branchId: string | null;
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
  branchId: string | null;
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
  sessionRolloutPath: string | null;
  sessionLineOffset: number | null;
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
  branchId: string | null;
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

export interface RunDetails {
  run: AgentRun;
  trace: TraceEvent[];
}

export interface Database {
  version: 1;
  users: User[];
  audit: AuditEntry[];
  agents: Agent[];
  projects: Project[];
  projectMembers: ProjectMember[];
  commitRequests: CommitRequest[];
  branches: AgentBranch[];
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
  onEvent?: (event: RunnerEvent) => void;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

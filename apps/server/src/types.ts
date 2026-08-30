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
  description: string;
  ownerId: string;
  mainWorkspacePath: string;
  parentAgentId: string;
  /** Snapshot id of the current canonical `main` tree. */
  headSnapshotId: string;
  /** ISO timestamp when the owner archived the project; null while active. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectMemberStatus = "invited" | "active";

/**
 * A human on a project. The owner is implicit (Project.ownerId) and has no row.
 * An "invited" row has no child agent / workspace yet — those are created when
 * the invitee accepts.
 */
export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  status: ProjectMemberStatus;
  /** Free-text label the owner assigns, e.g. "Frontend", "Backend". */
  role: string;
  /** "" until the invite is accepted. */
  childAgentId: string;
  /** "" until the invite is accepted. */
  workspacePath: string;
  /** Latest OWASP analysis the member's child agent ran against this branch. */
  securityAnalysis: SecurityAnalysis | null;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type OwaspStatus = "pass" | "fail" | "na";

/** One OWASP Top 10 (2021) category verdict from the child agent. */
export interface SecurityAnalysisPoint {
  /** e.g. "A01:2021". */
  id: string;
  /** e.g. "Broken Access Control". */
  name: string;
  status: OwaspStatus;
  detail: string;
  /** For `fail`: the file the issue was found in, relative to the branch. */
  file?: string;
  /** For `fail`: the flagged code, verbatim. */
  evidence?: string;
  /** For `fail`: how to fix it. */
  remediation?: string;
}

/**
 * Result of a child-agent OWASP Top 10 review of a member's branch. The commit
 * gate opens only while `passed` is true AND `workspaceHash` still equals the
 * branch's current hash (any file change since makes it stale).
 */
export interface SecurityAnalysis {
  ranAt: string;
  /** The child-agent run that produced this verdict. */
  runId: string;
  /** Branch workspace hash the verdict reflects. */
  workspaceHash: string;
  /** All ten points parsed and none is "fail". */
  passed: boolean;
  points: SecurityAnalysisPoint[];
  /** Short human summary, or the reason the verdict could not be trusted. */
  summary: string;
  /** True if the analysis run itself changed files in the branch. */
  modifiedWorkspace: boolean;
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
  securityAnalysis: SecurityAnalysis | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface MergeOutcome {
  id: string;
  label: string;
  summary: string;
  details: string[];
  requestedFeatures: string[];
}

export interface MergeSide {
  id: string;
  label: string;
  workspacePath: string;
  outcome: MergeOutcome;
  prompts: string[];
  conversation: ConversationCommit[];
  baseConversation?: ConversationCommit[];
  session?: {
    threadId: string | null;
    rolloutRelativePath: string | null;
    baseLineOffset: number | null;
    baseThreadId?: string | null;
  };
  baseSnapshot?: WorkspaceSnapshot | null;
}

export interface ConversationCommit {
  id: string;
  runId: string;
  branchId: string | null;
  prompt: string;
  response: string | null;
  createdAt: string;
  sessionRolloutPath?: string | null;
  sessionLineOffset?: number | null;
  origin?: "base" | "target" | "source";
}

export interface MergeWorkspaceConflict {
  path: string;
  targetContent: string | null;
  sourceContent: string | null;
  baseContent: string | null;
  targetPaths?: string[];
  sourcePaths?: string[];
}

export interface MergeContextConflict {
  id: string;
  target: ConversationCommit;
  source: ConversationCommit;
  targetSideId: string;
  sourceSideId: string;
  targetDeleted?: boolean;
  sourceDeleted?: boolean;
}

export interface MergePreview {
  target: MergeOutcome;
  source: MergeOutcome;
  targetPrompts: string[];
  sourcePrompts: string[];
  baseConversation: ConversationCommit[];
  targetConversation: ConversationCommit[];
  sourceConversation: ConversationCommit[];
  acceptanceCriteria: string[];
  changedFiles: ChangedFiles;
  workspaceConflicts: MergeWorkspaceConflict[];
  contextConflicts: MergeContextConflict[];
}

export interface MergeResolution {
  workspace: Record<string, "target" | "source" | "ai">;
  context: Record<string, "target" | "source" | "ai">;
}

export interface MergeResult {
  preview: MergePreview;
  conversation: ConversationCommit[];
  snapshot: WorkspaceSnapshot | null;
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

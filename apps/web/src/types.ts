export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface User {
  id: string;
  name: string;
}

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  agentId: string | null;
  action: string;
  resource: string;
  decision: "allow" | "deny";
  reason: string;
  timestamp: string;
}

export type AgentKind = "standalone" | "parent" | "child";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
  projectId?: string | null;
  kind?: AgentKind;
  memberId?: string | null;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  mainWorkspacePath: string;
  parentAgentId: string;
  headSnapshotId: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectMemberStatus = "invited" | "active";

export interface ProjectInvitation {
  projectId: string;
  projectName: string;
  role: string;
  invitedByName: string;
  invitedAt: string;
}

export interface ActivityEntry {
  id: string;
  userName: string;
  action: string;
  decision: "allow" | "deny";
  reason: string;
  timestamp: string;
}

export type OwaspStatus = "pass" | "fail" | "na";

export interface SecurityAnalysisPoint {
  id: string;
  name: string;
  status: OwaspStatus;
  detail: string;
  file?: string;
  evidence?: string;
  remediation?: string;
}

export interface SecurityAnalysis {
  ranAt: string;
  runId: string;
  workspaceHash: string;
  passed: boolean;
  points: SecurityAnalysisPoint[];
  summary: string;
  modifiedWorkspace: boolean;
}

/** Commit-gate state for the current member's branch. */
export interface MemberSecurityView {
  analysis: SecurityAnalysis | null;
  currentWorkspaceHash: string;
  canCommit: boolean;
  reason: "ok" | "never-run" | "failed" | "incomplete" | "branch-changed";
}

export type CommitRequestStatus = "pending" | "approved" | "rejected" | "merged";

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

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  status: ProjectMemberStatus;
  role: string;
  childAgentId: string;
  workspacePath: string;
  securityAnalysis: SecurityAnalysis | null;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Owner sees this shape for each member; a member sees only the RosterEntry subset. */
export interface ProjectMemberView {
  id: string;
  userId: string;
  name: string;
  status: ProjectMemberStatus;
  role: string;
  childAgentId: string;
  securityAnalysis: SecurityAnalysis | null;
  invitedByName: string;
  pendingCommits: number;
  createdAt: string;
}

export interface RosterEntry {
  userId: string;
  name: string;
  status: ProjectMemberStatus;
  role: string;
}

export interface ParentAgentView {
  agent: { id: string; name: string; description: string; status: AgentStatus; kind: AgentKind };
  messages: Message[];
  trace: TraceEvent[];
  checkpoints: AgentCheckpoint[];
  /** Only present on the member's own child-agent view (`/my-agent`). */
  security?: MemberSecurityView;
}

export interface ProjectDetail {
  project: Project;
  role: "owner" | "member";
  owner: { id: string; name: string };
  myMembership: ProjectMember | null;
  members: ProjectMemberView[] | RosterEntry[];
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

export interface MergeOutcome { id: string; label: string; summary: string; details: string[]; requestedFeatures: string[]; }
export interface MergeWorkspaceConflict { path: string; targetContent: string | null; sourceContent: string | null; baseContent: string | null; targetPaths?: string[]; sourcePaths?: string[]; }
export interface ConversationCommit { id: string; runId: string; branchId: string | null; prompt: string; response: string | null; createdAt: string; }
export interface MergeContextConflict { id: string; target: ConversationCommit; source: ConversationCommit; targetSideId: string; sourceSideId: string; targetDeleted?: boolean; sourceDeleted?: boolean; }
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

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  branchId: string | null;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  branchId: string | null;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  beforeWorkspaceHash: string | null;
  afterWorkspaceHash: string | null;
  checkpointId: string | null;
}

export interface RunDetails {
  run: AgentRun;
  trace: TraceEvent[];
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

export interface TraceEvent {
  id: string;
  runId: string;
  agentId: string;
  branchId: string | null;
  type: string;
  timestamp: string;
  metadata: Record<string, unknown>;
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
  context: {
    agentName: string;
    agentDescription: string;
    instructions: string;
    messages: Message[];
    sourceThreadId: string | null;
  };
  trace: TraceEvent[];
  snapshot: { workspaceHash: string; manifest: { files: Array<{ path: string; size: number; sha256: string; mode: number }> } };
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

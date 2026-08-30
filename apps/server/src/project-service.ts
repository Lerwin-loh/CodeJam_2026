import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AuditDecision,
  ChangedFiles,
  CommitRequest,
  OwaspStatus,
  Project,
  ProjectMember,
  SecurityAnalysis,
  SecurityAnalysisPoint,
  User,
} from "./types.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { WorkspaceManager } from "./workspace.js";
import { MergeEngine, outcomeDetails, outcomeSummary } from "./merge-engine.js";
import type { MergeResolution } from "./types.js";

const now = () => new Date().toISOString();

/** Minimum capability each project action needs. Unlisted -> owner only. */
const PROJECT_ACTIONS: Record<string, "owner" | "member" | "member-own"> = {
  "project.read": "member",
  "project.delete": "owner",
  "project.archive": "owner",
  "project.unarchive": "owner",
  "project.tree.read": "member",
  "file.read": "member",
  "members.read": "member",
  "parent.read": "member",
  "parent.query": "owner",
  "child.read": "member-own",
  "child.query": "member-own",
  "member.manage": "owner",
  "security.check": "member-own",
  "commit.request.create": "member-own",
  "commit.request.read": "member",
  "commit.request.decide": "owner",
};

/**
 * Actions that stay allowed while a project is archived. Everything else is
 * frozen for everyone (owner included) until the project is unarchived.
 * `project.archive` / `project.unarchive` / `project.delete` are lifecycle
 * actions and are always allowed for the owner.
 */
const ARCHIVED_READ_ACTIONS = new Set([
  "project.read",
  "project.tree.read",
  "file.read",
  "members.read",
  "parent.read",
  "child.read",
  "commit.request.read",
]);
const PROJECT_LIFECYCLE_ACTIONS = new Set([
  "project.archive",
  "project.unarchive",
  "project.delete",
]);

/** OWASP Top 10 (2021) categories, in canonical order. */
const OWASP_TOP_10: ReadonlyArray<{ id: string; name: string }> = [
  { id: "A01:2021", name: "Broken Access Control" },
  { id: "A02:2021", name: "Cryptographic Failures" },
  { id: "A03:2021", name: "Injection" },
  { id: "A04:2021", name: "Insecure Design" },
  { id: "A05:2021", name: "Security Misconfiguration" },
  { id: "A06:2021", name: "Vulnerable and Outdated Components" },
  { id: "A07:2021", name: "Identification and Authentication Failures" },
  { id: "A08:2021", name: "Software and Data Integrity Failures" },
  { id: "A09:2021", name: "Security Logging and Monitoring Failures" },
  { id: "A10:2021", name: "Server-Side Request Forgery (SSRF)" },
];
const OWASP_IDS = new Set(OWASP_TOP_10.map((entry) => entry.id));
const OWASP_NAME_BY_ID = new Map(OWASP_TOP_10.map((entry) => [entry.id, entry.name]));

/** Hard-coded prompt pushed to the member's child agent for the pre-commit gate. */
export const OWASP_ANALYSIS_PROMPT = [
  "SECURITY ANALYSIS — read-only. Do NOT create, edit, run, or delete anything.",
  "",
  "Review the source code in your current workspace (your branch) against the",
  "OWASP Top 10 (2021). Inspect the actual files. For each of the ten categories",
  "decide one status:",
  '  "pass" — you found no issue of this class in the code you can see',
  '  "fail" — at least one concrete instance of this class exists (name the file)',
  '  "na"   — this class cannot apply to this codebase',
  "",
  OWASP_TOP_10.map((entry) => `  ${entry.id}  ${entry.name}`).join("\n"),
  "",
  "For every category you mark \"fail\", also include:",
  '  "file"        — the file path (relative to your workspace root)',
  '  "evidence"    — the offending lines, copied verbatim (<= 1500 chars)',
  '  "remediation" — concrete steps to fix it (<= 600 chars)',
  'Omit those three keys (or leave them "") for "pass" and "na".',
  "",
  "You may explain your reasoning first. Then, as the LAST thing in your reply,",
  "output EXACTLY ONE fenced code block tagged `json` and nothing after it:",
  "",
  "```json",
  "[",
  OWASP_TOP_10.map(
    (entry) =>
      `  {"id":"${entry.id}","name":"${entry.name}","status":"pass|fail|na","detail":"<=200 chars","file":"","evidence":"","remediation":""}`,
  ).join(",\n"),
  "]",
  "```",
].join("\n");

interface OwaspVerdict {
  ok: boolean;
  points: SecurityAnalysisPoint[];
  summary: string;
}

/** Pull the last ```json fenced block out of the agent reply and validate it. */
function parseOwaspVerdict(output: string): OwaspVerdict {
  const fences = [...output.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1]?.[1]?.trim() : undefined;
  if (!raw) {
    return { ok: false, points: [], summary: "The agent did not return a JSON verdict block." };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, points: [], summary: "The agent's JSON verdict block was not valid JSON." };
  }
  if (!Array.isArray(data)) {
    return { ok: false, points: [], summary: "The agent's verdict was not a JSON array." };
  }
  const byId = new Map<string, SecurityAnalysisPoint>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const status = String(record.status ?? "").trim().toLowerCase();
    if (!OWASP_IDS.has(id)) continue;
    if (status !== "pass" && status !== "fail" && status !== "na") continue;
    const point: SecurityAnalysisPoint = {
      id,
      name: OWASP_NAME_BY_ID.get(id) ?? String(record.name ?? id),
      status: status as OwaspStatus,
      detail: String(record.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    };
    if (status === "fail") {
      const file = String(record.file ?? "").trim().slice(0, 400);
      const evidence = String(record.evidence ?? "").slice(0, 4000);
      const remediation = String(record.remediation ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
      if (file) point.file = file;
      if (evidence.trim()) point.evidence = evidence;
      if (remediation) point.remediation = remediation;
    }
    byId.set(id, point);
  }
  if (byId.size !== OWASP_TOP_10.length) {
    return {
      ok: false,
      points: [...byId.values()],
      summary:
        "The verdict covered " + byId.size + " of 10 OWASP categories — re-run the analysis.",
    };
  }
  const points = OWASP_TOP_10.map((entry) => byId.get(entry.id)!);
  const failed = points.filter((point) => point.status === "fail");
  return {
    ok: true,
    points,
    summary: failed.length
      ? failed.length + " OWASP categor" + (failed.length === 1 ? "y" : "ies") +
        " failed: " + failed.map((point) => point.id).join(", ")
      : "All 10 OWASP categories passed.",
  };
}

function childInstructions(projectName: string, role: string): string {
  return [
    `You are the ${role} engineer on the project "${projectName}".`,
    "You work in your own copy of the project. You may read every file in the project.",
    "Only the project owner can push changes to the shared main workspace.",
  ].join(" ");
}

export interface ProjectMemberView {
  id: string;
  userId: string;
  name: string;
  role: string;
  childAgentId: string;
  securityAnalysis: SecurityAnalysis | null;
  createdAt: string;
}

export interface RosterEntry {
  userId: string;
  name: string;
  role: string;
}

export interface MemberSecurityView {
  analysis: SecurityAnalysis | null;
  currentWorkspaceHash: string;
  /** True only when a passing analysis exists for the branch's current state. */
  canCommit: boolean;
  reason: "ok" | "never-run" | "failed" | "incomplete" | "branch-changed";
}

/** Why the commit button is disabled, phrased for the member. */
const COMMIT_GATE_MESSAGE: Record<Exclude<MemberSecurityView["reason"], "ok">, string> = {
  "never-run": "Run the security analysis before submitting a commit request.",
  failed:
    "The last security analysis failed one or more OWASP checks. Fix the issues and run it again.",
  incomplete:
    "The last security analysis did not cover all 10 OWASP categories. Run it again.",
  "branch-changed":
    "Your branch changed since the last security analysis. Run it again before submitting.",
};

export class ProjectService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly history: WorkspaceHistory,
    private readonly mergeEngine = new MergeEngine(history),
  ) {}

  // --------------------------------------------------------------------------
  // lookups & permissions
  // --------------------------------------------------------------------------

  private getProjectOrThrow(projectId: string): Project {
    const project = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!project) throw new HttpError(404, "Project not found");
    return project;
  }

  getMemberById(projectId: string, memberId: string): ProjectMember {
    const member = this.store
      .snapshot()
      .projectMembers.find((item) => item.id === memberId && item.projectId === projectId);
    if (!member) throw new HttpError(404, "Member not found");
    return member;
  }

  /** Resolve the caller's standing on a project and enforce an action's floor. */
  async assertProjectAccess(
    projectId: string,
    user: User,
    action: string,
    opts: { memberId?: string } = {},
  ): Promise<{ project: Project; role: "owner" | "member"; member: ProjectMember | null }> {
    const database = this.store.snapshot();
    const project = database.projects.find((item) => item.id === projectId);
    if (!project) throw new HttpError(404, "Project not found");
    const isOwner = project.ownerId === user.id;
    const member =
      database.projectMembers.find(
        (item) => item.projectId === projectId && item.userId === user.id,
      ) ?? null;
    if (!isOwner && !member) {
      await this.recordAudit(user, projectId, null, action, "deny", "Not a member of this project");
      throw new HttpError(403, "You are not on this project");
    }
    const required = PROJECT_ACTIONS[action] ?? "owner";
    if (required === "owner" && !isOwner) {
      await this.recordAudit(user, projectId, null, action, "deny", "Requires the project owner");
      throw new HttpError(403, "Only the project owner can do this");
    }
    if (required === "member-own" && !isOwner) {
      if (!member || (opts.memberId !== undefined && opts.memberId !== member.id)) {
        await this.recordAudit(user, projectId, null, action, "deny", "Members may only act on their own agent");
        throw new HttpError(403, "You can only act on your own agent");
      }
    }
    if (
      project.archivedAt &&
      !ARCHIVED_READ_ACTIONS.has(action) &&
      !PROJECT_LIFECYCLE_ACTIONS.has(action)
    ) {
      await this.recordAudit(user, projectId, null, action, "deny", "Project is archived");
      throw new HttpError(409, "This project is archived. Unarchive it to make changes.");
    }
    return { project, role: isOwner ? "owner" : "member", member };
  }

  /** Archive (freeze) or unarchive a project. Owner only. */
  async setProjectArchived(projectId: string, actor: User, archived: boolean): Promise<Project> {
    const project = this.getProjectOrThrow(projectId);
    if (project.ownerId !== actor.id) {
      await this.recordAudit(
        actor,
        projectId,
        null,
        archived ? "project.archive" : "project.unarchive",
        "deny",
        "Requires the project owner",
      );
      throw new HttpError(403, "Only the project owner can archive this project");
    }
    const timestamp = now();
    return this.store.mutate((database) => {
      const row = database.projects.find((item) => item.id === projectId);
      if (!row) throw new HttpError(404, "Project not found");
      row.archivedAt = archived ? row.archivedAt ?? timestamp : null;
      row.updatedAt = timestamp;
      database.audit.push({
        id: randomUUID(),
        userId: actor.id,
        userName: actor.name,
        agentId: null,
        action: archived ? "project.archive" : "project.unarchive",
        resource: "project:" + projectId,
        decision: "allow",
        reason: (archived ? "Owner archived project " : "Owner unarchived project ") + row.name,
        timestamp,
      });
      return structuredClone(row);
    });
  }

  // --------------------------------------------------------------------------
  // projects
  // --------------------------------------------------------------------------

  async createProject(name: string, ownerId: string): Promise<Project> {
    const trimmed = name.trim();
    if (!trimmed) throw new HttpError(400, "Enter a project name.");
    if (trimmed.length > 120) throw new HttpError(400, "Project name is too long.");

    const projectId = randomUUID();
    const parentAgentId = randomUUID();
    const mainPath = this.workspaces.projectMainPath(projectId);
    const timestamp = now();

    const parentAgent: Agent = {
      id: parentAgentId,
      name: trimmed + " - Parent Agent",
      description: "Coordinates the project and owns the canonical main workspace.",
      instructions:
        "You are the parent agent for the project \"" +
        trimmed +
        "\". You own the canonical main workspace. Only the project owner may instruct you.",
      ownerId,
      projectId,
      kind: "parent",
      memberId: null,
      status: "ready",
      workspacePath: mainPath,
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // seed main/ so the tree is concrete, then snapshot it as the project head
    await mkdir(mainPath, { recursive: true });
    await this.workspaces.writeInstructions(parentAgent);
    await writeFile(
      path.join(mainPath, "README.md"),
      "# " + trimmed + "\n\nCanonical `main` workspace for this project.\n",
      "utf8",
    );
    const manifest = await this.history.manifest(mainPath);
    const headSnapshot = await this.history.createSnapshot(
      parentAgentId,
      projectId,
      mainPath,
      manifest,
    );

    const project: Project = {
      id: projectId,
      name: trimmed,
      ownerId,
      mainWorkspacePath: mainPath,
      parentAgentId,
      headSnapshotId: headSnapshot.id,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.mutate((database) => {
      database.snapshots.push(headSnapshot);
      database.agents.push(parentAgent);
      database.projects.push(project);
    });
    return project;
  }

  listProjects(userId: string): Project[] {
    const database = this.store.snapshot();
    const memberProjectIds = new Set(
      database.projectMembers
        .filter((item) => item.userId === userId)
        .map((item) => item.projectId),
    );
    return database.projects
      .filter((item) => item.ownerId === userId || memberProjectIds.has(item.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  projectAgentIds(projectId: string): string[] {
    this.getProjectOrThrow(projectId);
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.projectId === projectId)
      .map((agent) => agent.id);
  }

  async deleteProject(
    projectId: string,
    actor: User,
  ): Promise<{
    archivedWorkspace: string | null;
    archivedSnapshots: number;
  }> {
    const database = this.store.snapshot();
    const project = database.projects.find((item) => item.id === projectId);
    if (!project) throw new HttpError(404, "Project not found");
    if (project.ownerId !== actor.id) {
      throw new HttpError(403, "Only the project owner can delete this project");
    }

    const agentIds = new Set(
      database.agents
        .filter((agent) => agent.projectId === projectId)
        .map((agent) => agent.id),
    );
    const snapshots = database.snapshots.filter((snapshot) =>
      agentIds.has(snapshot.agentId),
    );

    // Archive recoverable filesystem state before removing its metadata. A
    // manually deleted project directory is treated as an already-empty archive.
    const archivedWorkspace = await this.workspaces.archiveProject(projectId);
    const archivedSnapshots = await this.history.archiveSnapshots(projectId, snapshots);

    await this.store.mutate((next) => {
      next.projects = next.projects.filter((item) => item.id !== projectId);
      next.projectMembers = next.projectMembers.filter((item) => item.projectId !== projectId);
      next.commitRequests = next.commitRequests.filter((item) => item.projectId !== projectId);
      next.agents = next.agents.filter((item) => !agentIds.has(item.id));
      next.branches = next.branches.filter((item) => !agentIds.has(item.agentId));
      next.messages = next.messages.filter((item) => !agentIds.has(item.agentId));
      next.runs = next.runs.filter((item) => !agentIds.has(item.agentId));
      next.traces = next.traces.filter((item) => !agentIds.has(item.agentId));
      next.snapshots = next.snapshots.filter((item) => !agentIds.has(item.agentId));
      next.contexts = next.contexts.filter((item) => !agentIds.has(item.agentId));
      next.checkpoints = next.checkpoints.filter((item) => !agentIds.has(item.agentId));
      next.audit = next.audit.filter(
        (item) => item.resource !== "project:" + projectId &&
          (item.agentId === null || !agentIds.has(item.agentId)),
      );
      next.audit.push({
        id: randomUUID(),
        userId: actor.id,
        userName: actor.name,
        agentId: null,
        action: "project.delete",
        resource: "project:" + projectId,
        decision: "allow",
        reason: "Owner deleted project " + project.name,
        timestamp: now(),
      });
    });

    return { archivedWorkspace, archivedSnapshots };
  }

  getProject(projectId: string, user: User): {
    project: Project;
    role: "owner" | "member";
    myMembership: ProjectMember | null;
    members: ProjectMemberView[] | RosterEntry[];
  } {
    const database = this.store.snapshot();
    const project = database.projects.find((item) => item.id === projectId);
    if (!project) throw new HttpError(404, "Project not found");
    const isOwner = project.ownerId === user.id;
    const myMembership =
      database.projectMembers.find(
        (item) => item.projectId === projectId && item.userId === user.id,
      ) ?? null;
    if (!isOwner && !myMembership) {
      throw new HttpError(403, "You are not on this project");
    }
    return {
      project,
      role: isOwner ? "owner" : "member",
      myMembership,
      members: this.listMembers(projectId, isOwner),
    };
  }

  // --------------------------------------------------------------------------
  // read-all file access (from main)
  // --------------------------------------------------------------------------

  async getMainTree(projectId: string): Promise<string[]> {
    const project = this.getProjectOrThrow(projectId);
    const manifest = await this.history.manifest(project.mainWorkspacePath);
    return manifest.files.map((file) => file.path).sort();
  }

  async readMainFile(projectId: string, filePath: string): Promise<string> {
    const project = this.getProjectOrThrow(projectId);
    const relative = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (relative.includes("..") || relative === "") {
      throw new HttpError(400, "Invalid file path");
    }
    const target = path.resolve(project.mainWorkspacePath, relative);
    if (!target.startsWith(path.resolve(project.mainWorkspacePath) + path.sep)) {
      throw new HttpError(400, "Invalid file path");
    }
    try {
      const content = await readFile(target, "utf8");
      return content.slice(0, 200_000);
    } catch {
      throw new HttpError(404, "File not found");
    }
  }

  // --------------------------------------------------------------------------
  // members
  // --------------------------------------------------------------------------

  listMembers(projectId: string, forOwner: boolean): ProjectMemberView[] | RosterEntry[] {
    const database = this.store.snapshot();
    const rows = database.projectMembers
      .filter((item) => item.projectId === projectId)
      .sort((left, right) => left.role.localeCompare(right.role));
    const nameOf = (userId: string) =>
      database.users.find((user) => user.id === userId)?.name ?? "Unknown user";
    if (!forOwner) {
      return rows.map((item) => ({ userId: item.userId, name: nameOf(item.userId), role: item.role }));
    }
    return rows.map((item) => ({
      id: item.id,
      userId: item.userId,
      name: nameOf(item.userId),
      role: item.role,
      childAgentId: item.childAgentId,
      securityAnalysis: item.securityAnalysis,
      createdAt: item.createdAt,
    }));
  }

  async addMember(
    projectId: string,
    actor: User,
    input: { userName: string; role: string },
  ): Promise<ProjectMember> {
    const database = this.store.snapshot();
    const project = database.projects.find((item) => item.id === projectId);
    if (!project) throw new HttpError(404, "Project not found");

    const name = input.userName.trim();
    const role = input.role.trim();
    if (!role) throw new HttpError(400, "Give the member a role label.");
    if (role.length > 60) throw new HttpError(400, "Role label is too long.");

    const target = database.users.find(
      (user) => user.name.toLowerCase() === name.toLowerCase(),
    );
    if (!target) {
      throw new HttpError(
        404,
        "No user named \"" + name + "\" has signed in yet. They must sign in once before you can add them.",
      );
    }
    if (target.id === project.ownerId) {
      throw new HttpError(409, "The owner is already on this project.");
    }
    if (
      database.projectMembers.some(
        (item) => item.projectId === projectId && item.userId === target.id,
      )
    ) {
      throw new HttpError(409, target.name + " is already a member.");
    }

    const memberId = randomUUID();
    const childAgentId = randomUUID();
    const workspacePath = this.workspaces.projectMemberPath(projectId, memberId);
    const timestamp = now();

    // Snapshot main as it stands now and materialise the member's own copy.
    const mainManifest = await this.history.manifest(project.mainWorkspacePath);
    const baseSnapshot = await this.history.createSnapshot(
      childAgentId,
      projectId,
      project.mainWorkspacePath,
      mainManifest,
    );
    await this.history.restoreSnapshot(baseSnapshot, workspacePath);

    const childAgent: Agent = {
      id: childAgentId,
      name: project.name + " - " + role + " (" + target.name + ")",
      description: role + " workspace for " + target.name + ".",
      instructions: childInstructions(project.name, role),
      ownerId: target.id,
      projectId,
      kind: "child",
      memberId,
      status: "ready",
      workspacePath,
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.writeInstructions(childAgent);

    const member: ProjectMember = {
      id: memberId,
      projectId,
      userId: target.id,
      role,
      childAgentId,
      workspacePath,
      securityAnalysis: null,
      invitedBy: actor.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.mutate((next) => {
      if (
        next.projectMembers.some(
          (item) => item.projectId === projectId && item.userId === target.id,
        )
      ) {
        throw new HttpError(409, target.name + " is already a member.");
      }
      next.snapshots.push(baseSnapshot);
      next.agents.push(childAgent);
      next.projectMembers.push(member);
    });
    await this.recordAudit(
      actor,
      projectId,
      childAgentId,
      "project.member.add",
      "allow",
      "Added " + target.name + " as " + role,
    );
    return member;
  }

  async updateMember(
    projectId: string,
    memberId: string,
    input: { role: string },
  ): Promise<ProjectMember> {
    const updated = await this.store.mutate((database) => {
      const project = database.projects.find((item) => item.id === projectId);
      if (!project) throw new HttpError(404, "Project not found");
      const member = database.projectMembers.find(
        (item) => item.id === memberId && item.projectId === projectId,
      );
      if (!member) throw new HttpError(404, "Member not found");
      const role = input.role.trim();
      if (!role) throw new HttpError(400, "Give the member a role label.");
      member.role = role;
      member.updatedAt = now();
      const agent = database.agents.find((item) => item.id === member.childAgentId);
      if (agent) {
        agent.instructions = childInstructions(project.name, role);
        agent.updatedAt = now();
      }
      return structuredClone(member);
    });
    return updated;
  }

  async removeMember(projectId: string, memberId: string): Promise<void> {
    const database = this.store.snapshot();
    const member = database.projectMembers.find(
      (item) => item.id === memberId && item.projectId === projectId,
    );
    if (!member) throw new HttpError(404, "Member not found");
    const agent = database.agents.find((item) => item.id === member.childAgentId);
    if (agent) {
      await this.workspaces.archive(agent);
    }
    await this.store.mutate((next) => {
      next.projectMembers = next.projectMembers.filter((item) => item.id !== memberId);
      next.agents = next.agents.filter((item) => item.id !== member.childAgentId);
      next.commitRequests = next.commitRequests.filter((item) => item.memberId !== memberId);
    });
  }

  // --------------------------------------------------------------------------
  // pre-commit security gate (Part 1B) & commit requests (Part 2 scaffold)
  // --------------------------------------------------------------------------

  /**
   * Store the verdict from a completed child-agent OWASP analysis run and return
   * the resulting commit-gate state. `run` is the terminal run produced by
   * `AgentService.runToCompletion(childAgentId, OWASP_ANALYSIS_PROMPT)`.
   */
  async recordSecurityAnalysis(
    projectId: string,
    memberId: string,
    run: AgentRun,
  ): Promise<MemberSecurityView> {
    const database = this.store.snapshot();
    const member = database.projectMembers.find(
      (item) => item.id === memberId && item.projectId === projectId,
    );
    if (!member) throw new HttpError(404, "Member not found");

    const before = run.beforeWorkspaceHash;
    const after = run.afterWorkspaceHash ?? before;
    const workspaceHash =
      after ?? (await this.history.manifest(member.workspacePath)).workspaceHash;

    const verdict: OwaspVerdict =
      run.status === "completed"
        ? parseOwaspVerdict(run.output ?? "")
        : {
            ok: false,
            points: [],
            summary:
              "The analysis run " +
              run.status +
              (run.error ? ": " + run.error : "") +
              " — try again.",
          };
    const passed = verdict.ok && verdict.points.every((point) => point.status !== "fail");

    const analysis: SecurityAnalysis = {
      ranAt: now(),
      runId: run.id,
      workspaceHash,
      passed,
      points: verdict.points,
      summary: verdict.summary,
      modifiedWorkspace: before != null && after != null && before !== after,
    };

    await this.store.mutate((db) => {
      const row = db.projectMembers.find((item) => item.id === memberId);
      if (row) {
        row.securityAnalysis = analysis;
        row.updatedAt = now();
      }
      // The analysis is a system-issued prompt, not the member's conversation.
      // Keep its turn out of the child agent's chat transcript — the verdict is
      // shown in the security panel. The run + trace stay for provenance.
      db.messages = db.messages.filter((message) => message.runId !== run.id);
    });

    const memberName =
      database.users.find((user) => user.id === member.userId)?.name ?? "Member";
    await this.recordAudit(
      { id: member.userId, name: memberName } as User,
      projectId,
      member.childAgentId,
      "security.check",
      passed ? "allow" : "deny",
      passed ? "OWASP analysis passed — commit unlocked" : "OWASP analysis: " + verdict.summary,
    );

    return this.getMemberSecurity(projectId, memberId);
  }

  /** Current commit-gate state for a member: is a fresh passing analysis on file? */
  async getMemberSecurity(projectId: string, memberId: string): Promise<MemberSecurityView> {
    const member = this.store
      .snapshot()
      .projectMembers.find((item) => item.id === memberId && item.projectId === projectId);
    if (!member) throw new HttpError(404, "Member not found");

    const currentWorkspaceHash = (await this.history.manifest(member.workspacePath)).workspaceHash;
    const analysis = member.securityAnalysis;

    let reason: MemberSecurityView["reason"];
    if (!analysis) reason = "never-run";
    else if (!analysis.passed) {
      reason = analysis.points.length === 10 ? "failed" : "incomplete";
    } else if (analysis.workspaceHash !== currentWorkspaceHash) reason = "branch-changed";
    else reason = "ok";

    return { analysis, currentWorkspaceHash, canCommit: reason === "ok", reason };
  }

  private async diffMemberAgainstMain(
    project: Project,
    member: ProjectMember,
  ): Promise<ChangedFiles> {
    const mainManifest = await this.history.manifest(project.mainWorkspacePath);
    const memberManifest = await this.history.manifest(member.workspacePath);
    const diff = this.history.diff(mainManifest, memberManifest);
    // AGENTS.md is platform-managed per Agent, not member work.
    const drop = (list: string[]) => list.filter((item) => item !== "AGENTS.md");
    return {
      created: drop(diff.created),
      modified: drop(diff.modified),
      deleted: drop(diff.deleted),
    };
  }

  async submitCommitRequest(
    projectId: string,
    memberId: string,
    input: { title?: string | undefined; note?: string | undefined },
  ): Promise<CommitRequest> {
    const database = this.store.snapshot();
    const project = database.projects.find((item) => item.id === projectId);
    const member = database.projectMembers.find(
      (item) => item.id === memberId && item.projectId === projectId,
    );
    if (!project || !member) throw new HttpError(404, "Member not found");

    const changedFiles = await this.diffMemberAgainstMain(project, member);
    const totalChanged =
      changedFiles.created.length + changedFiles.modified.length + changedFiles.deleted.length;
    if (totalChanged === 0) {
      throw new HttpError(409, "Nothing to commit - your branch matches main.");
    }

    // Part 1B: a passing OWASP analysis for the branch's current state is required.
    const security = await this.getMemberSecurity(projectId, memberId);
    if (security.reason !== "ok") {
      throw new HttpError(409, COMMIT_GATE_MESSAGE[security.reason]);
    }

    const memberName =
      database.users.find((user) => user.id === member.userId)?.name ?? "Member";
    const request: CommitRequest = {
      id: randomUUID(),
      projectId,
      memberId,
      memberName,
      role: member.role,
      childAgentId: member.childAgentId,
      title: (input.title ?? "").trim().slice(0, 120) || member.role + " changes",
      note: (input.note ?? "").trim().slice(0, 2_000),
      status: "pending",
      changedFiles,
      securityAnalysis: security.analysis,
      decidedBy: null,
      decidedAt: null,
      createdAt: now(),
    };
    await this.store.mutate((db) => db.commitRequests.push(request));
    await this.recordAudit(
      { id: member.userId, name: memberName } as User,
      projectId,
      member.childAgentId,
      "commit.request.create",
      "allow",
      "Submitted a commit request (" + totalChanged + " file" + (totalChanged === 1 ? "" : "s") + ")",
    );
    return request;
  }

  listCommitRequests(projectId: string, member: ProjectMember | null): CommitRequest[] {
    return this.store
      .snapshot()
      .commitRequests.filter(
        (item) =>
          item.projectId === projectId &&
          (member === null || item.memberId === member.id),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getCommitRequest(id: string): CommitRequest {
    const request = this.store
      .snapshot()
      .commitRequests.find((item) => item.id === id);
    if (!request) throw new HttpError(404, "Commit request not found");
    return request;
  }

  private async projectMergeSide(agent: Agent, workspacePath: string, id: string, label: string, baseSnapshotId: string | null, branchId: string | null = null) {
    const database = this.store.snapshot();
    const runs = database.runs.filter((run) => run.agentId === agent.id && run.branchId === branchId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const prompts = database.messages.filter((message) => message.agentId === agent.id && message.role === "user" && (branchId === null ? message.branchId === null : message.branchId === branchId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((message) => message.content);
    const baseSnapshot = baseSnapshotId ? database.snapshots.find((snapshot) => snapshot.id === baseSnapshotId) ?? null : null;
    const changed = baseSnapshot ? this.history.diff(baseSnapshot.manifest, await this.history.manifest(workspacePath)) : { created: [], modified: [], deleted: [] };
    const fileSummary = [changed.created.length ? "created " + changed.created.join(", ") : "", changed.modified.length ? "updated " + changed.modified.join(", ") : "", changed.deleted.length ? "deleted " + changed.deleted.join(", ") : ""].filter(Boolean).join("; ");
    return { id, label, workspacePath, outcome: { id, label, summary: outcomeSummary(runs[0]?.output ?? "", fileSummary), details: outcomeDetails(runs[0]?.output ?? "", fileSummary), requestedFeatures: prompts }, prompts, baseSnapshot };
  }

  async previewChildMerge(projectId: string, memberId: string, branchId: string | null = null) {
    const database = this.store.snapshot();
    const project = this.getProjectOrThrow(projectId);
    const parent = database.agents.find((agent) => agent.id === project.parentAgentId);
    const member = database.projectMembers.find((item) => item.id === memberId && item.projectId === projectId);
    const child = member && database.agents.find((agent) => agent.id === member.childAgentId);
    if (!parent || !member || !child) throw new HttpError(404, "Project member not found");
    const branch = branchId ? database.branches.find((item) => item.id === branchId && item.agentId === child.id) : null;
    if (branchId && !branch) throw new HttpError(404, "Branch not found");
    const childBase = branch ? database.checkpoints.find((item) => item.id === branch.parentCheckpointId)?.snapshotId ?? null : database.snapshots.filter((snapshot) => snapshot.agentId === child.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id ?? null;
    return this.mergeEngine.preview(await this.projectMergeSide(parent, project.mainWorkspacePath, parent.id, "main", childBase), await this.projectMergeSide(child, branch?.workspacePath ?? child.workspacePath, branch?.id ?? child.id, branch?.name ?? child.name, childBase, branch?.id ?? null));
  }

  async mergeChild(projectId: string, memberId: string, branchId: string | null, resolution: MergeResolution) {
    const database = this.store.snapshot();
    const project = this.getProjectOrThrow(projectId);
    const parent = database.agents.find((agent) => agent.id === project.parentAgentId);
    const member = database.projectMembers.find((item) => item.id === memberId && item.projectId === projectId);
    const child = member && database.agents.find((agent) => agent.id === member.childAgentId);
    const branch = branchId ? database.branches.find((item) => item.id === branchId && item.agentId === child?.id) : null;
    if (!parent || !member || !child || (branchId && !branch)) throw new HttpError(404, "Project merge source not found");
    const childBase = branch ? database.checkpoints.find((item) => item.id === branch.parentCheckpointId)?.snapshotId ?? null : database.snapshots.filter((snapshot) => snapshot.agentId === child.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id ?? null;
    const target = await this.projectMergeSide(parent, project.mainWorkspacePath, parent.id, "main", childBase);
    const source = await this.projectMergeSide(child, branch?.workspacePath ?? child.workspacePath, branch?.id ?? child.id, branch?.name ?? child.name, childBase, branch?.id ?? null);
    return this.mergeEngine.apply(target, source, resolution, async (manifest, keptPrompts) => {
      const snapshot = await this.history.createSnapshot(parent.id, project.id, project.mainWorkspacePath, manifest);
      await this.store.mutate((db) => {
        db.snapshots.push(snapshot);
        const row = db.projects.find((item) => item.id === projectId);
        if (row) { row.headSnapshotId = snapshot.id; row.updatedAt = now(); row.mergedContext = keptPrompts; }
        const request = db.commitRequests.find((item) => item.projectId === projectId && item.memberId === memberId && item.status === "approved");
        if (request) { request.status = "merged"; request.decidedAt = now(); }
      });
      return snapshot;
    });
  }

  /**
   * Owner decision on a pending commit request. Approve/reject only records the
   * outcome: actually applying the change to main (with conflict handling) is
   * the next iteration.
   */
  async decideCommitRequest(
    requestId: string,
    decision: "approved" | "rejected",
    decidedBy: User,
  ): Promise<CommitRequest> {
    return this.store.mutate((database) => {
      const request = database.commitRequests.find((item) => item.id === requestId);
      if (!request) throw new HttpError(404, "Commit request not found");
      if (request.status !== "pending") {
        throw new HttpError(409, "This commit request has already been decided.");
      }
      request.status = decision;
      request.decidedBy = decidedBy.id;
      request.decidedAt = now();
      return structuredClone(request);
    });
  }

  // --------------------------------------------------------------------------

  private async recordAudit(
    user: User,
    projectId: string,
    agentId: string | null,
    action: string,
    decision: AuditDecision,
    reason: string,
  ): Promise<void> {
    await this.store.mutate((database) => {
      database.audit.push({
        id: randomUUID(),
        userId: user.id,
        userName: user.name,
        agentId,
        action,
        resource: "project:" + projectId,
        decision,
        reason,
        timestamp: now(),
      });
      if (database.audit.length > 2_000) {
        database.audit.splice(0, database.audit.length - 2_000);
      }
    });
  }
}

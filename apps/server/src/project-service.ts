import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AuditDecision,
  ChangedFiles,
  CommitRequest,
  Project,
  ProjectMember,
  SecurityCheckResult,
  SecurityFinding,
  User,
} from "./types.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { WorkspaceManager } from "./workspace.js";

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

/** Cheap static checks run against a member's workspace before a commit request. */
const SCAN_RULES: Array<{ rule: string; re: RegExp }> = [
  {
    rule: "hardcoded-secret",
    re: /(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][^'"]{6,}['"]/i,
  },
  { rule: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { rule: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "use-of-eval", re: /\beval\s*\(/ },
  { rule: "shell-injection-risk", re: /\bexec(?:Sync)?\s*\(\s*[`'"][^`'"]*\$\{/ },
];

const SCAN_SKIP = new Set([".git", "node_modules", "dist", ".codex", "branches"]);

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
  lastSecurityCheck: SecurityCheckResult | null;
  createdAt: string;
}

export interface RosterEntry {
  userId: string;
  name: string;
  role: string;
}

export class ProjectService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly history: WorkspaceHistory,
  ) {}

  // --------------------------------------------------------------------------
  // lookups & permissions
  // --------------------------------------------------------------------------

  private getProjectOrThrow(projectId: string): Project {
    const project = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!project) throw new HttpError(404, "Project not found");
    return project;
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
      lastSecurityCheck: item.lastSecurityCheck,
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
      lastSecurityCheck: null,
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
  // security checks & commit requests (Part 2 scaffold)
  // --------------------------------------------------------------------------

  /** Run the static scan against a member's workspace and store the result. */
  async runSecurityCheck(projectId: string, memberId: string): Promise<SecurityCheckResult> {
    const database = this.store.snapshot();
    const member = database.projectMembers.find(
      (item) => item.id === memberId && item.projectId === projectId,
    );
    if (!member) throw new HttpError(404, "Member not found");

    const manifest = await this.history.manifest(member.workspacePath);
    const findings: SecurityFinding[] = [];
    let filesScanned = 0;
    for (const file of manifest.files) {
      if (file.path.split("/").some((part) => SCAN_SKIP.has(part))) continue;
      if (file.size > 200_000) continue;
      let text: string;
      try {
        text = await readFile(path.join(member.workspacePath, file.path), "utf8");
      } catch {
        continue;
      }
      const NUL = String.fromCharCode(0);
      if (text.indexOf(NUL) !== -1) continue; // skip binary files
      filesScanned += 1;
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        for (const { rule, re } of SCAN_RULES) {
          if (re.test(line)) {
            findings.push({
              file: file.path,
              line: index + 1,
              rule,
              excerpt: line.trim().slice(0, 200),
            });
          }
        }
      }
    }

    const result: SecurityCheckResult = { ranAt: now(), filesScanned, findings };
    await this.store.mutate((db) => {
      const row = db.projectMembers.find((item) => item.id === memberId);
      if (row) {
        row.lastSecurityCheck = result;
        row.updatedAt = now();
      }
    });
    return result;
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
      throw new HttpError(409, "Nothing to commit - your workspace matches main.");
    }
    if (
      database.commitRequests.some(
        (item) => item.memberId === memberId && item.status === "pending",
      )
    ) {
      throw new HttpError(409, "You already have a commit request awaiting review.");
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
      securityCheck: member.lastSecurityCheck,
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

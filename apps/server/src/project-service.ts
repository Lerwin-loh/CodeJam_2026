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
  OwaspStatus,
  Project,
  ProjectMember,
  SecurityAnalysis,
  SecurityAnalysisPoint,
  User,
} from "./types.js";

/** One-shot text completion used for the OWASP classification (see ark-client). */
export type SecurityClassifier = (prompt: string) => Promise<string>;
import { WorkspaceHistory } from "./workspace-history.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

function projectName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "Enter a project name.");
  if (trimmed.length > 120) throw new HttpError(400, "Project name is too long.");
  return trimmed;
}

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

/** Per-file / total caps on the source bytes fed to the classifier. */
const CLASSIFY_FILE_CAP = 12_000;
const CLASSIFY_TOTAL_CAP = 48_000;

/**
 * The single prompt sent to the model for the OWASP gate. The changed files (vs
 * main) are inlined so the model needs no tools and no file-reading round-trips.
 */
export function owaspAnalysisPrompt(files: Array<{ path: string; content: string }>): string {
  let budget = CLASSIFY_TOTAL_CAP;
  const blocks: string[] = [];
  for (const file of files) {
    if (budget <= 0) {
      blocks.push(`--- ${file.path} ---\n… (omitted, size budget reached)`);
      continue;
    }
    let body = file.content;
    if (body.length > CLASSIFY_FILE_CAP) body = body.slice(0, CLASSIFY_FILE_CAP) + "\n… (truncated)";
    if (body.length > budget) body = body.slice(0, budget) + "\n… (truncated)";
    budget -= body.length;
    blocks.push(`--- ${file.path} ---\n${body}`);
  }
  return [
    "You are a security reviewer. Assess ONLY the code below (it is the diff vs the",
    "project's main branch) against the OWASP Top 10 (2021).",
    'Per category choose one status: "pass" (no issue in this code), "fail" (a',
    'concrete instance is present), or "na" (this class cannot apply here).',
    'On a "fail" also give: file, evidence (offending lines verbatim, <=600 chars),',
    'remediation (<=250 chars). Leave those keys "" otherwise.',
    "",
    "Reply with ONLY a JSON array of these 10 objects, in this order, no prose:",
    "[",
    OWASP_TOP_10.map(
      (entry) =>
        `  {"id":"${entry.id}","name":"${entry.name}","status":"pass|fail|na","detail":"<=120 chars","file":"","evidence":"","remediation":""}`,
    ).join(",\n"),
    "]",
    "",
    "=== FILES ===",
    blocks.join("\n\n"),
  ].join("\n");
}

/**
 * One direct model call that rewrites a single file to fix its flagged issues —
 * no agent, no tools, no conversation. Returns the whole corrected file.
 */
function fileFixPrompt(
  relPath: string,
  content: string,
  issues: SecurityAnalysisPoint[],
): string {
  return [
    "Rewrite the file below to fix these OWASP issues. Change ONLY what is needed;",
    "keep the rest of the file intact. Output the COMPLETE corrected file and NOTHING",
    "else — no explanation, no markdown fences.",
    "",
    ...issues.map(
      (issue) =>
        `- ${issue.id} ${issue.name}: ${issue.detail}` +
        (issue.remediation ? ` — fix: ${issue.remediation}` : ""),
    ),
    "",
    `=== ${relPath} ===`,
    content.length > CLASSIFY_FILE_CAP * 2
      ? content.slice(0, CLASSIFY_FILE_CAP * 2)
      : content,
  ].join("\n");
}

/** Strip an outer ```lang … ``` fence if the model wrapped its answer in one. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenced) return fenced[1] ?? trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9]*\r?\n?/, "")
    .replace(/\r?\n?```$/, "");
}

/**
 * Zero-token lexical pre-filter. If any of these fire on the changed files the
 * commit is blocked immediately with no agent run — the child agent is only
 * invoked when this pass is clean (to catch the subtle, non-lexical issues).
 */
const STATIC_RULES: ReadonlyArray<{ rule: string; owasp: string; re: RegExp; fix: string }> = [
  {
    rule: "hardcoded-secret",
    owasp: "A02:2021",
    re: /(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"][^'"]{6,}['"]/i,
    fix: "Move the secret to server-side/env config; never ship it in client code.",
  },
  {
    rule: "private-key-block",
    owasp: "A02:2021",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    fix: "Remove the key from the repo; load keys from a secret store at runtime.",
  },
  {
    rule: "aws-access-key-id",
    owasp: "A02:2021",
    re: /\bAKIA[0-9A-Z]{16}\b/,
    fix: "Rotate the exposed AWS key now; load credentials from env / IAM role.",
  },
  {
    rule: "weak-hash",
    owasp: "A02:2021",
    re: /\b(?:createHash\s*\(\s*['"](?:md5|sha1)['"]|\bMD5\s*\(|\bSHA1\s*\()/i,
    fix: "Use SHA-256+ for integrity; bcrypt/scrypt/argon2 for passwords.",
  },
  {
    rule: "use-of-eval",
    owasp: "A03:2021",
    re: /\beval\s*\(/,
    fix: "Remove eval(); parse with JSON.parse or dispatch via an allow-list.",
  },
  {
    rule: "document-write",
    owasp: "A03:2021",
    re: /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
    fix: "Replace document.write with safe DOM APIs (textContent / createElement).",
  },
  {
    rule: "innerhtml-assignment",
    owasp: "A03:2021",
    re: /\.innerHTML\s*=[^=]/,
    fix: "Use textContent, or sanitize with DOMPurify before assigning HTML.",
  },
  {
    rule: "dangerously-set-innerhtml",
    owasp: "A03:2021",
    re: /dangerouslySetInnerHTML/,
    fix: "Avoid dangerouslySetInnerHTML; render text or sanitize the HTML first.",
  },
  {
    rule: "shell-injection-risk",
    owasp: "A03:2021",
    re: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{/,
    fix: "Pass args as an array to execFile/spawn; never interpolate input into a shell string.",
  },
  {
    rule: "insecure-http-resource",
    owasp: "A08:2021",
    re: /(?:src|href)\s*=\s*["']http:\/\//i,
    fix: "Load third-party resources over HTTPS and add Subresource Integrity.",
  },
  {
    rule: "outdated-jquery",
    owasp: "A06:2021",
    re: /jquery[-/](?:1\.\d|2\.\d|3\.[0-4])(?:\.\d+)?(?:\.min)?\.js/i,
    fix: "Upgrade jQuery to a current 3.x (fixes known XSS / prototype pollution) or drop it.",
  },
  {
    rule: "wildcard-cors",
    owasp: "A05:2021",
    re: /access-control-allow-origin[\s"':=,]+\*/i,
    fix: "Restrict CORS to an explicit origin allow-list instead of \"*\".",
  },
];

/** Rough binary check: a UTF-8 decode of a binary file yields U+FFFD replacements. */
function looksBinary(text: string): boolean {
  return text.length > 400_000 || text.indexOf("�") !== -1;
}

interface OwaspVerdict {
  ok: boolean;
  points: SecurityAnalysisPoint[];
  summary: string;
}

/** Pull the JSON verdict array out of the model reply and validate it. */
function parseOwaspVerdict(output: string): OwaspVerdict {
  const fences = [...output.matchAll(/```json\s*([\s\S]*?)```/gi)];
  let raw = fences.length ? fences[fences.length - 1]?.[1]?.trim() : undefined;
  if (!raw) {
    // No fence — take the outermost [ … ] span.
    const open = output.indexOf("[");
    const close = output.lastIndexOf("]");
    if (open !== -1 && close > open) raw = output.slice(open, close + 1).trim();
  }
  if (!raw) {
    return { ok: false, points: [], summary: "The model did not return a JSON verdict." };
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
    /** One direct model call for the OWASP gate (no agent). Wired in index.ts. */
    private readonly classify?: SecurityClassifier,
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
    const trimmed = projectName(name);

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

  /**
   * Promote one standalone Agent into a new project's parent Agent without
   * changing its identity, Codex threads, execution history, or checkpoints.
   */
  async upgradeStandaloneAgent(
    agentId: string,
    name: string,
    actor: User,
  ): Promise<{ project: Project; parentAgent: Agent; archivedWorkspace: string | null }> {
    const trimmed = projectName(name);
    const initial = this.store.snapshot();
    const sourceAgent = initial.agents.find((item) => item.id === agentId);
    if (!sourceAgent) throw new HttpError(404, "Agent not found");
    if (sourceAgent.ownerId !== actor.id) {
      throw new HttpError(403, "Only the Agent owner can upgrade it to a project");
    }
    if (sourceAgent.kind !== "standalone" || sourceAgent.projectId !== null) {
      throw new HttpError(409, "Only a standalone Agent can be upgraded to a project");
    }
    if (sourceAgent.status === "busy") {
      throw new HttpError(409, "Wait for the Agent run to finish before upgrading it");
    }
    const sourceBranches = initial.branches.filter((item) => item.agentId === agentId);
    if (sourceBranches.some((branch) => branch.status === "busy")) {
      throw new HttpError(409, "Wait for every branch run to finish before upgrading the Agent");
    }

    const projectId = randomUUID();
    const timestamp = now();
    const sourceManifest = await this.history.manifest(sourceAgent.workspacePath);
    let mainPath: string;
    try {
      mainPath = await this.workspaces.copyStandaloneToProject(sourceAgent.workspacePath, projectId);
    } catch (error) {
      throw new HttpError(
        500,
        "Could not copy the Agent workspace into the new project: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    let headSnapshot: import("./types.js").WorkspaceSnapshot | null = null;
    try {
      const copiedManifest = await this.history.manifest(mainPath);
      if (copiedManifest.workspaceHash !== sourceManifest.workspaceHash) {
        throw new Error("The copied main workspace did not match the standalone workspace");
      }

      const parentAgent: Agent = {
        ...sourceAgent,
        projectId,
        kind: "parent",
        memberId: null,
        workspacePath: mainPath,
        updatedAt: timestamp,
      };
      await this.workspaces.writeInstructions(parentAgent);
      const promotedManifest = await this.history.manifest(mainPath);
      headSnapshot = await this.history.createSnapshot(
        parentAgent.id,
        projectId,
        mainPath,
        promotedManifest,
      );
      const project: Project = {
        id: projectId,
        name: trimmed,
        ownerId: actor.id,
        mainWorkspacePath: mainPath,
        parentAgentId: parentAgent.id,
        headSnapshotId: headSnapshot.id,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.store.mutate((database) => {
        const storedAgent = database.agents.find((item) => item.id === agentId);
        if (!storedAgent || storedAgent.ownerId !== actor.id) {
          throw new HttpError(404, "Agent not found");
        }
        if (storedAgent.kind !== "standalone" || storedAgent.projectId !== null) {
          throw new HttpError(409, "The Agent was already upgraded");
        }
        if (storedAgent.status === "busy") {
          throw new HttpError(409, "The Agent started a run while the upgrade was being prepared");
        }
        const branches = database.branches.filter((item) => item.agentId === agentId);
        if (branches.some((branch) => branch.status === "busy")) {
          throw new HttpError(409, "A branch started a run while the upgrade was being prepared");
        }

        Object.assign(storedAgent, parentAgent);
        for (const branch of branches) {
          branch.workspacePath = this.workspaces.branchWorkspacePath(mainPath, branch.id);
        }
        database.snapshots.push(headSnapshot!);
        database.projects.push(project);
        database.audit.push({
          id: randomUUID(),
          userId: actor.id,
          userName: actor.name,
          agentId,
          action: "agent.upgrade-to-project",
          resource: "project:" + projectId,
          decision: "allow",
          reason: "Owner upgraded standalone Agent " + sourceAgent.name + " into project " + trimmed,
          timestamp,
        });
      });

      // The committed project copy is authoritative. Archiving the old path is
      // recoverable cleanup; a failure here leaves only a harmless duplicate.
      let archivedWorkspace: string | null = null;
      try {
        archivedWorkspace = await this.workspaces.archive(sourceAgent);
      } catch {
        archivedWorkspace = null;
      }
      return { project, parentAgent, archivedWorkspace };
    } catch (error) {
      if (headSnapshot) {
        await this.history.archiveSnapshots(projectId, [headSnapshot]).catch(() => undefined);
      }
      await this.workspaces.discardProjectCopy(projectId).catch(() => undefined);
      throw error;
    }
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
   * Run the pre-commit OWASP gate, cheapest path first, and store the verdict:
   *  1. no changes vs main    -> passing, no work
   *  2. static pre-filter hit -> failing, zero tokens
   *  3. static pass clean     -> one direct model call over just the changed
   *     files (no agent, no tools, no conversation history)
   */
  async runSecurityGate(projectId: string, memberId: string): Promise<MemberSecurityView> {
    const gate = await this.buildSecurityGate(projectId, memberId);
    if (gate.kind === "ready") {
      return this.storeSecurityAnalysis(projectId, memberId, gate.analysis);
    }

    if (!this.classify) {
      throw new HttpError(503, "The security model is not configured.");
    }
    let verdict: OwaspVerdict;
    try {
      verdict = parseOwaspVerdict(await this.classify(gate.prompt));
    } catch (error) {
      // Fail-closed: block the commit with the reason shown to the member.
      return this.storeSecurityAnalysis(projectId, memberId, {
        ranAt: now(),
        runId: "",
        workspaceHash: gate.workspaceHash,
        passed: false,
        modifiedWorkspace: false,
        points: [],
        summary:
          (error instanceof HttpError ? error.message : "The security check could not run") +
          " — try again.",
      });
    }
    const passed = verdict.ok && verdict.points.every((point) => point.status !== "fail");
    return this.storeSecurityAnalysis(projectId, memberId, {
      ranAt: now(),
      runId: "",
      workspaceHash: gate.workspaceHash,
      passed,
      modifiedWorkspace: false,
      points: verdict.points,
      summary: verdict.summary,
    });
  }

  /**
   * Decide the cheapest way to run the pre-commit gate for a member:
   *  - no changes vs main       -> trivially "ready" (passing, nothing to scan)
   *  - static pre-filter hits   -> "ready" with those findings, no model call
   *  - static pass is clean     -> "needs-llm" with a prompt that inlines the
   *    changed files so the model needs no tools
   */
  async buildSecurityGate(
    projectId: string,
    memberId: string,
  ): Promise<
    | { kind: "ready"; analysis: SecurityAnalysis }
    | { kind: "needs-llm"; prompt: string; workspaceHash: string }
  > {
    const database = this.store.snapshot();
    const project = database.projects.find((item) => item.id === projectId);
    const member = database.projectMembers.find(
      (item) => item.id === memberId && item.projectId === projectId,
    );
    if (!project || !member) throw new HttpError(404, "Member not found");

    const changed = await this.diffMemberAgainstMain(project, member);
    const workspaceHash = (await this.history.manifest(member.workspacePath)).workspaceHash;
    const filesToReview = [...changed.created, ...changed.modified];

    if (filesToReview.length === 0) {
      return {
        kind: "ready",
        analysis: {
          ranAt: now(),
          runId: "",
          workspaceHash,
          passed: true,
          modifiedWorkspace: false,
          points: OWASP_TOP_10.map((entry) => ({
            id: entry.id,
            name: entry.name,
            status: "na" as OwaspStatus,
            detail: "No changes vs main.",
          })),
          summary: "No changes vs main to review.",
        },
      };
    }

    const findings = await this.staticScan(member.workspacePath, filesToReview);
    if (findings.length > 0) {
      return { kind: "ready", analysis: this.buildStaticAnalysis(findings, workspaceHash) };
    }

    const inlined: Array<{ path: string; content: string }> = [];
    for (const rel of filesToReview) {
      if (rel === "AGENTS.md") continue;
      try {
        const content = await readFile(path.join(member.workspacePath, rel), "utf8");
        if (!looksBinary(content)) inlined.push({ path: rel, content });
      } catch {
        /* unreadable — skip */
      }
    }
    return { kind: "needs-llm", prompt: owaspAnalysisPrompt(inlined), workspaceHash };
  }

  /** Lexical scan of the given files; returns raw hits mapped to OWASP ids. */
  private async staticScan(
    rootDir: string,
    files: string[],
  ): Promise<Array<{ file: string; line: number; rule: string; owasp: string; excerpt: string; fix: string }>> {
    const findings: Array<{
      file: string;
      line: number;
      rule: string;
      owasp: string;
      excerpt: string;
      fix: string;
    }> = [];
    for (const rel of files) {
      if (rel === "AGENTS.md") continue;
      let text: string;
      try {
        text = await readFile(path.join(rootDir, rel), "utf8");
      } catch {
        continue;
      }
      if (looksBinary(text)) continue; // skip huge / binary files
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        for (const spec of STATIC_RULES) {
          if (spec.re.test(line)) {
            findings.push({
              file: rel,
              line: index + 1,
              rule: spec.rule,
              owasp: spec.owasp,
              excerpt: line.trim().slice(0, 240),
              fix: spec.fix,
            });
          }
        }
      }
    }
    return findings;
  }

  private buildStaticAnalysis(
    findings: Array<{ file: string; line: number; rule: string; owasp: string; excerpt: string; fix: string }>,
    workspaceHash: string,
  ): SecurityAnalysis {
    const byOwasp = new Map<string, typeof findings>();
    for (const finding of findings) {
      const list = byOwasp.get(finding.owasp) ?? [];
      list.push(finding);
      byOwasp.set(finding.owasp, list);
    }
    const points: SecurityAnalysisPoint[] = OWASP_TOP_10.map((entry) => {
      const hits = byOwasp.get(entry.id);
      if (!hits || hits.length === 0) {
        return {
          id: entry.id,
          name: entry.name,
          status: "na" as OwaspStatus,
          detail: "Not assessed by the fast static check.",
        };
      }
      const rules = [...new Set(hits.map((hit) => hit.rule))];
      return {
        id: entry.id,
        name: entry.name,
        status: "fail" as OwaspStatus,
        detail:
          hits.length + " match" + (hits.length === 1 ? "" : "es") + " — " + rules.join(", "),
        file: hits[0]!.file,
        evidence: hits
          .slice(0, 6)
          .map((hit) => hit.file + ":" + hit.line + "  " + hit.excerpt)
          .join("\n")
          .slice(0, 2000),
        remediation: [...new Set(hits.map((hit) => hit.fix))].join(" "),
      };
    });
    const failedIds = points.filter((point) => point.status === "fail").map((point) => point.id);
    return {
      ranAt: now(),
      runId: "",
      workspaceHash,
      passed: false,
      modifiedWorkspace: false,
      points,
      summary:
        failedIds.length +
        " OWASP categor" +
        (failedIds.length === 1 ? "y" : "ies") +
        " flagged by the fast static check (no agent run): " +
        failedIds.join(", "),
    };
  }

  /** Persist a security verdict on the member, audit it, and return the gate state. */
  private async storeSecurityAnalysis(
    projectId: string,
    memberId: string,
    analysis: SecurityAnalysis,
  ): Promise<MemberSecurityView> {
    const database = this.store.snapshot();
    const member = database.projectMembers.find(
      (item) => item.id === memberId && item.projectId === projectId,
    );
    if (!member) throw new HttpError(404, "Member not found");

    await this.store.mutate((db) => {
      const row = db.projectMembers.find((item) => item.id === memberId);
      if (row) {
        row.securityAnalysis = analysis;
        row.updatedAt = now();
      }
    });

    const memberName =
      database.users.find((user) => user.id === member.userId)?.name ?? "Member";
    await this.recordAudit(
      { id: member.userId, name: memberName } as User,
      projectId,
      member.childAgentId,
      "security.check",
      analysis.passed ? "allow" : "deny",
      analysis.passed ? "Security gate passed — commit unlocked" : "Security gate: " + analysis.summary,
    );

    return this.getMemberSecurity(projectId, memberId);
  }

  /**
   * Auto-fix the flagged OWASP findings with one direct model call per affected
   * file (no agent run). Writes the rewritten files into the member's branch and
   * records the fix as a turn in the child agent's transcript. `pointIds` limits
   * it to specific findings; null = every fail with a known file.
   */
  async applySecurityFixes(
    projectId: string,
    memberId: string,
    pointIds: string[] | null,
  ): Promise<MemberSecurityView> {
    if (!this.classify) throw new HttpError(503, "The security model is not configured.");
    const database = this.store.snapshot();
    const member = database.projectMembers.find(
      (item) => item.id === memberId && item.projectId === projectId,
    );
    if (!member) throw new HttpError(404, "Member not found");
    const analysis = member.securityAnalysis;
    if (!analysis) throw new HttpError(409, "Run the security analysis first.");

    const wanted = pointIds && pointIds.length ? new Set(pointIds) : null;
    const fails = analysis.points.filter(
      (point) =>
        point.status === "fail" && point.file && (!wanted || wanted.has(point.id)),
    );
    if (fails.length === 0) throw new HttpError(409, "Nothing to fix.");

    const byFile = new Map<string, SecurityAnalysisPoint[]>();
    for (const point of fails) {
      const list = byFile.get(point.file!) ?? [];
      list.push(point);
      byFile.set(point.file!, list);
    }

    const fixed: string[] = [];
    const skipped: string[] = [];
    for (const [rel, issues] of byFile) {
      const absolute = path.join(member.workspacePath, rel);
      let original: string;
      try {
        original = await readFile(absolute, "utf8");
      } catch {
        skipped.push(rel);
        continue;
      }
      let rewritten: string;
      try {
        rewritten = stripCodeFence(await this.classify(fileFixPrompt(rel, original, issues)));
      } catch {
        skipped.push(rel);
        continue;
      }
      // Guard against refusals / truncation / snippets.
      if (
        !rewritten.trim() ||
        rewritten.length < Math.max(20, original.length * 0.25) ||
        rewritten.length > original.length * 6
      ) {
        skipped.push(rel);
        continue;
      }
      await writeFile(absolute, rewritten.endsWith("\n") ? rewritten : rewritten + "\n", "utf8");
      fixed.push(rel);
    }

    if (fixed.length === 0) {
      throw new HttpError(
        422,
        "The auto-fix could not be applied to " + [...byFile.keys()].join(", ") + " — fix by hand.",
      );
    }

    const ids = [...new Set(fails.filter((p) => fixed.includes(p.file!)).map((p) => p.id))];
    const summary =
      "Rewrote " + fixed.join(", ") + " to address " + ids.join(", ") + "." +
      (skipped.length ? " Could not auto-fix: " + skipped.join(", ") + "." : "");
    const runId = randomUUID();
    const timestamp = now();
    await this.store.mutate((db) => {
      db.runs.push({
        id: runId,
        agentId: member.childAgentId,
        branchId: null,
        status: "completed",
        prompt: "Auto-fix OWASP " + ids.join(", ") + " in " + fixed.join(", "),
        output: summary,
        error: null,
        usage: null,
        startedAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
        beforeWorkspaceHash: null,
        afterWorkspaceHash: null,
        checkpointId: null,
      });
      db.messages.push({
        id: randomUUID(),
        agentId: member.childAgentId,
        runId,
        branchId: null,
        role: "user",
        content: "Auto-fix the flagged OWASP issues (" + ids.join(", ") + ") in " + fixed.join(", ") + ".",
        createdAt: timestamp,
      });
      db.messages.push({
        id: randomUUID(),
        agentId: member.childAgentId,
        runId,
        branchId: null,
        role: "assistant",
        content: summary + " Re-run the security analysis to verify.",
        createdAt: timestamp,
      });
    });

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

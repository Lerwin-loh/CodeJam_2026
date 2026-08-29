import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  AgentPlayground,
  BranchPointPanel,
  useAgentWorkspace,
  WorkspaceOverlays,
} from "./useAgentWorkspace";
import type {
  AuditEntry,
  CommitRequest,
  ParentAgentView,
  Project,
  ProjectDetail,
  ProjectMemberView,
  SecurityCheckResult,
  User,
} from "./types";

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function changedCount(cr: CommitRequest): number {
  return cr.changedFiles.created.length + cr.changedFiles.modified.length + cr.changedFiles.deleted.length;
}

type ProjectTab = "parent" | "mine" | "commits" | "team";

interface Props {
  currentUser: User;
  onSignOut: () => void;
}

export default function ProjectsView({ currentUser, onSignOut }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<ProjectTab>("mine");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const [parent, setParent] = useState<ParentAgentView | null>(null);
  const [child, setChild] = useState<ParentAgentView | null>(null);

  const [commitRequests, setCommitRequests] = useState<CommitRequest[]>([]);
  const [securityResult, setSecurityResult] = useState<SecurityCheckResult | null>(null);
  const [securityRunning, setSecurityRunning] = useState(false);
  const [submittingCommit, setSubmittingCommit] = useState(false);

  const [showAudit, setShowAudit] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);

  const [mUserName, setMUserName] = useState("");
  const [mRole, setMRole] = useState("");

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects: next } = await api.projects.list();
      if (!mounted.current) return;
      setProjects(next);
      setSelectedId((current) => (current && next.some((p) => p.id === current) ? current : next[0]?.id ?? null));
    } catch (reason) {
      fail(reason);
    }
  }, [fail]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const myMember = detail?.myMembership ?? null;
  const isOwner = detail?.role === "owner";
  const childId = myMember?.childAgentId ?? null;

  const loadChild = useCallback(async (projectId: string) => {
    try {
      const view = await api.projects.myAgent(projectId);
      if (mounted.current) setChild(view);
    } catch (reason) {
      fail(reason);
    }
  }, [fail]);

  const openAudit = useCallback(async () => {
    setShowAudit(true);
    try {
      const { entries } = await api.audit();
      if (mounted.current) setAuditEntries(entries);
    } catch (reason) {
      fail(reason);
    }
  }, [fail]);

  const refreshCommitRequests = useCallback(async (id: string) => {
    try {
      const { requests } = await api.projects.commitRequests(id);
      if (mounted.current) setCommitRequests(requests);
    } catch (reason) {
      fail(reason);
    }
  }, [fail]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const next = await api.projects.get(id);
      if (!mounted.current) return;
      setDetail(next);
      setSecurityResult(next.myMembership?.lastSecurityCheck ?? null);
      const parentView = await api.projects.parentAgent(id).catch(() => null);
      if (mounted.current) setParent(parentView);
      await refreshCommitRequests(id);
      if (next.myMembership) await loadChild(id);
      else setChild(null);
      setTab(next.role === "owner" ? "team" : "mine");
    } catch (reason) {
      fail(reason);
    }
  }, [fail, loadChild, refreshCommitRequests]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const handleAgentDeleted = useCallback(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const activeAgent = useMemo(() => {
    if (tab === "parent" && parent) {
      return {
        id: parent.agent.id,
        canManage: isOwner,
        seed: parent,
        title: "Parent agent",
        subtitle: isOwner
          ? "You control the parent agent and the canonical main workspace."
          : "Read-only. Only the project owner can instruct the parent agent.",
      };
    }
    if (tab === "mine" && myMember && childId) {
      return {
        id: childId,
        canManage: true,
        seed: child,
        title: "Your agent",
        subtitle: "Your own copy of the project. You are the " + myMember.role + " engineer.",
      };
    }
    return null;
  }, [tab, parent, child, isOwner, myMember, childId]);

  const ws = useAgentWorkspace(
    activeAgent?.id ?? null,
    activeAgent?.canManage ?? false,
    activeAgent?.seed ?? null,
    handleAgentDeleted,
  );

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.projects.create(newName.trim());
      setNewName("");
      setShowCreate(false);
      await refreshProjects();
      setSelectedId(project.id);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedId || !mUserName.trim() || !mRole.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.projects.addMember(selectedId, { userName: mUserName.trim(), role: mRole.trim() });
      setMUserName("");
      setMRole("");
      await loadDetail(selectedId);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const saveMemberRole = async (memberId: string, role: string) => {
    if (!selectedId || !role.trim()) return;
    setError(null);
    try {
      await api.projects.updateMember(selectedId, memberId, { role: role.trim() });
      await loadDetail(selectedId);
    } catch (reason) {
      fail(reason);
    }
  };

  const removeMember = async (memberId: string, name: string) => {
    if (!selectedId || !window.confirm("Remove " + name + " from this project?")) return;
    setError(null);
    try {
      await api.projects.removeMember(selectedId, memberId);
      await loadDetail(selectedId);
    } catch (reason) {
      fail(reason);
    }
  };

  const startSecurityCheck = async () => {
    if (!selectedId || !myMember) return;
    setSecurityRunning(true);
    setError(null);
    try {
      const { result } = await api.projects.securityCheck(selectedId, myMember.id);
      if (mounted.current) setSecurityResult(result);
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setSecurityRunning(false);
    }
  };

  const submitCommitRequest = async () => {
    if (!selectedId || !myMember) return;
    const title = window.prompt("Title for this commit request", myMember.role + " changes");
    if (title === null) return;
    setSubmittingCommit(true);
    setError(null);
    try {
      await api.projects.submitCommitRequest(selectedId, myMember.id, { title: title.trim() });
      await refreshCommitRequests(selectedId);
      setTab("commits");
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setSubmittingCommit(false);
    }
  };

  const decideCommit = async (requestId: string, decision: "approved" | "rejected") => {
    if (!selectedId) return;
    setError(null);
    try {
      await api.projects.decideCommitRequest(requestId, decision);
      await refreshCommitRequests(selectedId);
    } catch (reason) {
      fail(reason);
    }
  };

  const ownerMembers = useMemo<ProjectMemberView[]>(
    () => (detail && detail.role === "owner" ? (detail.members as ProjectMemberView[]) : []),
    [detail],
  );

  const pendingCommits = commitRequests.filter((cr) => cr.status === "pending").length;

  const tabs: Array<{ key: ProjectTab; label: string; show: boolean }> = [
    { key: "parent", label: "Parent agent", show: true },
    { key: "mine", label: "Your agent", show: !!myMember },
    {
      key: "commits",
      label: "Commit requests" + (pendingCommits > 0 ? " (" + pendingCommits + ")" : ""),
      show: true,
    },
    { key: "team", label: "Team", show: !!isOwner },
  ];

  return (
    <div className={"app-shell " + (ws.showBranchPoint ? "branchpoint-open" : "")}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <strong>Projects</strong>
            <span>Collaboration · RBAC</span>
          </div>
        </div>

        <button className="button button-primary create-button" onClick={() => setShowCreate(true)}>
          <span>＋</span> New Project
        </button>

        <div className="sidebar-label">
          <span>Your Projects</span>
          <span>{projects.length}</span>
        </div>
        <nav className="agent-list">
          {projects.map((project) => (
            <button
              className={"agent-card " + (project.id === selectedId ? "selected" : "")}
              key={project.id}
              onClick={() => setSelectedId(project.id)}
            >
              <div className="agent-avatar">{project.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{project.name}</strong>
                <span>{project.ownerId === currentUser.id ? "Owner" : "Member"}</span>
              </div>
            </button>
          ))}
          {projects.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create a project to build with a team.
            </div>
          )}
        </nav>

        <div className="user-card">
          <div className="user-card-copy">
            <span className="eyebrow">Signed in</span>
            <strong>{currentUser.name}</strong>
          </div>
          <div className="user-card-actions">
            <button className="button button-ghost" onClick={() => void openAudit()}>
              Access log
            </button>
            <button className="button button-ghost" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {!detail ? (
          <div className="no-agent">
            <div className="no-agent-art">P</div>
            <span className="eyebrow">Projects</span>
            <h1>One owner, one agent per teammate.</h1>
            <p>Create a project, add members with a role, and review their commit requests.</p>
            <button className="button button-primary" onClick={() => setShowCreate(true)}>
              New Project
            </button>
          </div>
        ) : (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{detail.project.name}</h1>
                  <span className={"role-badge role-" + detail.role}>{detail.role}</span>
                </div>
                <p>
                  {isOwner
                    ? "You own this project. You control the parent agent, the team, and commit approvals."
                    : "You are the " + (myMember?.role ?? "member") + " on this project."}
                </p>
              </div>
            </header>

            <nav className="project-tabs">
              {tabs
                .filter((t) => t.show)
                .map((t) => (
                  <button
                    key={t.key}
                    className={tab === t.key ? "active" : ""}
                    onClick={() => setTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
            </nav>

            <section className="project-panel">
              {tab === "parent" &&
                (activeAgent ? (
                  <AgentPlayground ws={ws} title={activeAgent.title} subtitle={activeAgent.subtitle} />
                ) : (
                  <p className="muted-note">The parent agent is not available for this project.</p>
                ))}

              {tab === "mine" && myMember && childId && (
                <div className="mine-panel">
                  <div className="mine-toolbar">
                    <button
                      className="button button-ghost"
                      onClick={() => void startSecurityCheck()}
                      disabled={securityRunning || busy}
                    >
                      {securityRunning ? <Spinner /> : "Start security checks"}
                    </button>
                    <button
                      className="button button-primary"
                      onClick={() => void submitCommitRequest()}
                      disabled={submittingCommit || busy}
                    >
                      {submittingCommit ? <Spinner /> : "Submit commit request"}
                    </button>
                  </div>

                  {securityResult && (
                    <div
                      className={
                        "security-result " + (securityResult.findings.length === 0 ? "is-clean" : "has-findings")
                      }
                    >
                      <strong>
                        {securityResult.findings.length === 0
                          ? "Security check passed"
                          : securityResult.findings.length +
                            " potential issue" +
                            (securityResult.findings.length === 1 ? "" : "s")}
                      </strong>
                      <span>
                        {securityResult.filesScanned} files scanned · {formatTime(securityResult.ranAt)}
                      </span>
                      {securityResult.findings.map((f, index) => (
                        <div className="security-finding" key={index}>
                          <code>{f.file}:{f.line}</code>
                          <span className="finding-rule">{f.rule}</span>
                          <pre>{f.excerpt}</pre>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeAgent && activeAgent.id === childId && (
                    <AgentPlayground ws={ws} title={activeAgent.title} subtitle={activeAgent.subtitle} />
                  )}
                </div>
              )}

              {tab === "commits" && (
                <div className="commit-panel">
                  {commitRequests.length === 0 && (
                    <p className="muted-note">
                      {isOwner
                        ? "No commit requests yet."
                        : "No commit requests yet. Submit one from your agent tab when your work is ready."}
                    </p>
                  )}
                  {commitRequests.map((cr) => (
                    <article className={"commit-row commit-" + cr.status} key={cr.id}>
                      <div className="commit-head">
                        <div>
                          <strong>{cr.title}</strong>
                          <span>
                            {cr.memberName} · {cr.role} · {formatTime(cr.createdAt)}
                          </span>
                        </div>
                        <span className={"commit-status status-" + cr.status}>{cr.status}</span>
                      </div>

                      {cr.note && <p className="commit-note">{cr.note}</p>}

                      <div className="commit-files">
                        <span className="eyebrow">{changedCount(cr)} changed files</span>
                        {[
                          ...cr.changedFiles.created.map((f) => ["＋", f] as const),
                          ...cr.changedFiles.modified.map((f) => ["~", f] as const),
                          ...cr.changedFiles.deleted.map((f) => ["−", f] as const),
                        ].map(([mark, f]) => (
                          <code key={mark + f}>
                            {mark} {f}
                          </code>
                        ))}
                      </div>

                      <div className="commit-security">
                        {cr.securityCheck ? (
                          cr.securityCheck.findings.length === 0 ? (
                            <span className="sec-ok">Security check passed ({cr.securityCheck.filesScanned} files)</span>
                          ) : (
                            <span className="sec-bad">
                              {cr.securityCheck.findings.length} security finding
                              {cr.securityCheck.findings.length === 1 ? "" : "s"} —{" "}
                              {cr.securityCheck.findings.map((f) => f.rule).join(", ")}
                            </span>
                          )
                        ) : (
                          <span className="sec-none">No security check was run before submitting.</span>
                        )}
                      </div>

                      {isOwner && cr.status === "pending" && (
                        <div className="commit-actions">
                          <button className="button button-primary" onClick={() => void decideCommit(cr.id, "approved")}>
                            Approve
                          </button>
                          <button className="button button-ghost" onClick={() => void decideCommit(cr.id, "rejected")}>
                            Reject
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}

              {tab === "team" && isOwner && (
                <div className="team-panel">
                  <form className="member-add" onSubmit={addMember}>
                    <div className="member-add-row">
                      <input
                        placeholder="Username (must have signed in)"
                        value={mUserName}
                        onChange={(e) => setMUserName(e.target.value)}
                        maxLength={60}
                      />
                      <input
                        placeholder="Role — e.g. Frontend"
                        value={mRole}
                        onChange={(e) => setMRole(e.target.value)}
                        maxLength={60}
                      />
                    </div>
                    <button className="button button-primary" disabled={busy || !mUserName.trim() || !mRole.trim()}>
                      {busy ? <Spinner /> : "Add member"}
                    </button>
                  </form>

                  <div className="member-list">
                    {ownerMembers.map((member) => (
                      <MemberCard
                        key={member.id}
                        member={member}
                        onSaveRole={(role) => void saveMemberRole(member.id, role)}
                        onRemove={() => void removeMember(member.id, member.name)}
                      />
                    ))}
                    {ownerMembers.length === 0 && <p className="muted-note">No members yet.</p>}
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {ws.showBranchPoint && <BranchPointPanel ws={ws} />}
      <WorkspaceOverlays ws={ws} />

      {showAudit && (
        <div className="modal-backdrop" onMouseDown={() => setShowAudit(false)}>
          <section className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Access log</span>
                <h2>Your access events</h2>
                <p>Every action you take, and every denied attempt on agents you own.</p>
              </div>
              <button type="button" onClick={() => setShowAudit(false)} aria-label="Close access log">
                ×
              </button>
            </div>
            <div className="audit-list">
              {auditEntries.map((entry) => (
                <article className={"audit-row audit-" + entry.decision} key={entry.id}>
                  <span className="audit-decision">{entry.decision}</span>
                  <div className="audit-copy">
                    <strong>
                      {entry.userName} · {entry.action}
                    </strong>
                    <span>
                      {entry.resource} · {formatTime(entry.timestamp)}
                    </span>
                    <p>{entry.reason}</p>
                  </div>
                </article>
              ))}
              {auditEntries.length === 0 && <p className="audit-empty">No access events recorded yet.</p>}
            </div>
          </section>
        </div>
      )}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form className="modal" onSubmit={createProject} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New project</span>
                <h2>Create a project</h2>
                <p>You become the owner. A parent agent and a main workspace are created for you.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>
                ×
              </button>
            </div>
            <label>
              Project name
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} required />
            </label>
            <div className="modal-footer">
              <button type="button" className="button button-ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button className="button button-primary" disabled={busy || !newName.trim()}>
                {busy ? <Spinner /> : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function MemberCard({
  member,
  onSaveRole,
  onRemove,
}: {
  member: ProjectMemberView;
  onSaveRole: (role: string) => void;
  onRemove: () => void;
}) {
  const [role, setRole] = useState(member.role);
  const check = member.lastSecurityCheck;
  return (
    <article className="member-row">
      <div className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</div>
      <div className="member-copy">
        <strong>{member.name}</strong>
        <div className="member-role-edit">
          <input value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} placeholder="Role" />
          <button
            type="button"
            className="button button-primary"
            disabled={!role.trim() || role.trim() === member.role}
            onClick={() => onSaveRole(role)}
          >
            Save role
          </button>
          <button type="button" className="button button-ghost" onClick={onRemove}>
            Remove
          </button>
        </div>
        {check && (
          <span className="member-sec">
            Last security check: {check.findings.length === 0 ? "clean" : check.findings.length + " findings"} ·{" "}
            {formatTime(check.ranAt)}
          </span>
        )}
      </div>
    </article>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { MergeReview } from "./MergeReview";
import type {
    CommitRequest,
    MemberSecurityView,
    MergePreview,
    ParentAgentView,
    Project,
    ProjectDetail,
    ProjectMemberView,
    SecurityAnalysis,
    SecurityAnalysisPoint,
    User,
} from "./types";
import {
    AgentPlayground,
    BranchPointPanel,
    useAgentWorkspace,
    WorkspaceOverlays,
} from "./useAgentWorkspace";

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function changedCount(cr: CommitRequest): number {
  return cr.changedFiles.created.length + cr.changedFiles.modified.length + cr.changedFiles.deleted.length;
}

const SECURITY_GATE_TEXT: Record<MemberSecurityView["reason"], string> = {
  ok: "",
  "never-run": "run the security analysis first",
  failed: "the last OWASP analysis found an issue — fix it and run again",
  incomplete: "the last analysis didn't cover all 10 OWASP categories — run it again",
  "branch-changed": "your branch changed since the last analysis — run it again",
};

function owaspFailCount(a: SecurityAnalysis | null): number {
  return a ? a.points.filter((p) => p.status === "fail").length : 0;
}

function owaspItemBlock(p: SecurityAnalysisPoint, evidenceCap: number): string {
  const evidence =
    p.evidence && p.evidence.length > evidenceCap
      ? p.evidence.slice(0, evidenceCap) + "\n… (truncated)"
      : p.evidence;
  return [
    `OWASP ${p.id} (${p.name})`,
    p.detail ? `  Problem: ${p.detail}` : "",
    p.file ? `  File: ${p.file}` : "",
    evidence ? "  Flagged code:\n```\n" + evidence + "\n```" : "",
    p.remediation ? `  Recommended fix: ${p.remediation}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The message sent to the member's child agent when they press "Fix" on one row. */
function buildFixPrompt(p: SecurityAnalysisPoint): string {
  return [
    `Fix this OWASP ${p.id} (${p.name}) issue in my branch.`,
    "",
    owaspItemBlock(p, 4000),
    "",
    "Apply the fix directly to the file(s). Keep the change minimal and don't touch",
    "unrelated code. When done, briefly say what you changed.",
  ].join("\n");
}

/** The message sent when the member presses "Fix all". */
function buildFixAllPrompt(points: SecurityAnalysisPoint[]): string {
  return [
    `Fix all ${points.length} OWASP issues the security analysis found in my branch.`,
    "Work through them one file at a time and apply each fix directly.",
    "Keep every change minimal and scoped to its issue.",
    "",
    ...points.map((p, index) => `${index + 1}. ` + owaspItemBlock(p, 1000).replace(/\n/g, "\n   ")),
    "",
    "When done, summarise what you changed for each item.",
  ].join("\n");
}

type ProjectTab = "parent" | "mine" | "commits" | "team";

interface Props {
  currentUser: User;
  onSignOut: () => void;
  onToggleMode: () => void;
}

export default function ProjectsView({ currentUser, onSignOut, onToggleMode }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<ProjectTab>("mine");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [fixPoint, setFixPoint] = useState<SecurityAnalysisPoint | null>(null);
  const [newName, setNewName] = useState("");

  const [parent, setParent] = useState<ParentAgentView | null>(null);
  const [child, setChild] = useState<ParentAgentView | null>(null);

  const [commitRequests, setCommitRequests] = useState<CommitRequest[]>([]);
  const [security, setSecurity] = useState<MemberSecurityView | null>(null);
  const [securityExpanded, setSecurityExpanded] = useState(false);
  const [securityRunning, setSecurityRunning] = useState(false);
  const [submittingCommit, setSubmittingCommit] = useState(false);
  const [mergePreview, setMergePreview] = useState<{ preview: MergePreview; memberId: string; branchId: string | null } | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);

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
  const isArchived = !!detail?.project.archivedAt;
  const childId = myMember?.childAgentId ?? null;

  const loadChild = useCallback(async (projectId: string) => {
    try {
      const view = await api.projects.myAgent(projectId);
      if (mounted.current) {
        setChild(view);
        setSecurity(view.security ?? null);
        setSecurityExpanded(false);
      }
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
      setSecurity(null);
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
        canManage: isOwner && !isArchived,
        seed: parent,
        title: "Parent agent",
        subtitle: isArchived
          ? "This project is archived — the parent agent is read-only."
          : isOwner
            ? "You control the parent agent and the canonical main workspace."
            : "Read-only. Only the project owner can instruct the parent agent.",
      };
    }
    if (tab === "mine" && myMember && childId) {
      return {
        id: childId,
        canManage: !isArchived,
        seed: child,
        title: "Your agent",
        subtitle: isArchived
          ? "This project is archived — your agent is frozen and read-only."
          : "Your own copy of the project. You are the " + myMember.role + " engineer.",
      };
    }
    return null;
  }, [tab, parent, child, isOwner, isArchived, myMember, childId]);

  const ws = useAgentWorkspace(
    activeAgent?.id ?? null,
    activeAgent?.canManage ?? false,
    activeAgent?.seed ?? null,
    handleAgentDeleted,
  );

  // A child-agent turn (coding or the analysis itself) can change the branch and
  // therefore the commit gate — re-pull the security state whenever a run settles.
  useEffect(() => {
    if (tab === "mine" && selectedId && childId && ws.status === "ready" && !securityRunning) {
      void loadChild(selectedId);
    }
  }, [ws.status, tab, selectedId, childId, securityRunning, loadChild]);

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

  const deleteProject = async () => {
    if (!selectedId || !detail || detail.role !== "owner") return;
    const confirmed = window.confirm(
      "Delete " + detail.project.name +
        "? Its project and member workspaces will be archived, and all project history will be removed.",
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.projects.delete(selectedId);
      setSelectedId(null);
      setDetail(null);
      setParent(null);
      setChild(null);
      setCommitRequests([]);
      await refreshProjects();
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const setArchived = async (archived: boolean) => {
    if (!selectedId || !detail || detail.role !== "owner") return;
    if (
      archived &&
      !window.confirm(
        "Archive " + detail.project.name +
          "? All members become read-only and every child agent is frozen until you unarchive it.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (archived) await api.projects.archive(selectedId);
      else await api.projects.unarchive(selectedId);
      await loadDetail(selectedId);
      await refreshProjects();
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
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

  const runSecurityAnalysis = async () => {
    if (!selectedId || !myMember) return;
    setSecurityRunning(true);
    setError(null);
    try {
      const { security: next } = await api.projects.securityAnalysis(selectedId, myMember.id);
      if (mounted.current) setSecurity(next);
      // the analysis is a child-agent run — refresh its transcript
      await loadChild(selectedId);
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setSecurityRunning(false);
    }
  };

  const fixWithAgent = (p: SecurityAnalysisPoint) => {
    setFixPoint(null);
    setTab("mine");
    void ws.sendText(buildFixPrompt(p));
  };

  const fixAllWithAgent = (points: SecurityAnalysisPoint[]) => {
    if (points.length === 0) return;
    setFixPoint(null);
    setTab("mine");
    void ws.sendText(buildFixAllPrompt(points));
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

  const openChildMerge = async (memberId: string, branchId: string | null = null) => {
    if (!selectedId) return;
    setMergeBusy(true); setError(null);
    try { setMergePreview({ preview: await api.projects.mergePreview(selectedId, memberId, branchId), memberId, branchId }); }
    catch (reason) { fail(reason); }
    finally { if (mounted.current) setMergeBusy(false); }
  };

  const applyChildMerge = async (resolution: { workspace: Record<string, "target" | "source" | "ai">; context: Record<string, "target" | "source" | "ai"> }) => {
    if (!selectedId || !mergePreview) return;
    setMergeBusy(true); setError(null);
    try { await api.projects.merge(selectedId, mergePreview.memberId, mergePreview.branchId, resolution); setMergePreview(null); await loadDetail(selectedId); }
    catch (reason) { fail(reason); }
    finally { if (mounted.current) setMergeBusy(false); }
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

  const closeBranchPointAndSelectTab = (nextTab: ProjectTab) => {
    ws.setShowBranchPoint(false);
    setTab(nextTab);
  };

  return (
    <div className="app-shell project-app-shell">
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
                <span>
                  {project.ownerId === currentUser.id ? "Owner" : "Member"}
                  {project.archivedAt ? " · Archived" : ""}
                </span>
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
            <button className="button button-ghost" onClick={onToggleMode}>
              Individual mode
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
                  {isArchived && <span className="role-badge role-archived">archived</span>}
                </div>
                <p>
                  {isArchived
                    ? isOwner
                      ? "This project is archived and read-only. Unarchive it to bring back editing, agents, and commit approvals."
                      : "This project is archived by the owner. Everything is read-only until they unarchive it."
                    : isOwner
                      ? "You own this project. You control the parent agent, the team, and commit approvals."
                      : "You are the " + (myMember?.role ?? "member") + " on this project."}
                </p>
              </div>
              {isOwner && (
                <div className="header-actions">
                  <button
                    className="button button-ghost"
                    onClick={() => void setArchived(!isArchived)}
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : isArchived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    className="button button-danger"
                    onClick={() => void deleteProject()}
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : "Delete project"}
                  </button>
                </div>
              )}
            </header>

            <nav className="project-tabs">
              {tabs
                .filter((t) => t.show)
                .map((t) => (
                  <button
                    key={t.key}
                    className={tab === t.key ? "active" : ""}
                    onClick={() => closeBranchPointAndSelectTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
            </nav>

            <section className="project-panel">
              {tab === "parent" &&
                (activeAgent ? (
                  <div className="project-agent-layout">
                    <AgentPlayground
                      ws={ws}
                      title={activeAgent.title}
                      subtitle={activeAgent.subtitle}
                      showDelete={false}
                      sidePanel={ws.showBranchPoint ? <BranchPointPanel ws={ws} /> : undefined}
                    />
                  </div>
                ) : (
                  <p className="muted-note">The parent agent is not available for this project.</p>
                ))}

              {tab === "mine" && myMember && childId && (
                <div className="mine-panel">
                  {isArchived && (
                    <p className="muted-note">
                      This project is archived. Your agent is frozen — the security analysis and
                      commit requests are unavailable until the owner unarchives it.
                    </p>
                  )}
                  <div className="mine-toolbar">
                    <button
                      className="button button-ghost"
                      onClick={() => void runSecurityAnalysis()}
                      disabled={securityRunning || busy || isArchived || ws.status === "busy"}
                      title={
                        ws.status === "busy"
                          ? "Wait for the current agent run to finish"
                          : undefined
                      }
                    >
                      {securityRunning ? <Spinner /> : "Run security analysis"}
                    </button>
                    <button
                      className="button button-primary"
                      onClick={() => void submitCommitRequest()}
                      disabled={submittingCommit || busy || isArchived || !security?.canCommit}
                      title={security?.canCommit ? undefined : SECURITY_GATE_TEXT[security?.reason ?? "never-run"]}
                    >
                      {submittingCommit ? <Spinner /> : "Submit commit request"}
                    </button>
                  </div>

                  {securityRunning && (
                    <p className="muted-note">
                      Your child agent is reviewing the branch against the OWASP Top 10… this runs a
                      full agent turn and can take a minute.
                    </p>
                  )}

                  {security && !securityRunning && (() => {
                    const points = security.analysis?.points ?? [];
                    const fails = points.filter((p) => p.status === "fail");
                    return (
                      <div
                        className={
                          "security-result " + (security.canCommit ? "is-clean" : "has-findings")
                        }
                      >
                        <div className="security-result-head">
                          <div className="security-result-copy">
                            <strong>
                              {security.canCommit
                                ? "OWASP analysis passed — commit unlocked"
                                : "Commit blocked — " + SECURITY_GATE_TEXT[security.reason]}
                            </strong>
                            {security.analysis && (
                              <span>
                                {security.analysis.summary} · {formatTime(security.analysis.ranAt)}
                                {security.analysis.modifiedWorkspace
                                  ? " · ⚠ the analysis run changed files"
                                  : ""}
                              </span>
                            )}
                          </div>
                          <div className="security-result-actions">
                            {fails.length > 0 && (
                              <button
                                className="button button-primary"
                                onClick={() => fixAllWithAgent(fails)}
                                disabled={isArchived || ws.status === "busy"}
                                title={
                                  isArchived
                                    ? "This project is archived"
                                    : ws.status === "busy"
                                      ? "Wait for the current agent run to finish"
                                      : undefined
                                }
                              >
                                Fix all {fails.length}
                              </button>
                            )}
                            {points.length > 0 && (
                              <button
                                className="button button-ghost"
                                onClick={() => setSecurityExpanded((v) => !v)}
                                aria-expanded={securityExpanded}
                              >
                                {securityExpanded ? "Hide details" : "Show details"}
                              </button>
                            )}
                          </div>
                        </div>

                        {securityExpanded && points.length > 0 && (
                          <ul className="owasp-list">
                            {points.map((p) => (
                              <li key={p.id} className={"owasp-row owasp-" + p.status}>
                                <span className="owasp-status">{p.status}</span>
                                <span className="owasp-name">
                                  <code>{p.id}</code> {p.name}
                                </span>
                                {p.detail && <span className="owasp-detail">{p.detail}</span>}
                                {p.status === "fail" && (
                                  <button
                                    className="button button-ghost owasp-fix-btn"
                                    onClick={() => setFixPoint(p)}
                                  >
                                    View &amp; fix
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })()}

                  {activeAgent && activeAgent.id === childId && (
                    <div className="project-agent-layout">
                      <AgentPlayground
                        ws={ws}
                        title={activeAgent.title}
                        subtitle={activeAgent.subtitle}
                        showDelete={false}
                        sidePanel={ws.showBranchPoint ? <BranchPointPanel ws={ws} onMergeBranch={myMember ? (branchId) => void openChildMerge(myMember.id, branchId) : undefined} /> : undefined}
                      />
                    </div>
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
                        {cr.securityAnalysis ? (
                          cr.securityAnalysis.passed ? (
                            <span className="sec-ok">
                              OWASP Top 10 analysis passed · {formatTime(cr.securityAnalysis.ranAt)}
                            </span>
                          ) : (
                            <span className="sec-bad">
                              OWASP analysis: {owaspFailCount(cr.securityAnalysis)} failed —{" "}
                              {cr.securityAnalysis.points
                                .filter((p) => p.status === "fail")
                                .map((p) => p.id)
                                .join(", ")}
                            </span>
                          )
                        ) : (
                          <span className="sec-none">No security analysis attached.</span>
                        )}
                      </div>

                      {isOwner && cr.status === "pending" && !isArchived && (
                        <div className="commit-actions">
                          <button className="button button-primary" onClick={() => void decideCommit(cr.id, "approved")}>
                            Approve
                          </button>
                          <button className="button button-ghost" onClick={() => void decideCommit(cr.id, "rejected")}>
                            Reject
                          </button>
                        </div>
                      )}
                      {isOwner && cr.status === "approved" && !isArchived && (
                        <div className="commit-actions"><button className="button button-primary" onClick={() => void openChildMerge(cr.memberId)}>Review merge into main</button></div>
                      )}
                      {isOwner && cr.status === "pending" && isArchived && (
                        <p className="muted-note">
                          Unarchive the project to approve or reject this request.
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              )}

              {tab === "team" && isOwner && (
                <div className="team-panel">
                  {isArchived && (
                    <p className="muted-note">
                      This project is archived. Team changes are disabled until you unarchive it.
                    </p>
                  )}
                  <form className="member-add" onSubmit={addMember}>
                    <div className="member-add-row">
                      <input
                        placeholder="Username (must have signed in)"
                        value={mUserName}
                        onChange={(e) => setMUserName(e.target.value)}
                        maxLength={60}
                        disabled={isArchived}
                      />
                      <input
                        placeholder="Role — e.g. Frontend"
                        value={mRole}
                        onChange={(e) => setMRole(e.target.value)}
                        maxLength={60}
                        disabled={isArchived}
                      />
                    </div>
                    <button
                      className="button button-primary"
                      disabled={busy || isArchived || !mUserName.trim() || !mRole.trim()}
                    >
                      {busy ? <Spinner /> : "Add member"}
                    </button>
                  </form>

                  <div className="member-list">
                    {ownerMembers.map((member) => (
                      <MemberCard
                        key={member.id}
                        member={member}
                        readOnly={isArchived}
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

      <WorkspaceOverlays ws={ws} />

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

      {fixPoint && (
        <div className="modal-backdrop" onMouseDown={() => setFixPoint(null)}>
          <div className="modal owasp-fix-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">OWASP {fixPoint.id} · flagged</span>
                <h2>{fixPoint.name}</h2>
                {fixPoint.detail && <p>{fixPoint.detail}</p>}
              </div>
              <button type="button" onClick={() => setFixPoint(null)}>
                ×
              </button>
            </div>

            {fixPoint.file && (
              <p className="owasp-fix-file">
                File: <code>{fixPoint.file}</code>
              </p>
            )}

            <span className="eyebrow">Flagged code</span>
            <pre className="owasp-fix-code">
              {fixPoint.evidence || "The analysis did not capture a snippet — the agent will locate it."}
            </pre>

            <span className="eyebrow">Suggested fix</span>
            <p className="owasp-fix-remediation">
              {fixPoint.remediation || "No specific remediation was provided; the agent will propose one."}
            </p>

            <div className="modal-footer">
              <button type="button" className="button button-ghost" onClick={() => setFixPoint(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => fixWithAgent(fixPoint)}
                disabled={isArchived || ws.status === "busy"}
                title={
                  isArchived
                    ? "This project is archived"
                    : ws.status === "busy"
                      ? "Wait for the current agent run to finish"
                      : undefined
                }
              >
                Fix
              </button>
            </div>
          </div>
        </div>
      )}

      {mergeBusy && !mergePreview && <div className="modal-backdrop merge-loading-backdrop"><section className="merge-loading-card" role="status" aria-live="polite"><span className="spinner" /><div><strong>Preparing merge review…</strong><p>Comparing outcomes, workspace files, and context prompts.</p></div></section></div>}
      {mergePreview && <MergeReview preview={mergePreview.preview} busy={mergeBusy} onCancel={() => setMergePreview(null)} onFixWithAi={() => { if (!selectedId) return Promise.reject(new Error("Project not selected")); return api.projects.mergeAi(selectedId, mergePreview.memberId, mergePreview.branchId); }} onMerge={(resolution) => void applyChildMerge(resolution)} />}
    </div>
  );
}

function MemberCard({
  member,
  readOnly = false,
  onSaveRole,
  onRemove,
}: {
  member: ProjectMemberView;
  readOnly?: boolean;
  onSaveRole: (role: string) => void;
  onRemove: () => void;
}) {
  const [role, setRole] = useState(member.role);
  const analysis = member.securityAnalysis;
  return (
    <article className="member-row">
      <div className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</div>
      <div className="member-copy">
        <strong>{member.name}</strong>
        <div className="member-role-edit">
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            maxLength={60}
            placeholder="Role"
            disabled={readOnly}
          />
          <button
            type="button"
            className="button button-primary"
            disabled={readOnly || !role.trim() || role.trim() === member.role}
            onClick={() => onSaveRole(role)}
          >
            Save role
          </button>
          <button
            type="button"
            className="button button-ghost"
            onClick={onRemove}
            disabled={readOnly}
          >
            Remove
          </button>
        </div>
        {analysis && (
          <span className="member-sec">
            OWASP analysis: {analysis.passed ? "passed" : owaspFailCount(analysis) + " failed"} ·{" "}
            {formatTime(analysis.ranAt)}
          </span>
        )}
      </div>
    </article>
  );
}

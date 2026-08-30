import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import {
  AgentPlayground,
  BranchPointPanel,
  useAgentWorkspace,
  WorkspaceOverlays,
} from "./useAgentWorkspace";
import type {
  AgentBranch,
  CommitRequest,
  MemberSecurityView,
  ParentAgentView,
  Project,
  ProjectDetail,
  ProjectMemberView,
  SecurityAnalysis,
  SecurityAnalysisPoint,
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

const SECURITY_GATE_TEXT: Record<MemberSecurityView["reason"], string> = {
  ok: "",
  "never-run": "run Submit commit request to start the security analysis",
  failed: "the OWASP analysis found an issue — fix it, then press Submit commit request again",
  incomplete: "the analysis didn't cover all 10 OWASP categories — press Submit commit request again",
  "branch-changed": "your branch changed since the analysis — press Submit commit request again",
};

function owaspFailCount(a: SecurityAnalysis | null): number {
  return a ? a.points.filter((p) => p.status === "fail").length : 0;
}

type ProjectTab = "parent" | "mine" | "commits" | "team";

interface Props {
  currentUser: User;
  initialProjectId: string | null;
  onSignOut: () => void;
  onToggleMode: () => void;
}

export default function ProjectsView({ currentUser, initialProjectId, onSignOut, onToggleMode }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<ProjectTab>("mine");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [fixPoint, setFixPoint] = useState<SecurityAnalysisPoint | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [mergeSel, setMergeSel] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const [mergeNote, setMergeNote] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const [parent, setParent] = useState<ParentAgentView | null>(null);
  const [child, setChild] = useState<ParentAgentView | null>(null);

  const [commitRequests, setCommitRequests] = useState<CommitRequest[]>([]);
  const [security, setSecurity] = useState<MemberSecurityView | null>(null);
  const [securityExpanded, setSecurityExpanded] = useState(false);
  // "Submit commit request" now runs the OWASP analysis first, then submits.
  const [commitPhase, setCommitPhase] = useState<null | "fixing" | "analyzing" | "submitting">(null);

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
    if (tab === "mine" && selectedId && childId && ws.status === "ready" && commitPhase === null) {
      void loadChild(selectedId);
    }
  }, [ws.status, tab, selectedId, childId, commitPhase, loadChild]);

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

  const openMerge = () => {
    setMergeSel(new Set());
    setShowMerge(true);
  };

  const doMerge = async () => {
    if (mergeSel.size === 0) return;
    setMerging(true);
    setError(null);
    setMergeNote(null);
    try {
      const result = await ws.mergeBranches([...mergeSel]);
      setShowMerge(false);
      setMergeSel(new Set());
      if (selectedId) await loadChild(selectedId);
      if (mounted.current && result.mergedBranchIds.length > 0) {
        const n = result.mergedBranchIds.length;
        const f = result.changedFiles.length;
        setMergeNote(
          "Merged " + n + " sub-branch" + (n === 1 ? "" : "es") + " and deleted them" +
            (f > 0
              ? " — " + f + " file" + (f === 1 ? "" : "s") +
                " changed. Press Submit commit request to re-check and commit."
              : " (no file changes)."),
        );
      }
    } finally {
      if (mounted.current) setMerging(false);
    }
  };

  // One action: run the OWASP analysis, and only submit the commit request if it
  // passes. On failure the result panel shows the issues and nothing is submitted.
  // `silent` skips the title prompt (used by the auto-continue after a Fix).
  const submitCommitRequest = async (silent = false) => {
    if (!selectedId || !myMember) return;
    setError(null);
    setMergeNote(null);

    const finishSubmit = async () => {
      setCommitPhase("submitting");
      const defaultTitle = myMember.role + " changes";
      const title = silent
        ? defaultTitle
        : window.prompt("Title for this commit request", defaultTitle);
      if (title === null) return;
      await api.projects.submitCommitRequest(selectedId, myMember.id, {
        title: title.trim() || defaultTitle,
      });
      await refreshCommitRequests(selectedId);
      setTab("commits");
    };

    try {
      // A passing analysis already bound to the current branch state? Skip the
      // (token-costly) re-scan and submit straight away. If the server gate
      // disagrees (stale), fall back to a fresh analysis.
      if (security?.canCommit) {
        try {
          setCommitPhase("submitting");
          await finishSubmit();
          return;
        } catch (reason) {
          if (!(reason instanceof ApiError) || reason.status !== 409) throw reason;
        }
      }

      setCommitPhase("analyzing");
      const { security: next } = await api.projects.securityAnalysis(selectedId, myMember.id);
      if (!mounted.current) return;
      setSecurity(next);
      if (!next.canCommit) {
        setSecurityExpanded(true);
        return;
      }
      await finishSubmit();
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setCommitPhase(null);
    }
  };

  // After the agent finishes a fix, auto re-run the analysis + commit — the user
  // shouldn't have to press Submit again.
  // Direct model rewrite of the flagged file(s) — no agent run — then auto
  // re-scan + commit. `pointIds` undefined = fix every flagged finding.
  const runAutoFix = async (pointIds?: string[]) => {
    if (!selectedId || !myMember || commitPhase !== null) return;
    setFixPoint(null);
    setTab("mine");
    setError(null);
    setMergeNote(null);
    setCommitPhase("fixing");
    let fixed = false;
    try {
      const { security: next } = await api.projects.securityFix(selectedId, myMember.id, pointIds);
      if (mounted.current) setSecurity(next);
      if (selectedId) await loadChild(selectedId); // surface the fix turn in chat
      fixed = true;
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setCommitPhase(null);
    }
    if (fixed) await submitCommitRequest(true);
  };

  const fixWithAgent = (p: SecurityAnalysisPoint) => void runAutoFix([p.id]);
  const fixAllWithAgent = (points: SecurityAnalysisPoint[]) => {
    if (points.length > 0) void runAutoFix();
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
                      className="button button-primary"
                      onClick={() => void submitCommitRequest()}
                      disabled={commitPhase !== null || busy || isArchived || ws.status === "busy"}
                      title={
                        ws.status === "busy" ? "Wait for the current agent run to finish" : undefined
                      }
                    >
                      {commitPhase === "fixing" ? (
                        <>
                          <Spinner /> Applying fix…
                        </>
                      ) : commitPhase === "analyzing" ? (
                        <>
                          <Spinner /> Running security analysis…
                        </>
                      ) : commitPhase === "submitting" ? (
                        <>
                          <Spinner /> Submitting…
                        </>
                      ) : (
                        "Submit commit request"
                      )}
                    </button>
                    <button
                      className="button button-ghost"
                      onClick={openMerge}
                      disabled={
                        commitPhase !== null ||
                        busy ||
                        isArchived ||
                        ws.status === "busy" ||
                        ws.branches.length === 0
                      }
                      title={
                        ws.branches.length === 0
                          ? "You have no sub-branches to merge"
                          : ws.status === "busy"
                            ? "Wait for the current agent run to finish"
                            : undefined
                      }
                    >
                      Merge sub-branches{ws.branches.length ? " (" + ws.branches.length + ")" : ""}
                    </button>
                  </div>

                  {mergeNote && <p className="muted-note">{mergeNote}</p>}

                  {commitPhase === "analyzing" && (
                    <p className="muted-note">
                      Checking your changed files against the OWASP Top 10… a fast static pass runs
                      first, then one model call if that's clean. The commit request is submitted only
                      if every category passes.
                    </p>
                  )}

                  {security && commitPhase !== "analyzing" && (() => {
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
                                disabled={isArchived || commitPhase !== null}
                                title={isArchived ? "This project is archived" : undefined}
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
                                    disabled={commitPhase !== null}
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
                        sidePanel={ws.showBranchPoint ? <BranchPointPanel ws={ws} /> : undefined}
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
              {fixPoint.evidence || "The analysis did not capture a snippet."}
            </pre>

            <span className="eyebrow">Suggested fix</span>
            <p className="owasp-fix-remediation">
              {fixPoint.remediation || "No specific remediation was provided."}
            </p>
            <p className="muted-note">
              Fix rewrites <code>{fixPoint.file || "the file"}</code> in one model call, then re-runs
              the analysis and commits if it passes.
            </p>

            <div className="modal-footer">
              <button type="button" className="button button-ghost" onClick={() => setFixPoint(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => fixWithAgent(fixPoint)}
                disabled={isArchived || commitPhase !== null}
                title={isArchived ? "This project is archived" : undefined}
              >
                Fix
              </button>
            </div>
          </div>
        </div>
      )}

      {showMerge && (
        <div className="modal-backdrop" onMouseDown={() => !merging && setShowMerge(false)}>
          <div className="modal merge-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Your agent · sub-branches</span>
                <h2>Merge sub-branches</h2>
                <p>
                  Picked branches are folded into your workspace, then deleted. Overlapping
                  files: the newer branch wins. Re-run the security analysis afterwards —
                  anything not in your workspace at commit time is not committed.
                </p>
              </div>
              <button type="button" onClick={() => !merging && setShowMerge(false)}>
                ×
              </button>
            </div>

            {ws.branches.length === 0 ? (
              <p className="muted-note">No sub-branches.</p>
            ) : (
              <>
                <div className="merge-select-all">
                  <label>
                    <input
                      type="checkbox"
                      checked={mergeSel.size === ws.branches.length}
                      onChange={(e) =>
                        setMergeSel(
                          e.target.checked
                            ? new Set(ws.branches.map((b) => b.id))
                            : new Set(),
                        )
                      }
                    />
                    Select all ({ws.branches.length})
                  </label>
                </div>
                <ul className="merge-branch-list">
                  {[...ws.branches]
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                    .map((b: AgentBranch) => (
                      <li key={b.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={mergeSel.has(b.id)}
                            onChange={(e) =>
                              setMergeSel((cur) => {
                                const next = new Set(cur);
                                if (e.target.checked) next.add(b.id);
                                else next.delete(b.id);
                                return next;
                              })
                            }
                          />
                          <span className="merge-branch-name">{b.name}</span>
                          <span className="merge-branch-meta">
                            {b.status === "busy" ? "running · " : ""}
                            {formatTime(b.createdAt)}
                          </span>
                        </label>
                      </li>
                    ))}
                </ul>
              </>
            )}

            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowMerge(false)}
                disabled={merging}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => void doMerge()}
                disabled={merging || mergeSel.size === 0}
              >
                {merging ? <Spinner /> : "Merge " + mergeSel.size + " & delete"}
              </button>
            </div>
          </div>
        </div>
      )}
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

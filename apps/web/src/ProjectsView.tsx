import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import {
  AgentPlayground,
  BranchPointPanel,
  useAgentWorkspace,
  WorkspaceOverlays,
} from "./useAgentWorkspace";
import type {
  ActivityEntry,
  AgentBranch,
  CommitRequest,
  MemberSecurityView,
  ParentAgentView,
  Project,
  ProjectDetail,
  ProjectInvitation,
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

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

/** Deterministic avatar hue from a name. */
function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

const ACTIVITY_LABEL: Record<string, string> = {
  "project.member.invite": "invited a member",
  "project.invitation.accept": "joined the project",
  "project.invitation.decline": "declined an invitation",
  "project.member.role": "changed a member role",
  "project.member.remove": "removed a member",
  "project.member.leave": "left the project",
  "project.transfer": "transferred ownership",
  "project.update": "updated project settings",
  "project.archive": "archived the project",
  "project.unarchive": "unarchived the project",
  "project.delete": "deleted the project",
  "security.check": "ran a security gate",
  "commit.request.create": "filed a commit request",
  "commit.request.decide": "decided a commit request",
  "agent.run": "ran the agent",
};

type ProjectTab = "parent" | "mine" | "commits" | "team";
type TeamSection = "members" | "activity" | "danger";

interface Props {
  currentUser: User;
  initialProjectId: string | null;
  onSignOut: () => void;
  onDeleteAccount: () => Promise<void>;
  onToggleMode: () => void;
}

export default function ProjectsView({ currentUser, initialProjectId, onSignOut, onDeleteAccount, onToggleMode }: Props) {
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

  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [teamSection, setTeamSection] = useState<TeamSection>("members");
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [transferTo, setTransferTo] = useState<ProjectMemberView | null>(null);
  const [transferConfirm, setTransferConfirm] = useState("");
  const [pName, setPName] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

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
      const { projects: next, invitations: invs } = await api.projects.list();
      if (!mounted.current) return;
      setProjects(next);
      setInvitations(invs);
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

  const loadActivity = useCallback(async (id: string) => {
    try {
      const { activity: rows } = await api.projects.activity(id);
      if (mounted.current) setActivity(rows);
    } catch {
      /* non-critical */
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const next = await api.projects.get(id);
      if (!mounted.current) return;
      setDetail(next);
      setSecurity(null);
      setTeamSection("members");
      setPName(next.project.name);
      setPDesc(next.project.description);
      const parentView = await api.projects.parentAgent(id).catch(() => null);
      if (mounted.current) setParent(parentView);
      await refreshCommitRequests(id);
      await loadActivity(id);
      if (next.myMembership) await loadChild(id);
      else setChild(null);
      setTab(next.role === "owner" ? "team" : "mine");
    } catch (reason) {
      fail(reason);
    }
  }, [fail, loadChild, loadActivity, refreshCommitRequests]);

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

  const deleteAccount = async () => {
    const confirmation = window.prompt(
      `Delete ${currentUser.name}'s account and all dependent Agents and Projects?\n\nType the account name to confirm:`,
    );
    if (confirmation === null) return;
    if (confirmation !== currentUser.name) {
      setError("Account name did not match. Nothing was deleted.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onDeleteAccount();
    } catch (reason) {
      fail(reason);
      setBusy(false);
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

  const respondInvite = async (projectId: string, accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (accept) await api.projects.acceptInvite(projectId);
      else await api.projects.declineInvite(projectId);
      await refreshProjects();
      if (accept) setSelectedId(projectId);
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedId || !detail) return;
    const name = pName.trim();
    const description = pDesc.trim();
    if (name === detail.project.name && description === detail.project.description) return;
    setSavingSettings(true);
    setError(null);
    try {
      await api.projects.update(selectedId, { name, description });
      await loadDetail(selectedId);
      await refreshProjects();
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setSavingSettings(false);
    }
  };

  const doTransfer = async () => {
    if (!selectedId || !detail || !transferTo) return;
    if (transferConfirm.trim() !== detail.project.name) return;
    setBusy(true);
    setError(null);
    try {
      await api.projects.transfer(selectedId, transferTo.userId);
      setTransferTo(null);
      setTransferConfirm("");
      await loadDetail(selectedId);
      await refreshProjects();
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const leaveProject = async () => {
    if (!selectedId || !detail) return;
    if (!window.confirm("Leave " + detail.project.name + "?")) return;
    setBusy(true);
    setError(null);
    try {
      await api.projects.leave(selectedId);
      setSelectedId(null);
      setDetail(null);
      await refreshProjects();
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
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
      await refreshProjects();
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
    { key: "team", label: isOwner ? "Settings" : "Team", show: true },
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

        {invitations.length > 0 && (
          <div className="invite-list">
            <div className="sidebar-label">
              <span>Invitations</span>
              <span>{invitations.length}</span>
            </div>
            {invitations.map((inv) => (
              <div className="invite-card" key={inv.projectId}>
                <strong>{inv.projectName}</strong>
                <span>
                  {inv.invitedByName} invited you as {inv.role}
                </span>
                <div className="invite-actions">
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => void respondInvite(inv.projectId, true)}
                  >
                    Accept
                  </button>
                  <button
                    className="button button-ghost"
                    disabled={busy}
                    onClick={() => void respondInvite(inv.projectId, false)}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

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
          <div className="user-card-danger-row">
            <button className="button button-danger" disabled={busy} onClick={() => void deleteAccount()}>
              Delete account
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
                {detail.project.description ? (
                  <p>{detail.project.description}</p>
                ) : (
                  <p>
                    {isArchived
                      ? isOwner
                        ? "Archived and read-only. Unarchive from Settings › Danger zone."
                        : "Archived by the owner — everything is read-only."
                      : isOwner
                        ? "Owner · " + ownerMembers.filter((m) => m.status === "active").length +
                          " member" +
                          (ownerMembers.filter((m) => m.status === "active").length === 1 ? "" : "s")
                        : "You are the " + (myMember?.role ?? "member") + " · owner: " + detail.owner.name}
                  </p>
                )}
              </div>
              {isOwner && (
                <div className="header-actions">
                  <button
                    className="button button-ghost"
                    onClick={() => {
                      setTab("team");
                      setTeamSection("danger");
                    }}
                  >
                    Settings
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

                  {security && security.analysis && commitPhase !== "analyzing" && (() => {
                    const points = security.analysis.points;
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

              {tab === "team" && detail && (
                <div className="settings-layout">
                  <nav className="settings-rail">
                    <button
                      className={teamSection === "members" ? "active" : ""}
                      onClick={() => setTeamSection("members")}
                    >
                      Members
                    </button>
                    <button
                      className={teamSection === "activity" ? "active" : ""}
                      onClick={() => setTeamSection("activity")}
                    >
                      Activity
                    </button>
                    <button
                      className={teamSection === "danger" ? "active" : ""}
                      onClick={() => setTeamSection("danger")}
                    >
                      {isOwner ? "Danger zone" : "Membership"}
                    </button>
                  </nav>

                  <div className="settings-body">
                    {teamSection === "members" && (
                      <section className="settings-section">
                        <div className="settings-section-head">
                          <h3>Members</h3>
                          <p>The owner runs the parent agent. Everyone else gets one child agent.</p>
                        </div>

                        {isOwner && (
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
                              {busy ? <Spinner /> : "Send invite"}
                            </button>
                          </form>
                        )}
                        {isArchived && isOwner && (
                          <p className="muted-note">Unarchive the project to change the team.</p>
                        )}

                        <div className="member-list">
                          <article className="member-row">
                            <div
                              className="member-avatar"
                              style={{
                                background: `hsl(${avatarHue(detail.owner.name)} 55% 42%)`,
                              }}
                            >
                              {initials(detail.owner.name)}
                            </div>
                            <div className="member-copy">
                              <div className="member-name-row">
                                <strong>{detail.owner.name}</strong>
                                <span className="role-badge role-owner">owner</span>
                                {detail.owner.id === currentUser.id && (
                                  <span className="member-you">you</span>
                                )}
                              </div>
                              <span className="member-sec">Controls the parent agent &amp; main</span>
                            </div>
                          </article>

                          {isOwner
                            ? ownerMembers.map((member) => (
                                <MemberCard
                                  key={member.id}
                                  member={member}
                                  isYou={member.userId === currentUser.id}
                                  readOnly={isArchived}
                                  onSaveRole={(role) => void saveMemberRole(member.id, role)}
                                  onRemove={() => void removeMember(member.id, member.name)}
                                  onTransfer={
                                    member.status === "active" && !isArchived
                                      ? () => {
                                          setTransferConfirm("");
                                          setTransferTo(member);
                                        }
                                      : undefined
                                  }
                                />
                              ))
                            : (detail.members as { userId: string; name: string; role: string; status: string }[]).map(
                                (m) => (
                                  <article className="member-row" key={m.userId}>
                                    <div
                                      className="member-avatar"
                                      style={{ background: `hsl(${avatarHue(m.name)} 55% 42%)` }}
                                    >
                                      {initials(m.name)}
                                    </div>
                                    <div className="member-copy">
                                      <div className="member-name-row">
                                        <strong>{m.name}</strong>
                                        <span className="role-badge role-member">{m.role}</span>
                                        {m.userId === currentUser.id && (
                                          <span className="member-you">you</span>
                                        )}
                                      </div>
                                    </div>
                                  </article>
                                ),
                              )}
                          {isOwner && ownerMembers.length === 0 && (
                            <p className="muted-note">No members yet — send an invite above.</p>
                          )}
                        </div>
                      </section>
                    )}

                    {teamSection === "activity" && (
                      <section className="settings-section">
                        <div className="settings-section-head">
                          <h3>Activity</h3>
                          <p>Recent audited events on this project.</p>
                        </div>
                        {activity.length === 0 && <p className="muted-note">Nothing yet.</p>}
                        <ul className="activity-list">
                          {activity.map((e) => (
                            <li key={e.id} className={"activity-row activity-" + e.decision}>
                              <span className="activity-dot" />
                              <span className="activity-text">
                                <strong>{e.userName}</strong>{" "}
                                {ACTIVITY_LABEL[e.action] ?? e.action}
                                {e.reason ? <span className="activity-reason"> — {e.reason}</span> : null}
                              </span>
                              <span className="activity-time">{formatTime(e.timestamp)}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                    {teamSection === "danger" && isOwner && (
                      <>
                        <section className="settings-section">
                          <div className="settings-section-head">
                            <h3>Project</h3>
                            <p>Name and description.</p>
                          </div>
                          <form className="settings-form" onSubmit={saveSettings}>
                            <label>
                              Name
                              <input
                                value={pName}
                                onChange={(e) => setPName(e.target.value)}
                                maxLength={120}
                              />
                            </label>
                            <label>
                              Description
                              <textarea
                                value={pDesc}
                                onChange={(e) => setPDesc(e.target.value)}
                                maxLength={500}
                                rows={3}
                              />
                            </label>
                            <button
                              className="button button-primary"
                              disabled={
                                savingSettings ||
                                (pName.trim() === detail.project.name &&
                                  pDesc.trim() === detail.project.description)
                              }
                            >
                              {savingSettings ? <Spinner /> : "Save"}
                            </button>
                          </form>
                        </section>

                        <section className="settings-section danger-zone">
                          <div className="settings-section-head">
                            <h3>Danger zone</h3>
                          </div>
                          <div className="danger-row">
                            <div>
                              <strong>Transfer ownership</strong>
                              <p>Pick an active member to make them the owner. You become a member.</p>
                            </div>
                            <div className="danger-transfer">
                              {ownerMembers.filter((m) => m.status === "active").length === 0 ? (
                                <span className="muted-note">No active members to transfer to.</span>
                              ) : (
                                ownerMembers
                                  .filter((m) => m.status === "active")
                                  .map((m) => (
                                    <button
                                      key={m.id}
                                      className="button button-ghost"
                                      disabled={busy || isArchived}
                                      onClick={() => {
                                        setTransferConfirm("");
                                        setTransferTo(m);
                                      }}
                                    >
                                      Make {m.name} owner
                                    </button>
                                  ))
                              )}
                            </div>
                          </div>
                          <div className="danger-row">
                            <div>
                              <strong>{isArchived ? "Unarchive" : "Archive"} project</strong>
                              <p>
                                {isArchived
                                  ? "Restore editing, agents, and commit approvals."
                                  : "Freeze the project — everyone read-only, agents stopped."}
                              </p>
                            </div>
                            <button
                              className="button button-ghost"
                              disabled={busy}
                              onClick={() => void setArchived(!isArchived)}
                            >
                              {busy ? <Spinner /> : isArchived ? "Unarchive" : "Archive"}
                            </button>
                          </div>
                          <div className="danger-row">
                            <div>
                              <strong>Delete project</strong>
                              <p>Workspaces are archived; all project history is removed.</p>
                            </div>
                            <button
                              className="button button-danger"
                              disabled={busy}
                              onClick={() => void deleteProject()}
                            >
                              {busy ? <Spinner /> : "Delete"}
                            </button>
                          </div>
                        </section>
                      </>
                    )}

                    {teamSection === "danger" && !isOwner && (
                      <section className="settings-section danger-zone">
                        <div className="settings-section-head">
                          <h3>Membership</h3>
                        </div>
                        <div className="danger-row">
                          <div>
                            <strong>Leave project</strong>
                            <p>Your child agent and workspace are archived.</p>
                          </div>
                          <button
                            className="button button-danger"
                            disabled={busy}
                            onClick={() => void leaveProject()}
                          >
                            {busy ? <Spinner /> : "Leave"}
                          </button>
                        </div>
                      </section>
                    )}
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

      {transferTo && detail && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            setTransferTo(null);
            setTransferConfirm("");
          }}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Transfer ownership</span>
                <h2>Make {transferTo.name} the owner</h2>
                <p>
                  {transferTo.name} will control the parent agent and this page. You become a member
                  with a fresh child-agent workspace. Type <strong>{detail.project.name}</strong> to
                  confirm.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setTransferTo(null);
                  setTransferConfirm("");
                }}
              >
                ×
              </button>
            </div>
            <label>
              Project name
              <input
                autoFocus
                value={transferConfirm}
                onChange={(e) => setTransferConfirm(e.target.value)}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  setTransferTo(null);
                  setTransferConfirm("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-danger"
                disabled={busy || transferConfirm.trim() !== detail.project.name}
                onClick={() => void doTransfer()}
              >
                {busy ? <Spinner /> : "Transfer"}
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
  isYou = false,
  readOnly = false,
  onSaveRole,
  onRemove,
  onTransfer,
}: {
  member: ProjectMemberView;
  isYou?: boolean;
  readOnly?: boolean;
  onSaveRole: (role: string) => void;
  onRemove: () => void;
  onTransfer?: () => void;
}) {
  const [role, setRole] = useState(member.role);
  const [menuOpen, setMenuOpen] = useState(false);
  const analysis = member.securityAnalysis;
  const invited = member.status === "invited";
  return (
    <article className={"member-row" + (invited ? " member-invited" : "")}>
      <div
        className="member-avatar"
        style={{ background: `hsl(${avatarHue(member.name)} 55% 42%)` }}
      >
        {initials(member.name)}
      </div>
      <div className="member-copy">
        <div className="member-name-row">
          <strong>{member.name}</strong>
          <span className="role-badge role-member">{member.role}</span>
          {invited && <span className="member-tag">pending</span>}
          {isYou && <span className="member-you">you</span>}
        </div>

        {!invited && (
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
          </div>
        )}

        <span className="member-sec">
          {invited
            ? "Invited by " + member.invitedByName + " · not joined yet"
            : "Joined " + formatTime(member.createdAt) +
              " · invited by " + member.invitedByName +
              (member.pendingCommits > 0
                ? " · " + member.pendingCommits + " pending request" +
                  (member.pendingCommits === 1 ? "" : "s")
                : "")}
        </span>
        {analysis && !invited && (
          <span className="member-sec">
            OWASP analysis: {analysis.passed ? "passed" : owaspFailCount(analysis) + " failed"} ·{" "}
            {formatTime(analysis.ranAt)}
          </span>
        )}
      </div>

      <div className="member-menu">
        <button
          type="button"
          className="member-menu-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Member actions"
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="member-menu-pop" onMouseLeave={() => setMenuOpen(false)}>
            {onTransfer && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onTransfer();
                }}
              >
                Transfer ownership
              </button>
            )}
            <button
              type="button"
              className="member-menu-danger"
              disabled={readOnly}
              onClick={() => {
                setMenuOpen(false);
                onRemove();
              }}
            >
              {invited ? "Revoke invite" : "Remove"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

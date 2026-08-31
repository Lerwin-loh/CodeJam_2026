import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { branchPointSettingsTabs, type BranchPointSettingsTabKey } from "./branchPointSettingsContent";
import { MergeReview } from "./MergeReview";
import { traceEventDescription, traceEventLabel } from "./tracePresentation";
import { WorkspaceOutput } from "./WorkspaceOutput";
import type {
  Agent,
  AgentBranch,
  AgentCheckpoint,
  AgentRun,
  CheckpointDetails,
  CheckpointDiff,
  Message,
  SystemInfo,
  TraceEvent,
  User,
  MergePreview,
  WorkspacePreview,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function StandaloneLivePreview({
  agentId,
  agentName,
  activeBranchId,
  branches,
  workspacePreview,
  previewReload,
  previewError,
  previewExpanded,
  onBranchChange,
  onRefresh,
  onError,
  onExpand,
  onClose,
}: {
  agentId: string;
  agentName: string;
  activeBranchId: string | null;
  branches: AgentBranch[];
  workspacePreview: WorkspacePreview | null;
  previewReload: number;
  previewError: boolean;
  previewExpanded: boolean;
  onBranchChange: (branchId: string | null) => void;
  onRefresh: () => void;
  onError: () => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const previewUrl = workspacePreview?.entryFile
    ? api.previewUrl(agentId, workspacePreview.entryFile, activeBranchId) + "&v=" + previewReload
    : null;
  const sourceKey = [agentId, activeBranchId ?? "main", workspacePreview?.entryFile ?? "none", workspacePreview?.workspaceHash ?? "none"].join(":");
  const controls = (
    <div className="live-preview-actions">
      {branches.length > 0 && (
        <select className="preview-branch-select" value={activeBranchId ?? "main"} onChange={(event) => onBranchChange(event.target.value === "main" ? null : event.target.value)} aria-label="Preview workspace">
          <option value="main">Main workspace</option>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      )}
      <button className="button button-ghost" type="button" onClick={onRefresh}>Refresh</button>
      <button className="button button-ghost preview-expand-button" type="button" onClick={onExpand} aria-label="Expand website preview">⛶ <span>Expand</span></button>
    </div>
  );
  const body = workspacePreview?.available && previewUrl && !previewError
    ? <iframe key={sourceKey + ":" + previewReload} className="live-preview-frame" title="Generated website preview" src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms" onError={onError} />
    : <div className="live-preview-empty"><strong>{previewError ? "Preview could not be loaded" : "No website preview yet"}</strong><span>{previewError ? "Refresh the preview or ask the Agent to check the website entry file." : "Ask the Agent to create a website. The preview automatically discovers HTML pages and built web apps."}</span></div>;

  return (
    <>
      {!previewExpanded && (
        <section className="live-preview-card" aria-label="Live website preview">
          <div className="live-preview-heading">
            <div><span className="eyebrow">Workspace output</span><h2>Live website preview</h2></div>
            {workspacePreview?.available && controls}
          </div>
          {body}
        </section>
      )}
      {previewExpanded && workspacePreview?.available && previewUrl && !previewError && (
        <div className="preview-expanded-backdrop" role="dialog" aria-modal="true" aria-label="Expanded website preview">
          <section className="preview-expanded-panel">
            <header className="preview-expanded-heading">
              <div><span className="eyebrow">Workspace output</span><h2>{agentName} · Live preview</h2></div>
              <div className="live-preview-actions">
                {branches.length > 0 && (
                  <select className="preview-branch-select" value={activeBranchId ?? "main"} onChange={(event) => { onClose(); onBranchChange(event.target.value === "main" ? null : event.target.value); }} aria-label="Preview workspace">
                    <option value="main">Main workspace</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </select>
                )}
                <button className="button button-ghost" type="button" onClick={onRefresh}>Refresh</button>
                <button className="button button-ghost" type="button" onClick={onClose} aria-label="Close expanded website preview">× Close</button>
              </div>
            </header>
            <iframe key={sourceKey + ":" + previewReload + ":expanded"} className="live-preview-frame live-preview-frame-expanded" title="Expanded generated website preview" src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms" onError={() => { onError(); onClose(); }} />
          </section>
        </div>
      )}
    </>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

interface Props {
  currentUser: User;
  onProjectUpgraded: (projectId: string) => void;
  onSignOut: () => void;
  onDeleteAccount: () => Promise<void>;
  onToggleMode: () => void;
}

/** Flat, single-Agent-list dashboard — the default "individual" mode of the app. */
export default function IndividualDashboard({ currentUser, onProjectUpgraded, onSignOut, onDeleteAccount, onToggleMode }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [branches, setBranches] = useState<AgentBranch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeProjectName, setUpgradeProjectName] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBranchPoint, setShowBranchPoint] = useState(false);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [showBranchPointSettings, setShowBranchPointSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<BranchPointSettingsTabKey>("trace");
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [activeBranchPointView, setActiveBranchPointView] = useState<"history" | "branches">("history");
  const [expandedBranchPointView, setExpandedBranchPointView] = useState<string | null>("history");
  const [checkpointOverlay, setCheckpointOverlay] = useState<{
    kind: "diff" | "details" | "unavailable";
    checkpoint: AgentCheckpoint;
    details?: CheckpointDetails;
    diff?: CheckpointDiff;
  } | null>(null);
  const [showCodeChanges, setShowCodeChanges] = useState(false);
  const [runOverlay, setRunOverlay] = useState<import("./types").RunDetails | null>(null);
  const [restoreResult, setRestoreResult] = useState<{
    recoveryPath: string;
    activePath: string;
    hash: string;
  } | null>(null);
  const [checkpointLabel, setCheckpointLabel] = useState("");
  const [savingCheckpoint, setSavingCheckpoint] = useState(false);
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [workspacePreview, setWorkspacePreview] = useState<WorkspacePreview | null>(null);
  const [previewReload, setPreviewReload] = useState(0);
  const [previewError, setPreviewError] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [exportingProject, setExportingProject] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const activeBranchIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const traceStreamControllers = useRef(new Map<string, AbortController>());
  selectedIdRef.current = selectedId;
  activeBranchIdRef.current = activeBranchId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const historyItems = useMemo(
    () => [
      ...checkpoints.map((checkpoint) => ({ kind: "checkpoint" as const, createdAt: checkpoint.createdAt, checkpoint })),
      ...runs
        .filter((run) => run.checkpointId === null)
        .map((run) => ({ kind: "run" as const, createdAt: run.createdAt, run })),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [checkpoints, runs],
  );

  const branchGraphRows = useMemo(() => {
    const ordered = [...branches].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const depthById = new Map<string, number>();
    const getDepth = (branch: AgentBranch): number => {
      const cached = depthById.get(branch.id);
      if (cached !== undefined) return cached;
      const parent = branch.parentBranchId ? ordered.find((item) => item.id === branch.parentBranchId) : null;
      const depth = parent ? Math.min(getDepth(parent) + 1, 3) : 1;
      depthById.set(branch.id, depth);
      return depth;
    };
    return ordered.map((branch) => ({ branch, depth: getDepth(branch) }));
  }, [branches]);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string, branchId: string | null = activeBranchId) => {
    const result = await api.messages(agentId, branchId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, [activeBranchId]);

  const refreshBranchPoint = useCallback(async (agentId: string) => {
    const [checkpointResult, traceResult, branchResult] = await Promise.all([
      api.checkpoints(agentId, activeBranchId),
      api.trace(agentId, activeBranchId),
      api.branches(agentId),
    ]);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setCheckpoints(checkpointResult.checkpoints);
      setTraceEvents(traceResult.events);
      setBranches(branchResult.branches);
    }
  }, [activeBranchId]);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  const appendTraceEvent = useCallback((event: TraceEvent) => {
    if (selectedIdRef.current !== event.agentId || event.branchId !== activeBranchId) return;
    setTraceEvents((current) => current.some((item) => item.id === event.id)
      ? current
      : [...current, event].sort((left, right) => left.timestamp.localeCompare(right.timestamp)));
  }, [activeBranchId]);

  const streamRunTrace = useCallback((runId: string) => {
    traceStreamControllers.current.get(runId)?.abort();
    const controller = new AbortController();
    traceStreamControllers.current.set(runId, controller);
    void api.streamRunTrace(runId, appendTraceEvent, controller.signal)
      .catch((reason) => {
        if (!controller.signal.aborted && mountedRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (traceStreamControllers.current.get(runId) === controller) {
          traceStreamControllers.current.delete(runId);
        }
      });
  }, [appendTraceEvent]);

  useEffect(() => {
    mountedRef.current = true;
    void bootstrap();
    return () => {
      mountedRef.current = false;
      for (const controller of traceStreamControllers.current.values()) controller.abort();
      traceStreamControllers.current.clear();
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setSelectedCheckpointId(null);
    setRuns([]);
    setBranches([]);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    setCheckpoints([]);
    setTraceEvents([]);
    void Promise.all([refreshMessages(selectedId), refreshBranchPoint(selectedId), api.runs(selectedId, activeBranchId)])
      .then(([, , result]) => {
        if (selectedIdRef.current !== selectedId || activeBranchIdRef.current !== activeBranchId) return;
        setRuns(result.runs);
        // A branch inherits historical runs, but only its own runs can be
        // active in this workspace. Never show a parent's in-flight run here.
        const latest = activeBranchId
          ? result.runs.find((run) => run.branchId === activeBranchId) ?? null
          : result.runs.find((run) => run.branchId === null) ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          streamRunTrace(latest.id);
          void pollRun(latest.id, selectedId, activeBranchId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [activeBranchId, refreshBranchPoint, refreshMessages, selectedId, streamRunTrace]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    setWorkspacePreview(null);
    setPreviewError(false);
    setPreviewExpanded(false);
    if (!selectedId) return;
    let cancelled = false;
    void api.previewStatus(selectedId, activeBranchId)
      .then(({ preview }) => {
        if (!cancelled) setWorkspacePreview(preview);
      })
      .catch(() => {
        if (!cancelled) setWorkspacePreview({ available: false, entryFile: null, workspaceHash: null });
      });
    return () => { cancelled = true; };
  }, [selectedId, activeBranchId, activeRun?.status]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const upgradeAgentToProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !upgradeProjectName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.upgradeAgentToProject(selected.id, upgradeProjectName.trim());
      setShowUpgrade(false);
      onProjectUpgraded(project.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const downloadProject = async () => {
    if (!selected || exportingProject) return;
    setExportingProject(true);
    setError(null);
    try {
      const blob = await api.exportProject(selected.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = selected.name.replace(/[^a-z0-9._-]+/gi, "-") + ".zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExportingProject(false);
    }
  };

  const refreshPreview = () => {
    setPreviewError(false);
    setPreviewReload((value) => value + 1);
  };

  const pollRun = async (runId: string, agentId: string, branchId: string | null) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (
          selectedIdRef.current === agentId &&
          activeBranchIdRef.current === branchId &&
          result.run.branchId === branchId
        ) {
          setActiveRun(result.run);
        }
        if (!["queued", "running"].includes(result.run.status)) {
          if (selectedIdRef.current === agentId && activeBranchIdRef.current === branchId) {
            const [, , , runResult] = await Promise.all([refreshMessages(agentId), refreshAgents(), refreshBranchPoint(agentId), api.runs(agentId, branchId)]);
            setRuns(runResult.runs);
          }
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const branchIdAtSend = activeBranchId;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content, activeBranchId);
      if (selectedIdRef.current === selected.id && activeBranchIdRef.current === branchIdAtSend) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        streamRunTrace(result.run.id);
      }
      await pollRun(result.run.id, selected.id, branchIdAtSend);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (selectedIdRef.current === selected.id && activeBranchIdRef.current === branchIdAtSend) {
        setActiveRun(null);
      }
      await refreshAgents();
    }
  };

  const saveCheckpoint = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !checkpointLabel.trim() || savingCheckpoint) return;
    setSavingCheckpoint(true);
    setError(null);
    try {
      await api.createCheckpoint(selected.id, checkpointLabel.trim());
      setCheckpointLabel("");
      await refreshBranchPoint(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingCheckpoint(false);
    }
  };

  const openCheckpointAction = async (kind: "diff" | "details", checkpoint: AgentCheckpoint) => {
    setError(null);
    try {
      if (kind === "diff") {
        const { diff } = await api.checkpointDiff(checkpoint.id);
        setShowCodeChanges(false);
        setCheckpointOverlay({ kind, checkpoint, diff });
      } else {
        const details = await api.checkpointDetails(checkpoint.id);
        setCheckpointOverlay({ kind, checkpoint, details });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openRunDetails = async (run: AgentRun) => {
    setError(null);
    setRunOverlay({
      run,
      trace: traceEvents.filter((event) => event.runId === run.id),
    });
    try {
      setRunOverlay(await api.runDetails(run.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const restoreCheckpoint = async (checkpoint: AgentCheckpoint) => {
    if (!selected) return;
    const confirmed = window.confirm(
      "Restore this checkpoint into the active workspace? This will replace the current workspace state with the saved snapshot.",
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.restoreCheckpoint(checkpoint.id);
      setRestoreResult({
        recoveryPath: result.workspacePath,
        activePath: result.activeWorkspacePath,
        hash: result.workspaceHash,
      });
      setCheckpointOverlay(null);
      setSelectedCheckpointId(null);
      setError("Workspace restored to checkpoint " + checkpoint.id.slice(0, 8));
      await Promise.all([refreshMessages(selected.id), refreshBranchPoint(selected.id), api.runs(selected.id)]).then(([, , runResult]) => {
        setRuns(runResult.runs);
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createBranchFromCheckpoint = async (checkpoint: AgentCheckpoint) => {
    if (!selected) return;
    const name = window.prompt("Branch name", "experiment");
    if (!name?.trim()) return;
    setError(null);
    try {
      const { branch } = await api.createBranch(selected.id, checkpoint.id, name.trim());
      setBranches((current) => [branch, ...current]);
      setActiveBranchId(branch.id);
      setSelectedCheckpointId(null);
      setActiveBranchPointView("history");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openBranchMerge = async (branch: AgentBranch) => {
    if (!selected) return;
    setMergeBusy(true); setError(null);
    try { setMergePreview(await api.mergePreview(selected.id, branch.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mountedRef.current) setMergeBusy(false); }
  };

  const applyBranchMerge = async (branch: AgentBranch, resolution: { workspace: Record<string, "target" | "source" | "ai" | "combined">; context: Record<string, "target" | "source" | "ai" | "combined">; combined?: Record<string, import("./types").MergeCombinedDecision> }) => {
    if (!selected) return;
    setMergeBusy(true); setError(null);
    try {
      await api.merge(selected.id, branch.id, resolution);
      setMergePreview(null); setActiveBranchId(null);
      await Promise.all([refreshMessages(selected.id, null), refreshBranchPoint(selected.id)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mountedRef.current) setMergeBusy(false); }
  };

  const deleteBranch = async (branch: AgentBranch) => {
    if (!selected) return;
    const confirmed = window.confirm(
      `Delete branch "${branch.name}"? Its workspace will be archived for recovery, but its branch history will be removed.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteBranch(selected.id, branch.id);
      setBranches((current) => current.filter((item) => item.id !== branch.id));
      setActiveBranchId((current) => (current === branch.id ? null : current));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = () => {
    setAgents([]);
    setSelectedId(null);
    setMessages([]);
    setRuns([]);
    setCheckpoints([]);
    setTraceEvents([]);
    setShowBranchPoint(false);
    onSignOut();
  };

  const handleDeleteAccount = async () => {
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
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div className={"app-shell " + (showBranchPoint && !showBranchPointSettings ? "branchpoint-open" : "")}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
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
              Project mode
            </button>
            <button className="button button-ghost" onClick={handleSignOut}>
              Switch
            </button>
          </div>
          <div className="user-card-danger-row">
            <button className="button button-danger" disabled={busy} onClick={() => void handleDeleteAccount()}>
              Delete account
            </button>
          </div>
        </div>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className={"button " + (showBranchPoint ? "button-primary" : "button-ghost")}
                  onClick={() => {
                    const opening = !showBranchPoint;
                    setShowBranchPoint(opening);
                    if (opening) {
                      setActiveBranchPointView("history");
                      setExpandedBranchPointView("history");
                    }
                  }}
                  aria-expanded={showBranchPoint}
                  aria-controls="branchpoint-panel"
                >
                  BranchPoint
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => void downloadProject()}
                  disabled={busy || exportingProject}
                >
                  {exportingProject ? "Preparing..." : "Download ZIP"}
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => {
                    setUpgradeProjectName(selected.name);
                    setShowUpgrade(true);
                  }}
                  disabled={busy || selected.status === "busy"}
                >
                  Upgrade to project
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <div className="workspace-main-column">
            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.kind === "merge" ? "Merge history" : message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      {message.kind === "merge" ? (
                        <div className="message-body merge-history-event">
                          <strong>{message.content}</strong>
                          {message.mergeProvenance?.map((item) => (
                            <div className="merge-history-provenance" key={item.id}>
                              <b>{item.paths.join(", ")}</b>
                              <div className="merge-provenance-columns">
                                <div><b>Target prompts</b>{item.targetPrompts.map((commit) => <p key={commit.id}>{commit.prompt}</p>)}</div>
                                <div><b>Source prompts</b>{item.sourcePrompts.map((commit) => <p key={commit.id}>{commit.prompt}</p>)}</div>
                              </div>
                              <small>Merge instruction: {item.mergePrompt}</small>
                              <small>{item.explanation}</small>
                            </div>
                          ))}
                        </div>
                      ) : <div className="message-body">{message.content}</div>}
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && traceEvents.some((event) => event.runId === activeRun.id) && (
                  <section className="live-trace live-trace-chat" aria-live="polite">
                    <div className="live-trace-heading">
                      <div>
                        <span className="eyebrow">Live trace</span>
                        <strong>{activeRun.status === "running" || activeRun.status === "queued" ? "Run in progress" : "Latest Run"}</strong>
                      </div>
                      {(activeRun.status === "running" || activeRun.status === "queued") && <span className="live-indicator"><span /> Streaming</span>}
                    </div>
                    <div className="live-trace-list">
                      {traceEvents.filter((event) => event.runId === activeRun.id).slice(-8).map((event) => {
                        return <div className="live-trace-event" key={event.id}>
                          <span className="trace-event-dot" />
                          <div><strong>{traceEventLabel(event)}</strong><small>{formatTime(event.timestamp)}</small></div>
                          <p>{traceEventDescription(event)}</p>
                        </div>;
                      })}
                    </div>
                  </section>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
              </section>
              <WorkspaceOutput
                agentId={selected.id}
                agentName={selected.name}
                activeBranchId={activeBranchId}
                branches={branches}
                workspacePreview={workspacePreview}
                previewReload={previewReload}
                previewError={previewError}
                previewExpanded={previewExpanded}
                onBranchChange={(branchId) => { setPreviewError(false); setActiveBranchId(branchId); }}
                onRefresh={refreshPreview}
                onError={() => setPreviewError(true)}
                onExpand={() => setPreviewExpanded(true)}
                onClose={() => setPreviewExpanded(false)}
              />
            </div>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showBranchPoint && !showBranchPointSettings && (
        <aside className="branchpoint-panel" id="branchpoint-panel">
          <>
          <div className="branchpoint-heading">
            <div>
              <span className="eyebrow">BranchPoint · Beta</span>
              <h2>Execution history</h2>
            </div>
            <div className="panel-heading-actions">
              <button
                className="settings-button"
                onClick={() => setShowBranchPointSettings(true)}
                aria-expanded={showBranchPointSettings}
                aria-label="Open BranchPoint settings"
                title="BranchPoint settings"
              >
                Settings
              </button>
              <button
                className="panel-close"
                onClick={() => setShowBranchPoint(false)}
                aria-label="Close BranchPoint panel"
              >
                ×
              </button>
            </div>
          </div>

          <div className="branchpoint-context">
            <div><span>Agent</span><strong>{selected?.name ?? "No Agent selected"}</strong></div>
            <div><span>Active branch</span><strong>{branches.find((branch) => branch.id === activeBranchId)?.name ?? "main"}</strong></div>
            <div><span>Checkpoints saved</span><strong>{checkpoints.length}</strong></div>
          </div>

          <nav className="branchpoint-tabs" aria-label="BranchPoint views">
            {(["history", "branches"] as const).map((view) => (
              <button
                className={activeBranchPointView === view ? "active" : ""}
                key={view}
                onClick={() => {
                  setActiveBranchPointView(view);
                  setExpandedBranchPointView(view);
                }}
              >
                {view[0].toUpperCase() + view.slice(1)}
              </button>
            ))}
          </nav>


          <div className="branchpoint-view">
            <button
              className="view-collapse"
              onClick={() => setExpandedBranchPointView((current) => current === activeBranchPointView ? null : activeBranchPointView)}
              aria-expanded={expandedBranchPointView === activeBranchPointView}
            >
              <span>{activeBranchPointView === "history" ? "Execution history" : "Branch workspaces"}</span>
              <span>{expandedBranchPointView === activeBranchPointView ? "−" : "+"}</span>
            </button>
            {expandedBranchPointView === activeBranchPointView && activeBranchPointView === "history" && (
              <>
              <form className="checkpoint-create" onSubmit={saveCheckpoint}>
                <input
                  value={checkpointLabel}
                  onChange={(event) => setCheckpointLabel(event.target.value)}
                  placeholder="Name a checkpoint for the current workspace…"
                  maxLength={120}
                  disabled={
                    !selected ||
                    selected.status === "busy" ||
                    savingCheckpoint ||
                    runs.length === 0
                  }
                />
                <button
                  className="button button-primary"
                  disabled={
                    !selected ||
                    selected.status === "busy" ||
                    savingCheckpoint ||
                    !checkpointLabel.trim() ||
                    runs.length === 0
                  }
                >
                  {savingCheckpoint ? <Spinner /> : "Save checkpoint"}
                </button>
              </form>
              {selected && runs.length === 0 && (
                <p className="checkpoint-create-hint">
                  Send this Agent an instruction first — a checkpoint snapshots the workspace a run produces.
                </p>
              )}
              <div className={"checkpoint-list " + (historyItems.length === 0 ? "is-empty" : "")}>

                {historyItems.map((item) => {
              if (item.kind === "run") {
                return (
                  <button type="button" className="run-history-entry" key={item.run.id} onClick={() => void openRunDetails(item.run)}>
                    <span className="run-history-marker" />
                    <div className="run-history-copy">
                      <strong>Run event · Immutable <em>{item.run.status === "completed" ? "Completed" : item.run.status}</em></strong>
                      <span>{formatTime(item.run.createdAt)} · Run {item.run.id.slice(0, 8)}</span>
                      <p>{item.run.prompt}</p>
                      <small>View details →</small>
                    </div>
                  </button>
                );
              }
              const checkpoint = item.checkpoint;
              const isSelected = checkpoint.id === selectedCheckpointId;
              const changedCount = checkpoint.changedFiles.created.length + checkpoint.changedFiles.modified.length + checkpoint.changedFiles.deleted.length;
              return (
                <div
                  className={"checkpoint " + (isSelected ? "selected" : "")}
                  key={checkpoint.id}
                >
                  <button
                    className="checkpoint-summary"
                    onClick={() => setSelectedCheckpointId((current) => current === checkpoint.id ? null : checkpoint.id)}
                    aria-expanded={isSelected}
                  >
                    <span className="checkpoint-marker" />
                    <span className="checkpoint-copy">
                      <strong>
                        {checkpoint.label ?? "Checkpoint event · Recoverable"}
                        <em>{checkpoint.reason === "explicit" ? "Named checkpoint" : checkpoint.status === "partial" ? "Partial Run state" : "Workspace mutation"}</em>
                      </strong>
                      <span>{formatTime(checkpoint.createdAt)}</span>
                      <span>Run {checkpoint.runId.slice(0, 8)} · {checkpoint.reason === "auto-mutation" ? "Automatic" : "Explicit"}</span>
                    </span>
                    <small>{changedCount} file{changedCount === 1 ? "" : "s"}</small>
                  </button>
                  {isSelected && (
                    <div className="checkpoint-actions">
                      <div className="checkpoint-files">
                        {[...checkpoint.changedFiles.created, ...checkpoint.changedFiles.modified, ...checkpoint.changedFiles.deleted].map((file) => <code key={file}>{file}</code>)}
                      </div>
                      <div className="checkpoint-buttons">
                        <button className="button button-primary" type="button" onClick={() => void createBranchFromCheckpoint(checkpoint)}>Branch from here</button>
                        <button className="button button-ghost" type="button" onClick={() => void restoreCheckpoint(checkpoint)}>Restore workspace</button>
                        <button className="button button-ghost" type="button" onClick={() => void openCheckpointAction("diff", checkpoint)}>View diff</button>
                        <button className="button button-ghost" type="button" onClick={() => void openCheckpointAction("details", checkpoint)}>View details</button>
                      </div>
                    </div>
                  )}
                </div>
              );
                })}
                {historyItems.length === 0 && (
                  <div className="empty-branchpoint-view">
                    No Runs yet. Agent execution history will appear here after the first prompt.
                  </div>
                )}
              </div>
              </>
            )}
            {expandedBranchPointView === activeBranchPointView && activeBranchPointView === "branches" && (
              branches.length > 0 ? <>
                <div className="branch-graph" aria-label="Branch graph">
                  <div className="branch-graph-heading"><span>Branch graph</span><small>Execution lineage</small></div>
                  <div className="branch-graph-canvas">
                    <button className={"branch-graph-row " + (!activeBranchId ? "active" : "")} type="button" onClick={() => { setActiveBranchId(null); setActiveBranchPointView("history"); }}>
                      <span className="branch-graph-lane" style={{ "--branch-depth": 0 } as React.CSSProperties}><span className="branch-graph-node" /></span>
                      <span className="branch-graph-label"><strong>main</strong><small>Original workspace</small></span>
                    </button>
                    {branchGraphRows.map(({ branch, depth }) => (
                      <button className={"branch-graph-row " + (branch.id === activeBranchId ? "active" : "")} type="button" key={branch.id} onClick={() => { setActiveBranchId(branch.id); setActiveBranchPointView("history"); }}>
                        <span className="branch-graph-lane" style={{ "--branch-depth": depth } as React.CSSProperties}><span className="branch-graph-node" /></span>
                        <span className="branch-graph-label"><strong>{branch.name}</strong><small>{branch.status} · from {branch.parentCheckpointId?.slice(0, 8)}</small></span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="branch-list">
                  {branches.map((branch) => (
                    <div className="branch-card-row" key={branch.id}>
                      <div className={"branch-card " + (branch.id === activeBranchId ? "active" : "")}>
                        <button className="branch-card-select" type="button" onClick={() => { setActiveBranchId(branch.id); setActiveBranchPointView("history"); }}>
                          <span className="branch-card-icon">⑂</span>
                          <span><strong>{branch.name}</strong><small>{branch.status} · from checkpoint {branch.parentCheckpointId?.slice(0, 8)}</small></span>
                        </button>
                        <button
                          className="branch-delete-button"
                          type="button"
                          disabled={busy || branch.status === "busy"}
                          title={branch.status === "busy" ? "Stop the branch run before deleting it" : "Delete branch"}
                          aria-label={`Delete branch ${branch.name}`}
                          onClick={() => void deleteBranch(branch)}
                        >
                          Delete
                        </button>
                      </div>
                      <button className="button button-ghost" type="button" disabled={busy || branch.status === "busy"} onClick={() => void openBranchMerge(branch)}>Merge</button>
                    </div>
                  ))}
                </div>
              </> : <div className="branchpoint-empty-state">
                <span className="branchpoint-empty-icon">⑂</span>
                <strong>No branch workspaces yet</strong>
                <p>Choose “Branch from here” on a Checkpoint event to create an independent workspace.</p>
              </div>
            )}
          </div>
          </>
        </aside>
      )}

      {showBranchPointSettings && (() => {
        const activeTab = branchPointSettingsTabs.find((tab) => tab.key === settingsTab) ?? branchPointSettingsTabs[0];
        return (
          <div className="branchpoint-settings-overlay" onMouseDown={() => setShowBranchPointSettings(false)}>
            <aside className="branchpoint-settings-panel" onMouseDown={(event) => event.stopPropagation()}>
              <div className="settings-panel-heading">
                <div>
                  <span className="eyebrow">BranchPoint · Beta</span>
                  <h2>BranchPoint</h2>
                  <p>Understand how execution is tracked, versioned, recovered, and security-checked across runs, checkpoints, and branches.</p>
                </div>
                <button className="panel-close" type="button" onClick={() => setShowBranchPointSettings(false)} aria-label="Close BranchPoint settings">×</button>
              </div>

              <section className="how-it-works">
                <button
                  className="how-it-works-toggle"
                  type="button"
                  onClick={() => setHowItWorksOpen((value) => !value)}
                  aria-expanded={howItWorksOpen}
                >
                  <span>How it works?</span>
                  <span>{howItWorksOpen ? "⌃" : "›"}</span>
                </button>
                {howItWorksOpen && (
                  <div className="how-it-works-body">
                    <nav className="settings-main-tabs" aria-label="Settings sections">
                      {branchPointSettingsTabs.map((tab) => (
                        <button
                          key={tab.key}
                          className={settingsTab === tab.key ? "active" : ""}
                          type="button"
                          onClick={() => setSettingsTab(tab.key)}
                        >
                          <span>{tab.icon}</span>
                          {tab.label}
                        </button>
                      ))}
                    </nav>
                    <div className="settings-main-body">
                      <div className="settings-main-heading">
                        <div>
                          <h1>{activeTab.title}</h1>
                          <p>{activeTab.subtitle}</p>
                        </div>
                      </div>
                      <div className="settings-callout">{activeTab.intro}</div>
                      <section>
                        <h3>{activeTab.recordedHeading}</h3>
                        <p>{activeTab.recordedDescription}</p>
                        <div className="settings-badge-grid">
                          {activeTab.recordedItems.map((item) => (
                            <div className="settings-badge-card" key={item.label}>
                              <span>{item.icon}</span>
                              <strong>{item.label}</strong>
                              <small>{item.caption}</small>
                            </div>
                          ))}
                        </div>
                      </section>
                      <section>
                        <h3>How it's stored</h3>
                        <p>{activeTab.storedText}</p>
                      </section>
                      <section>
                        <h3>Why it matters</h3>
                        <div className="settings-why-grid">
                          {activeTab.whyItems.map((item) => (
                            <div className="settings-why-card" key={item.title}>
                              <span>{item.icon}</span>
                              <strong>{item.title}</strong>
                              <small>{item.caption}</small>
                            </div>
                          ))}
                        </div>
                      </section>
                      <div className="settings-summary">
                        <span>✦</span>
                        <p><strong>In short: </strong>{activeTab.summary}</p>
                      </div>
                      <div className="settings-tip">
                        <span className="settings-tip-icon">💡</span>
                        <div>
                          <strong>Tip</strong>
                          <p>{activeTab.tip}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </aside>
          </div>
        );
      })()}

      {checkpointOverlay && (
        <div className="modal-backdrop" onMouseDown={() => setCheckpointOverlay(null)}>
          <section className="modal checkpoint-overlay" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Checkpoint inspection</span>
                <h2>{checkpointOverlay.kind === "diff" ? "Changes from previous checkpoint" : checkpointOverlay.kind === "details" ? "Checkpoint details" : "Branching is not available yet"}</h2>
              </div>
              <button type="button" onClick={() => setCheckpointOverlay(null)} aria-label="Close checkpoint inspection">×</button>
            </div>
            {checkpointOverlay.kind === "unavailable" && (
              <p className="inspection-message">Branch creation and restore will be enabled after independent workspace branching is implemented.</p>
            )}
            {checkpointOverlay.kind === "diff" && checkpointOverlay.diff && (
              <div className="inspection-section">
                <p className="inspection-message">Comparing this checkpoint with its immediate parent.</p>
                <div className="diff-summary">
                  {checkpointOverlay.diff.changedFiles.created.length > 0 && <p>Codex added {checkpointOverlay.diff.changedFiles.created.length} file{checkpointOverlay.diff.changedFiles.created.length === 1 ? "" : "s"} in this step.</p>}
                  {checkpointOverlay.diff.changedFiles.modified.length > 0 && <p>Codex updated {checkpointOverlay.diff.changedFiles.modified.length} existing file{checkpointOverlay.diff.changedFiles.modified.length === 1 ? "" : "s"}.</p>}
                  {checkpointOverlay.diff.changedFiles.deleted.length > 0 && <p>Codex removed {checkpointOverlay.diff.changedFiles.deleted.length} file{checkpointOverlay.diff.changedFiles.deleted.length === 1 ? "" : "s"}.</p>}
                  {!checkpointOverlay.diff.files.length && <p>No file content changed between these checkpoints.</p>}
                  <p className="inspection-muted">This summary is based on the workspace snapshot, not only the Agent's explanation.</p>
                </div>
                {(["created", "modified", "deleted"] as const).map((category) => (
                  <div className="diff-category" key={category}>
                    <h3>{category[0].toUpperCase() + category.slice(1)} files</h3>
                    <div className="diff-files">
                      {checkpointOverlay.diff?.changedFiles[category].length ? checkpointOverlay.diff.changedFiles[category].map((file) => <code className="inspection-file" key={file}>{file}</code>) : <p className="inspection-muted">None</p>}
                    </div>
                  </div>
                ))}
                {checkpointOverlay.diff.files.length > 0 && (
                  <>
                    <button className="code-toggle" type="button" onClick={() => setShowCodeChanges((value) => !value)} aria-expanded={showCodeChanges}>
                      {showCodeChanges ? "Hide code changes" : "View actual code changes"}
                    </button>
                    {showCodeChanges && <div className="code-change-list">{checkpointOverlay.diff.files.map((file) => <article key={file.path}><header><strong>{file.path}</strong><span>{file.status}</span></header>{file.hunks.map((hunk) => <div className="diff-hunk" key={hunk.oldStart + ":" + hunk.newStart}><code>@@ -{hunk.oldStart} +{hunk.newStart} @@</code><pre>{hunk.lines.map((line, index) => <span className={"diff-line diff-line-" + line.type} key={index}>{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}{line.content}{"\n"}</span>)}</pre></div>)}</article>)}</div>}
                  </>
                )}
              </div>
            )}
            {checkpointOverlay.kind === "details" && checkpointOverlay.details && (
              <div className="inspection-section">
                <p className="inspection-message">Run {checkpointOverlay.details.run.id.slice(0, 8)} · {checkpointOverlay.details.run.status} · {checkpointOverlay.details.checkpoint.status}</p>
                {checkpointOverlay.details.checkpoint.label && (
                  <>
                    <h3>Checkpoint name</h3>
                    <p className="inspection-copy">{checkpointOverlay.details.checkpoint.label} · {checkpointOverlay.details.checkpoint.reason === "explicit" ? "Saved by a user" : "Automatic"}</p>
                  </>
                )}
                <h3>Observable context</h3>
                <p className="inspection-muted">{checkpointOverlay.details.context.agentName} · {checkpointOverlay.details.context.instructions.length} instruction characters · source session {checkpointOverlay.details.context.sourceThreadId?.slice(0, 12) ?? "not available"}</p>
                <p className="inspection-disclaimer">This context snapshot includes the observable conversation accumulated through previous Runs and checkpoints. It does not include hidden model reasoning.</p>
                <h3>Run instruction</h3>
                <p className="inspection-copy">{checkpointOverlay.details.run.prompt}</p>
                {checkpointOverlay.details.run.output && <><h3>Agent result</h3><p className="inspection-copy">{checkpointOverlay.details.run.output}</p></>}
                <h3>Conversation snapshot</h3>
                <div className="inspection-conversation">{checkpointOverlay.details.context.messages.map((message) => <div key={message.id}><strong>{message.role}</strong><p>{message.content}</p></div>)}</div>
                <h3>Trace events</h3>
                <div className="inspection-trace">{checkpointOverlay.details.trace.map((event) => <div key={event.id}><header><strong>{traceEventLabel(event)}</strong><span>{formatTime(event.timestamp)}</span></header><p>{traceEventDescription(event)}</p></div>)}</div>
                <h3>Verification</h3>
                <p className="inspection-muted">Workspace hash: {checkpointOverlay.details.checkpoint.workspaceHash}</p>
              </div>
            )}
          </section>
        </div>
      )}

      {runOverlay && (
        <div className="modal-backdrop" onMouseDown={() => setRunOverlay(null)}>
          <section className="modal checkpoint-overlay" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">Immutable Run inspection</span><h2>Run execution trace</h2></div>
              <button type="button" onClick={() => setRunOverlay(null)} aria-label="Close Run inspection">×</button>
            </div>
            <div className="inspection-section">
              <p className="inspection-message">Run {runOverlay.run.id.slice(0, 8)} · {runOverlay.run.status} · This event cannot be reverted.</p>
              <h3>Prompt</h3><p className="inspection-copy">{runOverlay.run.prompt}</p>
              <h3>Trace events</h3>
              <div className="inspection-trace">{runOverlay.trace.map((event) => <div key={event.id}><header><strong>{traceEventLabel(event)}</strong><span>{formatTime(event.timestamp)}</span></header><p>{traceEventDescription(event)}</p></div>)}</div>
              {runOverlay.run.output && <><h3>Agent result</h3><p className="inspection-copy">{runOverlay.run.output}</p></>}
            </div>
          </section>
        </div>
      )}

      {restoreResult && (
        <div className="modal-backdrop" onMouseDown={() => setRestoreResult(null)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><div><span className="eyebrow">Checkpoint restored</span><h2>Workspace updated</h2></div><button type="button" onClick={() => setRestoreResult(null)} aria-label="Close restore result">×</button></div>
            <p className="inspection-message">The active workspace now matches the saved snapshot.</p>
            <label>Active workspace<input readOnly value={restoreResult.activePath} /></label>
            <label>Recovery copy<input readOnly value={restoreResult.recoveryPath} /></label>
            <p className="inspection-muted">Workspace hash: {restoreResult.hash}</p>
          </section>
        </div>
      )}

      {mergeBusy && !mergePreview && <div className="modal-backdrop merge-loading-backdrop"><section className="merge-loading-card" role="status" aria-live="polite"><span className="spinner" /><div><strong>Preparing merge review…</strong><p>Comparing outcomes, workspace files, and context prompts.</p></div></section></div>}
      {mergePreview && selected && <MergeReview preview={mergePreview} busy={mergeBusy} onCancel={() => setMergePreview(null)} onFixWithAi={() => { const branch = branches.find((item) => item.id === mergePreview.source.id); if (!branch) throw new Error("Branch not found"); return api.mergeAi(selected.id, branch.id); }} onMerge={(resolution) => { const branch = branches.find((item) => item.id === mergePreview.source.id); if (branch) void applyBranchMerge(branch, resolution); }} />}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showUpgrade && selected && (
        <div className="modal-backdrop" onMouseDown={() => !busy && setShowUpgrade(false)}>
          <form
            className="modal"
            onSubmit={upgradeAgentToProject}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Agent promotion</span>
                <h2>Upgrade to a project</h2>
                <p>
                  {selected.name} will become the project's parent Agent. Its files,
                  conversation, Codex session, checkpoints, and branches will be preserved.
                </p>
              </div>
              <button type="button" onClick={() => setShowUpgrade(false)} disabled={busy}>×</button>
            </div>
            <label>
              Project name
              <input
                autoFocus
                value={upgradeProjectName}
                onChange={(event) => setUpgradeProjectName(event.target.value)}
                required
                maxLength={120}
              />
            </label>
            <p className="inspection-muted">
              The Agent will move from Individual mode into Project mode. This upgrade cannot
              currently be reversed.
            </p>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowUpgrade(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || !upgradeProjectName.trim()}
              >
                {busy ? <Spinner /> : "Upgrade Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

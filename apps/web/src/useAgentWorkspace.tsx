import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { branchPointSettingsTabs, type BranchPointSettingsTabKey } from "./branchPointSettingsContent";
import type {
  AgentBranch,
  AgentCheckpoint,
  AgentRun,
  AgentStatus,
  CheckpointDetails,
  CheckpointDiff,
  Message,
  ParentAgentView,
  RunDetails,
  TraceEvent,
} from "./types";

const RUN_ACTIVE = ["queued", "running"];

function fmt(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/** A local, not-yet-persisted user message so the chat echoes it immediately. */
function optimistic(agentId: string, content: string): Message {
  return {
    id: "pending-" + Date.now(),
    agentId,
    runId: "",
    branchId: null,
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Drives one project agent's playground + BranchPoint drawer.
 *
 * `canManage` gates every mutating call. When it is false (a member looking at
 * the parent agent) the hook never touches `/api/agents/:id/*` — it hydrates
 * read-only from the `seed` bundle the project route already returned.
 */
export function useAgentWorkspace(
  agentId: string | null,
  canManage: boolean,
  seed: ParentAgentView | null,
  onDeleted?: () => void,
) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState<AgentStatus>("ready");

  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [branches, setBranches] = useState<AgentBranch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);

  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showBranchPoint, setShowBranchPoint] = useState(false);
  const [bpView, setBpView] = useState<"history" | "branches">("history");
  const [bpExpanded, setBpExpanded] = useState<string | null>("history");
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [showBpSettings, setShowBpSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<BranchPointSettingsTabKey>("trace");
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", instructions: "" });

  const [checkpointOverlay, setCheckpointOverlay] = useState<{
    kind: "diff" | "details";
    checkpoint: AgentCheckpoint;
    details?: CheckpointDetails;
    diff?: CheckpointDiff;
  } | null>(null);
  const [showCodeChanges, setShowCodeChanges] = useState(false);
  const [runOverlay, setRunOverlay] = useState<RunDetails | null>(null);
  const [restoreResult, setRestoreResult] = useState<{ path: string; hash: string } | null>(null);
  const [checkpointLabel, setCheckpointLabel] = useState("");
  const [savingCheckpoint, setSavingCheckpoint] = useState(false);

  const mounted = useRef(true);
  const agentIdRef = useRef<string | null>(null);
  const activeBranchIdRef = useRef<string | null>(null);
  const pollingRunIds = useRef(new Set<string>());
  const traceStreams = useRef(new Map<string, AbortController>());
  agentIdRef.current = agentId;
  activeBranchIdRef.current = activeBranchId;

  const fail = useCallback((reason: unknown) => {
    if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of traceStreams.current.values()) controller.abort();
      traceStreams.current.clear();
    };
  }, []);

  const appendTraceEvent = useCallback((event: TraceEvent) => {
    if (agentIdRef.current !== event.agentId || event.branchId !== activeBranchIdRef.current) return;
    setTraceEvents((current) =>
      current.some((item) => item.id === event.id)
        ? current
        : [...current, event].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    );
  }, []);

  const streamRunTrace = useCallback(
    (runId: string) => {
      traceStreams.current.get(runId)?.abort();
      const controller = new AbortController();
      traceStreams.current.set(runId, controller);
      void api
        .streamRunTrace(runId, appendTraceEvent, controller.signal)
        .catch((reason) => {
          if (!controller.signal.aborted) fail(reason);
        })
        .finally(() => {
          if (traceStreams.current.get(runId) === controller) traceStreams.current.delete(runId);
        });
    },
    [appendTraceEvent, fail],
  );

  const refreshAgent = useCallback(async (id: string) => {
    try {
      const { agent } = await api.getAgent(id);
      if (mounted.current && agentIdRef.current === id) {
        setName(agent.name);
        setStatus(agent.status);
        setForm({ name: agent.name, description: agent.description, instructions: agent.instructions });
      }
    } catch {
      /* header keeps its seeded values */
    }
  }, []);

  const refreshMessages = useCallback(async (id: string, branchId: string | null) => {
    const result = await api.messages(id, branchId);
    if (mounted.current && agentIdRef.current === id && activeBranchIdRef.current === branchId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshBranchPoint = useCallback(async (id: string, branchId: string | null) => {
    const [checkpointResult, traceResult, branchResult] = await Promise.all([
      api.checkpoints(id, branchId),
      api.trace(id, branchId),
      api.branches(id),
    ]);
    if (mounted.current && agentIdRef.current === id && activeBranchIdRef.current === branchId) {
      setCheckpoints(checkpointResult.checkpoints);
      setTraceEvents(traceResult.events);
      setBranches(branchResult.branches);
    }
  }, []);

  const pollRun = useCallback(
    async (runId: string, id: string, branchId: string | null) => {
      if (pollingRunIds.current.has(runId)) return;
      pollingRunIds.current.add(runId);
      try {
        while (mounted.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          if (!mounted.current) return;
          const { run } = await api.run(runId);
          if (agentIdRef.current === id && activeBranchIdRef.current === branchId && run.branchId === branchId) {
            setActiveRun(run);
          }
          if (!RUN_ACTIVE.includes(run.status)) {
            if (agentIdRef.current === id && activeBranchIdRef.current === branchId) {
              const [, , , runResult] = await Promise.all([
                refreshMessages(id, branchId),
                refreshAgent(id),
                refreshBranchPoint(id, branchId),
                api.runs(id, branchId),
              ]);
              if (mounted.current) setRuns(runResult.runs);
            }
            return;
          }
        }
      } finally {
        pollingRunIds.current.delete(runId);
      }
    },
    [refreshMessages, refreshAgent, refreshBranchPoint],
  );

  // Reset everything when the agent under the tab changes.
  useEffect(() => {
    setActiveBranchId(null);
    setSelectedCheckpointId(null);
    setShowSettings(false);
    setShowBranchPoint(false);
    setShowBpSettings(false);
    setError(null);
    setPrompt("");
    setActiveRun(null);
    setRuns([]);
    setBranches([]);
    for (const controller of traceStreams.current.values()) controller.abort();
    traceStreams.current.clear();
  }, [agentId]);

  // Read-only mode: hydrate straight from the project route's bundle.
  useEffect(() => {
    if (!agentId || canManage) return;
    setMessages(seed?.messages ?? []);
    setCheckpoints(seed?.checkpoints ?? []);
    setTraceEvents(seed?.trace ?? []);
    setName(seed?.agent.name ?? "");
    setStatus(seed?.agent.status ?? "ready");
  }, [seed, agentId, canManage]);

  // Manage mode: load live state for the agent / active branch.
  useEffect(() => {
    if (!agentId || !canManage) {
      if (!agentId) {
        setMessages([]);
        setCheckpoints([]);
        setTraceEvents([]);
        setName("");
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [messageResult, checkpointResult, traceResult, branchResult, runResult] = await Promise.all([
          api.messages(agentId, activeBranchId),
          api.checkpoints(agentId, activeBranchId),
          api.trace(agentId, activeBranchId),
          api.branches(agentId),
          api.runs(agentId, activeBranchId),
        ]);
        await refreshAgent(agentId);
        if (cancelled || agentIdRef.current !== agentId || activeBranchIdRef.current !== activeBranchId) return;
        setMessages(messageResult.messages);
        setCheckpoints(checkpointResult.checkpoints);
        setTraceEvents(traceResult.events);
        setBranches(branchResult.branches);
        setRuns(runResult.runs);
        const latest = activeBranchId
          ? runResult.runs.find((run) => run.branchId === activeBranchId) ?? null
          : runResult.runs.find((run) => run.branchId === null) ?? null;
        setActiveRun(latest);
        if (latest && RUN_ACTIVE.includes(latest.status)) {
          streamRunTrace(latest.id);
          void pollRun(latest.id, agentId, activeBranchId);
        }
      } catch (reason) {
        if (!cancelled) fail(reason);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, canManage, activeBranchId]);

  const toggleBranchPoint = useCallback(() => {
    setShowBranchPoint((open) => {
      const next = !open;
      if (next) {
        setBpView("history");
        setBpExpanded("history");
      }
      return next;
    });
  }, []);

  const selectBranch = useCallback((branchId: string | null) => {
    setActiveBranchId(branchId);
    setBpView("history");
    setBpExpanded("history");
  }, []);

  const sendText = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!agentId || !canManage || !text) return;
      const branchAtSend = activeBranchId;
      setError(null);
      setMessages((current) => [...current, optimistic(agentId, text)]);
      try {
        const { run, message } = await api.sendMessage(agentId, text, activeBranchId);
        if (agentIdRef.current === agentId && activeBranchIdRef.current === branchAtSend) {
          setMessages((current) => [...current.filter((item) => !item.id.startsWith("pending-")), message]);
          setActiveRun(run);
          streamRunTrace(run.id);
        }
        await pollRun(run.id, agentId, branchAtSend);
      } catch (reason) {
        fail(reason);
        if (agentIdRef.current === agentId) setActiveRun(null);
      }
    },
    [agentId, canManage, activeBranchId, streamRunTrace, pollRun, fail],
  );

  const send = useCallback(async () => {
    if (!prompt.trim()) return;
    const text = prompt.trim();
    setPrompt("");
    await sendText(text);
  }, [prompt, sendText]);

  const saveCheckpoint = useCallback(async () => {
    if (!agentId || !checkpointLabel.trim() || savingCheckpoint) return;
    setSavingCheckpoint(true);
    setError(null);
    try {
      await api.createCheckpoint(agentId, checkpointLabel.trim());
      setCheckpointLabel("");
      await refreshBranchPoint(agentId, activeBranchId);
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setSavingCheckpoint(false);
    }
  }, [agentId, checkpointLabel, savingCheckpoint, activeBranchId, refreshBranchPoint, fail]);

  const openCheckpointAction = useCallback(
    async (kind: "diff" | "details", checkpoint: AgentCheckpoint) => {
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
        fail(reason);
      }
    },
    [fail],
  );

  const openRunDetails = useCallback(
    async (run: AgentRun) => {
      setError(null);
      setRunOverlay({ run, trace: traceEvents.filter((event) => event.runId === run.id) });
      try {
        setRunOverlay(await api.runDetails(run.id));
      } catch (reason) {
        fail(reason);
      }
    },
    [traceEvents, fail],
  );

  const restoreCheckpoint = useCallback(
    async (checkpoint: AgentCheckpoint) => {
      if (!agentId) return;
      const confirmed = window.confirm(
        "Restore this checkpoint into the active workspace? This replaces the current workspace state with the saved snapshot.",
      );
      if (!confirmed) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.restoreCheckpoint(checkpoint.id);
        setRestoreResult({ path: result.workspacePath, hash: result.workspaceHash });
        setCheckpointOverlay(null);
        setSelectedCheckpointId(null);
        await Promise.all([
          refreshMessages(agentId, activeBranchId),
          refreshBranchPoint(agentId, activeBranchId),
        ]);
      } catch (reason) {
        fail(reason);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [agentId, activeBranchId, refreshMessages, refreshBranchPoint, fail],
  );

  const createBranchFromCheckpoint = useCallback(
    async (checkpoint: AgentCheckpoint) => {
      if (!agentId) return;
      const branchName = window.prompt("Branch name", "experiment");
      if (!branchName?.trim()) return;
      setError(null);
      try {
        const { branch } = await api.createBranch(agentId, checkpoint.id, branchName.trim());
        setBranches((current) => [branch, ...current]);
        setActiveBranchId(branch.id);
        setSelectedCheckpointId(null);
        setBpView("history");
        setBpExpanded("history");
      } catch (reason) {
        fail(reason);
      }
    },
    [agentId, fail],
  );

  const toggleAgent = useCallback(async () => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      if (status === "stopped") await api.startAgent(agentId);
      else await api.stopAgent(agentId);
      await refreshAgent(agentId);
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [agentId, status, refreshAgent, fail]);

  const saveAgent = useCallback(async () => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(agentId, form);
      await refreshAgent(agentId);
      setShowSettings(false);
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [agentId, form, refreshAgent, fail]);

  const deleteAgent = useCallback(async () => {
    if (!agentId) return;
    if (!window.confirm("Delete this agent? Its workspace will be archived.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(agentId);
      onDeleted?.();
    } catch (reason) {
      fail(reason);
      if (mounted.current) setBusy(false);
    }
  }, [agentId, onDeleted, fail]);

  const historyItems = useMemo(
    () =>
      [
        ...checkpoints.map((checkpoint) => ({
          kind: "checkpoint" as const,
          createdAt: checkpoint.createdAt,
          checkpoint,
        })),
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

  return {
    agentId,
    canManage,
    name,
    status,
    messages,
    runs,
    checkpoints,
    branches,
    activeBranchId,
    traceEvents,
    activeRun,
    prompt,
    setPrompt,
    busy,
    error,
    setError,
    showBranchPoint,
    setShowBranchPoint,
    toggleBranchPoint,
    bpView,
    setBpView,
    bpExpanded,
    setBpExpanded,
    selectedCheckpointId,
    setSelectedCheckpointId,
    showBpSettings,
    setShowBpSettings,
    settingsTab,
    setSettingsTab,
    howItWorksOpen,
    setHowItWorksOpen,
    showSettings,
    setShowSettings,
    form,
    setForm,
    checkpointOverlay,
    setCheckpointOverlay,
    showCodeChanges,
    setShowCodeChanges,
    runOverlay,
    setRunOverlay,
    restoreResult,
    setRestoreResult,
    checkpointLabel,
    setCheckpointLabel,
    savingCheckpoint,
    historyItems,
    branchGraphRows,
    selectBranch,
    send,
    sendText,
    saveCheckpoint,
    openCheckpointAction,
    openRunDetails,
    restoreCheckpoint,
    createBranchFromCheckpoint,
    toggleAgent,
    saveAgent,
    deleteAgent,
  };
}

export type WorkspaceApi = ReturnType<typeof useAgentWorkspace>;

/* ------------------------------------------------------------------ */
/* Playground: agent header (Settings · BranchPoint · Stop · Delete)   */
/* + chat + composer. Lives inside the project tab.                    */
/* ------------------------------------------------------------------ */

export function AgentPlayground({
  ws,
  title,
  subtitle,
  showDelete = true,
  sidePanel,
}: {
  ws: WorkspaceApi;
  title: string;
  subtitle: string;
  showDelete?: boolean;
  /** Rendered beside the playground; the agent header above stays full width. */
  sidePanel?: ReactNode;
}) {
  const canManage = ws.canManage;
  const messageEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [ws.messages, ws.activeRun]);

  const runActive = ws.activeRun != null && RUN_ACTIVE.includes(ws.activeRun.status);

  return (
    <div className="agent-workspace">
      <header className="agent-header">
        <div>
          <span className="eyebrow">{title}</span>
          <div className="header-title-row">
            <h1>{ws.name || "Agent"}</h1>
            <span className={"status status-" + ws.status}>
              <span className="status-dot" />
              {ws.status}
            </span>
          </div>
          <p>{subtitle}</p>
        </div>
        <div className="header-actions">
          <button
            className="button button-ghost"
            onClick={() => ws.setShowSettings((value) => !value)}
            disabled={!canManage || ws.busy || ws.status === "busy"}
          >
            Settings
          </button>
          <button
            className={"button " + (ws.showBranchPoint ? "button-primary" : "button-ghost")}
            onClick={ws.toggleBranchPoint}
            aria-expanded={ws.showBranchPoint}
            aria-controls="branchpoint-panel"
          >
            BranchPoint
          </button>
          <button
            className="button button-ghost"
            onClick={() => void ws.toggleAgent()}
            disabled={!canManage || ws.busy}
          >
            {ws.status === "stopped" ? "Start" : "Stop"}
          </button>
          {showDelete && (
            <button
              className="button button-danger"
              onClick={() => void ws.deleteAgent()}
              disabled={!canManage || ws.busy || ws.status === "busy"}
            >
              Delete
            </button>
          )}
        </div>
      </header>

      {canManage && ws.showSettings && (
        <form
          className="settings-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void ws.saveAgent();
          }}
        >
          <div className="settings-title">
            <div>
              <span className="eyebrow">Agent configuration</span>
              <h2>Instructions and identity</h2>
            </div>
            <button type="button" onClick={() => ws.setShowSettings(false)}>
              ×
            </button>
          </div>
          <div className="form-grid">
            <label>
              Name
              <input
                value={ws.form.name}
                onChange={(event) => ws.setForm({ ...ws.form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                value={ws.form.description}
                onChange={(event) => ws.setForm({ ...ws.form, description: event.target.value })}
                maxLength={500}
              />
            </label>
          </div>
          <label>
            System instructions
            <textarea
              value={ws.form.instructions}
              onChange={(event) => ws.setForm({ ...ws.form, instructions: event.target.value })}
              rows={5}
              maxLength={10_000}
            />
          </label>
          <div className="panel-footer">
            <button className="button button-primary" disabled={ws.busy}>
              {ws.busy ? <Spinner /> : "Save changes"}
            </button>
          </div>
        </form>
      )}

      <div
        className={
          "playground-row" +
          (sidePanel && ws.showBranchPoint && !ws.showBpSettings ? " has-side-panel" : "")
        }
      >
      <section className="playground">
        <div className="playground-topbar">
          <div>
            <span className="eyebrow">Playground</span>
            <h2>{canManage ? "Build something with your Agent" : "Read-only conversation"}</h2>
          </div>
          <div className="session-info">
            <span className="pulse" />
            {canManage ? "Session connected" : "Owner controlled"}
          </div>
        </div>

        <div className="messages">
          {ws.messages.length === 0 && !ws.activeRun ? (
            <div className="welcome">
              <div className="welcome-orbit">
                <div>⌁</div>
              </div>
              <h3>{canManage ? "What should this agent build?" : "No messages yet"}</h3>
              <p>
                {canManage
                  ? "The agent can inspect files, write code, run commands, and continue the same session across messages."
                  : "Only the project owner can instruct this agent. You can read its history here."}
              </p>
            </div>
          ) : (
            ws.messages.map((message) => (
              <article className={"message message-" + message.role} key={message.id}>
                <div className="message-meta">
                  <strong>{message.role === "user" ? "You" : ws.name || "Agent"}</strong>
                  <span>{fmt(message.createdAt)}</span>
                </div>
                <div className="message-body">{message.content}</div>
              </article>
            ))
          )}
          {ws.activeRun && RUN_ACTIVE.includes(ws.activeRun.status) && (
            <article className="message message-assistant thinking">
              <div className="message-meta">
                <strong>{ws.name || "Agent"}</strong>
                <span>working in the Agent workspace</span>
              </div>
              <div className="thinking-row">
                <Spinner />
                Codex is reading, editing, or running commands…
              </div>
            </article>
          )}
          {ws.activeRun?.status === "failed" && (
            <article className="run-error">
              <strong>Run failed</strong>
              <span>{ws.activeRun.error}</span>
            </article>
          )}
          {ws.activeRun &&
            RUN_ACTIVE.includes(ws.activeRun.status) &&
            ws.traceEvents.some((event) => event.runId === ws.activeRun!.id) && (
              <section className="live-trace live-trace-chat" aria-live="polite">
                <div className="live-trace-heading">
                  <div>
                    <span className="eyebrow">Live trace</span>
                    <strong>Run in progress</strong>
                  </div>
                  <span className="live-indicator">
                    <span /> Streaming
                  </span>
                </div>
                <div className="live-trace-list">
                  {ws.traceEvents
                    .filter((event) => event.runId === ws.activeRun!.id)
                    .slice(-8)
                    .map((event) => {
                      const label =
                        event.type === "codex.event" && typeof event.metadata.eventType === "string"
                          ? event.metadata.eventType === "error"
                            ? "Codex error"
                            : event.metadata.eventType
                          : event.type;
                      return (
                        <div className="live-trace-event" key={event.id}>
                          <span className="trace-event-dot" />
                          <div>
                            <strong>{label}</strong>
                            <small>{fmt(event.timestamp)}</small>
                          </div>
                          <p>
                            {typeof event.metadata.explanation === "string"
                              ? event.metadata.explanation
                              : typeof event.metadata.output === "string"
                                ? event.metadata.output
                                : "Observable execution activity recorded."}
                          </p>
                        </div>
                      );
                    })}
                </div>
              </section>
            )}
          {ws.error && (
            <article className="run-error">
              <strong>Something went wrong</strong>
              <span>{ws.error}</span>
            </article>
          )}
          <div ref={messageEnd} />
        </div>

        {canManage ? (
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void ws.send();
            }}
          >
            <textarea
              value={ws.prompt}
              onChange={(event) => ws.setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={
                ws.status === "stopped" ? "Start this Agent to continue…" : "Describe what you want the Agent to do…"
              }
              disabled={ws.status === "stopped" || runActive}
              rows={3}
            />
            <div className="composer-footer">
              <span>Enter to send · Shift + Enter for newline</span>
              <button
                className="send-button"
                disabled={!ws.prompt.trim() || ws.status === "stopped" || runActive}
                aria-label="Send message"
              >
                ↑
              </button>
            </div>
          </form>
        ) : (
          <div className="composer composer-locked">
            Owner only — you can read this agent but not instruct it.
          </div>
        )}
      </section>
      {sidePanel}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* BranchPoint drawer: History / Branches. */
/* ------------------------------------------------------------------ */

export function BranchPointPanel({ ws, onMergeBranch }: { ws: WorkspaceApi; onMergeBranch?: (branchId: string) => void }) {
  const canManage = ws.canManage;
  return (
    <>
    {!ws.showBpSettings && (
    <aside className="branchpoint-panel" id="branchpoint-panel">
      <div className="branchpoint-heading">
        <div>
          <span className="eyebrow">BranchPoint · Beta</span>
          <h2>Execution history</h2>
        </div>
        <div className="panel-heading-actions">
          <button
            className="settings-button"
            onClick={() => ws.setShowBpSettings(true)}
            aria-expanded={ws.showBpSettings}
            aria-label="Open BranchPoint settings"
            title="BranchPoint settings"
          >
            Settings
          </button>
          <button
            className="panel-close"
            onClick={() => ws.setShowBranchPoint(false)}
            aria-label="Close BranchPoint panel"
          >
            ×
          </button>
        </div>
      </div>

      <div className="branchpoint-context">
        <div>
          <span>Agent</span>
          <strong>{ws.name || "No Agent selected"}</strong>
        </div>
        <div>
          <span>Active branch</span>
          <strong>{ws.branches.find((branch) => branch.id === ws.activeBranchId)?.name ?? "main"}</strong>
        </div>
        <div>
          <span>Checkpoints saved</span>
          <strong>{ws.checkpoints.length}</strong>
        </div>
      </div>

      <nav className="branchpoint-tabs" aria-label="BranchPoint views">
        {(["history", "branches"] as const).map((view) => (
          <button
            className={ws.bpView === view ? "active" : ""}
            key={view}
            onClick={() => {
              ws.setBpView(view);
              ws.setBpExpanded(view);
            }}
          >
            {view[0].toUpperCase() + view.slice(1)}
          </button>
        ))}
      </nav>

      <div className="branchpoint-view">
        <button
          className="view-collapse"
          onClick={() => ws.setBpExpanded((current) => (current === ws.bpView ? null : ws.bpView))}
          aria-expanded={ws.bpExpanded === ws.bpView}
        >
          <span>
            {ws.bpView === "history"
              ? "Execution history"
              : ws.bpView === "branches"
                ? "Branch workspaces"
              : "Branch workspaces"}
          </span>
          <span>{ws.bpExpanded === ws.bpView ? "−" : "+"}</span>
        </button>

        {ws.bpExpanded === ws.bpView && ws.bpView === "history" && (
          <>
            {canManage && (
              <>
                <form
                  className="checkpoint-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void ws.saveCheckpoint();
                  }}
                >
                  <input
                    value={ws.checkpointLabel}
                    onChange={(event) => ws.setCheckpointLabel(event.target.value)}
                    placeholder="Name a checkpoint for the current workspace…"
                    maxLength={120}
                    disabled={ws.status === "busy" || ws.savingCheckpoint || ws.runs.length === 0}
                  />
                  <button
                    className="button button-primary"
                    disabled={
                      ws.status === "busy" ||
                      ws.savingCheckpoint ||
                      !ws.checkpointLabel.trim() ||
                      ws.runs.length === 0
                    }
                  >
                    {ws.savingCheckpoint ? <Spinner /> : "Save checkpoint"}
                  </button>
                </form>
                {ws.runs.length === 0 && (
                  <p className="checkpoint-create-hint">
                    Send this Agent an instruction first — a checkpoint snapshots the workspace a run produces.
                  </p>
                )}
              </>
            )}

            <div className={"checkpoint-list " + (ws.historyItems.length === 0 ? "is-empty" : "")}>
              {ws.historyItems.map((item) => {
                if (item.kind === "run") {
                  return (
                    <button
                      type="button"
                      className="run-history-entry"
                      key={item.run.id}
                      onClick={() => void ws.openRunDetails(item.run)}
                    >
                      <span className="run-history-marker" />
                      <div className="run-history-copy">
                        <strong>
                          Run event · Immutable{" "}
                          <em>{item.run.status === "completed" ? "Completed" : item.run.status}</em>
                        </strong>
                        <span>
                          {fmt(item.run.createdAt)} · Run {item.run.id.slice(0, 8)}
                        </span>
                        <p>{item.run.prompt}</p>
                        <small>View details →</small>
                      </div>
                    </button>
                  );
                }
                const checkpoint = item.checkpoint;
                const isSelected = checkpoint.id === ws.selectedCheckpointId;
                const changed =
                  checkpoint.changedFiles.created.length +
                  checkpoint.changedFiles.modified.length +
                  checkpoint.changedFiles.deleted.length;
                return (
                  <div className={"checkpoint " + (isSelected ? "selected" : "")} key={checkpoint.id}>
                    <button
                      className="checkpoint-summary"
                      onClick={() =>
                        ws.setSelectedCheckpointId((current) => (current === checkpoint.id ? null : checkpoint.id))
                      }
                      aria-expanded={isSelected}
                    >
                      <span className="checkpoint-marker" />
                      <span className="checkpoint-copy">
                        <strong>
                          {checkpoint.label ?? "Checkpoint event · Recoverable"}
                          <em>
                            {checkpoint.reason === "explicit"
                              ? "Named checkpoint"
                              : checkpoint.status === "partial"
                                ? "Partial Run state"
                                : "Workspace mutation"}
                          </em>
                        </strong>
                        <span>{fmt(checkpoint.createdAt)}</span>
                        <span>
                          Run {checkpoint.runId.slice(0, 8)} ·{" "}
                          {checkpoint.reason === "auto-mutation" ? "Automatic" : "Explicit"}
                        </span>
                      </span>
                      <small>
                        {changed} file{changed === 1 ? "" : "s"}
                      </small>
                    </button>
                    {isSelected && (
                      <div className="checkpoint-actions">
                        <div className="checkpoint-files">
                          {[
                            ...checkpoint.changedFiles.created,
                            ...checkpoint.changedFiles.modified,
                            ...checkpoint.changedFiles.deleted,
                          ].map((file) => (
                            <code key={file}>{file}</code>
                          ))}
                        </div>
                        {canManage && (
                          <div className="checkpoint-buttons">
                            <button
                              className="button button-primary"
                              type="button"
                              onClick={() => void ws.createBranchFromCheckpoint(checkpoint)}
                            >
                              Branch from here
                            </button>
                            <button
                              className="button button-ghost"
                              type="button"
                              onClick={() => void ws.restoreCheckpoint(checkpoint)}
                            >
                              Restore workspace
                            </button>
                            <button
                              className="button button-ghost"
                              type="button"
                              onClick={() => void ws.openCheckpointAction("diff", checkpoint)}
                            >
                              View diff
                            </button>
                            <button
                              className="button button-ghost"
                              type="button"
                              onClick={() => void ws.openCheckpointAction("details", checkpoint)}
                            >
                              View details
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {ws.historyItems.length === 0 && (
                <div className="empty-branchpoint-view">
                  No Runs yet. Agent execution history will appear here after the first prompt.
                </div>
              )}
            </div>
          </>
        )}

        {ws.bpExpanded === ws.bpView && ws.bpView === "branches" &&
          (ws.branches.length > 0 ? (
            <>
              <div className="branch-graph" aria-label="Branch graph">
                <div className="branch-graph-heading">
                  <span>Branch graph</span>
                  <small>Execution lineage</small>
                </div>
                <div className="branch-graph-canvas">
                  <button
                    className={"branch-graph-row " + (!ws.activeBranchId ? "active" : "")}
                    type="button"
                    onClick={() => ws.selectBranch(null)}
                  >
                    <span className="branch-graph-lane" style={{ "--branch-depth": 0 } as React.CSSProperties}>
                      <span className="branch-graph-node" />
                    </span>
                    <span className="branch-graph-label">
                      <strong>main</strong>
                      <small>Original workspace</small>
                    </span>
                  </button>
                  {ws.branchGraphRows.map(({ branch, depth }) => (
                    <button
                      className={"branch-graph-row " + (branch.id === ws.activeBranchId ? "active" : "")}
                      type="button"
                      key={branch.id}
                      onClick={() => ws.selectBranch(branch.id)}
                    >
                      <span
                        className="branch-graph-lane"
                        style={{ "--branch-depth": depth } as React.CSSProperties}
                      >
                        <span className="branch-graph-node" />
                      </span>
                      <span className="branch-graph-label">
                        <strong>{branch.name}</strong>
                        <small>
                          {branch.status} · from {branch.parentCheckpointId?.slice(0, 8)}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="branch-list">
                {ws.branches.map((branch) => (
                  <div className="branch-card-row" key={branch.id}>
                    <button className={"branch-card " + (branch.id === ws.activeBranchId ? "active" : "")} type="button" onClick={() => ws.selectBranch(branch.id)}>
                      <span className="branch-card-icon">⑂</span><span><strong>{branch.name}</strong><small>{branch.status} · from checkpoint {branch.parentCheckpointId?.slice(0, 8)}</small></span><span>›</span>
                    </button>
                    {onMergeBranch && <button className="button button-ghost" type="button" onClick={() => onMergeBranch(branch.id)}>Merge</button>}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="branchpoint-empty-state">
              <span className="branchpoint-empty-icon">⑂</span>
              <strong>No branch workspaces yet</strong>
              <p>Choose “Branch from here” on a Checkpoint event to create an independent workspace.</p>
            </div>
          ))}

      </div>
    </aside>
    )}

    {ws.showBpSettings && (() => {
      const activeTab = branchPointSettingsTabs.find((tab) => tab.key === ws.settingsTab) ?? branchPointSettingsTabs[0];
      return (
        <div className="branchpoint-settings-overlay" onMouseDown={() => ws.setShowBpSettings(false)}>
          <aside className="branchpoint-settings-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-panel-heading">
              <div>
                <span className="eyebrow">BranchPoint · Beta</span>
                <h2>BranchPoint</h2>
                <p>Understand how execution is tracked, versioned, and recovered across runs, checkpoints, and branches.</p>
              </div>
              <button className="panel-close" type="button" onClick={() => ws.setShowBpSettings(false)} aria-label="Close BranchPoint settings">×</button>
            </div>

            <section className="how-it-works">
              <button
                className="how-it-works-toggle"
                type="button"
                onClick={() => ws.setHowItWorksOpen((value) => !value)}
                aria-expanded={ws.howItWorksOpen}
              >
                <span>How it works?</span>
                <span>{ws.howItWorksOpen ? "⌃" : "›"}</span>
              </button>
              {ws.howItWorksOpen && (
                <div className="how-it-works-body">
                  <nav className="settings-main-tabs" aria-label="Settings sections">
                    {branchPointSettingsTabs.map((tab) => (
                      <button
                        key={tab.key}
                        className={ws.settingsTab === tab.key ? "active" : ""}
                        type="button"
                        onClick={() => ws.setSettingsTab(tab.key)}
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
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Modal overlays for checkpoint diff / details, run details, restore  */
/* ------------------------------------------------------------------ */

export function WorkspaceOverlays({ ws }: { ws: WorkspaceApi }) {
  return (
    <>
      {ws.checkpointOverlay && (
        <div className="modal-backdrop" onMouseDown={() => ws.setCheckpointOverlay(null)}>
          <section className="modal checkpoint-overlay" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Checkpoint inspection</span>
                <h2>
                  {ws.checkpointOverlay.kind === "diff"
                    ? "Changes from previous checkpoint"
                    : "Checkpoint details"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => ws.setCheckpointOverlay(null)}
                aria-label="Close checkpoint inspection"
              >
                ×
              </button>
            </div>
            {ws.checkpointOverlay.kind === "diff" && ws.checkpointOverlay.diff && (
              <div className="inspection-section">
                <p className="inspection-message">Comparing this checkpoint with its immediate parent.</p>
                <div className="diff-summary">
                  {ws.checkpointOverlay.diff.changedFiles.created.length > 0 && (
                    <p>Codex added {ws.checkpointOverlay.diff.changedFiles.created.length} file(s) in this step.</p>
                  )}
                  {ws.checkpointOverlay.diff.changedFiles.modified.length > 0 && (
                    <p>Codex updated {ws.checkpointOverlay.diff.changedFiles.modified.length} existing file(s).</p>
                  )}
                  {ws.checkpointOverlay.diff.changedFiles.deleted.length > 0 && (
                    <p>Codex removed {ws.checkpointOverlay.diff.changedFiles.deleted.length} file(s).</p>
                  )}
                  {!ws.checkpointOverlay.diff.files.length && (
                    <p>No file content changed between these checkpoints.</p>
                  )}
                </div>
                {(["created", "modified", "deleted"] as const).map((category) => (
                  <div className="diff-category" key={category}>
                    <h3>{category[0].toUpperCase() + category.slice(1)} files</h3>
                    <div className="diff-files">
                      {ws.checkpointOverlay?.diff?.changedFiles[category].length ? (
                        ws.checkpointOverlay.diff.changedFiles[category].map((file) => (
                          <code className="inspection-file" key={file}>
                            {file}
                          </code>
                        ))
                      ) : (
                        <p className="inspection-muted">None</p>
                      )}
                    </div>
                  </div>
                ))}
                {ws.checkpointOverlay.diff.files.length > 0 && (
                  <>
                    <button
                      className="code-toggle"
                      type="button"
                      onClick={() => ws.setShowCodeChanges((value) => !value)}
                      aria-expanded={ws.showCodeChanges}
                    >
                      {ws.showCodeChanges ? "Hide code changes" : "View actual code changes"}
                    </button>
                    {ws.showCodeChanges && (
                      <div className="code-change-list">
                        {ws.checkpointOverlay.diff.files.map((file) => (
                          <article key={file.path}>
                            <header>
                              <strong>{file.path}</strong>
                              <span>{file.status}</span>
                            </header>
                            {file.hunks.map((hunk) => (
                              <div className="diff-hunk" key={hunk.oldStart + ":" + hunk.newStart}>
                                <code>
                                  @@ -{hunk.oldStart} +{hunk.newStart} @@
                                </code>
                                <pre>
                                  {hunk.lines.map((line, index) => (
                                    <span className={"diff-line diff-line-" + line.type} key={index}>
                                      {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                                      {line.content}
                                      {"\n"}
                                    </span>
                                  ))}
                                </pre>
                              </div>
                            ))}
                          </article>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {ws.checkpointOverlay.kind === "details" && ws.checkpointOverlay.details && (
              <div className="inspection-section">
                <p className="inspection-message">
                  Run {ws.checkpointOverlay.details.run.id.slice(0, 8)} · {ws.checkpointOverlay.details.run.status} ·{" "}
                  {ws.checkpointOverlay.details.checkpoint.status}
                </p>
                {ws.checkpointOverlay.details.checkpoint.label && (
                  <>
                    <h3>Checkpoint name</h3>
                    <p className="inspection-copy">
                      {ws.checkpointOverlay.details.checkpoint.label} ·{" "}
                      {ws.checkpointOverlay.details.checkpoint.reason === "explicit" ? "Saved by a user" : "Automatic"}
                    </p>
                  </>
                )}
                <h3>Observable context</h3>
                <p className="inspection-muted">
                  {ws.checkpointOverlay.details.context.agentName} ·{" "}
                  {ws.checkpointOverlay.details.context.instructions.length} instruction characters
                </p>
                <h3>Run instruction</h3>
                <p className="inspection-copy">{ws.checkpointOverlay.details.run.prompt}</p>
                {ws.checkpointOverlay.details.run.output && (
                  <>
                    <h3>Agent result</h3>
                    <p className="inspection-copy">{ws.checkpointOverlay.details.run.output}</p>
                  </>
                )}
                <h3>Conversation snapshot</h3>
                <div className="inspection-conversation">
                  {ws.checkpointOverlay.details.context.messages.map((message) => (
                    <div key={message.id}>
                      <strong>{message.role}</strong>
                      <p>{message.content}</p>
                    </div>
                  ))}
                </div>
                <h3>Verification</h3>
                <p className="inspection-muted">
                  Workspace hash: {ws.checkpointOverlay.details.checkpoint.workspaceHash}
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      {ws.runOverlay && (
        <div className="modal-backdrop" onMouseDown={() => ws.setRunOverlay(null)}>
          <section className="modal checkpoint-overlay" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Immutable Run inspection</span>
                <h2>Run execution trace</h2>
              </div>
              <button type="button" onClick={() => ws.setRunOverlay(null)} aria-label="Close Run inspection">
                ×
              </button>
            </div>
            <div className="inspection-section">
              <p className="inspection-message">
                Run {ws.runOverlay.run.id.slice(0, 8)} · {ws.runOverlay.run.status} · This event cannot be reverted.
              </p>
              <h3>Prompt</h3>
              <p className="inspection-copy">{ws.runOverlay.run.prompt}</p>
              <h3>Trace events</h3>
              <div className="inspection-trace">
                {ws.runOverlay.trace.map((event) => (
                  <div key={event.id}>
                    <header>
                      <strong>{event.type}</strong>
                      <span>{fmt(event.timestamp)}</span>
                    </header>
                    <p>
                      {typeof event.metadata.explanation === "string"
                        ? event.metadata.explanation
                        : event.type === "codex.event"
                          ? "Codex reported observable execution activity."
                          : "Recorded BranchPoint activity."}
                    </p>
                  </div>
                ))}
              </div>
              {ws.runOverlay.run.output && (
                <>
                  <h3>Agent result</h3>
                  <p className="inspection-copy">{ws.runOverlay.run.output}</p>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {ws.restoreResult && (
        <div className="modal-backdrop" onMouseDown={() => ws.setRestoreResult(null)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Checkpoint restored</span>
                <h2>Workspace updated</h2>
              </div>
              <button type="button" onClick={() => ws.setRestoreResult(null)} aria-label="Close restore result">
                ×
              </button>
            </div>
            <p className="inspection-message">The workspace now matches the saved snapshot.</p>
            <label>
              Restored workspace
              <input readOnly value={ws.restoreResult.path} />
            </label>
            <p className="inspection-muted">Workspace hash: {ws.restoreResult.hash}</p>
          </section>
        </div>
      )}
    </>
  );
}

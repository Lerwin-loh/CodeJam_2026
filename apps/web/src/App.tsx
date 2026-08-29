import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentCheckpoint, AgentRun, CheckpointDetails, CheckpointDiff, Message, SystemInfo, TraceEvent } from "./types";

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

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [showBranchPoint, setShowBranchPoint] = useState(false);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [showBranchPointSettings, setShowBranchPointSettings] = useState(false);
  const [showTraceRules, setShowTraceRules] = useState(false);
  const [activeBranchPointView, setActiveBranchPointView] = useState<"history" | "branches" | "compare">("history");
  const [expandedBranchPointView, setExpandedBranchPointView] = useState<string | null>("history");
  const [checkpointOverlay, setCheckpointOverlay] = useState<{
    kind: "diff" | "details" | "unavailable";
    checkpoint: AgentCheckpoint;
    details?: CheckpointDetails;
    diff?: CheckpointDiff;
  } | null>(null);
  const [showCodeChanges, setShowCodeChanges] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

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

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshBranchPoint = useCallback(async (agentId: string) => {
    const [checkpointResult, traceResult] = await Promise.all([
      api.checkpoints(agentId),
      api.trace(agentId),
    ]);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setCheckpoints(checkpointResult.checkpoints);
      setTraceEvents(traceResult.events);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setSelectedCheckpointId(null);
    setRuns([]);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    setCheckpoints([]);
    setTraceEvents([]);
    void Promise.all([refreshMessages(selectedId), refreshBranchPoint(selectedId), api.runs(selectedId)])
      .then(([, , result]) => {
        if (selectedIdRef.current !== selectedId) return;
        setRuns(result.runs);
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshBranchPoint, refreshMessages, selectedId]);

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

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          const [, , , runResult] = await Promise.all([refreshMessages(agentId), refreshAgents(), refreshBranchPoint(agentId), api.runs(agentId)]);
          setRuns(runResult.runs);
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
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
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

  const restoreCheckpoint = async (checkpoint: AgentCheckpoint) => {
    if (!selected) return;
    const confirmed = window.confirm(
      "Restore this checkpoint into the active workspace? This will replace the current workspace state with the saved snapshot.",
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.restoreCheckpoint(checkpoint.id);
      setCheckpointOverlay(null);
      setSelectedCheckpointId(null);
      setError("Workspace restored to checkpoint " + checkpoint.id.slice(0, 8));
      await Promise.all([refreshMessages(selected.id), refreshBranchPoint(selected.id), api.runs(selected.id)]).then(([, , result]) => {
        setRuns(result.runs);
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className={"app-shell " + (showBranchPoint ? "branchpoint-open" : "")}>
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
                  onClick={() => setShowBranchPoint((value) => !value)}
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
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
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
                    selected.status === "busy" ||
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
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
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

      {showBranchPoint && (
        <aside className="branchpoint-panel" id="branchpoint-panel">
          <div className="branchpoint-heading">
            <div>
              <span className="eyebrow">BranchPoint · Beta</span>
              <h2>Execution history</h2>
            </div>
            <div className="panel-heading-actions">
              <button
                className="settings-button"
                onClick={() => setShowBranchPointSettings((value) => !value)}
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
            <div><span>Active branch</span><strong>Branching is not available yet</strong></div>
            <div><span>Checkpoints saved</span><strong>{checkpoints.length}</strong></div>
          </div>

          {showBranchPointSettings && (
            <section className="branchpoint-settings">
              <div className="settings-popup-heading">
                <div>
                  <span className="eyebrow">BranchPoint settings</span>
                  <h3>Workspace controls</h3>
                </div>
                <button className="panel-close" onClick={() => setShowBranchPointSettings(false)} aria-label="Close BranchPoint settings">×</button>
              </div>
              <button className="settings-link active" type="button">Branch defaults <span>›</span></button>
              <button className="settings-link" type="button">Runtime and permissions <span>›</span></button>
              <button
                className={"settings-link " + (showTraceRules ? "active" : "")}
                type="button"
                onClick={() => setShowTraceRules((value) => !value)}
                aria-expanded={showTraceRules}
              >
                Trace and checkpoint rules <span>{showTraceRules ? "⌃" : "›"}</span>
              </button>
              {showTraceRules && (
                <div className="trace-rules">
                  <section>
                    <h4>Trace events</h4>
                    <p>Records what happened during a Run: start, completion, errors, workspace mutations, and observable Codex activity such as tools, commands, file operations, tests, and bounded output.</p>
                    <small>Stored as lightweight metadata in trace records linked to the Agent and Run. Private hidden chain-of-thought is not captured.</small>
                  </section>
                  <section>
                    <h4>Checkpoint events</h4>
                    <p>Records a recoverable workspace state after meaningful file changes, including changed files, parent checkpoint, workspace hash, Run, observable context, and the captured execution events for that Run.</p>
                    <small>Stored as checkpoint metadata in the JSON store. Immutable workspace files and manifests are stored under the BranchPoint snapshot directory. A checkpoint's observable context includes the accumulated conversation from earlier Runs and checkpoints up to that point.</small>
                  </section>
                  <div className="trace-rule-note">No checkpoint is created when a Run leaves the workspace unchanged. Context from previous checkpoints is implicitly carried forward in later context snapshots; each workspace snapshot remains a point-in-time copy.</div>
                </div>
              )}
            </section>
          )}

          <nav className="branchpoint-tabs" aria-label="BranchPoint views">
            {(["history", "branches", "compare"] as const).map((view) => (
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
              <span>{activeBranchPointView === "history" ? "Checkpoint history" : activeBranchPointView === "branches" ? "Branches" : "Compare branches"}</span>
              <span>{expandedBranchPointView === activeBranchPointView ? "−" : "+"}</span>
            </button>
            {expandedBranchPointView === activeBranchPointView && activeBranchPointView === "history" && (
              <div className="checkpoint-list">
                {historyItems.map((item) => {
              if (item.kind === "run") {
                return (
                  <article className="run-history-entry" key={item.run.id}>
                    <span className="run-history-marker" />
                    <div className="run-history-copy">
                      <strong>Run without checkpoint <em>{item.run.status === "completed" ? "Completed" : item.run.status}</em></strong>
                      <span>{formatTime(item.run.createdAt)} · Run {item.run.id.slice(0, 8)}</span>
                      <p>{item.run.prompt}</p>
                    </div>
                  </article>
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
                      <strong>Checkpoint {checkpoints.length - checkpoints.indexOf(checkpoint)} <em>{checkpoint.status === "partial" ? "Partial Run state" : "Workspace mutation"}</em></strong>
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
                        <button className="button button-primary" type="button" onClick={() => setCheckpointOverlay({ kind: "unavailable", checkpoint })}>Branch from here</button>
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
            )}
            {expandedBranchPointView === activeBranchPointView && activeBranchPointView !== "history" && (
              <div className="empty-branchpoint-view">
                {activeBranchPointView === "branches" ? "No branches have been created yet." : "Choose two branches to compare their workspace state."}
              </div>
            )}
          </div>
        </aside>
      )}

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
                <h3>Observable context</h3>
                <p className="inspection-muted">{checkpointOverlay.details.context.agentName} · {checkpointOverlay.details.context.instructions.length} instruction characters · source session {checkpointOverlay.details.context.sourceThreadId?.slice(0, 12) ?? "not available"}</p>
                <p className="inspection-disclaimer">This context snapshot includes the observable conversation accumulated through previous Runs and checkpoints. It does not include hidden model reasoning.</p>
                <h3>Run instruction</h3>
                <p className="inspection-copy">{checkpointOverlay.details.run.prompt}</p>
                {checkpointOverlay.details.run.output && <><h3>Agent result</h3><p className="inspection-copy">{checkpointOverlay.details.run.output}</p></>}
                <h3>Conversation snapshot</h3>
                <div className="inspection-conversation">{checkpointOverlay.details.context.messages.map((message) => <div key={message.id}><strong>{message.role}</strong><p>{message.content}</p></div>)}</div>
                <h3>Trace events</h3>
                <div className="inspection-trace">{checkpointOverlay.details.trace.map((event) => <div key={event.id}><header><strong>{event.type}</strong><span>{formatTime(event.timestamp)}</span></header><p>{typeof event.metadata.explanation === "string" ? event.metadata.explanation : event.type === "codex.event" ? "Codex reported observable execution activity." : "Recorded BranchPoint activity."}</p>{event.type === "codex.event" && <small>{typeof event.metadata.eventType === "string" ? event.metadata.eventType : "Codex event"}{typeof event.metadata.output === "string" ? " · " + event.metadata.output : ""}</small>}</div>)}</div>
                <h3>Verification</h3>
                <p className="inspection-muted">Workspace hash: {checkpointOverlay.details.checkpoint.workspaceHash}</p>
              </div>
            )}
          </section>
        </div>
      )}

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
    </div>
  );
}

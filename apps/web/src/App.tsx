import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, getStoredToken, setAuthToken } from "./api";
import type { Agent, AgentBranch, AgentCheckpoint, AgentRun, AuditEntry, CheckpointDetails, CheckpointDiff, Message, SystemInfo, TraceEvent, User } from "./types";

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

type BranchPointSettingsTabKey = "trace" | "run" | "checkpoint" | "branching";

interface BranchPointSettingsTab {
  key: BranchPointSettingsTabKey;
  icon: string;
  label: string;
  title: string;
  subtitle: string;
  intro: string;
  recordedHeading: string;
  recordedDescription: string;
  recordedItems: Array<{ icon: string; label: string; caption: string }>;
  storedText: string;
  whyItems: Array<{ icon: string; title: string; caption: string }>;
  summary: string;
  tip: string;
}

const branchPointSettingsTabs: BranchPointSettingsTab[] = [
  {
    key: "trace",
    icon: "⚡",
    label: "Trace events",
    title: "Trace events",
    subtitle: "See everything that happens during a Run.",
    intro:
      "Trace events capture observable activity during a Run — from start to completion. They help you understand what the Agent did, what tools were used, what changed, and how the Run finished.",
    recordedHeading: "What is recorded",
    recordedDescription:
      "Records what happened during a Run: start, completion, errors, workspace mutations, and observable Codex activity such as tools, commands, file operations, tests, and bounded output.",
    recordedItems: [
      { icon: "▶", label: "Run start", caption: "run.started" },
      { icon: "⚡", label: "Activity", caption: "Tools, commands, file ops" },
      { icon: "✎", label: "Changes", caption: "Workspace mutations" },
      { icon: "⚠", label: "Errors", caption: "Failures and cancellations" },
      { icon: "✓", label: "Run complete", caption: "run.completed" },
    ],
    storedText:
      "Stored as lightweight metadata in trace records linked to the Agent and Run. Private hidden chain-of-thought is not captured.",
    whyItems: [
      { icon: "🔍", title: "Auditability", caption: "Revisit exactly what happened in a Run." },
      { icon: "🛠", title: "Debugging", caption: "Identify where failures or issues occurred." },
      { icon: "↻", title: "Reproducibility", caption: "Understand steps taken to recreate or continue work." },
    ],
    summary: "Trace events give you a clear, structured timeline of a Run's observable behavior.",
    tip: "All events are lightweight metadata records stored in the JSON store and linked to the Agent and Run.",
  },
  {
    key: "run",
    icon: "◎",
    label: "Run lifecycle",
    title: "Run lifecycle",
    subtitle: "How a single prompt becomes a tracked, resumable execution.",
    intro:
      "A Run is one prompt sent to an Agent or Branch. It queues, executes Codex against that workspace, and streams observable events until it finishes — successfully, with an error, or cancelled.",
    recordedHeading: "What happens during a Run",
    recordedDescription:
      "Each Run moves through a fixed sequence of states, hashing the workspace before and after execution to detect real file changes.",
    recordedItems: [
      { icon: "⏳", label: "Queued", caption: "Waiting to execute" },
      { icon: "▶", label: "Running", caption: "Codex executing" },
      { icon: "⚡", label: "Streaming", caption: "codex.event per action" },
      { icon: "✓", label: "Completed", caption: "run.completed" },
      { icon: "✕", label: "Failed / cancelled", caption: "run.error" },
    ],
    storedText:
      "If the Agent or Branch already has a Codex thread, the Run resumes it — the model sees the full native history of every earlier turn on that thread. A freshly created Agent, or a Branch whose thread could not be forked, starts the Run with no prior conversational memory.",
    whyItems: [
      { icon: "🧵", title: "Continuity", caption: "Resumed threads keep full native memory." },
      { icon: "🔒", title: "Isolation", caption: "Each Branch's Runs stay on their own thread." },
      { icon: "📡", title: "Transparency", caption: "Every step streams as an observable event." },
    ],
    summary: "The Run lifecycle turns one prompt into a traceable, resumable unit of execution.",
    tip: "A Run only creates a checkpoint when it actually changes the workspace — otherwise it stays visible in history with no snapshot.",
  },
  {
    key: "checkpoint",
    icon: "▤",
    label: "Checkpoint events",
    title: "Checkpoint events",
    subtitle: "Recoverable workspace states you can return to or branch from.",
    intro:
      "A checkpoint is created automatically whenever a Run leaves meaningful file changes behind — or explicitly, whenever you choose to name and save one.",
    recordedHeading: "What is recorded",
    recordedDescription:
      "Records a recoverable workspace state after meaningful file changes, including changed files, parent checkpoint, workspace hash, Run, observable context, and the captured execution events for that Run.",
    recordedItems: [
      { icon: "📄", label: "Changed files", caption: "Created, modified, deleted" },
      { icon: "⑂", label: "Parent checkpoint", caption: "Lineage link" },
      { icon: "#", label: "Workspace hash", caption: "Content fingerprint" },
      { icon: "💬", label: "Observable context", caption: "Messages up to this point" },
      { icon: "⏱", label: "Session offset", caption: "Codex rollout line cut point" },
    ],
    storedText:
      "Stored as checkpoint metadata in the JSON store. Immutable workspace files and manifests are stored under the BranchPoint snapshot directory. Alongside the observable context, each checkpoint also records the Codex session's rollout file path and its exact line offset at that moment — the precise cut point later used to fork conversational memory when branching.",
    whyItems: [
      { icon: "⏮", title: "Recoverability", caption: "Restore any past workspace state." },
      { icon: "🧭", title: "Traceability", caption: "Every checkpoint links back to its Run." },
      { icon: "🗜", title: "Efficient storage", caption: "Unchanged Runs reuse the last snapshot." },
    ],
    summary: "Checkpoints are the recoverable, branchable waypoints of an Agent's history.",
    tip: "Each checkpoint also records the Codex session's rollout offset — the exact cut point used later when branching.",
  },
  {
    key: "branching",
    icon: "⑂",
    label: "Branching",
    title: "Branching",
    subtitle: "Fork a workspace and its Codex memory from any checkpoint.",
    intro:
      "Branching from a checkpoint creates a new, independent workspace and forks the Codex conversation itself — not just the files.",
    recordedHeading: "What happens when you branch",
    recordedDescription:
      "Branching from a checkpoint does two things: it restores that checkpoint's workspace snapshot into a new Branch workspace, and it forks the Codex conversation transcript at the checkpoint's recorded line offset, registering the copy as a new thread.",
    recordedItems: [
      { icon: "📁", label: "Workspace restore", caption: "Files copied from snapshot" },
      { icon: "🧵", label: "Thread fork", caption: "Transcript truncated & copied" },
      { icon: "🆔", label: "New thread id", caption: "Registered as its own session" },
      { icon: "🔀", label: "Independent history", caption: "Later Runs diverge safely" },
    ],
    storedText:
      "The new Branch resumes with full native Codex memory of everything up to that checkpoint, but nothing from Runs recorded after it — even when branching from an older checkpoint on a thread that has since moved on with more turns. If the source thread's session files are missing or unreadable, the Branch falls back to a fresh thread with no prior memory rather than failing.",
    whyItems: [
      { icon: "🧪", title: "Safe experimentation", caption: "Try a new direction without losing the original." },
      { icon: "🧠", title: "True memory continuity", caption: "No re-explaining context after branching." },
      { icon: "🚫", title: "No context leakage", caption: "Later turns never leak into an earlier branch." },
    ],
    summary: "Branching gives you a genuinely independent workspace and conversation, cut at exactly the right point.",
    tip: "If session files are missing, a Branch still restores its workspace — it just starts with no prior Codex memory.",
  },
];

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
  const [branches, setBranches] = useState<AgentBranch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [showAudit, setShowAudit] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [showBranchPoint, setShowBranchPoint] = useState(false);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [showBranchPointSettings, setShowBranchPointSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<BranchPointSettingsTabKey>("trace");
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [activeBranchPointView, setActiveBranchPointView] = useState<"history" | "branches" | "compare">("history");
  const [expandedBranchPointView, setExpandedBranchPointView] = useState<string | null>("history");
  const [checkpointOverlay, setCheckpointOverlay] = useState<{
    kind: "diff" | "details" | "unavailable";
    checkpoint: AgentCheckpoint;
    details?: CheckpointDetails;
    diff?: CheckpointDiff;
  } | null>(null);
  const [showCodeChanges, setShowCodeChanges] = useState(false);
  const [runOverlay, setRunOverlay] = useState<import("./types").RunDetails | null>(null);
  const [restoreResult, setRestoreResult] = useState<{ path: string; hash: string } | null>(null);
  const [checkpointLabel, setCheckpointLabel] = useState("");
  const [savingCheckpoint, setSavingCheckpoint] = useState(false);
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

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId, activeBranchId);
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
    const token = getStoredToken();
    if (!token) {
      setAuthChecked(true);
      return () => {
        mountedRef.current = false;
      };
    }
    void api
      .me()
      .then(async ({ user }) => {
        if (!mountedRef.current) return;
        setCurrentUser(user);
        await bootstrap();
      })
      .catch(() => {
        if (mountedRef.current) setAuthToken("");
      })
      .finally(() => {
        if (mountedRef.current) setAuthChecked(true);
      });
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
      setRestoreResult({ path: result.workspacePath, hash: result.workspaceHash });
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

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.createUser(name);
      setAuthToken(user.token);
      setCurrentUser({ id: user.id, name: user.name });
      setNameInput("");
      await bootstrap();
    } catch (reason) {
      setAuthToken("");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    setAuthToken("");
    setCurrentUser(null);
    setAgents([]);
    setSelectedId(null);
    setMessages([]);
    setRuns([]);
    setCheckpoints([]);
    setTraceEvents([]);
    setAuditEntries([]);
    setShowAudit(false);
    setShowBranchPoint(false);
  };

  const openAudit = async () => {
    setShowAudit(true);
    try {
      const { entries } = await api.audit();
      setAuditEntries(entries);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (!authChecked) {
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

  if (!currentUser) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={signIn}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Who's working?</h1>
          <p>Enter your name. You see and control only the Agents you own.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Your name
            <input
              autoFocus
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              maxLength={60}
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !nameInput.trim()}>
            {busy ? <Spinner /> : "Continue"}
          </button>
        </form>
      </main>
    );
  }

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
            <button className="button button-ghost" onClick={openAudit}>
              Access log
            </button>
            <button className="button button-ghost" onClick={signOut}>
              Switch
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
                        const label = event.type === "codex.event" && typeof event.metadata.eventType === "string"
                          ? event.metadata.eventType === "error" ? "Codex error" : event.metadata.eventType
                          : event.type;
                        return <div className="live-trace-event" key={event.id}>
                          <span className="trace-event-dot" />
                          <div><strong>{label}</strong><small>{formatTime(event.timestamp)}</small></div>
                          <p>{typeof event.metadata.explanation === "string" ? event.metadata.explanation : typeof event.metadata.output === "string" ? event.metadata.output : "Observable execution activity recorded."}</p>
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
              <span>{activeBranchPointView === "history" ? "Execution history" : activeBranchPointView === "branches" ? "Branch workspaces" : "Compare workspaces"}</span>
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
                <div className="branch-list">{branches.map((branch) => <button className={"branch-card " + (branch.id === activeBranchId ? "active" : "")} type="button" key={branch.id} onClick={() => { setActiveBranchId(branch.id); setActiveBranchPointView("history"); }}><span className="branch-card-icon">⑂</span><span><strong>{branch.name}</strong><small>{branch.status} · from checkpoint {branch.parentCheckpointId?.slice(0, 8)}</small></span><span>›</span></button>)}</div>
              </> : <div className="branchpoint-empty-state">
                <span className="branchpoint-empty-icon">⑂</span>
                <strong>No branch workspaces yet</strong>
                <p>Choose “Branch from here” on a Checkpoint event to create an independent workspace.</p>
              </div>
            )}
            {expandedBranchPointView === activeBranchPointView && activeBranchPointView === "compare" && (
              <div className="branchpoint-empty-state">
                <span className="branchpoint-empty-icon">⇄</span>
                <strong>{branches.length > 1 ? "Comparison is ready for the next step" : "No workspaces to compare yet"}</strong>
                <p>{branches.length > 1 ? "Select branch snapshots to compare their files and outcomes." : "Create two independent branches from Checkpoint events to compare their files and outcomes."}</p>
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
                  <p>Understand how execution is tracked, versioned, and recovered across runs, checkpoints, and branches.</p>
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
                <div className="inspection-trace">{checkpointOverlay.details.trace.map((event) => <div key={event.id}><header><strong>{event.type}</strong><span>{formatTime(event.timestamp)}</span></header><p>{typeof event.metadata.explanation === "string" ? event.metadata.explanation : event.type === "codex.event" ? "Codex reported observable execution activity." : "Recorded BranchPoint activity."}</p>{event.type === "codex.event" && <small>{typeof event.metadata.eventType === "string" ? event.metadata.eventType : "Codex event"}{typeof event.metadata.output === "string" ? " · " + event.metadata.output : ""}</small>}</div>)}</div>
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
              <div className="inspection-trace">{runOverlay.trace.map((event) => <div key={event.id}><header><strong>{event.type}</strong><span>{formatTime(event.timestamp)}</span></header><p>{typeof event.metadata.explanation === "string" ? event.metadata.explanation : event.type === "codex.event" ? "Codex reported observable execution activity." : "Recorded BranchPoint activity."}</p>{event.type === "codex.event" && <small>{typeof event.metadata.eventType === "string" ? event.metadata.eventType : "Codex event"}{typeof event.metadata.output === "string" ? " · " + event.metadata.output : ""}</small>}</div>)}</div>
              {runOverlay.run.output && <><h3>Agent result</h3><p className="inspection-copy">{runOverlay.run.output}</p></>}
            </div>
          </section>
        </div>
      )}

      {restoreResult && (
        <div className="modal-backdrop" onMouseDown={() => setRestoreResult(null)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><div><span className="eyebrow">Checkpoint restored</span><h2>New workspace created</h2></div><button type="button" onClick={() => setRestoreResult(null)} aria-label="Close restore result">×</button></div>
            <p className="inspection-message">The original workspace was not changed.</p>
            <label>Restored workspace<input readOnly value={restoreResult.path} /></label>
            <p className="inspection-muted">Workspace hash: {restoreResult.hash}</p>
          </section>
        </div>
      )}

      {showAudit && (
        <div className="modal-backdrop" onMouseDown={() => setShowAudit(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Authorization</span>
                <h2>Access log</h2>
                <p>Every action you take on an Agent, and every denied attempt on Agents you own.</p>
              </div>
              <button type="button" onClick={() => setShowAudit(false)} aria-label="Close access log">×</button>
            </div>
            <div className="audit-list">
              {auditEntries.map((entry) => (
                <article className={"audit-row audit-" + entry.decision} key={entry.id}>
                  <span className="audit-decision">{entry.decision}</span>
                  <div className="audit-copy">
                    <strong>{entry.userName} · {entry.action}</strong>
                    <span>{entry.resource} · {formatTime(entry.timestamp)}</span>
                    <p>{entry.reason}</p>
                  </div>
                </article>
              ))}
              {auditEntries.length === 0 && (
                <p className="audit-empty">No access events recorded yet.</p>
              )}
            </div>
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

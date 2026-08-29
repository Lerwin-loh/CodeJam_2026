/**
 * Shared BranchPoint "How it works?" settings content, used by both the flat
 * individual-mode App and the collaboration-mode ProjectsView workspace.
 */
export type BranchPointSettingsTabKey = "trace" | "run" | "checkpoint" | "branching";

export interface BranchPointSettingsTab {
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

export const branchPointSettingsTabs: BranchPointSettingsTab[] = [
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

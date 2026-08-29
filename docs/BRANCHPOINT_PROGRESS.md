# BranchPoint Progress

## Product Direction

BranchPoint is middleware for autonomous Agent execution. It preserves and explains observable execution history so users can understand what happened and recover meaningful workspace states later.

The core distinction is:

```text
Trace event = something happened
Checkpoint  = recoverable workspace state
```

The existing Agent Launchpad remains responsible for Agent CRUD, Playground chat, Runs, Codex execution, runtime containers, and persistent workspaces.

## BranchPoint UI

Added a toggleable BranchPoint panel to the Agent interface.

- Opens and closes from the Agent header.
- Uses a real layout column on desktop, shifting the Playground left.
- Stacks below the Playground on mobile.
- Contains History, Branches, Compare, and Settings.
- History, Branches, and Compare views are collapsible.
- Checkpoint actions appear only after selecting a checkpoint.


## Trace Events

Trace events are lightweight metadata records persisted in the JSON store and linked to an Agent and Run.

Current event types:

```text
run.started
codex.event
workspace.changed
checkpoint.created
run.completed
run.error
```

Each event includes:

- Event ID
- Agent ID
- Run ID
- Timestamp
- Event type
- Human-readable explanation
- Event-specific metadata

The system does not capture private hidden chain-of-thought. It captures only observable activity reported by Codex and verified workspace changes.

## Observable Codex Activity

Both local-process and container runners use `codex exec --json`.

The Codex parser preserves bounded observable events such as:

- Tool activity
- Commands
- File operations when exposed by the protocol
- Tests
- Status changes
- Bounded command or tool output
- Agent messages
- Thread ID
- Token usage
- Errors

These are persisted as `codex.event` trace records.

## Workspace Mutation Detection

`WorkspaceHistory` scans the live Agent workspace before and after each Run.

It calculates:

- File paths
- File sizes
- File modes
- SHA-256 content hashes
- A deterministic workspace hash

It detects:

- Created files
- Modified files
- Deleted files

The filesystem is authoritative. Codex's final message prompt is not treated as proof of what changed.

## Automatic Checkpoints

A checkpoint is automatically created when a Run produces meaningful workspace changes.

A successful Run with no meaningful mutation creates no checkpoint, but the Run and its trace events remain visible in history.

Failed or cancelled Runs that partially mutate the workspace can create a `partial` checkpoint.

Each checkpoint stores:

- Agent ID
- Run ID
- Parent checkpoint ID
- Snapshot ID
- Context snapshot ID
- Workspace hash
- Created, modified, and deleted files
- Complete or partial status
- Automatic creation reason
- Timestamp

## Snapshot Storage

Snapshots are stored separately from live workspaces:

```text
.data/branchpoint/snapshots/<snapshot-id>/
  manifest.json
  files/
```

Snapshot creation uses a staging directory and atomic rename so incomplete snapshots are not published as usable checkpoints.

The manifest contains:

- Workspace hash
- File paths
- File sizes
- File hashes
- File modes
- Creation timestamp

## Observable Context Snapshots

When a checkpoint is created, BranchPoint stores observable Agent context:

- Agent name
- Agent description
- Agent instructions
- User messages
- Assistant messages
- Run output
- Source Codex thread ID
- Run relationship

The thread ID is retained as provenance. Branching from a checkpoint forks the
underlying Codex session transcript at the exact line offset recorded when
that checkpoint was captured (see `codex-session-fork.ts`), so the new branch
resumes with full native Codex context up to that point and none of the
turns that happened afterward. If the source rollout file or its offset is
unavailable (older checkpoints, missing session files), the branch falls back
to a fresh thread with no prior context.

## History View

History combines two kinds of entries:

### Checkpoint entries

Prominent entries representing recoverable workspace states. They display:

- Checkpoint number
- Timestamp
- Source Run
- Automatic or explicit origin
- Number of changed files
- Changed file paths

### Run entries

Lighter entries for Runs that did not create checkpoints. They display:

- Run status
- Timestamp
- Run ID
- Original prompt

This ensures non-mutating prompts remain visible without incorrectly treating them as checkpoints.

## Checkpoint Inspection

Selecting a checkpoint reveals four actions:

- `Branch from here`: currently reports that branching is not available yet.
- `Restore in new branch`: currently reports that restore is not available yet.
- `View diff`: implemented and compares the checkpoint with its immediate parent.
- `View details`: implemented and displays provenance and execution information.

### -> View diff

Displays:

- Created files
- Modified files
- Deleted files
- Clear empty states

The diff view uses an aligned two-column layout with category separators and stable file rows.

### -> View details

Displays:

- Run ID and status
- Checkpoint status
- Agent context metadata
- Source Codex session ID
- Original Run instruction
- Agent result
- Observable conversation snapshot
- Trace events and explanations
- Observable Codex event metadata
- Full workspace hash for verification


## Settings Documentation

The BranchPoint Settings popup explains:

- What trace events capture
- What checkpoint records capture
- How records and snapshots are stored
- That hidden chain-of-thought is excluded
- That unchanged Runs do not create checkpoints
- That observable Codex activity is bounded and persisted as metadata



## Remaining Work

Not implemented yet:

- Independent branches
- Workspace restoration
- Branch workspace materialization
- Three-way merge
- Merge approval flow
- Multi-user identity
- Repository membership
- Live streaming of trace events during a Run
- Explicit user-named checkpoints

The current implementation provides the foundation for these features without replacing the existing Launchpad execution platform.

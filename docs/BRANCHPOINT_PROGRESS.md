# BranchPoint Status and Verification

## Product direction

BranchPoint is middleware for observable autonomous-Agent execution. It gives a
user evidence of what ran, detects what changed on disk, captures recoverable
states, and lets later work continue in an independent branch.

```text
Trace event = observable execution evidence
Checkpoint  = recoverable workspace state
Branch      = independent workspace and execution lineage
```

It extends rather than replaces the starter baseline: Agent CRUD, lifecycle,
Playground chat, persistent messages/workspaces, and Codex model execution
remain handled by the Launchpad control plane and Runtime.

## Implemented behavior

### Observable traces

Both Runtime providers invoke `codex exec --json`. Bounded observable activity
is persisted as `codex.event` records alongside control-plane events:

```text
run.started
codex.event
workspace.changed
checkpoint.created
run.completed
run.error
```

Live trace events are delivered through an authenticated Server-Sent Events
endpoint. The endpoint resolves the Run and checks access to its Agent before
opening the stream.

### Filesystem-derived checkpoints

`WorkspaceHistory` calculates a deterministic manifest from file paths, sizes,
modes, and SHA-256 content hashes. It detects created, modified, and deleted
files. A meaningful successful change creates a complete automatic checkpoint;
a failed or cancelled Run that changed files can create a partial checkpoint.
Unchanged Runs remain in history without being mislabeled as checkpoints.

Users can also save a named checkpoint. An unchanged named checkpoint reuses
the latest immutable snapshot while recording a new lineage marker.

### Inspection and restoration

Checkpoint details expose the associated Run, bounded observable context,
trace events, snapshot manifest, and workspace hash. Comparison shows the
created/modified/deleted files and bounded content hunks relative to the parent.

Restoration materializes a snapshot under
`data/branchpoint/restores/<checkpoint>-<timestamp>`. It does not overwrite the
source Agent workspace. The API checks access to the checkpoint's Agent before
materializing the restored files.

### Independent branches and persistent threads

Creating a branch restores the selected checkpoint into
`<agent-workspace>/branches/<branch-id>`. Project parent and child branches stay
inside their respective project workspaces.

The checkpoint records the source Codex rollout path and exact line offset. If
that source is available, `codex-session-fork.ts` copies only the transcript up
to the checkpoint, registers a new thread, and starts the branch with that
thread. Later messages on the branch resume the branch's own stored thread ID.
If the source transcript is missing or predates offset capture, creation falls
back to a fresh branch thread rather than pretending context was restored.

Branch history includes the source lineage only up to the checkpoint where it
forked; subsequent main or ancestor turns do not leak into the branch.

## API authorization and verification strategy

Core middleware tests are split by boundary:

- Service tests directly verify hashing, snapshot integrity, lineage,
  concurrency, session forking, and persistence invariants.
- Fastify API tests use `app.inject()` with separate user bearer tokens. Each
  protected resource should have both an allowed owner/member request and a
  cross-user request that expects `403`.
- Runtime command tests verify container mounts, limits, new-thread arguments,
  and resume-thread arguments without needing live model credentials.

The BranchPoint end-to-end API test covers:

1. Create two demo users and one Agent owned by the first user.
2. Run the Agent to produce an automatic checkpoint.
3. Verify the second user cannot branch from that checkpoint.
4. Create a branch as the owner and run two messages on it.
5. Assert the second branch message receives the thread ID returned by the
   first branch message.
6. Verify owner success and cross-user denial for Run details and trace SSE.
7. Verify owner success and cross-user denial for checkpoint restoration.

The native session-fork test separately creates a realistic Codex SQLite index
and rollout JSONL, captures a checkpoint offset, appends a later source turn,
forks the thread, and proves the new rollout includes the earlier turn but not
the later one.

## Meaningful demo path

1. Run an Agent task that creates or edits a file; show the live trace and
   automatic checkpoint.
2. Save a named checkpoint, make another change, and show the comparison.
3. Branch from the earlier checkpoint and give the branch a different task;
   show that main remains unchanged and the branch continues its own thread.
4. Sign in as another demo persona and show a denied Agent/branch request plus
   the resulting audit entry.
5. Archive a project and show that reads remain available while writes are
   denied; unarchive it and show recovery.

## Not implemented

- Three-way merge of a branch back into its source workspace
- Applying approved member commit requests to canonical project `main`
- Conflict detection and conflict-resolution UI
- Production authentication, token rotation/expiry, and tenant isolation

## Future merge API tests

Merge tests should be added only with real merge behavior. A coherent suite
should establish a base checkpoint, diverge source and branch workspaces, call
the merge endpoint, and verify filesystem hashes rather than only response text:

- clean merge: non-overlapping branch changes appear in source and the proposal
  becomes `merged`;
- authorization: a non-owner receives `403` and neither workspace changes;
- conflict: overlapping edits produce a conflict response and source remains
  byte-for-byte unchanged;
- stale proposal: source changes after proposal creation and merge is rejected;
- idempotency: a merged/rejected proposal cannot be applied twice;
- persistence: restart the service and prove proposal status and resulting
  workspace hashes remain consistent.

Until those exist, the UI and documentation must not claim that approval merges
changes into `main`.

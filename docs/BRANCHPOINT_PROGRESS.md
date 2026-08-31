# BranchPoint Progress and Verification

## Product scope

BranchPoint is the post-starter-kit middleware layer for observable,
recoverable, branchable, and reviewable Agent work. It wraps the existing
Launchpad control plane and Codex Runtime rather than replacing the baseline
Agent product.

The starter baseline remains available:

- Agent CRUD, lifecycle controls, deletion, and multi-turn Playground chat;
- persistent users, messages, runs, workspaces, and Codex thread IDs;
- host-process and disposable container execution; and
- bounded prompts, output, duration, cancellation, and resumable turns.

## Implemented BranchPoint features

### Observable execution

Both Runtime providers run `codex exec --json` and persist bounded activity as
trace records alongside control-plane events:

```text
run.started
codex.event
workspace.changed
checkpoint.created
run.completed
run.error
```

Run details and authenticated Server-Sent Events expose observable progress,
workspace effects, usage metadata, and errors. Hidden chain-of-thought is not
captured. Trace and Run access is checked against the owning Agent before data
is returned.

### Workspace history and checkpoints

`WorkspaceHistory` calculates deterministic manifests from relative file paths,
sizes, modes, and SHA-256 content hashes. It detects created, modified, and
deleted files while excluding platform-owned directories such as `branches/`,
`.codex`, `node_modules`, and `dist`.

- A meaningful successful change creates a complete immutable checkpoint.
- A failed or cancelled Run that changed files can create a partial recovery
  checkpoint.
- An unchanged Run remains in history without being mislabeled as a checkpoint.
- A user can create a named checkpoint; unchanged named checkpoints may reuse
  the latest immutable snapshot with a new lineage marker.
- Details include the associated Run, bounded trace, snapshot manifest, and
  workspace hash.
- Comparison reports created, modified, and deleted files plus bounded content
  hunks against the parent snapshot.

### Restoration and recovery

Restoration materializes a snapshot under the BranchPoint recovery directory,
stages a replacement workspace, verifies the resulting manifest, and publishes
the replacement atomically. It preserves platform-owned branch directories,
keeps a timestamped recovery copy, and rolls back to the previous workspace if
publication or verification fails. Restoration is rejected while the affected
Agent or branch is running.

### Independent branches and context

Creating a branch restores a selected checkpoint into an independent workspace.
Each branch has its own status, Runs, messages, lineage, and Codex thread.
Project parent and child branch directories remain inside their respective
project workspaces.

When a checkpoint contains usable Codex rollout metadata, the source transcript
is forked exactly at the recorded line offset. The branch receives only the
conversation visible through that checkpoint. Later source/main turns do not
leak into the branch. If rollout data is missing or predates offset capture,
the system safely starts a fresh branch thread instead of claiming context was
restored.

### Collaboration projects

A project contains one canonical parent Agent and one isolated child Agent per
active member. A standalone Agent can be upgraded into a project parent while
preserving its identity, workspace, messages, Runs, checkpoints, branches, and
Codex threads. The upgrade stages and verifies the project copy before
publishing project metadata.

Project lifecycle features include membership invitations and acceptance,
member roles, activity history, owner transfer, archive/unarchive, leave, and
deletion. Archived projects remain readable but freeze ordinary writes and
execution until unarchived.

### Authorization and audit

The Web UI can hide controls for usability, but the Fastify API and service
layers are authoritative. User bearer tokens resolve the acting human and each
resource/action is checked before mutation.

| Operation | Rule |
| --- | --- |
| Standalone Agent | Only its owner can operate it. |
| Project parent Agent | The project owner controls it. |
| Child Agent | Its member owner can operate it; the project owner can administer project resources. |
| Child branch → child main | The child Agent owner can merge their own branch. |
| Child Agent → parent main | Project owner only. |
| Child security review/request | The child Agent owner only. |
| Request approval/rejection/resolution | Project owner only. |

Denied requests return `403` and create an audit record. Archive and Run-state
guards prevent unsafe mutation during project freeze or concurrent execution.

### OWASP security gate and commit requests

The member workspace is compared with project `main`, and only created or
modified file content is reviewed:

1. No changes pass with a model request; the no-change path is trivially
   passing and consumes zero model calls.
2. Obvious lexical findings fail locally with zero model tokens.
3. Otherwise one bounded direct Ark request returns all ten OWASP Top 10
   category verdicts as JSON, without Agent tools or conversation history.

Input is capped per file and in total. Auto-fix accepts complete file rewrites
only and reruns the gate. A pass is bound to the exact workspace hash, so any
subsequent change makes it stale.

A member can submit a request only with a current passing gate. The owner can
approve, reject, or continue into merge review:

- clean approval calls the shared merge engine and atomically marks the request
  `merged`;
- a conflict returns a preview, leaves the request `pending`, and does not
  modify the parent workspace;
- explicit resolution applies the merge and completes the request; and
- rejection marks the request `rejected` without changing any workspace.

### Causal three-way merge

`MergeEngine` compares target and source against their common checkpoint. It
automatically applies clean non-overlapping changes. Real overlapping file
changes produce workspace conflicts with target, source, and base content.

Prompt conflicts are causal, not textual heuristics:

- each conversation commit is tied to its Run and checkpoint;
- checkpoint changes record changed file paths;
- only prompts attributed to a conflicting file are linked to that conflict;
- similar wording, a shared conversation anchor, unrelated files, and code-free
  prompts do not create prompt conflicts; and
- missing attribution remains a visible workspace conflict without inventing a
  prompt conflict.

### Resolution, acceptance criteria, and provenance

The final code decision controls the conversation history:

- selecting target keeps target prompts;
- selecting source keeps source prompts;
- mixed file decisions keep both attributed prompt sets and mark the result
  combined; and
- a prompt cannot be retained when its implementation was not selected.

AI side selection is valid only when the selected complete side satisfies every
acceptance criterion. If neither side satisfies all criteria, AI must choose
`COMBINED` and return a complete validated file body, merge instruction, and
explanation. Clean three-way merges are also marked combined when both sides
contributed to the resulting file.

Combined results with available attribution persist a dedicated merge-history
event containing the affected files, target/source prompts, merge instruction,
and resulting explanation. The Web merge review and application history render
this event. It is excluded from prompt-conflict detection and from the native
Codex rollout; only real prompts and responses are sent to the next Agent turn.

### Reconstructed threads

Because native Codex rollout files are append-oriented, a merged context is
represented by a newly registered thread rather than surgical edits to the old
thread. `rebuildSessionFromTimeline` copies the selected real conversation
blocks, excludes merge-history events from native prompts, and explicitly sets
the new thread's `cwd` to the merged workspace path. The persisted workspace,
application timeline, and provenance remain authoritative if rollout metadata
is unavailable.

## Verification strategy

The implementation is tested at service, API, filesystem, Runtime, and Web
boundaries:

- service tests cover manifests, hashes, snapshots, persistence queues,
  authorization, lineage, session forking, merge decisions, and rollback;
- Fastify `app.inject()` tests use separate bearer tokens and assert both
  permitted and cross-user `403` paths;
- Runtime tests verify mounts, limits, argv, resumable threads, and cancellation
  without live model credentials;
- merge tests verify clean three-way changes, causal attribution, target/source/
  combined decisions, strict AI criteria, provenance, request transitions,
  conflict previews, stale protection, and atomic rollback; and
- the Web build/type-check validates merge review, provenance, request feedback,
  and reconstructed-thread UI contracts.

Run the complete gate with:

```bash
npm run check
```

This runs server and Web TypeScript checks, production builds, and the full
server test suite. The tests use mocks/fixtures and do not require Ark secrets,
an external network, or a running Docker daemon.

## Known limitations

- Demo identity and generated bearer tokens are not production authentication.
- `JsonStore` is single-process JSON persistence, not a distributed database.
- Runtime containers are resource-limited but not hardened tenant isolation.
- The OWASP gate is a focused pre-commit control, not a complete security audit.
- Native Codex transcripts cannot be surgically rewritten; merges create a new
  thread when reconstruction is possible.
- Reconstruction is best-effort if rollout files or offsets are missing.
- The POC does not provide distributed locks, remote object storage, or hosted
  multi-node collaboration.

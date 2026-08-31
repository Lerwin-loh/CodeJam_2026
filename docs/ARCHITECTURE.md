# Architecture

Volc Agent Launchpad is a single-node control plane with two product modes:
standalone Agents for individual work and collaboration projects containing
one owner-controlled parent Agent plus one child Agent per active member.
BranchPoint is the middleware layer that adds observable execution,
recoverable workspace history, isolated branches, security-gated handoff, and
causal merge behavior around the starter Agent experience.

![Whole BranchPoint architecture](branchpoint-architecture.svg)

The editable source is [branchpoint-architecture.mmd](branchpoint-architecture.mmd).
It shows the authenticated Web/API boundary, BranchPoint services, persistent
state, project handoff, merge review and provenance, reconstructed Codex
sessions, security analysis, and both local and ECS Runtime profiles.

## Responsibility boundaries

### React Web UI

The UI selects the demo user, stores that user's generated bearer token in
local storage, renders Individual and Collaboration modes, and calls the API.
It presents Playground chat, run traces, checkpoints, comparisons, restoration,
branches, project membership, security results, commit requests, merge review,
provenance, and application history. UI restrictions are only for usability;
the server rechecks every permission. The Ark API key is never returned to the
browser.

### Fastify API

The API validates route parameters and JSON bodies, resolves bearer tokens to
users, applies body-size limits, and maps service errors to HTTP responses.
Resource routes resolve the owning Agent or project before invoking service
authorization. Protected operations include Agent lifecycle, chat, runs,
traces, checkpoints, restoration, branches, project membership and lifecycle,
security checks, commit requests, merge preview/resolution, and request
decisions.

### AgentService

`AgentService` owns Agent lifecycle, asynchronous Run state, messages, Codex
thread IDs, trace subscriptions, checkpoints, branches, verified restoration,
Agent-level branch merges, reconstructed sessions, and audit entries for Agent
decisions.

Only one Run is admitted for a main workspace or branch at a time. A stopped
Agent rejects prompts. On restart, interrupted Runs become `cancelled` and
busy Agents return to `ready`.

Agent-level merge authorization is distinct from project-level authorization:

- an Agent owner can merge their own branch into that Agent's main;
- a project member can operate and merge only their own child Agent's branch;
- the project owner can access project Agents for administration; and
- an Agent-level merge never publishes a child Agent into the project parent.

### ProjectService

`ProjectService` owns project membership, owner/member/member-own policies,
canonical parent `main`, isolated member workspaces, project lifecycle, member
security analysis, commit requests, project-level merges, and standalone-Agent
upgrade.

Project-level child-to-parent merge preview, AI resolution, manual resolution,
and application are owner-only. A member can submit work but cannot publish it
to the canonical parent tree.

A commit request requires an OWASP pass bound to the member workspace's current
hash. Clean owner approval delegates to the same merge engine used by manual
project merges and marks the request `merged` in the same persisted mutation.
A conflicting approval returns the preview, leaves the request `pending`, and
lets the owner finish in merge review. Rejection only changes the request to
`rejected`.

### MergeEngine

`MergeEngine` is the shared three-way merge path for Agent-branch and project
merges. It compares target and source manifests against a common checkpoint
and stages file changes before publication.

The merge pipeline is:

1. Resolve the target, source, merge base, and current workspace hashes.
2. Build a three-way file preview for created, modified, deleted, and
   overlapping paths.
3. Attribute conversation commits to their checkpoint and changed paths.
4. Link prompt conflicts only to prompts that changed a file with a real code
   conflict.
5. Validate manual or AI target/source/combined decisions against the complete
   acceptance criteria.
6. Materialize selected file bodies in staging and verify the resulting
   manifest.
7. Persist the snapshot, selected conversation, merge provenance, and request
   status as one application mutation.
8. Rebuild a Codex thread from selected real conversation blocks when rollout
   metadata is usable, with `cwd` set to the merged workspace.

Prompt wording, shared conversation anchors, unrelated file changes, and
code-free prompts cannot create prompt conflicts. Missing attribution remains a
workspace conflict without invented prompt attribution.

### WorkspaceHistory and BranchPoint

The filesystem is authoritative for code. `WorkspaceHistory` hashes relative
file paths, content, modes, and sizes with SHA-256 before and after each Run.
Meaningful changes create immutable snapshots through staging-directory creation
and atomic rename. Branch directories and other platform-owned directories are
excluded from recursive manifests.

BranchPoint stores bounded observable events from `codex exec --json`, verified
workspace mutations, output metadata, user/assistant messages, contexts,
checkpoints, and merge-history events. It does not store private hidden
chain-of-thought.

Restoration creates a verified recovery copy under the BranchPoint data root,
then uses a staged, hash-verified filesystem swap with rollback on publication
failure. Creating a branch materializes the selected snapshot into an
independent workspace and forks the Codex rollout at the recorded checkpoint
offset when possible.

### Runtime providers

- `ContainerCodexRunner` starts one disposable Docker/Podman-compatible
  container per local turn with selected-workspace and Codex-home mounts,
  resource limits, dropped capabilities, and `no-new-privileges`.
- `CodexRunner` starts Codex as a child process for host development or ECS.

Both use argv-based execution, bounded output and duration, resumable thread
IDs, cancellation, and termination escalation. Security classification is a
separate direct `arkClassify` path with no Agent loop, tools, or conversation
history.

### JsonStore

`JsonStore` serializes mutations through one in-process queue and persists a
temporary JSON file before replacement. It stores users, Agents, projects,
membership, Runs, messages, traces, checkpoints, contexts, security verdicts,
commit requests, branches, and audit entries.

## Core state flows

### Agent run

```text
prompt
  → authorization and run admission
  → Runtime executes in selected main/branch workspace
  → observable trace events
  → before/after manifest comparison
  → checkpoint/context persistence
  → assistant response and resumable thread ID
```

Run states are `queued → running → completed|failed|cancelled`; Agent states
are `ready`, `busy`, `stopped`, or `error`.

### Branch creation

```text
checkpoint
  → access check
  → snapshot materialized into branches/<branch-id>
  → transcript forked at checkpoint offset, or fresh thread fallback
  → independent branch runs and history
```

The branch sees only source history through its fork point. Subsequent source
turns cannot leak into it.

### Member handoff

```text
child workspace
  → changed-file hash
  → OWASP gate
  → commit request
  → owner approval
  → MergeEngine
  → clean merge OR pending conflict preview
```

The OWASP verdict becomes stale whenever the child workspace hash changes.
Conflict approval never partially writes the parent workspace or marks the
request merged.

### Merge and context

Target and source code are resolved independently of conversation history. The
resulting conversation is derived from the file choices:

- target selection keeps target prompts;
- source selection keeps source prompts;
- mixed file choices keep both attributed prompt sets and create combined
  provenance; and
- a prompt cannot be selected when its code was not selected.

AI may choose a side only when that complete side satisfies every acceptance
criterion. Otherwise it must return `COMBINED` with a complete file body, merge
instruction, and explanation. Clean merges are marked combined when both sides
contributed. The merge event is visible in application history but excluded
from the native Codex rollout; the next Agent turn receives only real prompts
and responses plus the merged workspace path.

## Security and failure handling

The security gate reviews only bounded changed-file content. Static lexical
findings fail without consuming model tokens; otherwise a direct classifier
returns the ten OWASP category verdicts. Auto-fix accepts full-file rewrites
only and reruns the gate.

Merge and restoration operations stage filesystem changes, verify hashes,
persist metadata, and retain a rollback path until publication succeeds.
Failure returns a controlled error and leaves the previous authoritative state
intact. The Codex session index is a separate best-effort integration; if its
rollout data cannot be reconstructed, the persisted workspace and application
timeline remain authoritative.

## Data crossing boundaries

| Boundary | Data | Failure behavior |
| --- | --- | --- |
| Browser → API | Generated user token, validated JSON, resource IDs, merge decisions | `401` for identity failure; `400`/`413` for invalid or oversized input |
| API → authorization services | Human principal, action, Agent/project/member ID | `403` with audit record for denial; `409` for archive, stale, or conflicting state |
| AgentService → Runtime | Workspace path, prompt, sandbox mode, resumable thread ID | Run becomes failed/cancelled; workspace mutation may yield a partial checkpoint |
| ProjectService → classifier | Bounded changed-file source and OWASP request | Static findings fail locally; model/parse failures close the commit gate |
| MergeEngine → workspace/history | Base/target/source manifests, selected bodies, attribution, provenance | Conflict preview or rollback; no partial merge publication |
| Services → JsonStore | Structured metadata, messages, traces, audit, requests | Serialized persistence; failed publication is not treated as committed |
| Runtime → Ark | Model request and server-side credential | Configuration failure is controlled; timeout/output limits terminate the Run |

## Persistent layout

```text
data/launchpad.json
data/branchpoint/snapshots/<snapshot-id>/
data/branchpoint/restores/<checkpoint-id>-<timestamp>/
workspaces/<standalone-agent-id>/
  branches/<branch-id>/
workspaces/projects/<project-id>/
  main/
    branches/<parent-branch-id>/
  members/<member-id>/
    branches/<member-branch-id>/
workspaces/.deleted/
codex-home/
```

## Deployment profiles and limitations

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable local container |
| Local development | Host Node.js | Host Codex process |
| ECS | Application container | Codex process in the same container |

The trust boundary is the local host/container or ECS instance. Demo identity
and generated bearer tokens are not production authentication, and Runtime
containers are not hardened multi-tenant isolation. `JsonStore` is designed
for one control-plane process, not distributed writers. Codex rollout files are
append-oriented, so merged context requires a new reconstructed thread instead
of surgical transcript edits. See [SECURITY.md](../SECURITY.md) before using
the POC with any data.

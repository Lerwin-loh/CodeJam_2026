# Merge, Conflict, and Thread Behavior

This document describes the merge and conversation behavior implemented in the current `feat/merge-logic` branch.

## Terminology

- **Parent agent**: the project owner's agent in project mode. Its workspace is the project's canonical `main`.
- **Child agent**: a project member's agent and workspace.
- **Target**: the workspace receiving the merge, usually `main`.
- **Source**: the branch or child workspace being merged.
- **Merge base**: the checkpoint snapshot from which the source branch was created.
- **Prompt**: a user message paired with the agent run and response that produced it.

## Agent and branch permissions

There are two merge scopes:

| Operation | Authorized users |
| --- | --- |
| Child branch → that child agent's own main | The child-agent owner or project owner |
| Child agent / child branch → project parent agent's main | Project owner only |
| Preview, AI resolution, or manual application of a project-level merge | Project owner only |

The agent-level routes use `branch.merge` authorization. An agent owner can merge their own branches, and the project owner can access agents in the project. A different project member cannot merge another member's child branch.

Project-level routes use project-owner authorization. A child-agent owner cannot merge their child agent into the parent agent's main through those routes.

Archived projects freeze mutating agent and branch operations, including branch creation, deletion, merging, checkpoint creation, and checkpoint restore.

## Three-way workspace merge

The merge engine compares target and source against the merge-base snapshot. It evaluates every file except platform-managed `AGENTS.md`.

For each path:

1. If only one side changed relative to the base, that side's change is retained.
2. If both sides changed to the same content, the shared content is retained.
3. If both sides changed different content, the engine attempts a real three-way merge.
4. A clean three-way result is applied automatically.
5. A textual conflict becomes a workspace conflict requiring an explicit decision.

Workspace conflict records include the path and target, source, and base content. Created, modified, and deleted paths are included in the merge preview.

The merge is staged in a temporary workspace and swapped into the target only after all decisions and validation succeed. On failure, the target workspace is restored from its backup and no partial merge is retained.

## Workspace conflict decisions

Every real workspace conflict must resolve to one of:

- `target`: use the target implementation for that file.
- `source`: use the source implementation for that file.
- `combined`: write the validated file body supplied by AI or by an explicit combined resolution.
- `ai`: ask the isolated merge resolver to choose `target`, `source`, or `combined`.

For `combined`, the response must contain:

- complete file content, not a patch;
- a non-empty merge instruction describing how both implementations were combined;
- a non-empty explanation.

Combined content is size-validated and is written exactly as returned. Missing or invalid combined content fails safely before application.

AI must verify every combined acceptance criterion against the actual target and source implementations. `TARGET` or `SOURCE` is valid only when that complete implementation satisfies every criterion. If neither side satisfies every criterion, or the criteria are split between the sides, AI must choose `COMBINED`.

The UI supports selecting different decisions per file, so a merge can retain target code in one file, source code in another, and combined code in a third.

## Prompt and context conflict detection

Prompt conflicts are causal, not wording-based.

Each conversation commit is associated with:

- its run;
- the run's checkpoint;
- the checkpoint's changed file paths.

A prompt conflict is created only when:

1. both target and source have an actual code/workspace conflict for a path; and
2. both sides have attributed prompts whose runs changed that conflicting path.

The following do not create prompt conflicts by themselves:

- similar prompt wording;
- shared or matching conversation anchors;
- prompts that changed no files;
- prompts that changed unrelated files;
- missing prompt attribution.

Missing attribution still leaves the workspace conflict visible and resolvable; the system does not invent a prompt conflict.

For semantic identity checks, such as login identity code, the semantic check is supplemental only. It runs only when a real file-level conflict exists and both sides changed attributed identity-related paths.

When multiple prompts contributed to a conflicting file, all linked target and source prompts are preserved in the preview. A prompt affecting multiple files can participate in a combined result when those files resolve to different sides.

## Prompt history rules after merge

The merged application timeline is derived from workspace decisions:

- target-selected code retains the target prompt set;
- source-selected code retains the source prompt set;
- mixed selections retain both relevant prompt sets;
- combined selections retain both prompt sets and record combined provenance.

Prompt selection cannot contradict the selected code. A prompt is not copied merely because its wording resembles a prompt on the other side; it must be causally linked to a changed path or be part of the selected conversation timeline.

The final conversation is rebuilt in merge-base order. Post-base target and source turns are inserted according to their selected conflict side, while non-conflicting turns from both sides are retained.

## Merge provenance

When both sides contribute to a result, the system records a dedicated merge-history event containing:

- affected file paths;
- target prompts;
- source prompts;
- the merge instruction;
- the resulting explanation;
- whether the result was automatic or AI-generated.

Automatic clean three-way merges are marked combined when the resulting content differs from both target and source, indicating that both sides contributed. AI-combined files are marked with the AI merge instruction and explanation.

Provenance is rendered in merge review and in application history. It is stored as a message with `kind: "merge"` and is excluded from normal prompt extraction, so it is not treated as a native user prompt or response.

## Commit requests

Before submission, a child workspace must pass the OWASP gate for its current workspace hash. Any workspace change makes the previous analysis stale.

Owner decisions behave as follows:

- **Reject**: atomically marks the request `rejected`; no workspace is changed.
- **Approve, conflict-free**: invokes the same merge engine used by manual project merges, applies the merge to the parent agent's canonical main, and atomically marks the request `merged`.
- **Approve, conflicting**: returns a merge-conflict preview and leaves the request `pending`; no workspace or request status is partially changed.
- **Explicit conflict resolution**: the owner uses the existing merge-review flow, after which the merge and request status update occur together.

The merge application, snapshot creation, parent conversation replacement, provenance event, parent thread update, and request status update are handled as one persistence operation with filesystem rollback on failure.

## Thread and chat reconstruction

The existing Codex thread is not surgically edited. Codex rollout history is append-oriented, so the system creates a new registered thread when it can reconstruct one safely.

Reconstruction works by:

1. taking the target thread's session metadata and transcript through the merge-base checkpoint;
2. finding each selected target/source user turn in its original rollout;
3. copying the corresponding turn blocks in the merged conversation order;
4. writing a new rollout with a new thread ID;
5. registering that thread in Codex's state database;
6. explicitly setting the reconstructed thread's `cwd` to the merged target workspace path.

The target session supplies model, sandbox, approval, title, and other session settings when available. If the target has no usable session, the source session can provide the registration template.

The new thread contains the selected previous prompts and responses, so a later agent turn can answer questions about the reconstructed conversation. Merge-history provenance is visible in the application UI/history but is intentionally excluded from the native Codex transcript sent as conversational prompts.

If rollout files, offsets, metadata, or required turn blocks are unavailable or inconsistent, reconstruction fails safely and the application still retains its persisted merged timeline and workspace result; the stored thread ID is cleared rather than pointing to an invalid context.

## UI behavior

The merge review presents:

- target and source outcomes;
- combined acceptance criteria;
- code-linked prompt provenance cards;
- per-file target/source/AI/combined decisions;
- AI explanations and combined merge instructions;
- merge provenance in review and history.

The final action is labeled `Merge`. There is no separate compare tab.

## Main implementation locations

- Server merge engine: `apps/server/src/merge-engine.ts`
- Server merge/project orchestration: `apps/server/src/agent-service.ts` and `apps/server/src/project-service.ts`
- Authorization and routes: `apps/server/src/app.ts`
- Codex session reconstruction: `apps/server/src/codex-session-fork.ts`
- Shared server types: `apps/server/src/types.ts`
- Merge review UI: `apps/web/src/MergeReview.tsx`
- Project merge UI: `apps/web/src/ProjectsView.tsx`
- Individual branch merge UI: `apps/web/src/IndividualDashboard.tsx`

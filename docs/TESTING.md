# Testing and Automated Verification

This document inventories the automated tests in the repository and separates
user-observable behavior from internal system behavior.

## Test commands

Run the complete verification gate:

```bash
npm run check
```

The command runs these stages in order:

```text
TypeScript checks -> Web/API production builds -> all server tests
```

Run only the automated tests:

```bash
npm test
```

Run one test file while developing:

```bash
npm test -- --run src/app.test.ts
```

Vitest automatically discovers every `*.test.ts` file under
`apps/server/src`. The current suite contains **93 tests in 9 files**.

## Classification

### User tests

User tests verify behavior observable through the API or product workflow. They
cover successful actions, validation, authorization denials, conflicts, and
recovery. Fastify tests call the real HTTP handlers with `app.inject()`; service
tests exercise the same domain services without rendering the React UI.

#### HTTP and API boundary — `app.test.ts`

1. **Rejects API requests without a valid user token** — verifies missing and
   invalid credentials return `401` while a generated user token is accepted.
2. **Lets anyone create or resume a user without a token** — documents the
   current demo-persona entry flow.
3. **Preserves Fastify client error status codes**
    — verifies malformed and oversized requests remain `400` and `413` responses.
4. **Scopes projects per user, denies cross-user access to project Agents, and records the decision**
    — exercises project/Agent isolation and audit records through the HTTP boundary.
5. **Protects branch, Run, trace, restore, and branch-deletion resources and resumes a branch thread**
   — verifies owner success, cross-user `403` responses, branch creation and deletion, trace streaming, restoration, and persistent branch thread IDs.
6. **Deletes an account and all dependent resources without affecting another user's remaining work**
   — verifies owned projects, standalone and child Agents, memberships, execution
   history, snapshots, audit records, and the old bearer token are removed while
   projects owned by another user remain available.

#### Agent and BranchPoint behavior — `agent-service.test.ts`

7. **Creates, updates, stops, starts, and deletes an Agent** — preserves the
   starter lifecycle baseline.
8. **Persists a Playground conversation** — stores user/assistant messages and
   the resumable Codex thread ID.
9. **Automatically checkpoints meaningful workspace mutations** — derives a
   checkpoint from a real file change rather than an Agent success message.
10. **Saves an explicit user-named checkpoint from the current workspace** —
   covers unchanged markers and changed snapshots.
11. **Rejects an explicit checkpoint before the Agent has run** — verifies the
    `409` failure path.
12. **Exposes checkpoint details and a parent comparison** — verifies context,
    traces, and changed-file evidence.
13. **Keeps a recovery copy and restores a checkpoint into active main** —
    proves newer files are reverted while platform-owned branch data survives.
14. **Creates an independent branch workspace and records branch provenance** —
    proves branch changes and branch restores do not mutate main.
15. **Recoverably deletes leaf branches without orphaning branch lineage** —
    archives branch files, removes branch-scoped history, preserves main, and
    rejects deleting a parent until its child branches are removed.
16. **Rejects an active-workspace restore while the Agent is running.**
17. **Atomically accepts only one concurrent Run per Agent** — verifies one
    request succeeds and the competing request receives `409`.
18. **Does not let start reset a busy Agent and admit a second Run** — protects
    the lifecycle/concurrency invariant.
19. **Finds or creates a user by name and resolves it by token** — verifies the
    current demo-user persistence model.
20. **Scopes Agents to their owner and denies cross-user access** — verifies
    ownership checks and denied-attempt audit visibility.

#### Collaboration projects — `project-service.test.ts`

21. **Creates a project with a parent Agent and a head snapshot.**
22. **Upgrades a standalone Agent into a project without losing its workspace,
    Agent identity, messages, Runs, checkpoints, branches, or Codex threads.**
23. **Rejects unauthorized, busy, and repeated standalone-Agent upgrades.**
24. **Adds a member with their own full-copy workspace and child Agent.**
25. **Stores parent and member branches inside their respective project
    workspaces.**
26. **Rejects adding an unknown user, the owner, or a duplicate member.**
27. **Updates a member's role and keeps child-Agent instructions in sync.**
28. **Removes a member and their child Agent.**
29. **Deletes a project, archives its workspaces, and removes linked metadata.**
30. **Deletes an orphaned project whose workspace directory is already
    missing.**
31. **Enforces the owner/member/member-own authorization floor.**
32. **Shows the owner the full roster and members only names and roles.**
33. **Lists and reads main files while blocking path traversal.**
34. **Lets members reach their own child Agent, lets the owner reach every child,
    and denies access to another member's child.**
35. **Scans a member workspace, files a commit request, and lets the owner
    decide it.**
36. **Keeps the commit gate closed when an OWASP category fails.**
37. **Invalidates a passing security result after the member workspace changes.**
38. **Rejects a commit request when the member workspace matches main.**
39. **Chooses the cheapest security-analysis path** — verifies no-change and
    static-finding paths use zero model calls while a clean diff uses one scoped
    request containing only changed files.
40. **Auto-fixes a flagged file with one direct model call and no Agent Run.**
41. **Freezes writes while a project is archived and restores them after
    unarchive.**
42. **Runs a member's child Agent in that member's workspace.**
43. **Merges selected sub-branches into their trunk workspace and removes the
    merged branch records and folders.**
44. **Completes a branch merge when an old branch folder is already missing.**

<!-- The merge-engine entry is documented below with the system tests.

#### Merge engine — `merge-engine.test.ts`

63. **Verifies shared causal three-way merge behavior** — covers clean
    non-overlapping merges, workspace and prompt conflicts, semantic identity
    conflicts, target/source/combined decisions, strict AI criteria validation,
    invalid combined-output rejection, merge provenance, and conversation
    reconstruction without partial application.

-->
### System tests

System tests verify middleware internals and infrastructure adapters. They use
temporary directories, fake Runtime responses, real file operations, and a
temporary Codex SQLite/session layout. They do not require Ark credentials,
Docker, or network access.

#### Agent execution internals — `agent-service.test.ts`

45. **Streams Runtime events to live trace subscribers** — verifies the
    in-process trace subscription boundary.
46. **Migrates owner-less Agents to a demo user during initialization** —
    verifies backward-compatible persisted-data startup behavior.
47. **Keeps a standalone Agent usable when upgrade persistence fails** — injects
    a database-write failure after workspace staging and verifies that project
    metadata is not published and the original files remain available.
48. **Leaves the active workspace unchanged when checkpoint materialization
    fails** — verifies restore locking is released and newer files survive.

#### Workspace history — `workspace-history.test.ts`

49. **Hashes files, classifies changes, and materializes an immutable snapshot.**
50. **Ignores generated dependency and output directories.**
51. **Restores a snapshot into a workspace.**
52. **Rolls back the original workspace when active-restore verification fails.**

#### JSON persistence — `store.test.ts`

53. **Does not publish a mutation in memory when persistence fails** — verifies
    failed disk writes do not become committed application state and the write
    queue remains usable.
54. **Falls back when atomic database replacement is blocked** — injects a
    deterministic `EPERM` rename failure, then verifies real copy/unlink fallback
    persistence and temporary-file cleanup.

#### Codex process adapter — `codex-runner.test.ts`

55. **Builds a new-session Codex invocation.**
56. **Builds an invocation that resumes a stored Codex thread.**
57. **Extracts the session ID, final message, and token usage.**
58. **Captures bounded observable activity and error details without exposing
    unbounded output or private reasoning.**
#### Native Codex session forking — `codex-session-fork.test.ts`

59. **Captures a thread's current rollout offset and forks a truncated copy** —
    uses a real temporary SQLite index and JSONL rollout to prove later parent turns do not leak into a branch.
60. **Returns no fork source when a thread has no recorded session** — verifies
    the controlled fresh-thread fallback.

#### Container Runtime adapter — `container-codex-runner.test.ts`

61. **Builds an isolated Docker/Podman-compatible invocation** — checks the
    workspace mount, Codex-home mount, dropped capabilities, resource limits,
    user, network, and Runtime labels.
62. **Resumes a thread inside the mounted Runtime workspace.**

#### Merge engine - `merge-engine.test.ts`

63. **Verifies shared causal three-way merge behavior** - covers clean
    non-overlapping merges, workspace and prompt conflicts, semantic identity
    conflicts, target/source/combined decisions, strict AI criteria validation,
    invalid combined-output rejection, merge provenance, and conversation
    reconstruction without partial application.

## How this meets automated-verification requirements

The suite tests core middleware behavior rather than treating rendered UI as
proof:

- authorization decisions execute in the real Fastify/service path;
- messages, Runs, branches, checkpoints, audit entries, and thread IDs persist
  through the real JSON store;
- snapshots and restoration operate on real temporary files;
- native Codex session forking operates on a realistic SQLite/session layout;
- both success and denial/failure/recovery cases have assertions;
- tests are deterministic and safe to run on every commit without secrets.

A GitHub Actions workflow can run `npm ci` followed by `npm run check` on every
push and pull request. The workflow makes verification continuous, while the
tests above are the evidence that core middleware behavior is actually checked.

## Deliberately separate verification

The automated suite does not currently cover:

- live Ark model requests with production credentials;
- launching a real Docker or Podman Runtime container;
- browser rendering and interaction.

Use a manual local POC smoke test for live Ark/container execution. Add merge
conflict tests alongside future three-way merge behavior; the required future
cases are listed in [BranchPoint Status and Verification](BRANCHPOINT_PROGRESS.md#future-merge-api-tests).

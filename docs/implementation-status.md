# Implementation Status

The sole execution baseline is `../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md`
in the parent system workspace. This repository is a greenfield implementation
and does not copy the rejected legacy dashboard architecture.

## Current stage

Stage 6: Scheduler — completed locally on 2026-09-03.
Stage 7 (Release Acceptance) is next.

## Done

### Stage 6 — Scheduler

- Filled `packages/scheduler` with a dependency-free 5-field cron evaluator
  (lists, ranges, steps, Sunday 0/7) that finds the next occurrence in the
  configured IANA timezone (plan 16.1).
- Added SQLite task/run services in `packages/database`
  (`scheduler-service.ts`): task CRUD with `next_run_at` persistence, run rows
  with running/completed/failed/skipped states, restart recovery that marks
  crashed `running` runs as failed (plan 16.2), and run history reads.
- Added the `SchedulerEngine` in `apps/server`: a single timer for the
  nearest enabled task; each due task starts a fresh general Agent Session on
  its workspace, sends the prompt verbatim, waits for the turn to idle, and
  records completed/failed (plan 16.1). One workspace runs at most one agent
  turn at a time (plan 16.3); a busy workspace defers rather than duplicates.
  `POST /:id/run` (Run Now) is supported and surfaces a 409 when the
  workspace is busy. Restarts recompute future occurrences and never replay
  missed runs.
- Added scheduled task routes (plan 17.7): `GET/POST /api/scheduled-tasks`,
  `PUT/DELETE /:id`, `POST /:id/run`, and `GET /:id/runs`, wired into the
  runtime lifecycle (engine starts after the chat controller and closes with
  the app).
- Added the `/scheduled-tasks` web page: task list with next/last run and
  workspace, create form, enable/disable, Run now, Delete, and run history
  with status/error (plan 18).

### Stage 5 — Knowledge Repository

- Filled `packages/knowledge`: recursive Markdown tree scan that excludes
  `.git`/`node_modules`/`.loong` (plan 15.1), front-matter parsing and the
  stable `loongboard_id` (`doc_...`) serialization (plan 15.2), adoption of
  front-matter-less files on first LoongBoard save, atomic temp+rename
  writes (plan 15.3), and root-escape guards.
- Added SQLite indexing and history in `packages/database`
  (`knowledge-service.ts`): documents keyed by `loongboard_id` with unique
  path, content hash, and default session id; full-content versions pruned to
  the configured history window (default 10, plan 15.4); path moves update
  the index only, so the default chat mapping survives renames.
- Added the server `KnowledgeController` and routes (plan 17.6):
  `GET /api/knowledge/tree`, `POST /api/knowledge/documents` (new document
  writes the id front matter), `GET/PUT /api/knowledge/documents?path=`
  (read/adopt by repository path), `GET/PUT /:id`, `POST /:id/move`,
  `DELETE /:id`, `GET /:id/versions`, `POST /:id/versions/:versionId/restore`,
  and `POST /:id/chat` which ensures and persists the default session
  (plan 15.5). A recursive watcher plus a 1s debounce indexes external edits
  as `external` versions; changes made while a knowledge-scope agent session
  runs are aggregated and flushed as one `agent` version per document when the
  agent becomes idle (plan 15.4 aggregation).
- Added the Knowledge web page at `/knowledge/:documentId?`: file tree, a
  center document panel with Preview / Edit (plain Markdown source editor)
  / History + Restore, move and delete actions, a New-document form, and the
  default document chat rail (plan 18.3). Documents opened without an id are
  adopted on their first save and then redirect to their stable id URL.
- Knowledge content stays ordinary Markdown on disk; Git checkpoint/autoPush
  options remain off in V1 (documented limitation).

## Validated

- `CI=true pnpm check` passed on 2026-09-03 after Stage 5 (web build required
  a manually cleared `apps/web/dist` for the sandbox bulk-delete guard).
- New coverage: knowledge package front-matter/scan/atomic-write unit tests
  (6), and server Stage 5 route tests (create -> tree -> save -> versions ->
  move -> restore -> delete, plus front-matter adoption on first save). The
  whole workspace suite stays green (see counts under Stage 4 plus the
  additions above).

## Deferred validation and known limitations

- Live DSH smoke (real provider credentials), the two-repository real GitHub
  smoke, and browser-level E2E remain deferred to the Stage 7 release
  acceptance.
- Git checkpoint (`autoCommit`/`autoPush`) settings are not exposed yet;
  version history is stored in SQLite full-content snapshots, and Markdown
  stays plain on disk.
- Mermaid rendering and Monaco editing for Knowledge were simplified to the
  shared Markdown renderer and a plain source editor; raw HTML stays escaped.


### Stage 4 — DSH Agent Chat and Worktree Pool

- Added the vendor-neutral runtime contract in
  `packages/agent-runtime` (`AgentRuntime`, `AgentRuntimeEvent`,
  `AgentSessionSpec`) and the `AgentRuntimeHost` supervisor that owns one
  runtime per LoongBoard session, tracks running state, stops sessions on
  demand, and closes idle processes after `agent.idleProcessMinutes`
  (plan 13.1/19.4). Product code never imports DSH types.
- Implemented the DSH adapter in `packages/agent-runtime-dsh`: one pinned
  `DeepSeekHarness` subprocess per session with an isolated per-session
  `dsh-home` (plan 13.2/13.3), stop-by-process-termination cancel (plan
  13.4), runtime session id reuse for context resume, and a shape-driven
  `mapNotification` normalizer covering both the nested `session.event` wire
  shape and flat params. `DSH_PERMISSION_MODE=danger-full-access` is the
  default child environment (plan 3.5).
- Added `worktree-pool.ts` inside `packages/git-workspace`: detached worktree
  allocation follows the frozen order (exact-target reuse -> next free slot ->
  LRU clean non-busy recycle), `reset --hard` + `clean -fd` only, no `-x`,
  and a clear exhaustion error (plan 12.1-12.3).
- Added the agent chat API in `apps/server` (plan 17.5): `POST
  /api/agent-sessions` (idempotent default chat per scope), `GET /:id`,
  `GET /` list with scope filters, `GET /:id/messages`, `POST
  /:id/messages`, `GET /:id/events` (SSE), `POST /:id/cancel`, and `POST
  /:id/workspace` for the plan 12.5 sync action. The controller resolves
  PR sessions to a worktree of their head commit, Issue sessions to the
  repository root, and knowledge/general sessions to the knowledge root;
  nothing is auto-injected into prompts (plan 13.6). Only normalized
  messages and tool summaries are persisted (plan 13.5).
- Added the Chat UI as a reusable right-rail panel with persisted history,
  live SSE streaming, Stop, revision banner (Target/Workspace ✓/⚠), a
  "Sync workspace" action, and old-chat discovery for a PR. Wired into the
  PR detail page and a new Issue detail page (`/issues/:number`) that also
  renders the stored markdown body (plan 1.3/14/18.2/18.3). No Markdown
  library dependency was added; the chat renderer escapes raw HTML and
  supports headings/code/lists/links.
- Added the Issue detail read endpoint `GET /api/repositories/:id/issues/:number`
  backed by the stored SQLite row (`ISSUE_NOT_FOUND` -> 404).
- Extended the database agent services: session create/find/list by scope,
  normalized message append/update, and `listBusyWorkspacePaths` for the
  recycle protection, all inside `packages/database` (no raw SQL elsewhere).

## Validated

- `CI=true pnpm check` passed on 2026-09-03 after Stage 4: lint, workspace
  type checks, architecture boundaries, DSH pin, all workspace tests (agent
  runtime 4, adapter mapper 6, git-workspace 8, database 22 incl.
  agent-service, server 39 incl. Stage 4 agent chat, contracts 24+Stage 3,
  web 33 incl. Markdown and PR detail with the chat rail), integration
  fixtures, and every production build.
- Server route tests prove session creation is idempotent per scope, user and
  assistant messages persist across a recorded turn, a second message while a
  turn runs returns `AGENT_TURN_BUSY` (409), and cancel marks the session
  interrupted (200). Unknown sessions map to `AGENT_SESSION_NOT_FOUND` (404).
- The worktree pool tests allocate/reuse/recycle against a real fixture
  repository with no extra fetches, and the adapter notification mapper tests
  cover the nested `session.event` wire shapes plus flat params.
- `pnpm check` still requires a manually cleared `apps/web/dist` before the
  web production build because Vite's out-dir clean triggers the sandbox bulk
  delete guard (pre-existing environment note).

## Deferred validation and known limitations

- Live DSH smoke (real provider credentials) and the two-repository real
  GitHub smoke remain deferred by explicit user direction; adapter behavior
  is covered by recorded-fixture tests, and the live smoke belongs to
  Stage 7.
- The pinned pre-release SDK does not publish a cancel or streaming API
  contract, so the adapter replays normalized events after a turn settles
  rather than forwarding true token deltas live. SSE delivers the same event
  vocabulary on completion; the UI reconciles transcripts from SQLite.
- Browser-level diff and agent E2E are deferred to the Stage 7 release
  acceptance; unit/integration coverage stands in the meantime.
- `packages/scheduler` remains a Stage 0 scaffold until Stage 6.

## Next stage

Stage 7: Release Acceptance — final `pnpm check:full`, docs sweep, live
smokes (real GitHub/DSH), performance/command-count report, known
limitations, and local install/run notes. Deferred evidence from earlier
stages must not be represented as completed.

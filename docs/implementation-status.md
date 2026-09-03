# Implementation Status

The sole execution baseline is `../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md`
in the parent system workspace. This repository is a greenfield implementation
and does not copy the rejected legacy dashboard architecture.

## Current stage

All V1 stages (0-7) are complete locally (2026-09-03). Real GitHub/DSH live
smokes remain deferred by explicit user direction and must not be represented
as completed evidence.

## Deliveries by stage

### Stage 4 — DSH Agent Chat and Worktree Pool

- `packages/agent-runtime`: vendor-neutral `AgentRuntime` contract, runtime
  events, and `AgentRuntimeHost` (one runtime per session, running state,
  stop on demand, idle close after `agent.idleProcessMinutes`). Product code
  never imports DSH types.
- `packages/agent-runtime-dsh`: one pinned `DeepSeekHarness` subprocess per
  session with an isolated per-session `dsh-home`, stop-by-process-termination
  cancel, runtime session id reuse, and a shape-driven `mapNotification`
  normalizer covering the nested `session.event` wire shape and flat params.
  `DSH_PERMISSION_MODE=danger-full-access` is the default child environment.
- `packages/git-workspace` `worktree-pool.ts`: detached-worktree allocation in
  the frozen order (exact-target reuse -> free slot -> LRU clean non-busy
  recycle), `reset --hard` + `clean -fd` only.
- Server agent API (plan 17.5): `POST /api/agent-sessions` (idempotent per
  scope), `GET /api/agent-sessions` list, `GET /:id`, `GET /:id/messages`,
  `POST /:id/messages`, `GET /:id/events` (SSE), `POST /:id/cancel`, and
  `POST /:id/workspace`. PR chats run in a worktree of the head commit, Issue
  chats in the repository root, Knowledge/general chats in the knowledge
  root; nothing is auto-injected into prompts; only normalized messages and
  tool summaries are persisted.
- Web: reusable Chat UI rail (history, SSE live streaming, Stop, revision
  banner, Sync workspace, old-chat discovery) wired into the PR detail page
  and a new Issue detail page (`/repositories/:repo/issues/:number`), plus
  the Issue detail read endpoint (`ISSUE_NOT_FOUND` -> 404).

### Stage 5 — Knowledge Repository

- `packages/knowledge`: Markdown tree scan (excludes `.git`/`node_modules`/
  `.loong`), `loongboard_id` front matter, adoption of id-less files on first
  save, atomic temp+rename writes, root-escape guards.
- `packages/database` knowledge services: documents keyed by `loongboard_id`
  with unique path/hash/default session; full-content versions pruned to 10;
  moves update the index only, keeping the default chat mapping.
- Server `KnowledgeController` + routes (plan 17.6): tree, create, path- and
  id-based read/save, move, delete, versions, restore, and `POST /:id/chat`
  for the default document session. Recursive watcher + 1s debounce creates
  `external` versions; changes during a running knowledge agent turn are
  aggregated into one `agent` version per document on idle.
- Web `/knowledge/:documentId?`: file tree, Preview / Edit (plain Markdown
  source) / History + Restore, move/delete, New document, and the default
  document chat rail.

### Stage 6 — Scheduler

- `packages/scheduler`: dependency-free 5-field cron evaluator (lists, ranges,
  steps, Sunday 0/7) computing the next occurrence in an IANA timezone.
- `packages/database` scheduler services: task CRUD with `next_run_at`, run
  rows (running/completed/failed/skipped), restart recovery marking crashed
  `running` runs as failed, run history.
- Server `SchedulerEngine`: single timer for the nearest enabled task; each
  due task starts a fresh general Agent Session on its workspace, sends the
  prompt verbatim, waits for the turn to idle, and records the outcome. One
  workspace runs at most one turn (busy defers, never duplicates); restarts
  recompute future occurrences and never replay missed runs; `POST /:id/run`
  (Run Now) returns 409 when the workspace is busy.
- Routes (plan 17.7): `GET/POST /api/scheduled-tasks`, `PUT/DELETE /:id`,
  `POST /:id/run`, `GET /:id/runs`. Web page `/scheduled-tasks` with create,
  enable/disable, Run now, Delete, and run history.

### Stage 7 — Release Acceptance

- Docs sweep: `requirements.md`, `architecture.md` (Stages 2-6),
  `data-model.md`, `operations.md` (full V1 run + acceptance notes), and this
  file reflect the complete V1 surface.

## Validated

- `pnpm check:full` passed on 2026-09-03: complete `pnpm check` (lint,
  workspace type checks, architecture boundaries, DSH pin, all workspace
  tests - server 44, scheduler 5, database 22, git-workspace 8, adapter 6,
  agent-runtime 4, contracts, web 33 - integration fixtures, production
  builds) plus the Stage 1 deterministic browser E2E against system Chrome
  (1/1, 12 fake `gh` calls).
- Cold-start process smoke on 2026-09-03 against the real server binary
  (temporary `system.yaml`, no credentials): `/api/health` 200; repository
  list, knowledge tree (pre-existing Markdown listed), scheduled task list;
  Knowledge create -> read-by-path -> versions and path-save adoption of an
  id-less file; general Agent Session create/list with the knowledge-root
  cwd and per-session DSH home under `.loong`. All responses validated.
- `pnpm check` web build requires a manually cleared `apps/web/dist` first
  (Vite's out-dir clean trips the sandbox bulk-delete guard).

## Deferred validation and known limitations

- Live DSH smoke (real model credentials) and the two-repository real GitHub
  smoke remain deferred by explicit user direction; adapters are covered by
  recorded-fixture tests.
- The pinned pre-release SDK has no cancel/streaming API, so the adapter
  replays normalized events after a turn settles; the UI reconciles
  transcripts from SQLite.
- Knowledge Git checkpoint (`autoCommit`/`autoPush`) is not exposed; history
  is SQLite full-content snapshots and Markdown stays plain on disk. Mermaid
  rendering and Monaco editing for Knowledge are simplified (shared Markdown
  renderer + plain source editor; raw HTML escaped).
- Browser-level E2E beyond Stage 1 is not yet written; unit/integration and
  the deterministic Stage 1 browser path cover the critical flows.

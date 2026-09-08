# Implementation Status

The sole execution baseline is `../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md`
in the parent system workspace. This repository is a greenfield implementation
and does not copy the rejected legacy dashboard architecture.

## Current stage

All V1 stages (0-7) are implemented locally. Validation recorded on
2026-09-07 covers a full sandbox-external `pnpm check`, a live DSH session
smoke, and live PR/Knowledge UI checks (details under Validation state). The
real two-repository GitHub smoke remains deferred by explicit user direction;
the main agent owns any further fresh validation of the current tree.

## Implementation updates

The following changes are in the current tree and are the authoritative
description for the affected areas:

- DSH events stream during the run. `packages/agent-runtime-dsh` maps the
  real `session.event` wire shape while `session.run` is still pending:
  `assistant/chunk` text deltas become `assistant.delta`;
  `assistant/message` emits nothing because the completed assistant message is
  persisted exactly once from `RunResult.finalResponse`; `tool/call` becomes
  `tool.started` and `tool/result` becomes `tool.completed`, with tool names
  recovered per run from the paired calls (unmatched results fall back to
  `"tool"`). The notification channel's close wakes parked waiters, and
  notifications after close are ignored.
- Chat and scheduler share one `WorkspaceRunCoordinator`, so the same
  workspace path never runs two agent turns at once. Conflicts surface as 409
  `WORKSPACE_BUSY` (chat) or 409 `SCHEDULED_TASK_WORKSPACE_BUSY` (Run Now); a
  due scheduled fire defers without creating a run. PR turns must match the
  session's target revision, and an explicit workspace sync stops the DSH
  process before the worktree is switched.
- PR worktree affinity and LRU are database-backed through `worktree_slots`
  (PR number, target SHA, last-used time), while Git remains the source of
  truth for actual revision and cleanliness: a failed
  `git status --porcelain` is fail-closed, so allocation throws before any
  destructive reset/clean recycle.
- Knowledge saves preserve front matter: only the `loongboard_id` line is
  added or replaced (indexed identity wins over stale content ids), all other
  front matter bytes and line endings stay untouched, and id-less files are
  adopted on first save.
- Web Markdown uses react-markdown + remark-gfm (GFM tables and task lists),
  safe http(s) links and images, a validated Knowledge asset endpoint for
  relative image URLs, and fenced Mermaid diagrams; raw HTML stays escaped.
- Issue body and comments are fetched lazily: list responses remain
  summary-only, and the issue detail route calls GitHub only when
  `issues.detail_synced_updated_at` is older than the issue's `updated_at`,
  then replaces the cached body and `issue_comments` rows transactionally.
  Concurrent readers share one in-flight refresh, and stale-cache checks no
  longer load the body/comments before deciding to refresh.
- GitHub metadata access uses native HTTP fetch for GraphQL and REST. A
  bearer token is resolved once per provider instance (`GITHUB_TOKEN` when
  set, otherwise `gh auth token`) and reused for every request.
- Knowledge scans now return content and hashes as one snapshot. Tree and
  document reads reuse that snapshot, and an active filesystem watcher keeps
  it cached until a relevant write/event marks it dirty. This removes the
  previous duplicate full-tree scan and repeated per-file reads.
- Worktree allocation inspects existing revisions concurrently and caches
  revision/cleanliness results for the complete selection pass. A slot is not
  re-probed in later affinity/LRU phases, while dirty/busy protection and the
  original allocation order remain unchanged.
- The web shell is modular: `AppShell` composes the sidebar, repository
  context header, and routes, with a per-repository subnav (Activity / Open
  Pull Requests / Open Issues), calendar-day activity and metadata pages
  with date/domain/status filters, Settings (Schedules, Domains, Health),
  and a light/dark theme control shared with the Monaco editors.
- PR detail is a chrome-free full-viewport diff workbench: the route drops
  app chrome, the changed-files rail and the chat rail collapse
  independently, and the Monaco diff editor lazy-loads with the late-apply
  race fixed (latest props are captured at commit time and no editor is
  created after unmount).
- Knowledge editing uses a Monaco Markdown editor that follows the shell
  theme. Preview hides the leading LF/CRLF YAML front matter and renders
  only the body, while Edit and Save keep the complete raw source with
  front-matter bytes and line endings preserved; MarkdownView renders GFM
  tables and task lists, code fences, safe http(s) and relative Knowledge
  asset images, and Mermaid, with raw HTML escaped.

## Deliveries by stage

### Stage 4 — DSH Agent Chat and Worktree Pool

- `packages/agent-runtime`: vendor-neutral `AgentRuntime` contract, runtime
  events, and `AgentRuntimeHost` (one runtime per session, running state,
  stop on demand, idle close after `agent.idleProcessMinutes`). Product code
  never imports DSH types.
- `packages/agent-runtime-dsh`: one pinned `DeepSeekHarness` subprocess per
  session with an isolated per-session `dsh-home`, stop-by-process-termination
  cancel, runtime session id reuse, and a per-run `DshNotificationMapper`
  over the real nested `session.event` wire shape (see Implementation
  updates). A FIFO channel drains notifications while `session.run` is
  pending, so normalized events stream to subscribers during the turn.
  `DSH_PERMISSION_MODE=danger-full-access` is the default child environment.
- `packages/git-workspace` `worktree-pool.ts`: detached-worktree allocation
  in the frozen order (same-PR exact-target reuse -> same-PR clean target
  switch -> next free slot -> legacy unbound clean slot -> clean non-busy LRU
  recycle), `reset --hard` + `clean -fd` only. SQLite `worktree_slots` rows
  drive PR affinity and LRU ordering; Git remains the source of truth for
  actual revision and cleanliness and failures are fail-closed.
- Server agent API (plan 17.5): `POST /api/agent-sessions` (idempotent per
  scope), `GET /api/agent-sessions` list, `GET /:id`, `GET /:id/messages`,
  `POST /:id/messages`, `GET /:id/events` (SSE), `POST /:id/cancel`, and
  `POST /:id/workspace`. PR chats run in a worktree of the head commit, Issue
  chats in the repository root, Knowledge/general chats in the knowledge
  root; nothing is auto-injected into prompts; only normalized messages and
  tool summaries are persisted. Every agent turn (manual chat or scheduled
  run) acquires the shared `WorkspaceRunCoordinator`; PR turns start only when
  the worktree is on the session's target revision, and sync stops the DSH
  process before switching.
- Web: reusable Chat UI rail (history, SSE live streaming, Stop, revision
  banner, Sync workspace, old-chat discovery) wired into the PR detail page
  and a new Issue detail page (`/repositories/:repo/issues/:number`), plus
  the Issue detail read endpoint (`ISSUE_NOT_FOUND` -> 404).

### Stage 5 — Knowledge Repository

- `packages/knowledge`: Markdown tree scan (excludes `.git`/`node_modules`/
  `.loong`), `loongboard_id` front matter with preservation of all other
  front matter bytes and line endings, adoption of id-less files on first
  save, atomic temp+rename writes, root-escape guards.
- `packages/database` knowledge services: documents keyed by `loongboard_id`
  with unique path/hash/default session; full-content versions pruned to 10;
  moves update the index only, keeping the default chat mapping.
- Server `KnowledgeController` + routes (plan 17.6): tree, create, path- and
  id-based read/save, move, delete, versions, restore, and `POST /:id/chat`
  for the default document session. Recursive watcher + 1s debounce creates
  `external` versions; changes during a running knowledge agent turn are
  aggregated into one `agent` version per document on idle.
- Web `/knowledge/:documentId?`: file tree, Preview (shared MarkdownView:
  GFM, safe images, Mermaid; leading LF/CRLF front matter hidden) / Edit
  (Monaco with the shell theme; raw source preserved exactly) / History +
  Restore, move/delete, New document, and the default document chat rail.

### Stage 6 — Scheduler

- `packages/scheduler`: dependency-free 5-field cron evaluator (lists, ranges,
  steps, Sunday 0/7) computing the next occurrence in an IANA timezone.
- `packages/database` scheduler services: task CRUD with `next_run_at`, run
  rows (running/completed/failed/skipped), restart recovery marking crashed
  `running` runs as failed, run history.
- Server `SchedulerEngine`: single timer for the nearest enabled task; each
  due task starts a fresh general Agent Session on its workspace, sends the
  prompt verbatim, waits for the turn to idle, and records the outcome. One
  workspace path runs at most one turn because manual chats and scheduled
  runs share one `WorkspaceRunCoordinator` (a due fire defers without
  creating a run; Run Now returns 409 `SCHEDULED_TASK_WORKSPACE_BUSY`).
  Restarts recompute future occurrences and never replay missed runs.
- Routes (plan 17.7): `GET/POST /api/scheduled-tasks`, `PUT/DELETE /:id`,
  `POST /:id/run`, `GET /:id/runs`. Web page `/scheduled-tasks` with create,
  enable/disable, Run now, Delete, and run history.

### Stage 7 — Release Acceptance

- Docs sweep: `requirements.md`, `architecture.md` (Stages 2-6),
  `data-model.md`, `operations.md` (full V1 run + acceptance notes), and this
  file reflect the complete V1 surface.
- Test maintenance now uses UT by default. Historical stage/E2E fixtures were
  removed; three independently rewritten critical backend regressions live in
  `tests/regression` and run only through `test:regression`/`check:full`.

## Validation state

- Current validation on 2026-09-08 after the backend performance and test
  restructuring: `pnpm check` passed, including 266 UT and all production
  builds; the new independent `pnpm test:regression` passed 3 tests. The
  regression suite was run because this was a major cross-module change.

- Historical full run on 2026-09-03 passed the former stage/E2E suite. Those
  test files and commands were intentionally removed on 2026-09-08 and are
  not part of the current validation contract.
- Recorded cold-start process smoke on 2026-09-03 against the real server
  binary (temporary `system.yaml`, no credentials): `/api/health` 200;
  repository list; knowledge tree (pre-existing Markdown listed); Knowledge
  create -> read-by-path -> versions; path-save adoption of an id-less file;
  general Agent Session create/list with the knowledge-root cwd and
  per-session DSH home under `.loong`. All responses were validated.
- `pnpm check` web build requires a manually cleared `apps/web/dist` first
  (Vite's out-dir clean trips the sandbox bulk-delete guard).
- Live DSH session smoke recorded on 2026-09-07 against the real subprocess
  runtime: a LoongBoard session whose previous turn ended in error was
  recovered and streamed `STREAM_OK`, and glob/read tool calls on the
  recovered session reported `TOOL_OK`. Stop interrupted the running turn
  with a null runtime session id; the next message resumed with `RESUMED_OK`
  on an idle session that received a fresh runtime session id.
- Live PR check on 2026-09-07 (real PR #55473, 1357x987 viewport): the
  chrome-free workbench filled the viewport, measured diff pane widths grew
  659 px -> 903 px -> 1217 px across layout changes with no horizontal
  overflow, and the real source view, Full File, and Back controls all
  worked.
- Knowledge checks on 2026-09-07 passed in isolation: GFM table and task
  lists, code fences, relative images through the Knowledge asset endpoint,
  Mermaid diagrams, and the dark Monaco editor. Startup indexing produced one
  `external` version record, and the default document chat rail was available;
  Restore was not exercised in this live check.
- Sandbox-external `pnpm check` passed on 2026-09-07: server 70, web 74,
  agent-runtime-dsh 11, agent-runtime 4, contracts 27, database 29,
  git-workspace 20, github 21, knowledge 12, scheduler 5, architecture 11,
  integration 3, plus production builds. Only non-blocking warnings were
  emitted (React `act(...)` warning and Vite large-chunk warning); inside
  the sandbox the same run can fail with EMFILE even though it passes
  outside.
- Fresh live GitHub, DSH, and browser checks remain explicit manual acceptance
  activities and are not claimed as completed here.

## Deferred validation and known limitations

- Live DSH smoke is recorded on 2026-09-07 (see Validation state); any fresh
  live GitHub, DSH, or browser validation remains manually invoked.
- The pinned pre-release SDK streams notifications through `session.run`'s
  `onNotification` callback but has no separate cancel API; stopping a turn
  terminates the child process. SQLite message rows are the durable record
  and the UI keeps its transcript in sync with them.
- Knowledge Git checkpoint (`autoCommit`/`autoPush`) is not exposed; history
  is SQLite full-content snapshots and Markdown stays plain on disk. Preview
  and chat share the MarkdownView with GFM, safe images, and Mermaid; raw
  HTML stays escaped; leading LF/CRLF front matter is hidden from preview
  only, because the Monaco editor and save path keep the complete raw
  source.
- There is intentionally no routine browser E2E suite. Component UT covers
  normal behavior; major/manual acceptance uses the running local site.

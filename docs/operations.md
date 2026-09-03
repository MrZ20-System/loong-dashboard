# Operations

LoongBoard runs locally with Node.js 24-26 (the pinned `better-sqlite3` ABI
requires Node 26 on this machine), pnpm, Git, SQLite, an authenticated GitHub
CLI for sync, and a DSH runtime for Agent chat. Relative paths in
`system.yaml` are resolved once against that file's directory and become
absolute internal paths.

## Run locally

1. Create `system.yaml` next to this repository (see
   `system.example.yaml`); repository paths, `knowledge.path`, `.loong` and
   `.worktrees` are resolved relative to it.
2. `pnpm install` (a pnpm corepack shim and Node 26 may be required on
   sandboxed machines; when `pnpm` is unavailable, link workspace packages
   into `apps/*/node_modules/@loongboard` by hand).
3. `pnpm dev` starts the Server and Web application. The local server listens
   on `127.0.0.1:4174` by default and the web dev server proxies `/api` to it.
4. Open `http://127.0.0.1:5173` (Vite default).

Runtime state lives under `.loong`; disposable worktrees live under
`.worktrees`; per-session DSH homes live under
`.loong/agent-sessions/<session-id>/dsh-home`. Do not commit either
directory. Configuration errors fail fast; failed commands/migrations are
never converted into empty responses.

## Main routes

- REST and SSE APIs (see the implementation plan for schemas): repositories,
  PR/Issue lists and details, domain rules, PR diff/file content, agent
  sessions and SSE events, Knowledge tree/documents/versions, scheduled
  tasks/runs, health.
- Web pages: `/repositories/:repo/pulls[:/number]`,
  `/repositories/:repo/issues[:/number]`, `/knowledge/:documentId?`,
  `/scheduled-tasks`, `/settings/domains`, `/health`.

## Acceptance commands

- `pnpm check` — lint, type checks, architecture boundaries, DSH pin, all
  workspace tests, integration fixtures, and production builds. Note: in this
  sandbox the web build requires an empty `apps/web/dist` first because
  Vite's out-dir clean trips the bulk-delete guard.
- `pnpm check:full` — `pnpm check` plus browser E2E.
- `pnpm test:e2e:stage1` — deterministic Stage 1 acceptance path. The runner
  owns one temporary root and removes it after terminating the Server, Vite,
  Playwright, and their discovered descendants. Its fake GitHub executable is
  selected by `PATH` only inside that process environment, and its command
  log carries repository/operation/state/cursor/generation metadata rather
  than credentials or raw responses.
- `pnpm smoke:stage1:real` — real two-repository smoke, only when
  authenticated GitHub CLI access is intended. It selects `vllm` and
  `vllm-ascend` from the parent configuration, points the Server at temporary
  runtime directories, and wraps an absolute real `gh` executable. It never
  writes either source repository and verifies raw Git HEAD/status are
  unchanged around the syncs. A successful report includes per-repository
  watermarks, list sizes, and command counts before/after local reads.

## Known environment notes

- Node 26 requires exact `better-sqlite3@12.11.1`.
- `tsx` prints a `module.register()` deprecation warning on startup; it does
  not affect validated paths.
- Live DSH smoke needs real model credentials and remains a manual Step 7
  activity; recorded-fixture adapter tests cover the event mapping.

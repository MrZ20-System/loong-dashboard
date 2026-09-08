# Operations

LoongBoard runs locally with Node.js 24-26 (the pinned `better-sqlite3` ABI
requires Node 26 on this machine), pnpm, Git, SQLite, GitHub API access, and
a DSH runtime for Agent chat. Relative paths in `system.yaml` are resolved
once against that file's directory and become absolute internal paths.

## GitHub authentication

GitHub metadata access goes through the server's GitHub provider over native
HTTP fetch (GraphQL and REST). The provider resolves one bearer token per
instance and reuses it: `GITHUB_TOKEN` when that environment variable is set
and non-empty, otherwise `gh auth token`. An authenticated `gh` CLI is
therefore required only when `GITHUB_TOKEN` is not set.

## Credential handling

Startup retains the existing secure macOS Keychain-backed credential pattern
for the local agent stack: secrets are resolved into the process environment
at launch and never appear in `system.yaml`, in this documentation, or in
command output or logs. No command here prints credentials.

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

## Validation commands

- `pnpm test` or `pnpm test:ut` — the normal, UT-only development loop.
- `pnpm check` — lint, type checks, architecture boundaries, DSH pin, UT, and
  production builds. It does not run regression or browser automation.
- `pnpm test:regression` — three independent critical backend checks covering
  Issue refresh coalescing, Knowledge external-version indexing, and dirty
  worktree protection. Run only for major cross-module changes or when the
  user requests it.
- `pnpm check:full` — `pnpm check` plus the critical regression suite. This is
  also reserved for major changes or an explicit request.

Browser interaction, live GitHub access, and live DSH sessions are manual
acceptance activities. They are not hidden inside the routine test command.

## Known environment notes

- Node 26 requires exact `better-sqlite3@12.11.1`.
- `tsx` prints a `module.register()` deprecation warning on startup; it does
  not affect validated paths.
- A sandbox-external `pnpm check` passed on 2026-09-07 with per-workspace
  counts recorded in implementation-status.md. Only a React `act(...)`
  warning and a Vite large-chunk warning were emitted; the same build can
  fail with EMFILE inside the sandbox even though the outside run passes.
- Live DSH smoke needs real model credentials supplied through the secure
  startup environment and is recorded on 2026-09-07; UT covers the adapter's
  event mapping and channel behavior.

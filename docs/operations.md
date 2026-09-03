# Operations

LoongBoard runs locally with Node.js 24 or newer within the repository engine
range, pnpm, Git, SQLite, and an authenticated GitHub CLI for later sync
stages. Relative paths in `system.yaml` are resolved once against that file's
directory and become absolute internal paths.

The local server listens on `127.0.0.1:4174` by default. Runtime state lives
under `.loong`; disposable worktrees live under `.worktrees`. Do not commit
either directory.

Configuration errors fail fast. A failed command or migration is visible in
the operation error and is not converted to an empty response. `pnpm dev`
starts the local Server and Web application. Stage 1 GitHub synchronization is
started only by the explicit sync action; DSH process lifecycle is deferred to
its later stage.

## Stage 1 acceptance harnesses

Use `pnpm test:e2e:stage1` for the deterministic acceptance path. The runner
owns one temporary root and removes it after terminating the Server, Vite,
Playwright, and their discovered descendant processes. Its fake GitHub
executable is selected by `PATH` only inside that process environment, and its
command log contains repository/operation/state/cursor/generation metadata
rather than credentials or raw responses. Cleanup fails visibly if neither the
owned process group nor descendant discovery can prove tree termination.

Use `pnpm smoke:stage1:real` only when authenticated GitHub CLI access is
intended. The real smoke selects exactly `vllm` and `vllm-ascend` from the parent
configuration, points Server at temporary runtime directories, and wraps an
absolute real `gh` executable. It does not create worktrees, fetch, checkout,
commit, or otherwise write either source repository. Before and after the two
syncs it compares the source repositories' raw Git `HEAD` and status output;
any difference fails the command. A successful report includes per-repository
watermarks, list sizes, command counts before/after local reads, and an
explicit unchanged-source result. The recording wrapper passes GraphQL stdout
through a pipe to the provider for in-memory validation; it persists only
operation, repository, states, cursor, exit, signal, and byte-count metadata.

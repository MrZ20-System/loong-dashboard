# Operations

LoongBoard runs locally with Node.js 24 or newer within the repository engine
range, pnpm, Git, SQLite, and an authenticated GitHub CLI for later sync
stages. Relative paths in `system.yaml` are resolved once against that file's
directory and become absolute internal paths.

The local server listens on `127.0.0.1:4174` by default. Runtime state lives
under `.loong`; disposable worktrees live under `.worktrees`. Do not commit
either directory.

Configuration errors fail fast. A failed command or migration is visible in
the operation error and is not converted to an empty response. Stage 0 starts
the local server and Web shell through `pnpm dev`; DSH process lifecycle is
deferred to its later stage.

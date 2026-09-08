# Testing

LoongBoard uses a unit-first test model. Normal development runs only fast,
local tests with injected process/network boundaries:

```bash
pnpm test
pnpm test:ut
pnpm check
```

`pnpm test` is an alias for `pnpm test:ut`. The unit runner executes each
workspace package's local suite plus the architecture checker tests. `pnpm
check` adds lint, type checks, architecture/DSH pin checks, and production
builds; it does not run regression tests or browser automation.

## Critical regression suite

`tests/regression` is intentionally small and independent of the removed
historical stage/E2E fixtures. It currently protects only three high-impact
contracts:

- concurrent stale Issue reads share one GitHub refresh;
- an external Knowledge edit is indexed and versioned;
- a dirty bound worktree is never recycled.

Run it only for a major cross-module change or when explicitly requested:

```bash
pnpm test:regression
pnpm check:full
```

`pnpm check:full` is `pnpm check` followed by `pnpm test:regression`.

## Manual acceptance

Browser interaction, live GitHub access, and live DSH sessions are manual
acceptance. Start the local application with `pnpm dev`, exercise the changed
flow, and report exactly what was checked. A static or unit pass does not prove
live credentials, remote API behavior, or browser layout.

Add the smallest test at the nearest stable business boundary. Prefer pure
functions and injected dependencies. Do not recreate broad stage suites,
recording fixtures, or a second implementation solely for tests.

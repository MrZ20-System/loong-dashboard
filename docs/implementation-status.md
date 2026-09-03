# Implementation Status

The sole execution baseline is `../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md`
in the parent system workspace. This repository is a greenfield implementation
and does not copy the rejected legacy dashboard architecture.

## Current stage

Stage 1: GitHub Metadata Vertical Slice — completed and accepted locally on
2026-09-03. Stage 2 has not started.

## Done

- Stage 0 was accepted locally on 2026-09-03 in commit `e075dc4`.
- Froze the Stage 1 API, persistence, GitHub command, timezone, cursor,
  ownership, and failure-semantics decisions in `docs/stage-1-tasks.md`.
- Added strict shared Pull Request, Issue, repository, synchronization, cursor,
  and error contracts without leaking GitHub or DSH types into the business
  layer.
- Added the GitHub GraphQL provider, SQLite migrations and reconciliation,
  persisted list reads, per-stream watermarks, and explicit partial-failure
  behavior.
- Added the Server metadata routes, synchronization coordinator, request-body
  boundaries, response validation, and orderly shutdown behavior.
- Added repository-scoped Pull Request and Issue pages, filters, metrics,
  pagination, explicit synchronization, and failed-stream recovery while
  preserving cached rows.
- Added deterministic GitHub fixtures, browser acceptance coverage, a guarded
  real-repository smoke harness, and process-tree cleanup regression tests.
- Kept list pages SQLite-only. GitHub is contacted only by the explicit sync
  action; no AI summarization or domain classification was introduced.

## Validated

- `CI=true pnpm check` passed on 2026-09-03: lint, all workspace type checks,
  architecture boundaries, the exact DSH pin, 122 substantive tests, fixture
  integration tests, and all production builds passed.
- The test total comprises Server 30, Web 24, contracts 19, database 21,
  GitHub provider 16, architecture 9, and acceptance fixtures 3.
- The deterministic browser command passed 1/1 scenario with 12 fake `gh`
  calls using system Chrome through `LOONGBOARD_E2E_BROWSER_PATH`.
- The browser scenario verifies that list reads remain local until explicit
  synchronization, both metadata streams refresh independently, and failed
  rows remain visible from SQLite.
- Process cleanup tests verify termination of a signal-resistant descendant and
  explicit failure after stopping the known root when descendants cannot be
  safely discovered.
- The local CodeGraph index was refreshed for the final Stage 1 code state.

## Deferred validation and known limitations

- The two-repository real GitHub smoke is deferred by explicit user direction.
  Attempts reached `vllm-project/vllm` but GitHub CLI GraphQL requests failed
  with `Post "https://api.github.com/graphql": EOF`. This is not positive smoke
  evidence and no claim is made that real synchronization passed.
- Those failed attempts did not change either configured source checkout. The
  smoke harness also compares each checkout's raw Git `HEAD` and status before
  and after a successful run.
- The repository supports Node.js 24 through 26. The local Node.js 26 runtime
  requires exact `better-sqlite3@12.11.1`; this changes no database ownership or
  API contract.
- Node.js 26 prints a `tsx` deprecation warning for `module.register()` during
  development and acceptance startup. It does not affect the validated paths.
- DSH remains pinned and isolated but is not started in Stage 1. Live DSH
  lifecycle validation belongs to Stage 4.

## Next stage

Stage 2 remains intentionally unstarted. The deferred real GitHub smoke must
not be represented as completed evidence in later stage reports.

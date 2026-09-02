# Stage 1 Task Plan

The sole execution baseline is
`../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md`. Stage 1 implements only the
GitHub metadata vertical slice. Stage 2 and later behavior remains blocked.

## Frozen decisions

- `system.yaml` is the only Repository configuration source. Stage 1 adds no
  Repository write API.
- A configured Repository uses `key` as its stable `id`. Reconciliation upserts
  configured rows and disables removed rows without deleting their history.
- The SQLite file is `${runtime.statePath}/loongboard.sqlite3`.
- List requests read SQLite only. They never call GitHub and never trigger a
  sync implicitly.
- A manual sync is accepted with HTTP 202 and runs in the Server process. The
  UI polls only the local sync-status endpoint.
- PR status is derived once in the GitHub provider and stored as
  `draft | open | closed | merged`. The Web never derives it again.
- List order is `updated_at DESC, number DESC`. An opaque cursor contains
  version 1, the last returned `updatedAt`, and the last returned `number`.
- Calendar filtering converts the requested local date in
  `system.yaml.timezone` to a UTC half-open range. No duplicate local-date
  column is maintained.
- Bootstrap uses all Open items plus a 90-day Closed/Merged lookback.
  Incremental sync stops below the previous watermark minus two minutes.
- A successful watermark is the captured sync-attempt start time. It advances
  only after the complete entity stream succeeds.
- Metadata page writes are idempotent. A failure preserves old rows and the old
  watermark, records an explicit error, and leaves list reads available.

## Frozen HTTP contracts

All schemas are strict Zod schemas owned by `packages/contracts`.

```text
GET /api/repositories
  -> { items: RepositorySummary[] }

POST /api/repositories/:id/sync
  -> 202 { repositoryId, syncRunId, status: "accepted" }

GET /api/repositories/:id/sync-status
  -> {
       repositoryId,
       status: "idle" | "running" | "failed",
       pullRequests: SyncStreamState,
       issues: SyncStreamState
     }

GET /api/repositories/:id/pulls?date=&status=&cursor=
  -> { items: PullRequestListItem[], nextCursor, calendarTimeZone }

GET /api/repositories/:id/pulls/activity-days?from=&to=
  -> { days: ActivityDay[], calendarTimeZone }

GET /api/repositories/:id/issues?date=&status=&cursor=
  -> { items: IssueListItem[], nextCursor, calendarTimeZone }

GET /api/repositories/:id/issues/activity-days?from=&to=
  -> { days: ActivityDay[], calendarTimeZone }
```

`PullRequestListItem` contains `repositoryId`, `number`, `title`, `url`,
`authorLogin`, stored `status`, `updatedAt`, `changedFilesCount`, `additions`,
and `deletions`. `IssueListItem` contains `repositoryId`, `number`, `title`,
`url`, `authorLogin`, `status`, `commentsCount`, and `updatedAt`.

Invalid request data returns HTTP 400. An invalid cursor uses
`INVALID_CURSOR`; a missing/disabled Repository uses HTTP 404
`REPOSITORY_NOT_FOUND`; an overlapping Repository sync uses HTTP 409
`SYNC_ALREADY_RUNNING`. Errors use `{ error: { code, message } }`.

## Ownership

| Task | Owner | Writable scope |
| --- | --- | --- |
| S1-T1 contracts and persistence | Luna Max | `packages/contracts/**`, `packages/database/**` |
| S1-T2 GitHub provider | Luna High | `packages/github/**` |
| S1-T3 Web metadata lists | Luna High | `apps/web/**` |
| S1-T4 Server integration | Integration Lead after T1/T2 | `apps/server/**`, Stage 1 integration fixtures |
| S1-T5 review and acceptance | Team Lead and independent reviewer | fixes assigned after review |

No two implementation tasks may modify the same package. Root manifests and
the lockfile remain Integration Lead owned.

## S1-T1: contracts and persistence

### Goal

Implement the frozen HTTP schemas, Repository reconciliation, sync-state
transitions, idempotent PR/Issue upserts, stable cursor pagination, date/status
filters, and activity-day queries.

### Non-goals

No GitHub execution, Fastify routes, UI, changed-file enrichment, domains,
details, Git, DSH, Knowledge, or Scheduler behavior.

### Files allowed

`packages/contracts/**` and `packages/database/**` only.

### Existing contracts

Health stays exact. Existing migration 001 is immutable. Raw SQL stays in the
database package.

### Required behavior

Use `key` as Repository ID; reconcile and disable without deleting; create two
sync-state rows; recover interrupted running states as failed; implement the
frozen list/cursor/timezone behavior and sync state transitions.

### Required tests

Strict schema tests, real-date validation, cursor property tests, migration
index tests, reconciliation idempotence, upsert idempotence, DST/date/status
queries, pagination ties, activity days, and failure state preservation.

### Acceptance commands

```bash
pnpm --filter @loongboard/contracts test
pnpm --filter @loongboard/contracts typecheck
pnpm --filter @loongboard/database test
pnpm --filter @loongboard/database typecheck
pnpm check:architecture
```

### Dependencies / blocked by

Stage 0 only.

## S1-T2: GitHub provider

### Goal

Implement the only `gh api graphql` boundary, PR/Issue pagination and mapping,
bootstrap/incremental inputs, watermark stop behavior, and command errors.

### Non-goals

No database, HTTP, Web, details, changed-file enrichment, REST files, Git, DSH,
Knowledge, or retry framework.

### Files allowed

`packages/github/**` only.

### Existing contracts

Only this package may execute `gh`. External JSON is validated once. No
per-item command is permitted.

### Required behavior

Use `gh api graphql --input -` without a shell, one command per page, strict
response parsing, canonical UTC timestamps, the frozen status derivation, and
inclusive updated-at floors. Do not accept partial GraphQL data with errors.

### Required tests

Fake executable fixtures for pagination, four PR statuses, nullable authors,
cutoff equality and early stop, response errors, command errors, exact argv,
and the explicit 100-PR/one-command assertion.

### Acceptance commands

```bash
pnpm --filter @loongboard/github test
pnpm --filter @loongboard/github typecheck
pnpm check:architecture
```

### Dependencies / blocked by

Stage 0 only.

## S1-T3: Web metadata lists

### Goal

Implement Repository selection, PR/Issue list routes, URL-backed date/status
filters, pagination, metrics, manual sync status polling, and explicit errors.

### Non-goals

No domains, details, Monaco, Agent, Knowledge, Scheduler, AI summaries, UI
framework, or automatic GitHub sync on page load.

### Files allowed

`apps/web/**` only.

### Existing contracts

Use the frozen schemas above from `@loongboard/contracts`. React Router remains
fixed. Preserve Server order and stored PR status.

### Required behavior

Page reads call only local GET endpoints; only a user click calls POST sync;
running sync polls local status; failure preserves visible rows. Accessible
tables show all required values including zero metrics.

### Required tests

Routes, Repository selection, URL filters, invalid parameters, Server ordering,
zero metrics, pagination, request cancellation, boundary failures, and sync
success/failure with stale rows retained.

### Acceptance commands

```bash
pnpm --filter @loongboard/web test
pnpm --filter @loongboard/web typecheck
pnpm --filter @loongboard/web build
```

### Dependencies / blocked by

The frozen contract in this document; compilation depends on S1-T1 exports.

## Stage acceptance

Stage 1 is accepted only after two configured real repositories synchronize,
the second sync demonstrates watermark-bounded reads, list browsing adds zero
GitHub commands, a failed sync leaves old lists readable, `pnpm check` passes,
and Stage 1 E2E passes. Stage 2 remains blocked until then.

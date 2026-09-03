# @loongboard/database

## Purpose

SQLite persistence foundation for LoongBoard.

## Owns

- Deterministically ordered SQLite migrations and their migration ledger.
- The 14 V1 core tables, constraints, foreign keys, and indexes.
- PR and Issue Chat target identity through repository-scoped number foreign
  keys on `agent_sessions`.
- Typed Drizzle table declarations and database creation.
- Raw SQL used by LoongBoard.

## Does not own

- Business services or generic repository abstractions.
- HTTP contracts and routes.
- GitHub, local Git, Knowledge filesystem, Scheduler, or DSH behavior.

## Public API

- `openDatabase(path)`: opens SQLite, enables foreign keys, and applies pending
  migrations.
- `runMigrations(database)`: applies pending migrations to an existing client.
- `createDrizzleDatabase(database)`: wraps a migrated `better-sqlite3` client
  with the exported typed schema.
- `reconcileRepositories(database, configuredRepositories)`: synchronizes the
  `system.yaml` repository projection, using each configured `key` as its
  stable id and disabling removed entries without deleting history.
- `startRepositorySync`, `completeSyncStream`, and `failSyncStream`: the
  narrow metadata sync state machine. A failed stream leaves its previous
  watermark unchanged; `openDatabase` recovers interrupted running streams.
- `upsertPullRequestPage` and `upsertIssuePage`: transactional, replay-safe
  metadata page writes.
- `listPullRequests` and `listIssues`: SQLite-only list reads ordered by
  `updated_at DESC, number DESC`, with status, IANA-date, and v1 cursor
  filters.
- `getPullRequestActivityDays` and `getIssueActivityDays`: UTC-range queries
  grouped by the requested IANA calendar date.
- Table declarations and the combined `schema` object.

## Dependencies

- `better-sqlite3` for the SQLite client.
- `drizzle-orm` for typed queries.

## Invariants

- Raw SQL never leaves this package.
- Migration IDs are unique and executed in lexical order.
- A migration and its ledger record commit atomically.
- Re-running migrations does not reapply completed migrations.
- Foreign-key enforcement is enabled before migrations or application queries.
- `agent_sessions.issue_number` references the matching repository-scoped Issue;
  no Issue Chat behavior is implemented in this package.
- PR/Issue activity and PR domain filtering use the baseline list indexes.

## Tests

`test/migration-runner.test.ts` covers a fresh database, idempotent re-runs,
foreign-key activation and enforcement, all V1 core tables, the metadata list
indexes, and typed Drizzle queries for repository, scheduled-task, and Issue
Chat identity mappings. `test/metadata-services.test.ts` covers reconciliation,
interrupted sync recovery, failure watermark preservation, replay-safe upserts,
stable tie-breaking cursors, status/date/DST filters, and activity-day counts.

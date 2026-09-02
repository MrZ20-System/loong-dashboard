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
foreign-key activation and enforcement, all V1 core tables, and typed Drizzle
queries for repository, scheduled-task, and Issue Chat identity mappings.

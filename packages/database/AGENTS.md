# Database Package Agent Instructions

## Purpose

Own LoongBoard's SQLite schema, migrations, constraints, and typed Drizzle access.

## Boundaries

- Keep all raw SQL inside this package.
- Keep migrations deterministic, ordered, atomic, and recorded in the ledger.
- Enable SQLite foreign keys for every database opened through the public API.
- Add the smallest migration and typed-schema tests for every schema change.
- Do not add business services, repository base classes, GitHub calls, Git
  commands, or DSH imports.

## Verification

Run `pnpm test` and `pnpm typecheck` from this package after a database change.

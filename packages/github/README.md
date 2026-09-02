# @loongboard/github

## Purpose

Provider boundary for GitHub metadata synchronization.

## Owns

- `gh api graphql` and `gh api` command execution.
- GitHub response validation and metadata provider behavior.

## Does not own

- SQLite schema or raw SQL.
- Local Git workspaces.
- HTTP list rendering or DSH runtime behavior.

## Public API

No Stage 0 API is exported yet.

## Dependencies

None in Stage 0.

## Invariants

HTTP list reads use SQLite and never invoke GitHub directly.

## Tests

Future provider tests use fake executables or recorded JSON fixtures.

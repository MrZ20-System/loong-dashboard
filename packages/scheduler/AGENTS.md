# Scheduler Package Agent Instructions

## Purpose

Reserve scheduling, run-state, retry, and workspace-serialization behavior for
the Scheduler stage.

## Boundaries

- Do not import DSH types; call the vendor-neutral Agent Runtime contract.
- Do not own raw SQL, GitHub calls, or local Git commands.
- A workspace path may have at most one active Agent run.

## Verification

Future changes require scheduler unit/integration tests and the root checks.

# @loongboard/knowledge

## Purpose

Provide the Markdown-backed Knowledge repository and its version/checkpoint
integration.

## Owns

- Knowledge tree and document file operations.
- The scoped Git checkpoint service for Knowledge history.

## Does not own

- Product database schema.
- GitHub synchronization, general worktrees, or DSH lifecycle.

## Public API

No Stage 0 API is exported yet.

## Dependencies

None in Stage 0.

## Invariants

Markdown files remain the source of truth; SQLite stores indexes and runtime
state only.

## Tests

Future tests cover file edits, history, and explicit Knowledge Git checkpoints.

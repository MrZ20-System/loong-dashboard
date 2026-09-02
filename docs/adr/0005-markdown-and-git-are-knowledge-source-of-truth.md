# ADR 0005: Markdown and Git are Knowledge source of truth

## Decision

Knowledge documents live as Markdown files. SQLite stores indexes and runtime
state; Git provides long-term recovery and explicit checkpoints.

## Consequence

Document behavior must preserve file-system semantics and must not make a
database copy the canonical content.

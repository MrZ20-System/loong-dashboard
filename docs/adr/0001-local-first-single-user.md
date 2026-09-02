# ADR 0001: Local-first single-user runtime

## Decision

Run the core application on the user's machine with local Git, SQLite,
Markdown, and DSH child processes. Do not introduce a cloud control plane,
PostgreSQL, Redis, or a queue in V1.

## Consequence

The server can use direct typed module boundaries and local filesystem
semantics. Multi-user authorization and distributed coordination are outside
the V1 scope.

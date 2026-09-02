# LoongBoard Architecture

LoongBoard is local-first. A browser talks to one local Node server. The
server owns API orchestration, SQLite state, GitHub metadata synchronization,
local Git workspaces, Knowledge files, scheduling, and the DSH adapter. DSH is
an external Agent runtime and is isolated behind
`packages/agent-runtime-dsh/**`.

## Dependency direction

```text
apps/web -> packages/contracts
apps/server -> packages/contracts, domain packages
packages/agent-runtime-dsh -> external DSH SDK
domain packages -> packages/contracts where an HTTP boundary is involved
```

Domain code does not import DSH types. The adapter maps external notifications
to LoongBoard-owned events before they leave its package.

## Stage 0 boundaries

Stage 0 creates the workspace, shared health contract, architecture checks,
core database schema/migrations, the Fastify health route, the minimal React
shell, and the exact DSH release pin. It does not implement GitHub calls,
product CRUD, business routes or pages, or DSH process lifecycle.

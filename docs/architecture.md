# LoongBoard Architecture

## Runtime shape

The browser calls one local Node server over REST and SSE. The server connects
to SQLite, GitHub through the GitHub provider, local repositories through the
Git workspace boundary, Markdown through the Knowledge service, and DSH via
isolated child processes.

```text
Browser -> Local Server -> { contracts, SQLite, GitHub provider,
                             Git workspace, Knowledge, Scheduler,
                             DSH adapter }
```

## Dependency direction

- Web and Server consume schemas from `packages/contracts`.
- Product code consumes a LoongBoard-owned `AgentRuntime` contract.
- Only `packages/agent-runtime-dsh` knows DSH SDK types and notifications.
- GitHub list reads use SQLite and never invoke GitHub during HTTP reads.
- Domain labels are calculated from changed paths and user rules; AI is not a
  classifier.

## Validation and failures

Validate configuration, HTTP input, external command output, DSH notifications,
and database constraints at their boundaries. Internal typed modules trust the
established invariant. Errors include the operation and relevant repository or
session identifier; command failures are not converted into empty results.

## Stage 0

Stage 0 establishes the workspace, package boundaries, shared health contract,
architecture checks, core database schema/migrations, the Fastify health route,
the minimal React shell, package scaffolds, and the exact DSH pin. It does not
implement product CRUD, GitHub synchronization, business routes or pages, or
DSH lifecycle behavior.

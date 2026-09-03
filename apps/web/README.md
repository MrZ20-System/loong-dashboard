# LoongBoard Web

## Purpose

Provide the Stage 1 Vite and React Router experience for local GitHub metadata.

## Owns

- Stable branded browser layout and navigation.
- Browser-side health API boundary and status presentation.
- Repository selection, PR/Issue lists, filters, pagination, metrics, and
  explicit synchronization status.

## Does not own

GitHub commands, database access, Diff, Agent, Knowledge, Scheduler, or domain
classification behavior.

## Public API

- `App`: the application shell and React Router routes.
- `fetchHealth`: validates `GET /api/health` through the shared contract.
- Metadata client functions validate repository, PR/Issue, activity-day, sync,
  and error responses through shared contracts.
- `resolveApiOrigin`: resolves the Vite development proxy target.

## Dependencies

- `@loongboard/contracts` for every HTTP response schema and type.
- TanStack Query, React, React DOM, React Router, Vite, and Vitest.

## Invariants

- React Router remains the sole router.
- Health transport, HTTP, JSON, and schema failures remain visible.
- HTTP schemas are not redefined in this package.
- Metadata GET, filter, and pagination behavior never invokes GitHub.
- Successful PR and Issue streams refresh independently; a failed stream keeps
  its existing rows visible.
- `/api` proxies to `http://127.0.0.1:4174` by default and honors
  `LOONGBOARD_API_ORIGIN` when configured.

## Tests

Install the workspace dependencies from the repository root, then run:

```bash
pnpm --filter @loongboard/web test
pnpm --filter @loongboard/web typecheck
pnpm --filter @loongboard/web build
```

Tests cover health, strict metadata parsing, URL filters, list navigation,
pagination, fast synchronization, mixed stream outcomes, consecutive attempts,
and repository-switch cancellation recovery.

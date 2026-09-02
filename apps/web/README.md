# LoongBoard Web

## Purpose

Provide the Stage 0 Vite and React Router shell for LoongBoard.

## Owns

- Stable branded browser layout and navigation.
- Browser-side health API boundary and status presentation.

## Does not own

PR, Issue, Diff, Agent, Knowledge, Scheduler, GitHub, database, or server
behavior.

## Public API

- `App`: the application shell and React Router routes.
- `fetchHealth`: validates `GET /api/health` through the shared contract.
- `resolveApiOrigin`: resolves the Vite development proxy target.

## Dependencies

- `@loongboard/contracts` for the health response schema and type.
- React, React DOM, React Router, Vite, and Vitest.

## Invariants

- React Router remains the sole Stage 0 router.
- Health transport, HTTP, JSON, and schema failures remain visible.
- HTTP schemas are not redefined in this package.
- `/api` proxies to `http://127.0.0.1:4174` by default and honors
  `LOONGBOARD_API_ORIGIN` when configured.

## Tests

Install the workspace dependencies from the repository root, then run:

```bash
pnpm --filter @loongboard/web test
pnpm --filter @loongboard/web typecheck
pnpm --filter @loongboard/web build
```

The health view requests `GET /api/health` and validates the response with the
shared `@loongboard/contracts` schema.

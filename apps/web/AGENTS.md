# Web application instructions

This package owns the minimal LoongBoard browser shell under `apps/web/**`.

## Boundaries

- Keep routing on React Router.
- Import HTTP schemas and response types from `@loongboard/contracts`.
- Keep API parsing and transport errors at the client boundary.
- Configure the Vite `/api` proxy with the local default and
  `LOONGBOARD_API_ORIGIN` override.
- Do not add PR, Issue, Diff, Agent, Knowledge, or Scheduler behavior in Stage 0.
- Do not introduce a component framework or duplicate server contracts.

## Checks

Run these commands from the repository root after the workspace is installed:

```bash
pnpm --filter @loongboard/web test
pnpm --filter @loongboard/web typecheck
pnpm --filter @loongboard/web build
```

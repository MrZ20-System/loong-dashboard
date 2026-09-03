# Web application instructions

This package owns the LoongBoard browser shell and metadata list experience
under `apps/web/**`.

## Boundaries

- Keep routing on React Router.
- Import HTTP schemas and response types from `@loongboard/contracts`.
- Keep API parsing and transport errors at the client boundary.
- Configure the Vite `/api` proxy with the local default and
  `LOONGBOARD_API_ORIGIN` override.
- PR and Issue list pages read only the local Server APIs; page load, filtering,
  and pagination must never trigger GitHub.
- Keep the two metadata sync streams independent when refreshing cached lists.
- Do not add Diff, Agent, Knowledge, Scheduler, or Stage 2 domain behavior.
- Do not introduce a component framework or duplicate server contracts.

## Checks

Run these commands from the repository root after the workspace is installed:

```bash
pnpm --filter @loongboard/web test
pnpm --filter @loongboard/web typecheck
pnpm --filter @loongboard/web build
```

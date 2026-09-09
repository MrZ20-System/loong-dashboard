# Web application instructions

This package owns the LoongBoard browser shell, metadata, PR/Issue, Agent, Knowledge, and scheduling UI
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
- Keep domain classification and runtime execution on the Server; reuse the shared chat and Markdown components.
- Do not introduce a component framework or duplicate server contracts.

## Checks

Run these commands from the repository root after the workspace is installed:

```bash
pnpm --filter @loongboard/web test
pnpm --filter @loongboard/web typecheck
pnpm --filter @loongboard/web build
```

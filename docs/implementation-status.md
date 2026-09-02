# Implementation Status

The sole execution baseline is `../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md` in the parent system workspace. This repository is a greenfield implementation and does not copy the rejected legacy dashboard architecture.

## Current stage

Stage 0: Foundation — accepted locally on 2026-09-03.

## Done

- Created the new `system/loong-dashboard` Git repository and pnpm workspace.
- Added root and package-level Agent operating rules.
- Froze first-wave ownership, the health API contract, and Stage 0 task briefs.
- Added the shared health contract, Fastify server, React/Vite shell, SQLite
  migration foundation, Drizzle schema, DSH adapter boundary, and empty package
  scaffolds for later stages.
- Added architecture, pin, unit, migration, integration-entrypoint, and build
  checks under one root `pnpm check` command.
- Refreshed the local CodeGraph index after implementation and inspected the
  Stage 0 configuration, migration, and health-request flow.

## Validated

- `CI=true pnpm install --frozen-lockfile` completed with the committed lockfile.
- `CI=true pnpm check` completed: lint, type checking, architecture boundaries,
  the exact DSH pin, 39 substantive tests, the integration entrypoint, and the
  production build all passed.
- `pnpm dev` started Fastify on `127.0.0.1:4174` and Vite on
  `127.0.0.1:5173`.
- Direct `GET http://127.0.0.1:4174/api/health` and proxied
  `GET http://127.0.0.1:5173/api/health` both returned HTTP 200 with
  `{ "status": "ok" }`; the Web root also returned HTTP 200.
- Validation used Node.js 26.3.0, pnpm 11.19.0, and Git 2.54.0.

## Known limitations

- The repository supports Node.js 24 through 26. The local Node.js 26 runtime
  requires exact `better-sqlite3@12.11.1`; this changes no database ownership or
  API contract.
- Node.js 26 prints a `tsx` deprecation warning for `module.register()` during
  development startup. It does not affect startup or the health contract.
- Stage 0 intentionally has no product-level integration or browser scenarios;
  their entrypoints exist and later stages must add feature tests with their
  behavior.
- DSH is pinned and isolated but is not started in Stage 0. Live DSH lifecycle
  validation belongs to Stage 4.

## Next stage blockers

- None. Stage 1 remains deliberately unstarted until the Team Lead explicitly
  begins it from this accepted foundation.

# Stage 0 Task Plan

## Frozen decisions

- Execution baseline: `/Users/lonng/system/LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md` only.
- Repository: `/Users/lonng/system/loong-dashboard`, created greenfield.
- Router: React Router. Do not add TanStack Router.
- Package manager: pnpm workspace with an exact lockfile.
- API schemas: `packages/contracts` is the only owner of HTTP request and response schemas.
- Database schema and migration runner: `packages/database` is the only owner of schema, raw SQL, migrations, and migration tests.
- DSH imports: only `packages/agent-runtime-dsh/**` may import `@deepseek-ai/*`.
- DSH version: exactly `deepseek-ai/deepseek-harness@dsh-v0.1.2-alpha.5`; no range.
- Health API: `GET /api/health` returns HTTP 200 and JSON `{ "status": "ok" }`.
- Stage 0 scope ends at foundation. No GitHub sync, PR/Issue product CRUD, diff workspace, Agent chat, Knowledge behavior, or Scheduler behavior.

## Ownership

| Area | Stage 0 owner | Writable scope |
| --- | --- | --- |
| Lead plan and acceptance | Team Lead (Sol High) | `docs/implementation-status.md`, `docs/stage-0-tasks.md`, integration-only fixes |
| Workspace, contracts, checks, DSH pin | Integration Lead | root toolchain files, `scripts/**`, `packages/contracts/**`, `packages/agent-runtime-dsh/**`, empty package scaffolds |
| Web shell | Implementation Agent | `apps/web/**` |
| Database and server foundation | Senior Engineer | `packages/database/**`, `apps/server/**` |
| API contract | Integration Lead | `packages/contracts/**` exclusively |
| Database migrations | Senior Engineer | `packages/database/**` exclusively |

Maximum first-wave implementation Agents: 3. No two Agents may modify the same package.

## First-wave briefs

### S0-T1 — Workspace, contracts, architecture checks, and DSH pin

#### Goal

Create the pnpm/TypeScript workspace foundation, the shared health contract, unified checks, required package directories and scoped guidance, and the exact DSH dependency lock.

#### Non-goals

No product feature, GitHub call, Git command service, database schema, Fastify implementation, React implementation, DSH runtime lifecycle, or speculative abstraction.

#### Files allowed

Root toolchain/config files; `scripts/**`; `packages/contracts/**`; `packages/agent-runtime-dsh/**`; empty Stage 0 scaffolds under other `packages/**`; `docs/requirements.md`; `docs/architecture.md`; other initial architecture/operations/testing/ADR documents. Do not modify `apps/**`, `packages/database/**`, or this task plan.

#### Existing contracts

The frozen decisions above and the baseline sections 2, 3, 5, 6, 7, 17, 23, and 24.

#### Required behavior

Root scripts expose `dev`, `build`, `lint`, `typecheck`, `test`, `test:ut`, `test:regression`, `check:architecture`, `check:dsh-boundary`, `check`, and `check:full`. Architecture checks report the violating file, rule, and repair direction. `packages/contracts` owns a Zod schema for `{ status: 'ok' }`. The DSH dependency is exactly pinned and represented in `dsh.lock.json` and `pnpm-lock.yaml`.

#### Required tests

Contract parse tests and architecture-check fixture tests for at least the DSH import boundary and raw-SQL boundary.

#### Acceptance commands

`pnpm install`; `pnpm --filter @loongboard/contracts test`; `pnpm check:architecture`; `pnpm typecheck`.

#### Dependencies / blocked by

None. This task owns the shared contract and must publish it before final Server/Web integration.

### S0-T2 — React shell

#### Goal

Create a minimal Vite React shell that builds and visibly identifies LoongBoard.

#### Non-goals

No PR, Issue, Diff, Agent, Knowledge, Scheduler, component framework, data-fetching feature, or alternate router.

#### Files allowed

`apps/web/**` only.

#### Existing contracts

Use React Router and the health response type from `@loongboard/contracts`; do not define a duplicate health type.

#### Required behavior

The app renders a stable shell, uses React Router, and contains a minimal health client boundary without hiding fetch failures.

#### Required tests

A focused component test for the shell and a health-client contract test.

#### Acceptance commands

`pnpm --filter @loongboard/web test`; `pnpm --filter @loongboard/web typecheck`; `pnpm --filter @loongboard/web build`.

#### Dependencies / blocked by

The package may scaffold in parallel, but final typecheck is blocked by S0-T1 publishing `@loongboard/contracts` and root workspace configuration.

### S0-T3 — SQLite migration runner and Fastify health API

#### Goal

Implement the Stage 0 database foundation and a Fastify server exposing the frozen health endpoint.

#### Non-goals

No Stage 1 entity syncing, no GitHub/Git execution, no business routes, no DSH integration, and no generic repository abstraction.

#### Files allowed

`packages/database/**` and `apps/server/**` only.

#### Existing contracts

`GET /api/health` must validate and return the shared `@loongboard/contracts` response `{ status: 'ok' }`. Raw SQL exists only under `packages/database/**`. The Stage 0 migration must establish the documented V1 core tables without implementing their services.

#### Required behavior

Provide deterministic ordered migrations, a migration ledger, idempotent re-runs, SQLite foreign keys, and an injectable database path for tests. Provide a Fastify app factory separate from process startup. Configuration errors fail fast.

#### Required tests

Migration tests cover fresh database creation and idempotent re-run. Server integration tests assert status, content type, and exact response for `/api/health`.

#### Acceptance commands

`pnpm --filter @loongboard/database test`; `pnpm --filter @loongboard/server test`; `pnpm --filter @loongboard/server typecheck`.

#### Dependencies / blocked by

Final Server typecheck is blocked by the S0-T1 workspace and health contract. Database implementation is independent.

## Lead acceptance

After all three tasks are integrated, the Team Lead runs `codegraph sync`, reviews package dependencies and boundary checks, then runs:

```text
pnpm install
pnpm check
pnpm dev
GET /api/health = 200
```

Only then may Stage 0 be marked accepted or Stage 1 begin.

# @loongboard/server

## Purpose

Local Fastify HTTP server for LoongBoard.

## Owns

- Fastify app construction and route registration.
- The local server process entrypoint.
- Strict `system.yaml` loading and one-time path resolution.
- Stage 1 runtime composition and bounded background metadata synchronization.

## Does not own

- HTTP request or response contracts.
- Database schema, migrations, or raw SQL.
- GitHub command execution, local Git, Knowledge, Scheduler, or DSH behavior.

## Public API

- `buildApp(dependencies, options)`: creates a Fastify application without
  listening from explicit database, timezone, and sync-coordinator
  dependencies.
- `systemConfigSchema`: strict V1 configuration contract.
- `loadSystemConfig(path)`: parses YAML, validates it, and resolves configured
  paths once relative to the configuration file.
- `resolveSystemConfigPath(environment, cwd)`: selects the explicit environment
  path or the repository parent's `system.yaml`, whether invoked from the
  repository root or a package working directory.
- `RepositorySyncCoordinator`: starts one background run per repository with a
  global maximum of two active repositories and independent PR/Issue streams.
- `createServerRuntime`: reconciles configured repositories, opens the runtime
  database, wires the provider/coordinator/app, and owns graceful shutdown.

## Dependencies

- `fastify` for the HTTP server.
- `zod` for system-configuration boundary validation.
- `yaml` for parsing `system.yaml`.
- `@loongboard/contracts` for shared HTTP response validation.
- `@loongboard/database` for typed persistence operations.
- `@loongboard/github` for the metadata provider boundary.

## Invariants

- `GET /api/health` returns exactly `{ "status": "ok" }` with HTTP 200.
- The health response is validated by the shared contract.
- Importing the app factory never starts a network listener.
- Invalid or missing system configuration stops startup before listening.
- `knowledge.inbox` is a relative directory contained by the resolved
  `knowledge.path`.
- PR/Issue GET routes read SQLite only; only the explicit sync POST calls the
  GitHub provider.
- Sync POST has an empty-body contract, returns 202 without waiting, and a
  second run for the same repository returns 409.
- Shutdown waits for active runs before closing SQLite.

## Tests

Fastify injection tests cover health, strict request/error boundaries, every
Stage 1 route, background 202 behavior, concurrency, bootstrap/incremental
selection, mixed stream failures, and shutdown ordering. Configuration tests
cover validation and path resolution.

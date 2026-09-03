# @loongboard/server

## Purpose

Local Fastify HTTP server for LoongBoard.

## Owns

- Fastify app construction and route registration.
- The local server process entrypoint.
- Strict `system.yaml` loading and one-time path resolution.

## Does not own

- HTTP request or response contracts.
- Database schema, migrations, or raw SQL.
- GitHub, local Git, Knowledge, Scheduler, or DSH behavior in Stage 0.

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

## Dependencies

- `fastify` for the HTTP server.
- `zod` for system-configuration boundary validation.
- `yaml` for parsing `system.yaml`.
- `@loongboard/contracts` for shared HTTP response validation.

## Invariants

- `GET /api/health` returns exactly `{ "status": "ok" }` with HTTP 200.
- The health response is validated by the shared contract.
- Importing the app factory never starts a network listener.
- Invalid or missing system configuration stops startup before listening.
- `knowledge.inbox` is a relative directory contained by the resolved
  `knowledge.path`.

## Tests

`test/health.test.ts` uses Fastify injection to verify the health response status,
content type, and exact body. Configuration tests cover valid parsing, invalid
fail-fast behavior, path resolution, extra-field rejection at every schema
layer, and startup-path selection.

# @loongboard/contracts

## Purpose

Shared runtime-validated HTTP contracts for the LoongBoard Web and Server.

## Owns

- Zod schemas for request and response boundaries.
- Inferred TypeScript types exported next to those schemas.
- The frozen `GET /api/health` response contract.
- The frozen Stage 1 repository, sync-status, PR/Issue list, activity-day,
  query, cursor, and error contracts.

## Does not own

- HTTP routes or server startup.
- Database schema or raw SQL.
- GitHub, local Git, or DSH operations.
- UI state and data-fetching behavior.

## Public API

- `healthResponseSchema`: strict Zod schema for `{ status: "ok" }`.
- `HealthResponse`: inferred response type.
- `repositoriesResponseSchema`, `syncStatusResponseSchema`, and
  `syncAcceptedResponseSchema` for repository selection and manual sync;
  `repositoryParamsSchema` validates repository-scoped path parameters.
- `pullRequestsResponseSchema`, `issuesResponseSchema`, and
  `activityDaysResponseSchema` for metadata lists.
- `pullRequestsQuerySchema`, `issuesQuerySchema`, and
  `activityDaysQuerySchema` for HTTP query validation.
- `encodeListCursor` and `decodeListCursor` for the versioned opaque list
  cursor.
- `apiErrorSchema` for the frozen error envelope.

## Dependencies

- `zod` for runtime validation.

## Invariants

- Web and Server import HTTP schemas from this package instead of redefining
  them.
- The health schema accepts only the exact successful response shape.
- Calendar dates are real `YYYY-MM-DD` dates, not parser-normalized strings.
- List cursors are versioned, URL-safe, and contain only the stable ordering
  key (`updatedAt`, `number`).
- Cursor query and response fields accept only nonblank opaque strings; cursor
  encoding remains an implementation detail of the persistence boundary.

## Tests

`tests/health.test.ts` covers successful parsing, invalid status, missing data,
and extra fields.

# @loongboard/contracts

## Purpose

Shared runtime-validated HTTP contracts for the LoongBoard Web and Server.

## Owns

- Zod schemas for request and response boundaries.
- Inferred TypeScript types exported next to those schemas.
- The frozen `GET /api/health` response contract.

## Does not own

- HTTP routes or server startup.
- Database schema or raw SQL.
- GitHub, local Git, or DSH operations.
- UI state and data-fetching behavior.

## Public API

- `healthResponseSchema`: strict Zod schema for `{ status: "ok" }`.
- `HealthResponse`: inferred response type.

## Dependencies

- `zod` for runtime validation.

## Invariants

- Web and Server import HTTP schemas from this package instead of redefining
  them.
- The health schema accepts only the exact successful response shape.

## Tests

`tests/health.test.ts` covers successful parsing, invalid status, missing data,
and extra fields.

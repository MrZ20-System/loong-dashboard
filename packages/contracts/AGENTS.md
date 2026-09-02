# Contracts Package Agent Instructions

## Purpose

Own the shared, runtime-validated HTTP request and response schemas used by the
LoongBoard Web and Server packages.

## Boundaries

- Keep HTTP schemas and their inferred TypeScript types in this package.
- Do not import DSH, GitHub CLI, Git, SQLite, Fastify, or React code here.
- Keep the health response exact: `{ status: "ok" }`.
- Validate data entering a boundary once; typed callers may rely on the result.

## Verification

Run `pnpm test` and `pnpm typecheck` from this package after a contract change.

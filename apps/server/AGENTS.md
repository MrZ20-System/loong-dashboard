# Server App Agent Instructions

## Purpose

Own the local Fastify HTTP process and route composition.

## Boundaries

- Import request and response schemas from `@loongboard/contracts`.
- Keep the app factory independent from process startup.
- Validate `system.yaml` once and resolve its paths relative to the file before
  entering typed application code.
- Do not place raw SQL here.
- Do not call GitHub, Git, or DSH in Stage 0.

## Verification

Run `pnpm test` and `pnpm typecheck` from this app after a Server change.

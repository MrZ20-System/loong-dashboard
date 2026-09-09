# Server App Agent Instructions

## Purpose

Own the local Fastify HTTP process and route composition.

## Boundaries

- Import request and response schemas from `@loongboard/contracts`.
- Keep the app factory independent from process startup.
- Validate `system.yaml` once and resolve its paths relative to the file before
  entering typed application code.
- Do not place raw SQL here.
- Route GitHub metadata work only through `@loongboard/github`; GET list routes
  remain SQLite-only and sync starts only from the explicit POST route.
- Keep Pull Request and Issue stream failures independent and make process
  shutdown wait for active synchronization before closing SQLite.
- Route local Git and DSH through their package adapters; keep orchestration here.

## Verification

Run `pnpm --filter @loongboard/server test`, typecheck, and build from the
repository root after a Server change.

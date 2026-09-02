# DSH Adapter Package Agent Instructions

## Purpose

Contain all interaction with the pinned DeepSeek Harness SDK. This package is
the only location where `@deepseek-ai/*` may be imported.

## Boundaries

- Keep DSH SDK types and notifications inside this package.
- Expose LoongBoard-owned runtime contracts to callers; never leak raw DSH
  `SessionEvent` or Cordis types.
- Use the exact release recorded in the repository `dsh.lock.json`.
- Do not implement a DSH Plugin or duplicate DSH's Agent loop.

## Stage 0 scope

Stage 0 reserves the boundary and pins the dependency. Session lifecycle,
process supervision, cancellation, and event mapping belong to Stage 4.

## Verification

Run `pnpm test`, `pnpm typecheck`, and the root DSH boundary check after future
adapter changes.

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

## Current implementation

Own subprocess lifecycle, stop, notification mapping, and streaming through the product runtime contract. See `../../docs/dsh-integration.md`.

## Verification

Run `pnpm test`, `pnpm typecheck`, and the root DSH boundary check after adapter changes.

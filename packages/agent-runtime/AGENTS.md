# Agent Runtime Package Agent Instructions

## Purpose

Reserve the LoongBoard-owned runtime contract that the Server and product
features use without knowing which external Agent runtime is underneath.

## Boundaries

- Keep public types independent of DSH and other vendor SDKs.
- Do not import `@deepseek-ai/*` here; that boundary belongs exclusively to
  `packages/agent-runtime-dsh/**`.
- Do not add lifecycle behavior before its Stage 4 task is assigned.

## Verification

Run the root architecture and type checks after changes.

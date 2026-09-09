# Agent Runtime Package Agent Instructions

## Purpose

Own the LoongBoard runtime contract and session runtime host that the Server and product
features use without knowing which external Agent runtime is underneath.

## Boundaries

- Keep public types independent of DSH and other vendor SDKs.
- Do not import `@deepseek-ai/*` here; that boundary belongs exclusively to
  `packages/agent-runtime-dsh/**`.
- Keep product persistence in the Server/database and SDK process details in the adapter.

## Verification

Run the root architecture and type checks after changes.

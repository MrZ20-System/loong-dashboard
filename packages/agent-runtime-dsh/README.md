# @loongboard/agent-runtime-dsh

## Purpose

Isolate the external DeepSeek Harness runtime behind a LoongBoard-owned
boundary.

## Owns

- The exact DeepSeek Harness package pin.
- Future DSH SDK process integration and notification mapping.
- Conversion from DSH events to the project `AgentRuntime` contract.

## Does not own

- Product workflows, permissions, or database persistence.
- Web components or Server routes.
- A DSH Plugin, DSH Web UI, or a replacement Agent loop.

## Public API

Stage 0 exports only `DSH_RELEASE` as a pin marker. Runtime lifecycle APIs are
deferred until the Stage 4 task is accepted.

## Dependencies

- `@deepseek-ai/dsh` `0.1.2-alpha.5`.
- `@deepseek-ai/dsh-sdk-client` `0.1.2-alpha.5`.

## Invariants

- This is the only package permitted to import `@deepseek-ai/*`.
- Raw DSH session/event types never cross the package boundary.
- The release must match `dsh.lock.json` exactly.

## Tests

Stage 0 validates the package pin and import boundary. Stage 4 adds DSH
compatibility and lifecycle tests without asserting internal DSH persistence
files.

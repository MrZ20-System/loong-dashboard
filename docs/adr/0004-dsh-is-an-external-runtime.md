# ADR 0004: Treat DSH as an external runtime

## Decision

Integrate DeepSeek Harness through `packages/agent-runtime-dsh` and a small
LoongBoard-owned runtime contract. Do not fork DSH or write a product DSH
Plugin.

## Consequence

DSH can be upgraded or replaced behind one adapter, while product code stays
independent of raw SessionEvent and vendor types.

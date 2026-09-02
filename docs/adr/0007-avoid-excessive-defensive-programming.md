# ADR 0007: Avoid excessive defensive programming

## Decision

Validate once at external boundaries and fail fast with an operation-specific
error. Do not add silent catches, empty-result fallbacks, generic Result
wrappers, or speculative compatibility layers.

## Consequence

Internal modules can use established TypeScript invariants and failures remain
visible to operators and tests.

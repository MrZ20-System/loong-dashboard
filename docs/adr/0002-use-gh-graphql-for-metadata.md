# ADR 0002: Use GitHub CLI GraphQL for metadata

## Decision

Use `gh api graphql` and `gh api` through `packages/github` for GitHub metadata
bootstrap and incremental synchronization.

## Consequence

External JSON is validated once at the provider boundary, and list HTTP reads
remain local SQLite reads.

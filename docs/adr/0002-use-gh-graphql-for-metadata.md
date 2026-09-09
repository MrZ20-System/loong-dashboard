# ADR 0002: Use GitHub CLI GraphQL for metadata

## Status

Superseded for transport; the provider boundary remains accepted. Current implementation uses native HTTP fetch for GraphQL/REST, with GITHUB_TOKEN or gh auth token for authentication. See [GitHub synchronization](../github-sync.md).

## Original decision

Use `gh api graphql` and `gh api` through `packages/github` for GitHub metadata
bootstrap and incremental synchronization.

## Consequence

External JSON is validated once at the provider boundary, and list HTTP reads
remain local SQLite reads.

# @loongboard/github

## Purpose

Provider boundary for GitHub metadata synchronization.

## Owns

- `gh api graphql --input -` command execution for pull-request and issue
  metadata pages.
- GitHub response validation and metadata provider behavior.

## Does not own

- SQLite schema or raw SQL.
- Local Git workspaces.
- HTTP list rendering or DSH runtime behavior.

## Public API

`GhGitHubMetadataProvider` exposes the frozen metadata streams:

- `fetchPullRequestUpdates(input)`;
- `fetchIssueUpdates(input)`.

Each stream yields typed pages and performs exactly one `gh api graphql`
invocation per page. Bootstrap reads all open items and then the configured
closed lookback; incremental reads all states down to the inclusive watermark
overlap floor.

## Dependencies

`execa` runs `gh` with `shell: false`; `zod` validates each GraphQL response at
the command boundary.

## Invariants

HTTP list reads use SQLite and never invoke GitHub directly.

## Tests

Provider tests use a temporary fake `gh` executable and assert exact argv,
stdin request bodies, page iteration, cutoff behavior, response validation,
and command counts. No per-item `gh pr view` command is used.

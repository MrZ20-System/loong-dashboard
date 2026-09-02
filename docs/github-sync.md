# GitHub Synchronization

GitHub access is a provider boundary. Only `packages/github/**` may execute
`gh api graphql` or `gh api`, and its external JSON is validated before it
enters typed domain code.

## Read model

The Server reads pull-request and issue lists from SQLite. An HTTP list request
does not call GitHub. Bootstrap and incremental synchronization update the
local read model; changed-file enrichment runs only for a new pull request or
when its head SHA changes.

## V1 constraints

The list model uses user-relevant metadata such as `updatedAt`, status, and
changed paths. It does not fetch comments, reviews, timeline bodies, or
AI-generated summaries for list rendering. Failures are explicit and may mark
file enrichment as pending without pretending that no data exists.

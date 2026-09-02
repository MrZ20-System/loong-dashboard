# ADR 0003: Use local Git for pull-request content

## Decision

Use the local repository and disposable worktrees for pull-request diffs and
full-file content. Keep Git commands in the Git workspace boundary.

## Consequence

Large content is read on demand without turning GitHub into the content path.

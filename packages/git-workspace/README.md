# @loongboard/git-workspace

## Purpose

Safe local Git and disposable worktree operations for LoongBoard.

## Owns

- Local Git command adapters.
- Worktree allocation and cleanup behavior.

## Does not own

- GitHub CLI synchronization.
- SQLite schema or HTTP routes.
- DSH process lifecycle.

## Public API

No Stage 0 API is exported yet.

## Dependencies

None in Stage 0.

## Invariants

Only this package executes local Git commands for the PR workspace.

## Tests

Future tests use temporary Git fixture repositories.

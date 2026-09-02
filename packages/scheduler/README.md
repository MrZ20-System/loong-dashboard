# @loongboard/scheduler

## Purpose

Future home of scheduled prompts and their durable run state.

## Owns

- Schedule calculation and run orchestration once the Scheduler stage begins.
- Workspace-path serialization for Agent runs.

## Does not own

- DSH SDK interaction, GitHub, Git, or database schema.

## Public API

No Stage 0 API is exported yet.

## Dependencies

None in Stage 0.

## Invariants

One workspace path can run only one Agent turn at a time.

## Tests

Future tests cover cron calculations, restart semantics, and the workspace
mutex.

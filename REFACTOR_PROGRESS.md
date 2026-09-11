# LoongBoard Pre-Freeze Refactor Progress

- Baseline SHA: `57d1cedafab9a1510d6616619cc33859f56d125d`
- Current phase: Phase 1 — schema canonicalization

## Frozen product semantics

- Metadata sync paths are only Forward Sync, History Backfill, and Fetch PR.
- Merged is a `pull_requests` projection ordered by `merged_at DESC`; it is not a separate sync path.
- PR lists use page/limit/OFFSET and support direct page navigation; Issue lists retain cursor pagination.
- Every scheduled Agent occurrence creates a fresh Agent Session; tasks do not reuse conversations.
- DSH remains isolated behind `packages/agent-runtime` and `packages/agent-runtime-dsh`.
- Worktree dirty/busy/affinity/LRU/capacity/TTL behavior is frozen.
- Git checkpoint and push remain distinct; push uses source ref to remote backup ref without checkout, force push, rebase, or merge.
- Deployment remains local-first and single-user.

## Canonical model decisions

- Compatibility knowledge may remain only in SQLite migrations, settings migration, and migration tests.
- Runtime and public contracts must expose one canonical field/path per business concept.
- Settings policy, scheduled task projection, and runtime facts must remain separate authorities.

## Completed changes

- Phase 0: added explicit canonical tests for PR ordering/archive/Merged projection, Issue reopen/payload-marker independence, forward/history/fetch state isolation, manual Agent title ownership, and Git backup push behavior.
- Confirmed existing scheduler persistence tests cover a fresh Agent Session per occurrence, no task session reuse, and no Agent workspace claim for system tasks.

## Pending changes

- Phase 1: add migration 014 and remove schema/runtime compatibility paths identified by the audit.
- Phases 2–13: execute the supplied canonicalization plan in dependency order.

## Migrations added

- None.

## Legacy items removed

- None.

## Tests run

- Phase 0 database metadata/retention: 2 files, 22 tests passed.
- Phase 0 Git backup: 1 file, 5 tests passed.
- Phase 0 Server sync/scheduler/title: 3 files, 24 tests passed.
- Database, Git workspace, Server, Agent Runtime typechecks passed in delegated targeted runs.
- `git diff --check` passed.

## Known failures

- None.

## Known intentionally deferred work

- None. The Phase 1 audit found the `agent_sessions.scope_type` rebuild feasible with explicit child-FK and row-preservation checks, so it is not deferred.

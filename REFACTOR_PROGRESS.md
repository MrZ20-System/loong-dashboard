# LoongBoard Pre-Freeze Refactor Progress

- Baseline SHA: `57d1cedafab9a1510d6616619cc33859f56d125d`
- Current phase: Phase 2 — settings canonicalization

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
- Phase 1: rebuilt Scheduler task/run, Agent session, and Worktree slot persistence into one canonical schema; removed runtime/API compatibility projections and legacy metadata cursor/date/sync paths.
- Phase 1 review fixes: each scheduled run exposes its own Agent link; repository-scoped system actions require a valid repository; orphan legacy run pointers safely become NULL; system task Agent-only fields are NULL.

## Pending changes

- Phase 2: migrate settings documents to strict V2 and make settings policy the only policy authority.
- Phases 3–13: execute the supplied canonicalization plan in dependency order.

## Migrations added

- `014_phase1_schema_canonicalization`: removes Scheduler conversation pointers, canonicalizes actions, makes `origin_kind` the Agent discriminator, removes Worktree busy ownership residue, and preserves valid child references.

## Legacy items removed

- `scheduled_tasks.conversation_id` and `setScheduledTaskConversation`.
- `scheduled_task_runs.conversation_id`; runs expose only `agentSessionId`.
- Runtime system-action normalization and hyphenated action aliases.
- `agent_sessions.scope_type` runtime/schema use and `scopeType` list query.
- `worktree_slots.busy_session_id` runtime/schema use.
- Generic list cursor sort variants and legacy metadata `date` query.
- Test-only `startRepositorySync`; production Coordinator transitions are now the only path.

## Tests run

- Phase 0 database metadata/retention: 2 files, 22 tests passed.
- Phase 0 Git backup: 1 file, 5 tests passed.
- Phase 0 Server sync/scheduler/title: 3 files, 24 tests passed.
- Database, Git workspace, Server, Agent Runtime typechecks passed in delegated targeted runs.
- `git diff --check` passed.
- Phase 1 Contracts cursor/scheduler: 2 files, 7 tests passed.
- Phase 1 Database migration/scheduler/agent/worktree/metadata: 5 files, 46 tests passed.
- Phase 1 Server scheduler/settings/sync/title: 5 files, 32 tests passed.
- Phase 1 Web schedules/metadata/App: 4 files, 40 tests passed.
- Contracts, Database, Server, and Web typechecks passed; `git diff --check` passed.

## Known failures

- None.

## Known intentionally deferred work

- None. The Phase 1 audit found the `agent_sessions.scope_type` rebuild feasible with explicit child-FK and row-preservation checks, so it is not deferred.

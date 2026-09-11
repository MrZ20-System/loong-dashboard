# LoongBoard Pre-Freeze Refactor Progress

- Baseline SHA: `57d1cedafab9a1510d6616619cc33859f56d125d`
- Current phase: Phase 12

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
- Phase 2: introduced a strict Settings V2 document and explicit missing/V1 migration, made Settings the sole operational-policy authority, and kept scheduler/run state as runtime-only projections.
- Phase 2 review fixes: preserved the Agent archive repository path as durable policy, rejected Agent-to-system task conversion through the generic scheduler endpoint, and aligned strict-V2 operational documentation.
- Phase 3: kept `SchedulerEngine` as the single time/run engine, moved the nine canonical system-action handlers to `apps/server/src/system-actions.ts`, and moved Settings-to-task projection to `apps/server/src/system-schedules.ts` before scheduler start and after Settings updates.
- Phase 3 cron migration: replaced the custom cron parser with numeric five-field `validateCron`/`nextOccurrence` wrappers over `cron-parser`; named and extended syntax is rejected, and timezone/DST/DOM-DOW calculation remains delegated to the library.
- Phase 4: reduced `runtime.ts` to the composition root; centralized Settings, backup, worktree, and Agent runtime adapters in `runtime-settings-adapters.ts`; corrected the Agent Archive default to `systemRoot/agent-history` with an explicit persisted custom path taking precedence; added runtime-only Code backup Git availability detection and container-image UI/action guards; and ordered shutdown so Scheduler waits for active scheduled Agent runs before Agent runtime close.
- Phase 5: made `buildProductionApp` the complete production HTTP factory with required product capabilities; the Server package index exposes only this production entry, while optional fallback behavior remains inside the focused-test-only `buildTestApp`, imported directly from `src/app` by same-repository tests. Removed the old `buildApp` entry point. Made the product `SyncCoordinator` history and fetch operations required, removed route-level undefined defenses, and supplied complete test fakes. Kept `app.ts` as the Fastify composition boundary while moving repositories, sync, metadata, and auth routes into `apps/server/src/routes/`; HTTP paths and schemas are unchanged.
- Phase 6: removed the Drizzle adapter, schema, and dependency; made migrations plus typed SQLite services the sole database source boundary; removed the two legacy purge aliases and high-confidence dead/internal public APIs; and retained raw SQLite migration assertions for canonical tables and foreign-key verification.
- Phase 7: split the GitHub integration by responsibility while preserving the package facade and observable behavior. `provider.ts` is now a 335-line composition facade over `github-client.ts`, `pull-requests.ts`, `issues.ts`, and the expanded `files.ts`; token resolution, HTTP/GraphQL handling, PR/Issue paging and history semantics, file batching/REST fallback, quota projection, public exports, and error contracts remain unchanged. Updated the package and architecture/current-state documentation, and replaced the last Server raw scheduled-task test queries with the typed database service so the architecture guard remains canonical.
- Phase 8: kept `RepositorySyncCoordinator` as the sole queue/admission/priority/limiter/continuation/recovery owner while moving forward, history, and fetch-PR page execution into three narrow runners. Kept `AgentChatController` as the compatible route and caller facade while moving durable session/workspace/runtime lifecycle, turn execution/persistence, and SSE/interaction fan-out into dedicated services. Provisional native titles now retry after every successful turn with per-session single-flight and a 2-second cooldown; empty/error/unavailable results may retry, while generated/manual ownership remains final and title failures never affect turn success.
- Phase 9: made archive and payload-pruned state independent in PR/Issue details; PR Fetch clears the prune marker only after changed-file payload restoration, while pruned Issue GET stays local until the explicit refresh endpoint is used. Activity links now open `archive=all`; Web business clients emit one global auth-required event on a matching 401 so `AuthGate` immediately re-locks. Metadata maintenance replaced its event-loop busy poll with a close-interruptible 150 ms delay while preserving batch-boundary admission.
- Phase 10: split the Settings control center into repository, GitHub, Agent, backup, and archive sections; split the monolithic Web stylesheet into ordered base, shell, metadata, settings, Agent, knowledge, and responsive modules; and reduced list URL canonicalization to formal illegal-value cleanup plus model-specific pagination. Issues retain cursor pagination, while PR and Merged retain page/limit navigation. Cross-review caught and restored the Repository Activity desktop style block before acceptance.
- Phase 11: split the mixed Database metadata suite into repository, sync, pull-request, pull-request-files, issue, domain, and activity service tests; expanded the real 013-to-014 migration fixture to prove durable canonical state and removed legacy columns; and reduced `App.test.tsx` to AuthGate, Shell, Router, primary navigation, and NotFound. Forward-sync invalidation, repository context, metadata feed accessibility, and sidebar behavior now live at their nearest Web component boundaries. The Server and regression suites were audited without adding fixture-heavy duplicates; their existing orchestration and three cross-module regression contracts remain focused.

## Pending changes

- Phases 12–13 remain.

## Migrations added

- `014_phase1_schema_canonicalization`: removes Scheduler conversation pointers, canonicalizes actions, makes `origin_kind` the Agent discriminator, removes Worktree busy ownership residue, and preserves valid child references.
- Settings document migration: missing/V1 input is converted once to a complete strict V2 document and atomically written; invalid V2 input is rejected without overwrite.

## Legacy items removed

- `scheduled_tasks.conversation_id` and `setScheduledTaskConversation`.
- `scheduled_task_runs.conversation_id`; runs expose only `agentSessionId`.
- Runtime system-action normalization and hyphenated action aliases.
- `agent_sessions.scope_type` runtime/schema use and `scopeType` list query.
- `worktree_slots.busy_session_id` runtime/schema use.
- Generic list cursor sort variants and legacy metadata `date` query.
- Test-only `startRepositorySync`; production Coordinator transitions are now the only path.
- Knowledge Settings aliases `branch` and `intervalMinutes` outside the V1 migration boundary.
- Runtime facts such as next/last/error timestamps from durable `settings.json` policy.
- Generic scheduled-task mutation of system tasks, including Agent-to-system kind conversion.
- Legacy scheduler system-action switch, inline system-task definitions/projector, and custom cron parser.

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
- Phase 2 Contracts Settings: 1 file, 3 tests passed.
- Phase 2 Server Settings/config/Knowledge/schedule projection/scheduler persistence/archive: 7 files, 50 tests passed.
- Phase 2 Web Settings payload: 1 file, 1 test passed.
- Contracts, Server, and Web typechecks passed; `git diff --check` passed.
- Phase 3 Scheduler cron: 1 file, 11 tests passed.
- Phase 3 Server system actions/schedules/runtime projection/scheduler persistence/scheduled tasks/archive: 6 files, 23 tests passed after follow-up.
- Phase 3 Scheduler and Server typechecks passed; `git diff --check` passed.
- Phase 4 Contracts Settings: 4 tests passed.
- Phase 4 Git workspace checkpoint/availability: 6 tests passed.
- Phase 4 Server focused coverage: 40 tests passed across 6 files; SchedulerEngine active-run close waiting is covered by focused tests. The createServerRuntime/app.close end-to-end lifecycle was not run because the macOS single-file setup triggers `EMFILE`.
- Phase 4 Web Settings: 3 tests passed.
- Phase 4 Contracts, Git workspace, Server, and Web typechecks passed; `git diff --check` passed.
- Phase 5 lightweight validation: Server typecheck; 12 health/auth/sync-history/issue-detail tests; 2 runtime construction/projection tests; 2 backend-critical regression tests; zero residual matches for old `buildApp`, old types, `SyncCoordinator` casts, and the five formerly optional methods; `git diff --check` passed. Full `pnpm check`, real UI, Docker, and live provider/DSH paths were not claimed.
- Phase 6 lightweight validation: Database 9 files, 58 tests passed (including 15 migration tests); Database typecheck; Server typecheck; `git diff --check` passed. Root `pnpm check` and real runtime validation were not run.
- Phase 7 lightweight validation: GitHub 4 files, 38 tests passed; GitHub typecheck and production build passed; production-condition package import smoke passed; Server scheduled-task test 3 tests passed; architecture guard and `git diff --check` passed. A separate Luna Max strict review found no P0/P1/P2 issue. Root `pnpm check`, live GitHub credentials/API behavior, and real UI were not run.
- Phase 8 lightweight validation: 6 focused Server files, 44 tests passed for forward/history/fetch coordination, Agent lifecycle, title retry, interactions, and workspace ownership; Server typecheck, root typecheck, architecture guard, and `git diff --check` passed. A separate full Server run also passed 29 files/146 tests, and the strict cross-review found no P0/P1/P2 issue. Production build, live GitHub/DSH, and browser smoke were not run.
- Phase 9 lightweight validation: Database retention/metadata 2 files/22 tests, Server issue/sync/maintenance 4 files/31 tests, and Web auth/clients/PR/Issue/Activity 8 files/37 tests passed. Database, Server, and Web typechecks plus the architecture guard and `git diff --check` passed; strict cross-review found no P0/P1/P2 issue. Full root checks, live GitHub, and browser smoke remain for final validation.
- Phase 10 lightweight validation: Web behavior 9 files/63 tests passed; Web typecheck and production build passed. After restoring the Activity style block, 4 focused files/10 tests and `git diff --check` passed. Independent Settings, CSS, and URL cross-reviews found no remaining P0/P1/P2 issue. Full root checks and real browser smoke remain for final validation.
- Phase 11 package validation: Database 15 files/62 tests and typecheck passed; Web 38 files/166 tests and typecheck passed; Server audit run 29 files/152 tests and typecheck passed. Five focused Web boundary files/33 tests passed under independent review. The three-test regression suite was audited but not rerun because it was unchanged; it remains deferred to final `check:full`. `git diff --check` passed, and final cross-review found no remaining P0/P1/P2 issue.

## Known failures

- None.

## Known intentionally deferred work

- Docker PUID/PGID support is deferred: the current Debian runtime would require non-trivial user creation and ownership migration, potentially recursive changes to user data, and no Docker runtime is available here for safe validation. The existing `/data` persistence and container defaults are unchanged; Phase 13 will document the Linux bind-mount ownership limitation.

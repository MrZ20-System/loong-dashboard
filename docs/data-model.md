# LoongBoard Data Model

The database package owns migrations, schema, raw SQL, and migration tests.
Stage 0 established the core tables and migration ledger. Stage 1 implements
repository reconciliation, sync state, and PR/Issue metadata persistence while
later entity services remain deferred.

## Core entities

- `repositories` and `repository_sync_state` describe configured local and
  remote repositories.
- `pull_requests`, `pull_request_files`, `domain_rules`, and
  `pull_request_domains` support metadata, changed paths, and deterministic
  labels.
- `issues` stores synchronized issue metadata.
- `agent_sessions`, `agent_messages`, and `worktree_slots` store persistent
  session state, normalized messages, and disposable workspace allocation.
  A session may reference either a repository-scoped PR through `pr_number`, a
  repository-scoped Issue through `issue_number`, or a commit through
  `target_sha`; the database enforces that at most one target is selected.
- `knowledge_documents` and `document_versions` index Markdown source files
  and their short-term history.
- `scheduled_tasks` and `scheduled_task_runs` store schedule definitions and
  execution state.

## Ownership

`packages/database` is the only owner of schema, migrations, raw SQL, foreign
keys, and the migration ledger. Other packages consume typed database APIs.
Markdown remains the source of truth for Knowledge content, and Git remains
the long-term recovery mechanism.

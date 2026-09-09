# LoongBoard Agent Instructions

## Read order

Before changing code:

1. Read `docs/README.md` and `docs/requirements.md`.
2. Read `docs/architecture.md` and the relevant module chapter.
3. Read the nearest `AGENTS.md`.
4. Read the target package README.
5. Use `docs/testing.md` for checks; historical acceptance is in `docs/validation-history.md`.

## Product boundary

This is a local-first, single-user application.

V1 owns:

- GitHub PR/Issue activity lists;
- deterministic PR domain labels from changed file paths;
- local-Git PR diff/full-file reading;
- DSH-backed general Agent chat;
- Markdown/Git knowledge repository;
- scheduled prompts sent to Agent.

Do not add features listed as V1 non-goals in `docs/requirements.md`.

## Architecture invariants

- Only `packages/agent-runtime-dsh/**` may import `@deepseek-ai/*`.
- Only `packages/github/**` may execute `gh`.
- Git workspace commands belong in `packages/git-workspace/**`.
- Raw SQL belongs in `packages/database/**`.
- Web and Server share schemas from `packages/contracts/**`.
- Product code must not expose raw DSH SessionEvent types.
- GitHub list pages read SQLite only; they do not call GitHub during HTTP reads.
- PR domains are derived only from changed file paths and user-defined rules.
- Knowledge Markdown files are the source of truth; SQLite is an index.
- Worktrees are disposable cache; Agent Sessions are persistent user state.
- One workspace path may run only one Agent turn at a time.

## Defensive programming policy

Validate once at external boundaries:

- config parsing;
- HTTP input;
- GitHub provider JSON;
- DSH notifications;
- database constraints.

Inside typed modules, trust established invariants.

Do not:

- repeat the same null/type/path check at multiple layers;
- catch and ignore errors;
- return empty data on command failure;
- add fallback chains without a confirmed requirement;
- create compatibility shims before an actual upstream break;
- introduce generic DI containers, repository base classes, or Result wrappers everywhere;
- keep parallel old and new implementations;
- add speculative feature flags.

Fail fast with an error that includes the operation and relevant repository/session id.

## Testing

Every behavioral change must include the smallest useful test:

- pure logic: unit/property test;
- command adapter and API boundary: an in-process unit test with injected dependencies when possible;
- user-visible behavior: a focused component unit test.

Do not write tests for trivial getters solely to increase coverage.
Do not recreate broad stage suites or fixture-heavy E2E coverage. The normal
development loop is UT-only:

```bash
pnpm test:ut
```

The small `tests/regression` suite is reserved for major cross-module changes
or an explicit user request. It is not part of `pnpm test` or `pnpm check`.
Run it directly, or through the full gate, only in those cases:

```bash
pnpm test:regression
pnpm check:full
```

Before ordinary completion run `pnpm check`. Browser or live-provider smoke is
manual acceptance, not a routine automated test.

## Task completion report

Report:

- files and behavior changed;
- tests run and results;
- explicit remaining limitations;
- commit SHA.

Do not claim completion while checks are failing.

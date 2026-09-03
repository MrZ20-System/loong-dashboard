# Implementation Status

The sole execution baseline is `../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md`
in the parent system workspace. This repository is a greenfield implementation
and does not copy the rejected legacy dashboard architecture.

## Current stage

Stage 3: PR Diff Workspace — completed and accepted locally on 2026-09-03.
Stage 4 (DSH Agent Chat) is next and was not started.

## Done

- Stage 3 was completed locally on 2026-09-03 (plan sections 11, 17.2, 18.2).
- Added the `@loongboard/git-workspace` package owning all local Git process
  execution: `preparePull` guarantees the PR head commit and the base ref
  exist with one serialized fetch per repository, `listChangedFiles` merges
  `--name-status`/`--numstat` with rename detection, and `readFile` returns
  byte-exact content with the two V1 degradation branches (binary, too
  large). Execa `stripFinalNewline` is disabled so `git show` output is not
  trimmed.
- Added PR detail and diff endpoints: `GET /pulls/:number`,
  `POST /pulls/:number/prepare`, `GET /pulls/:number/file?path=&ref=`, and
  `GET /pulls/:number/local-command`. File queries validate repository-safe
  paths and full 40-hex refs; missing files map to `FILE_NOT_FOUND` (404).
  No GitHub patch is ever used; prepare performs at most one fetch.
- Added a stored PR detail read model (`getPullRequestDetail`) exposing base
  ref, head SHA/ref, timestamps, and body for the diff header.
- Added the PR detail page at `/repositories/:id/pulls/:number`: changed-file
  tree with A/M/D/R badges, one shared Monaco diff editor (lazy-loaded local
  bundle, no CDN), Changes/Full File mode toggle, binary and too-large
  notices, fetched-object hint, and a copy-local-command button. PR list
  rows link to the detail page.
- Deferred browser-level diff E2E to Stage 7 release acceptance; Stage 1
  browser acceptance and unit/integration coverage keep passing.
- Stage 2 was accepted locally on 2026-09-03, following the frozen decisions
  in `docs/stage-2-tasks.md` (D1-D8).
- Added the changed-file enrichment pipeline: GraphQL `nodes(ids:)` batches of
  20 with `files(first: 100)`, REST pagination fallback, 3000-file truncation
  marker, at most 2 concurrent batches, and skip when the metadata stream
  reports `rateLimitRemaining` below 200. Enrichment failure never fails the
  metadata stream; affected PRs retry on the next sync.
- Added deterministic classification: picomatch include/exclude semantics
  with `dot: true`, one matching file attaches the domain, multiple domains
  per PR, no AI, `classificationKey` short-circuit so unchanged rule sets and
  unchanged head files never recompute.
- Added Domain rule CRUD (`GET/POST/PUT/DELETE
  /api/repositories/:id/domains`) with server-assigned palette colors and
  positions, `dom_<random>` ids, and 404/409 error envelopes. Mutations
  trigger a serial in-process reclassification task per repository with a
  dirty flag; reclassification never calls GitHub and exposes
  `{ running, pendingCount }` through the domains GET response.
- Added PR list domain filtering via repeated `?domain=` params with ANY
  semantics, `domains` chips on list rows loaded by one batched IN query, and
  the stored current-head files endpoint
  `GET /api/repositories/:id/pulls/:number/files`.
- Added the Web UI: domain chips on PR rows, a multi-select domain filter
  stored in the URL as repeated `domain` params, the `/settings/domains`
  management page (repository selector, rule list, create/edit/delete form,
  reclassification indicator polled while running), and the 重新分类中 hint.
- Corrected migration 004 to apply only the additive
  `pull_requests.files_truncated` column; the Stage 0 tables and indexes were
  already created by 001 with frozen shapes.
- Tightened the `raw-sql` architecture rule to require SQL statement
  structure (`DELETE FROM`, `INSERT INTO`, ...) so quoted HTTP method strings
  and UI copy no longer produce false positives.
- Stage 0 was accepted locally on 2026-09-03 in commit `e075dc4`.
- Stage 1 froze its API, persistence, GitHub command, timezone, cursor,
  ownership, and failure-semantics decisions in `docs/stage-1-tasks.md`, and
  delivered the GitHub GraphQL provider, SQLite migrations and
  reconciliation, persisted list reads, per-stream watermarks, metadata
  routes, synchronization coordinator, repository-scoped PR/Issue pages, and
  deterministic fixtures. List pages stay SQLite-only; GitHub is contacted
  only by the explicit sync action.

## Validated

- `CI=true pnpm check` passed on 2026-09-03 after Stage 3: lint, all
  workspace type checks, architecture boundaries, the exact DSH pin, 145
  substantive tests across Server 35, Web 30, contracts 24, git-workspace 5,
  database 21, GitHub provider 16, architecture 11, and acceptance fixtures
  3, plus all production builds (including the lazy-loaded Monaco bundle).
- Stage 3 Git behaviors are covered by a real fixture repository: the first
  prepare fetches missing PR objects exactly once, an unchanged head never
  refetches, merge-base and changed files match, renames/binary/added/removed
  entries carry correct stats, `git show` content is byte-exact, unsafe
  paths are rejected, and files over the 5 MB limit degrade to a notice.
- Server route coverage proves the diff endpoints use the stored PR and
  repository config, validate refs/paths at the edge, and map missing files
  and PRs to 404 envelopes.
- Web coverage renders the PR detail header, changed-file tree, default
  first-file diff, Changes/Full File toggle, and binary-file notice with the
  Monaco component isolated behind a mock in jsdom tests.
- Stage 2 acceptance behaviors are covered: a PR touching `.github/**` hits
  the CI rule, one PR can carry multiple domains, rule mutations never call
  GitHub, and an unchanged `head_sha` never re-fetches files.
- The deterministic browser command passed 1/1 scenario with 12 fake `gh`
  calls using system Chrome through `LOONGBOARD_E2E_BROWSER_PATH`.
- The browser scenario verifies that list reads remain local until explicit
  synchronization, both metadata streams refresh independently, and failed
  rows remain visible from SQLite.

## Deferred validation and known limitations

- The two-repository real GitHub smoke is deferred by explicit user direction.
  Attempts reached `vllm-project/vllm` but GitHub CLI GraphQL requests failed
  with `Post "https://api.github.com/graphql": EOF`. This is not positive smoke
  evidence and no claim is made that real synchronization passed.
- Browser-level PR diff E2E is deferred to the Stage 7 release acceptance.
  Unit and integration coverage (real Git fixture + route tests + web
  component tests) covers the diff workspace in the meantime.
- The monaco-editor bundle is loaded lazily only on the PR detail page; the
  main web bundle stays independent of it.
- The repository supports Node.js 24 through 26. The local Node.js 26 runtime
  requires exact `better-sqlite3@12.11.1`; this changes no database ownership or
  API contract.
- Node.js 26 prints a `tsx` deprecation warning for `module.register()` during
  development and acceptance startup. It does not affect the validated paths.
- DSH remains pinned and isolated but is not started before Stage 4. Live DSH
  lifecycle validation belongs to Stage 4.

## Next stage

Stage 4: DSH Agent Chat. The deferred real GitHub smoke and browser-level
diff E2E must not be represented as completed evidence in later stage
reports.

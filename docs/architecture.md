# LoongBoard Architecture

## Runtime shape

The browser calls one local Node server over REST and SSE. The server connects
to SQLite, GitHub through the GitHub provider, local repositories through the
Git workspace boundary, Markdown through the Knowledge service, and DSH via
isolated child processes.

```text
Browser -> Local Server -> { contracts, SQLite, GitHub provider,
                             Git workspace, Knowledge, Scheduler,
                             DSH adapter }
```

## Dependency direction

- Web and Server consume schemas from `packages/contracts`.
- Product code consumes a LoongBoard-owned `AgentRuntime` contract.
- Only `packages/agent-runtime-dsh` knows DSH SDK types and notifications.
- GitHub list reads use SQLite and never invoke GitHub during HTTP reads.
- Domain labels are calculated from changed paths and user rules; AI is not a
  classifier.

## Validation and failures

Validate configuration, HTTP input, external command output, DSH notifications,
and database constraints at their boundaries. Internal typed modules trust the
established invariant. Errors include the operation and relevant repository or
session identifier; command failures are not converted into empty results.

## Stage 0

Stage 0 establishes the workspace, package boundaries, shared health contract,
architecture checks, core database schema/migrations, the Fastify health route,
the minimal React shell, package scaffolds, and the exact DSH pin. It does not
implement product CRUD, GitHub synchronization, business routes or pages, or
DSH lifecycle behavior.

## Stage 1

Stage 1 adds one explicit metadata write path from the Server through
`GhGitHubMetadataProvider` into SQLite. Repository, PR, Issue, activity-day, and
sync-status GET routes read SQLite only. The Web consumes those routes, and an
explicit user sync starts independent PR and Issue streams. GitHub response
types are validated once in `packages/github`; they do not leak into the
database, Server, or Web layers.

## Stages 2-6

Stage 2 derives deterministic PR domain labels from changed file paths and
user rules (`domain_rules`, `pull_request_domains`) and reclassifies in
process without GitHub calls. Stage 3 reads local Git only through
`packages/git-workspace` (fetch-once prepare, merge-base diffs, byte-exact
file reads). Stage 4 adds Agent chat: product code depends on the
vendor-neutral `AgentRuntime` contract in `packages/agent-runtime`, while
`packages/agent-runtime-dsh` is the only package allowed to import
`@deepseek-ai/*`; one DSH subprocess per session runs in an isolated
`dsh-home`, worktrees are disposable caches, and messages persist as
normalized rows in SQLite. Stage 5 makes the Knowledge Markdown directory the
source of truth with SQLite only an index (`loongboard_id` front matter,
full-content history capped at 10 versions, default document chat). Stage 6
adds a single-timer scheduler that starts fresh Agent Sessions per run with a
workspace mutex.

# LoongBoard

LoongBoard is a local-first, single-user engineering workspace. The V1
implementation follows `../LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md` as its
only execution baseline.

The repository is a pnpm workspace containing the browser shell, local server,
shared HTTP contracts, and focused domain packages. Stage 0 establishes the
toolchain and package boundaries; product behavior is added only after the
Team Lead accepts that foundation.

## Commands

```bash
pnpm install
pnpm test
pnpm check
pnpm dev
```

`pnpm test` runs UT only. `pnpm test:regression` is a separate, small critical
flow suite for major changes or explicit requests.

The `/api/health` endpoint is the first frozen HTTP contract. Its response is
owned by `packages/contracts` and is `{ "status": "ok" }`.

## Boundaries

- Only `packages/agent-runtime-dsh/**` may import `@deepseek-ai/*`.
- Raw SQL belongs only in `packages/database/**`.
- GitHub CLI calls belong only in `packages/github/**`.
- Git commands belong in `packages/git-workspace/**` and the Knowledge Git
  service.
- Web and Server consume schemas from `packages/contracts/**`.

See `ARCHITECTURE.md` and `docs/` for the frozen design and maintenance rules.

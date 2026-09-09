# Testing

LoongBoard uses a unit-first test model. Normal development runs only fast,
local tests with injected process/network boundaries:

```bash
pnpm test
pnpm test:ut
pnpm check
```

`pnpm test` is an alias for `pnpm test:ut`. The unit runner executes each
workspace package's local suite plus the architecture checker tests. `pnpm
check` adds lint, type checks, architecture/DSH pin checks, and production
builds; it does not run regression tests or browser automation.

## Critical regression suite

`tests/regression` is intentionally small and independent of the removed
historical stage/E2E fixtures. It currently protects only three high-impact
contracts:

- concurrent stale Issue reads share one GitHub refresh;
- an external Knowledge edit is indexed and versioned;
- a dirty bound worktree is never recycled.

Run it only for a major cross-module change or when explicitly requested:

```bash
pnpm test:regression
pnpm check:full
```

`pnpm check:full` is `pnpm check` followed by `pnpm test:regression`.

## Manual acceptance

Browser interaction, live GitHub access, and live DSH sessions are manual
acceptance. Start the local application with `pnpm dev`, exercise the changed
flow, and report exactly what was checked. A static or unit pass does not prove
live credentials, remote API behavior, or browser layout.

Add the smallest test at the nearest stable business boundary. Prefer pure
functions and injected dependencies. Do not recreate broad stage suites,
recording fixtures, or a second implementation solely for tests.

## 修改工作流

1. 从 [说明书索引](README.md) 定位模块，再读最近的 AGENTS.md 和 package README。
2. 修改 API 先对齐 contracts；修改数据库添加迁移；保持业务逻辑在现有模块边界。
3. 行为变化补最小有价值 UT，更新相关说明书。纯文档变化检查链接、旧引用和实际源码一致性。
4. 顺序运行需要的门禁；最终按根 AGENTS.md 执行 `pnpm check`。不要并发启动多套最终检查。
5. 报告实际修改、检查结果、未验证范围；有提交才报告提交 SHA。

源码入口：[workspace test runner](../scripts/run-workspace-tests.mjs)、[architecture checker](../scripts/check-architecture.mjs)、[DSH pin checker](../scripts/check-dsh-pin.mjs)。宏观回归需明确触发原因，文档整理不新增业务测试。

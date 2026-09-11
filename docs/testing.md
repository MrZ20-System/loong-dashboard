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

## Server application builders

The production HTTP factory is `buildProductionApp`. Its
`BuildProductionAppDependencies` requires every product capability, and the
production runtime supplies the complete set explicitly, including the real
`LocalGitWorkspace`. The old `buildApp` entry point no longer exists.

`buildTestApp` is a separate lightweight builder used only by focused tests in
this repository, imported directly from `src/app`. It is not a package public
API; the Server package index exposes only `buildProductionApp`. Optional
capabilities and fallback services are scoped to the focused-test builder only;
they are not production capability-presence branches.
`SyncCoordinator` fakes use the complete interface, including required
history and pull-request operations, so route tests exercise the same HTTP
paths and schemas without changing them.

## 本次关键验证层

新增或调整的行为应在最近边界保留轻量测试：

- History admission、cursor continuation、`resume_after` 和 foreground 优先级在 Server coordinator tests 中验证；provider `resetAt`、真实 GitHub 分页和 quota 需要 live GitHub 环境。
- metadata archive/restore、reopen auto-unarchive、payload prune marker、Merged projection、maintenance run 和 sync-run purge 在 database/service tests 中验证；SQLite 文件大小、free pages、快照恢复和实际 `VACUUM` 效果需要独立运维验证。
- `title_source` 的 provisional/generated/manual ownership、首轮成功后的 native title、scheduled run 独立会话、delete 精确 `dsh-home` 在 runtime/Server tests 中验证；真实 DSH title RPC、模型推理、provider secrets 和工具调用需要固定版本 DSH 与凭证环境。
- 当前 HTTP boundary 由 health/auth/sync-history/issue-detail 12 tests、runtime construction/projection 2 tests 和 backend-critical regression 2 tests 轻量覆盖；这些测试验证 production/test builder 分界、required SyncCoordinator route 调用及未改变的 HTTP path/schema。它们不等同于全量 `pnpm check`、真实 UI、Docker 或 live provider/DSH 验收。
- password lock 的 auth file 权限、scrypt/HMAC cookie、authVersion 失效、backoff、reset 和 API gate 在 Server tests 中验证；密码锁不加密数据，真实浏览器 cookie/HTTPS 属性仍需部署环境确认。
- retention Settings、Archive/All 过滤、Security 页面和标题重命名在 Web component tests 中验证；布局、路由跳转、cookie 续期和交互可用性必须通过真实 browser acceptance。

## Manual acceptance

Browser interaction, live GitHub access, and live DSH sessions are manual
acceptance. Start the local application with `pnpm dev`, exercise the changed
flow, and report exactly what was checked. A static or unit pass does not prove
live credentials, remote API behavior, or browser layout.

Production static serving and native `pnpm start` can be smoke-tested locally;
Docker build, restart persistence and bind-mount restore require a host with
Docker/Compose. Do not claim those paths passed when the runtime is absent.
On macOS, run the final cross-package checks serially: parallel Vitest/watch
processes can hit `EMFILE` even when assertions themselves pass.

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

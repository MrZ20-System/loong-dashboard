# LoongBoard

本地优先、单用户的工程工作台：GitHub PR/Issue 活动、本地 Git diff、DSH Agent 对话、Markdown 知识库与定时任务。

Settings 集中管理仓库、GitHub 凭证、Agent、Knowledge checkpoint、Domain 和计划任务。仓库首次同步可选最近 7/30 天（默认 30 天），覆盖全部 PR/Issue 状态；后续沿用成功水位增量同步。Agent 页面、业务上下文与全局浮窗共享持久会话。

**[仓库说明书](docs/README.md)** 是人和 Agent 的统一入口，按架构、前端、API、数据库、GitHub、Git、Agent、Knowledge、调度及运行测试分章。修改代码前阅读 [AGENTS.md](AGENTS.md) 和目标模块的就近指引。

## 开始使用

配置和依赖要求见 [运行说明](docs/operations.md)。在应用仓库根目录执行：

```bash
pnpm install
pnpm dev
```

`pnpm test` 为 UT；`pnpm check` 包含 lint、类型检查、架构/DSH pin、UT 和构建。关键回归另用 `pnpm test:regression`，仅用于重大改动或明确要求，见 [测试说明](docs/testing.md)。

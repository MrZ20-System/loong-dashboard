# 文档维护规则

## 当前规则

`docs/README.md` 为统一说明书入口，章节按实现模块维护。根 README 提供安装、启动和备份入口；根 `ARCHITECTURE.md` 只指向完整架构章节；package README 说明本包职责和入口并链接章节；AGENTS.md 保存执行约束。不要再维护一份平行总方案作为现状依据。

新增/改变能力时更新模块章节；改变架构决策时更新 ADR 状态并说明原因。历史测试只能记录日期和当时结果，不冒充当前验收。执行任务完成后把稳定行为整合到模块说明；临时执行记录不作为现状依据。

## 说明边界

当前说明书不把平行执行方案、任务清单、状态记录或 AGENTS 模板副本作为现状依据。实现行为以模块章节为准，设计原因以 ADR 为准，验收证据以 [历史验收记录](validation-history.md) 为准；已移除的说明可从各自仓库 Git 历史恢复，不另建一套过时正文归档。

## 已校正的文档偏差

- GitHub 传输已是 HTTP fetch，gh 仅为可选凭证入口；ADR 0002 明确标记原决策被替代。
- Scheduler 实际为每任务 timer map，并非旧设计中的单 timer/min-heap。
- Knowledge checkpoint 已接入可选配置，默认关闭，Git 执行在 git-workspace 包。
- PR 会话可同时携带 PR number 与 target SHA；不是所有目标字段互斥。
- 文档版本数由 historyLimit 控制，示例值为 10，当前行为见 [Knowledge](knowledge.md)。
- 过时的空包描述及阻止后续功能的 scoped AGENTS 约束已移除。

当前源码注释不依赖旧执行记录；迁移原因与架构决策只保留在 migration、ADR 和 validation history。

当前验收不复用旧文档整理阶段的测试结论；最新结果见 [历史验收记录](validation-history.md)。

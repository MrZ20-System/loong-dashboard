# 文档维护与旧方案清理

## 当前规则

`docs/README.md` 为统一说明书入口，章节按实现模块维护。根 README 与 ARCHITECTURE 仅导航；package README 说明本包职责和入口并链接章节；AGENTS.md 保存执行约束。不要再维护一份平行总方案作为现状依据。

新增/改变能力时更新模块章节；改变架构决策时更新 ADR 状态并说明原因。历史测试只能记录日期和当时结果，不冒充当前验收。较长的未来计划完成后把稳定行为整合到模块说明，再从工作树移除任务书。

## 2026-09-09 说明书整理记录（功能改造前）

本次以应用仓库 `ef71412` 与 system-home `859fd4b` 的实际代码/目录为依据，仅整理文档与 Agent 阅读指引。

| 移除的旧文件 | 原因与替代入口 |
| --- | --- |
| system-home 根 LOONGBOARD_V1_TECHNICAL_DEVELOPMENT_PLAN.md | 初始 V1 分阶段执行方案；当前行为归入各模块说明 |
| system-home 根 LoongBoard_V1_MultiAgent_Technical_Development_Plan.md | 平行旧方案与阶段/角色分工已不适用 |
| system-home 根 LOONGBOARD_ROOT_AGENTS.md | AGENTS 模板副本过时；使用应用仓库实际 AGENTS.md |
| docs/stage-0-tasks.md、stage-1-tasks.md、stage-2-tasks.md | 已实现阶段的执行任务与旧阻塞规则 |
| docs/implementation-status.md | 阶段交付清单与现状描述混杂；模块能力迁入说明书，验收迁入 validation-history.md |

旧内容仍可通过各自仓库 Git 历史恢复，不另建一套过时正文归档。有效 ADR 和 design-qa 证据保留。knowledge 及第三方源码仓库不属于本次清理范围。

## 已校正的文档偏差

- GitHub 传输已是 HTTP fetch，gh 仅为可选凭证入口；ADR 0002 明确标记原决策被替代。
- Scheduler 实际为每任务 timer map，并非旧设计中的单 timer/min-heap。
- Knowledge checkpoint 已接入可选配置，默认关闭，Git 执行在 git-workspace 包。
- PR 会话可同时携带 PR number 与 target SHA；不是所有目标字段互斥。
- 文档版本数由 historyLimit 控制，示例值为 10，当前行为见 [Knowledge](knowledge.md)。
- 阶段 0/1 的空包描述及阻止后续功能的 scoped AGENTS 约束已移除。

少量源码注释仍以 `plan 12.x` 等标记历史设计出处；这是历史注释，可在后续修改相应代码时改成行为说明，不作为当前执行规则。

## 说明书整理验证（功能改造前）

2026-09-09：191 个本地 Markdown 链接目标检查通过，两个仓库 `git diff --check` 通过；应用 `pnpm check` 通过（287 项测试，含架构 checker 测试；全部生产构建）。出现非阻塞的 React act、localStorage 实验提示和 Vite chunk 大小警告。本次只改文档及 Agent 指引，未执行真实 GitHub/DSH/browser 验收或关键回归，未创建提交。

同日后续 Settings、Agent、调度和首次同步改造的验收见 [历史验收记录](validation-history.md)，不沿用上述文档整理阶段的测试结论。

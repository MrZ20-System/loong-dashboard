# LoongBoard 仓库说明书

本目录是当前实现的统一阅读入口，面向维护者和 Agent。2026-09-09 随 Settings、原生 DSH 会话和同步行为改造更新；功能修改时同步更新对应章节，历史验收单独记录。本文档描述已实现行为，不再按开发阶段组织。

## 快速阅读

首次进入仓库：先读 [产品范围](requirements.md) 和 [架构与代码地图](architecture.md)，再读目标模块。准备运行时读 [配置与运行](operations.md)；准备修改时读 [开发与验收](testing.md) 和最近的 `AGENTS.md`。

| 板块 | 内容 |
| --- | --- |
| [产品范围](requirements.md) | 已有能力、事实来源、产品边界 |
| [架构与代码地图](architecture.md) | 技术栈、模块职责、启动与关闭、修改定位 |
| [前端](frontend.md) | 页面路由、Query、PR 工作台、Markdown 和编辑器 |
| [HTTP 与事件](api.md) | 路由分组、共享 schema、SSE、错误边界 |
| [数据模型](data-model.md) | 表与服务归属、迁移、持久状态和缓存 |
| [数据生命周期](data-model.md#数据生命周期) | 归档、payload 清理、恢复和 runtime history 保留边界 |
| [GitHub 同步与分类](github-sync.md) | HTTP provider、水位、文件补全、Issue 详情、Domain |
| [Git 与 PR 工作区](git-workspace.md) | prepare、diff、文件读取、slot 复用与安全约束 |
| [Agent 与 DSH](dsh-integration.md) | 会话、子进程、事件、取消与 workspace 互斥 |
| [Knowledge](knowledge.md) | Markdown 身份、版本、watcher、Git checkpoint |
| [调度器](scheduler.md) | cron、timer、运行记录、忙碌与重启语义 |
| [配置与运行](operations.md) | 安装、配置位置、GitHub 凭证、启动、备份和排错 |
| [部署](deployment.md) | Native production、Docker Compose、静态托管、监听和升级 |
| [Backup and Restore](backup-restore.md) | data root、SQLite、Knowledge、Agent session 和恢复边界 |
| [安全与密码锁](operations.md#本地密码锁) | 可选本地锁、会话 cookie、reset 和恢复边界 |
| [开发与验收](testing.md) | 改动顺序、测试分层、手工验收 |
| [文档维护规则](maintenance.md) | 文档 authority、更新和历史验收边界 |
| [历史验收记录](validation-history.md) | 过去的检查及其适用边界 |

## 架构决策

保留 ADR 解释设计原因：[本地单用户](adr/0001-local-first-single-user.md)、[GitHub 传输边界](adr/0002-use-gh-graphql-for-metadata.md)、[本地 Git 内容](adr/0003-use-local-git-for-pr-content.md)、[外部 DSH](adr/0004-dsh-is-an-external-runtime.md)、[Markdown/Git 知识源](adr/0005-markdown-and-git-are-knowledge-source-of-truth.md)、[权限边界](adr/0006-no-product-level-agent-permission-system.md)、[边界校验](adr/0007-avoid-excessive-defensive-programming.md)。

目录中的源码链接均相对应用仓库；各模块章节共同构成完整的当前实现说明。

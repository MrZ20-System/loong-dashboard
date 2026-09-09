# 数据模型与持久化

数据库位置为 `runtime.statePath/loongboard.sqlite3`。[migration-runner.ts](../packages/database/src/migration-runner.ts) 使用 better-sqlite3 开启外键，以有序事务执行迁移，并在 `schema_migrations` 记录已应用 id；[schema.ts](../packages/database/src/schema.ts) 是 Drizzle 类型化 schema。

## 实体与服务

| 表 | 职责 | 服务源码 |
| --- | --- | --- |
| repositories | 配置仓库的 SQLite 投影，key 为稳定 id，移除配置后禁用并保留历史 | [repository-service](../packages/database/src/repository-service.ts) |
| repository_sync_state | PR/Issue 分流状态、水位和错误 | [sync-service](../packages/database/src/sync-service.ts) |
| pull_requests / pull_request_files | PR 元数据、按 head SHA 存储的变更路径 | [metadata-service](../packages/database/src/metadata-service.ts)、[classification-service](../packages/database/src/classification-service.ts) |
| domain_rules / pull_request_domains | 路径规则和确定性标签关联 | [domain-service](../packages/database/src/domain-service.ts) |
| issues / issue_comments | Issue 元数据、懒加载正文与评论缓存 | [metadata-service](../packages/database/src/metadata-service.ts) |
| agent_sessions / agent_messages | scope、workspace、runtime id、状态、标准化消息 | [agent-service](../packages/database/src/agent-service.ts) |
| worktree_slots | PR affinity、目标 SHA、最近使用时间 | [worktree-slot-service](../packages/database/src/worktree-slot-service.ts) |
| knowledge_documents / document_versions | 文档身份/路径/hash/默认会话、完整内容短期版本 | [knowledge-service](../packages/database/src/knowledge-service.ts) |
| scheduled_tasks / scheduled_task_runs | cron/prompt/模型/workspace、下次执行及结果；system task 的 action 使用 `repository.sync`、`knowledge.checkpoint`、`knowledge.push` | [scheduler-service](../packages/database/src/scheduler-service.ts) |

PR/Issue 的 number 需要与 repository id 组合定位，不能当作全局 id。PR Agent 会话可同时记录 PR number 与 target SHA；具体 scope 约束由 schema 和 contracts 定义，不可误读为所有目标字段只能选一个。

## 当前迁移序列

[migrations](../packages/database/src/migrations) 中依次包含：001 初始模型、002 列表索引、003 Issue 状态约束、004 Domain 分类、005 Issue 详情缓存、006 Agent 来源元数据与统一 Scheduler 字段。新增 schema 变化应添加新迁移，并同步 Drizzle 声明及 typed service，不修改旧迁移来“升级”已有数据库。

Domain 的用户源文件位于 system workspace 的 `domains/<repository-key>.json`，由 [DomainFileService](../apps/server/src/domain-file.ts) 负责安全路径、机械校验、pretty format 和外部编辑吸收；`domain_rules` 与 `pull_request_domains` 只是分类查询投影。文件解析失败时源文本仍可读，最近一次有效投影继续提供分类，修复后再投影并触发重分类。文件版本的内容和 hash 保存在 `runtime.statePath/domain-file-versions/`，它是短期恢复记录，不替代 JSON 源文件或 Git。

控制中心非秘密值保存在 system workspace 的 `settings.json`，更新时保留同一文件中的未知字段；GitHub token 和 Agent provider secret 位于 `runtime.statePath` 下的私有文件（0600），不进入数据库、设置响应或版本记录。

## 恢复与数据边界

启动打开数据库时恢复中断同步；每个 repository 的 PR/Issue stream 只有整条流成功才推进 `watermark_updated_at`，恢复会保留已有 rows 和成功水位。Server 恢复中断会话；Scheduler 恢复未完成 run 为失败。恢复逻辑不等于重放远端操作或补跑所有错过的任务。

Knowledge 正文以 Markdown 为源，SQLite 的版本记录和聊天历史却是持久状态，不能通过重新扫描 Markdown 全部恢复。Domain JSON 同样以文件为源，SQLite 仅保留 rendered/classifier projection。Git worktree 实际 HEAD/cleanliness 以 Git 检查为准，数据库 slot 行仅用于 affinity/LRU 选择。备份要同时覆盖知识 Git、数据库、会话目录、system workspace 配置和需要恢复的 Domain 文件版本目录，见 [运行说明](operations.md)。

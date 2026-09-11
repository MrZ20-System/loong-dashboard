# 数据模型与持久化

数据库位置为 `runtime.statePath/loongboard.sqlite3`。[migration-runner.ts](../packages/database/src/migration-runner.ts) 使用 better-sqlite3 开启外键，以有序事务执行迁移，并在 `schema_migrations` 记录已应用 id；[schema.ts](../packages/database/src/schema.ts) 是 Drizzle 类型化 schema。

## 实体与服务

| 表 | 职责 | 服务源码 |
| --- | --- | --- |
| repositories | 配置仓库的 SQLite 投影，key 为稳定 id，移除配置后禁用并保留历史 | [repository-service](../packages/database/src/repository-service.ts) |
| repository_sync_state | PR/Issue 分流状态、水位和错误 | [sync-service](../packages/database/src/sync-service.ts) |
| repository_sync_runs / repository_sync_run_streams / repository_sync_run_targets | 持久 sync run、实体流进度、forward / fetch_pr 当轮 enrichment 目标和错误/水位前后值 | [sync-service](../packages/database/src/sync-service.ts) |
| repository_history_state | 每实体 history cursor、更新时间恢复 anchor、目标日期、最老覆盖边界和运行状态 | [sync-service](../packages/database/src/sync-service.ts) |
| pull_requests / pull_request_files | PR 当前元数据、按 head SHA 存储的变更路径；Merged 直接查询 `pull_requests.merged_at`，不复制数据 | [metadata-service](../packages/database/src/metadata-service.ts)、[classification-service](../packages/database/src/classification-service.ts) |
| domain_rules / pull_request_domains | 路径规则和确定性标签关联 | [domain-service](../packages/database/src/domain-service.ts) |
| issues / issue_comments | Issue 元数据、懒加载正文与评论缓存 | [metadata-service](../packages/database/src/metadata-service.ts) |
| agent_sessions / agent_messages | scope、workspace、runtime id、状态、标准化消息；Archive projection 只读取 allowlist 字段 | [agent-service](../packages/database/src/agent-service.ts)、[agent-archive-service](../packages/database/src/agent-archive-service.ts) |
| worktree_slots | PR affinity、目标 SHA、最近使用时间；物理 slot 删除后的缓存元数据清理 | [worktree-slot-service](../packages/database/src/worktree-slot-service.ts) |
| knowledge_documents / document_versions | 文档身份/路径/hash/默认会话、完整内容短期版本 | [knowledge-service](../packages/database/src/knowledge-service.ts) |
| scheduled_tasks / scheduled_task_runs | cron/prompt/模型/workspace、下次执行及结果；system task 的 action 使用 `repository.sync`、`knowledge.checkpoint`、`knowledge.push`、`git.checkpoint`、`git.push`、`agent.archive.checkpoint`、`agent.archive.push` | [scheduler-service](../packages/database/src/scheduler-service.ts) |

PR/Issue 的 number 需要与 repository id 组合定位，不能当作全局 id。PR Agent 会话可同时记录 PR number 与 target SHA；具体 scope 约束由 schema 和 contracts 定义，不可误读为所有目标字段只能选一个。

Repository summary 的 list/get projection 同时返回本地 `pullRequestCount`、`mergedPullRequestCount`（`merged_at IS NOT NULL`）和 `issueCount`，供导航和侧边栏展示；这些计数来自 SQLite 投影，不触发 GitHub 请求。

## 当前迁移序列

[migrations](../packages/database/src/migrations) 中依次包含：001 初始模型、002 列表索引、003 Issue 状态约束、004 Domain 分类、005 Issue 详情缓存、006 Agent 来源元数据与统一 Scheduler 字段、007 持久 repository sync/history、008 曾引入的 PR Daily/lifecycle 数据、009 PR 查询模式索引、010 删除已废弃的 Daily/lifecycle/逐日 coverage 并加入 Merged partial index。007–009 可能已经存在于用户数据库，因此保留为升级历史；当前 schema 从 010 起不再包含 Daily 体系。新增 schema 变化必须添加新迁移，并同步 Drizzle 声明及 typed service，不能改写已执行迁移。

Domain 的用户源文件位于 system workspace 的 `domains/<repository-key>.json`，由 [DomainFileService](../apps/server/src/domain-file.ts) 负责安全路径、机械校验、pretty format 和外部编辑吸收；`domain_rules` 与 `pull_request_domains` 只是分类查询投影。文件解析失败时源文本仍可读，最近一次有效投影继续提供分类，修复后再投影并触发重分类。文件版本的内容和 hash 保存在 `runtime.statePath/domain-file-versions/`，它是短期恢复记录，不替代 JSON 源文件或 Git。

控制中心非秘密值保存在 system workspace 的 `settings.json`，更新时保留同一文件中的未知字段；GitHub token 和 Agent provider secret 位于 `runtime.statePath` 下的私有文件（0600），不进入数据库、设置响应或版本记录。

## 恢复与数据边界

启动打开数据库时恢复中断同步；每个 repository 的 PR/Issue stream 只有整条 forward 流成功才推进 `watermark_updated_at`，恢复会保留已有 rows 和成功水位。History 每页先持久化 cursor/anchor，单 run 页预算耗尽后以 `partial` 结束；启用状态下由下一次 bounded continuation 从保存位置新建 run 继续，pause、rate-limit floor 或失败会停止 admission。持久化的 running history 会阻止同仓库重复 admission。`forward` 拥有普通 metadata watermark，`history` 拥有 cursor/anchor/target/oldest boundary，`fetch_pr` 只拥有目标 PR fetch/enrichment；三者不互相推进对方 watermark。

PR 与 Merged 查询使用 page-based pagination：请求带 `page`（正整数）和 `limit`（1–100，服务默认 100），响应返回 `page`、`pageSize`、过滤后的 `totalCount` 和 `totalPages`。PR 的 `updated` 排序为 `updated_at DESC, number DESC`，`number` 排序为 `number DESC`；Merged 为 `merged_at DESC, number DESC` 且只包含 `merged_at IS NOT NULL`。日期、状态、搜索和 Domain 条件同时作用于 PR 的列表与 COUNT；Merged 的搜索和 Domain 条件同时作用于列表与 COUNT。Issue 仍使用 cursor pagination。Merged 的 partial index 只包含 `merged_at IS NOT NULL` 的 PR，避免对未合入数据扩大索引。

Knowledge 正文以 Markdown 为源，SQLite 的版本记录和聊天历史却是持久状态，不能通过重新扫描 Markdown 全部恢复。Domain JSON 同样以文件为源，SQLite 仅保留 rendered/classifier projection。Git worktree 实际 HEAD/cleanliness 以 Git 检查为准，数据库 slot 行仅用于 affinity/LRU 选择。备份要同时覆盖知识 Git、数据库、会话目录、system workspace 配置和需要恢复的 Domain 文件版本目录，见 [运行说明](operations.md)。

Worktree slot 行不承载 live ownership：`busy_session_id` 是兼容保留字段，维护和分配使用运行中 `agent_sessions.workspace_path` 与 `WorkspaceRunCoordinator` 的路径集合。Janitor 成功删除物理 worktree 后删除精确 repository/slot/path 行；busy、dirty 或 Git status 失败的 slot 不删除，缩容中的高编号 slot 以维护结果的 `pendingRetirement` 暂存。

Agent Archive 不新增 SQLite source-of-truth 表。`listAgentArchiveProjection` 以两次批量查询读取 normalized `agent_sessions`/`agent_messages`，导出器只投影 session id、scope、workspace、模型配置、状态、时间和标准化 transcript 字段；`dsh_home_path`、凭证、provider secret、cache 及其他 runtime 文件不属于 archive projection。

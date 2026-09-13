# HTTP API 与事件

生产服务由 [buildProductionApp](../apps/server/src/app.ts) 组装 HTTP route；Server package 的 [index.ts](../apps/server/src/index.ts) 只公开该生产入口。所有路径以下均带 `/api` 前缀。repositories、sync、metadata、auth 的 route 注册分别位于 [repositories.ts](../apps/server/src/routes/repositories.ts)、[sync.ts](../apps/server/src/routes/sync.ts)、[metadata.ts](../apps/server/src/routes/metadata.ts)、[auth.ts](../apps/server/src/routes/auth.ts)；其他领域 route 仍从现有模块注册。精确字段、可选参数和约束以 [contracts 导出](../packages/contracts/src/index.ts) 链接到的 Zod schema 为准，本页提供查找目录，避免维护第二份字段定义。Focused tests 如需 lightweight builder，只能在同仓库内从 `src/app` 直接导入 `buildTestApp`，不属于 HTTP package public API。

| 路径组 | 操作 | contracts / route |
| --- | --- | --- |
| `/health` | GET，精确返回 `{ "status": "ok" }` | [health](../packages/contracts/src/health.ts) / [app](../apps/server/src/app.ts) |
| `/auth/status`、`/auth/unlock`、`/auth/password`、`/auth/disable`、`/auth/logout` | GET/POST 可选本地密码锁；仅 status/unlock/health 是公共 API，其余 API 在锁启用时需要 HttpOnly session cookie | [auth](../packages/contracts/src/auth.ts) / [auth route](../apps/server/src/routes/auth.ts) |
| `/repositories` | GET 配置仓库投影；POST 创建持久异步仓库接入任务并以 202 返回 job id | [repositories](../packages/contracts/src/repositories.ts)、[repository onboarding](../packages/contracts/src/repository-onboarding.ts) / [repositories route](../apps/server/src/routes/repositories.ts) |
| `/repository-onboarding/:jobId` | GET 查询验证、clone、注册、初始化、同步或终态进度；POST `retry` / `cancel` 重试或取消 | repository onboarding / repositories route |
| `/repositories/:id/sync`、`/sync-status` | POST 接受 forward/history/fetch_pr 同步并返回 `syncRunId`，GET 当前状态；HTTP trigger 固定为 `api` | [sync](../packages/contracts/src/sync.ts) / [sync route](../apps/server/src/routes/sync.ts) |
| `/repositories/:id/sync-runs`、`/sync-runs/:runId` | GET 最近 run 或具体 run（含 PR/Issue stream、计数、水位、错误） | sync / [sync route](../apps/server/src/routes/sync.ts) |
| `/repositories/:id/sync-history` | GET metadata history target、cursor/anchor 与最老覆盖边界；PUT 设置目标日期或 enable；POST `/pause`、`/continue` 控制 batch admission | sync / [sync route](../apps/server/src/routes/sync.ts) |
| `/repositories/:repositoryId/pulls/:number/fetch` | POST 定向拉取单 PR，返回独立 `fetch_pr` run，不改变 forward watermark/cursor | sync / [sync route](../apps/server/src/routes/sync.ts) |
| `/repositories/:id/pulls`、`/issues` 及各自 `/activity-days` | GET 列表和日期活动；PR 支持 `updated` / `number` sort，使用 `page` + `limit` 页码分页；Issue 继续使用 cursor；PR/Issue 可选 `archive=current|archived|all` | [metadata](../packages/contracts/src/metadata.ts) / [metadata route](../apps/server/src/routes/metadata.ts) |
| `/repositories/:id/merged` | GET `pull_requests` 的 merged projection，使用 `page` + `limit` 页码分页并返回过滤后的总数；没有独立同步，也不按 archive 过滤 | metadata / [metadata route](../apps/server/src/routes/metadata.ts) |
| `/repositories/:id/maintenance/preview`、`/maintenance`、`/maintenance/:runId` | POST preview/accepted bounded archive run，request selector 可用 `prune` 决定 payload cleanup，GET durable status；日期按 server timezone 转换为 UTC | [retention](../packages/contracts/src/retention.ts) / [maintenance route](../apps/server/src/metadata-maintenance-routes.ts) |
| `/repositories/:id/maintenance/runtime-history/preview`、`/maintenance/runtime-history` | POST preview/accepted runtime sync-run purge；服务固定使用 30 天 cutoff、保留最新 100 条并返回 protected/active/stream/target 计数 | retention / maintenance route |
| `/repositories/:id/pulls/:number/restore`、`/issues/:number/restore` | POST 恢复单个 metadata entity 的 archive marker | retention / maintenance route |
| `/repositories/:repositoryId/issues/:number` | GET 懒加载详情 | metadata / app |
| `/repositories/:id/domains` 及 `/:domainId` | GET/POST 集合，PUT/DELETE 单项 | [domains](../packages/contracts/src/domains.ts) / [domains route](../apps/server/src/domains.ts) |
| `/repositories/:id/pulls/:number/files` | GET 已同步变更路径 | domains / domains route |
| `/repositories/:id/pulls/:number` 及 `/prepare`、`/file`、`/tree`、`/local-command` | GET 详情及内容，POST prepare | [diff](../packages/contracts/src/diff.ts) / [diff route](../apps/server/src/diff.ts) |
| `/agent-sessions` 及 `/:id` | POST 创建、GET 列表/单项、PATCH 配置、DELETE 会话 | [agent](../packages/contracts/src/agent.ts) / [agent-chat](../apps/server/src/agent-chat.ts) |
| `/agent-sessions/:id/messages`、`/events`、`/workspace`、`/cancel` | GET/POST 消息、GET SSE、POST 工作区同步/停止 | agent / agent-chat |
| `/knowledge/tree`、`/assets` | GET 树和图片资产 | [knowledge](../packages/contracts/src/knowledge.ts) / [knowledge route](../apps/server/src/knowledge.ts) |
| `/knowledge/documents`、`/:id` | GET、POST 集合创建、PUT 保存、DELETE 单项 | knowledge / knowledge route |
| `/knowledge/documents/:id/move`、`/versions`、`/versions/:versionId/restore`、`/chat` | POST 移动、GET 历史、POST 恢复/默认聊天 | knowledge / knowledge route |
| `/scheduled-tasks`、`/:id`、`/:id/run`、`/:id/runs` | GET/POST 集合，PUT/DELETE 单项，POST 运行，GET 历史；run 只通过 `agentSessionId` 关联 Agent session | [scheduler](../packages/contracts/src/scheduler.ts) / [scheduled-tasks](../apps/server/src/scheduled-tasks.ts) |

Maintenance run kind 是 canonical 的 `archive` 或 `purge_runtime_history`；`prune` 只作为 archive request/selector 布尔值保留，其他 maintenance kind 会被拒绝。

控制中心新增以下路径，精确字段由 [settings contracts](../packages/contracts/src/settings.ts) 与模块路由定义：

| 路径组 | 操作 |
| --- | --- |
| `/repositories/:id/settings` | GET/PUT 仓库同步、retention policy 与 Worktrees operational policy；retention 默认 automatic OFF/7 天，`configuredSlots` 为 1-16（新仓库默认 10），`idleCleanupTtlHours` 为正数，响应包含 configured/physical/active/idle/dirty/pending retirement |
| `/repositories/:id/settings/worktrees/cleanup` | POST 显式清理 unused Worktrees；busy、dirty 和 Git status 失败的 slot fail closed |
| `/settings/integrations/github`、`/verify` | GET 摘要、PUT/DELETE token、POST 验证；不回传 secret |
| `/settings/agent`、`/providers` | GET runtime 能力与默认值、PUT 默认值/私有 provider secret |
| `/settings/knowledge-checkpoint`、`/run`、`/push` | GET/PUT 配置，POST checkpoint/push |
| `/repositories/:id/domains/source`、`/prompt` | GET/PUT 文件源码与更新 prompt |
| `/repositories/:id/domains/source/versions`、`/:versionId`、`/:versionId/restore` | GET 历史/内容、POST 恢复；prompt 具有同构路径 |
| `/agent-sessions/:id/interactions/:requestId` | POST 答复当前 runtime 交互 |

表内简写子路径均拼接到同一行的父资源。Knowledge 集合 GET/PUT 支持按 path 读取/保存；按 id 的资源用于稳定身份操作。

PR 与 Merged 列表的 `page` 默认为 1，`limit` 默认为 100 且最大为 100；响应统一包含 `page`、`pageSize`、`totalCount`、`totalPages` 和 `calendarTimeZone`。这些总数对应当前日期、状态、搜索和 Domain 过滤后的完整结果集（Merged 使用其支持的搜索和 Domain 过滤）。Issue 列表仍返回 `nextCursor` 并接受 cursor。
请求页超过 `totalPages` 时，服务返回最后一页的有效 `page`；过滤结果为空时返回 `page=1`、`totalPages=0` 和空 `items`。

Domain source 的 GET/PUT 读写仓库中的 JSON 文件，versions 提供历史列表、版本内容和 restore；prompt 使用同一文件读写边界。页面通过普通 Agent session 发送更新请求，成功后重新读取 source 与 rendered projection。GitHub token、provider secret 和其他凭据只接受写入或返回摘要，任何响应都不包含 secret。

## 边界和错误

[route-helpers.ts](../apps/server/src/route-helpers.ts) 与模块路由处理输入校验和错误映射；标准 envelope 为 `{ error: { code, message } }`。常见状态：400 输入无效、404 资源不存在、409 同步或 workspace 冲突。manual sync 返回 202 表示已接受，不表示远端同步完成。

列表 GET 始终本地读取；Issue detail GET 可刷新过期详情；Git prepare POST 可以 fetch。新增路由需明确是否有远端或文件系统副作用。

## SSE

Agent `/events` 暴露 LoongBoard 自有 `AgentRuntimeEvent`，事件由 DSH adapter 转换后经 controller 发送。历史消息走 `/messages` 并持久化到 SQLite；实时增量不是独立的持久消息。运行时 approval 会发送 `interaction.requested`，客户端选择后 POST `/interactions/:requestId`，完成时发送 `interaction.resolved`。改变事件时联动 contracts、adapter、controller 和 Web client，检查最终回答只落库一次。具体映射与取消语义见 [DSH 集成](dsh-integration.md)。

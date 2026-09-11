# 调度器

[cron.ts](../packages/scheduler/src/cron.ts) 是不依赖 DSH/数据库的五字段 cron 计算器，支持列表、范围、步长、星期日 0/7 和 IANA timezone。任务 CRUD、运行记录分别由 [HTTP routes](../apps/server/src/scheduled-tasks.ts) 和 [database service](../packages/database/src/scheduler-service.ts) 负责。

## 执行流程

[SchedulerEngine](../apps/server/src/scheduler.ts) 实际使用 `Map<taskId, setTimeout>` 为各任务维护 timer，**当前实现不是旧方案中的单 timer/min-heap**。

1. 启动恢复崩溃遗留 run，加载 enabled 任务并安排 timer；已过期的 nextRunAt 重算到未来。
2. 到期时 Agent task 获取共享 workspace 锁，再插入 run；成功获取后先安排下一次计划。System task 不获取 Agent workspace 锁。
3. 每个 Agent run 都创建一个全新的持久 general conversation，原样发送保存的 prompt；run 记录保存该 conversationId，用户可从运行记录打开并继续聊天。旧的 `scheduled_tasks.conversation_id` 仅作为兼容投影，不参与下一次 run 的选择。System task 通过同一 engine 的 executor 执行仓库同步或 Knowledge checkpoint/push，不创建虚假 Agent 会话。
4. 等待执行结束，记录 completed/failed、Agent session/conversation ID 并释放锁。调度器不解析报告格式。

## 忙碌、手动运行和重启

定时触发遇到 workspace busy 时，保留同一次 occurrence，30 秒后重试，此时不创建 run。Run Now 遇到冲突返回 409 `SCHEDULED_TASK_WORKSPACE_BUSY`。手动聊天使用同一个 [WorkspaceRunCoordinator](../apps/server/src/workspace-run-coordinator.ts)，不能再添加另一套锁。

重启不补跑所有错过的周期；残留 running run 恢复为 failed。关闭时先同步撤销 timers，停止 Agent，再等待正在执行的 run，最后关闭其他服务与数据库。该互斥为单服务进程内协调，与当前单用户本地架构一致。

前端入口为 `/settings/schedules`，也保留 `/scheduled-tasks`。变更 cron 检查时区和边界日期；变更执行逻辑检查 workspace 竞争、关闭及失败状态，不能只测时间表达式。

## 控制中心与系统任务

Repository 自动同步、metadata retention、Worktree maintenance、Knowledge checkpoint/push、LoongBoard code checkpoint/push 和 Agent archive export/push 使用稳定任务 ID，由 Settings 与 Schedules 操作同一 scheduler 记录；修改 cron/enabled 后重启不能被旧 settings.json 覆盖。系统任务动作使用 `repository.sync`、`repository.metadata-maintenance`、`repository.worktrees.cleanup`、`knowledge.checkpoint`、`knowledge.push`、`git.checkpoint`、`git.push`、`agent.archive.checkpoint`、`agent.archive.push`。Metadata maintenance 默认每天 03:00；该 task 固定执行 runtime sync-run history purge，只有 retention automatic archive 开启时才追加 terminal metadata archive/prune。每个 repository 的 worker 在 transaction batch boundary 让出 admission，不能新增第二个 timer。Worktree cleanup 每个 repository 使用固定低频（当前 6 小时）任务，不占 Agent workspace lock；Settings 只负责容量/TTL policy，不重复保存 cadence。checkpoint/export 与 push 始终是独立 cadence；Archive export 会先生成 allowlist projection 再提交，push 不会再次 export 或 commit。

`scheduled_tasks` 的 `enabled`、cron 和 `nextRunAt` 是运行时权威；settings.json 只保存非调度设置及必要的镜像值，启动不会用旧设置重新启用已禁用任务。`git.push` 通过显式 source ref 到 remote backup branch 推送，不 checkout、不 force、不 pull/rebase/merge；`knowledge.push` 同样只推送既有 source ref，不隐式创建 checkpoint commit。

Agent Archive 的 archive path 必须是明确的现有或可创建目录，不能指向 runtime state、agent-sessions、provider-secrets、worktrees、Knowledge 或代码仓库（包括其子目录）。设置和执行都不会自动 `git init`；目标不是 Git 仓库时，export checkpoint 和 push 会记录清晰失败。

Schedules 支持编辑 cron/timezone/prompt、启停、Run now、历史和打开 conversation；系统任务链接到对应 Settings。每个 run 的 conversation 都可独立打开；人工修改旧 conversation 不影响后续 run。运行中的会话不能删除或重配置。

Repository sync run history 的 purge 不是普通同步路径，也不与 metadata archive 混用：固定删除 30 天前且不在最新 100 条内的 terminal runs，保护 queued/running、History 的 `last_run_id` 和其他当前引用；stream/target 子行随 parent cascade 删除。SQLite free pages 不会因每次 purge 自动 `VACUUM`，文件整理属于单独的显式 optimize 运维动作。

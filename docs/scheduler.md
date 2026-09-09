# 调度器

[cron.ts](../packages/scheduler/src/cron.ts) 是不依赖 DSH/数据库的五字段 cron 计算器，支持列表、范围、步长、星期日 0/7 和 IANA timezone。任务 CRUD、运行记录分别由 [HTTP routes](../apps/server/src/scheduled-tasks.ts) 和 [database service](../packages/database/src/scheduler-service.ts) 负责。

## 执行流程

[SchedulerEngine](../apps/server/src/scheduler.ts) 实际使用 `Map<taskId, setTimeout>` 为各任务维护 timer，**当前实现不是旧方案中的单 timer/min-heap**。

1. 启动恢复崩溃遗留 run，加载 enabled 任务并安排 timer；已过期的 nextRunAt 重算到未来。
2. 到期先获取共享 workspace 锁，再插入 run；成功获取后先安排下一次计划。
3. Agent task 找到或创建绑定的持久 general conversation，原样发送保存的 prompt；后续 run 默认复用该 conversation，用户可从运行记录继续聊天。System task 通过同一 engine 的 executor 执行仓库同步或 Knowledge checkpoint/push，不创建虚假 Agent 会话。
4. 等待执行结束，记录 completed/failed、Agent session/conversation ID 并释放锁。调度器不解析报告格式。

## 忙碌、手动运行和重启

定时触发遇到 workspace busy 时，保留同一次 occurrence，30 秒后重试，此时不创建 run。Run Now 遇到冲突返回 409 `SCHEDULED_TASK_WORKSPACE_BUSY`。手动聊天使用同一个 [WorkspaceRunCoordinator](../apps/server/src/workspace-run-coordinator.ts)，不能再添加另一套锁。

重启不补跑所有错过的周期；残留 running run 恢复为 failed。关闭时先同步撤销 timers，停止 Agent，再等待正在执行的 run，最后关闭其他服务与数据库。该互斥为单服务进程内协调，与当前单用户本地架构一致。

前端入口为 `/settings/schedules`，也保留 `/scheduled-tasks`。变更 cron 检查时区和边界日期；变更执行逻辑检查 workspace 竞争、关闭及失败状态，不能只测时间表达式。

## 控制中心与系统任务

Repository 自动同步与 Knowledge checkpoint/push 使用稳定任务 ID，由 Settings 与 Schedules 操作同一 scheduler 记录；修改 cron/enabled 后重启不能被旧 settings.json 覆盖。系统任务动作使用 `repository.sync`、`knowledge.checkpoint`、`knowledge.push`。Knowledge 的远端行为仍限于 Knowledge repository，未扩展为任意源码仓库自动推送。

`scheduled_tasks` 的 `enabled`、cron 和 `nextRunAt` 是运行时权威；settings.json 只保存非调度设置及必要的镜像值，启动不会用旧设置重新启用已禁用任务。`repository.sync` 由 executor 启动同步 coordinator 并检查 PR/Issue 流的最终状态；`knowledge.checkpoint` 与 `knowledge.push` 分别执行 Knowledge checkpoint 和显式 push。

Schedules 支持编辑 cron/timezone/prompt、启停、Run now、历史和打开 conversation；系统任务链接到对应 Settings。删除绑定会话后，下次 Agent run 会创建替代会话并更新绑定。运行中的会话不能删除或重配置。

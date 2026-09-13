# 配置与运行

## 安装和开发启动

[package.json](../package.json) 当前要求 Node `>=24 <27`，包管理器固定 pnpm `11.19.0`。还需 Git；没有 `GH_TOKEN` 或 `GITHUB_TOKEN` 时需已认证的 gh。按所选 Node 版本安装原生 better-sqlite3 依赖，不手工替代 workspace 链接。

在应用仓库根目录执行：

```bash
pnpm install
pnpm dev
```

先准备父目录 `system.yaml`；独立克隆可复制 [system.example.yaml](../system.example.yaml) 到该位置，再修改仓库路径。已有配置时直接编辑所需项，不覆盖现存本机配置。

开发启动为两个进程：Fastify 默认 `127.0.0.1:4174`，Vite 默认 `127.0.0.1:5173`。Vite 将 `/api` 代理到 Server，覆盖变量为 `LOONGBOARD_API_ORIGIN`。生产启动使用已构建的同一份前端/Server 产物：`pnpm build && pnpm start`；Fastify 提供 API、SSE、静态文件和前端 deep link。具体 native/Docker 步骤见 [部署](deployment.md)。

## 配置定位和字段

[config.ts](../apps/server/src/config.ts) 从 pnpm workspace 定位应用根目录，默认读取父目录 `system.yaml`；`LOONGBOARD_SYSTEM_CONFIG` 可覆盖，变量中的相对路径以应用根目录解析。YAML 内路径则一次性相对 **YAML 所在目录** 解析。

| 字段组 | 含义 |
| --- | --- |
| version / timezone | 当前 version=1；日期活动的 IANA 时区 |
| repositories[] | key、name、GitHub owner/repo、本地 path、remote、defaultBranch、worktreeSlots（Worktree capacity fallback） |
| knowledge | path、相对 inbox、historyLimit；可选 checkpoint 配置见 Knowledge 章节 |
| runtime | statePath、repositoriesPath、worktreesPath、serverHost、serverPort；`repositoriesPath` 是页面接入仓库的受管 clone 根目录；`LOONGBOARD_SERVER_HOST`/`LOONGBOARD_SERVER_PORT` 可在进程环境中覆盖监听值 |
| agent | defaultProvider、defaultModel、defaultReasoningEffort、idleProcessMinutes |

`system.yaml.repositories` 是仓库定义的唯一持久来源，启动时投影到 SQLite。Settings → Repositories 可提交 GitHub HTTPS/SSH 地址或 `owner/repo`；Server 在 `runtime.repositoriesPath` 下安全 clone 或复用已验证 checkout，并通过原子写入把定义追加到 `system.yaml`。SQLite 只保存投影和可恢复的接入任务状态，不是第二份仓库注册表。配置拒绝重复 key/GitHub slug、无效时区、越界 inbox 和逃出受管根目录的路径。

仓库接入是异步流程：验证、clone/复用、YAML 注册、SQLite 投影、Settings/Domain/Scheduler 初始化及首次 metadata sync 都有持久状态。失败或取消不会被标为 ready，可从页面重试；服务重启会恢复 queued 任务。已有有效 checkout 不会覆盖，目标目录、父目录或符号链接越界时 fail closed。新仓库默认 10 个 Worktree slots，允许范围为 1–16；首次 metadata sync 默认回看 7 天，已有显式 30 天设置继续保留。

`agent.idleProcessMinutes` 缺省为 120，`0` 表示 Never。该时间从 turn 完成后开始计算，不限制正在执行的 Agent 长任务；已有显式配置继续生效。`system.yaml` 的 Agent 字段是安装级 fallback；服务启动后会把 `settings.json` 中保存的 default provider/model/reasoning 和 retention overrides 应用到 Agent runtime。Scheduled Task 自己保存的模型配置不受该默认值 hydration 覆盖。

Repository metadata retention 位于每个 Repository Settings：默认 automatic archive 为 OFF、cutoff 为 7 天，scope 可分别选择 merged PR、closed PR 和 closed Issue，另有 `prunePayloadWhenArchived` 开关。手动维护先用本地日期执行 preview，再确认 Archive & clean；Server 按配置时区转换为 UTC，并以默认 250 条（内部允许 200–500）的 batch 执行。归档不删除 PR/Issue metadata，Archived/All 视图仍可读；restore 或 reopen 会解除归档，继续处于 terminal 状态的 metadata update 不会自动解除归档。payload 被清理后，PR files/Issue detail 会在下一次需要时重新从 GitHub 获取。现有 `repository.metadata-maintenance` system schedule 每天都会执行 runtime sync-run history purge，即使 automatic archive 为 OFF；只有 metadata `archive` operation 受该开关控制，`prunePayloadWhenArchived` 只是 archive request/selector 的 payload 清理布尔值，不是独立阶段或 run kind，不另加 timer。手动 Storage maintenance 使用同一固定 30 天 + 最新 100 条策略。

Repository Settings 以 Settings V2 policy 形式保存在 system workspace 的 `settings.json`：forward sync 的开关与频率是用户 operational policy，写入后由 runtime bridge 投影到稳定的 `repository.sync` scheduled task。服务启动时再次以 JSON policy 投影 enabled 和 cron；task 既有值不能反向覆盖 JSON。已有成功水位的增量从 watermark 前 2 分钟读取。更老数据的范围只由 SQLite 中持久的 History target 控制，Settings 使用日期选择器及 7/30/90 天 quick actions，不再暴露一套重复的 Initial sync range。手动 Sync now 与自动 `repository.sync` 使用同一 forward 规则。

Repository Worktree Settings 的 maximum slots 与 idle cleanup TTL 是 operational override；它们覆盖 `system.yaml` 的安装级 fallback，不写入 `worktree_slots`。维护为低频或显式操作：自动 TTL 及缩容只处理 clean、非 busy slot，手动 Clean unused now 忽略 TTL 但仍保护 busy、dirty 和 status 失败的 slot。Settings/API 展示 configured/physical/active/idle/dirty/pending retirement；缩容不会因忽略高编号目录而留下磁盘孤儿。

Agent Archive 使用独立的 archive repository/path 配置。默认目录是 `systemRoot/agent-history`；用户明确保存的自定义 `archiveRepositoryPath`（archive directory）优先，因此 Docker 的典型默认路径是 `/data/agent-history`。Settings → Code backup 同页的 Agent history 区域支持 export/checkpoint cadence、独立 push cadence、source ref、remote、remote backup branch（默认 `agent-history-backup`）和最近状态。运行 exporter 时，`agent_sessions` 与 `agent_messages` 的 normalized projection 是唯一输入；输出为 `conversations/<safe-session-id>/metadata.json` 和 `transcript.jsonl`。DSH source of truth 仍在各会话的 runtime home；LoongBoard 当前 adapter 没有稳定官方 export 时，archive 明确是 normalized transcript fallback。导出不复制 `dsh-home`、provider secrets、credentials、cache 或其他 runtime 目录，且重复运行不会重写未变化文件。archive path 必须独立于 runtime state、agent-sessions、provider-secrets、worktrees、Knowledge 和代码仓库；目标不存在时可创建，export 可写入该目录，但不会自动 `git init`。checkpoint/push 只对已经存在且可写的 Git repository 执行；目录不是 Git repository 时会保留失败状态并拒绝该操作。

Code backup 的 `repositoryPath` 和 `available` 是 runtime-only 状态：Server 启动时检查真实 code checkout 是否为 Git repository，SettingsDocumentV2 只保存 checkpoint/push policy，不保存这两个字段。镜像部署通常没有 `.git`，此时 `available=false`，自动 checkpoint/push 不会被投影为可执行任务，手工动作也会被拒绝并返回精确提示 `Code backup unavailable in container-image deployment.`。即使如此，保存其他 Code backup 字段、路由字段和 Agent Archive 仍可用。

## 凭证

Settings → Integrations → GitHub 是 GitHub 凭证的唯一控制入口。解析顺序为设置页保存的 token、非空 `GH_TOKEN`、`GITHUB_TOKEN`，最后是 `gh auth token`；provider 和本地 `gh` 边界共用 [GitHubCredentialService](../packages/github/src/credentials.ts)。设置页只能看到来源、是否已配置和上次验证的账号/quota，永远不会返回 token。

设置页 token 存在 `runtime.statePath/github-credential.json`，provider secret 存在 `runtime.statePath/provider-secrets/*.secret`，写入权限为 0600；这些文件不写入 `system.yaml`、`settings.json`、Knowledge/Domain 版本或 Agent transcript。DSH 在启动时通过受控 credentials callback 接收 provider secret；没有凭证时 Settings 显示未配置，不能把 `gh` 命令失败误报为已认证。不要把 token 写入 YAML、文档或日志。

凭据和运行数据只保存在 runtime state 或显式挂载的数据目录中，不会打包进镜像或提交到仓库；部署时只持久化明确列出的数据边界。

## 数据与退出

| 位置 | 内容与处理 |
| --- | --- |
| knowledge.path | Markdown 和知识 Git，长期保留 |
| runtime.statePath/loongboard.sqlite3 | 索引、消息、短期版本、任务状态，需备份 |
| runtime.statePath/agent-sessions | 每会话 DSH home，随会话保留；不作为 Agent Archive 的输入目录 |
| runtime.repositoriesPath | Settings 接入和默认容器仓库的持久 checkout；不能与 state/worktree/Knowledge 根目录混用 |
| runtime.worktreesPath | PR slot 缓存；清理前由 WorktreeJanitor 确认没有 busy/dirty 内容，Git status 失败时 fail closed |
| system workspace/agent-history | Agent Archive 默认目录；Docker 中对应 `/data/agent-history`，用户保存的自定义 archive path 优先 |
| system workspace/settings.json | 控制中心非秘密设置；严格 Settings V2 policy。缺失文件或 V1 文档会迁移为完整 V2；V2 的未知、缺失或非法字段会拒绝并保留原文件，V1 迁移可能丢弃 legacy 未知字段 |
| system workspace/domains/*.json | Domain JSON 源文件；文件名普通 key 可读，异常 key 编码 |
| system workspace/prompts/update-domains.md | Agent 更新 Domain 使用的可编辑 prompt |
| runtime.statePath/domain-file-versions | Domain/prompt content hash 短期历史，可由 history/restore API 查看 |

SIGINT/SIGTERM 触发服务的有序退出。服务启动会把数据库中上次遗留的 running metadata sync 标记为 interrupted/failed，保留已写入 rows 与成功 watermark；下次显式 Sync now 可继续。不会自动补跑错过的周期。备份前停止写入，保留整个知识仓库、数据库及会话目录；只备份 Markdown 无法恢复聊天与短期版本。SQLite 在线复制不作为安全备份方式，完整备份/恢复边界见 [Backup and Restore](backup-restore.md)。不要用删除 `.loong` 处理普通启动故障。

### GitHub history 与 Merged 验收边界

数据库启动会执行有序迁移至 016；010 删除旧 Daily/lifecycle/逐日 coverage 表并建立 Merged partial index，011 持久化 History rate-limit recovery，012 增加 metadata retention/maintenance runs，013 增加 Agent title source，014 canonicalize Scheduler task/run、Agent session origin_kind 与 Worktree slot，015 将 `repository_maintenance_runs.kind` 收敛为 `archive` 与 `purge_runtime_history`，016 增加持久 repository onboarding jobs。迁移 015 会把旧 `prune` 行转为 `archive` 并保留 selector 中的 `prune` 布尔值；旧 `optimize` 行不删除，保留为 `interrupted` 的 `archive`，并在 selector/error 写入迁移说明，同时保留原计数和时间字段。History 保留每个实体的 cursor、recovery anchor、target date、最老 metadata 覆盖边界和 `resume_after`。非空 cursor 续跑不会重新套用 anchor cutoff，只有明确的 GitHub invalid/expired cursor 才进行一次 anchor-overlap 恢复；未知 GraphQL 错误应使本次 history 失败并保留原状态。History 是低优先级 admission，forward、`fetch_pr` 和 metadata maintenance 的 batch boundary 必须保留可用容量。

单个 History run 仍有页预算并可显示 `partial`；这不是 2000 条总上限。只要 enabled、cursor 未结束且未触发 pause/error/rate-limit floor，Coordinator 会以新 run 继续，重启后也从持久 cursor/anchor 恢复。History 只扩展当前 metadata coverage，不生成额外历史 projection，也不对整批历史 PR 立即补 changed files。

排查时先区分三类 ownership：forward 看 metadata watermark，history 看 cursor/anchor/target/oldest boundary，`fetch_pr` 看目标 PR 和 enrichment；fetch 不会修复或推进 forward/history 状态。Merged 只看 `pull_requests.merged_at`，一个 PR 后续 `updatedAt` 变化不能改变它在 Merged 时间线的日期或位置。

## 排错入口

| 现象 | 检查 |
| --- | --- |
| 启动失败 | config 错误中的路径/字段；Node 与 better-sqlite3 ABI；端口 |
| 列表为空或旧 | 先看 sync-status；列表 GET 不自动同步 |
| GitHub 同步失败 | provider 的认证、HTTP/GraphQL 错误，区分 PR/Issue 流 |
| 无法创建 PR 会话 | worktreeSlots、busy/dirty slot、Git 对象与 revision |
| Agent 无输出 | DSH pin、启动环境、session 状态、adapter 通知与 SSE |
| Knowledge 内容不一致 | 磁盘文件、watcher、id/hash、版本记录 |
| Domain 分类不一致 | `domains/*.json`、source 的 `parseError`、`domain_rules` 投影和重分类状态；非法 JSON 不会覆盖上一次有效投影 |
| GitHub 显示未配置 | Settings 的 credential source、`gh auth status`、环境变量和私有 credential 文件权限；不要打印 token |
| 仓库接入失败或停住 | 查看 Settings → Repositories 的接入步骤；核对 GitHub 凭证、managed path、目标目录和持久 onboarding job；不要手工覆盖已有 checkout |
| Code backup 不可用 | 先看 Settings API 的 runtime `available` 和只读 `repositoryPath`；镜像 checkout 没有 `.git` 时保持自动/手工 Code backup 关闭，使用页面提示，不要把它写入 settings |
| 计划未执行 | enabled、timezone、nextRunAt、workspace busy、服务是否在线 |

Repository metadata sync、metadata maintenance、Worktree maintenance、Knowledge checkpoint、Knowledge push、Code backup 和 Agent Archive 共享 Scheduler。system task action 包括 `repository.sync`、`repository.metadata-maintenance`、`repository.worktrees.cleanup`、`knowledge.checkpoint`、`knowledge.push`、`git.checkpoint`、`git.push`、`agent.archive.checkpoint`、`agent.archive.push`；调整 Settings 中的 policy 会先持久化 JSON，再更新同一条稳定任务，重启也会按 JSON policy 重新投影。Task GET、history 和 Run now 仍可用，但通用 scheduled-task PUT 不允许修改 system task。System task 不占用 Agent workspace lock；真正的同步、metadata maintenance、Knowledge、Worktree 或 Archive subsystem 负责自己的资源协调。Agent scheduled task 每次 run 都新建独立 session，run history 保存 `agentSessionId`，可继续打开旧 run；旧 session 的人工模型修改不影响下一次 run。Runtime sync history 的 purge 策略固定为 30 天 cutoff + 保留最新 100 条，并保护 queued/running 与 History 的 `last_run_id`；它与 metadata archive 分开。Archive export checkpoint 只读取 normalized allowlist 并对现有 Git 仓库提交，Archive push 只执行显式 refspec；两者失败均保留 Scheduler history，不自动初始化或合并远端。

## 本地密码锁

密码锁是可选的 Web/API 访问门禁，不是数据加密功能。启用、修改、停用和 Logout 位于 Settings → Security；密码本身永不进入 `settings.json`、SQLite、Knowledge、Agent transcript 或 API 响应。服务只在 `runtime.statePath/auth.json` 保存 scrypt 派生值、随机 salt、HMAC signing secret、版本和时间戳；文件为 0600，父目录收紧为 0700，写入使用临时文件、fsync 和原子 rename。

解锁会签发仅含版本/时间信息的 HMAC 会话 cookie：`HttpOnly`、`SameSite=Strict`、`Path=/`，HTTPS 环境追加 `Secure`，默认有效期 8 小时。密码失败使用进程内短暂 backoff；密码轮换、停用或重新启用会改变 `authVersion`/签名密钥，使旧 cookie 失效。`/api/health`、`/api/health/live`、auth status/unlock 和生产静态入口保持可访问，其他 API 需要有效 cookie。

恢复使用精确的 `runtime.statePath/auth.json` reset：native 先 `pnpm build` 再 `pnpm auth:reset`，Docker 在同一 `/data` bind mount 内运行 reset。reset 后必须重启 Server 才重新加载文件；它只删除 auth 文件，不触碰 SQLite、Knowledge、Agent session、Git 或 worktree。不要在文档、配置示例或日志中放置真实密码、token 或 provider secret。

检查命令与手工验收边界见 [testing.md](testing.md)。历史环境限制见 [validation-history.md](validation-history.md)，不将旧机器 workaround 当作安装步骤。

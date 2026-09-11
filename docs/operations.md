# 配置与运行

## 安装和开发启动

[package.json](../package.json) 当前要求 Node `>=24 <27`，包管理器固定 pnpm `11.19.0`。还需 Git；没有 `GH_TOKEN` 或 `GITHUB_TOKEN` 时需已认证的 gh。按所选 Node 版本安装原生 better-sqlite3 依赖，不手工替代 workspace 链接。

在应用仓库根目录执行：

```bash
pnpm install
pnpm dev
```

先准备父目录 `system.yaml`；独立克隆可复制 [system.example.yaml](../system.example.yaml) 到该位置，再修改仓库路径。已有配置时直接编辑所需项，不覆盖现存本机配置。

开发启动为两个进程：Fastify 默认 `127.0.0.1:4174`，Vite 默认 `127.0.0.1:5173`。Vite 将 `/api` 代理到 Server，覆盖变量为 `LOONGBOARD_API_ORIGIN`。`pnpm build` 只构建产物，不等于部署；当前 Server 不负责生产静态站点托管。

## 配置定位和字段

[config.ts](../apps/server/src/config.ts) 从 pnpm workspace 定位应用根目录，默认读取父目录 `system.yaml`；`LOONGBOARD_SYSTEM_CONFIG` 可覆盖，变量中的相对路径以应用根目录解析。YAML 内路径则一次性相对 **YAML 所在目录** 解析。

| 字段组 | 含义 |
| --- | --- |
| version / timezone | 当前 version=1；日期活动的 IANA 时区 |
| repositories[] | key、name、GitHub owner/repo、本地 path、remote、defaultBranch、worktreeSlots（Worktree capacity fallback） |
| knowledge | path、相对 inbox、historyLimit；可选 checkpoint 配置见 Knowledge 章节 |
| runtime | statePath、worktreesPath、serverHost、serverPort |
| agent | defaultProvider、defaultModel、defaultReasoningEffort、idleProcessMinutes |

仓库配置是唯一来源，启动时投影到 SQLite；不提供仓库增删 API。配置拒绝重复 key/GitHub slug、无效时区和越界 inbox。修改环境变量/配置后重启服务。

`agent.idleProcessMinutes` 缺省为 120，`0` 表示 Never。该时间从 turn 完成后开始计算，不限制正在执行的 Agent 长任务；已有显式配置继续生效。`system.yaml` 的 Agent 字段是安装级 fallback；服务启动后会把 `settings.json` 中保存的 default provider/model/reasoning 和 retention overrides 应用到 Agent runtime。Scheduled Task 自己保存的模型配置不受该默认值 hydration 覆盖。

Repository Settings 另存于 system workspace 的 `settings.json`：forward sync 的开关与频率是用户 operational policy；已有成功水位的增量从 watermark 前 2 分钟读取。更老数据的范围只由 SQLite 中持久的 History target 控制，Settings 使用日期选择器及 7/30/90 天 quick actions，不再暴露一套重复的 Initial sync range。手动 Sync now 与自动 `repository.sync` 使用同一 forward 规则。

Repository Worktree Settings 的 maximum slots 与 idle cleanup TTL 是 operational override；它们覆盖 `system.yaml` 的安装级 fallback，不写入 `worktree_slots`。维护为低频或显式操作：自动 TTL 及缩容只处理 clean、非 busy slot，手动 Clean unused now 忽略 TTL 但仍保护 busy、dirty 和 status 失败的 slot。Settings/API 展示 configured/physical/active/idle/dirty/pending retirement；缩容不会因忽略高编号目录而留下磁盘孤儿。

Agent Archive 使用独立的 archive repository/path 配置。Settings → Code backup 同页的 Agent history 区域支持 export/checkpoint cadence、独立 push cadence、source ref、remote、remote backup branch（默认 `agent-history-backup`）和最近状态。运行 exporter 时，`agent_sessions` 与 `agent_messages` 的 normalized projection 是唯一输入；输出为 `conversations/<safe-session-id>/metadata.json` 和 `transcript.jsonl`。DSH source of truth 仍在各会话的 runtime home；LoongBoard 当前 adapter 没有稳定官方 export 时，archive 明确是 normalized transcript fallback。导出不复制 `dsh-home`、provider secrets、credentials、cache 或其他 runtime 目录，且重复运行不会重写未变化文件。archive path 必须独立于 runtime state、agent-sessions、provider-secrets、worktrees、Knowledge 和代码仓库；目标不存在时可创建，但不会自动 `git init`。

## 凭证

Settings → Integrations → GitHub 是 GitHub 凭证的唯一控制入口。解析顺序为设置页保存的 token、非空 `GH_TOKEN`、`GITHUB_TOKEN`，最后是 `gh auth token`；provider 和本地 `gh` 边界共用 [GitHubCredentialService](../packages/github/src/credentials.ts)。设置页只能看到来源、是否已配置和上次验证的账号/quota，永远不会返回 token。

设置页 token 存在 `runtime.statePath/github-credential.json`，provider secret 存在 `runtime.statePath/provider-secrets/*.secret`，写入权限为 0600；这些文件不写入 `system.yaml`、`settings.json`、Knowledge/Domain 版本或 Agent transcript。DSH 在启动时通过受控 credentials callback 接收 provider secret；没有凭证时 Settings 显示未配置，不能把 `gh` 命令失败误报为已认证。不要把 token 写入 YAML、文档或日志。

## 数据与退出

| 位置 | 内容与处理 |
| --- | --- |
| knowledge.path | Markdown 和知识 Git，长期保留 |
| runtime.statePath/loongboard.sqlite3 | 索引、消息、短期版本、任务状态，需备份 |
| runtime.statePath/agent-sessions | 每会话 DSH home，随会话保留；不作为 Agent Archive 的输入目录 |
| runtime.worktreesPath | PR slot 缓存；清理前由 WorktreeJanitor 确认没有 busy/dirty 内容，Git status 失败时 fail closed |
| system workspace/settings.json | 控制中心非秘密设置；更新保留未知字段 |
| system workspace/domains/*.json | Domain JSON 源文件；文件名普通 key 可读，异常 key 编码 |
| system workspace/prompts/update-domains.md | Agent 更新 Domain 使用的可编辑 prompt |
| runtime.statePath/domain-file-versions | Domain/prompt content hash 短期历史，可由 history/restore API 查看 |

SIGINT/SIGTERM 触发服务的有序退出。服务启动会把数据库中上次遗留的 running metadata sync 标记为 interrupted/failed，保留已写入 rows 与成功 watermark；下次显式 Sync now 可继续。不会自动补跑错过的周期。备份前停止写入，保留整个知识仓库、数据库及会话目录；只备份 Markdown 无法恢复聊天与短期版本。不要用删除 `.loong` 处理普通启动故障。

### GitHub history 与 Merged 验收边界

数据库启动会执行有序迁移至 010；010 删除旧 Daily/lifecycle/逐日 coverage 表并建立 Merged partial index。History 保留每个实体的 cursor、recovery anchor、target date 和最老 metadata 覆盖边界。非空 cursor 续跑不会重新套用 anchor cutoff，只有明确的 GitHub invalid/expired cursor 才进行一次 anchor-overlap 恢复；未知 GraphQL 错误应使本次 history 失败并保留原状态。History 是低优先级 admission，forward 和 `fetch_pr` 必须保留可用容量。

单个 History run 仍有页预算并可显示 `partial`；这不是 2000 条总上限。只要 enabled、cursor 未结束且未触发 pause/error/rate-limit floor，Coordinator 会以新 run 继续，重启后也从持久 cursor/anchor 恢复。History 只 upsert metadata，不请求 lifecycle timeline、不构造 Daily Snapshot，也不对整批历史 PR 立即补 changed files。

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
| 计划未执行 | enabled、timezone、nextRunAt、workspace busy、服务是否在线 |

Repository metadata sync、Knowledge checkpoint、Knowledge push、Code backup 和 Agent Archive 共享 Scheduler。system task action 包括 `repository.sync`、`knowledge.checkpoint`、`knowledge.push`、`git.checkpoint`、`git.push`、`agent.archive.checkpoint`、`agent.archive.push`；调整 Settings 中的开关或频率会更新同一条持久任务，重启不会根据旧的 `settings.json` 重新启用已禁用任务。System task 不占用 Agent workspace lock；真正的同步、Knowledge 或 Archive subsystem 负责自己的资源协调。Agent scheduled task 每次 run 都新建独立 conversation，run history 保存 conversationId，可继续打开旧 run；旧 conversation 的人工模型修改不影响下一次 run。Archive export checkpoint 只读取 normalized allowlist 并对现有 Git 仓库提交，Archive push 只执行显式 refspec；两者失败均保留 Scheduler history，不自动初始化或合并远端。

检查命令与手工验收边界见 [testing.md](testing.md)。历史环境限制见 [validation-history.md](validation-history.md)，不将旧机器 workaround 当作安装步骤。

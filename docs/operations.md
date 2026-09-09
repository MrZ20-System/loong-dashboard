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
| repositories[] | key、name、GitHub owner/repo、本地 path、remote、defaultBranch、worktreeSlots |
| knowledge | path、相对 inbox、historyLimit；可选 checkpoint 配置见 Knowledge 章节 |
| runtime | statePath、worktreesPath、serverHost、serverPort |
| agent | defaultProvider、defaultModel、defaultReasoningEffort、idleProcessMinutes |

仓库配置是唯一来源，启动时投影到 SQLite；不提供仓库增删 API。配置拒绝重复 key/GitHub slug、无效时区和越界 inbox。修改环境变量/配置后重启服务。

`agent.idleProcessMinutes` 缺省为 120，`0` 表示 Never。该时间从 turn 完成后开始计算，不限制正在执行的 Agent 长任务；已有显式配置继续生效。

Repository Settings 另存于 system workspace 的 `settings.json`：`syncLookbackDays` 只能是 7 或 30，默认 30，仅限制首次 bootstrap 的 `updated_at` 窗口。已有成功水位的增量只从 watermark 前 2 分钟读取，不受首轮窗口影响；修改首轮窗口不重置水位。手动 Sync now 与自动 `repository.sync` 使用同一设置。

## 凭证

Settings → Integrations → GitHub 是 GitHub 凭证的唯一控制入口。解析顺序为设置页保存的 token、非空 `GH_TOKEN`、`GITHUB_TOKEN`，最后是 `gh auth token`；provider 和本地 `gh` 边界共用 [GitHubCredentialService](../packages/github/src/credentials.ts)。设置页只能看到来源、是否已配置和上次验证的账号/quota，永远不会返回 token。

设置页 token 存在 `runtime.statePath/github-credential.json`，provider secret 存在 `runtime.statePath/provider-secrets/*.secret`，写入权限为 0600；这些文件不写入 `system.yaml`、`settings.json`、Knowledge/Domain 版本或 Agent transcript。DSH 在启动时通过受控 credentials callback 接收 provider secret；没有凭证时 Settings 显示未配置，不能把 `gh` 命令失败误报为已认证。不要把 token 写入 YAML、文档或日志。

## 数据与退出

| 位置 | 内容与处理 |
| --- | --- |
| knowledge.path | Markdown 和知识 Git，长期保留 |
| runtime.statePath/loongboard.sqlite3 | 索引、消息、短期版本、任务状态，需备份 |
| runtime.statePath/agent-sessions | 每会话 DSH home，随会话保留 |
| runtime.worktreesPath | PR slot 缓存；清理前确认没有 busy/dirty 内容 |
| system workspace/settings.json | 控制中心非秘密设置；更新保留未知字段 |
| system workspace/domains/*.json | Domain JSON 源文件；文件名普通 key 可读，异常 key 编码 |
| system workspace/prompts/update-domains.md | Agent 更新 Domain 使用的可编辑 prompt |
| runtime.statePath/domain-file-versions | Domain/prompt content hash 短期历史，可由 history/restore API 查看 |

SIGINT/SIGTERM 触发服务的有序退出。服务启动会把数据库中上次遗留的 running metadata sync 标记为 interrupted/failed，保留已写入 rows 与成功 watermark；下次显式 Sync now 可继续。不会自动补跑错过的周期。备份前停止写入，保留整个知识仓库、数据库及会话目录；只备份 Markdown 无法恢复聊天与短期版本。不要用删除 `.loong` 处理普通启动故障。

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

Repository metadata sync、Knowledge checkpoint 和 Knowledge push 共享 Scheduler。system task action 分别是 `repository.sync`、`knowledge.checkpoint`、`knowledge.push`；调整 Settings 中的开关或频率会更新同一条持久任务，重启不会根据旧的 `settings.json` 重新启用已禁用任务。Knowledge checkpoint 只作用于 Knowledge 仓库，支持 Run now / Push now；自动 push 不会把任意源码仓库纳入 checkpoint。

检查命令与手工验收边界见 [testing.md](testing.md)。历史环境限制见 [validation-history.md](validation-history.md)，不将旧机器 workaround 当作安装步骤。

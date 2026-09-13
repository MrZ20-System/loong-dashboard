# 前端页面与技术实现

[main.tsx](../apps/web/src/main.tsx) 启动 React；[App.tsx](../apps/web/src/App.tsx) 注入 TanStack QueryClient；[AppShell.tsx](../apps/web/src/shell/AppShell.tsx) 组合 Sidebar、ContextHeader、主题和 React Router。

## 路由与入口

| 路由 | 代码入口 |
| --- | --- |
| `/` | [BoardPage](../apps/web/src/features/board/BoardPage.tsx) |
| `/repositories/:repositoryId` | [RepositoryActivityPage](../apps/web/src/features/community/RepositoryActivityPage.tsx) |
| `/repositories/:repositoryId/pulls`、`/issues` | [MetadataPage](../apps/web/src/features/community/MetadataPage.tsx) |
| `/repositories/:repositoryId/merged` | Merged timeline（current PR metadata 按真实 `mergedAt` 投影） |
| `/repositories/:repositoryId/pulls/:number` | [PullRequestDetailPage](../apps/web/src/pull-request-detail.tsx) |
| `/repositories/:repositoryId/issues/:number` | [IssueDetailPage](../apps/web/src/issue-detail.tsx) |
| `/knowledge`、`/knowledge/:documentId` | [KnowledgePage](../apps/web/src/knowledge.tsx) |
| `/agent` | [AgentPage](../apps/web/src/features/agent/AgentPage.tsx) |
| `/settings` | [SettingsControlCenter](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/repositories` | [RepositoriesSettings](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/integrations` | [IntegrationsSettings](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/agent` | [AgentSettings](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/checkpoint` | [KnowledgeCheckpointSettingsPage](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/code-backup` | [CodeBackupSettingsPage](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/security` | [SecuritySettings](../apps/web/src/features/settings/SecuritySettings.tsx) |
| `/settings/domains` | [DomainsSettingsPage](../apps/web/src/features/settings/DomainsSettingsPage.tsx) |
| `/settings/schedules`、`/scheduled-tasks` | [ScheduledTasksPage](../apps/web/src/scheduled-tasks.tsx) |
| `/settings/health` | [HealthPage](../apps/web/src/features/system/HealthPage.tsx) |

`/health` 重定向到 `/settings/health`；`/settings` 是控制中心入口。控制中心按 Repositories、Integrations、Agent、Domains、Schedules、Health、Knowledge checkpoint 和 Code backup 分区，具体设置页通过 `SettingsShell` 的标签导航进入。表中的 `/issues` 指与同一 repository 前缀拼接的 Issue 列表。

## 请求与状态

各 `*-client.ts` 管理传输及 contracts 响应校验。Query 默认配置在 [app/query.ts](../apps/web/src/app/query.ts)，路由过滤和请求 hook 在 [app/hooks.ts](../apps/web/src/app/hooks.ts)。PR/Issue 同步成功后分别刷新相关查询，失败流保留旧数据。页面筛选和分页不能隐式触发远端同步。

Pull Requests 只提供 Recently Updated 与 PR Number 两种当前事实视图。前者按 `updatedAt + number`、后者按 number 使用服务端分页；搜索在 SQLite 全结果集上执行，不只过滤当前页。Web 每页固定请求 100 条，URL 使用 `?page=N`，由共享 [Pagination](../apps/web/src/components/metadata/Pagination.tsx) 提供首尾页、邻近页码、省略号、Previous/Next 和可访问的 Go to page 输入。过滤、搜索或排序变化会回到第 1 页。

PR/Issue 列表默认显示 current metadata，Archive filter 可切换 Archived 或 All；Merged 仍显示所有 `merged_at` projection，包括已归档 PR，并继续使用 page/limit 分页。payload 被 prune 的详情由 Server 在需要时重新获取，不能在 Web 中把空文件或空评论当成成功缓存。

Merged 是独立 repository 页面，使用与 PR 相同的 `page`/`limit=100` 分页和 Pagination 组件，不累计旧页或提供 Load older。每一页按 response 的 `calendarTimeZone` 和 `mergedAt` 分成清晰的每日 timeline group；日期标题、Codicon merge 节点、贯穿线和 bordered list card 用于明确日期边界。点击条目进入现有 PR Detail；Merged 直接读取当前 PR projection，不请求正文、diff 或完整文件。

## PR 工作台

PR detail 占用整个 viewport，AppShell 隐藏公共导航与页脚。Changed Files 和聊天侧栏独立折叠，尺寸交互在 [ResizableSidePanel](../apps/web/src/components/pr/ResizableSidePanel.tsx)。[ContinuousChanges](../apps/web/src/components/pr/ContinuousChanges.tsx) 负责连续变更视图；[diff-viewer.tsx](../apps/web/src/diff-viewer.tsx) 负责 Monaco diff/full-file 编辑器。

Full File 使用目标 revision 的 RepositoryTree；文件缓存见 [pr-file-cache.ts](../apps/web/src/pr-file-cache.ts)。修改 Monaco 生命周期需保持延迟加载取最新 props，卸载后不创建 editor，并释放 editor/model。布局验收要检查窄屏 Split、滚动、折叠和完整文件切换，历史参考见 [design QA](../design-qa.md)。

## 共享内容与聊天

[agent-chat.tsx](../apps/web/src/agent-chat.tsx) 用 HTTP 历史加 SSE 展示实时对话，提供 Stop、revision 提示与 workspace sync。[markdown.tsx](../apps/web/src/markdown.tsx) 统一 GFM/Mermaid 渲染；[knowledge-editor.tsx](../apps/web/src/knowledge-editor.tsx) 统一 Monaco Markdown 编辑及主题。不要为新页面复制 Markdown 或聊天实现。

Agent 会话由 `AgentSessionSelectionProvider` 按 origin scope 在 Query 页面、PR/Issue/Knowledge 侧栏和 [GlobalAgentDock](../apps/web/src/features/agent/GlobalAgentDock.tsx) 之间共享。显式打开已有会话使用 `/agent?session=<id>`；全局 Agent 页支持搜索、来源、repository 和状态过滤，并提供来源跳转及删除。列表展示 `provisional`、native `generated` 或用户 `manual` title；inline rename 一旦成功，后续 native title 不再覆盖。只有用户点击新建或打开 dock 后才会调用 ensure，导航和设置加载不会隐式创建会话。聊天中的 command、model 和 reasoning 选项来自 runtime capabilities。输入 `/` 会打开 runtime command 列表，按 command id 或 label 的连续子串过滤，选择后只插入 runtime 提供的真实 command id；当前 session 的模型与 reasoning 切换通过 session reconfiguration 接口提交。运行时活动、工具、approval interaction 和 streaming 事件仍由 SSE 展示。Global Dock 展开时隐藏 launcher，关闭后恢复；面板在 viewport 内自适应，消息区独立滚动，composer 固定在面板底部并在窄屏换行。

[SettingsControlCenter](../apps/web/src/features/settings/SettingsControlCenter.tsx) 使用 [settings-client](../apps/web/src/settings-client.ts) 调用 Server 控制端点。Repository 设置独立维护 forward 自动同步和频率，以及默认 OFF/7 天的 metadata retention policy；Retention 区域提供 scope、payload prune、按 server timezone 的本地日期 preview 和 Archive & clean。Storage maintenance 区域提供 runtime sync-run history preview/cleanup，但策略固定为 30 天 cutoff + 最新 100 条，不能在 Web 中调整。更老元数据统一由 Historical PR coverage 的目标日期及 7/30/90 quick actions 控制，不再并列显示另一套 Initial sync range。History 启用后按 bounded run 持续向目标推进，Recent syncs 展示目标、时间、耗时、状态和处理量。同步成功会刷新 repository Query，因此侧栏和 Board 计数会更新。GitHub token 和 provider secret 只在密码输入中写入，保存后不会回显。Security 页面管理本地 password lock；password 不写入 settings。Knowledge 页面维护 `autoCommit`、`autoPush`、`remote`、`sourceRef`、`remoteBranch`、`checkpointIntervalMinutes` 和 `pushIntervalMinutes`，并展示最近成功、下次运行、错误及 Run now/Push now；Code backup 同页展示独立 source ref、remote backup branch、checkpoint/push cadence 及 Agent history 的 archive path、export/push cadence、状态、Export checkpoint now 和 Push now。代码仓库路径由 Server runtime 提供，只读展示，不进入 SettingsDocumentV2。若 runtime 返回 `available=false`，页面显示精确提示 `Code backup unavailable in container-image deployment.`，禁用 Automatic checkpoint、Automatic push、Checkpoint now 和 Push now；Save、路由字段和 Agent Archive 仍可用。Agent Archive 默认目录为 `systemRoot/agent-history`，Docker 中通常为 `/data/agent-history`，用户明确保存的自定义 archive path 优先。

Settings → Repositories 顶部提供仓库接入卡片，接受 GitHub HTTPS、SSH 或 `owner/repo`，默认显示 7 天首次同步窗口和 10 个 Worktree slots，高级设置允许调整名称、key、remote、默认分支及 1–16 个 slots。提交后页面轮询持久 job，并以本地化步骤展示验证、clone/复用、注册、初始化、首次同步和 ready；失败/取消可重试，进行中可取消，GitHub 凭证缺失时引导到 Integrations。ready 后刷新仓库、Settings 和 sync 查询并提供进入仓库/立即同步入口。

Repository Settings 的 Worktrees 区域维护每 repository 的 maximum slots（1-16，新仓库默认 10）和 idle cleanup TTL，并展示 configured/physical/active/idle/dirty/pending retirement；`Clean unused now` 只回收可安全删除的 clean、非 busy worktree，不代表 Agent 全局并发。

Domains 页面提供 Rendered、JSON Source 和 Agent Update 三种视角。JSON 保存前只做必要的 JSON 解析校验并 pretty format，成功后刷新 rendered projection；解析失败时保留错误提示和最后有效投影。更新 prompt 存在可编辑 Markdown 文件中，Agent Update 通过同一个持久 Agent conversation 继续编辑 Domain JSON。

Schedules 页面统一展示 Agent 和 system 任务的启用状态、next/last run、运行历史和 Run now；Agent 任务支持编辑和删除，system 任务的 policy 通过对应 Settings 管理，通用 scheduled-task PUT 不允许修改 system task。Agent 运行历史中的 `agentSessionId` 可直接跳到全局 Agent 页面继续对话；system 任务显示对应 action。

共享样式在 [styles.css](../apps/web/src/styles.css)，PR 样式在 `components/pr/*.css`。全局 hover 保留颜色、背景和 focus 反馈，不给内部字符增加下划线。日常行为用相邻组件 UT 检查；视觉改动需在真实页面验收，构建通过不能证明布局正确。

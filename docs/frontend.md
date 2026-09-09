# 前端页面与技术实现

[main.tsx](../apps/web/src/main.tsx) 启动 React；[App.tsx](../apps/web/src/App.tsx) 注入 TanStack QueryClient；[AppShell.tsx](../apps/web/src/shell/AppShell.tsx) 组合 Sidebar、ContextHeader、主题和 React Router。

## 路由与入口

| 路由 | 代码入口 |
| --- | --- |
| `/` | [BoardPage](../apps/web/src/features/board/BoardPage.tsx) |
| `/repositories/:repositoryId` | [RepositoryActivityPage](../apps/web/src/features/community/RepositoryActivityPage.tsx) |
| `/repositories/:repositoryId/pulls`、`/issues` | [MetadataPage](../apps/web/src/features/community/MetadataPage.tsx) |
| `/repositories/:repositoryId/pulls/:number` | [PullRequestDetailPage](../apps/web/src/pull-request-detail.tsx) |
| `/repositories/:repositoryId/issues/:number` | [IssueDetailPage](../apps/web/src/issue-detail.tsx) |
| `/knowledge`、`/knowledge/:documentId` | [KnowledgePage](../apps/web/src/knowledge.tsx) |
| `/agent` | [AgentPage](../apps/web/src/features/agent/AgentPage.tsx) |
| `/settings` | [SettingsControlCenter](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/repositories` | [RepositoriesSettings](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/integrations` | [IntegrationsSettings](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/agent` | [AgentSettings](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/checkpoint` | [KnowledgeCheckpointSettingsPage](../apps/web/src/features/settings/SettingsControlCenter.tsx) |
| `/settings/domains` | [DomainsSettingsPage](../apps/web/src/features/settings/DomainsSettingsPage.tsx) |
| `/settings/schedules`、`/scheduled-tasks` | [ScheduledTasksPage](../apps/web/src/scheduled-tasks.tsx) |
| `/settings/health` | [HealthPage](../apps/web/src/features/system/HealthPage.tsx) |

`/health` 重定向到 `/settings/health`；`/settings` 是控制中心入口。控制中心按 Repositories、Integrations、Agent、Domains、Schedules、Health 和 Knowledge checkpoint 分区，具体设置页通过 `SettingsShell` 的标签导航进入。表中的 `/issues` 指与同一 repository 前缀拼接的 Issue 列表。

## 请求与状态

各 `*-client.ts` 管理传输及 contracts 响应校验。Query 默认配置在 [app/query.ts](../apps/web/src/app/query.ts)，路由过滤和请求 hook 在 [app/hooks.ts](../apps/web/src/app/hooks.ts)。PR/Issue 同步成功后分别刷新相关查询，失败流保留旧数据。页面筛选和分页不能隐式触发远端同步。

## PR 工作台

PR detail 占用整个 viewport，AppShell 隐藏公共导航与页脚。Changed Files 和聊天侧栏独立折叠，尺寸交互在 [ResizableSidePanel](../apps/web/src/components/pr/ResizableSidePanel.tsx)。[ContinuousChanges](../apps/web/src/components/pr/ContinuousChanges.tsx) 负责连续变更视图；[diff-viewer.tsx](../apps/web/src/diff-viewer.tsx) 负责 Monaco diff/full-file 编辑器。

Full File 使用目标 revision 的 RepositoryTree；文件缓存见 [pr-file-cache.ts](../apps/web/src/pr-file-cache.ts)。修改 Monaco 生命周期需保持延迟加载取最新 props，卸载后不创建 editor，并释放 editor/model。布局验收要检查窄屏 Split、滚动、折叠和完整文件切换，历史参考见 [design QA](../design-qa.md)。

## 共享内容与聊天

[agent-chat.tsx](../apps/web/src/agent-chat.tsx) 用 HTTP 历史加 SSE 展示实时对话，提供 Stop、revision 提示与 workspace sync。[markdown.tsx](../apps/web/src/markdown.tsx) 统一 GFM/Mermaid 渲染；[knowledge-editor.tsx](../apps/web/src/knowledge-editor.tsx) 统一 Monaco Markdown 编辑及主题。不要为新页面复制 Markdown 或聊天实现。

Agent 会话由 `AgentSessionSelectionProvider` 按 origin scope 在 Query 页面、PR/Issue/Knowledge 侧栏和 [GlobalAgentDock](../apps/web/src/features/agent/GlobalAgentDock.tsx) 之间共享。显式打开已有会话使用 `/agent?session=<id>`；全局 Agent 页支持搜索、来源、repository 和状态过滤，并提供来源跳转及删除。只有用户点击新建或打开 dock 后才会调用 ensure，导航和设置加载不会隐式创建会话。聊天中的 command、model 和 reasoning 选项来自 runtime capabilities，command 只会插入 runtime 提供的 command id，当前 session 的切换通过 session reconfiguration 接口提交；运行时活动、工具、approval interaction 和 streaming 事件仍由 SSE 展示。Global Dock 再次点击 launcher 会切换开关，关闭按钮仍可用；面板在 viewport 内自适应，消息区独立滚动，composer 控件会在窄屏换行。

[SettingsControlCenter](../apps/web/src/features/settings/SettingsControlCenter.tsx) 使用 [settings-client](../apps/web/src/settings-client.ts) 调用 Server 控制端点。Repository 设置独立维护自动同步和频率；Initial sync range 为 7 或 30 天（默认 30），首次按 `updated_at` 覆盖所有 PR/Issue 状态，后续从各流上次成功水位减 2 分钟继续增量，改变范围不会重置数据或水位。同步成功会刷新 repository 查询，因此侧栏和 Board 计数会更新；PR/Issue 两个同步流都成功时，以较早时间作为完整同步时间。GitHub token 和 provider secret 只在密码输入中写入，保存后不会回显。Agent 默认值及 retention 来自 runtime 能力，retention 的 `0` 表示 Never。Knowledge checkpoint 是当前唯一支持自动 commit/push 的文件仓库，页面展示 remote、branch、周期、最近成功、下次运行、错误及 Run now/Push now。

Domains 页面提供 Rendered、JSON Source 和 Agent Update 三种视角。JSON 保存前只做必要的 JSON 解析校验并 pretty format，成功后刷新 rendered projection；解析失败时保留错误提示和最后有效投影。更新 prompt 存在可编辑 Markdown 文件中，Agent Update 通过同一个持久 Agent conversation 继续编辑 Domain JSON。

Schedules 页面统一展示 Agent 和 system 任务的启用状态、next/last run、运行历史、Run now、编辑和删除。Agent 任务返回的 conversation ID 可直接跳到全局 Agent 页面继续对话；system 任务显示对应 action。

共享样式在 [styles.css](../apps/web/src/styles.css)，PR 样式在 `components/pr/*.css`。全局 hover 保留颜色、背景和 focus 反馈，不给内部字符增加下划线。日常行为用相邻组件 UT 检查；视觉改动需在真实页面验收，构建通过不能证明布局正确。

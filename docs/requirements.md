# 产品范围

LoongBoard 是本地优先、单用户的工程工作台。一个浏览器连接本地 Node 服务，把 GitHub 活动、本地代码阅读、Agent 对话和 Markdown 知识管理放到同一界面。

## 当前能力

- 按仓库浏览 PR、Issue 和日期活动，手动或定时同步元数据，筛选和分页。首次同步按更新时间读取最近 7/30 天的所有状态，后续按成功水位增量同步。
- 根据 PR 变更文件路径及用户维护的规则生成确定性的 Domain 标签。
- 从本地 Git 读取 PR diff、完整文件及目录树；PR 对话使用可复用 worktree。
- 通过外部 DeepSeek Harness 原生 Host 运行 Agent，保存和恢复会话，实时展示文本、工具事件及交互请求，使用原生模型、命令和运行配置；Agent 页面、业务页与全局浮窗共享会话。
- 管理 Knowledge Markdown 文件、短期版本和文档默认对话。
- 按 cron 或 Run Now 向计划任务的持久 Agent 会话发送 prompt；仓库同步、Knowledge checkpoint 和 push 也由统一 Scheduler 执行。
- 通过 Settings 控制中心管理仓库同步、统一 GitHub 凭证、Agent、checkpoint、Domain JSON 源文件和计划任务。

## 数据归属

GitHub 是远端元数据源，SQLite 是列表读取模型。Git 是代码内容与实际 revision 的依据。Knowledge 正文以磁盘 Markdown 为准，Git 提供长期历史；SQLite 同时保存知识索引、短期版本、会话消息和调度状态，不能把整个数据库当作可丢缓存。Worktree 是缓存位置，但其中未提交改动仍需保护。

## 产品边界

当前产品不提供 GitHub 写操作、AI PR/Issue 摘要、AI Domain 分类、DSH Web UI 或 DSH Plugin，也没有产品级 Agent 权限系统、分布式任务队列或多用户控制面。LoongBoard 不复制外部 DSH 的 Agent loop。

这些限制针对产品功能；Agent 在本机的实际能力由运行环境和 DSH 配置决定，见 [DSH 集成](dsh-integration.md)。

HTTP schema 统一由 `packages/contracts` 维护，模块依赖约束见 [架构](architecture.md)。

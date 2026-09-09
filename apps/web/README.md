# @loongboard/web

React 浏览器应用。页面路由、Query/API 客户端、PR 工作台、共享聊天与 Markdown/Monaco。使用 contracts 校验响应，不访问数据库或远端 GitHub。

设置控制中心覆盖仓库同步（首次 7/30 天范围）、GitHub 凭据摘要、runtime defaults、Knowledge checkpoint、Domain source/history/prompt、schedules 和 health。Agent 页面与 Global Dock 共享显式 session ID；Dock 支持 viewport 内自适应、消息滚动和 launcher toggle。同步完成后会刷新 repository Query，使侧栏计数保持最新。全局 hover 保留交互反馈但不增加文字下划线。

- [实现说明](../../docs/frontend.md)
- [源码入口](src/shell/AppShell.tsx)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/web test
pnpm --filter @loongboard/web typecheck
```

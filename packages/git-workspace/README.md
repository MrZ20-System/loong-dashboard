# @loongboard/git-workspace

本地 Git 与 worktree。LocalGitWorkspace、WorktreePool、命令错误和 Knowledge runCheckpoint；不持有数据库或 DSH。

- [实现说明](../../docs/git-workspace.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/git-workspace test
pnpm --filter @loongboard/git-workspace typecheck
```

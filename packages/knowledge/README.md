# @loongboard/knowledge

Markdown 文件操作。扫描快照、front matter 身份、路径边界和原子写入；版本索引、watcher、默认会话在 Server，Git checkpoint 在 git-workspace。

- [实现说明](../../docs/knowledge.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/knowledge test
pnpm --filter @loongboard/knowledge typecheck
```

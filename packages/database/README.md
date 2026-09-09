# @loongboard/database

SQLite 持久化。迁移、Drizzle schema、原始 SQL、类型化存取；跨模块业务流程由 Server 协调。

- [实现说明](../../docs/data-model.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/database test
pnpm --filter @loongboard/database typecheck
```

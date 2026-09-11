# @loongboard/database

SQLite 持久化。迁移、原始 SQL、按业务拆分的类型化存取服务；跨模块业务流程由 Server 协调。

迁移和这些类型化 SQLite 服务是本包唯一的 schema/source boundary；数据库运行时不再维护独立 ORM schema。

- [实现说明](../../docs/data-model.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/database test
pnpm --filter @loongboard/database typecheck
```

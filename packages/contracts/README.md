# @loongboard/contracts

共享 HTTP 与事件契约。Zod schemas、推导类型、游标和产品 AgentRuntimeEvent；不执行网络、Git、SQL 或 UI 行为。

- [实现说明](../../docs/api.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/contracts test
pnpm --filter @loongboard/contracts typecheck
```

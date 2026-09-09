# @loongboard/scheduler

Cron 计算。parseCron、validateCron、nextOccurrence；timer、执行协调和持久化在 Server/database。

- [实现说明](../../docs/scheduler.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/scheduler test
pnpm --filter @loongboard/scheduler typecheck
```

# @loongboard/agent-runtime

产品 Agent runtime。AgentRuntime、AgentSessionSpec、AgentRuntimeHost；不导入 DSH SDK 或持久化消息。

- [实现说明](../../docs/dsh-integration.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/agent-runtime test
pnpm --filter @loongboard/agent-runtime typecheck
```

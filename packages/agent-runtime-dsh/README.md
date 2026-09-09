# @loongboard/agent-runtime-dsh

DSH adapter。DSHRuntime、固定版本原生 Host、动态模型/命令发现、私有凭证、交互和流式 channel；DSH 类型与传输认证不进入产品层。

- [实现说明](../../docs/dsh-integration.md)
- [源码入口](src/index.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/agent-runtime-dsh test
pnpm --filter @loongboard/agent-runtime-dsh typecheck
```

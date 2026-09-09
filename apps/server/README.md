# @loongboard/server

Fastify 服务与跨模块协调。配置加载、依赖组装、HTTP 路由、同步、Agent/Knowledge/调度 controller。SQL、Git 命令和 DSH SDK 调用通过对应包完成。

- [实现说明](../../docs/architecture.md)
- [源码入口](src/runtime.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/server test
pnpm --filter @loongboard/server typecheck
```

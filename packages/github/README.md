# @loongboard/github

GitHub provider。GraphQL/REST HTTP fetch、token 解析与响应校验；gh 仅用于缺少环境 token 时获取凭证。

- [实现说明](../../docs/github-sync.md)
- [源码入口](src/provider.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/github test
pnpm --filter @loongboard/github typecheck
```

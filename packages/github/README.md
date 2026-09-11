# @loongboard/github

GitHub provider。`GhGitHubMetadataProvider` 是稳定的 facade；具体职责按单向边界拆在
`github-client.ts`（token、`gh auth token`、REST/GraphQL、错误与 quota）、
`pull-requests.ts`（PR 查询、分页、水位、history、按编号 fetch）、
`issues.ts`（Issue 查询、分页、history、详情与评论）以及 `files.ts`
（changed-file GraphQL batch、REST fallback 与 cap）。
`gh` 仅用于缺少环境 token 时获取凭证，所有外部响应仍在 GitHub 包内做 Zod 校验。

- [实现说明](../../docs/github-sync.md)
- [facade 入口](src/provider.ts)
- [transport 边界](src/github-client.ts)
- [本包修改约束](AGENTS.md)
- [统一测试与验收](../../docs/testing.md)

从应用仓库根目录运行本包检查：

```bash
pnpm --filter @loongboard/github test
pnpm --filter @loongboard/github typecheck
```

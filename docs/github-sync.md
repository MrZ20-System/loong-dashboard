# GitHub 同步与 Domain 分类

## 入口与传输

[provider.ts](../packages/github/src/provider.ts) 的 `GhGitHubMetadataProvider` 保留既有类名，实际通过原生 HTTP fetch 调用 GraphQL/REST。Server 将 provider 与 [GitHubCredentialService](../packages/github/src/credentials.ts) 连接到同一个凭证边界：设置页保存的 token 优先，其次是非空 `GH_TOKEN`、`GITHUB_TOKEN`，最后执行 `gh auth token`；`gh` 解析时通过受控环境继承 token。响应在 provider 使用 Zod 校验，外部 JSON 不直接流入 Web。

设置页只返回 `configured`、来源和已验证的账号/quota；不会回传 token。设置页保存的 GitHub 凭证位于 `runtime.statePath/github-credential.json`，文件权限为 0600，不进入 `settings.json`、Domain/Knowledge 版本或 Agent workspace。缺少认证时显示 `configured=false/source=none`，不会伪装成已配置。

## 元数据流程

1. Web 显式 POST sync；[RepositorySyncCoordinator](../apps/server/src/sync-coordinator.ts) 返回 202 后在进程中运行，同一仓库按 admission FIFO 排队，最多同时处理两个仓库。foreground forward、`fetch_pr` 和 metadata maintenance batch boundary 优先于低优先级 History admission；History 不会占满所有 repository slot。
2. PR、Issue 分别维护同步流。首次 forward sync 按最近更新时间读取所有状态，不单独全量读取 Open；后续增量同步继续从上次成功水位向前重叠两分钟读取。更老的数据由独立 History target 持续回补，Settings 不再暴露一套与 History 重复的 7/30 bootstrap 选择。History 遇到 rate-limit floor 时将 provider 的 `resetAt` 持久化为 `repository_history_state.resume_after`，到达该 UTC 时间前不重新 admission；服务重启后按该字段恢复 continuation，而不是永久停在 rate-limit 状态。
   GraphQL 每页按 `UPDATED_AT DESC` 请求，首轮在结果更新时间早于 cutoff 时停止；`hasNextPage=false` 正常结束，重复或无效 endCursor 记为分页错误而停止，避免重复拉取。实现不按固定总数截断。
3. 页面结果幂等写入 SQLite。只有整个实体流成功才把水位推进到本次尝试开始时间；失败保留旧行和旧水位并记录错误。归档 metadata 仍可被列表读取：PR/Issue 默认 current，也可选 archived/all；reopen 会自动解除 archive，继续处于 terminal 状态的 metadata update 不会自动解除归档，Merged 仍保留已归档的 PR 且不改变既有 page/limit 分页。payload prune 后，PR files 和 Issue detail 发现 marker/过期缓存会重新请求 GitHub，成功刷新清除 marker。
4. 列表、日期活动、过滤及分页只读 SQLite。PR 和 Merged 使用 `page` + `limit` 页码分页，并在同一过滤条件下计算准确的 `totalCount` / `totalPages`。当前 PR 支持 `updated_at DESC, number DESC` 和 `number DESC` 两种排序；Merged 使用 `merged_at DESC, number DESC`，且只包含 `merged_at IS NOT NULL`。PR 的日期筛选按配置时区转换为 UTC 半开区间；Issue 仍使用 cursor 分页。

## Run、历史与 Merged 投影

每次同步先写入 `repository_sync_runs`，并为 PR/Issue（单 PR fetch 只建 PR）写入
`repository_sync_run_streams`。Run 的 `kind` 为 `forward`、`history` 或 `fetch_pr`，状态为
`queued`、`running`、`completed`、`partial`、`failed` 或 `interrupted`；页面数、条目数、错误、
水位前后值和每次 enrichment 的目标写入同一 run。Server 返回 `syncRunId`，等待只绑定这个
run；同一仓库拒绝重叠 run，其他仓库不互相等待。进程启动会把上次的 queued/running run
恢复为 `interrupted`，保留已经写入的 rows、history cursor 和最老覆盖边界。

forward 只在两个实体流都成功结束后推进各自水位，仍使用成功水位前两分钟 overlap；失败不会
推进水位。history 维护每个实体独立的 cursor、更新时间 anchor、目标日期和最老覆盖边界，按
`UPDATED_AT DESC` 连续分页；每个 run 默认最多消费 20 页，留下 cursor 后由下一批继续，因此
不会一次请求无限翻页。History 启用时，`partial` batch 完成后以新的持久 run 自动续跑；服务
重启也从 cursor 新建 continuation，而不是重放旧 run。非空 cursor 续跑时不应用 anchor cutoff；只有 GitHub 明确报告 cursor
invalid/expired/unknown/not-found 才允许从最新页按 durable anchor 减两分钟重试一次，未知
GraphQL 错误保留状态并失败。history 不改变 forward watermark。`fetch_pr` 只请求目标 PR、只对
该目标做文件 enrichment，并不修改 watermark、history cursor 或 recovery anchor。

History 只 upsert 当前 PR/Issue metadata，并不再请求 timeline facts、重放 EOD 状态或写 Daily
Snapshot，也不恢复 Daily crawler。它也不为每个历史 PR 立即补 changed files；forward 只 enrichment 当轮 new/head-changed/
retry target，`fetch_pr` 只 enrichment 指定 PR，因此 metadata coverage 不被历史文件请求阻塞。

Merged 是 `pull_requests` 的 SQLite projection：`WHERE merged_at IS NOT NULL ORDER BY merged_at DESC,
number DESC`。它没有独立表、sync run、crawler 或 scheduler；任何 forward/history/fetch_pr 获得的
merged PR 会自然进入该页面。搜索和 Domain 过滤同时用于列表与 COUNT 查询；Web 使用 response 的
configured timezone 对当前页扁平结果插入日期分割线，不按日期发 N+1 请求。

相关持久化入口：[sync-service](../packages/database/src/sync-service.ts) 与 [metadata-service](../packages/database/src/metadata-service.ts)。迁移 010 删除已落库的旧 Daily/lifecycle/逐日 coverage 表并建立 Merged partial index；011 增加 History `resume_after`，012 增加 archive/prune 状态和 maintenance runs。新增列表字段时同步修改 contracts 与 provider 映射，避免给每行引入额外远端请求。

## 变更文件与分类

[enrichment-service](../apps/server/src/enrichment-service.ts) 只接收明确目标：forward 是
new/head-changed/retry，fetch_pr 是单一 PR；History 默认只补 metadata，不扫描或 enrichment 全库历史项目。
provider 的 [files.ts](../packages/github/src/files.ts) 管理批次、分页和并发限制。补全失败/截断
是显式状态，不可当作空文件列表已成功。

[domain-classifier.ts](../apps/server/src/domain-classifier.ts) 使用 picomatch 编译 include/exclude 规则：任意路径匹配 include 且不匹配 exclude 即命中该规则，可以命中多个 Domain。规则编辑经 [reclassification-service](../apps/server/src/reclassification-service.ts) 在进程内使用已存文件重算，不重新请求 GitHub。数据写入 `domain_rules`、`pull_request_domains` 及分类状态。

Domain 源文件位于 system workspace 的 `domains/<repository-key>.json`，JSON 是唯一编辑来源，SQLite 是渲染与分类投影。创建、编辑和删除 Domain 都先更新该文件再重投影；外部编辑和 Agent 文件工具的修改在 watcher 或读取时吸收。程序只做 JSON 解析及分类所需字段的机械校验，不限制 Domain 数量，也不施加 AI 类别、confidence 等上限。源文件暂时是非法 JSON 时，source API 仍返回原文和 `parseError`，最近一次有效投影继续可见；直接保存非法内容返回 400 并保留原文件。

每次有效 Domain/prompt 内容变化都会生成 content hash 版本，来源记录为 `manual`、`agent`、`external` 或 `restore`，短期历史位于 `runtime.statePath/domain-file-versions/`，可通过 history/restore API 修复文件。更新 prompt 是 system workspace 中可编辑的 `prompts/update-domains.md`；Agent 更新通过普通持久 conversation 读取该 prompt、仓库代码并直接编辑 Domain JSON。

## Issue 详情例外

[issue-detail-service.ts](../apps/server/src/issue-detail-service.ts) 按 `detail_synced_updated_at` 与元数据 `updated_at` 判断详情缓存是否过期。过期才调用 provider 获取正文和评论，事务替换缓存；同一 Issue 的并发读共享正在进行的刷新。列表仍不加载正文和评论。

排错先区分列表缓存、同步状态、文件补全和详情刷新，分别检查对应服务的错误。认证失败不会被解释为“仓库没有数据”。

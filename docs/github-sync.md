# GitHub 同步与 Domain 分类

## 入口与传输

[provider.ts](../packages/github/src/provider.ts) 的 `GhGitHubMetadataProvider` 保留既有类名，实际通过原生 HTTP fetch 调用 GraphQL/REST。Server 将 provider 与 [GitHubCredentialService](../packages/github/src/credentials.ts) 连接到同一个凭证边界：设置页保存的 token 优先，其次是非空 `GH_TOKEN`、`GITHUB_TOKEN`，最后执行 `gh auth token`；`gh` 解析时通过受控环境继承 token。响应在 provider 使用 Zod 校验，外部 JSON 不直接流入 Web。

设置页只返回 `configured`、来源和已验证的账号/quota；不会回传 token。设置页保存的 GitHub 凭证位于 `runtime.statePath/github-credential.json`，文件权限为 0600，不进入 `settings.json`、Domain/Knowledge 版本或 Agent workspace。缺少认证时显示 `configured=false/source=none`，不会伪装成已配置。

## 元数据流程

1. Web 显式 POST sync；[RepositorySyncCoordinator](../apps/server/src/sync-coordinator.ts) 返回 202 后在进程中运行，同一仓库不可重复同步，最多同时处理两个仓库。
2. PR、Issue 分别维护同步流。首次同步按最近更新时间读取所有状态，不单独全量读取 Open；仓库设置中的 `syncLookbackDays` 可选 7 或 30 天，默认 30 天，仅用于首次同步。后续增量同步继续从上次成功水位向前重叠两分钟读取，不受首次同步窗口限制。调整首次同步范围不重置已有成功水位；手动和定时同步使用同一规则。
   GraphQL 每页按 `UPDATED_AT DESC` 请求，首轮在结果更新时间早于 cutoff 时停止；`hasNextPage=false` 正常结束，重复或无效 endCursor 记为分页错误而停止，避免重复拉取。实现不按固定总数截断。
3. 页面结果幂等写入 SQLite。只有整个实体流成功才把水位推进到本次尝试开始时间；失败保留旧行和旧水位并记录错误。
4. 列表、日期活动、过滤及分页只读 SQLite。排序为 `updated_at DESC, number DESC`，游标包含稳定排序键；日期按配置时区转换为 UTC 半开区间。

相关持久化入口：[sync-service](../packages/database/src/sync-service.ts)、[metadata-service](../packages/database/src/metadata-service.ts)。新增列表字段时同步修改 contracts 与 provider 映射，避免给每行引入额外远端请求。

## 变更文件与分类

[enrichment-service](../apps/server/src/enrichment-service.ts) 在新 PR 或 head SHA 变化时补全文件路径；provider 的 [files.ts](../packages/github/src/files.ts) 管理批次、分页和并发限制。补全失败/截断是显式状态，不可当作空文件列表已成功。

[domain-classifier.ts](../apps/server/src/domain-classifier.ts) 使用 picomatch 编译 include/exclude 规则：任意路径匹配 include 且不匹配 exclude 即命中该规则，可以命中多个 Domain。规则编辑经 [reclassification-service](../apps/server/src/reclassification-service.ts) 在进程内使用已存文件重算，不重新请求 GitHub。数据写入 `domain_rules`、`pull_request_domains` 及分类状态。

Domain 源文件位于 system workspace 的 `domains/<repository-key>.json`，JSON 是唯一编辑来源，SQLite 是渲染与分类投影。创建、编辑和删除 Domain 都先更新该文件再重投影；外部编辑和 Agent 文件工具的修改在 watcher 或读取时吸收。程序只做 JSON 解析及分类所需字段的机械校验，不限制 Domain 数量，也不施加 AI 类别、confidence 等上限。源文件暂时是非法 JSON 时，source API 仍返回原文和 `parseError`，最近一次有效投影继续可见；直接保存非法内容返回 400 并保留原文件。

每次有效 Domain/prompt 内容变化都会生成 content hash 版本，来源记录为 `manual`、`agent`、`external` 或 `restore`，短期历史位于 `runtime.statePath/domain-file-versions/`，可通过 history/restore API 修复文件。更新 prompt 是 system workspace 中可编辑的 `prompts/update-domains.md`；Agent 更新通过普通持久 conversation 读取该 prompt、仓库代码并直接编辑 Domain JSON。

## Issue 详情例外

[issue-detail-service.ts](../apps/server/src/issue-detail-service.ts) 按 `detail_synced_updated_at` 与元数据 `updated_at` 判断详情缓存是否过期。过期才调用 provider 获取正文和评论，事务替换缓存；同一 Issue 的并发读共享正在进行的刷新。列表仍不加载正文和评论。

排错先区分列表缓存、同步状态、文件补全和详情刷新，分别检查对应服务的错误。认证失败不会被解释为“仓库没有数据”。

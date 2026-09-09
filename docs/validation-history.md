# 历史验收记录

以下记录各次验收的日期与适用边界，不代表未来工作树自动通过这些检查。环境特例不作为日常操作要求；当前命令见 [测试与验收](testing.md)。

## 2026-09-09 Settings、原生 Agent 与首次同步改造

- `pnpm check` 通过：313 项 UT、lint、类型检查、架构与 DSH pin 检查、全部生产构建。随后侧栏数量刷新收尾通过现有 App 定向测试（25 项）及 Web 构建。未重跑独立 regression 套件。
- 首次同步关键测试覆盖全状态分页、7/30 天更新时间边界和重复游标；增量测试确认旧水位超过 30 天时仍从原水位前移两分钟读取。Settings 保存范围不改变已有水位，同一轮 PR/Issue 使用启动时的配置快照。
- 在独立运行状态和 Knowledge 仓库的本地预览中完成真实浏览器验收：Settings 7/30 天保存刷新、GitHub 账号与 quota 验证、Domain JSON 编辑与错误反馈、Agent 页面和全局浮窗共享会话、计划任务连续两轮复用会话、checkpoint 提交并推送到本地 bare remote。
- vLLM 真实同步：PR 无成功水位，按默认 30 天读取全部状态；已有 Issue 水位继续增量。两流最终均为 idle；本轮开始于 `2026-09-09T14:41:46.547Z`，PR 完成于 `2026-09-09T14:47:00.923Z`，closed 最早更新时间为 `2026-08-10T14:42:07Z`，符合 30 天边界。此前已缓存的旧记录保留；本轮不是清库重建。
- 在 1357×987 真实页面确认浮窗与 composer 无横向溢出、Send 完整可见、launcher 可重复开关；closed/merged 列表与筛选可见，同步完成后侧栏数据刷新有定向测试覆盖。
- 原生 DSH 手工检查包括模型/命令目录、`/permission`、进程关闭后恢复及缺少模型凭证时的终态。独立预览未配置模型推理凭证，因此本轮不声明完整模型推理或 Agent 实际文件修改已验证。
- 仅出现非阻塞的 React act、Node 实验提示和 Vite 大 chunk 警告。

## 更早记录

以下内容保留自原 implementation-status.md，属于当时版本的记录。


- Current validation on 2026-09-08 after the backend performance and test
  restructuring: `pnpm check` passed, including 266 UT and all production
  builds; the new independent `pnpm test:regression` passed 3 tests. The
  regression suite was run because this was a major cross-module change.

- Historical full run on 2026-09-03 passed the former stage/E2E suite. Those
  test files and commands were intentionally removed on 2026-09-08 and are
  not part of the current validation contract.
- Recorded cold-start process smoke on 2026-09-03 against the real server
  binary (temporary `system.yaml`, no credentials): `/api/health` 200;
  repository list; knowledge tree (pre-existing Markdown listed); Knowledge
  create -> read-by-path -> versions; path-save adoption of an id-less file;
  general Agent Session create/list with the knowledge-root cwd and
  per-session DSH home under `.loong`. All responses were validated.
- `pnpm check` web build requires a manually cleared `apps/web/dist` first
  (Vite's out-dir clean trips the sandbox bulk-delete guard).
- Live DSH session smoke recorded on 2026-09-07 against the real subprocess
  runtime: a LoongBoard session whose previous turn ended in error was
  recovered and streamed `STREAM_OK`, and glob/read tool calls on the
  recovered session reported `TOOL_OK`. Stop interrupted the running turn
  with a null runtime session id; the next message resumed with `RESUMED_OK`
  on an idle session that received a fresh runtime session id.
- Live PR check on 2026-09-07 (real PR #55473, 1357x987 viewport): the
  chrome-free workbench filled the viewport, measured diff pane widths grew
  659 px -> 903 px -> 1217 px across layout changes with no horizontal
  overflow, and the real source view, Full File, and Back controls all
  worked.
- Knowledge checks on 2026-09-07 passed in isolation: GFM table and task
  lists, code fences, relative images through the Knowledge asset endpoint,
  Mermaid diagrams, and the dark Monaco editor. Startup indexing produced one
  `external` version record, and the default document chat rail was available;
  Restore was not exercised in this live check.
- Sandbox-external `pnpm check` passed on 2026-09-07: server 70, web 74,
  agent-runtime-dsh 11, agent-runtime 4, contracts 27, database 29,
  git-workspace 20, github 21, knowledge 12, scheduler 5, architecture 11,
  integration 3, plus production builds. Only non-blocking warnings were
  emitted (React `act(...)` warning and Vite large-chunk warning); inside
  the sandbox the same run can fail with EMFILE even though it passes
  outside.
- Fresh live GitHub, DSH, and browser checks remain explicit manual acceptance
  activities and are not claimed as completed here.


另见 [PR 工作台视觉验收](../design-qa.md)。

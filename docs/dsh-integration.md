# Agent 与 DSH 集成

## 分层

[AgentChatController](../apps/server/src/agent-chat.ts) 管理会话索引、来源、workspace、兼容消息缓存和订阅；[AgentRuntimeHost](../packages/agent-runtime/src/index.ts) 管理每会话 runtime、运行状态及空闲关闭；[DSHRuntime](../packages/agent-runtime-dsh/src/index.ts) 是唯一 DSH adapter。

当前固定 `dsh-v0.1.2-alpha.5`，依赖版本见 [dsh.lock.json](../dsh.lock.json)。该版本 SDK 的 prompt 协议没有模型/命令发现接口，因此 adapter 使用同版本官方 `dsh --profile web --no-open --port 0` Host 的原生服务。评估过的官方 UI 模块依赖 DSH 客户端容器；LoongBoard 保留自身 React shell，通过服务适配接入，没有 iframe、DSH fork 或自建插件。升级时同时维护 manifest、lock、pin 检查和 adapter，不在业务包加入兼容代码。

## 会话与工作目录

| origin | workspace |
| --- | --- |
| PR | 该 PR target revision 的 detached worktree |
| Repository / Issue | 配置的本地仓库根目录 |
| Domain | system workspace，包含 domains/ 与 prompts/ |
| Knowledge / 普通 general | knowledge 根目录 |
| 调度创建的 general | 任务显式配置的 workspace；每次 scheduled run 都创建独立持久会话 |

origin 是创建来源，workspace 是执行绑定。全局 Agent、业务面板和 Dock 通过相同产品 session ID 打开会话。每个会话拥有独立 `runtime.statePath/agent-sessions/<id>/dsh-home`。DSH 保存原生 transcript，LoongBoard 保存 opaque runtime ID、项目索引及 normalized 消息兼容缓存，不读取或重建 DSH 内部日志。

会话标题有明确的 ownership：新会话先使用 `provisional` 标题；首轮成功且 runtime 暴露原生 title 时，LoongBoard 通过 DSH 原生 session/title 能力读取并最多一次投影为 `generated`。用户 inline rename 后变为 `manual`，后续 native title 不得覆盖；title discovery 失败是非阻塞的 metadata 失败，不改变 turn 状态、不写入 prompt/transcript，也不把 prompt 文本拼成标题。Scheduled Task 每次 occurrence 创建独立 general Agent session，使用该 run 的 provisional title，不复用上一 run 的标题或 transcript。升级前已有 title 会按 `manual` 处理。

原生 Host 仅监听 loopback。启动 token 和认证 cookie 留在 adapter，浏览器只访问 LoongBoard API。GitHub token 不注入 DSH 子进程。Settings 保存的 provider secret 通过 DSH 的动态 provider settings 和 credentials 服务配置到对应独立 home；provider 与凭证引用由 DSH 发现，产品不维护静态环境变量映射。生产运行使用受控的 `env`、`startupTimeoutMs` 和测试/嵌入用 `transportFactory` 参数；adapter 负责回收原生 Host 进程及其 stream，不把 provider secret 复制到进程环境。

## Conversation Archive

DSH 的 session/runtime 仍是 conversation source of truth。当前 adapter 没有可依赖的稳定官方 conversation export 时，`AgentArchiveExporter` 只从 SQLite 中 LoongBoard 已保存的 normalized session metadata 与 messages 生成独立 archive repository 的 `conversations/<safe-session-id>/metadata.json` 和 `transcript.jsonl`。它不读取或复制 `dsh-home`、provider secrets、credentials、cache 或任何 runtime 目录，也不把 archive 反向当作 DSH 状态。

Archive export 与 push 由独立的 `agent.archive.checkpoint` / `agent.archive.push` system tasks 调度。前者导出 allowlist 后在已存在的 Git 仓库执行 checkpoint，后者仅通过 source ref → remote backup branch 的显式 refspec 推送；不会 checkout、force push、pull/rebase/merge 或自动 `git init`。Archive projection 包含最终的 session title 与 `titleSource`，但不包含 DSH home 或 secrets。Archive 路径边界拒绝 runtime state、session/provider secrets、worktrees、Knowledge 和代码仓库内路径。

导出使用固定字段 allowlist、稳定 session/message 顺序、完整 JSONL 行和 canonical JSON；每个文件通过临时文件 rename 原子替换，内容未变化时不重写，重复执行幂等。session id 必须是安全的单目录名；路径穿越会在任何写入前拒绝。数据库 projection 一次读取 sessions、一次按 session id 批量读取 messages，避免按会话 N+1 查询。

## 能力与交互

模型和 reasoning 来自 `session/modelCatalog`，命令来自 `commands/list`。system.yaml 提供安装级 fallback，启动时 `settings.json` 中已保存的 Agent operational overrides 会 hydrate 到 AgentChatController/runtime；Settings 只配置新会话默认值，Scheduled Task 自身保存的 provider/model/reasoning 仍是调度 run 的 authority。composer 修改当前会话的配置，adapter 在下一次 prompt 前调用 `session/selectModel`。普通 prompt 进入原生队列，slash command 先交给 `commands/execute`，未匹配的内容按普通 prompt 处理。

原生 Host 的 approval request 映射为通用交互请求，由用户点击 runtime 提供的选项后答复；不会自动允许。其他尚未适配的交互委托给 Host 的默认处理链。当前适配层不等同于完整官方客户端，复杂原生视图仍可增量扩展。

## 运行与停止

发消息前取得共享 [WorkspaceRunCoordinator](../apps/server/src/workspace-run-coordinator.ts) 的 workspace 锁，PR 还需匹配目标 revision。手动聊天冲突返回 409 `WORKSPACE_BUSY`。显式 workspace sync 先停止 DSH 后切换 worktree。

`agent.idleProcessMinutes` 默认 120，0 表示 Never。计时从 turn 完成后开始；运行中的长任务没有由此产生的 hard timeout。空闲关闭只释放进程并保留持久化的 opaque ID，后续可恢复原生会话。显式 Stop 终止当前 Host、清除本轮 runtime ID 并中断本轮，不复用被终止的 DSH session；服务启动会把前次遗留运行恢复为中断状态。删除 session 是更强的 destructive action：先确认没有运行中的 turn，停止 runtime，删除 LoongBoard session/messages，再只删除 `runtime.statePath/agent-sessions/<id>/dsh-home` 的精确 home；路径越界、symlink 或清理失败必须 fail closed，不得沿用父目录递归删除。

## 事件转换

[原生 transport](../packages/agent-runtime-dsh/src/native-transport.ts) 封装经过校验的 HTTP RPC 和 WebSocket multiplex stream。[notification-mapper.ts](../packages/agent-runtime-dsh/src/notification-mapper.ts) 把原生日志映射到已有产品兼容事件：

| DSH 数据 | 产品行为 |
| --- | --- |
| assistant/chunk 文本增量 | assistant.delta，即时流式显示 |
| assistant/message + turn/end + Host idle | assistant.completed，最终文本只落库一次 |
| tool/call、tool/result | tool.started / tool.completed，同一 run 内匹配 call id |
| command、job、subagent 等活动 | 通用 agent.activity 摘要 |
| approval/request | interaction.requested；结果经原生 Host 返回 |

日志与 Host 状态位于独立 stream，可能先收到 idle；adapter 同时等待完成日志，避免截断最终回答。模型错误或连接中断必须结束生成器并恢复 idle。长 turn 不设置 RPC hard timeout；关闭进程会撤销相关请求和订阅。

关键测试使用注入原生 transport 验证流顺序、终止、恢复和动态发现。真实进程 smoke 可在临时 home 中验证 catalog、slash command 和无凭证错误；它不证明真实模型推理或远端工具调用成功。[历史验收](validation-history.md) 不代表本次重新验证。

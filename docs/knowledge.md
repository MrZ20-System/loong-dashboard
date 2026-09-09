# Knowledge 文档与历史

## 文件与身份

[knowledge 包](../packages/knowledge/src/index.ts) 负责 Markdown 扫描、front matter、路径约束和 temp+rename 原子写入。[KnowledgeController](../apps/server/src/knowledge.ts) 负责 HTTP 行为、索引/版本协调、watcher、默认文档对话及 checkpoint 执行入口。

`loongboard_id` 是文档稳定身份。首次保存无 id 文件时接管并写入 id；索引中的身份优先于内容中的旧 id。保存只添加/替换该行，保留其他 front matter 字节和换行。移动文档保持身份和默认会话关联，不重新建一份聊天。

## 索引与版本

扫描排除 `.git`、`node_modules`、`.loong`，返回文件内容与 hash 的同一快照。有效 watcher 下，树和文档读取复用快照；相关写入/文件系统事件使其失效。

递归 watcher 以一秒 debounce 处理外部修改，写入 `external` 完整内容版本。Knowledge Agent 运行期间聚合修改，在 idle 时为各文档写入 `agent` 版本。UI 保存和恢复也通过 controller 协调文件与索引。保留数量由 `knowledge.historyLimit` 指定，示例为 10，必须为正整数；短期版本不是 Git 全历史。

## 预览、资产和对话

Web 的 Preview 隐藏开头 YAML front matter，Edit 使用 Monaco 并保留完整源文本。共享 MarkdownView 支持 GFM、Mermaid、受控链接和图片；相对图片经过 Knowledge asset API，路径需限制在知识根目录。原始 HTML 保持转义。

文档默认对话通过 `POST /api/knowledge/documents/:id/chat` 建立；工作目录为知识根目录。正文不会自动附加到 prompt，Agent 通过文件工具读取。

## 可选 Git checkpoint

配置支持 `knowledge.checkpoint.autoCommit`、`autoPush`、`remote`、`branch`；两个自动开关默认 false。Settings → Checkpoint 提供周期、运行状态、Run now 和 Push now。自动行为与手动操作都进入共享 Scheduler，使用 workspace 锁和持久运行记录；文档写入和索引变化不再自行提交。执行 [runCheckpoint](../packages/git-workspace/src/checkpoint.ts) 时会在知识仓库执行 `git add -A` 和 commit，覆盖该仓库全部待提交变更；启用 autoPush 后会推送，Push now 在工作区干净时仍可推送已有 HEAD。

失败记录在 Scheduler history 并显示于 Settings，不自动 pull、merge、rebase 或重试，也不回滚已保存的 Markdown。修改这部分时同时检查 [config.ts](../apps/server/src/config.ts)、controller 与 Git adapter，不能把“默认关闭”写成“未实现”。

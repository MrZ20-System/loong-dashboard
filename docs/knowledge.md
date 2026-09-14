# Knowledge 文档与历史

## 文件与身份

[knowledge 包](../packages/knowledge/src/index.ts) 负责 Markdown 扫描、front matter、路径约束和 temp+rename 原子写入。[KnowledgeController](../apps/server/src/knowledge.ts) 负责 HTTP 行为、索引/版本协调、watcher、默认文档对话及 checkpoint 执行入口。

`loongboard_id` 是文档稳定身份。首次保存无 id 文件时接管并写入 id；索引中的身份优先于内容中的旧 id。保存只添加/替换该行，保留其他 front matter 字节和换行。移动文档保持身份和默认会话关联，不重新建一份聊天。

## 索引与版本

扫描排除 `.git`、`node_modules`、`.loong`，返回文件内容与 hash 的同一快照。有效 watcher 下，树和文档读取复用快照；相关写入/文件系统事件使其失效。

递归 watcher 以一秒 debounce 处理外部修改，写入 `external` 完整内容版本。Knowledge Agent 运行期间聚合修改，在 idle 时为各文档写入 `agent` 版本。UI 保存和恢复也通过 controller 协调文件与索引。保留数量由 `knowledge.historyLimit` 指定，示例为 10，必须为正整数；短期版本不是 Git 全历史。

## 预览、资产和对话

Web 的 Preview 隐藏开头 YAML front matter，Edit 使用 Monaco 并保留完整源文本。共享 MarkdownView 支持 GFM、Mermaid、受控链接和图片；相对图片经过 Knowledge asset API，路径需限制在知识根目录。原始 HTML 保持转义。

文档默认对话通过 `POST /api/knowledge/documents/:id/chat` 建立；scope 仍是 Knowledge，但工作目录为 `personalData.path`，因此既能访问当前 `knowledge/` 文档，也能按统一相对路径读取 `prompts/` 与 `skills/`。正文不会自动附加到 prompt，Agent 通过文件工具读取。

## Personal Data 内的 Knowledge 边界

Knowledge 只扫描 `knowledge.path`，不把同级 `prompts/` 和 `skills/` 投影成新的产品类型。Refresh Instruction Tree 生成的 `_loongboard/instruction-tree.md` 也是普通 Knowledge Markdown，允许正常打开、编辑和删除；再次刷新会覆盖它，没有只读或绕过 watcher 的特例。

Git checkpoint 已升级为整个 `personalData.path` 的 Personal Data Backup，不再由 Knowledge 内容根代表仓库根。Settings → Personal Data 提供独立 checkpoint/push Cron、运行状态、Checkpoint Now 和 Push Now。执行 [runCheckpoint](../packages/git-workspace/src/checkpoint.ts) 时会覆盖同一 Git 仓库内的 `knowledge/`、`prompts/` 和 `skills/`；push 只执行显式 ref push，不隐式创建 checkpoint。

失败记录在 Scheduler history 并显示于 Settings，不自动 pull、merge、rebase、重试或 `git init`，也不回滚已保存的 Markdown。完整边界见 [Personal Data](personal-data.md)。

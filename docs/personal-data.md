# Personal Data

LoongBoard Personal Data 是一个普通 Git 仓库，仓库根目录由 `system.yaml` 的 `personalData.path` 指定：

```text
personal-data/
├── knowledge/
├── prompts/
└── skills/
```

`knowledge.path` 必须位于 Personal Data 根目录内，并且只有该目录进入 Knowledge 的扫描、watcher、版本和 SQLite projection。`prompts/` 与 `skills/` 在 V1 中只是普通文件：没有专用数据库、parser、runtime、管理页或 Scheduler 字段。Filesystem 与 Git 历史是三类内容的 source of truth。

## Git 导入

Settings → Personal Data 接受 Repository URL 和 Branch，并把所选分支以 single-branch clone 导入到配置好的只读 Local path。目标目录必须不存在或为空；已有数据时拒绝，绝不先删除再克隆。导入完成前会验证 `knowledge/`、`prompts/` 和 `skills/` 都存在。

导入是一次性操作，不保存来源 URL 或分支，也不创建 pull、fetch、merge、rebase、overlay 或后台同步任务。Git credential 使用现有受控 credential/askpass 边界，token 不进入 clone URL、`.git/config`、设置或日志。

## Instruction Tree

Settings 中的 Refresh Instruction Tree 使用 `tree-node-cli` 的 Node API 分别扫描 `prompts/` 与 `skills/`，再通过原子写入生成：

```text
knowledge/_loongboard/instruction-tree.md
```

树中的路径相对 Personal Data 根目录，默认展示完整深度。该文件对 Knowledge 来说是普通 Markdown：可以打开、编辑或删除；再次刷新会覆盖它。扫描结果不写入 SQLite 特殊表，也没有只读特例。

Refresh 只刷新文件，不隐式触发 checkpoint 或 push。V1 不提供 Refresh Cron。

## Agent workspace

General Agent 和 Knowledge document chat 的默认 workspace 是 Personal Data 根目录，所以提示词可以直接引用 `skills/foo.md`、`prompts/foo.md` 或 `knowledge/foo.md`。Knowledge scope 与文档关联仍保持不变。

Repository Agent 继续使用 repository checkout，PR Agent 继续使用 worktree。Scheduled Agent 的 `workspacePath` 和 prompt 数据模型不变；需要读取 Personal Data 时由用户把 workspace 指向 Personal Data 根目录。

## Backup

Personal Data Backup 复用既有 `runCheckpoint` 与 `pushBackupRef`：checkpoint 在整个 `personalData.path` 上执行，覆盖 `knowledge/`、`prompts/` 和 `skills/`；push 只把明确的 source ref 推到配置的 remote branch。两者是独立的手动操作和独立 Cron，互不隐式调用，也不会自动 `git init`、pull、merge 或 rebase。

Import source 与 Backup destination 完全独立。导入某个仓库和分支不会把它保存为备份目标，后续 push 只服从 Personal Data Backup policy。

## 部署与恢复

Native 部署应把 Personal Data 放在代码 checkout 之外的持久数据目录。Docker 示例使用 `personalData.path: ./personal-data`，相对于 `/data/system.yaml` 解析后就是 `/data/personal-data`；Compose 的 `/data` bind mount 会在容器重建后保留该仓库及 `.git` 历史。

从旧配置升级时不自动搬运未知文件。只有旧 Knowledge root 已经是 Git 仓库，并且新三目录结构已完整存在时，配置才可以安全重写为 Personal Data root 与其内部 Knowledge path；否则先按明确迁移步骤整理并备份原数据。

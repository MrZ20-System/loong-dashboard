# Git 与 PR 工作区

## 内容读取链路

[Server diff.ts](../apps/server/src/diff.ts) 通过 [LocalGitWorkspace](../packages/git-workspace/src/local-git-workspace.ts) 准备 PR revision、计算 merge-base、读取变更和文件。prepare 在所需对象不足时执行受控 fetch；不会用 GitHub 正文 API 代替本地 Git 内容。

文件读取使用指定 ref 和路径，并保留 Git 文件字节语义。重命名路径、二进制及大文件有显式表示；[diff-types.ts](../packages/git-workspace/src/diff-types.ts) 当前将超过 5 MiB 的文件标为 tooLarge，content 为 null。文件树对应选定 ref，全文件视图可读取未修改文件。

[Server 文件缓存](../apps/server/src/file-content-cache.ts) 与 [Web 文件缓存](../apps/web/src/pr-file-cache.ts) 服务于反复阅读；修改缓存键或 revision 传递时要检查切换 PR/head 后不会复用旧内容。`local-command` 端点只生成供复制的命令，不执行用户命令。

## Worktree 分配

[WorktreePool](../packages/git-workspace/src/worktree-pool.ts) 管理 `.worktrees/<repository-key>/slot-NN` 的 detached worktree。当前选择次序：

1. 同一 PR 且实际 HEAD 等于目标的非 busy slot，原位复用。
2. 同 PR 的可用 slot；若需切换 revision，必须 clean。
3. 创建下一个空 slot。
4. 回收尚未绑定数据库记录的 clean、非 busy slot。
5. 按数据库 last-used 排序回收 clean、非 busy 的 LRU slot。

Git revision/cleanliness 在一次选择过程中缓存，数据库记录 affinity、target 和 last-used。原位复用无需 reset，因此不能把“dirty 不回收”理解为“dirty 一律不能复用”。切换和回收使用 `reset --hard`、`clean -fd`，不删除 ignored 文件；cleanliness 检查失败必须在破坏性命令前抛错。池耗尽返回明确错误。

PR 会话在每个 turn 前核对 workspace revision；显式 Sync workspace 先停止该会话 DSH，再切换 worktree。聊天与调度共享 workspace 互斥，见 [Agent](dsh-integration.md)。

## 维护入口

Git 命令执行与错误类型在 [git-command.ts](../packages/git-workspace/src/git-command.ts)；slot 持久化由 Server 调用 database 包完成，Git 包不写 SQL。Knowledge 的 Git 提交另走 [checkpoint.ts](../packages/git-workspace/src/checkpoint.ts)。改变回收逻辑时重点覆盖 dirty、busy、Git 检查失败及同 PR revision 切换，不将缓存目录名作为可任意清空的授权。

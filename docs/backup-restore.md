# Backup and Restore

LoongBoard 的持久状态分布在配置文件、运行 state、Knowledge 仓库和可选的 Agent Archive。重大升级、迁移 data directory 或修改 storage 前，先停止 native Server 或 Docker container，确认没有写入，再备份。

## 必须保留

备份整个 data root（native 中是 `system.yaml` 所在目录下由 YAML 指定的路径集合；Docker 中通常是宿主机 `$LOONGBOARD_DATA_DIR`），至少保留：

- `system.yaml`：运行配置和 repository 路径。
- `runtime.statePath/loongboard.sqlite3`：索引、消息、任务、版本和同步状态。
- `runtime.statePath/agent-sessions/`：各 Agent session 的 runtime home。
- `runtime.statePath/github-credential.json` 和 `runtime.statePath/provider-secrets/`：敏感凭证，恢复时保持文件权限并限制访问。
- `system workspace/settings.json`、`domains/`、`prompts/`：控制中心设置、Domain 源文件和 update prompt。
- `knowledge.path`：Markdown 文件及其 Knowledge Git 历史。
- 独立配置的 Agent Archive repository/path（如果启用）。

SQLite 正在写入时不能把单个 `.sqlite3` 文件的在线 `cp` 当作安全备份。最简单的安全边界是停止服务后复制整个 data root；需要在线快照时，应使用已验证的文件系统快照机制，并由操作者确认一致性。

## 可以重建

以下内容通常可由源码、依赖安装或配置重建，但重建前仍应确认没有用户改动：

- `node_modules/`、`.pnpm-store/`、`dist/`：重新安装依赖或运行 build。
- `runtime.worktreesPath` 中没有 busy/dirty 内容的 PR worktree 缓存：删除后可由后续会话重新准备。
- Docker image/container：从同一 Git revision 和 lockfile 重新构建。

Worktree 不是持久聊天或知识数据；如果其中有未提交用户工作，不得按缓存删除。

## Native backup

停止服务后，将配置文件、YAML 指定的 state/knowledge 路径和独立 archive repository 一并复制到备份介质。推荐使用保留权限和目录结构的归档工具：

```bash
tar -C "$BACKUP_SOURCE" -czf "$BACKUP_FILE" .
```

其中 `BACKUP_SOURCE` 必须是已经停止写入的 data root，`BACKUP_FILE` 必须位于 data root 之外。不要在服务运行时执行上述归档，也不要只备份 `knowledge.path` 来声称可以恢复 Agent transcript。

## Docker backup

先停止容器，保留宿主机 data directory：

```bash
docker compose stop
export BACKUP_SOURCE="${LOONGBOARD_DATA_DIR:-./loongboard-data}"
export BACKUP_FILE="$PWD/loongboard-data-backup.tar.gz"
tar -C "$BACKUP_SOURCE" -czf "$BACKUP_FILE" .
docker compose start
```

`docker compose down` 也不会删除 bind-mounted data directory，但备份过程中仍应保持服务停止。备份文件包含敏感 credential/provider secret，必须按敏感资料保护。

## Restore

1. 停止 native Server 或 Docker container。
2. 先把当前 data root 移到安全位置或制作另一份离线备份。
3. 将备份恢复到目标 data root，保持 `system.yaml`、state、Knowledge 和 archive 的目录结构与权限。
4. 检查 `system.yaml` 中的相对路径是否仍指向当前 data root；Docker 配置应继续使用 `/data/system.yaml`，native 配置则按 YAML 所在目录解析。
5. 启动服务，让数据库执行已有有序迁移；观察日志和 `/api/health`。
6. 验证 Knowledge、Agent session、Settings、同步状态和 archive，再恢复正常写入。

恢复不会自动重新创建外部 GitHub 凭证、远端 repository 或 Docker volume 之外的本地 repository。不要运行 `git init` 覆盖已有 Knowledge 或 archive Git 历史；如果目标 Git 仓库缺失，应先恢复其完整 `.git` 目录或按部署流程重新配置。

## Upgrade checkpoint

重大版本升级前：停止写入、备份完整 data root、记录当前 Git revision 和配置文件 checksum。升级后先做只读启动和健康检查，再执行同步或 Agent 写入。若需要回滚代码，优先恢复与该 revision 匹配的 data root 备份，不要删除当前 data root 试错。

# LoongBoard

LoongBoard 是本地优先、单用户的工程工作台：GitHub PR/Issue 活动、本地 Git diff、DSH Agent 对话、Markdown 知识库与定时任务集中在一个界面中。

## What

应用由 React/Vite 前端和 Fastify 本地服务组成。开发时两者分别运行；生产时 `pnpm start` 由 Fastify 同时提供 API、SSE 和已构建的 React 静态文件。运行数据、知识库和 worktree 路径都由 `system.yaml` 决定，不写入代码仓库。

## Quick Start: Native

在应用仓库根目录执行：

```bash
pnpm install
cp system.example.yaml ../system.yaml
$EDITOR ../system.yaml
pnpm dev
```

开发服务默认监听 `127.0.0.1:4174`，Vite 默认监听 `127.0.0.1:5173`。浏览器打开 <http://127.0.0.1:5173>。

生产构建使用同一份构建产物：

```bash
pnpm build
pnpm start
```

生产 Server 默认监听 YAML 中的 `runtime.serverHost`/`runtime.serverPort`（示例为 `127.0.0.1:4174`），并托管 `/`、`/agent`、`/repositories/...`、`/settings` 等前端 deep link；未匹配的 `/api/*` 仍返回 JSON 404。

## Quick Start: Docker

先在宿主机准备 data directory 和配置；不要把真实配置、token、SSH key 或本地 runtime 文件复制进镜像：

```bash
export LOONGBOARD_DATA_DIR="$PWD/loongboard-data"
mkdir -p "$LOONGBOARD_DATA_DIR"
cp system.example.yaml "$LOONGBOARD_DATA_DIR/system.yaml"
$EDITOR "$LOONGBOARD_DATA_DIR/system.yaml"
docker compose up -d --build
```

Compose 将 `${LOONGBOARD_DATA_DIR:-./loongboard-data}` 挂载为容器 `/data`，并读取 `/data/system.yaml`。因此配置中的相对 `knowledge.path`、`runtime.statePath` 和 `runtime.worktreesPath` 都相对 `/data` 解析。Compose 设置 `LOONGBOARD_SERVER_HOST=0.0.0.0`、端口 `4174`，宿主机仍只通过 `127.0.0.1:4174` 暴露服务。

镜像内包含 Node、Git 和 CA certificates；这些不需要宿主机挂载。GitHub 凭证应通过 Settings 保存，或在运行容器时显式提供 `GH_TOKEN`/`GITHUB_TOKEN`。宿主机的 `gh` 登录状态不会自动进入容器。镜像不 COPY SSH key、token 或凭证文件；如需额外凭证挂载，应使用本地 compose override，并保持只读和不入镜像。

查看日志或停止容器：

```bash
docker compose logs -f loongboard
docker compose down
```

`down` 不会删除宿主机 data directory。首次启动前必须确认 `$LOONGBOARD_DATA_DIR/system.yaml` 存在且仓库路径对容器可访问。

## First Run

1. 修改 `system.yaml` 中的 repositories、knowledge 和 runtime 路径。
2. 启动后在 Settings 配置 GitHub 凭证、Agent 默认值和需要的计划任务。
3. 确认 GitHub provider 能访问目标仓库，再执行首次同步。

没有 GitHub token 时，native 环境可使用已认证的 `gh`；Docker 环境优先使用 Settings token 或显式环境变量，因为镜像不依赖宿主机的 `gh` 配置。

## Data Directory

`system.yaml` 所在目录决定所有 YAML 相对路径。通常需要保留：

- `knowledge.path`：Markdown 和知识 Git 仓库。
- `runtime.statePath`：SQLite、Agent session、GitHub credential、provider secrets、Settings 相关运行状态。
- `runtime.worktreesPath`：PR worktree 缓存。
- `system workspace/settings.json`、`domains/`、`prompts/`：非秘密 Settings、Domain 源文件和 update prompt。
- 独立配置的 Agent Archive repository/path。

`node_modules`、`dist`、`.pnpm-store` 和可安全重建的 worktree 缓存不属于代码提交内容。备份和恢复请看 [Backup and Restore](docs/backup-restore.md)。

## Update

Native 更新前停止服务，然后在应用仓库执行：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Docker 更新前停止容器，保留 data directory，再重新构建：

```bash
docker compose down
docker compose up -d --build
```

重大升级前先停止写入并备份整个 data directory。不要用删除 `.loong` 或 data directory 作为普通排错步骤。

## Backup

备份前停止 native Server 或 Docker container，保留整个 data directory 及独立的 Agent Archive repository。不要把正在写入的 SQLite 文件当作安全的在线 `cp` 快照；操作步骤见 [Backup and Restore](docs/backup-restore.md)。

## Development

修改代码前阅读 [AGENTS.md](AGENTS.md) 和目标模块的就近指引。仓库说明书 [docs/README.md](docs/README.md) 是架构、API、数据库、Agent、Knowledge、调度和运行测试的统一入口。

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm check` 还包含 lint、架构/DSH pin 检查和 UT；关键回归另用 `pnpm test:regression`。

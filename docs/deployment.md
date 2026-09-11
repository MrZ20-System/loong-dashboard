# 部署

LoongBoard 的部署产物只有一套：`pnpm build` 生成 workspace packages、Server 和 React 静态文件，`pnpm start` 以普通 Node 进程启动 Fastify。Docker 使用同一份 `pnpm start` 产物，不运行 Vite 或 `tsx watch`。

## Native production

在应用仓库根目录准备 `system.yaml`。默认查找位置是应用仓库的父目录；如果使用自定义位置，设置 `LOONGBOARD_SYSTEM_CONFIG`，其相对路径相对应用仓库根目录解析。YAML 内所有相对路径则相对 YAML 文件所在目录解析。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Server 默认使用 YAML 中的 `runtime.serverHost` 和 `runtime.serverPort`。示例配置监听 `127.0.0.1:4174`。生产 Fastify 同时提供 API、SSE、React 静态资源和 SPA deep link：`/`、`/agent`、`/repositories/...`、`/settings` 等非 API GET 路径返回 `apps/web/dist/index.html`；真实资产按文件提供；未匹配的 `/api/*` 保持 JSON 404。

如需容器式监听覆盖，可设置：

```bash
LOONGBOARD_SERVER_HOST=0.0.0.0 LOONGBOARD_SERVER_PORT=4174 pnpm start
```

覆盖只改变监听地址和端口，不改变 YAML 相对路径或数据目录。

## Docker Compose

先在宿主机创建 data directory，并把配置放在该目录中：

```bash
export LOONGBOARD_DATA_DIR="$PWD/loongboard-data"
mkdir -p "$LOONGBOARD_DATA_DIR"
cp system.example.yaml "$LOONGBOARD_DATA_DIR/system.yaml"
$EDITOR "$LOONGBOARD_DATA_DIR/system.yaml"
docker compose up -d --build
```

默认 Compose 配置：

- `${LOONGBOARD_DATA_DIR:-./loongboard-data}` 挂载到 `/data`。
- `LOONGBOARD_SYSTEM_CONFIG=/data/system.yaml`。
- `LOONGBOARD_SERVER_HOST=0.0.0.0`、`LOONGBOARD_SERVER_PORT=4174`。
- 宿主机只绑定 `127.0.0.1:4174:4174`。
- 容器使用 `restart: unless-stopped`。
- healthcheck 使用镜像内 Node 请求 `http://127.0.0.1:4174/api/health/live`，不依赖 curl/wget。

容器内 YAML 的相对路径相对 `/data`，所以 `./knowledge`、`./.loong`、`./.worktrees` 分别落在 `/data/knowledge`、`/data/.loong`、`/data/.worktrees`。首次启动前必须确认 `/data/system.yaml` 存在，并且其中配置的 repository path 对容器可访问。

镜像安装 Node、Git 和 CA certificates。宿主机不需要为这些组件提供挂载。GitHub 凭证通过 Settings 保存，或在启动容器时显式传入 `GH_TOKEN`/`GITHUB_TOKEN`；宿主机的 `gh` 登录状态不会自动进入容器。Dockerfile 不 COPY SSH key、token、`system.yaml`、`.loong`、knowledge 或 worktrees。Code backup 的 `repositoryPath` 和 `available` 由运行时从真实 code checkout 探测，不写入 SettingsDocumentV2；镜像 checkout 没有 `.git` 时 `available=false`，自动 checkpoint/push 会关闭，手工 Checkpoint now/Push now 会拒绝，并显示 `Code backup unavailable in container-image deployment.`。Code backup 的 policy 仍可保存，但不能开启必失败的自动任务。

Agent Archive 默认使用持久 data root 下的 `/data/agent-history`；用户明确保存的自定义 archive path 优先。容器重建不会删除宿主机 data directory，因此默认 archive 不会随容器层丢失。Settings 页面在 code backup unavailable 时仍可保存普通字段、路由字段和 Agent Archive 设置。

停止、启动和查看日志：

```bash
docker compose down
docker compose up -d
docker compose logs -f loongboard
```

`down` 不删除宿主机 data directory。

## Git credentials and local access

native 环境可使用已认证的 `gh` 作为 GitHub credential fallback；Docker 镜像不假设存在宿主机 `gh` 配置，因此应使用 Settings token 或显式环境变量。不要将 SSH key、GitHub token、provider secret 或 `github-credential.json` 写入镜像层或提交到仓库。

如果个人部署需要额外的 Git credential helper、企业 CA 或只读凭证挂载，应在本地 compose override 中显式声明，并确认它们不会进入镜像和版本库。默认 compose 只挂载 `/data`。

## Data and code boundary

生产代码和构建产物位于镜像或应用仓库；运行数据由 `system.yaml` 指定。必须持久化的内容包括 SQLite、Agent session、credential/provider secret 文件、Knowledge 仓库、Settings/Domain 文件和显式配置的 Agent Archive。`dist`、`node_modules` 和可重建的 worktree 缓存不是备份替代品。

升级前先停止写入并备份 data directory，再执行新的 build/start 或重新构建容器。SQLite 正在写入时的在线文件复制不作为安全备份方式，详见 [Backup and Restore](backup-restore.md)。

## Update

Native：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Docker：

```bash
docker compose down
docker compose up -d --build
```

两种方式都继续使用原 data directory；不要为了升级删除 `.loong`、knowledge 或整个 `/data`。

## Reset local password lock

`pnpm auth:reset` 运行的是 production build 中的 `apps/server/dist/auth-reset.js`，所以 native 环境必须先构建：

```bash
pnpm build
pnpm auth:reset
```

Docker 使用当前镜像和同一个 `/data` bind mount：

```bash
docker compose run --rm loongboard pnpm auth:reset
docker compose restart loongboard
```

如果 Server 正在运行，删除 `runtime.statePath/auth.json` 后必须重启 Server，才能让进程重新加载已删除的 auth 文件。reset 只处理这个精确文件，不触碰 SQLite、Knowledge、Agent session、Git 或 worktree。

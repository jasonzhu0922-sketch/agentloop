# CentOS 7 单机 Docker 部署

本目录交付的是一台 CentOS 7 Docker 主机上的完整单机服务端拓扑：一个 Router、两个 Runtime Host 和一个 Web。浏览器经 Web 的同源 `/api` 访问 Router；已安装在用户电脑上的 Local Runtime Agent 则直接连接 `PUBLIC_ROUTER_URL`，所以 Router 也必须有一个可从用户设备访问的公网入口。模型和 Skill 密钥只注入 Runtime Host。

它不是多机高可用方案：默认 SQLite 只能用于这台机器的本地 Docker 卷。要增加第二台 Router/Runtime 主机，先切换为独立的 Router/Runtime PostgreSQL 或 TiDB 数据库，并提供共享的附件、工作区和 Skill 存储；不能把 SQLite 放到 NFS/RWX。

CentOS 7 已停止维护，建议把它作为过渡宿主机。部署前确认 Docker Engine 与 Compose v2 能运行、CPU 架构为 `x86_64`、可用磁盘至少 30 GB、内存至少 8 GB（文档/PDF/浏览器类 Runtime 工作负载建议更多）。本包不会安装 Docker，也不会修改 firewalld；默认需允许 TCP 3001（Web）和 TCP 5001（Router）。Router 容器监听 `8788`，但宿主机将其发布为 `0.0.0.0:5001`，为浏览器无关的 API 客户端和 Local Runtime Agent 的 HTTP/WebSocket 控制通道提供独立入口。正式公网部署应由 Nginx/TLS 反代，并把 `PUBLIC_WEB_ORIGIN` 与 `PUBLIC_ROUTER_URL` 设为各自精确的 HTTPS 地址。

## 使用服务器本机 PostgreSQL

已有 PostgreSQL 适合替换默认 SQLite，但 Docker 容器不能使用 `127.0.0.1` 连接它；那会连接到容器自身。部署 Compose 已把 `host.docker.internal` 映射到 Docker host gateway。先由服务器管理员创建两个独立数据库（不要使用 `postgres` 管理库）：

```sql
CREATE DATABASE agentloop_router;
CREATE DATABASE agentloop_runtime;
```

建议另建最小权限服务账号后授予这两个库所有权。密码若包含 `@`、`:`、`/`、`?`、`#` 或 `%`，必须 URL 编码。然后在服务器的 `/opt/agentloop/.env` 中设置，文件权限保持 `600`：

```dotenv
AGENTLOOP_ROUTER_STATE_DRIVER=postgres
AGENTLOOP_ROUTER_STATE_DATABASE_URL=postgresql://agentloop:URL_ENCODED_PASSWORD@host.docker.internal:5432/agentloop_router
AGENTLOOP_RUNTIME_STATE_DRIVER=postgres
AGENTLOOP_RUNTIME_STATE_DATABASE_URL=postgresql://agentloop:URL_ENCODED_PASSWORD@host.docker.internal:5432/agentloop_runtime
```

`psql -h 127.0.0.1` 成功只证明宿主机回环连接有效，不能证明容器可连。PostgreSQL 必须监听 Docker gateway 可达的接口（通常设 `listen_addresses = '*'`，但防火墙不开放 5432 到公网），且 `pg_hba.conf` 必须只允许该 Docker 网络的 CIDR 使用该服务账号访问两库。修改后重载 PostgreSQL，并在 `deploy.sh up` 后以实际容器连接为准验证。Docker Engine 必须支持 `host-gateway`（20.10+）；旧版 CentOS Docker 要先升级 Engine，不能退回使用容器内 `127.0.0.1`。

## 方式 A：服务器拉取 Git 并构建

将仓库克隆为固定目录结构。部署配置位于 `/opt/agentloop`，代码在其下的 `repo`，以后 Git 更新不会覆盖密钥、工作区或 Docker 卷。

```bash
sudo mkdir -p /opt/agentloop
sudo chown "$USER" /opt/agentloop
git clone --branch main YOUR_GIT_URL /opt/agentloop/repo
cd /opt/agentloop/repo
AGENTLOOP_PUBLIC_HOST=47.101.178.145 \
  apps/agentloop-multi-runtime/deploy/centos7/deploy.sh init
```

编辑 `/opt/agentloop/.env`：`AGENTLOOP_PUBLIC_HOST=47.101.178.145` 初始化后 Web 默认就是 `http://47.101.178.145:3001/`（宿主机端口 3001）。检查 `PUBLIC_WEB_ORIGIN` 和预留的 `PUBLIC_ROUTER_URL`；编辑 `/opt/agentloop/secrets/runtime.env`，填写 `llm-providers.json` 中引用的 API Key。两个文件应保持 `600` 权限，绝不能提交到 Git。

```bash
apps/agentloop-multi-runtime/deploy/centos7/deploy.sh build
apps/agentloop-multi-runtime/deploy/centos7/deploy.sh up
```

`up` 会实际请求 Router `/healthz`、Web 首页和 Web 反向代理的 `/api/healthz`。三者通过才表示服务器内 Router 和浏览器→Web→Router 链路可用；在 Router 宿主机端口 5001 开放前，远程 Local Runtime Agent 尚不能配对。这不替代一次已配对 Local Agent 和一次带真实模型凭据的新 Run 验证。

更新代码时，在停止/重建前先审阅要升级的提交；配置并不在 Git 工作区：

```bash
git -C /opt/agentloop/repo pull --ff-only
/opt/agentloop/repo/apps/agentloop-multi-runtime/deploy/centos7/deploy.sh build
/opt/agentloop/repo/apps/agentloop-multi-runtime/deploy/centos7/deploy.sh up
```

若本版 `custom-skills.zip` 有更新，显式执行 `deploy.sh refresh-skills`。旧 Skills 会备份到 `/opt/agentloop/backups/`，然后使用当前 Compose 配置执行 `docker compose up -d --no-build --no-deps --force-recreate runtime-general-01 runtime-general-02`（带上对应的 `--project-directory`、`--env-file` 和 `-f` 参数，见生产手册）。普通 `up` 不保证 Runtime 重新加载 Skills。

## 可重复的离线增量发布

推荐始终在构建机上从 `main` 的精确提交制作不可变镜像；脚本会用 Git archive 隔离未提交的本地改动，默认 tag 为 `agentloop-multi-runtime:<12 位提交 SHA>`。BuildKit 缓存保存在 `.docker-build-cache/`：业务源码更新通常只重建应用及后续层；依赖 manifest、Dockerfile、基础镜像、构建参数或输入文件权限变化也可能使依赖/工具层失效。以构建日志中的 `CACHED` 为准。当前生产服务器的旧 Git 不支持脚本里的 `git -C`，在该主机上请采用生产手册的“本机导出，服务器缓存构建”流程。

```bash
cd /path/to/agentloop
git switch main
git pull --ff-only
apps/agentloop-multi-runtime/deploy/centos7/build-image.sh
scp agentloop-multi-runtime-<sha>.tar.gz \
  agentloop-multi-runtime-<sha>-deployment.tar.gz SERVER:/tmp/
```

若构建机不能访问 Docker Hub，可在构建命令前设置经验证的镜像地址，例如 `NODE_IMAGE=docker.1ms.run/library/node:26-bookworm`；若 Debian 或 Python 依赖源不可达，可设置 `APT_MIRROR=https://mirrors.aliyun.com/debian`、`PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/` 和 `PIP_FALLBACK_INDEX_URL=https://pypi.org/simple/`；若 Playwright 官方 CDN 不可达，可设置 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`。这些值会写入同版本 release manifest，保留构建来源审计。服务器本地 `deploy.sh build` 也接受相同的环境变量。

在服务器解开同版本部署包后，用单一 release 命令加载镜像、切换 `.env` 中的不可变 tag，并启动健康检查。若健康检查失败，脚本会恢复上一个 tag 并重新拉起此前服务；Docker 不会删除旧镜像或数据卷。

```bash
tar -C /opt/agentloop/release -xzf /tmp/agentloop-multi-runtime-<sha>-deployment.tar.gz
cd /opt/agentloop/release/agentloop-centos7-release
deploy/centos7/deploy.sh release \
  /tmp/agentloop-multi-runtime-<sha>.tar.gz \
  ./release-manifest.env
```

## 方式 B：离线镜像上传服务器（服务器无需 Git）

在与服务器同架构的构建机（通常为 x86_64）上运行。Apple Silicon 构建机默认交叉构建 `linux/amd64`；首次构建需要 Docker 能访问基础镜像、npm、apt、pip 所需源。

```bash
cd /path/to/agentloop
apps/agentloop-multi-runtime/deploy/centos7/build-image.sh /tmp/agentloop-centos7.tar.gz
scp /tmp/agentloop-centos7.tar.gz /tmp/agentloop-centos7-deployment.tar.gz SERVER:/tmp/
```

脚本会同时生成 Docker 镜像与同版本的部署包。部署包不含源码和密钥，但含 Compose、启动脚本、受版本控制的 Provider 配置样本及运行所需的 Skill 压缩包。`init` 仅在实际配置尚不存在时，才将该样本物化为服务器的可编辑 `config/llm-providers.json`；本机忽略配置不会进入包内。服务器无需访问 Git、npm、apt 或 pip。

```bash
sudo mkdir -p /opt/agentloop/release
sudo chown -R "$USER" /opt/agentloop
tar -C /opt/agentloop/release -xzf /tmp/agentloop-centos7-deployment.tar.gz
cd /opt/agentloop/release/agentloop-centos7-release
AGENTLOOP_PUBLIC_HOST=47.101.178.145 deploy/centos7/deploy.sh init
deploy/centos7/deploy.sh load-image /tmp/agentloop-centos7.tar.gz
deploy/centos7/deploy.sh up
```

镜像标签必须和 `/opt/agentloop/.env` 的 `MULTI_RUNTIME_IMAGE` 相同。`init` 的初始占位标签是 `agentloop-multi-runtime:centos7`，而 `build-image.sh` 默认生成提交 SHA 标签；推荐用 `deploy.sh release IMAGE_ARCHIVE RELEASE_MANIFEST` 从 manifest 选择正确标签，或在 `up` 前显式修改 `.env`。

## Local Runtime Agent 下载页

Web `/downloads` 公开展示安装包，设备识别仅标记推荐项，用户可以选择其他系统、架构或历史版本。公开接口 `GET /v1/local-agent/releases` 只返回发布元数据；设备配对及业务 API 保持认证。旧的 `/v1/local-agent/releases/latest` 仍需认证。

安装包独立于镜像，目录如下：

```text
/opt/agentloop/downloads/catalog/releases.json
/opt/agentloop/downloads/installers/<release-id>/<installer.pkg 或 installer.msi>
```

`deploy.sh init` 创建空清单及目录，已有清单不会被覆盖。升级旧部署时先运行新版 `init`，再更新 Web/Router；Compose 将 catalog **目录**挂载给 Router，将 installers 目录只读挂载给 Web。Router 使用 `LOCAL_AGENT_RELEASES_FILE=/run/local-agent-catalog/releases.json`，Web 使用 `LOCAL_AGENT_DOWNLOADS_DIR=/run/local-agent-installers`。目录挂载允许清单原子替换后立即生效，无需重建镜像或重启服务。

每次完成安装包构建后，在服务器上的源码目录执行（一次仅由一个发布进程更新清单）：

```bash
node scripts/publish-local-agent.mjs \
  --root /opt/agentloop/downloads \
  --installer /tmp/AgentLoop-Local-Runtime-0.1.0-macos-arm64.pkg \
  --platform darwin --arch arm64 --version 0.1.0 \
  --release-id 0_1_0-2638cf3 \
  --signature '应用为 ad-hoc 签名；安装包未签名、未公证' \
  --notes '首次提供 macOS Apple Silicon 安装包'
```

脚本验证 PKG/MSI 文件头、计算 SHA-256 和文件大小，将安装包复制到不可覆盖的版本路径，复核复制后的哈希，最后原子更新清单。已有同版本的不同内容不能覆盖，重新构建须发布新版本。Windows 使用 `--platform windows --arch x64` 及真实 `.msi` 文件；源码 ZIP 不可登记为安装包。

清单字段为 `version`、`protocolVersion`、`platform`、`arch`、`fileName`、`size`（字节）、`publishedAt`（带时区的 ISO 日期）、`downloadUrl`、`sha256`、`signature`（真实签名状态）、可选 `releaseNotes`。每个平台/架构/协议组合按发布时间确定当前版本，其余进入历史版本。缺少兼容版本的卡片显示“暂未发布”。清单内禁止真实密钥、设备信息和内部服务器路径。

`downloadUrl` 支持本站 `/downloads/local-agent/...` 路径或外部 HTTPS 地址。本站路径自然使用当前 Web 地址，例如 `http://47.101.178.145:3001/downloads/local-agent/...`，不影响 Router 的独立 `5001` 入口。外部 HTTPS 托管需正确配置文件下载响应头。Web 本站下载支持 GET、HEAD、单段 Range 和不可变缓存，只提供挂载目录内的 PKG/MSI 文件。

本地验证可把上述 `--root` 换成临时目录，并分别设置 Router 的 `LOCAL_AGENT_RELEASES_FILE` 和 Web 的 `LOCAL_AGENT_DOWNLOADS_DIR`。小规模部署也可继续使用 `LOCAL_AGENT_RELEASES_JSON`（相同字段），但不能与文件配置同时设置。

回滚时将 catalog 恢复为之前备份的有效 JSON，即可撤回当前推荐版本；版本文件保持原样，现有历史链接仍可用。上传后的 PKG/MSI 应保留并在登记后验证 HTTP 下载哈希和原生安装、启动、配对；登记清单本身不代表完成原生验收。

## 运维边界

- 不要执行 `docker compose down -v`：它会删除数据库/附件等命名卷。`deploy.sh` 故意没有提供该命令。
- `router-data` 保存 Router 附件与控制面数据，`runtime-state` 保存 Runtime 状态；升级前应由运维按卷进行备份。SQLite 方式的恢复是整组卷的一致性恢复。
- 当前 Router 已通过 Bearer 会话认证识别用户；浏览器登录后提交认证请求。公网入口仍应使用 TLS 保护凭据，并按实际需要配置访问控制和审计。
- `PUBLIC_WEB_ORIGIN` 与 `PUBLIC_ROUTER_URL` 若改成 HTTPS 域名，就填精确的 `https://domain`，不要保留 `SERVER_IP` 占位值。发布 macOS/Windows Local Agent 安装包时，将相同的 HTTPS Router 地址写入 `AGENTLOOP_ROUTER_URL_PRODUCTION`。

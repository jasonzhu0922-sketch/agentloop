# CentOS 7 单机 Docker 部署

本目录交付的是一台 CentOS 7 Docker 主机上的完整单机服务端拓扑：一个 Router、两个 Runtime Host 和一个 Web。浏览器经 Web 的同源 `/api` 访问 Router；已安装在用户电脑上的 Local Runtime Agent 则直接连接 `PUBLIC_ROUTER_URL`，所以 Router 也必须有一个可从用户设备访问的公网入口。模型和 Skill 密钥只注入 Runtime Host。

它不是多机高可用方案：默认 SQLite 只能用于这台机器的本地 Docker 卷。要增加第二台 Router/Runtime 主机，先切换为独立的 Router/Runtime PostgreSQL 或 TiDB 数据库，并提供共享的附件、工作区和 Skill 存储；不能把 SQLite 放到 NFS/RWX。

CentOS 7 已停止维护，建议把它作为过渡宿主机。部署前确认 Docker Engine 与 Compose v2 能运行、CPU 架构为 `x86_64`、可用磁盘至少 30 GB、内存至少 8 GB（文档/PDF/浏览器类 Runtime 工作负载建议更多）。本包不会安装 Docker，也不会修改 firewalld；默认仅需允许 TCP 80（Web）。Router 默认只绑定 `127.0.0.1:8788`；准备让 Local Runtime Agent 从用户设备配对时，先完成安全组/firewalld/HTTPS 策略，再将 `ROUTER_BIND_ADDRESS=0.0.0.0` 并开放 TCP 8788。正式公网部署应由 Nginx/TLS 反代：将 Web 和 Router 都绑定 `127.0.0.1`，并把 `PUBLIC_WEB_ORIGIN` 和 `PUBLIC_ROUTER_URL` 设为对应的 HTTPS 地址。

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

编辑 `/opt/agentloop/.env`：`AGENTLOOP_PUBLIC_HOST=47.101.178.145` 初始化后 Web 默认就是 `http://47.101.178.145/`（宿主机端口 80）。检查 `PUBLIC_WEB_ORIGIN` 和预留的 `PUBLIC_ROUTER_URL`；编辑 `/opt/agentloop/secrets/runtime.env`，填写 `llm-providers.json` 中引用的 API Key。两个文件应保持 `600` 权限，绝不能提交到 Git。

```bash
apps/agentloop-multi-runtime/deploy/centos7/deploy.sh build
apps/agentloop-multi-runtime/deploy/centos7/deploy.sh up
```

`up` 会实际请求 Router `/healthz`、Web 首页和 Web 反向代理的 `/api/healthz`。三者通过才表示服务器内 Router 和浏览器→Web→Router 链路可用；在 Router 8788 端口开放前，远程 Local Runtime Agent 尚不能配对。这不替代一次已配对 Local Agent 和一次带真实模型凭据的新 Run 验证。

更新代码时，在停止/重建前先审阅要升级的提交；配置并不在 Git 工作区：

```bash
git -C /opt/agentloop/repo pull --ff-only
/opt/agentloop/repo/apps/agentloop-multi-runtime/deploy/centos7/deploy.sh build
/opt/agentloop/repo/apps/agentloop-multi-runtime/deploy/centos7/deploy.sh up
```

若本版 `custom-skills.zip` 有更新，显式执行 `deploy.sh refresh-skills`。旧 Skills 会备份到 `/opt/agentloop/backups/`，然后重启 Runtime Host：`deploy.sh up`。

## 方式 B：离线镜像上传服务器（服务器无需 Git）

在与服务器同架构的构建机（通常为 x86_64）上运行。Apple Silicon 构建机默认交叉构建 `linux/amd64`；首次构建需要 Docker 能访问基础镜像、npm、apt、pip 所需源。

```bash
cd /path/to/agentloop
apps/agentloop-multi-runtime/deploy/centos7/build-image.sh /tmp/agentloop-centos7.tar.gz
scp /tmp/agentloop-centos7.tar.gz /tmp/agentloop-centos7-deployment.tar.gz SERVER:/tmp/
```

脚本会同时生成 Docker 镜像与同版本的部署包。部署包不含源码和密钥，但含 Compose、启动脚本、Provider 配置样本及运行所需的受版本控制 Skill 压缩包。服务器无需访问 Git、npm、apt 或 pip。

```bash
sudo mkdir -p /opt/agentloop/release
sudo chown -R "$USER" /opt/agentloop
tar -C /opt/agentloop/release -xzf /tmp/agentloop-centos7-deployment.tar.gz
cd /opt/agentloop/release/agentloop-centos7-release
AGENTLOOP_PUBLIC_HOST=47.101.178.145 deploy/centos7/deploy.sh init
deploy/centos7/deploy.sh load-image /tmp/agentloop-centos7.tar.gz
deploy/centos7/deploy.sh up
```

镜像标签必须和 `/opt/agentloop/.env` 的 `MULTI_RUNTIME_IMAGE` 相同；默认都是 `agentloop-multi-runtime:centos7`。

## 运维边界

- 不要执行 `docker compose down -v`：它会删除数据库/附件等命名卷。`deploy.sh` 故意没有提供该命令。
- `router-data` 保存 Router 附件与控制面数据，`runtime-state` 保存 Runtime 状态；升级前应由运维按卷进行备份。SQLite 方式的恢复是整组卷的一致性恢复。
- 当前 Web 的租户/用户头映射是演示身份适配，不能把裸露的 `5174`/`8788` 当作已有生产认证。正式公网开放前应在 TLS 反代或应用层接入真实认证、访问控制和审计。
- `PUBLIC_WEB_ORIGIN` 与 `PUBLIC_ROUTER_URL` 若改成 HTTPS 域名，就填精确的 `https://domain`，不要保留 `SERVER_IP` 占位值。发布 macOS/Windows Local Agent 安装包时，将相同的 HTTPS Router 地址写入 `AGENTLOOP_ROUTER_URL_PRODUCTION`。

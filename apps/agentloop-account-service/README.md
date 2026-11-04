# AgentLoop Account Service

Desktop 产品的独立云端账号服务，复用原 Multi Runtime 账号实现，**不需要启动 Router 或 Runtime Host**。源码位于本仓库，部署位置应为我们运营的云端服务；本机运行仅用于开发联调，不意味着正式服务已上线。

`@zhujun/agentloop-identity` 提供账号权威、HTTP 客户端和 Router 适配器。此服务只保存账号、个人 tenant、membership 和会话凭据摘要，不接受对话、Plan、Run、Evidence、文件、Connector 凭据或本机路径。

## 本机启动

需要 Node.js 26+ 和仓库依赖。首次检出先运行根目录 `npm install`、`npm run build:kernel`、`npm run build:identity`。

```sh
cd /Users/zhujun/coding/agentloop
npm run start:accounts
```

默认只监听 `127.0.0.1:8795`，数据库默认在此 workspace 的 `data/accounts.db`。根目录 `npm run start:accounts` 由本机管理器以前台方式启动；`npm run start:desktop` 会先安全重启该管理器登记的实例、等待 `/healthz` 就绪，再启动 Desktop。后台重启日志写入 `apps/agentloop-account-service/data/local-account-service.log`。启动不会载入 Multi Runtime 业务数据库或初始化 Kernel 业务表。可在此目录使用被 git 忽略的 `.env`（参考 `.env.example`），或注入环境变量：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `ACCOUNT_SERVICE_HOST` | `127.0.0.1` | 监听地址；默认只允许同机代理访问 |
| `ACCOUNT_SERVICE_PORT` | `8795` | 端口 |
| `ACCOUNT_SERVICE_DATABASE_PATH` | `data/accounts.db` | SQLite 持久化文件；生产必须使用独立绝对路径与受限目录 |

另一个终端启动 Desktop（根目录脚本已固定指向 `127.0.0.1:8795`）：

```sh
npm run start:desktop
```

## API 与凭据

| 方法与路径 | 能力 |
| --- | --- |
| `POST /v1/auth/register` | `{email,password}` 注册并签发会话，201 |
| `POST /v1/auth/login` | `{email,password}` 登录，200 |
| `GET /v1/auth/me` | Bearer 身份查询，200 |
| `POST /v1/auth/logout` | 撤销当前 Bearer 会话，204 |
| `GET /healthz` | 进程健康，非数据库/业务端到端验收 |

注册/登录返回 `{token,expiresAt,user:{id,email},tenant:{id}}`，邮箱规范化，密码 12 至 256 位，scrypt 哈希；服务仅保存 Token 的 SHA-256 哈希，会话默认 7 天。没有用户资料编辑、邮箱验证、找回密码、OAuth/PKCE 或刷新 Token 接口，不伪装这些功能已存在。

不开放 CORS，不发浏览器 cookie，不记录请求正文或凭据。Desktop 通过本机宿主转发认证，云端 Token 仅保留在宿主内存。不要把 Token/密码放在 URL、日志或仓库中。已有的会话撤销不撤销同账号其他独立会话。

## Multi Runtime 共用一个权威

Router 可设置 `IDENTITY_SERVICE_URL=https://accounts.your-domain.example`，然后重启 Router；Desktop 设置同一个基址。Router 的注册、登录、身份查询、退出将转发到独立服务，业务授权继续使用服务返回的 tenantId/userId，不接受用户伪造的身份。

Multi Runtime Router 现在必须配置此服务，不再回退到本地身份库。旧 Router 数据库中的身份行须在切换前停止 Router，并使用仓库提供的迁移命令复制到本服务；迁移保持用户 ID、密码哈希、租户、关系和会话不变，源库不删除，目标库冲突会失败。不要将 Router 业务库直接当成账号服务的数据文件，也不要重新注册同邮箱后声称旧会话与资源已迁移。

迁移 SQLite Router 身份库（先停止 Router 和 Account Service，并保留命令输出的备份路径）：

```sh
npm run migrate:router-identity --workspace agentloop-account-service -- \
  --source /absolute/path/to/apps/agentloop-multi-runtime/data/local/agentloop.db \
  --target /absolute/path/to/apps/agentloop-account-service/data/accounts.db
```

迁移完成后启动 Account Service，再启动 Router。迁移支持重复执行：目标库已有相同 ID 的账号/租户会复用，同邮箱账号会映射到目标账号；不兼容的 ID/会话冲突仍会 fail-closed。Router 会在启动迁移阶段确认本地 `mr_identity_*` 表已为空并移除它们；如果仍有本地账号，会 fail-closed，避免账号分叉。

## 云端部署边界

目前提供单进程 SQLite 服务，可在云服务器上从同一仓库构建并由进程管理器运行 `npm run start:accounts`，监听 loopback，由同机 HTTPS ingress 转发；公开接口只能走 TLS。生产数据库应放持久卷/受限目录，不用临时目录、NFS 或共享 RWX，不把运行数据打进镜像。限制服务账号权限，安排备份、恢复演练、监控与日志脱敏。

服务有请求体、超时、连接数、并发及进程级认证总量限制；这不是按账号/IP 的完整防滥用体系。正式开放注册前必须在 ingress 配置共享限流、请求体/连接超时、TLS 与滥用防护；当前不宣称多副本/HA、密码找回、邮箱验证或生产安全验收已完成。不要为联调把明文账号接口暴露到公网。

本批只完成源码及本机隔离验收，没有指定或部署真实云域名。测试：

```sh
npm run test:accounts
npm run test --workspace @zhujun/agentloop-identity
npm run test:desktop
node --test apps/agentloop-multi-runtime/tests/identity-account-service.test.ts
```

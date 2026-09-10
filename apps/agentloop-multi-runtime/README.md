# AgentLoop Multi Runtime

`agentloop-multi-runtime` 是一个可本地运行的多 Runtime 参考应用。完整部署有三个角色：

```text
Browser Web → Router API / 控制面 → Runtime Host A | Runtime Host B | Runtime Host N
```

- `web` 提供会话列表、新对话、模型选择、附件上传和 SSE 实时事件展示；不直连或选择 Runtime。
- `router` 承载会话入口、附件 broker 与 Assignment，选择一个 Host 并读取其 Run 状态。
- 每个 `runtime-host` 加载 `@zhujun/agentloop`，在共享状态库中完成一个完整 Run；所有 Host 共享一个任务工作区根目录。

Router 还可以作为应用集成与鉴权钩子的承载面：Host 通过受信任的 Router Tool Adapter 调用企业 API、MCP 或 Plugin，Router 据 Assignment/Run 上下文注入短期凭据并审计。工具调用的 Step 授权、Receipt、Evidence、Assessment 和 Outcome 仍留在 Host 的 AgentLoop 内核路径。

因此 Runtime 个数由部署副本决定：启动同一 Host 镜像多次，每个实例设置不同的 `RUNTIME_ID`，但 Router 与所有 Host 必须连接同一个状态库，并挂载同一个 `WORKSPACE_ROOT`。RunService 将任务目录固定为 `WORKSPACE_ROOT/conversations/<conversationId>`，故同一会话可复用目录、不同会话物理隔离。Router 通过 `runtimes.json` 或节点注册表知道可用实例。

已实现：持久 Assignment 与可过期槽位预留、静态节点配置加动态心跳、基于实际运行数的容量调度、Host 侧持久 `dispatchKey` 幂等、Host 容量准入、Router-owned 附件导入、Runtime 本地 Source 导入及 SHA-256 校验、Router/Host 私有 HTTP 协议、取消转发接口、Run 事件查询与 SSE 代理、会话式 Web 入口（会话列表、新对话、模型选择、Planner 与 SSE 事件面板），以及云端拒绝 `visibleDirectories`。它不拆分 Plan 或 Step，也不实现跨 Runtime 的 Run 迁移。

## 代码分层

```text
src/
├── domain/         跨进程协议和领域类型
├── config/         Runtime 配置解析与校验
├── control-plane/  Router 调度、Assignment 和控制面持久化
├── runtime/        Runtime Host 执行、资源导入和 dispatch 幂等
├── attachments/    Router-owned 附件存储与资源引用
├── http/           Router/Host HTTP 协议适配
└── entrypoints/    Router 与 Runtime Host 进程装配入口
config/             本应用的 Runtime/Provider 配置模板
```

各层通过 `domain/contracts.ts` 交换中立协议类型；HTTP 层不承载调度规则，入口层只负责依赖装配，Runtime Host 不依赖 Router 的控制面实现。

```bash
npm run typecheck --workspace agentloop-multi-runtime
npm run test --workspace agentloop-multi-runtime
```

## 本地启动

前置条件：根目录已执行 `npm install`；先复制 `config/llm-providers.example.json` 为 `config/llm-providers.json` 并按部署环境修改。两个 Runtime Host 都读取这份多 Runtime 自有的 Provider 配置。从本目录启动下列四个进程。示例中的两个共享令牌只适用于本地开发，生产应使用工作负载身份或 mTLS，并为每个环境独立配置密钥。

也可以从仓库根目录用一个命令启动 Router、Web 和指定数量的 Runtime Host。默认启动 2 个 Host。启动器默认读取 `apps/agentloop-multi-runtime/.env` 中 Provider 配置引用的环境变量（例如 `OPENAI_API_KEY`）；也可以用 `LLM_PROVIDER_ENV_FILE` 指定其他环境文件。Provider 密钥只注入 Runtime Host，不会注入 Router 或 Web：

```bash
npm run start:multi-runtime
npm run start:multi-runtime -- --runtimes 4
```

`--runtime-count 4`、`-n 4` 和 `RUNTIME_COUNT=4` 等价。Host 使用 `general-01` 起始的独立端口，默认共用 `data/local/agentloop.db` 与 `data/local/workspace`；可通过 `AGENTLOOP_STATE_*` 和 `RUNTIME_WORKSPACE_ROOT` 分别指向共享状态库与同一个已挂载的物理工作区。启动器先等待 Router 健康后才启动 Host，避免本地共享 SQLite/WAL 的初始化竞争。可用 `RUNTIME_BASE_PORT`、`PORT`、`WEB_PORT`、`PUBLIC_HOST`、`ROUTER_URL`、`LLM_PROVIDER_CONFIG_PATH` 和 `STEP_EXECUTION_STRATEGY_CONFIG_PATH` 覆盖默认值。`PUBLIC_HOST`/`ROUTER_URL` 用于浏览器访问 Router；当 `HOST=0.0.0.0` 时启动器默认向浏览器公布 `127.0.0.1`。按 `Ctrl-C` 会同时停止所有子进程。

### 存储模式切换

同一套 Router/Host 镜像仅靠环境变量切换状态后端；`WORKSPACE_ROOT` 始终是所有 Host 的同一 POSIX 目录，不会被对象存储替代。

| 模式 | 状态库 | workspace | 适用范围 |
|---|---|---|---|
| 本地开发 | `AGENTLOOP_STATE_DRIVER=sqlite`，一个共享 WAL 文件 | 本机目录 / Docker bind mount | 单机、低并发调试 |
| 生产 | `AGENTLOOP_STATE_DRIVER=postgres`，所有副本共用连接串 | RWX POSIX 卷（EFS、CephFS 或受控 NFS） | 多 Router、多 Host |

SQLite 不是多节点数据库：不要把它放到 NFS/RWX 卷。生产还应将附件、不可变交付物与 checkpoint 放入 S3 或兼容对象存储；活跃的 Tool 工作目录、临时文件和原子重命名仍留在共享 workspace。完整边界见[共享状态与故障接管设计](../../docs/MULTI-RUNTIME-SHARED-STATE-FAILOVER-DESIGN.md)。

### Step execution policy

每个 Runtime Host 在启动时从 `config/step-execution-strategy.json` 读取内置执行策略；默认已设为 `action-aware`。它根据当前证据和下一动作收缩可见工具，并保留必要的回执、诊断和产物引用。若需要为一组 Host 使用另一份策略文件，设置 `STEP_EXECUTION_STRATEGY_CONFIG_PATH` 并重启这些 Host；不会影响正在执行或已完成的 Run。

```json
{
  "schema": "agentloop.stepExecutionStrategyConfig/v1",
  "profile": "action-aware",
  "projection": {
    "diagnosticProjectionCharacters": 4096,
    "diagnosticPreviewCharacters": 1200,
    "terminalProjectionCharacters": 2048,
    "terminalPreviewCharacters": 800
  }
}
```

### Custom Skills

每个 Runtime Host 在启动时读取 `config/skill-directories.json`（可用 `SKILL_DIRECTORIES_CONFIG_PATH` 指向另一份应用配置），把 `customSkillDirectories` 与 `@zhujun/agentloop-skills` 的内置目录合并后调用内核的 `syncSkillDirectories()`。相对路径始终相对本应用根目录解析，不从 Router、浏览器请求或任务中接收本机路径。

默认配置把 `./custom-skills` 作为显式扩展目录；该目录中的内容不会被 Git 跟踪。配置目录可改为任何由每个 Host 可读的绝对路径或应用相对路径：

```json
{
  "schema": "agentloop.skillDirectories/v1",
  "customSkillDirectories": ["./custom-skills", "/srv/agentloop/team-skills"]
}
```

所有 Host 必须能读取同一组目录，否则 Router 的能力路由无法判断某个实例是否缺少某个 Skill；不存在目录、非法 Skill 包或跨目录重名都会在 Host 启动同步时明确失败。

```bash
# 终端 1：Router（默认读取 config/runtimes.json）
RUNTIME_DISPATCH_TOKEN=development-dispatch-token-123 \
RUNTIME_ATTACHMENT_TOKEN=development-attachment-token-123 \
CONTROL_PLANE_DATABASE_PATH=./data/control-plane.db \
WEB_ORIGIN=http://127.0.0.1:5174 \
npm run start --workspace agentloop-multi-runtime

# 终端 2：Runtime Host general-01
RUNTIME_ID=general-01 PORT=8791 \
ROUTER_URL=http://127.0.0.1:8788 MAX_CONCURRENT_RUNS=2 \
LLM_PROVIDER_CONFIG_PATH=./config/llm-providers.json \
STEP_EXECUTION_STRATEGY_CONFIG_PATH=./config/step-execution-strategy.json \
RUNTIME_DISPATCH_TOKEN=development-dispatch-token-123 \
RUNTIME_ATTACHMENT_TOKEN=development-attachment-token-123 \
npm run start:runtime-host --workspace agentloop-multi-runtime

# 终端 3：Runtime Host general-02（共享状态库与共享任务工作区）
RUNTIME_ID=general-02 PORT=8792 \
ROUTER_URL=http://127.0.0.1:8788 MAX_CONCURRENT_RUNS=2 \
LLM_PROVIDER_CONFIG_PATH=./config/llm-providers.json \
STEP_EXECUTION_STRATEGY_CONFIG_PATH=./config/step-execution-strategy.json \
RUNTIME_DISPATCH_TOKEN=development-dispatch-token-123 \
RUNTIME_ATTACHMENT_TOKEN=development-attachment-token-123 \
npm run start:runtime-host --workspace agentloop-multi-runtime

# 终端 4：前端
npm run start:web --workspace agentloop-multi-runtime
```

访问 [http://127.0.0.1:5174](http://127.0.0.1:5174)。Web 页面提供会话侧栏、对话流、Composer 和详情面板；左侧可以创建和切换会话。每次发送都会复用当前 `conversationId`，模型下拉只提交公开的 `requestedModelKey`，Planner 和 Run 事件通过 Router 的 SSE 代理实时展示。文件会先上传到 Router，再由被选 Host 导入为仅对该 Host 有效的 `sourceId`。

## Docker Compose：一条命令启动

[compose.yaml](compose.yaml) 定义一个 Router、两个同构 Runtime Host、一个 Web、由 Router 与所有 Host 共用的状态卷，以及一个由所有 Host 共同挂载的任务工作区目录。Docker 在 macOS 上需要一个 Linux 虚拟机；你已安装的 Colima 就是这个本地 Docker 引擎。Compose 则是把四个服务按配置一起启动的清单。

先复制并按机器路径检查本地配置。这个文件被 Git 忽略，允许填写本机路径和开发用服务令牌；它**不应包含**模型 API Key。

```bash
cp apps/agentloop-multi-runtime/.env.docker.example \
  apps/agentloop-multi-runtime/.env.docker
```

Provider 密钥单独放在多 Runtime 自己的环境文件中：

```bash
cp apps/agentloop-multi-runtime/.env.example \
  apps/agentloop-multi-runtime/.env
```

然后在该文件中填写 `OPENAI_API_KEY` 或配置文件中 `apiKeyEnv` 指定的变量。不要把密钥写入 `.env.docker`；`.env.docker` 只保存 Compose 路径和服务参数。

默认示例假设你已有单 Runtime 开发环境中的两个本地文件：

- `apps/agentloop-multi-runtime/config/llm-providers.json`：模型提供方的非密钥配置；会以只读方式挂载进两个 Runtime Host。
- `apps/agentloop-multi-runtime/.env`：该配置所引用的 API Key 环境变量；只注入两个 Runtime Host，绝不会注入 Router 或 Web。

基础镜像使用官方名称 `node:26-bookworm`，实际下载地址由 Colima 的 `docker.registry-mirrors` 决定。如果网络不能访问 Docker Hub，应在 Colima 中配置阿里云或企业批准的镜像加速器；不要把加速器地址拼进 `NODE_IMAGE`。受控生产环境应改用企业内部镜像仓库。

`.env.docker` 中的 `DOCKER_BUILD_*_PROXY` 只用于 `npm ci` 构建阶段；它让 Dockerfile 内的依赖安装复用 Clash HTTP/Mixed 端口，不会作为 `ENV` 写入最终应用镜像。若使用公司内网且不需要代理，可将这三个值留空。

`RUNTIME_WORKSPACE_HOST_PATH` 是所有 Runtime Host 的共享挂载源。生产部署时将它设置为同一块已挂载的物理目录或 POSIX 共享存储；不要为不同 Host 配置不同路径。Host 内部统一使用 `/app/apps/agentloop-multi-runtime/workspace`，内核再按 `conversations/<conversationId>` 隔离会话。

`CUSTOM_SKILLS_HOST_PATH` 同样必须指向每个 Runtime Host 共享的同一份扩展 Skill 根目录。Compose 将它以只读方式挂载到容器内的 `./custom-skills`，与默认 `config/skill-directories.json` 对应；如改用其他容器路径，请同步修改该 JSON 配置。不要把该目录烘焙进镜像或从浏览器上传为“全局 Skill”。

`NPM_REGISTRY` 默认使用阿里云公共 npm 镜像（npmmirror）`https://registry.npmmirror.com`，并在 `npm ci` 命令和安装前配置中同时显式指定该地址；安装完成后会删除临时 npm registry 配置。公司有内部 npm 仓库时，只需把这个变量替换为内部地址。

之后从仓库根目录执行：

```bash
docker compose \
  --env-file apps/agentloop-multi-runtime/.env.docker \
  -f apps/agentloop-multi-runtime/compose.yaml \
  up --build
```

首次运行会构建镜像并安装依赖；构建阶段会输出 npm 下载进度。浏览器访问 [http://127.0.0.1:5174](http://127.0.0.1:5174)，Router 健康检查为 [http://127.0.0.1:8788/healthz](http://127.0.0.1:8788/healthz)。停止服务使用 `Ctrl-C`；如需后台运行，可把最后一行换成 `up --build -d`，日志用同一命令加 `logs -f` 查看。

四个服务复用同一个 `agentloop-multi-runtime:local` 镜像，Compose 只会构建一次；避免在不带 Buildx 的本地 Docker 上并行下载四次相同的 Node 基础镜像。若输出长期只重复 `Pulling fs layer` 且没有出现 `Download complete` 或 `Pull complete`，可先 `Ctrl-C` 中断（不会删除卷），再确认 `docker pull $NODE_IMAGE` 能完成后重新运行。

真实部署应通过 Secret manager 注入 Provider 配置和服务身份，而不是把这些值提交到仓库。这里的 `RUNTIME_*_TOKEN` 仅适合本地开发，生产中应替换为工作负载身份或 mTLS。

本地开发界面中的租户/用户输入会被映射为 `x-tenant-id` 与 `x-user-id` 请求头，仅用于演示身份适配；它不是生产认证。Runtime 下拉框读取 Router 静态节点的具体实例 ID，例如 `general-01`、`general-02`；选择“自动”时由 Router 均衡调度，显式选择某实例时只在该实例有可预留容量时提交，不存在的实例会明确报错。Router 只选择未过期、`ready`、capability 匹配且未满的节点，并在同一事务中创建 Task、Assignment 和 30 秒可过期预留。评分是 `(activeRuns + pendingAdmissions + 0.5 × queuedRuns) / maxConcurrentRuns`；Host 仍会按自己已接受且正在运行的 Run 执行容量准入。`reserved` 不形成会话绑定；只有 Host 返回 `remoteRunId` 后才成为 affinity 候选。后续新 Run 优先健康的原 Host，原 Host 失联、draining 或满载时会迁移到下一台兼容 Host，并写入迁移审计记录。

Router 提供可断线续读的事件查询以及 `GET /v1/assignments/:assignmentId/events/stream` SSE 代理；事件权威仍在共享状态库的持久 Run event log，浏览器绝不直连 Host。当前已实现的是“下一新 Run”的健康 affinity 降级；执行中的 Run 的自动接管仍需要 Run lease、fence 与按 Action receipt 的安全恢复，尚未声明完成。Compose 是本地/单机骨架；生产应替换为 PostgreSQL、对象存储和 RWX workspace。设计见[共享状态与故障接管设计](../../docs/MULTI-RUNTIME-SHARED-STATE-FAILOVER-DESIGN.md)。

# AgentLoop Multi Runtime

![AgentLoop Web 登录页：云端与本机统一 Runtime 工作台](../../docs/assets/multi-runtime-web-local-login.png)

`agentloop-multi-runtime` 有三个独立发布、独立扩缩容的云端部署角色；本地启动器只是同时启动它们的开发便利工具：

```text
Browser Web → Router API / 控制面 → Runtime Host A | Runtime Host B | Runtime Host N
```

- `web` 是用户唯一的工作台：无论本次选择云端还是已配对设备上的本机 Runtime，用户都在同一会话列表、Composer、执行轨迹和产物工作区中完成操作。Web 只表达已选执行位置、数据策略和实际 Runtime，不自行成为第二个执行或状态权威。
- `router` 承载会话入口、附件 broker 与 Assignment，选择一个 Host 并读取其 Run 状态。
- 每个 `runtime-host` 加载 `@zhujun/agentloop`，在共享状态库中完成一个完整 Run；所有 Host 共享一个任务工作区根目录。

Router 还可以作为应用集成与鉴权钩子的承载面：Host 通过受信任的 Router Tool Adapter 调用企业 API、MCP 或 Plugin，Router 据 Assignment/Run 上下文注入短期凭据并审计。工具调用的 Step 授权、Receipt、Evidence、Assessment 和 Outcome 仍留在 Host 的 AgentLoop 内核路径。

因此 Runtime 个数由部署副本决定：启动同一 Host 镜像多次，每个实例设置不同的 `RUNTIME_ID`，但 Router 与所有 Host 必须连接同一个状态库，并挂载同一个 `WORKSPACE_ROOT`。RunService 将任务目录固定为 `WORKSPACE_ROOT/conversations/<conversationId>`，故同一会话可复用目录、不同会话物理隔离。Router 通过 `runtimes.json` 或节点注册表知道可用实例。

已实现：持久 Assignment 与可过期槽位预留、静态节点配置加动态心跳、基于实际运行数的容量调度、Host 侧持久 `dispatchKey` 幂等、Host 容量准入、Router-owned 附件导入、Runtime 本地 Source 导入及 SHA-256 校验、Router/Host 私有 HTTP 协议、取消转发接口、Run 事件查询与 SSE 代理、会话式 Web 入口（会话列表、新对话、模型选择、Planner 与 SSE 事件面板），以及云端拒绝 `visibleDirectories`。它不拆分 Plan 或 Step，也不实现跨 Runtime 的 Run 迁移。

## Web 的云端/本机一致性表达

Web 的“一致”是交互和可追溯性的一致，而不是把设备数据复制成云端数据。用户始终在同一个会话中发送消息、看到待上传文件、执行状态、事件、回复和产物；每条回复同时记录实际执行位置与 Runtime 身份。因此切换本机运行只影响**下一次**提交，不能把正在运行的云端 Run 改派到设备，也不能把本机 Run 迁移到云端。

```text
同一 Web 会话 / Composer / 回复卡片 / 产物工作区
             │
             ├─ 云端：Router Assignment → Cloud Runtime Host → Router SSE / 产物代理
             │         数据策略 cloud；附件是 Router-owned attachmentIds
             │
             └─ 本机：已配对的 Local Runtime Agent → 设备上的 Local Runtime
                       数据策略 local；目录授权和上传源由设备持有
```

这两条路径共享的是用户可见的交互模型，不共享数据归属：

- 云端提交只能使用 Router 管理的 `attachmentIds`；Router 解析资源引用，并将其交给获分配的 Cloud Runtime Host。
- 本机提交只能使用目标 Local Runtime 自己的 `localUploadedSourceIds` 与目录 scope。它们是 opaque ID，文件字节和绝对路径不穿过 Router；云端附件不能被本机 Runtime 隐式读取，本机上传也不能被云端 Runtime 隐式读取。
- Web 以每条回复记录的执行位置展示“云端”或“本机”，而不是依据当前开关倒推历史。Router 可用的本机 Run 通过受控连接投影状态、事件和产物；浏览器既不直连云端 Host，也不把 Local Agent 当作未鉴权的公共服务。

`local` 表示由已配对的设备 Runtime 执行、但仍可由 Router 完成身份、调度和受控状态投影；`strict_local` 是更强的 loopback-only 数据面，任务内容、Run 观察和取消均直接经过本机 Agent，不创建 Router Assignment。后者不能用“本机运行”开关自动替代，必须由明确的严格本地入口发起。无论哪种方式，Local Runtime Agent 的数据库、目录授权、工作区和上传源始终留在设备 SQLite/文件系统中。

## 代码分层

```text
web/                       唯一业务 Web 界面与同源 Router 代理
├── router-client.js       Router URL、Bearer 认证与 JSON 请求适配
├── local-agent-client.js  Loopback Agent 会话头、续期与 401 重试
├── session-state.js       登录身份与 Local Agent 会话凭据状态
├── local-runtime-state.js Local Agent/设备/Runtime 的浏览器状态
├── local-runtime-view-model.js 本机 Runtime 控件的纯视图投影
├── run-state.js            运行中任务、上传、取消与实时刷新协调状态
├── *-projection.js        Run/事件/产物的纯投影与展示数据转换
└── app.js                 页面状态协调、DOM 事件绑定与渲染
src/
├── shared/               Router 与 Cloud Runtime Host 共用的中立契约、配置与连接适配
├── router/
│   ├── transport/        用户、Host 与设备的 Router HTTP 接入
│   ├── application/      Assignment、任务提交构造、调度、状态观察与投影
│   ├── persistence/      Router 专属 schema、迁移与 Repository
│   ├── identity/         云端用户身份与会话
│   ├── devices/          Local Agent 注册和反向连接
│   ├── attachments/      云端附件与受控资源引用
│   └── artifacts/        云端产物目录与完整性收据
└── runtime-host/
    ├── transport/        仅 Router 信任的 Host HTTP 接入
    ├── application/      dispatch 适配、容量准入与运行前检查
    ├── persistence/      Runtime kernel 迁移与 Host dispatch ledger
    └── infrastructure/   Router 受控资源导入
local-agent-runtime/
└── src/
    ├── config/           设备启动和集成配置
    ├── transport/        loopback HTTP 协议解码、响应与错误映射
    ├── application/      Agent 用例、Runtime 工厂、Supervisor 与生命周期
    ├── persistence/      设备状态、目录授权等设备 SQLite/文件状态
    ├── infrastructure/   Router 反向连接与原生目录选择器
    └── observability/    多 Local Runtime 的终端日志
config/                   本应用的 Runtime/Provider 配置模板
```

Local Runtime Agent 没有独立的业务 Web 页面。它是设备侧后台服务和托盘程序：HTTP
协议、Runtime 生命周期、目录授权、设备本地 Run 与文件状态都在
`local-agent-runtime/src/`；托盘只负责启动、停止、重连提示和协议唤起。用户可见的
Runtime 选择、目录授权操作、执行状态和产物展示全部属于 `web/`，通过
`local-agent-client.js` 或 Router 的受控设备接口访问 Agent。这样不会形成第二套页面、
第二套身份状态或第二套业务路由。

`src/shared/contracts.ts` 是 Router 与 Cloud Runtime Host 唯一允许共享的版本化运行协议；HTTP 层只做协议解码、响应和错误映射，任务身份绑定、数据面校验和调度规则属于 application，`main.ts` 只负责依赖装配。测试会递归检查依赖闭包：Router 不得引入 `runtime-host/`，Host 不得引入 `router/`，Local Agent 不得依赖任一云端角色。新增跨角色能力必须先进入 `shared/` 的中立协议，不能以进程内 import 绕过边界。

```bash
npm run typecheck --workspace agentloop-multi-runtime
npm run test --workspace agentloop-multi-runtime       # Router / Host / DDL contracts
npm run test:full --workspace agentloop-multi-runtime  # extended Web and integration coverage
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
| 分布式 SQL | `AGENTLOOP_STATE_DRIVER=tidb`，所有 Router/云端 Host 共用连接串 | RWX POSIX 卷（EFS、CephFS 或受控 NFS） | TiDB/MySQL 方言部署 |

SQLite 不是多节点数据库：不要把它放到 NFS/RWX 卷。生产还应将附件、不可变交付物与 checkpoint 放入 S3 或兼容对象存储；活跃的 Tool 工作目录、临时文件和原子重命名仍留在共享 workspace。完整边界见[共享状态与故障接管设计](../../docs/MULTI-RUNTIME-SHARED-STATE-FAILOVER-DESIGN.md)。

`Local Runtime Agent` 不属于上述共享状态后端切换范围。Agent 的
`LOCAL_AGENT_DATABASE_PATH`、`LOCAL_AGENT_SUPERVISOR_DATABASE_PATH`、本地目录授权和
本地 Run 数据始终是设备上的 SQLite 文件；不要向该进程传递
`AGENTLOOP_STATE_*` 或云端 PostgreSQL/TiDB 凭据。设备注册和浏览器本地会话的云端记录仍
由 Router 的共享状态库保存。

### Local Runtime Agent 独立部署配置

Local Runtime Agent 的模型、联网搜索和 Skill 集成配置属于设备部署边界，不属于同步的 Skill 包，也不复用 Router/云端 Host 的 `.env`。开发模式从 `local-agent-runtime/.env` 与 `local-agent-runtime/config/llm-providers.json` 读取；已安装 Agent 首次启动会在设备数据目录创建 `agent-loop-runtime/.env.example`，运维应复制为同目录 `.env` 并以最小权限保存真实凭据。macOS 默认目录为 `~/Library/Application Support/AgentLoop Local Runtime/agent-loop-runtime/`，Windows 为 `%LOCALAPPDATA%\AgentLoop Local Runtime\agent-loop-runtime\`。该 `.env` 是 Local Agent 唯一的模型/联网搜索配置来源：例如 `OPENAI_API_KEY`、`MY_LLM_API_KEY`、`WEB_SEARCH_*` 均仅被 Agent 进程内集成读取；`mysql-steel-data` 与 `enterprise-info` 只收到同一文件路径并自行读取各自字段。凭据绝不写入 Skill 包、Planner、模型上下文或命令环境。受管部署可用 `LOCAL_AGENT_RUNTIME_CONFIG_ROOT`、`LOCAL_AGENT_RUNTIME_ENV_FILE` 或 `LOCAL_AGENT_PROVIDER_CONFIG_PATH` 覆盖路径。

Local Agent 的源码也作为独立部署单元位于 `local-agent-runtime/src/`；它只依赖共享内核包及 Multi Runtime 的中立配置/契约，Router 和云端 Runtime Host 入口仍保留在 `src/`。`start:local-agent`、本地启动器和 macOS/Windows 打包器都以此目录的 `main.ts` 为唯一入口。

### TiDB role databases

TiDB 中的 schema 即 database。生产或真实联调可将 Router 与云端 Runtime Host
分到两个 database：`agentloop_router` 保存身份、设备、附件、Assignment 与 Router
投影；`agentloop_runtime` 保存 Run、Plan、事件与 Host dispatch ledger。Router 经
受控 Runtime endpoint 读取 Run 状态，不直接跨库读 Host 的执行表。

```dotenv
AGENTLOOP_ROUTER_STATE_DRIVER=tidb
AGENTLOOP_ROUTER_STATE_DATABASE_URL=mysql://user:password@tidb:4000/agentloop_router
AGENTLOOP_RUNTIME_STATE_DRIVER=tidb
AGENTLOOP_RUNTIME_STATE_DATABASE_URL=mysql://user:password@tidb:4000/agentloop_runtime
```

未设置角色变量时，两类进程继续回退到 `AGENTLOOP_STATE_*`，便于现有单库 SQLite
开发。Local Runtime Agent 不读取以上任何变量。

Router 与 Runtime Host 会在启动、构造业务服务前分别应用其版本化迁移。每个逻辑
database 都有 `mr_schema_migrations(id, checksum, applied_at)`：已安装 migration 的
checksum 必须与当前代码一致，否则进程会拒绝继续启动。SQLite 旧库会先执行既有的
前向兼容升级，再写入当前基线；PostgreSQL/TiDB 从同一有序清单建库。迁移期间使用
SQLite 事务、PostgreSQL advisory transaction lock 或 TiDB advisory lock 串行化。

当前生产部署基线将附件元数据写入共享 PostgreSQL，并把不可变附件字节放在仅 Router 共享的 RWX 挂载；Host 始终经 Router 的受控下载接口读取附件，而不会拿到存储路径。对象存储 BlobStore 是下一步替换此挂载的演进点，不是已经宣称完成的能力。可直接使用 [Kubernetes 多主机部署清单](deploy/kubernetes/README.md) 构建并独立发布 `router`、`runtime-host`、`web` 三个镜像目标。

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

### Enterprise Info Broker 配置

Cloud `custom-skills/enterprise-info` 仅通过 Runtime Host 的受保护 integration broker 请求 `enterprise_info.search` 或 `enterprise_info.detail`。Skill 子进程只拿到一次性 socket permit；它不会读取 `.env`、endpoint、client ID、client secret 或 access token，也不会注册 `enterprise_info_query` Runtime Tool。

当 `RUNTIME_CONFIGURATION_SOURCE=control_plane` 时，Host 需要已认证的 delivery API、一个已确认的 `enterprise_info` binding（含 `search`/`detail` allowlist）以及部署侧 secret-provider adapter。缺少 binding、过期 grant 或不可用 provider 时会以稳定错误失败；不得回退到 `ENTERPRISE_INFO_ENV_FILE`。Local Agent 的旧路径由 WP-5 迁移，不能据此配置 Cloud Host。

WP-8 起，Cloud Host 与 Local Agent 的 source 默认是 `control_plane`；Provider、Skill directory、Step strategy、Practice Profile JSON 以及运行时 `.env` 不再作为 control-plane target 的权威来源。`RUNTIME_CONFIGURATION_SOURCE=file` 或 `LOCAL_RUNTIME_CONFIGURATION_SOURCE=file` 只用于明确的本地开发、安装 bootstrap 或受控 emergency rollback。

```bash
# 终端 1：Router（默认读取 config/runtimes.json）
RUNTIME_DISPATCH_TOKEN=development-dispatch-token-123 \
RUNTIME_ATTACHMENT_TOKEN=development-attachment-token-123 \
CONTROL_PLANE_DATABASE_PATH=./data/control-plane.db \
WEB_ORIGIN=http://127.0.0.1:5174 \
npm run start:router --workspace agentloop-multi-runtime

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

访问 [http://127.0.0.1:5174](http://127.0.0.1:5174)。Web 页面提供会话侧栏、对话流、Composer 和详情面板；左侧可以创建和切换会话。会话侧栏通过 Router 的 `GET /v1/conversations?limit=30&offset=...` 按最近活动时间倒序加载，首屏 30 条，点击“加载更多对话”后追加下一页 30 条；正常分页结果以 Router 为权威，localStorage 只在首屏接口失败时作为恢复缓存。首次点击分页加载的会话时，再通过 `GET /v1/conversations/:conversationId` 读取持久轮次索引，并按 Assignment 回放 Host 状态与事件形成完整对话流。每次发送都会复用当前 `conversationId`，模型下拉只提交公开的 `requestedModelKey`，Planner 和 Run 事件通过 Router 的 SSE 代理实时展示。

默认是云端路径：文件先上传到 Router，再由被选 Host 导入为仅对该 Host 有效的 `sourceId`。启用并配对 Local Runtime Agent 后，Web 在同一 Composer 中切换到指定的设备 Runtime；待上传文件会跟随该选择进入相应数据面。发送前 Web 会拒绝混用云端附件与本机上传源，也会拒绝把属于另一台 Local Runtime 的上传源提交给当前 Runtime。切换仅影响新消息，已有回复继续按其记录的执行位置恢复、展示与取消。

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

四个服务默认复用同一个 `agentloop-multi-runtime:runtime-baseline-local` 镜像，Compose 只会构建一次；直接执行 Compose 与 `npm run start:multi-runtime:docker` 选择相同标签。若输出长期只重复 `Pulling fs layer` 且没有出现 `Download complete` 或 `Pull complete`，可先 `Ctrl-C` 中断（不会删除卷），再确认 `docker pull $NODE_IMAGE` 能完成后重新运行。

真实部署应通过 Secret manager 注入 Provider 配置和服务身份，而不是把这些值提交到仓库。这里的 `RUNTIME_*_TOKEN` 仅适合本地开发，生产中应替换为工作负载身份或 mTLS。

本地开发界面中的租户/用户输入会被映射为 `x-tenant-id` 与 `x-user-id` 请求头，仅用于演示身份适配；它不是生产认证。Runtime 下拉框读取 Router 静态节点的具体实例 ID，例如 `general-01`、`general-02`；选择“自动”时由 Router 均衡调度，显式选择某实例时只在该实例有可预留容量时提交，不存在的实例会明确报错。Router 只选择未过期、`ready`、capability 匹配且未满的节点，并在同一事务中创建 Task、Assignment 和 30 秒可过期预留。评分是 `(activeRuns + pendingAdmissions + 0.5 × queuedRuns) / maxConcurrentRuns`；Host 仍会按自己已接受且正在运行的 Run 执行容量准入。`reserved` 不形成会话绑定；只有 Host 返回 `remoteRunId` 后才成为 affinity 候选。后续新 Run 优先健康的原 Host，原 Host 失联、draining 或满载时会迁移到下一台兼容 Host，并写入迁移审计记录。

Router 提供可断线续读的事件查询以及 `GET /v1/assignments/:assignmentId/events/stream` SSE 代理；事件权威仍在共享状态库的持久 Run event log，浏览器绝不直连 Host。当前已实现的是“下一新 Run”的健康 affinity 降级；执行中的 Run 的自动接管仍需要 Run lease、fence 与按 Action receipt 的安全恢复，尚未声明完成。Compose 是本地/单机骨架；生产应替换为 PostgreSQL、对象存储和 RWX workspace。设计见[共享状态与故障接管设计](../../docs/MULTI-RUNTIME-SHARED-STATE-FAILOVER-DESIGN.md)。

### 打包 Local Runtime Agent（macOS Apple Silicon）

Local Runtime Agent 优先使用 Node SEA 打包为后台可执行程序，配合一个很小的 Swift 托盘壳，不包含 Electron/Chromium。若构建机的 Node 二进制没有 SEA fuse（例如当前 Homebrew Node 26），打包器会自动改为随包携带 Node runtime 及其 macOS 动态库依赖；两种产物使用同一个 Agent bundle 和协议。打包命令会先构建 kernel 和 bundled Skills：

```bash
npm run package:local-agent:mac --workspace agentloop-multi-runtime
```

默认生成开发环境包，固定连接本地 Router。测试、生产环境的 Router/Web 地址必须在构建时注入，安装后用户不能修改：

```bash
AGENTLOOP_RELEASE_ENV=test \
AGENTLOOP_ROUTER_URL_TEST=https://router.test.example.com \
AGENTLOOP_WEB_ORIGIN_TEST=https://app.test.example.com \
npm run package:local-agent:mac --workspace agentloop-multi-runtime
```

生产包使用 `AGENTLOOP_RELEASE_ENV=production`、`AGENTLOOP_ROUTER_URL_PRODUCTION` 和 `AGENTLOOP_WEB_ORIGIN_PRODUCTION`。变量模板见 `distribution/macos/environments.example.env`。产物位于 `release/local-agent/macos-arm64/AgentLoop-Local-Runtime-<version>-macos-arm64.pkg`。未设置签名身份时，`.app` 使用 ad-hoc 签名且 `.pkg` 不签名，只适用于本地开发。正式分发应分别使用 Developer ID Application 和 Developer ID Installer 身份签名，并完成 notarize/staple；当前脚本中的 `APPLE_CODESIGN_IDENTITY` 只负责 app 内代码签名，尚未替代 installer 签名流程。

安装后 Agent 通过 macOS LaunchAgent 登录启动；托盘只提供在线状态、重连、打开 Web、查看日志和退出，业务配置仍由 Web 管理。Router 地址作为固定构建配置嵌入 Agent；Agent 的 bootstrap 文件仅作为安装器/运维迁移用途保留。

### 打包 Local Runtime Agent（Windows x64 MSI）

Windows 使用 WiX 生成 per-machine `.msi`，安装到 `Program Files`，注册 `agentloop-local-runtime://` 协议。协议唤起的原生 .NET 托盘壳会启动本机 Agent，并在首次运行时写入当前用户的登录自启项；业务配置仍只存在于 Web。它同样优先使用 Node SEA，无法注入时携带 Node fallback，不包含 Electron。

必须在 64 位 Windows 构建机上执行，并准备：Node 26、.NET 8 SDK、WiX Toolset v4（`wix` 在 `PATH` 中）。

```powershell
npm run package:local-agent:win
```

默认生成开发环境 MSI。测试、生产环境沿用同一组构建期固定地址变量：`AGENTLOOP_RELEASE_ENV`、`AGENTLOOP_ROUTER_URL_TEST`/`AGENTLOOP_ROUTER_URL_PRODUCTION`、`AGENTLOOP_WEB_ORIGIN_TEST`/`AGENTLOOP_WEB_ORIGIN_PRODUCTION`；模板见 `distribution/windows/environments.example.env`。产物为 `release/local-agent/windows-x64/AgentLoop-Local-Runtime-<version>-windows-x64.msi`。正式分发还应在 Windows 发布流水线中使用组织的代码签名证书分别签名 tray/Agent 可执行文件和 MSI，并运行 Windows 签名验证。

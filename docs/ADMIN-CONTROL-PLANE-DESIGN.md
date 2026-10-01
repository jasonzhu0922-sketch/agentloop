# AgentLoop 管理控制面整体设计

## 1. 结论与目标

管理端是独立发布、独立扩缩容的运营控制面，不是 `apps/agentloop-multi-runtime/web/` 的一个页面或 Router HTTP API 的附属路由。

它要让平台/租户管理员安全地管理共享 Provider、外部 Integration、Skill、动态策略、用户和 Runtime，并能追溯任一 Run 在 admission 时实际采用的配置版本。它不接管用户的对话交互、调度决策、Tool 授权、Evidence、Assessment 或 TerminalCommitter。

本设计的核心契约：

> 任一新 Run 都能以不可变事实回答：谁发布了什么配置、它为何对这个租户/Runtime 生效、目标是否已加载、最终使用的 Provider、Integration、Skill 与策略 release 是什么。

## 2. 现状与首个断点

目前 Cloud Runtime Host 与 Local Agent 在启动时分别读取 Provider、Skill directory、Step execution strategy 和 Practice Profile 文件。部分默认文件内容相同，部分只是开发目录中同一个路径；Provider 凭据与 Local Agent integration `.env` 又是分离的。文件修改、容器重启和本地安装包之间没有统一的 release、目标范围、应用回执或审计。

因此第一处需要修复的不是管理页面，而是**配置事实从部署文件到新 Run 的权威链路缺失**。管理端写数据库但 Host 仍读取旧 JSON，同样不构成动态配置。

## 3. 发布单元与代码隔离

所有新增代码保留在 `apps/agentloop-multi-runtime/`，但拆成独立的管理 API、管理前端和中立控制面模块。它们有各自的入口、构建、部署和依赖闭包；Admin 不 import `src/router/**`、`src/runtime-host/**` 或用户 `web/**` 的内部实现。

```text
apps/agentloop-multi-runtime/
  admin-api/                     # 独立进程：管理 API + workload configuration-delivery API
  admin-web/                     # 独立静态前端/服务器：只访问 Admin API
  control-plane/
    contracts/                    # 版本化 DTO、权限、release/receipt 契约；无 SQL/HTTP/UI
    domain/                       # release、scope、发布、审计、密钥引用等用例与 Port
  src/
    shared/                       # 既有 Router—Cloud Host 执行协议，不放管理对象
    router/ runtime-host/         # 既有用户面与云执行角色
  local-agent-runtime/            # 既有设备侧独立进程
```

允许的依赖方向：

```text
Admin Web ──HTTP──> Admin API ──> control-plane/domain ──> DB / secret / package ports
                                        ↑
Router / Cloud Host / Local Agent ── control-plane/contracts ──┘
```

- `admin-web/` 只含展示、表单校验、页面状态和 Admin API client；绝不访问数据库、Router 内部 HTTP 或 Local Agent loopback。
- `admin-api/` 分为 `transport -> application -> domain -> persistence/infrastructure`。HTTP handler 只鉴权、解码、响应；发布、授权、作用域求值和审计在 application/domain。
- Multi Runtime 通过 `control-plane/contracts/` 中的**中立契约**拉取所需 release；不能 import Admin API 的 service 或 repository。
- `shared/` 继续只服务 Router 与 Cloud Host 的运行协议。管理契约另建 package，避免把运营对象混入执行协议。
- `@zhujun/agentloop` 内核不得连接 Admin API、控制面数据库、secret provider 或设备服务；它只接受 Host/Local Agent 在 admission 前已解析、校验并冻结的运行环境快照。

## 4. 数据所有权与统一存储

“统一存储”指共享权威数据库与明确的数据所有权，不是所有应用可以任意读写彼此的表。

| 数据域 | 权威所有者 | 物理位置 | Admin 权限 |
|---|---|---|---|
| 用户、租户、成员资格、用户会话 | Identity domain | Router control-plane database | 通过 Identity Port 管理；不直接修改 session 表 |
| 用户会话、Task、Assignment、Turn、Runtime 节点及其投影 | Router | Router control-plane database | 只读 contract view；受控操作走 Router operation port |
| Run、Plan、Step、action、Evidence、Assessment、Outcome | Runtime Host | Runtime state database；Local 为设备 SQLite | 不跨库直写；经受控查询/投影读取 |
| Provider、Integration、Skill、Policy release、TargetAssignment、ApplyReceipt、Audit | Control-plane domain | 与 Router control-plane database 同一实例、独立 `cp_*` 表及迁移 | Admin API 写；Runtime/Agent 经 delivery contract 获取其已授权的有效配置 |
| 凭据明文 | Secret provider / 本机安全存储 | 不入普通业务表、不进浏览器 | Admin 只管理元数据、secret reference 与轮换 |
| Local 文件、目录 scope、本机 Run 源数据 | Local Agent | 设备 SQLite/文件系统 | 不同步；Admin 仅查看脱敏状态和回执 |

初期可将 `cp_*` 与 `mr_*` 放在同一个 PostgreSQL/TiDB database，以保留事务、租户 FK 和低延迟查询；迁移登记和表 owner 必须按 bounded context 分开。Admin API 使用专用数据库角色：可写 `cp_*`、经受控 Port 写 Identity、对 `mr_*`/Runtime projection 仅 `SELECT`。不得用 Admin 账号写 `mr_tasks`、`mr_assignments`、Run/Plan/Event 表。

Admin 的会话追踪使用 Router/Runtime 已持久化事实，呈现：

```text
Conversation → Task → Assignment → Runtime Run → Plan / actions / events / evidence
             → Assessment → TerminalCommitter → Outcome
```

缺少任一链路时显示“未投影/无权限/目标离线”，不能由 UI 推断 completed 或伪造执行数据。

## 5. 配置模型

所有可运营对象采用共同的不可变 release 模型：

```text
Resource (稳定 ID)
  └─ Release (递增版本、content hash、author、createdAt、schema version)
       └─ TargetAssignment (scope、优先级、rollout 状态)
            └─ ApplyReceipt (目标、release、hash、loaded/failed、observedAt、reason)
```

发布状态为：`draft -> validated -> observe/canary -> active -> superseded | rolled_back | retired`。

`active` 只表示 control plane 的 desired state；只有目标已产生 `ApplyReceipt(loaded)` 才可称为已生效。已有 Run 永远保留 admission 时解析出的 release/digest，不因后续发布改变。

### 5.1 Scope

每个 `TargetAssignment` 显式包含：

```text
plane: cloud | local | both
target: platform | tenant | runtime_class | runtime_id | device_id
```

求值顺序固定为：平台基线 < plane 基线 < tenant < runtime class < runtime/device；同层使用 priority，冲突拒绝发布而不是静默覆盖。不可跨 tenant 泄露配置或凭据。

### 5.2 Integration 与 Provider

Provider、MCP、Web Search、企业信息和其他数据源统一归入 `Integration`，而不是分别维护散落的环境变量配置。

```text
IntegrationDefinition       # provider / mcp / search / data_source 等类型与公开元数据
IntegrationRelease          # endpoint、协议、超时、重试、能力、策略，含 content hash
CredentialReference         # secret provider、版本、轮换状态；无明文
IntegrationBinding          # release + scope + credential reference + egress/capability policy
ModelRouteRelease           # model key -> Provider binding 与模型参数
```

Provider 和 Model Route 是平台共享的逻辑配置。Cloud 与 Local 可以使用同一 release，但 Binding 必须分别定义：端点可按 plane 覆盖，凭据也可使用不同 secret version。若确实需要同一组织凭据，Local Agent 仅经已注册设备获得短期或设备公钥加密的 secret envelope，并写入系统安全存储；Router、浏览器、Run snapshot 和 audit 都不得包含明文。

### 5.3 Skill

```text
SkillRelease = manifest + package digest + signer + compatibility + required integrations
SkillAssignment = scope + enabled + approved release
SkillInstallReceipt = target + release/digest + downloaded/verified/loaded/failed
```

- 内核 Skill 随 Cloud Host/Local Agent 安装包发布，登记为只读 baseline release。
- 可下载 Skill 必须有不可变包、签名、digest、兼容性和审批记录；控制面发布“允许哪个目标安装何版本”，不是向设备推送任意代码。
- Local Agent 可自行拉取、验签、安装到自己的 package store，并报回 install/load receipt；设备未确认加载前，不得把 Skill 视作可调度能力。
- Skill 发布不增加 Tool 权限，也不绕过 Runtime 的 Plan Step、Evidence、Assessment 或 completion 规则。

### 5.4 Policy

Practice Profile、Step Execution Strategy、Plan Template policy 和未来的准入策略作为独立 `PolicyRelease` 类型，共用发布/回滚/receipt 内核。策略只能影响其声明的语义，不可授予 Tool、传递 secret、改变 Runtime evidence 或直接声明完成。

## 6. 生效与执行链路

```text
管理员发布 release
  → Admin API 校验 schema、scope、依赖、权限与 secret reference
  → 写 cp_* release / assignment / audit（事务）
  → Cloud Host 或 Local Agent 认证拉取 desired config
  → 校验 schema、签名、包 digest、设备/plane scope
  → 安全加载或为下一个 admission 预热
  → 回传 ApplyReceipt
  → 新 Run admission 解析 effective config，并固化 release/digest 集合
```

首次版本采用 pull + receipt，不要求任意进程常驻推送通道。Cloud Host 可在 heartbeat 或配置 TTL 到期时拉取；Local Agent 在已认证的 Router/设备连接上拉取。配置切换只影响**后续 admission**；不重写在途 Run 的 `RunService`、Plan 或 prompt context。

`effective config` 是一个受版本控制的结果，不是运行时拼接 JSON：

```text
effectiveConfig = {
  configurationRevision,
  modelRouteRelease,
  integrationBindings[],
  skillReleases[],
  policyReleases[],
  resolvedAt
}
```

Runtime 在 Plan/admission 持久化其中的 release IDs、versions 与 SHA-256；secret reference 仅记录 ID/version，不记录凭据。

### 6.1 运行时配置供给：Host/Agent 改变，内核保持运输中立

控制面持久化后，运行时的真实改变是：**文件 loader 被 Host/Local Agent 的 `RuntimeConfigurationClient` 替换**。不是让 AgentLoop 内核在任意时点查询数据库，也不是把 Admin API client 混进 Planner、Skill 或模型上下文。

```text
Control-plane DB / secret provider
       ↑                 ↓
Admin API ── delivery API ── RuntimeConfigurationClient (Cloud Host / Local Agent)
                                  ↓ 校验、scope 求值、凭据解析
                          RuntimeConfigurationSnapshot
                                  ↓ admission
               AgentLoop RunService / SkillService / model factory / integration tools
```

新的中立契约至少包括：

```ts
interface RuntimeConfigurationSnapshot {
  readonly snapshotId: string;
  readonly target: { readonly plane: "cloud" | "local"; readonly runtimeId: string; readonly deviceId?: string };
  readonly resolvedAt: number;
  readonly validUntil: number;
  readonly modelRoute: { readonly releaseId: string; readonly contentHash: string };
  readonly integrations: readonly { readonly bindingId: string; readonly releaseId: string; readonly contentHash: string }[];
  readonly skills: readonly { readonly releaseId: string; readonly packageHash: string }[];
  readonly policies: readonly { readonly releaseId: string; readonly contentHash: string }[];
}
```

快照的公开部分可传给内核；密钥材料只留在 Host/Agent 的受限内存或 secret broker。`LlmProviderRegistry.fromConfigObject()` 已具备使用内存 Provider 文档构造的入口，后续应将现有 `apiKeyEnv` 的环境变量解析替换为 Host-owned `SecretResolver`。Kernel 继续只获得 model factory、Skill catalog、策略和 Tool adapter，永远不获得 Admin 凭据、数据库连接、secret reference 的值或 delivery token。

这要求把当前单例 `RunService` 的启动配置改为**每次 admission 绑定的 Run Environment**：

```text
admission -> resolve acknowledged RuntimeConfigurationSnapshot
          -> create/bind immutable RunEnvironment
          -> persist snapshot refs with Run/Plan
          -> execute
```

不得在运行中修改一个全局 `RunService` 的 Provider registry、Tool 集合或 Practice Profile；那会使并发的旧 Run 静默使用新配置。已开始的 Run 使用自己的 immutable snapshot；新的 Run 才可使用已经 receipt-confirmed 的 release。

配置不可用时的规则：

- 没有本地已验证快照：拒绝新 admission，返回稳定的 `configuration_unavailable`，不能悄悄退回旧 JSON。
- delivery 暂时失败但有未过期的已验证快照：是否允许新 Run 由 binding 的明确 policy 决定；使用时写入 `configuration_stale` 事实和版本。
- `validUntil` 已过、目标被撤销或 secret 轮换失败：拒绝新 admission；不终止已有 Run，除非该 Integration 的独立紧急撤销策略明确要求。

### 6.2 Integration secret broker 与 Skill 脚本迁移

外部 key 的迁移不能变成“管理端把 key 写进另一份 `.env`”。所有 Provider 和 Integration 都通过 Host/Agent-owned `IntegrationSecretBroker` 消费凭据：

```text
Skill executor / generic Tool adapter
  -> declared Integration invocation (run, step, skill release, action)
  -> IntegrationSecretBroker
  -> checks RunEnvironment + Step authorization + target binding
  -> resolves secret reference / performs upstream request
  -> returns redacted, schema-validated result + receipt
```

Broker 可在 Cloud Host 内部运行，或由 Router 的受控 Tool Adapter 承载；Local Agent 使用同一 contract 的设备侧实现。它必须是通用的 Integration 类型/动作机制，不能把 enterprise、钢材或某个 Provider 的业务字段硬编码到内核。

`enterprise-info` 是首批迁移对象。当前 `enterprise_info.py` 从 `ENTERPRISE_INFO_ENV_FILE` 读取 `ENTERPRISE_INFO_API_BASE_URL`、`ENTERPRISE_INFO_API_CLIENT_ID` 和 `ENTERPRISE_INFO_API_CLIENT_SECRET`；Runtime 仅将该非敏感文件路径放进 command environment。目标形态应是：

1. `enterprise-info` manifest 声明所需 `enterprise_info` Integration 与允许的 `search`/`detail` 动作。
2. 脚本保留输入规范化、候选/主体绑定、结果解释和 Evidence 结构；删除 `read_config()` 及直连上游的 client-secret 流程。
3. 脚本调用由 Runtime 提供的受限 Integration invocation（例如受保护的本地 socket/adapter），只提交已声明动作和已校验参数。
4. Broker 使用该 Run 的 snapshot binding 获取 client secret、申请 token、调用上游，并只将经过 redaction/shape validation 的响应交回脚本。
5. Run/receipt 记录 `enterprise_info` binding/release 和 secret version reference，绝不记录 client secret、access token、`.env` 路径或完整授权响应。

不能通过给脚本额外注入 `ENTERPRISE_INFO_API_CLIENT_SECRET`、短期 bearer token 或可读凭据文件来替代旧 `.env`：即使 ComputerExecutor 拒绝敏感 command environment，模型可见的命令面和 Skill 脚本仍不应成为通用 secret transport。

Web Search、MCP、`mysql-steel-data` 等采用相同迁移模式：连接定义与 binding 受 release 管理，实际凭据由 broker 在已授权 invocation 内消费。需要直连数据库的受信任脚本也只能拿到 broker 代理或绑定到最小权限数据库用户的短期连接能力，不能取得平台通用数据库密码。

## 7. API 分面

Admin API 使用独立 host，例如 `admin-api`，与用户 Router API 分域、分 session audience、分 rate limit。

| API 面 | 调用方 | 责任 |
|---|---|---|
| `/admin/v1/*` | Admin Web、自动化 CLI | 用户/租户、Integration、Skill、Policy、发布、审计、运营查询 |
| `/delivery/v1/*` | 已认证 Cloud Host、Local Agent | 拉取目标的 desired config、Skill 包元数据、密钥短期 envelope、提交 receipt |
| `OperationalQueryPort` | Admin API | 只读查询 Router/Runtime 的规范化投影 |
| `RuntimeOperationPort` | Admin API | 受控命令：drain、恢复、撤销；不允许数据库直写 |

Admin API 的首批资源接口：

- `integrations`, `model-routes`, `credential-references`
- `skills`, `skill-releases`, `skill-assignments`
- `policies`, `policy-releases`, `target-assignments`, `rollouts`, `apply-receipts`
- `tenants`, `users`, `memberships`, `admin-sessions`
- `operations/conversations`, `operations/assignments`, `operations/runs`, `operations/runtimes`, `audit-events`

任何 mutating API 都需要 `expectedRevision`，返回新的 release/digest，并写入不可变 audit event；不能提供通用 SQL、任意环境变量或任意文件路径编辑接口。

## 8. Admin Web 信息架构

独立前端只消费 `/admin/v1`，首版导航：

1. 概览：发布健康、失败 receipt、离线 Runtime、关键告警。
2. 集成与模型：Provider、Model Route、MCP/数据源、凭据状态、连通性。
3. Skill：目录、release、签名、目标安装/加载状态。
4. 策略：Practice Profile、执行策略、Plan Template，含 dry-run/observe/canary/rollback。
5. Runtime：Cloud/Local 节点、能力、版本、容量、心跳、drain/recovery 历史。
6. 用户与租户：成员、角色、设备、session 吊销。
7. 运行追踪：按 tenant/user/conversation/assignment/run 查询完整事实链。
8. 审计：谁在何时对哪个资源发布、回滚或执行受控操作。

初版优先“查看、发布、回滚、receipt 排障”，不做可视化编排器、聊天界面副本或直接的 Run/Plan 编辑器。

## 9. 权限与安全

当前角色收敛为 `platform_admin`、`operator`、`skill_operator`、`auditor`、`member`。`RuntimeTarget.scopeId` 只是运行目标的作用域/隔离键，尚未形成独立的租户管理域，因此不定义 `tenant_admin`。管理员登录态必须有独立 audience，不能复用用户 Web token 作为万能管理凭据。Router 用户身份域中的 `tenantId` 保持不变，并在 Runtime admission 边界显式映射为 `scopeId`。

- 最小权限：用户、租户、平台、设备和 workload identity 分开授权。
- 密钥：外部 secret provider 优先；若过渡期加密入库，采用 envelope encryption、版本化 DEK/KEK、轮换和访问审计。
- Local：只向注册且未撤销的 device 交付其 target 的短期加密 envelope；不将本机目录、上传内容或数据库密码回传。
- Skill：下载包验签、校验 digest、记录 signer；包不能携带凭据。
- 审计：写操作、secret access grant、delivery、receipt、drain/recovery 都产生不可变事件。

## 10. 分阶段交付

### Phase 0 — 契约与基线

建立 contracts/domain package、`cp_*` 迁移、审计模型、`RuntimeConfigurationSnapshot` 和只读配置导入器。将现有 JSON/部署变量登记为 baseline release，包含其 source hash；保持当前启动行为不变。

同时实现 shadow resolver：对同一 target 计算文件基线和 control-plane effective config，记录差异但不改变执行。差异必须在切换前消除，不能以“缺字段则读文件”形成永久双源。

### Phase 1 — Shared provider/integration control plane

实现 Integration/Model Route/Binding、Cloud Host `RuntimeConfigurationClient`、snapshot cache、pull/receipt、Admin API 与最小前端。Host composition 从文件 loader 迁移为 snapshot -> in-memory registry/tool adapter；AgentLoop 内核仍只接收已冻结依赖。

验收发布一个不含密钥的模型路由，Cloud Host 回执 loaded，随后 fresh Run 固化该 release。通过 shadow comparison 后，按 Runtime target 切换到 control-plane source；文件只保留为显式 bootstrap/rollback release，不允许 per-field fallback。

### Phase 2 — Secret broker 与受信任 Integration

实现 `IntegrationSecretBroker`、凭据版本/轮换、Cloud workload identity 与 `enterprise-info` 的完整迁移。验收该脚本不再读取 `.env` 或接触 client secret，仍可取得同样的受控结果、Evidence receipt 和 failure 分类。

### Phase 3 — Local delivery

实现设备 scope、Local Agent pull/receipt、设备公钥加密凭据 envelope 和本机安全存储。验收同一 Provider release 对 Cloud/Local 有各自 binding，凭据不交叉泄露。

### Phase 4 — Skill 与策略

接入签名 Skill Release、安装回执、Practice Profile、执行策略和 Plan Template policy。验收已加载 release 才进入 Runtime capability/admission。

### Phase 5 — 运营面

接入成员管理、会话/Run 追踪、Runtime 受控操作与审计检索。只读查询先于高风险操作；操作必须通过 Router/Runtime Port。

### Phase 6 — 去除文件权威性

在 Cloud/Local 完成 release 拉取、回执、回滚与故障恢复证明后，JSON 从权威配置降为安装种子/离线 bootstrap。不可在没有回滚和 Host/Agent 重启验证前删除现有部署路径。

## 11. 验收边界

每个阶段至少包含：schema/权限测试、冲突发布测试、scope 解析测试、secret 不泄漏测试、Cloud 与 Local receipt 测试，以及一条新 Run 的持久化链路测试。迁移阶段还必须测试旧/新 resolver 的 shadow 等价、同一进程中旧/新 snapshot 并发 Run 隔离、delivery 不可用、撤销/轮换和 Host/Agent 重启后的 receipt 恢复。

`enterprise-info` 的回归样例必须证明：脚本无法从 command environment 或可读文件取得 client secret；无 binding 时得到稳定的配置错误；合法 binding 下 search/detail、主体选择约束、evidence receipt 和脱敏输出仍完整保留。此类测试验证的是通用 broker 边界，而不是为单一 Skill 在 Renderer 或 Kernel 中添加特殊判断。

发布成功、页面显示 active、或单元测试通过，都不证明配置生效。完成证明必须包含：目标 receipt、目标的版本/哈希、fresh Run 的 admission snapshot、实际模型/Skill/策略的运行事件，以及终端 Assessment/Outcome 投影。

不在本设计范围内：把 Local SQLite/文件复制到云端、Admin 直接修改 Runtime 内核表、用配置强行更改在途 Run、或用后台 UI 绕过用户会话与 Runtime 授权。

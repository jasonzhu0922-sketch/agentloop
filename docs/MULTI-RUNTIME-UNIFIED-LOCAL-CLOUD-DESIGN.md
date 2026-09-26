# Multi Runtime 统一本地与云端架构设计

> 状态：实施中（2026-09-25）
>
> 本文把 AgentLoop 的单机能力、本地目录能力和云端多 Runtime 能力统一到一条产品架构中。后续产品开发以 `agentloop-multi-runtime` 为唯一主线；`agentloop-app` 暂停新增功能，保留为迁移参考和历史实现。

## 核心架构结论

本机不是另一种产品，也不是 Browser 自己维护的一套执行链。本机唯一的特殊性是：**Local Runtime Agent 是用户设备上的 Supervisor 与 Router 连接代理；它管理一个或多个用户拥有的 Local Runtime Host。** 因此：

- Web、Router、登录、会话、Task、Assignment、状态投影和最终轮次协议全部共享；
- Router 像调度云端 Runtime 一样调度每一个本地 Runtime，只是通过 Local Agent 的出站 WebSocket 连接发送任务；
- 每个 Local Runtime 有独立的数据库、目录 scope、工作区和生命周期；当前阶段的 Skill 仍由 Runtime 启动时从同一组 bundled/custom Skill 目录统一加载，不提供实例级安装、更新或回滚；
- Local Runtime 保存完整本地执行事实和产物，普通 `local` 模式只把不含产物正文的最终轮次摘要写入云端共享会话；
- `strict_local` 是显式隐私例外，连最终轮次摘要也不上传；
- Browser 直连 Local Agent 通常只用于目录授权和本地产物读取；只有显式 `strict_local` 作为隐私数据面例外，直接创建和观察本地 Run，但不创建云端 Task/Assignment，也不形成第二个 Router 权威。

## 实施状态

第一批已落地并有 HTTP 回归覆盖：

- Multi Runtime Router 已拥有独立的用户、个人租户和 Bearer 会话身份服务；公开用户 API 从认证会话导出用户和租户，不再信任请求头或请求体提供的身份。
- 新增 `agentloop.task/v2` 请求入口及 `ExecutionTarget`、`DataPolicy` 契约。云端任务和本地任务都由 Router 创建 Task/Assignment；本地只是一个特殊 Runtime，由已注册的 Local Runtime Agent 执行。
- `local_device` 目标现在必须同时携带 `deviceId` 与稳定的 `runtimeId`，本机 Runtime catalog 绑定所属租户和用户；不能通过猜测其他用户的设备或 Runtime ID 越权调度。
- Multi Runtime Web 已改为登录/注册入口，不再把用户 ID、租户 ID 作为可编辑的授权参数。
- 登录与注册已是独立页面；Web 通过同源 `/api` 由 Web 服务端代理 Router，Router 不可达时返回明确的 `router_unavailable`，不会被渲染为 Run 已失败或认证失效。
- 已实现 Local Runtime Agent 的最小设备注册闭环：用户点击“启用本机 Runtime”时，Browser 领取一次性注册授权并交给 loopback Agent；Agent 保存自己的 Ed25519 密钥与 Agent 凭据，向 Router 注册设备。设备可列出、心跳和撤销；浏览器不保存 Agent 长期凭据。
- Agent 已使用设备凭据主动建立 Router WebSocket 控制连接，在同一连接上发布 Runtime catalog、心跳并处理统一的 RuntimeEndpoint RPC。Router 动态登记/下线本机 Runtime，Web 本机任务不再调用 `/v1/local-runs` 创建、轮询或取消 Run。
- Router 已为普通 `local` 策略写入 `mr_turns` 最终轮次投影；设备离线后仍可读取用户输入、最终回复和终态。Router 明确拒绝 `strict_local` 进入云端 Task 数据面；Web 改为通过短期本机会话直连 loopback Agent 创建、观察、取消本地 Run 和读取产物。
- Router 重投本机 dispatch 时复用原 Assignment 与 `dispatchKey`，Agent 使用本地 dispatch ledger 返回已创建的 Run，覆盖“Run 已创建但 ACK 丢失”的重复执行窗口。
- 本机产物元数据通过 Assignment 展示时会移除绝对路径；产物字节仍由 Browser 使用短期本机会话从 loopback Agent 读取，不经过 Router BlobStore。
- 云端 Router 已拥有基于共享工作区的 Artifact Catalog：在终态 Host 状态被 Router 观察时，先登记 Assignment、归属、相对路径、大小、MIME 与 SHA-256，再投影终态；后续列表、下载和预览优先由 Catalog 读取共享工作区，不再依赖原 Assignment Host endpoint。Catalog 的主键是 `(assignmentId, artifactId)`，避免把执行侧 artifact ID 误当作全局身份。该实现是 BlobStore 的可替换适配器，而非字节复制。
- Local Agent 已实现持久化的多实例 Runtime Supervisor。一个设备连接可发布多个稳定 `runtimeId`；默认实例沿用原数据目录，新实例使用各自的 SQLite、workspace 和 directory scope。Supervisor 是 `ready/draining/restarting/stopped/failed` 生命周期及 Run admission 的唯一权威。
- 已实现 `drain`、`restart`、`stop`、`start`：drain 原子关闭新 Run admission，活动 Run 与正在创建 Run 的 admission 都会阻止实例提前关闭；Run 终态后再完成 pending restart/stop。完整 Runtime catalog 更新通过同一条 Agent WebSocket 重新发布，停止的实例从 Router catalog 下线。
- Web 已提供 Runtime 新建、选择和生命周期控制，并使用操作系统原生目录选择器创建指定 Runtime 的 scope；绝对路径不进入 Browser 请求或 Router。
- `strict_local` 数据面已实现 Browser ↔ Local Agent 直连。正文、事件、结果和产物只保存在实例本地数据库/工作区和有界 Browser 恢复缓存；Router 只承担用户、设备和短期本机会话授权。
- Skill 保持统一加载模式：每个 Runtime 启动时同步同一组 bundled/custom Skill 目录与共享 package store；本阶段没有实例级 Skill 管理 API。

仍需继续完善的阶段：Local Agent 的签名安装包/桌面内置分发与自动更新、生产首次启动引导、对象存储版 BlobStore、Local ↔ Cloud 的显式上传与产物同步，以及比当前短期本机会话更细粒度的本地产物句柄。实例级 Skill 安装、更新和回滚不属于当前阶段；若未来引入，必须先单独设计版本、drain 和回滚契约，不能改变当前 Runtime 启动时统一加载模式。

## 1. 摘要

AgentLoop 不再维护“单机版”和“Multi Runtime 版”两套产品。统一产品由一个共享 Web 前端、一个云端 Router、若干云端 Runtime Host，以及用户设备上的可选 Local Runtime Agent 组成。Local Runtime Agent 不是第二个产品或第二个控制面，而是设备上的 Runtime Supervisor；其管理的一个或多个 Local Runtime Host 与云端 Host 处于同一调度模型。

“单机”不是另一套 Router，而是用户在任务或工作区上选择：

- 由本机的 Local Runtime Agent 执行；
- 目录授权和产物默认留在本机；最终轮次摘要统一写入云端，便于跨设备继续使用；
- 用户账号仍由云端统一管理；
- 云端只负责登录、租户、权限、设备配对和可选的任务授权。

“云端”则表示：

- Router 从云端 Runtime Pool 选择一个完整 Runtime Host；
- 云端保存任务所需的会话状态、附件和产物；
- 产物由 Router 管理的 Artifact Catalog 和 BlobStore 持久化，不依赖原 Runtime Host 是否仍在线。

核心原则是：**Web 和 Router 共享同一套任务、会话和 Assignment 协议；Local Runtime Agent 是本机 Runtime Supervisor，负责设备连接、生命周期管理，并承载本机目录、设备本地 Skill 和本地执行资源。**

## 2. 要恢复的真实契约

改造的目标不是让启动命令成功，或让某个 UI 开关出现，而是让以下系统契约成立：

1. 同一个云端账号可以登录 Web、管理租户、授权设备，并在不同设备上继续使用同一产品。
2. 每个任务明确声明执行位置和数据驻留策略，不能由 Router 根据网络错误静默改道。
3. 本机选择的目录可以直接作为可读文件源；目录真实路径只存在于用户设备，不进入云端任务、事件、日志或数据库。
4. 本机执行时，Local Agent 在本机保存完整 Run 事实、事件和产物；Router 只接收不含产物正文的最终轮次摘要。
5. 用户明确选择云端执行或上传资料后，云端才持有相应的正文、附件或产物内容；`strict_local` 可关闭最终轮次摘要上传。
6. 云端任务完成后，产物在原 Host 停止、替换或重启后仍然可以访问。
7. 任何用户输入的身份字段都不能覆盖认证上下文；Router 必须从认证令牌和设备授权中得到用户身份。
8. 本机设备不可用时，系统必须返回明确的 `device_unavailable`，不能悄悄切换到云端。

## 3. 当前实现的边界问题

当前 Multi Runtime 已经具备 Router、Runtime Host、Assignment、容量调度、事件投影和 Host dispatch 幂等等基础。但在统一产品目标下有四个语义断点：

### 3.1 身份不是可信上下文

`router-http.ts` 当前读取 `x-tenant-id`、`x-user-id`，并允许请求体提供 `tenantId`、`ownerUserId`。这些字段都可以被客户端伪造，不能承载统一登录和租户权限。

目标是：公开 API 只接受认证令牌；认证中间件解析出 `Principal`，后续 Router 方法只接收服务端生成的身份对象。

### 3.2 Router 当前保存了完整输入

`mr_tasks.input` 当前用于会话列表标题和会话详情。这不符合“本机历史默认不上传”的目标，也会把云端 Router 变成不必要的会话正文存储。

目标是将“统一云端轮次索引”和“Runtime 私有执行事实”拆开：

- 云端统一保存每个任务的最终轮次摘要、状态、执行目标和可恢复引用；
- 本地 Runtime 的完整正文、事件、Plan、Tool 证据和产物仍由 Local Agent 本地保存；
- 云端摘要不得包含绝对路径、目录内容、产物正文或完整工具参数；用户可通过数据策略关闭摘要正文上传。

### 3.3 本地目录被正确拒绝，但缺少本地执行入口

云端 Router 和云端 Host 拒绝 `visibleDirectories` 是正确的安全边界。问题不在于取消拒绝，而在于当前产品没有 Local Runtime Agent 来承接这项能力。

目标是让目录授权在本机解析为内核现有的 `VisibleDirectoryGrant`，而不是把绝对路径放进云端协议。

### 3.4 云端产物依赖原 Host

当前 `PersistentMultiRuntimeRouter.artifacts/readArtifact/previewArtifact` 直接代理给 Assignment 对应的 Host。Host 下线后，旧产物可能无法读取。

目标是把云端产物的最终所有权移到 Router 的 Artifact Catalog 和对象存储；Host 只负责生产和上传。

## 4. 目标拓扑

```text
                         云端
┌──────────────────────────────────────────────────────────────┐
│ Identity / Tenant / Device Registry                           │
│                                                              │
│ Router（唯一云端控制面）                                      │
│  - 登录上下文与权限                                           │
│  - 设备配对与授权                                             │
│  - Task / Assignment / SSE                                    │
│  - 云端 BlobStore / Artifact Catalog                          │
│              │                                               │
│              ├──────── Cloud Runtime Host A                   │
│              ├──────── Cloud Runtime Host B                   │
│              └──────── Cloud Runtime Host N                   │
└──────────────┬───────────────────────────────────────────────┘
               │ HTTPS / WebSocket / outbound device session
               │
        ┌──────▼───────┐
        │ Browser/Web  │
        └──────┬───────┘
               │ localhost authenticated session
        ┌──────▼────────────────┐
        │ Local Runtime Agent   │
        │ - local RunService    │
        │ - local SQLite        │
        │ - directory grants   │
        │ - local artifacts     │
        └──────────┬─────────────┘
                   │
             User-selected directories
```

### 4.1 Browser/Web

Web 是唯一的用户交互前端，负责：

- 登录、注册、租户和设备列表；
- 创建工作区和任务；
- 选择 `cloud_pool` 或 `local_device`；
- 选择本地目录并显示目录 scope；
- 通过 Router 订阅统一 Assignment 事件；本地 Runtime 的事件由 Agent 上报 Router 后投影给 Web；
- 显示执行位置、数据驻留位置、设备状态和最终产物。

Web 不保存 Runtime endpoint、云端服务令牌、绝对本地路径或 Host 内部 Run ID。

### 4.2 Cloud Router

Router 是所有云端公开 API 的入口，负责：

- 验证用户会话、租户成员关系和设备授权；
- 创建 Task、Assignment 和执行目标；
- 调度云端 Runtime Host；
- 向云端 Host 发放短期、绑定 Assignment 的执行凭据；
- 向 Web 投影状态和 SSE 事件；
- 管理云端附件、BlobStore、Artifact Catalog 和访问授权。

Router 不负责 Plan、Step、Tool、Evidence、Assessment、Recovery 或 Outcome 的决策。它只投影 Runtime 已提交的执行事实。

### 4.3 Cloud Runtime Host

每个云端 Host 是一个完整 AgentLoop Runtime，负责一个 Run 的完整生命周期：

- Plan 和 Step 调度；
- Tool 执行和 Capability Grant；
- Evidence、Assessment、Recovery；
- Terminal Committer 和最终 Outcome；
- 将正式产物上传到 Router 管理的 BlobStore。

一个 Run 不拆分到多个 Host。Host 失效时，现阶段只能按已有 recovery/continuation 语义处理，不能把共享数据库误称为无损 HA 接管。

### 4.4 Local Runtime Agent 与 Local Runtime Host

Local Runtime Agent 是设备级 Supervisor，而不是一个固定且唯一的 Runtime：

- 保存设备身份，与 Router 建立一条出站 WebSocket 连接，并复用它注册/注销多个 Local Runtime；
- 维护 Runtime 的生命周期：`start`、`drain`、`restart`、`stop`；
- 只在用户明确操作或已声明的维护策略下重启 Runtime；运行中的 Assignment 必须先 `drain`，不得因配置或版本变化被静默中断；
- 将 Router 的 `task.start` / `task.cancel` 定向给指定 Runtime，并汇总心跳、状态和最终轮次摘要；
- 可额外通过 loopback 给本机 Web 提供目录授权和本地 Artifact 读取能力，但这不是第二套控制面。

每个 Local Runtime Host：

- 与 Cloud Runtime Host 使用同一套 `RuntimeEndpoint`、Task、Assignment、Run 状态和最终轮次协议；
- 有稳定 `runtimeId`、所属 `deviceId`、独立数据目录/workspace 与目录 scope；
- 当前从设备统一配置的 bundled/custom Skill 目录加载同一套 Skill；Runtime catalog 可以登记能力摘要，但不能上传 Skill 正文或本地路径；
- 本地保存完整 Run、Plan、事件、会话正文和本地产物，并按 `DataPolicy` 提交最终轮次摘要。

Agent 与 Local Runtime 都不负责用户注册、租户成员关系、全局会话管理或云端调度决策。身份和 Assignment 权威仍然是云端 Router。

## 5. 任务放置与数据驻留协议

任务协议从“选择某个 Runtime ID”升级为显式的执行目标和数据策略。

```ts
type ExecutionTarget =
  | {
      kind: "cloud_pool";
      profile?: "general" | "artifact";
      region?: string;
    }
  | {
      kind: "local_device";
      deviceId: string;
      runtimeId: string;
    };

type DataPolicy =
  | { mode: "cloud" }
  | { mode: "local" }
  | { mode: "strict_local" };

interface SubmitTaskV2 {
  schema: "agentloop.task/v2";
  conversationId: string;
  clientMessageId: string;
  input?: string;
  executionTarget: ExecutionTarget;
  dataPolicy: DataPolicy;
  attachmentIds?: string[];
  localDirectoryScopeIds?: string[];
  requestedModelKey?: string;
  allowDangerousTools?: boolean;
}
```

### 5.1 放置约束

| 执行目标 | 数据策略 | 结果 |
| --- | --- | --- |
| `cloud_pool` | `cloud` | 允许。正文、云端附件和云端产物由 Router 持久化。 |
| `local_device` | `local` | 允许。完整 Run、目录和产物留在 Local Agent；云端保存不含产物正文的最终轮次摘要。 |
| `local_device` | `strict_local` | 允许。Browser 与 Local Agent 直连数据面，云端不持久化会话正文、事件、附件字节、产物或最终轮次摘要。 |
| `cloud_pool` | `local` / `strict_local` | 拒绝。云端执行无法在不上传内容的情况下读取本地数据。 |
| `local_device` + 本地 scope | `cloud` | 拒绝，除非用户先明确执行一次上传/快照操作。 |

系统不得把 `localDirectoryScopeIds` 转换为绝对路径后写入云端 Task、Assignment、事件、日志或 Blob 元数据。

### 5.2 不允许静默降级

以下情况必须返回类型化错误，而不是自动改道：

- 本机设备离线：`device_unavailable`；
- 本地 scope 已撤销：`local_scope_revoked`；
- 云端要求本地内容但未得到上传授权：`cloud_data_transfer_required`；
- 云端产物上传失败：`artifact_persist_failed`；
- 用户无权访问 Assignment 或设备：`not_authorized`。

## 6. 本地目录协议

### 6.1 Scope 生命周期

1. Browser 请求 Local Agent 打开系统目录选择器。
2. Local Agent 取得绝对路径并检查目录权限。
3. Local Agent 在本地数据库保存路径、名称、授权时间和撤销状态。
4. Local Agent 返回不透明的 `localDirectoryScopeId`，例如 `lds_...`。
5. Web 在创建 Task 时只提交 scope ID；Router 将 scope ID 作为不透明的本地能力引用转给 Local Runtime。
6. Local Agent 在执行 Run 前将 scope ID 解析为内核 `VisibleDirectoryGrant`。
7. 用户撤销授权或 Local Agent 检测路径不可用时，scope 进入 `revoked`/`unavailable`。

```ts
interface LocalDirectoryScope {
  id: string;
  deviceId: string;
  displayName: string;
  status: "active" | "revoked" | "unavailable";
  grantedAt: number;
  lastCheckedAt?: number;
}
```

真实路径只存储在 Local Agent 的本地安全存储中。`displayName` 是否同步到云端也不是默认行为；云端设备状态可以只使用 scope 数量和不透明 ID。

### 6.2 Local Agent 到内核的适配

Local Agent 不是重新实现 `visible_*` 工具。它将本地 scope 编译成现有内核的：

```ts
interface VisibleDirectoryGrant {
  id: string;
  name: string;
  path: string;
}
```

因此原有的 `visible_list_directory`、`visible_find_files`、`visible_index_directory`、`visible_read_file` 等工具继续由内核执行；Local Agent 只负责授权、路径解析、生命周期和本地数据边界。

### 6.3 云端上传是显式数据转移

当用户把本地任务切换为云端时，Web 必须展示数据转移确认，并执行独立的“上传/快照目录”流程：

- 用户选择文件或限定目录范围；
- Local Agent 扫描并计算文件清单、大小和 SHA-256；
- 用户确认后，Browser/Local Agent 上传到 Router 附件或 Source API；
- 云端得到的是新的 `uploadedSourceId`，不是 `localDirectoryScopeId`；
- 原本地 scope 不会自动变成云端 Source。

这两个命名空间必须严格分离：`local_directory_scope`、`uploaded_source`、`tool_source` 和 Skill ID 不能互相绑定。

## 7. 身份、租户和设备安全

### 7.1 云端身份

从旧 `agentloop-app` 中可以复用密码散列和会话实现，但应抽成独立的 Identity 模块，而不是继续依赖旧 App 的 RunService。

最小模型包括：

- `users`：用户账号和认证信息；
- `tenants`：组织/租户；
- `tenant_memberships`：用户在租户中的角色；
- `sessions`：浏览器会话或 OIDC/JWT 会话；
- `devices`：设备公钥、名称、状态和最后在线时间；
- `device_pairing_codes`：一次性、短时有效的配对码；
- `device_grants`：用户、租户、设备和权限的绑定。

公开 API 的处理链为：

```text
Authorization Cookie/Bearer
  -> Identity authenticate
  -> Principal { userId, tenantId, roles }
  -> Router authorization
  -> Task / Assignment operation
```

服务端不得接受请求体中的 `tenantId`、`ownerUserId` 作为身份来源。旧的 `x-tenant-id`/`x-user-id` 兼容入口应在迁移期仅保留开发测试开关，生产配置直接拒绝。

### 7.2 Local Agent 配对与 WebSocket 控制通道

推荐使用浏览器显示一次性配对码或 QR：

1. 用户登录 Web 后创建设备配对会话。
2. Local Agent 生成设备密钥对，并显示配对码。
3. Browser 将配对码提交 Router。
4. Router 将设备公钥绑定到当前用户和租户。
5. 配对成功后，Local Agent 使用设备凭据主动建立到 Router 的 `wss` 长连接；Router 不主动连接用户局域网。
6. WebSocket 建立时使用设备 ID、随机 nonce、签名和短期会话证明完成握手；长期 Agent 凭据只保存在 Local Agent。
7. Router 通过连接下发 `task.start`、`task.cancel` 和能力/授权消息；Agent 回传 `run.accepted`、事件摘要、`run.completed`/`run.failed` 与最终轮次摘要。
8. 用户可以在 Web 中撤销设备；撤销后 Router 拒绝新任务并关闭该设备连接。

Local Agent 不保存长期浏览器 Cookie，也不把云端用户密码放在本机。

注册本身可以使用 WebSocket：Web 先通过 HTTPS 登录 Router 并创建一次性 `pairingSession`，随后把该短期凭据交给 loopback Agent；Agent 通过 `wss://router/.../runtime-registration` 携带设备公钥和 pairingSession 完成注册。这样注册、心跳和任务控制都可以收敛到 Agent 主动建立的 WebSocket 连接。HTTPS 只负责用户登录、创建 pairingSession 和撤销设备，不承担设备长连接。

### 7.3 严格本地模式

`strict_local` 下，Router 仍是身份和设备授权权威，但数据面可以不经过云端：

- Browser 使用短期设备授权连接 Local Agent；
- Local Agent 校验授权签名、设备绑定和本地会话；
- 会话正文、事件、目录内容和产物通过 Browser ↔ Local Agent 传输；
- 云端只看到设备授权和在线状态，不接收最终轮次摘要。

这使“统一登录”与“本地隐私”同时成立，不要求云端 Router 读取本地目录。

### 7.4 Local Agent 安装、配置与启动

Web 页面不能直接假设 Local Agent 已存在，也不能静默下载并执行本机程序。生产环境把“启用本机能力”和“启动某个 Runtime”拆成两个阶段：

1. Web 先探测固定 loopback health endpoint，并核对 Agent 协议版本和所属环境。
2. Agent 不存在时，展示与操作系统和 CPU 架构匹配的签名安装包；下载安装与执行必须经过用户明确操作。若产品使用桌面壳，则 Agent 可以随桌面应用内置，不再单独下载。
3. 首次启动由安装器或桌面壳写入最小配置：Router URL、loopback 端口、本地数据根目录、统一 Skill 配置位置和自动更新通道。云端用户密码、浏览器 Cookie、目录绝对路径不得写入该配置。
4. Agent 作为用户级服务/登录项启动，先初始化设备密钥、Supervisor 数据库和默认 Runtime，再暴露 loopback health；不得要求管理员权限才能运行日常任务。
5. Browser 获取一次性配对授权并交给 Agent，Agent 使用自己的设备凭据主动连接 Router。配对完成后 Web 才显示本机 Runtime catalog。
6. “启动 Runtime”只发生在 Agent 已在线之后：Supervisor 打开该实例的数据库和 workspace，统一加载 bundled/custom Skill 配置，状态变为 `ready` 后通过 WebSocket 发布 catalog。
7. Agent 或 Runtime 版本更新必须先验证下载签名；Agent 更新与 Runtime `drain/restart` 是不同操作，不能在活动 Run 中静默替换进程。

当前仓库的 `start-local.mjs` 只承担开发环境编排，预先启动 Router、Local Agent、Web 和示例 Cloud Host；它不是生产安装器，也不能作为“Web 已经具备下载并启动 Agent”的完成证明。

### 7.5 Headless Local Runtime Agent、托盘与 Web 管理

Local Runtime Agent 是独立安装、用户级启动的**无业务界面后台程序**。它不拥有 Runtime 配置页面、目录配置页面或会话页面；这些页面全部由登录后的 Web 提供。安装包可以提供可选桌面托盘，但托盘只表达后台服务状态和快速动作：在线/离线、重连、启动/停止 Agent、打开 Web、查看本地日志和退出。托盘不得成为另一份 Runtime catalog 或存储配置权威。

```text
Web UI -- HTTPS --> Router -- authenticated WebSocket RPC --> Local Runtime Agent
                                                    |-> Supervisor / child Runtimes
                                                    |-> device shared workspace

strict_local browser data plane -- loopback --> Local Runtime Agent
```

常规控制面不由 Browser 直接调用 loopback：Web 调用 Router 的设备控制 API，Router 根据已认证用户和设备所有权在 Agent 主动建立的 WebSocket 上发送 `agent.*` RPC。该 RPC 至少覆盖：读取 Agent 状态、列出/创建/重命名/删除子 Runtime、Drain/Restart/Stop/Start、读取设备配置和请求原生共享存储选择器。`strict_local` 的任务、事件、目录和本地产物仍可使用 Browser 到 loopback 的直接数据面，不能借此把本地正文上传 Router。

首次安装与配对是例外：Web 只探测固定 loopback health endpoint、下载 Router 发布的安装包、并把一次性注册授权交给上线的 Agent。浏览器不能静默执行安装包。安装包完成后注册 `agentloop-local-runtime://start`（或桌面壳 launcher）以启动后台 Agent；Agent 随后自己建立 WebSocket，不接受 Router 对用户局域网的反向连接。

### 7.6 Agent 发布、版本和设备共享存储

Router 的受认证 release manifest 按 `platform + arch` 返回：`version`、`protocolVersion`、`downloadUrl`（HTTPS）、`sha256`、`signature`、可选 `launchUrl` 与 release notes。Web 仅展示并下载该 manifest；安装器验证签名和哈希后安装后台 Agent。Agent health 必须返回 Agent/协议版本，Web 遇到不兼容版本时不配对也不调度。

设备级共享存储和实例状态明确分离：

- Local Agent 拥有一个可配置的共享 workspace 根，全部子 Runtime 的 `RunService.workspaceRoot` 指向它；会话仍在 `conversations/<conversationId>` 下隔离。
- 每个子 Runtime 保留自己的执行状态数据库、dispatch ledger 和目录授权数据库；共享 workspace 不是把授权目录自动共享给其他 Runtime。
- Skill 包目录和来源配置是设备级统一配置；每个 Runtime 启动/重启时统一加载，不提供实例级 Skill 安装入口。
- 切换共享存储前 Agent 必须检查全部子 Runtime 没有 in-flight admission 或 active Run。通过后重载处于运行状态的实例，原存储不自动移动或删除；正式“迁移并清理旧存储”必须另有可回滚迁移任务。
- 删除子 Runtime 只在它已停止、无活动 Run、且不是默认 Runtime 时允许；删除只移除 catalog 登记并保留本地数据，物理清理需要独立确认流程。

## 8. 云端产物持久化

### 8.1 所有权转移

云端 Host 仍然负责生成产物，但最终所有权属于 Router 的 Artifact Catalog：

```text
Host Run 完成写入
  -> Host 计算 SHA-256 / MIME / 大小
  -> Router 发放一次性上传凭据
  -> Host 上传 BlobStore
  -> Router 校验哈希并写入 Artifact Catalog
  -> Terminal Committer/Router 投影 delivery receipt
```

Host 不能只返回一个本地路径。正式产物必须有 Router 可验证的 receipt。

### 8.2 Artifact Catalog

建议最小字段：

```ts
interface ArtifactCatalogEntry {
  id: string;
  tenantId: string;
  ownerUserId: string;
  conversationId: string;
  assignmentId: string;
  remoteRunId: string;
  name: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  blobKey: string;
  previewKey?: string;
  state: "uploading" | "available" | "rejected" | "expired";
  createdAt: number;
}
```

Browser 的列表、下载和预览 API 只读取 Catalog/BlobStore。原 Host 在线时可以提供上传和执行证据，但不是历史产物的唯一读取来源。

### 8.3 本地产物

本地产物由 Local Agent 持有，Router 只保存 artifact 元数据、可访问性和短期句柄，不保存产物正文。Web 通过统一 Assignment 看到产物状态；打开或下载时由 Local Agent 校验短期句柄并直接返回本地字节。用户明确点击“同步到云端”后，Local Agent 才创建云端上传任务；同步产生新的 Catalog 条目，并保留来源为 `local_agent` 的审计记录。

### 8.4 最终轮次摘要

普通 `local` 策略下，Local Agent 在 Run 终态提交：

```ts
interface FinalTurnSummary {
  assignmentId: string;
  runId: string;
  status: "completed" | "failed" | "cancelled";
  userInputDigest: string;
  assistantSummary?: string;
  errorCode?: string;
  artifactRefs: readonly { id: string; name: string; mimeType: string; byteSize: number }[];
  completedAt: number;
}
```

摘要允许跨设备恢复会话列表和最终回复，但不得包含本地绝对路径、目录内容、完整事件流、完整 Tool 参数或产物正文。`strict_local` 下不发送 `FinalTurnSummary`。

## 9. Router 与 Local Agent 的通信

不采用“本地 Router 调用云端 Router”作为默认控制流。这样会产生两个身份、两个调度和两个状态权威。

采用两个互补的数据路径：

### 9.1 普通本地模式

- Browser 通过云端 Router 完成登录、Task 创建和 Assignment 订阅；
- Router 根据 `executionTarget.local_device` 把同一份 Runtime Dispatch envelope 发送到 Local Agent 的 WebSocket 连接；
- Local Agent 在本地执行 Run，把执行状态、必要事件和不含产物正文的最终轮次摘要回传 Router；
- Web 通过 Router 读取统一会话轮次和状态；需要打开本地产物时，使用 Local Agent 的短期 artifact 句柄。

### 9.2 严格本地模式

- Web 仍使用共享登录和统一 UI，但 Task/Assignment 的内容与最终轮次摘要不上传 Router；
- Router 只签发设备授权、撤销状态和连接存活控制；
- Local Agent 在本地完成所有模型、Tool、目录和产物操作；
- 任何云端搜索、云端模型或云端 Runtime 都必须显式切换为云端任务。

### 9.3 云端模式

- Browser 将任务提交给 Router；
- Router 调度 Cloud Runtime Pool；
- Cloud Host 只收到 Router 签名的任务 envelope，不知道用户本机目录；
- 附件通过 Router/BlobStore 传递；
- 事件、取消和产物访问均以 Router Assignment 为边界。

## 10. 数据模型演进

现有 `mr_tasks`、`mr_assignments` 和 `mr_runtime_nodes` 可以作为云端调度基础，但需要扩展并拆分隐私数据。

### 10.1 Router 控制面表

建议增加或演进：

- `mr_tasks`：只保存任务引用、执行目标、数据策略和状态；
- `mr_turns`：统一保存云端可见的最终轮次摘要；不得写入本地绝对路径、目录内容、产物正文或完整本地事件流；
- `mr_assignments`：增加 `execution_target`、`device_id`、`protocol_version`；
- `mr_devices`：设备注册和在线状态；
- `mr_device_grants`：设备授权；
- `mr_uploaded_sources`：用户明确上传后的云端资料源；
- `mr_artifacts`：Artifact Catalog；
- `mr_task_privacy`：正文是否持久化、保留期限、删除状态；
- `mr_task_events`：仅保存允许云端保存的状态事件。

### 10.2 Local Agent 本地表

- `local_runtime_instances`：Runtime ID、显示名、状态、配置版本、独立数据目录引用和最后心跳；
- `local_runtime_operations`：用户触发的启动、停止、drain 和重启操作及结果；
- `local_runs`、`local_run_events`、`local_plans`：本地执行事实；
- `local_conversations`：本地会话正文；
- `local_directory_scopes`：路径和授权状态；
- `local_artifacts`：本地产物索引；
- `local_device_identity`：设备私钥引用和配对状态。

本地表保留完整执行历史；普通 `local` 策略只将受限的最终轮次摘要投影到共享云端会话。`strict_local` 不做此投影。除此之外的本地表不需要同步到云端。

### 10.3 Runtime 目录与多助理

Router 应把本地 Runtime 与云端 Runtime 放进同一份 Runtime Catalog；本地条目至少含 `runtimeId`、`deviceId`、显示名、状态、并发上限、能力和已发布 Skill 摘要。一个设备可以注册多个 Runtime，例如：

| Runtime | 面向的助理 | 设备私有能力 |
| --- | --- | --- |
| `local:macbook:research` | 研究助理 | 本地资料库、独立工作区 |
| `local:macbook:creator` | 创作助理 | 独立工作区、专用模型 |
| `local:macbook:private` | 私密助理 | 严格本地目录与模型 |

“多助理”通过选择或自动路由到不同 Runtime 实现，而不是复制 Web、会话或 Router。多个 Runtime 可以共享同一台设备 Agent；数据库、workspace 和 scope 隔离，Skill 则按当前统一加载策略共享同一组受配置管理的来源。

## 11. API 方向

### 11.1 身份和设备

```text
POST /v1/auth/register
POST /v1/auth/login
POST /v1/auth/logout
GET  /v1/me
GET  /v1/devices
POST /v1/devices/pairing-sessions
POST /v1/devices/pairing-sessions/{id}/complete
POST /v1/devices/{deviceId}/revoke
```

### 11.2 云端任务

```text
POST /v2/tasks
GET  /v2/assignments/{assignmentId}
GET  /v2/assignments/{assignmentId}/events/stream
POST /v2/assignments/{assignmentId}/cancel
GET  /v2/assignments/{assignmentId}/artifacts
GET  /v2/artifacts/{artifactId}
GET  /v2/artifacts/{artifactId}/preview
```

### 11.3 本地 Agent

```text
GET  http://127.0.0.1:<port>/healthz
POST http://127.0.0.1:<port>/v1/directory-scopes/pick
GET  http://127.0.0.1:<port>/v1/directory-scopes?runtimeId={runtimeId}
GET  http://127.0.0.1:<port>/v1/local-runtimes/{runtimeId}/runs/{runId}/artifacts
POST http://127.0.0.1:<port>/v1/local-artifacts/{artifactId}/sync
WSS  wss://router.example.com/v1/runtime-connections/{deviceId}
```

Local Agent 的 loopback API 通常只负责本地目录授权、产物读取和用户触发的 Runtime 生命周期操作。普通 `local` 的创建任务、取消任务、运行状态和最终轮次摘要走 Router 的统一 Assignment API 与 Agent -> Router WebSocket。`strict_local` 是明确例外，使用下面的 loopback Run API，且不创建云端 Task/Assignment。Local Agent 端口必须绑定 loopback，并要求短期设备授权；不能提供无认证的任意路径读取接口。

```text
GET  http://127.0.0.1:<port>/v1/local-runtimes
POST http://127.0.0.1:<port>/v1/local-runtimes
POST http://127.0.0.1:<port>/v1/local-runtimes/{runtimeId}/drain
POST http://127.0.0.1:<port>/v1/local-runtimes/{runtimeId}/restart
POST http://127.0.0.1:<port>/v1/local-runtimes/{runtimeId}/stop
POST http://127.0.0.1:<port>/v1/local-runtimes/{runtimeId}/start
POST http://127.0.0.1:<port>/v1/strict-local-runs
GET  http://127.0.0.1:<port>/v1/strict-local-runs/{runtimeId}/{runId}
GET  http://127.0.0.1:<port>/v1/strict-local-runs/{runtimeId}/{runId}/events
POST http://127.0.0.1:<port>/v1/strict-local-runs/{runtimeId}/{runId}/cancel
```

上述生命周期 API 记录用户操作，并返回 `draining`/`ready`/`restarting`/`stopped`/`failed` 等真实状态。Runtime 启动时从统一 Skill 配置加载，不提供实例级 Skill 写 API。

## 12. 前端产品行为

前端统一使用 Multi Runtime Web，不再维护旧的 `agentloop-app` 页面作为第二套入口。

新建工作区时显示三个明确选择：

1. **云端运行**：由云端 Runtime 执行，任务和产物保存云端。
2. **本机运行**：由本地特殊 Runtime 执行，完整执行事实和产物保存在本机；最终轮次摘要进入云端共享会话。
3. **严格本地**：仍由本地特殊 Runtime 执行，任务正文、事件、摘要和产物均不进入云端。

每个会话头部应显示：

- 当前执行目标：云端 Runtime / 本机设备名称；
- 数据位置：云端 / 本机；
- 本机设备状态；
- 本地目录 scope 数量，不显示绝对路径；
- 云端上传确认状态；
- 产物位置和同步状态。

任务运行中，UI 不根据“看起来像完成”的文本推断成功，仍以 Router 或 Local Agent 的正式 Run/Outcome 投影为准。前端的 multi-runtime simulation 只能作为真实执行事件的展示投影，不能创建第二套执行权威。

## 13. 迁移阶段

### 阶段 0：冻结旧单机 App

- `agentloop-app` 暂停新增产品能力；
- 保留其认证、会话和 RunService 代码作为迁移参考；
- Multi Runtime Web 成为唯一前端开发入口；
- 清理历史 Run 只能通过明确的数据迁移/删除命令完成，不在启动流程中隐式处理。

### 阶段 1：统一云端身份

- 抽取 Identity 模块和数据库迁移；
- 引入 `Principal` 和统一鉴权中间件；
- 生产环境删除客户端身份头信任；
- 增加用户、租户、成员、设备和配对模型；
- 让现有云端 Task/Assignment API 先在认证上下文下工作。

### 阶段 2：引入 v2 任务契约

- 增加 `ExecutionTarget`、`DataPolicy` 和版本化 envelope；
- 任务创建时校验放置与隐私组合；
- 云端任务拒绝本地绝对路径；
- 不做本地到云端的静默 fallback；
- 旧 v1 入口只保留受控迁移期，不能继续扩展。

### 阶段 3：云端产物目录化

- 实现 BlobStore 适配器；
- 增加 Artifact Catalog 和上传 receipt；
- Cloud Host 在完成写入后上传产物；
- Router 的读取/预览从 Catalog/BlobStore 返回；
- 通过 Host 替换测试后再移除 Host 回源读取。

### 阶段 4：Local Runtime Agent

- 新增 Local Agent 进程和本地数据库；
- 实现设备配对、出站 WebSocket Runtime 连接和 Router Assignment 消费；
- 把 Agent 实现为多 Runtime Supervisor：一个设备可注册、启动、drain、重启和停止多个 Local Runtime；
- 使用操作系统原生目录选择器将目录授权转换为指定 Runtime 的本地 scope，并把 scope 编译为内核 `VisibleDirectoryGrant`；
- 实现本地事件、本地产物和 `strict_local` 直连数据面；每个 Runtime 启动时统一加载相同的 bundled/custom Skill 来源；
- Local Agent 将最终轮次摘要按 `DataPolicy` 投影到 Router；
- Browser 增加本机 Runtime 不可用的明确错误状态。

### 阶段 5：数据转移和同步

- 实现用户确认的文件/目录快照上传；
- 实现本地产物显式同步到云端；
- 记录上传来源、哈希、用户确认和撤销状态；
- 默认不上传本地历史，也不自动同步全部会话。

### 阶段 6：收敛和下线旧入口

- Web、Router、Local Agent 的功能覆盖稳定后，停止旧 App 的启动文档和前端入口；
- 将 `agentloop-app` 标为 legacy/reference；
- 删除仅服务于旧 App 的直接执行路径前，完成迁移数据和用户可见行为核对；
- 保留内核公共能力，不因为产品入口收敛而复制 Runtime 实现。

## 14. 验收与回归测试

### 14.1 身份和授权

- 伪造 `x-user-id`、`x-tenant-id` 或请求体身份字段不能越权；
- 用户只能访问自己租户的 Task、Assignment、Artifact 和设备；
- 撤销设备后，Local Agent 不能创建新的授权 Run；
- 过期配对码和过期设备令牌必须失败。

### 14.2 隐私边界

- 本地任务的 Router 数据库不出现绝对路径；
- 本地任务的云端日志、事件和错误不包含本地文件正文；
- 普通 `local` 任务会创建不含产物正文的云端最终轮次摘要；
- `strict_local` 不创建云端会话正文、最终轮次摘要、附件 Blob 或本地产物 Catalog 条目；
- 没有用户确认时，Local Directory Scope 不能变成 Uploaded Source。

### 14.3 本地目录

- Browser 选择目录后，Local Agent 能创建有效 scope；
- Local Run 能真实执行 `visible_index_directory` 和 `visible_read_file`；
- scope 撤销或目录不可用时返回类型化错误；
- Local Agent 不能通过任意路径参数绕过 scope。

### 14.4 云端执行和产物

- 云端任务只能调度云端 Host；
- 云端 Host envelope 不包含本机绝对路径；
- Cloud Host 停止或替换后，已完成产物仍可下载和预览；
- Catalog 哈希、大小、MIME 和 Blob 内容一致；
- Host 上传失败不能被投影为成功交付。

### 14.5 放置和故障

- 本机设备离线时显示 `device_unavailable`，不自动切云端；
- 云端容量不足时显示明确的排队/容量状态；
- Assignment 幂等重试不会创建重复 Run；
- Router 重启后仍能恢复 Assignment 投影；
- 每次发布验证都要区分：聚焦测试、重启后的 Host 验证和浏览器代表性 E2E，不能用前者代替后两者。

### 14.6 本地 Runtime 生命周期与多助理

- 用户重启指定 Local Runtime 时，Router 先看到 `draining`，不再投递新 Assignment；已有 Run 按取消或既有 recovery 语义收敛；
- drain 与新 Run admission 必须原子化；已经进入 admission 但尚未生成 Run ID 的任务也必须阻止实例提前关闭；
- 同一 Agent 下两个 Runtime 的 workspace、scope 与本地数据库不得越界读取；Skill 来源按设备统一配置加载；
- Router Runtime Catalog 能区分同一设备下的多个 Runtime，并按各自能力调度；
- 多助理选择只是 Runtime 选择/调度策略，不能创建另一套用户、会话、Task 或 Assignment 权威。

## 15. 明确不采用的方案

### 15.1 本地 Router 调云端 Router

不作为默认架构。它会引入两套身份、两套任务状态和两套调度权威，难以判断本地目录、会话和产物究竟属于哪一层。

### 15.2 云端 Router 直接访问用户本地路径

不允许。云端没有用户电脑的可信文件系统边界，也不应通过网络暴露任意路径读取能力。

### 15.3 本机不可用时静默改用云端

不允许。执行位置是用户选择和隐私契约的一部分，自动改道会造成未授权的数据转移。

### 15.4 复制一套新的本地 Tool/Run 内核

不采用。Local Agent 应复用 `@zhujun/agentloop` 和现有 `visible_*` 工具，只新增设备、scope、存储和协议适配边界。

### 15.5 让前端 simulation 成为执行权威

不采用。simulation 只能把真实 Run、Assignment、Host 和阶段事件投影为 UI；不能在前端另造一套 Run 生命周期。

## 16. 决策结论

最终产品形态为：

> 一个 Multi Runtime 产品，云端统一管理身份和设备，用户按任务选择云端 Runtime 或本机 Local Runtime Agent；本机目录只在本机解析，云端产物由 Router 持久化，旧 `agentloop-app` 作为冻结的 legacy/reference 实现逐步退出产品入口。

本设计首先解决的是控制面、执行面、数据驻留和产物所有权的边界问题。具体代码实现应按迁移阶段推进，并在每一阶段通过对应的协议、隐私、故障和重启后验证，而不是通过针对单个场景的兼容分支完成。

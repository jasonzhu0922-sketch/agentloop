# 多 Runtime 负载分流设计

> 本文描述任务分流、容量和 Host Protocol。Run 状态已改为由 Router 与所有 Host 共用的状态库；关于故障接管，以及本地 SQLite 与生产 PostgreSQL 的切换方案，见[共享状态与故障接管设计](./MULTI-RUNTIME-SHARED-STATE-FAILOVER-DESIGN.md)。执行中 Run 的 lease/fencing 接管仍在后续阶段，不能把“共享状态库”误称为已实现的无损迁移。

## 1. 目标

当 AgentLoop 不再以单机方式部署时，让**不同用户的不同会话任务**被稳定分配到不同的 AgentLoop Runtime，以获得横向扩容、故障隔离和差异化运行环境。

```text
用户 A 的任务 ─┐
用户 B 的任务 ─┼─► 任务路由层 ─► Runtime 1 / Runtime 2 / Runtime N
用户 C 的任务 ─┘
```

每个被分配的任务仍然是一个完整的单 AgentLoop Run：由同一个 Runtime 完成 Plan、依赖调度、Step Agent Loop、Tool、Evidence、Assessment、Recovery 和 Terminal Committer。

## 2. 非目标

本设计明确不做以下事情：

- 不把一个用户任务拆成多个 Agent；
- 不把一个 Plan 的不同 Step 调度到不同 Runtime；
- 不让多个 Runtime 共同写一个 Run、Plan、Step 或 Evidence；
- 不根据模型文本、Tool 成功或 SSE 片段判定任务完成；
- 不通过用户 ID、模型名或某个 Tool 名做硬编码分流。

这些边界保证“负载分流”只是选择任务由哪个完整 Runtime 执行，而不会破坏 AgentLoop 内核的单一 Run 权威。

## 3. 三层部署模型

一个可用的多 Runtime 产品由三个部署角色组成。前端与 Router 是控制面，Runtime Host 是数据面；它们不是多个 Agent，也不共享 AgentLoop 的内部运行态。

### 3.1 `agentloop-multi-runtime-web`：用户会话前端

Web 只调用 Router 的公开会话 API。它负责用户登录后的会话展示、文件选择、消息提交、任务进度和最终 Outcome 呈现。

- Web 不保存 Runtime endpoint、调度策略、`remoteRunId`、`sourceId` 或工作区路径；
- Web 通过 Router 的 Task/Assignment 投影获取 SSE 进度，而不订阅 Runtime Host 的事件流；
- Web 上传文件到 Router 的附件入口，文件在路由之前没有归属到任何 Runtime；
- 浏览器提交的是用户意图与会话上下文，不能提交 `visibleDirectories`、本地路径或 Tool ID。

### 3.2 `agentloop-router`：会话任务入口与分流后端

Router 面向 Web、移动端或业务后端。它负责：

- 认证用户并创建会话任务；
- 维护 Runtime 节点注册、健康、容量和策略；
- 为新任务选择一个 Runtime；
- 持久化“任务 → Runtime → 远端 Run”的映射；
- 转发进度事件、取消请求和最终结果。

Router 不负责：Plan、Step、Tool、Evidence、Assessment 或 Recovery 的决策与写入。

Router 可以承载**应用集成与鉴权钩子**，但这不改变上述执行权威。例如企业业务 API、需要按租户授权的 MCP Source，或必须以用户身份调用的内部工具，可由 Router 统一解析身份、策略与密钥，并作为 Runtime Host 的受信任集成网关。Router 此时不规划 Step、不把某次上游调用自行判为完成，也不写入 Runtime 的 Canonical Evidence。

### 3.3 `agentloop-runtime-host`：可横向扩容的 Runtime 应用

每一个 Runtime Host 都加载 `@zhujun/agentloop`，并独立装配：

- `AppDatabase`、`SkillService`、`RunService`；
- 云主机或容器内的工作区、Skill Package Store、Computer/Plugin Tools；
- 该节点可用的模型、Provider、密钥和资源上限；
- AgentLoop Host Protocol API 与事件流。

Runtime Host 接收 Router 的可信任务委派后，创建本地 Run，并对该 Run 的完整生命周期负责。

```text
Router                    Runtime Host
──────                    ────────────
认证 / 路由               Run / Plan / Step
节点容量 / 健康           Capability Grant / Tool
任务映射 / UI 投影        Canonical Evidence / Assessment
取消请求转发             Recovery / Terminal Committer
```

## 4. 总体拓扑

```text
                 ┌──────────────────────────┐
Browser ────────►│ Multi Runtime Web         │
                 └───────────┬──────────────┘
                             │ public session API / SSE
                 ┌───────────▼──────────────┐
                 │ agentloop-router          │
                 │ - Auth integration        │
                 │ - Runtime registry        │
                 │ - Assignment store        │
                 │ - Router / event proxy    │
                 └───────────┬──────────────┘
                             │ Host Protocol
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Runtime Host A  │ │ Runtime Host B  │ │ Runtime Host C  │
│ AgentLoop kernel│ │ AgentLoop kernel│ │ AgentLoop kernel│
│ shared state DB │ │ shared state DB │ │ shared state DB │
│ shared workspace│ │ shared workspace│ │ shared workspace│
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

生产环境中 Router 可以多副本部署，并与 Runtime Host 连接同一个 PostgreSQL 状态库；Runtime Host 可以按不同 profile 横向扩容。Run、调度账本与 Host dispatch receipt 是共享的权威状态；Skill Package Store 仍可作为 Host 本地可丢弃缓存。所有 Runtime Host 挂载同一个任务工作区根。Router、Web 和 Runtime Host 之间仍只通过受控协议访问 Run、Artifact 和 Evidence，不能把共享 workspace 当作跨 Runtime 的数据库。

本仓库的参考应用会以一个 `apps/agentloop-multi-runtime` 目录承载这三种可执行角色：`web`、`router` 与 `runtime-host`。这只是源码组织；部署时它们是独立进程/容器，Runtime Host 可有任意多个实例。

## 5. 实例配置与部署

Router 的启动配置列出可委派的云端 Host；每个 Host 自己使用实例配置启动。实例数量不是内核参数，而是部署层中同一 Runtime Host 镜像的副本数。

```json
{
  "schema": "agentloop.multiRuntimeConfig/v1",
  "runtimes": [
    {
      "id": "general-01",
      "endpoint": "http://runtime-general-01:8791",
      "profile": "general",
      "capabilities": ["document", "web"],
      "maxConcurrentRuns": 4
    },
    {
      "id": "general-02",
      "endpoint": "http://runtime-general-02:8792",
      "profile": "general",
      "capabilities": ["document", "web"],
      "maxConcurrentRuns": 4
    }
  ]
}
```

对应的两个 Host 使用同一镜像、不同实例标识、同一个状态库和同一个任务工作区挂载：

```text
runtime-general-01: RUNTIME_ID=general-01, AGENTLOOP_STATE_DATABASE_URL=postgresql://..., WORKSPACE_ROOT=/workspace
runtime-general-02: RUNTIME_ID=general-02, AGENTLOOP_STATE_DATABASE_URL=postgresql://..., WORKSPACE_ROOT=/workspace
```

`AGENTLOOP_STATE_*` 必须在 Router 与所有 Host 中解析到同一逻辑数据库；本地可用共享 SQLite/WAL，生产必须使用 PostgreSQL。`WORKSPACE_ROOT` 必须映射到所有 Host 共同可读写的同一实际 POSIX 卷，且路径在每个容器内保持一致。`RunService` 在该根下使用 `conversations/<conversationId>` 隔离会话。Skill Package Store 不写入共享任务工作区，应位于 Host 自己的数据卷。Router 只有附件对象存储凭据；Web 没有任何 Runtime 凭据。云端 v1 的配置拒绝 `desktop` profile、`visibleDirectories` 和宿主机本地路径。

## 6. Router 承载的集成与鉴权钩子

Router 是用户身份与应用策略的稳定边界，因此可承载需要跨 Runtime 一致执行的集成钩子。它不是 AgentLoop 内核的新执行器；它通过现有的应用侧 `RuntimeTool` / `ToolSource` 适配接口接入。

```text
AgentLoop Step（某 Runtime Host）
  → 该 Host 注册的 Router Tool Adapter
  → Router 验证 Runtime 身份、assignmentId、remoteRunId 和用户授权
  → Router 注入短期上游凭据并调用企业 API / MCP / Plugin
  ← 结构化工具结果
  ← Host 依现有内核路径生成 Tool Receipt、Evidence、Assessment
```

适合放在 Router 的事情：

- 将浏览器登录态换成仅限某租户、用户、会话、Assignment 与 Run 的短期委派令牌；
- 统一租户策略、审计、配额、API 密钥轮换及外部应用 OAuth refresh；
- 作为企业 API、MCP 或 Plugin 的内部代理，向所有 Runtime 提供一致的 ToolSource；
- 在工具执行期间重新验证用户授权，避免 Runtime 保存浏览器 Cookie 或长期业务凭据。

仍必须留在 Runtime Host / 内核路径的事情：

- 依据 admitted `executionBinding` 与 Run grant 决定当前 Step 能否使用某个工具；
- 执行 Step Agent Loop、记录工具调用、生成 Canonical Evidence、Assessment、Recovery 和 Outcome；
- 将 Router 的结构化返回当作普通工具结果，而不是把 Router 的“调用成功”当作任务完成。

Router Tool Adapter 必须只接受来自可信 Runtime 的工作负载身份（mTLS、服务身份或短期签名），不能暴露给浏览器。它的请求上下文至少绑定 `tenantId`、`userId`、`conversationId`、`assignmentId`、`remoteRunId` 与过期时间；不得接受浏览器传入的 Tool ID、上游凭据或本地路径。

## 7. 核心对象与权威边界

### 7.1 Conversation Task

`ConversationTask` 是 Router 创建的用户请求记录，不是 AgentLoop Run。

```ts
interface ConversationTask {
  id: string;
  conversationId: string;
  ownerUserId: string;
  clientMessageId: string;
  input: string;
  requestedProfile?: string;
  status: "queued" | "assigned" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
}
```

它的职责是支持入口幂等、路由和 UI 展示。它不能承载 Plan、Step、Tool 调用或完成判定。

### 7.2 Runtime Assignment

`RuntimeAssignment` 把一个 Conversation Task 绑定到一个 Runtime。一次任务只创建一个有效 Assignment；重试复用同一 Assignment。

```ts
interface RuntimeAssignment {
  id: string;
  taskId: string;
  runtimeId: string;
  dispatchKey: string;
  remoteRunId?: string;
  status: "pending" | "accepted" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  lastEventSeq: number;
  createdAt: string;
  finishedAt?: string;
}
```

推荐的唯一约束：

```text
UNIQUE(owner_user_id, conversation_id, client_message_id)
UNIQUE(task_id)
UNIQUE(runtime_id, dispatch_key)
```

### 7.3 Runtime Instance

```ts
interface RuntimeInstance {
  id: string;
  endpoint: string;
  protocolVersion: "agentloop.hostProtocol/v1";
  profile: "general" | "artifact";
  capabilities: string[];
  status: "ready" | "draining" | "offline";
  maxConcurrentRuns: number;
  activeRunCount: number;
  lastHeartbeatAt: string;
}
```

Runtime Registry 中的能力是宿主声明的通用云端环境能力，例如 `document`, `web`, `high_memory` 或数据驻留区域。它不是用户可传入的 Tool 名称，也不是 Runtime 内部的资源 ID。

## 8. 任务分流流程

```text
1. 用户提交消息，Router 完成认证并写入 ConversationTask。
2. Router 查询会话亲和性、组织策略和 Runtime Registry。
3. Router 选择一个 ready 且有容量的 Runtime，原子写入 RuntimeAssignment。
4. Router 以 dispatchKey 调用该 Runtime 的异步 Host Run API。
5. Runtime 原子保存 dispatchKey → remoteRunId，创建本地 AgentLoop Run。
6. Runtime 自行完成完整的 AgentLoop 执行链。
7. Router 从远端事件流按 seq 投影进度；它不改变远端 Run 状态。
8. Router 读取远端已提交的 Outcome 后，才完成 ConversationTask。
```

现有 `GET /v1/host/protocol`、`POST /v1/host/runs/async`、Host Run 查询与 SSE 事件流可作为通信基础。正式多 Runtime 协议还需要增加 `assignmentId` 与 `dispatchKey` 的幂等语义。

```ts
interface RuntimeDispatchEnvelope {
  schema: "agentloop.runtimeDispatch/v1";
  assignmentId: string;
  dispatchKey: string;
  subject: { tenantId: string; userId: string };
  conversationId: string;
  input: string;
  requestedProfile?: string;
  requestedModelKey?: string;
  allowDangerousTools: boolean;
  resourceRefs: PortableResourceRef[];
}
```

`subject` 必须由 Router 通过 mTLS、工作负载身份或短期签名令牌断言。Runtime 不应接受浏览器直接指定 `userId`、本地工作区路径、内部 Tool 白名单或 Skill 路径。

## 9. 路由策略与会话亲和性

第一版路由应完全确定性，以便可解释和测试：

```text
1. 如果当前会话有可用的 preferredRuntimeId，优先继续使用。
2. 过滤不满足明确环境约束的节点：数据驻留、组织策略、Runtime profile。
3. 排除 offline、draining、协议不兼容和无可用槽位的节点。
4. 按利用率、排队长度和近期失败率排序，选择最优节点。
```

会话亲和性用于让后续用户消息自然复用上下文和工作区，但不是永久锁定：

- 同一会话的**新任务**默认仍路由到原 Runtime；
- 原 Runtime `draining`、离线或不满足新任务的明确环境约束时，才允许迁移；
- 迁移只发生在旧 Run 已终态、新 Run 尚未创建的边界；
- 不能迁移正在执行中的 Plan、Step、Tool Action、Recovery 或工作区路径。

如果新 Runtime 需要会话上下文，Router 只传递用户可见的历史消息、已经提交的 Outcome 摘要和已发布资源；不能复制旧 Runtime 的内部 Evidence、未完成 Action 或数据库行。

## 10. 容量、重试与故障

### 10.1 容量

准生产实现将静态节点配置与动态容量事实分开。Router 的控制面数据库持久化 Task、Assignment、Runtime 心跳与可过期预留；Host 则以自己的 Run 数据库作为最终容量准入依据。

Router 的候选有效负载为：

```text
effectiveUsed = max(hostHeartbeat.activeRunCount, routerTracked(reserved + accepted))
loadScore = (effectiveUsed + 0.5 × hostHeartbeat.queuedRunCount) / maxConcurrentRuns
```

只有 `ready` 且心跳未过期的静态节点参与排序。Router 以同一数据库事务创建唯一 ConversationTask、Assignment 和短期 reservation；随后才执行网络 dispatch。Host 在接受任务前计算：

```text
availableSlots = maxConcurrentRuns - activeRunCount - reservedDispatches
```

- 有槽位：原子保留槽位并创建本地 Run；
- 无槽位：返回可重试的 `RUNTIME_CAPACITY_EXHAUSTED`，不创建 Run；
- `draining`：拒绝新任务，继续服务已存在的 Run、事件、取消和 Recovery。

Host 接受后，Router 将 reservation 转为 accepted Assignment；Host 心跳报告实际 running 数。Host 的本地准入失败时，Router 释放 reservation；终态 Run 被 Router 观察到后才释放该 Assignment 对容量的占用。Router 根据容量选择其他候选 Runtime，或将 Task 保持在 `queued` 状态。它不在 Router 内执行 AgentLoop，也不通过增加全局超时掩盖 Worker 过载。

### 10.2 幂等

Router 必须先持久化 Task 与 Assignment 再发起网络请求。Worker 必须持久化 `dispatchKey → remoteRunId` 映射：

```text
收到重复 dispatchKey → 返回同一个 remoteRunId
收到新 dispatchKey 且有容量 → 创建一个 Run
```

这覆盖浏览器重试、Router 重试和网络超时，避免同一用户消息被执行两次。

### 10.3 故障

- SSE 断开：浏览器带最后 seq 重新连接 Router；Router 向原 Host 查询其持久 Run event log 并从该 seq 回补。Router 可额外持久投影，但不能把短暂 SSE 缓冲当作事件权威；
- Runtime 暂时失联：Task 标为 `unknown`，先查询 Host Run，不能直接标失败；
- Runtime 进程重启：由该 Runtime 的 AgentLoop Recovery 处理本地 Run；
- Runtime 永久不可恢复：旧 Run 保留其失败/未知事实；如用户需要重试，Router 创建一个新的 Task/Assignment，而不是把旧 Run 迁移到新节点。

## 11. 资源与产物

### 11.1 上传入口：文件先属于会话，不属于 Runtime

用户上传文件时，请求先到 Router。Router 将原始字节放入会话级 Artifact Broker / 对象存储，并创建控制面附件记录：

```ts
interface ConversationAttachment {
  id: string;
  tenantId: string;
  ownerUserId: string;
  conversationId: string;
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  objectRef: string;
  createdAt: string;
}
```

这条记录只描述“哪个用户会话拥有哪份不可变文件”，不包含 `runtimeId`、本地 `sourceId`、工作区路径或 Tool 名。Router 可以利用文件类型、大小和用户显式选择的环境约束参与路由，但不负责提取文件内容，也不生成 Source chunks。

### 11.2 分流后的本地导入：每个 Runtime 获得自己的 Source

Router 创建 `RuntimeAssignment` 后，为被选中的 Worker 生成最小权限、短期有效的资源引用：

```ts
interface PortableResourceRef {
  attachmentId: string;
  uri: string;
  sha256: string;
  mediaType: string;
  originalName: string;
}
```

Worker 在创建本地 Run 前执行：

```text
下载 PortableResourceRef
→ 验证租户/会话授权、媒体类型、字节数和 SHA-256
→ 调用该 Worker 本地的 Source Intake
→ 在该 Worker 的 sources/source_chunks 中创建本地 sourceId
→ 将本地 sourceId 绑定到本地 Run 的 run_sources
→ RunService.startConversation/executeConversation
```

这正好复用当前 AgentLoop 的 Source Intake 与 `run_sources` 绑定模型：Source 的所有者仍是 Router 断言的 opaque `userId`，Source 只能被绑定到同一会话的本地 Run。文件内容、文本抽取和 chunks 只落在执行该任务的 Runtime Host。

Router 应持久化导入映射，便于重试与审计：

```ts
interface AttachmentImport {
  assignmentId: string;
  attachmentId: string;
  runtimeId: string;
  remoteSourceId: string;
  sha256: string;
  importedAt: string;
}
```

`remoteSourceId` 只对该 Runtime 有意义，永远不暴露给浏览器，也不能作为另一个 Runtime 的输入。

### 11.3 工作区隔离继续有效

所有 Worker 挂载同一个 `WORKSPACE_ROOT`，但 RunService 以会话目录作为隔离边界。对会话 `conv_123` 而言，所有被 Router 正常路由到该会话的 Run 使用同一个目录：

```text
Runtime A: /srv/agentloop-workspace/conversations/conv_123/
Runtime B: /srv/agentloop-workspace/conversations/conv_123/
```

这是一份共享目录，但不是共享 Run：Router 的 Assignment 与会话亲和性确保一个未完成 Run 只由其 owning Runtime 执行。当前内核的会话工作区规则保持原样：同一会话的后续 Run 复用 `conversations/<conversationId>`，不同会话物理隔离；Skill Package Store 则保持在每个 Host 独立的数据卷中。

因此 Router 和 Worker 都不得：

- 传递 `workspace/conversations/...` 本地路径；
- 让多个 Runtime 同时执行同一个 Run，或绕过 Router/Host 协议直接读取其他会话目录；
- 用共享 SQLite 或 NFS 工作区试图“接力”执行一个未完成 Run；
- 将一个 Runtime 的未发布中间文件当作另一个 Runtime 的输入。

### 11.4 第一阶段隐藏可见目录能力

第一阶段只部署云端 Runtime，因此 Router 的外部任务接口不接收 `visibleDirectories` 或本机路径；Runtime Host 的 Dispatch Adapter 必须拒绝这两个字段，并始终以空 `visibleDirectories` 调用 `RunService`。用户文件只能通过本节的 `ConversationAttachment → PortableResourceRef → 本地 Source` 流程进入 Run。

这不要求修改 AgentLoop 内核：当前 `composeRunTools()` 只有在 Run 的 `visibleDirectories` grant 非空时才动态加入 `visible_*` Tools。云端 Host 不传入目录 grant 时，工具不会进入工具目录、Planner 或 Step Agent Loop。若基于现有参考 HTTP Server 组装 Host，必须在应用层省略或拒绝 `/v1/local-directories` 与 Run 请求中的 `visibleDirectories`，不能把参考应用的本地开发接口直接公开给 Router。

这不是删除或在内核新增“禁用开关”，而是在多 Runtime 云端应用中不授予目录能力，避免把某台机器的本地路径误解成集群资源或可迁移资源。额外增加内核开关会把宿主部署策略重复成第二套权限边界。

未来需要云边协同时，再新增显式的 edge Runtime profile、设备配对和目录授权协议。届时 Router 只能把目录任务路由到持有该授权的 edge Runtime；目录路径仍不可跨节点传递，且该能力必须默认关闭、由用户和组织策略共同显式授权。

### 11.5 会话亲和性、迁移与产物

会话亲和性只是健康 Host 的调度偏好：后续新任务优先原 Host；原 Host 失联、draining 或满载时，Router 选择另一台兼容且有容量的 Host，并持久化迁移记录。正在执行的 Run 不会被此规则迁移。若需要将已终态的会话新 Run 迁移到另一个 Runtime：

1. Router 重新向新 Runtime 提供原始 `ConversationAttachment` 引用；新 Worker 重新导入，得到新的本地 `sourceId`。
2. 需要复用的最终产物由旧 Worker 发布到 Artifact Broker，带摘要、媒体类型和访问控制；新 Worker 把它作为新的本地 Source/Artifact 导入。
3. 不迁移旧 Run 的 Plan、Step、Evidence、RuntimeAction、未完成 Tool 调用或工作区中间文件。

用户下载最终产物也应优先经 Artifact Broker 的不可变对象引用，或由 Router 受控代理到产物所属 Worker；不能向用户暴露 Worker 本地路径。这样即使 Worker 轮换、draining 或扩缩容，完成的会话产物仍可安全访问。

## 12. 安全与观测

安全边界：

- 浏览器只访问 Router；Runtime Host 只接受可信 Router。
- Router 请求危险工具权限，Runtime 仍根据节点组织策略、Runtime Profile 与 AgentLoop Capability Grant 最终审核。
- 每个 Runtime 最小化配置自己的 Tool、Skill、模型与密钥；不能因路由而扩大节点能力。
- Host Projection 和 Router 事件投影必须脱敏内部路径、工具敏感参数和密钥。

应监控：

```text
router_assignment_queue_seconds
runtime_active_runs
runtime_available_slots
runtime_dispatch_idempotency_hits
runtime_event_lag_seconds
runtime_terminal_failure_rate
conversation_runtime_migrations_total
```

## 13. 分阶段落地

1. 抽取现有参考应用的 Host Protocol 使用方式，增加 Runtime Instance 静态注册与健康检查。
2. 实现 Router 的 ConversationTask、RuntimeAssignment、确定性路由和单 Runtime 委派。
3. 在 Runtime Host 增加可信身份、`dispatchKey` 幂等和容量准入。
4. 接入 SSE 事件投影、Outcome 回读、取消转发和 `draining`。
5. 接入可验证资源引用和会话新 Run 边界迁移。
6. 最后再引入动态扩缩容、区域路由和更复杂的容量预测。

## 14. 验收案例

1. 用户 A 和用户 B 同时提交独立任务，Router 将二者分配到不同 Runtime；两个 Runtime 各自产生独立 Run、Plan、Evidence 和 Outcome。
2. `runtime-general-01` 已满时，用户 C 的普通任务被分配到另一个同 profile 的云端节点；不会被分配到不满足产物任务约束的节点。
3. Router 对同一个 `clientMessageId` 重试三次，Worker 只创建一个 `remoteRunId`。
4. Router 在 SSE 中断后按 seq 回补，并且只在读取到远端 Terminal Outcome 后完成本地 Task。
5. 一个会话的后续新任务优先健康的 Runtime affinity；节点进入 draining、失联或满载后，下一新任务迁移，旧 Run 不迁移。
6. 云端 Router 拒绝 `visibleDirectories` 和本机路径；云端 Runtime Host 的 Tool 目录不含 `visible_*`。

## 15. 参考应用案例：多 Runtime 智能工作台

本设计最终可落为一个可运行的参考案例：`apps/agentloop-multi-runtime`。它模拟一个企业智能工作台，多个用户从同一 Web 入口提交各自独立的会话任务，系统将任务分流至不同 Runtime Host。

```text
apps/agentloop-multi-runtime/
├── router/                       会话入口、认证适配、节点注册、分流、事件聚合
├── runtime-host/                 同构 Worker 程序：加载 @zhujun/agentloop
├── web/                          会话列表、任务进度、实际 Runtime 标识
├── compose.yaml                  1 Router + 3 Runtime Host + 可选对象存储
└── README.md                     一键启动、模拟任务、扩缩容说明
```

`runtime-host/` 是同一个应用镜像，通过环境变量配置运行 profile、容量和工作区；示例不为每个用户或每类任务复制一份业务代码：

```text
RUNTIME_ID=runtime-a   RUNTIME_PROFILE=general   MAX_CONCURRENT_RUNS=2
RUNTIME_ID=runtime-b   RUNTIME_PROFILE=general   MAX_CONCURRENT_RUNS=2
RUNTIME_ID=runtime-c   RUNTIME_PROFILE=artifact  MAX_CONCURRENT_RUNS=1
```

### 15.1 演示流程

| 用户 | 独立任务 | Router 选择 | 预期结果 |
|---|---|---|---|
| 用户 A | “整理本周项目风险” | `runtime-a` | A 的完整 Run 在 A 执行并提交 Outcome |
| 用户 B | “总结上传的制度文件” | `runtime-b` | B 的完整 Run 在 B 执行并提交 Outcome |
| 用户 C | “生成并校验 PDF 报告” | `runtime-c` | C 的完整 Run 在 C 执行并提交 Artifact Outcome |

三个任务可以同时运行，但彼此没有共享 Plan、Step、Evidence、工作区或 Agent 身份。Web 通过 Router 展示每个任务的 `runtimeId`、远端 Run 状态和事件投影，使负载分流可观察。

### 15.2 负载分流演示

将 `runtime-a` 的并发上限设为 2：

```text
用户 A、B 的普通任务 → runtime-a（占满 2 个槽位）
用户 D 的普通任务    → Router 发现 runtime-a 已满 → runtime-b
runtime-a 进入 draining → 后续新任务 → runtime-b 或其他 ready 节点
```

此演示验证的是调度层的容量分流，而不是把用户 D 的一个任务分为多个 Agent。每个 Runtime Host 都使用相同 AgentLoop 内核流程；区别仅在 Router 选择了哪一个节点启动其本地 Run。

### 15.3 最小验收

参考应用完成后应能证明：

1. 两个不同用户的任务可同时在不同 Runtime Host 上完成。
2. Worker 容量耗尽时，新的独立任务会转发至另一个合格节点。
3. 重试同一个浏览器消息只产生一个远端 Run。
4. 关闭一个 Worker 的新任务接收后，已有 Run 保持可查询，新任务不再被路由过去。
5. Router 展示的是远端已提交 Outcome，而不是根据 SSE 或 Tool 成功推断完成。

# AgentLoop Connector 体系设计

## 1. 设计目标

AgentLoop 需要连接飞书、金山文档、126 邮箱等外部业务系统。连接能力应满足：

- 外部系统接入方式统一；
- Connector 可独立开发、版本化和部署；
- 应用负责连接与授权持久化；
- Runtime 负责加载、实例化和执行；
- AgentLoop Kernel 负责理解任务、匹配能力、规划执行和验证证据；
- Connector 可原生接入 AgentLoop，也可通过 MCP 暴露；
- 平台细节不进入 AgentLoop 内核；
- 凭据、权限和外部 API 调用不进入 Planner；
- 外部读取和写入可审计、可恢复、可评估。

核心原则：

```text
Connector 负责外部系统能力
Application 负责业务持久化与授权
Runtime 负责运行时管理和执行
AgentLoop Kernel 负责任务理解、能力匹配、规划和结果判断
```

## 2. 总体架构

```text
用户需求
  ↓
AgentLoop Kernel
  ↓
Connector Capability Catalog
  ↓
Outcome Plan
  ↓
Admission / Capability Grant
  ↓
Runtime Host
  ↓
Connector Instance
  ↓
飞书 / 金山文档 / 126 邮箱
  ↓
Canonical Evidence
  ↓
AgentLoop Kernel
```

Connector 是一个独立模块：

```text
Connector Module
├── Definition
├── Connection
├── Capability
├── Source
├── Operations
├── Execution
├── Evidence Mapping
└── Adapters
    ├── AgentLoop Adapter
    ├── Runtime Adapter
    └── MCP Adapter
```

## 3. Connector 的定义

Connector 是一个自包含的外部系统领域模块，封装：

- 平台 API Client；
- 认证与连接能力；
- 资源模型；
- 能力声明；
- 读写操作；
- 分页、限流和重试；
- 错误映射；
- Source 标准化；
- Evidence 标准化；
- RuntimeTool / MCP 适配。

Connector 不拥有应用数据库，也不负责 AgentLoop Run 状态。

## 4. Connector、Connection 和 Source

### 4.1 Connector Definition

表示如何接入某个平台：

```ts
interface ConnectorDefinition {
  key: string;
  version: string;
  displayName: string;
  description: string;
  supportedAuthModes: readonly AuthMode[];
  capabilities: readonly ConnectorCapabilityDefinition[];
}
```

### 4.2 Connection Instance

表示某个用户或 Workspace 授权的外部账号：

```ts
interface ConnectionRecord {
  id: string;
  connectorKey: string;
  ownerType: "user" | "workspace";
  ownerId: string;
  externalAccountId?: string;
  scopes: readonly string[];
  credentialRef: string;
  status: "active" | "expired" | "revoked" | "error";
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}
```

### 4.3 Source

表示本次运行中访问的具体外部数据：

```ts
interface ExternalSource {
  id: string;
  connectionId: string;
  connectorKey: string;
  kind: SourceKind;
  externalId: string;
  title?: string;
  locator?: string;
  contentType?: string;
  modifiedAt?: number;
  snapshotAt: number;
  contentHash?: string;
}
```

三者关系：

```text
Connector Definition = 平台接入方式
Connection Instance = 某个授权账号
Source = 该账号下的一份具体外部数据
```

## 5. Connector 内部层次

### 5.1 Definition Layer

描述 Connector 名称、版本、平台、授权方式、资源类型、能力和 API 版本：

```ts
interface ConnectorManifest {
  schema: "agentloop.connectorManifest/v1";
  key: string;
  version: string;
  agentloopSdk: string;
  apiVersion?: string;
  capabilities: readonly ConnectorCapabilityDefinition[];
}
```

### 5.2 Connection Layer

负责 OAuth、Token 刷新、API Key、IMAP/SMTP、企业内部凭据和连接健康检查。

凭据由宿主注入：

```ts
interface CredentialProvider {
  get(ref: string): Promise<Credential>;
}
```

Connector 不决定凭据保存在哪里。

### 5.3 Capability Layer

描述 Connector 能做什么：

```ts
interface ConnectorCapabilityDefinition {
  id: string;
  category: "source" | "read" | "write" | "event";
  label: string;
  description: string;
  sourceKinds: readonly SourceKind[];
  producesEvidenceKinds: readonly EvidenceKind[];
  risk: "low" | "medium" | "high";
  replaySafe: boolean;
  requiresConfirmation?: boolean;
}
```

例如：

```ts
{
  id: "document.search",
  category: "source",
  sourceKinds: ["document"],
  producesEvidenceKinds: [
    "source_summary",
    "source_urls",
    "explicit_caveats"
  ],
  risk: "low",
  replaySafe: true
}
```

### 5.4 Operation Layer

定义具体读写操作：

```ts
interface ConnectorOperation {
  id: string;
  mode: "read" | "write";
  capabilityId: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  timeoutMs?: number;
  executionMode: "parallel" | "exclusive";
  replaySafe: boolean;
  requiresConfirmation?: boolean;
}
```

示例：

```text
feishu.document.search
feishu.document.read
feishu.file.download
feishu.document.create
feishu.document.update
```

### 5.5 Execution Layer

负责实际执行：

```ts
interface ConnectorExecutionContext {
  connection: ConnectionContext;
  runId: string;
  workspaceId?: string;
  actorUserId: string;
  signal?: AbortSignal;
  credentialProvider: CredentialProvider;
}
```

```ts
interface ConnectorExecutionResult {
  operationId: string;
  data: unknown;
  externalRequestId?: string;
  sourceRefs?: readonly ExternalSourceRef[];
  warnings?: readonly string[];
  retryable?: boolean;
}
```

### 5.6 Evidence Mapping Layer

把平台结果转成 AgentLoop 标准 Evidence：

```ts
interface EvidenceMapper {
  map(
    result: ConnectorExecutionResult,
    context: EvidenceContext
  ): readonly CanonicalEvidence[];
}
```

```ts
interface CanonicalEvidence {
  schema: "agentloop.canonicalEvidence/v1";
  evidenceId: string;
  connectorKey: string;
  connectionId: string;
  operationId: string;
  sourceRefs: readonly ExternalSourceRef[];
  facts: readonly Record<string, unknown>[];
  evidenceKinds: readonly EvidenceKind[];
  retrievedAt: number;
  caveats: readonly string[];
  contentHash?: string;
}
```

## 6. AgentLoop Kernel 的职责

### 6.1 理解用户需求

例如：

> 从飞书项目文档和 126 邮箱中找出项目延期原因，生成报告。

Kernel 识别：

```text
任务类型：source-grounded analysis
来源类型：document + email
需要能力：
  document.search
  document.read
  email.search
  email.read
交付类型：report
必须证据：
  source_summary
  source_urls
  explicit_caveats
  artifact_acceptance
```

### 6.2 匹配 Connector 能力

Kernel 主要匹配能力，不直接匹配平台名称：

```text
需要 document.search
→ Feishu Connector
→ WPS Connector
→ 其他 document Connector
```

用户明确指定平台时，Connector identity 成为约束。

### 6.3 规划 Connector 执行能力

Planner 输出最小 OutcomePlan：

```ts
{
  shape: "fact_then_produce",
  leaves: [
    {
      id: "acquire-sources",
      role: "fact_acquisition",
      requiredCapabilities: [
        "document.search",
        "document.read",
        "email.search",
        "email.read"
      ],
      evidenceContract: {
        requiredKinds: [
          "source_summary",
          "source_urls",
          "explicit_caveats"
        ]
      }
    },
    {
      id: "produce-report",
      role: "produce",
      requiredCapabilities: [
        "artifact_generation",
        "artifact_acceptance"
      ]
    }
  ]
}
```

Planner 不负责 OAuth、Token、平台 API 参数、Connector 内部分页、重试流程或用户授权判断。

### 6.4 判断结果是否完成

Kernel 根据 Connector Evidence、Source 引用、Artifact Evidence、Assessment、Skill Compliance 和 Terminal Commit 判断任务是否完成。

## 7. Runtime 的职责

Runtime 负责 Connector 的运行时管理。

### 7.1 Connector Registry

```ts
interface ConnectorRegistry {
  register(definition: ConnectorDefinition): void;
  unregister(key: string, version: string): void;
  list(): readonly ConnectorDefinition[];
  resolve(key: string, version?: string): ConnectorDefinition;
}
```

Registry 管理：

- Connector 包；
- Connector 版本；
- 是否启用；
- 健康状态；
- AgentLoop SDK 兼容性；
- 支持的部署环境。

### 7.2 Connector Instance Manager

```ts
interface ConnectorInstanceManager {
  create(input: {
    connectorKey: string;
    version?: string;
    connection: ConnectionRecord;
    credentialProvider: CredentialProvider;
    runId: string;
  }): Promise<ConnectorInstance>;

  release(instanceId: string): Promise<void>;
}
```

### 7.3 动态能力注入

能力注入按以下顺序过滤：

```text
Connector Registry
→ 应用启用的 Connector
→ Workspace 可用的 Connector
→ 用户已授权的 Connection
→ Run Capability Grant
→ 当前 Step Tool Projection
```

最终注入 AgentLoop：

```ts
interface ConnectorProjection {
  source: ToolSourceDescriptor;
  capabilities: readonly PlanningCapability[];
  tools: readonly RuntimeTool[];
}
```

Connector 可以动态注册，但 Agent 每一轮只能看到当前 Step 已授权的工具。

## 8. Application 的职责

应用负责 Connector 的持久化和管理：

- Connector 安装记录；
- Connector 启停；
- Connection 持久化；
- OAuth 回调；
- Credential 引用；
- User / Workspace 绑定；
- Scope；
- 授权撤销；
- 连接健康状态；
- 审计日志；
- Connector 版本升级；
- 租户隔离。

Connector 不依赖具体 ORM，只依赖宿主注入的抽象：

```ts
interface ConnectionResolver {
  resolve(connectionId: string): Promise<ConnectionRecord>;
}

interface CredentialProvider {
  get(credentialRef: string): Promise<Credential>;
}
```

## 9. AgentLoop Adapter

Connector 通过 Adapter 接入内核：

```ts
interface AgentLoopConnectorAdapter {
  toRuntimeTools(
    instance: ConnectorInstance
  ): readonly RuntimeTool[];

  toCapabilities(
    definition: ConnectorDefinition
  ): readonly PlanningCapability[];

  toSourceProviders(
    definition: ConnectorDefinition
  ): readonly SourceProviderDescriptor[];

  mapEvidence(
    result: ConnectorExecutionResult
  ): readonly CanonicalEvidence[];
}
```

转换关系：

```text
Connector Operation
→ RuntimeTool

Connector Capability
→ PlanningCapability

Connector Source
→ SourceProvider

Connector Result
→ Canonical Evidence
```

## 10. MCP 适配

MCP 是 Connector 的一种暴露方式，而不是 Connector 本身：

```text
Connector Module
├── Native AgentLoop Adapter
└── MCP Adapter
```

原生接入：

```text
Connector → RuntimeTool → AgentLoop Kernel
```

MCP 接入：

```text
Connector → MCP Server Adapter → MCP Client → RuntimeTool → AgentLoop Kernel
```

外部 MCP Server 也可以被包装成临时 Connector，但长期维护的核心 Connector 应保留自己的 Connection、Source 和 Evidence 语义。

## 11. 完整运行流程

以“整理飞书文档和 126 邮箱中的项目资料”为例：

```text
1. 用户授权飞书和 126 邮箱
2. 应用保存 ConnectionRecord
3. Runtime Registry 加载两个 Connector
4. Runtime 获取 Connector Capability Catalog
5. AgentLoop Kernel 理解用户需求
6. Planner 匹配 document.search / email.search
7. Admission 校验用户授权和 Run Grant
8. Runtime Host 创建 Connector Instance
9. Connector 暴露 RuntimeTool
10. Agent 调用搜索和读取工具
11. Connector 访问外部 API
12. Evidence Mapper 生成 Canonical Evidence
13. Evidence 回到 AgentLoop Context
14. Agent 生成报告
15. Assessment 验证来源、结论和产物
16. Terminal Committer 提交最终 Outcome
17. Runtime 释放 Connector Instance
```

## 12. Run 级授权快照

Connector Registry 和 Connection 状态可以动态变化，但一个正在运行的 Run 不应随意变化。

```ts
interface ConnectorGrant {
  connectionId: string;
  connectorKey: string;
  connectorVersion: string;
  allowedCapabilityIds: readonly string[];
  allowedOperationIds: readonly string[];
  scopes: readonly string[];
  snapshotHash: string;
}
```

Run 使用不可变的 Connection Grant 和 Capability Snapshot，避免执行过程中 Connector 版本、权限和工具列表漂移。

## 13. 读写能力和风险控制

| 操作 | 模式 | 风险 | 默认策略 |
|---|---|---:|---|
| 搜索文档 | read | low | 允许 |
| 读取邮件 | read | low | 允许 |
| 下载附件 | read | medium | 允许但限范围 |
| 创建文档 | write | medium | 可配置 |
| 修改表格 | write | high | 需要授权 |
| 发送邮件 | external side effect | high | 默认确认 |
| 删除文件 | destructive | high | 默认禁止 |

写操作需要声明：

```ts
{
  mode: "write",
  replaySafe: false,
  requiresConfirmation: true,
  idempotencyKeyRequired: true
}
```

## 14. 连接器维护方式

每个 Connector 独立版本化：

```text
@agentloop/connector-feishu
@agentloop/connector-wps
@agentloop/connector-126mail
```

每个 Connector 应包含：

- Manifest；
- API 版本；
- AgentLoop SDK 兼容范围；
- 能力清单；
- Scope 清单；
- Operation Schema；
- 错误映射；
- Mock API；
- Contract Test；
- 限流测试；
- Evidence 快照测试；
- 版本迁移说明。

测试分三层：

```text
Connector Unit Test
→ API / 数据转换 / 错误处理

Connector Contract Test
→ 是否符合 Connector SDK

AgentLoop Integration Test
→ 是否能注册 Capability、执行 Tool、生成 Evidence

Runtime E2E
→ OAuth、Host、恢复、审计和真实外部系统
```

## 15. 推荐包结构

```text
packages/
├── connector-sdk/
│   ├── definition.ts
│   ├── connection.ts
│   ├── capability.ts
│   ├── source.ts
│   ├── operation.ts
│   ├── execution.ts
│   ├── evidence.ts
│   └── adapters.ts
│
├── connector-feishu/
│   ├── manifest.ts
│   ├── client.ts
│   ├── connection.ts
│   ├── source-models.ts
│   ├── operations.ts
│   ├── evidence-mapper.ts
│   └── adapters/
│       ├── agentloop.ts
│       └── mcp.ts
│
├── connector-wps/
└── connector-126mail/
```

AgentLoop 内核：

```text
packages/agentloop/src/connectors/
├── connector-types.ts
├── connector-projection.ts
├── connector-capability-binding.ts
├── connector-tool-adapter.ts
└── connector-evidence.ts
```

Runtime：

```text
apps/agentloop-multi-runtime/src/connectors/
├── connector-registry.ts
├── connector-instance-manager.ts
├── connection-resolver.ts
├── credential-provider.ts
└── connector-health.ts
```

应用：

```text
apps/agentloop-multi-runtime/src/control-plane/
├── connection-repository.ts
├── connector-installation-repository.ts
├── oauth-routes.ts
└── connector-permission-service.ts
```

## 16. 最终职责边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| Connector SDK | 统一连接器协议 | 具体平台实现 |
| 具体 Connector | 平台 API、连接、Source、Operation、Evidence | AgentLoop Run 状态 |
| AgentLoop Kernel | 任务理解、能力匹配、规划、授权校验、Evidence、Assessment | OAuth 和平台 API |
| Runtime | Connector 注册、实例化、动态注入、执行生命周期 | 决定业务结果 |
| Application | 持久化、用户授权、Workspace、凭据引用、审计 | 外部 API 领域逻辑 |
| Runtime Host | 外部调用、超时、重试、恢复 | 规划用户任务 |
| MCP Adapter | 连接器的 MCP 暴露 | 连接器核心语义 |

## 17. 首期落地建议

建议按以下顺序落地：

```text
1. connector-sdk
2. Connector Manifest
3. ConnectionRecord 和 CredentialProvider
4. Runtime Connector Registry
5. AgentLoop Tool / Capability / Evidence Adapter
6. 飞书只读 Connector
7. Runtime Host 动态注入
8. 飞书专业场景验证
9. MCP Adapter
10. 金山文档和 126 邮箱
11. 受控写入能力
```

第一个闭环：

```text
用户授权飞书
→ Application 持久化 Connection
→ Runtime Host 加载 Connector
→ AgentLoop 匹配 document.search / document.read
→ Connector 返回标准 Source
→ Evidence Mapper 生成证据
→ Agent 生成报告
→ Assessment 验证来源
→ Terminal Committer 交付
```

## 18. 结论

```text
Connector 是独立的外部系统领域模块；
Application 管理持久化和授权；
Runtime 管理加载和执行；
AgentLoop Kernel 理解用户任务、匹配 Connector 能力、规划执行并验证结果；
MCP 是 Connector 的一种可选适配出口。
```

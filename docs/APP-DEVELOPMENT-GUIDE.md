# 基于 AgentLoop 内核开发应用

本文面向把 `@zhujun/agentloop` 当作智能体运行内核嵌入自己应用的开发者。重点说明三件事：

1. 应用和内核的职责边界。
2. 一个应用如何装配数据库、模型、Skill、工具和用户体系。
3. `@zhujun/agentloop` 当前到底暴露了哪些公开接口。

相关背景见 [KERNEL-DELIVERY-PLAN](KERNEL-DELIVERY-PLAN.md) 和 [INTEGRATION](INTEGRATION.md)。参考应用在 `apps/agentloop-app`。

---

## 1. 总体边界

`@zhujun/agentloop` 是 headless kernel，不包含 HTTP server、登录注册、前端页面和业务用户表。

内核负责：

- Run 生命周期：规划、执行、评估、恢复、完成提交。
- Skill 发现、私有 Skill、Skill 可见性过滤、Skill 正文加载。
- 工具目录、能力授权、危险工具门控、工具证据持久化。
- 会话、Run、Plan、Source、Batch、Recovery 等运行态持久化。
- 模型适配层和 OpenAI-compatible provider 注册表。
- 工作区 containment、产物发现、命令输出和工具参数读取。

应用负责：

- 用户、登录、会话、组织、角色、业务权限。
- HTTP/RPC/API 层和前端。
- 业务数据和业务 DAL。
- LLM provider 配置和密钥注入。
- 自定义 Skill 目录、自定义工具、自定义可见性策略。
- 是否使用 SQLite、PostgreSQL，或自己的 SkillStore。

最重要的身份契约：

```text
app authenticate -> app user.id -> RunService / SkillService / BatchService
```

内核只认 opaque `userId` 字符串。它不会解释、验证或创建用户，也不会要求这个 id 存在于内核表中。

---

## 2. 最小应用装配

```ts
import {
  AppDatabase,
  LlmProviderRegistry,
  RunService,
  SkillService,
  createWebTools,
} from "@zhujun/agentloop";

const database = new AppDatabase("./data/agentloop.db");
await database.ready();

const providers = await LlmProviderRegistry.fromConfigFile("./config/llm-providers.json");

const skills = new SkillService(database, {
  skillDirectories: ["/path/to/agentloop-skills", ...extraSkillDirectories],
});
await skills.syncSkillDirectories();

const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, modelKey) => providers.create(modelKey, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot: "./workspace",
  tools: createWebTools({
    searchProvider: "baidu",
    searchApiKey: process.env.WEB_SEARCH_API_KEY,
  }),
});

const run = await runs.execute("opaque-user-id", "生成一份项目周报");
```

应用 API 层通常这样调用：

```ts
app.post("/runs", async (req, res) => {
  const user = await requireLogin(req);
  const run = await runs.start(user.id, req.body.input, {
    modelKey: req.body.modelKey,
    allowDangerousTools: req.body.allowDangerousTools,
    conversationId: req.body.conversationId,
    visibleDirectories: req.body.visibleDirectories,
    sourceIds: req.body.sourceIds,
  });
  res.status(202).json({ run });
});
```

---

## 3. 应用目录建议

参考应用采用这个结构：

```text
apps/agentloop-app/
├── .env
├── config/
│   └── llm-providers.json
├── custom-skills/
│   └── <skill-name>/
│       └── SKILL.md
├── data/
│   └── agentloop.db
├── src/
│   ├── auth/
│   ├── http/
│   └── main.ts
├── web/
└── workspace/
    ├── conversations/
    ├── uploads/
    └── .agentloop/skill-packages/
```

内核自带 Skill 来自 `@zhujun/agentloop-skills`。参考应用的 `custom-skills/` 是额外 Skill 目录，但不会被源码隐式扫描，而是通过 `.env` 中的 `CUSTOM_SKILL_DIRECTORIES_JSON` 显式配置；启动时它与内核目录合并后传给 `SkillService`：

```ts
const skills = new SkillService(database, {
  skillDirectories: [
    ...bundledSkillDirectories(),
    ...extraSkillDirectories,
  ],
});
```

每个额外 Skill 根目录必须是目录包形式。发现器扫描每个 discovery root 的直接子目录，只认 `<name>/SKILL.md`，会忽略 zip 文件。

内核自带 Skill 目录不放进 `.env`，参考应用会用 `bundledSkillDirectories()` 固定解析它。应用或部署环境需要额外加载 Skill 时配置：

```bash
CUSTOM_SKILL_DIRECTORIES_JSON='["./custom-skills"]'
```

`SKILL_PACKAGE_STORE_ROOT` 也不作为应用配置暴露；参考应用固定从 `WORKSPACE_ROOT` 派生为 `<workspaceRoot>/.agentloop/skill-packages`。

启动时必须把应用决定的所有扩展目录传给内核，并调用 `skills.syncSkillDirectories()`。这个内核方法会检查目录、扫描包、处理跨目录重名、同步 `discovered_skills`，并刷新已安装包元数据。

---

## 4. Skill 包契约

一个可被发现并参选规划的 Skill 至少需要：

```markdown
---
name: html-report
description: 生成单文件 HTML 报告、仪表盘和演示材料。
agentloop:
  roles:
    - primary_builder
  artifactKinds:
    - html
  sourceKinds: []
  qaKinds: []
  executionProfiles: []
---

# Workflow

这里写领域工作流。正文是 Skill 的权威说明。
```

规则：

- 目录名必须等于 frontmatter `name`。
- `name` 使用 lowercase kebab-case，最长 80 字符。
- `description` 必填，Planner 会用它理解 Skill 用途。
- 没有 `agentloop:` 元数据的 Skill 可以被发现，但不会进入 Planner 候选。
- `agentloop:` 字段、类型和可选值以 `packages/agentloop/src/skills/agentloop-metadata.ts` 为权威；`sourceKinds` 只能使用通用源类型：`api`、`database`、`dataset`、`document`、`repository`、`rubric`、`web`。
- 业务源名称和行业模型名称写进 Skill 正文或 references，不写进 `sourceKinds`。
- 跨目录同名 Skill 会 fail-closed。
- 同级 `<name>.disabled.json` 可显式禁用一个目录包。
- 同级 `<name>.source.json` 可提供可验证来源，不改变包内容 hash。

---

## 5. 用户与权限

内核的所有面向用户的服务都要求调用方传入 `actorUserId` 或 `ownerUserId`。

典型映射：

```ts
const user = await auth.authenticate(request);
await runs.execute(user.id, input);
await skills.create(user.id, skillInput);
await batches.create(user.id, batchInput);
```

内核保证：

- `RunService.get/list/events/plan/...` 按 `owner_user_id` 隔离。
- `SkillService.list/get/create/...` 按 `ownerUserId` 隔离私有 Skill。
- `BatchService.get/items` 按 `ownerUserId` 隔离。
- 不存在的资源和别人的资源都返回 not found 语义，避免 id ownership oracle。

内核不负责：

- 用户是否登录。
- 用户是否属于某租户。
- 用户是否购买了某模块。
- 用户是否能读取某业务对象。

这些必须由应用完成。工具内的数据级权限尤其关键：

```ts
async execute({ grant }, input) {
  const doc = await businessStore.loadDocument(input.docId);
  if (doc.ownerUserId !== grant.actorUserId) throw new Error("forbidden");
  return analyze(doc);
}
```

---

## 6. 模型配置

推荐用 `LlmProviderRegistry`，配置文件只存环境变量名，不存密钥本体。

```json
{
  "defaultProvider": "default",
  "defaultModelKey": "gpt-5",
  "providers": {
    "default": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "defaultModel": "gpt-5",
      "contextWindowTokens": 128000,
      "maxOutputTokens": 8192,
      "timeoutMs": 120000,
      "maxAttempts": 3,
      "retryDelayMs": 1000,
      "toolChoiceMode": "native",
      "runtimeContextPlacement": "system",
      "protocol": "responses"
    }
  },
  "models": {
    "gpt-5": {
      "providerKey": "default",
      "providerModel": "gpt-5",
      "displayName": "GPT-5"
    }
  }
}
```

入口：

```ts
const providers = await LlmProviderRegistry.fromConfigFile(path);
const providers = await LlmProviderRegistry.fromConfigFile(path, vaultEnvironment);
const providers = LlmProviderRegistry.fromConfigObject(config, vaultEnvironment);
const providers = LlmProviderRegistry.fromEnvironment(process.env);
```

`RunService` 只接收 `modelKey`。base URL、provider model、API key、协议、上下文限制都由服务端配置控制，不能由 Run 输入覆盖。

---

## 7. 自定义工具

工具实现 `RuntimeTool<TInput>`：

```ts
import type { RuntimeTool } from "@zhujun/agentloop";

export const queryCaseTool: RuntimeTool<{ caseId: string }> = {
  name: "query_case",
  description: "按案件 ID 查询业务系统中的案件事实和材料摘要。",
  inputSchema: {
    type: "object",
    properties: {
      caseId: { type: "string" },
    },
    required: ["caseId"],
    additionalProperties: false,
  },
  executionMode: "parallel",
  replaySafe: true,
  timeoutMs: 30_000,
  maxResultCharacters: 50_000,
  parse(input) {
    if (typeof input !== "object" || input === null || typeof (input as { caseId?: unknown }).caseId !== "string") {
      throw new Error("caseId is required");
    }
    return input as { caseId: string };
  },
  async execute({ grant, signal }, input) {
    signal?.throwIfAborted();
    return caseStore.loadForUser(grant.actorUserId, input.caseId);
  },
};

const runs = new RunService({
  database,
  skills,
  modelFactory,
  tools: [queryCaseTool],
});
```

字段含义：

- `name`：工具名，必须全局唯一。
- `description`：Planner 和模型理解工具用途的主要依据。
- `inputSchema`：给模型看的 JSON Schema。
- `executionMode`：`parallel` 适合纯读，`exclusive` 适合副作用或全局资源。
- `replaySafe`：恢复流程能否安全重放。
- `timeoutMs`：一次工具调用的 Runtime Action deadline。
- `maxResultCharacters`：结果进入上下文前的截断上限。
- `parse`：把模型参数校验成强类型输入。
- `execute`：真实执行业务逻辑。

内置工具可通过工厂组合：

```ts
createWebTools({ searchProvider: "baidu" | "bing", searchEndpoint?, searchApiKey? })
createComputerTools(...)
createSourceTools(...)
createVisibleDirectoryTools(...)
createSkillLoader(...)
createCoreTools(...)
composeRunTools(...)
```

一般应用只需要显式注入业务工具和 `createWebTools()`。Computer/source/skill loader 等核心工具由 `RunService` 内部通过 `createCoreTools()` 组装。

---

## 8. 数据库与持久化

默认 SQLite：

```ts
const database = new AppDatabase("./data/agentloop.db");
await database.ready();
```

注入已有连接：

```ts
const database = await AppDatabase.open({
  connection: PgConnection.fromPool(pool),
});
```

`AppDatabase` 是 schema owner 和连接 facade。新库会创建内核运行态表；旧 SQLite 库会前向迁移。认证表不属于内核。

如果应用要完全接管 Skill 持久化：

```ts
import type { SkillStore } from "@zhujun/agentloop";

class AppSkillStore implements SkillStore {
  // 实现 findIdByOwnerAndName/listByOwner/findByIdAndOwner/insert 等方法
}

const skills = new SkillService(undefined, {
  skillStore: new AppSkillStore(),
  skillDirectories: extraSkillDirectories,
});
```

提供 `skillStore` 后，Skill 的读写走应用 DAL。Run、Plan、Source、Batch 等仍走 `SqlConnection`。

---

## 9. 事件、产物和恢复

推荐异步启动 Run，然后用事件驱动 UI：

```ts
const run = await runs.start(userId, input);

const unsubscribe = runs.subscribeRunEvents(run.id, (event) => {
  websocket.send(JSON.stringify(event));
});

const current = await runs.get(userId, run.id);
const events = await runs.events(userId, run.id);
const plan = await runs.plan(userId, run.id);
const artifacts = await runs.processArtifacts(userId, run.id);
```

产物读取：

```ts
const artifacts = await runs.processArtifacts(userId, runId);
const { artifact, content } = await runs.readProcessArtifact(userId, runId, artifacts[0].id);
const preview = await runs.previewProcessArtifact(userId, runId, artifacts[0].id);
```

命令详情：

```ts
const stdout = await runs.readCommandOutput(userId, runId, toolCallId, "stdout");
const args = await runs.readToolArguments(userId, runId, toolCallId);
```

恢复：

```ts
const detail = await runs.recoveryForRun(userId, runId);
const advanced = await runs.advanceRecovery(userId, runId);
const responded = await runs.respondRecovery(userId, runId, "用户确认继续");
const resumed = await runs.resumeRecovery(userId, runId);
```

---

## 10. `@zhujun/agentloop` 公开接口总览

包只暴露一个入口：

```ts
import { ... } from "@zhujun/agentloop";
```

`package.json` exports:

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  },
  "./package.json": "./package.json"
}
```

没有 `./server` 子路径。HTTP server 和 AuthService 属于参考应用，不属于内核包。

### 10.1 RunService

`RunService` 是应用最常用的内核入口。

构造：

```ts
new RunService({
  database,
  skills,
  modelFactory,
  plannerFactory?,
  assessorFactory?,
  recoveryPlannerFactory?,
  planRevisionAssessorFactory?,
  workspaceRoot?,
  computerDriver?,
  acceptanceProviders?,
  computerExecutableAliases?,
  computerCommandEnvironment?,
  tools?,
  systemPrompt?,
  maxSteps?,
  defaultModelKey?,
  modelKeys?,
  runEventLogSink?,
})
```

方法：

```ts
execute(actorUserId, input, options?): Promise<RunRecord>
start(actorUserId, input, options?): Promise<RunRecord>
get(actorUserId, runId): Promise<RunRecord>
cancel(actorUserId, runId): Promise<RunRecord>
list(actorUserId, limit?): Promise<RunRecord[]>

listConversations(actorUserId): Promise<ConversationSummary[]>
getConversation(actorUserId, conversationId): Promise<{ conversation; runs }>
updateConversationVisibleDirectories(actorUserId, conversationId, paths): Promise<ConversationSummary>
deleteConversation(actorUserId, conversationId): Promise<void>

uploadSource(actorUserId, { originalName, mimeType?, content, conversationId? }): Promise<UploadedSourceSummary>
source(actorUserId, sourceId): Promise<UploadedSourceSummary>

plan(actorUserId, runId): Promise<{ state, plan, assessments }>
events(actorUserId, runId): Promise<StoredRunEvent[]>
subscribeRunEvents(runId, listener): () => void

processArtifacts(actorUserId, runId): Promise<ProcessArtifact[]>
readProcessArtifact(actorUserId, runId, artifactId): Promise<{ artifact, content }>
previewProcessArtifact(actorUserId, runId, artifactId): Promise<ProcessArtifactPreview>
readCommandOutput(actorUserId, runId, toolCallId, stream): Promise<CommandOutputContent>
readToolArguments(actorUserId, runId, toolCallId): Promise<ToolArgumentsContent>

actionsForRun(actorUserId, runId): Promise<RuntimeActionRecord[]>
recoveryForRun(actorUserId, runId): Promise<RecoveryDetail>
advanceRecovery(actorUserId, runId): Promise<RecoveryDetail>
respondRecovery(actorUserId, runId, response): Promise<RecoveryDetail>
resumeRecovery(actorUserId, runId): Promise<RunRecord>

toolCatalog(): Array<{ name; dangerous; description }>
reconcileInterruptedRuns(): Promise<number>
```

`execute` 同步等待完成；`start` 持久化 Run 后立即返回，后台继续执行。这两个是通用执行入口。用户会话必须使用 `executeConversation` / `startConversation`；后者是生产 HTTP API 使用的异步会话入口，并由 Runtime 默认完成 `reply/execute` 分类。

Run options：

```ts
{
  allowDangerousTools?: boolean;
  conversationId?: string;
  modelKey?: string;
  visibleDirectories?: string[];
  sourceIds?: string[];
}
```

会话请求的 `reply/execute` 分类由 Runtime 默认执行并持久化为 `conversation.intent.classified` 事件；客户端不能传入或覆盖该决策。

核心类型：

```ts
RunRecord
StoredRunEvent
RecoveryDetail
ModelFactory
PlannerFactory
AssessorFactory
RecoveryPlannerFactory
PlanRevisionAssessorFactory
```

说明：`ConversationSummary`、`CommandOutputContent`、`ToolArgumentsContent` 这类结构会出现在 `RunService` 方法返回值中，但当前没有作为独立 type 从包入口导出。应用代码通常直接消费返回对象，或用 `Awaited<ReturnType<typeof runs.getConversation>>` 这类方式推导。

### 10.2 SkillService

构造：

```ts
new SkillService(database?, {
  packageStoreRoot?,
  allowedImportRoots?,
  skillDirectory?,
  skillDirectories?,
  selectVisibleSkills?,
  skillStore?,
})
```

方法：

```ts
syncSkillDirectories(): Promise<SkillDirectorySyncResult>
refreshSkillDirectory(): Promise<DiscoveredSkillSummary[]>
pruneLegacyDirectoryPackageSkills(): Promise<number>
refreshInstalledPackageMetadata(): Promise<number>
discovered(): DiscoveredSkillSummary[]

listAvailable(ownerUserId): Promise<SkillSummary[]>
resolveForAgent(ownerUserId, boundSkillIds): Promise<PrivateSkill[]>
resolveForConversation(ownerUserId): Promise<PrivateSkill[]>

create(ownerUserId, { name, description, instructions }): Promise<PrivateSkill>
installFromDirectory(ownerUserId, { sourceDirectory, sourceUrl, sourceRevision, expectedPackageHash }): Promise<PrivateSkill>
list(ownerUserId): Promise<SkillSummary[]>
get(ownerUserId, skillId): Promise<PrivateSkill>
getMany(ownerUserId, skillIds): Promise<PrivateSkill[]>
assertIntegrity(skills): Promise<void>
```

常用类型：

```ts
SkillServiceOptions
SkillVisibilityContext
SkillDirectorySyncResult
SkillSummary
PrivateSkill
DiscoveredSkillSummary
SkillPackageSource
SkillSourceKind
```

可见性钩子：

```ts
selectVisibleSkills: async ({ userId, skills }) => {
  return skills.filter((skill) => allowed(userId, skill.name));
}
```

钩子抛错会 fail-closed。

### 10.3 BatchService

构造：

```ts
new BatchService(database, runs)
```

方法：

```ts
create(actorUserId, input): Promise<BatchRecord>
get(actorUserId, batchId): Promise<BatchRecord>
items(actorUserId, batchId): Promise<BatchItemRecord[]>
```

输入：

```ts
{
  idempotencyKey: string;
  concurrency?: number;        // 1..32
  failurePolicy?: "continue" | "fail-fast";
  allowDangerousTools?: boolean;
  items: Array<{ key: string; input: string }>; // 1..1000
}
```

类型：

```ts
BatchRecord
BatchItemRecord
```

### 10.4 模型接口

导出：

```ts
LlmProviderRegistry
OpenAICompatibleModel
ModelAdapter
ModelInvocation
ModelResponse
ModelMessage
ModelToolCall
ModelToolDefinition
ModelRetryReporter
ModelStreamSink
RuntimeContextSnapshot
```

`LlmProviderRegistry`：

```ts
fromEnvironment(environment?): LlmProviderRegistry
fromConfigFile(path, environment?): Promise<LlmProviderRegistry>
fromConfigObject(config, environment?): LlmProviderRegistry

catalog(): readonly LlmProviderSummary[]
keys(): readonly string[]
modelCatalog(): readonly LlmModelSummary[]
modelKeys(): readonly string[]
create(modelKey?, onRetry?): ModelAdapter
```

`ModelAdapter`：

```ts
interface ModelAdapter {
  limits: {
    contextWindowTokens: number;
    maxOutputTokens: number;
  };
  operationTimeoutMs?: number;
  estimateInputTokens?(invocation): number | undefined;
  complete(invocation, signal?): Promise<ModelResponse>;
  streamComplete?(invocation, sink, signal?): Promise<ModelResponse>;
}
```

如果你不使用 OpenAI-compatible provider，可以直接实现 `ModelAdapter`。

### 10.5 工具接口

导出：

```ts
RuntimeTool
ToolExecutionContext
ToolRegistry
PreparedToolCall
MaterializedTools

createWebTools
createComputerTools
createSourceTools
createVisibleDirectoryTools
createSkillLoader
createCoreTools
composeRunTools
assertNoDuplicateTools

DANGEROUS_COMPUTER_TOOL_NAMES
VISIBLE_DIRECTORY_TOOL_NAMES
SKILL_LOADER_TOOL_NAME
skillExecutionCwd
```

`RuntimeTool<T>`：

```ts
interface RuntimeTool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  executionMode: "parallel" | "exclusive";
  replaySafe: boolean;
  timeoutMs?: number;
  maxResultCharacters?: number;
  parse(input: unknown): TInput;
  execute(context: ToolExecutionContext, input: TInput): Promise<unknown>;
}
```

`ToolExecutionContext`：

```ts
interface ToolExecutionContext {
  grant: CapabilityGrant;
  signal?: AbortSignal;
}
```

`CapabilityGrant` 包含：

```ts
actorUserId
runId
conversationId?
depth
workspaceRoot?
visibleDirectories
uploadedSources
skillExecutionRoots
allowedToolNames
allowedSkillIds
```

### 10.6 数据库和连接

导出：

```ts
AppDatabase
SqliteConnection
PgConnection
translatePlaceholders

SqlConnection
SqlDialect
SqlStatement
SqlRunResult
SqlValue
```

`SqlConnection`：

```ts
interface SqlConnection {
  dialect: "sqlite" | "postgres";
  exec(sql: string): Promise<void>;
  prepare(sql: string): SqlStatement;
  transaction<T>(operation: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

`AppDatabase`：

```ts
new AppDatabase(filename)
new AppDatabase({ connection })
AppDatabase.open({ connection }): Promise<AppDatabase>

ready(): Promise<void>
exec(sql): Promise<void>
prepare(sql): SqlStatement
transaction(operation): Promise<T>
close(): Promise<void>
```

### 10.7 Skill 持久化 SPI

导出：

```ts
SkillStore
SkillRecord
SkillInsertRecord
SkillPackageMetadataUpdate
SkillDiscoveryPersistence
DiscoveredSkillSnapshot
SqliteSkillStore
```

`SkillStore`：

```ts
interface SkillStore {
  findIdByOwnerAndName(ownerUserId, name): Promise<{ id } | undefined>;
  listByOwner(ownerUserId): Promise<SkillRecord[]>;
  listPackageSkills(): Promise<SkillRecord[]>;
  listPackageSkillsWithoutSourceProvenance(): Promise<SkillRecord[]>;
  findByIdAndOwner(skillId, ownerUserId): Promise<SkillRecord | undefined>;
  insert(input): Promise<void>;
  updatePackageMetadata(input): Promise<void>;
  deletePackageSkillById(id): Promise<void>;
}
```

`SkillDiscoveryPersistence` 是可选能力，用于把 discovery snapshot 同步进宿主持久层：

```ts
syncDiscoveredSkills(records): Promise<void>
listDiscoveredSkills(): Promise<DiscoveredSkillSnapshot[]>
```

### 10.8 Skill 包和目录工具

导出：

```ts
discoverSkillDirectory(directory): Promise<SkillDirectoryEntry[]>
inspectSkillPackage(directory): Promise<SkillPackageInspection>
```

类型：

```ts
SkillDirectoryEntry
SkillPackageInspection
```

用于应用启动前做预检，或在管理后台展示可导入 Skill 包信息。

### 10.9 Planning 接口

导出：

```ts
admitPlan
ModelPlanner
ModelStepAssessor
ProfiledRuleStepAssessor
RuleBasedStepAssessor
DependencyScheduler
PlanRepository
```

以及 `planning/contracts.ts` 的全部类型，例如：

```ts
ExecutionPlan
PlanProposal
PlanStepProposal
StepAssessor
Planner
PlanRevisionAssessor
SkillComplianceAssessment
AssessmentProfileId
StepEvidence
ToolEvidence
FailedBoundary
```

普通应用通常不直接调用这些类，除非要自定义 planner、assessor 或做底层测试。

### 10.10 Recovery 接口

导出：

```ts
RuntimeActionRepository
RecoveryRepository
ModelRecoveryPlanner
ModelPlanRevisionAssessor
reconstructRecoveryTranscript
RunEventHub
```

类型：

```ts
RuntimeActionRecord
RuntimeActionKind
RuntimeActionState
ReplayPolicy
RecoveryDecisionKind
RecoveryDecisionProposal
RecoveryPlanner
RecoveryDecisionRecord
RunRecoveryState
RecoveryUserResponse
PlanRevisionAssessmentRecord
RecoveryTranscript
LiveRunEvent
```

普通应用主要通过 `RunService.recoveryForRun/advanceRecovery/respondRecovery/resumeRecovery` 使用恢复能力。

### 10.11 产物与验收接口

导出：

```ts
collectProcessArtifacts
artifactId
previewProcessArtifact

ArtifactAcceptanceService
createPlaywrightArtifactAcceptanceProvider
collectRenderEnvironmentEvidence
classifyRenderEnvironmentCredibility
```

类型：

```ts
ProcessArtifact
ProcessArtifactPreview
ArtifactAcceptanceProvider
ArtifactAcceptanceProviderRequest
ArtifactAcceptanceProviderResult
ArtifactAcceptanceEvidence
ArtifactAcceptanceInput
ArtifactAcceptanceKind
PlaywrightArtifactAcceptanceProviderOptions
RenderEnvironmentEvidence
RenderCredibility
BinaryProbe
FontResolutionEvidence
```

应用通常通过 `RunService.processArtifacts/readProcessArtifact/previewProcessArtifact` 读取产物；低层函数适合离线检查或测试。

### 10.12 Computer 接口

导出：

```ts
ComputerExecutor
ComputerDriver
ComputerSnapshot
```

`ComputerExecutor` 是内核默认本地执行器，负责工作区 containment、文件读写、命令执行、Skill 只读根等。应用只在需要自定义 GUI/浏览器驱动时实现 `ComputerDriver`。

### 10.13 仓储接口

导出：

```ts
BatchRepository
RunOutcomeRepository
RunRepository
SkillRepository
SourceRepository
sourceSummary
SourceRow
SourceChunkRow
```

这些是底层仓储。常规应用优先用 `RunService/SkillService/BatchService`；仓储适合管理后台、迁移脚本、诊断工具和测试。

### 10.14 错误与校验

导出：

```ts
AppError
asAppError
badRequest
conflict
forbidden
notFound
unauthenticated
ErrorCode

optionalPositiveInteger
optionalString
requireRecord
requireString
requireStringArray
```

应用 HTTP 层可以把 `AppError` 映射成响应码：

```ts
try {
  // ...
} catch (error) {
  const appError = asAppError(error);
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
    },
  });
}
```

---

## 11. 启动流程建议

推荐顺序：

```ts
const database = new AppDatabase(databasePath);
await database.ready();

const auth = new AppAuthService(database); // 应用自己的，不属于内核
const providers = await LlmProviderRegistry.fromConfigFile(providerConfigPath);

const skills = new SkillService(database, {
  skillDirectories,
  packageStoreRoot,
  allowedImportRoots,
  selectVisibleSkills,
});
const skillDirectorySync = await skills.syncSkillDirectories();

const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, modelKey) => providers.create(modelKey, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot,
  tools,
});
await runs.reconcileInterruptedRuns();

const batches = new BatchService(database, runs);
```

服务关闭时：

```ts
await database.close();
```

---

## 12. 上线检查清单

- [ ] 应用自己的 `.env/config` 不在内核包内。
- [ ] 认证表、用户表、组织权限表属于应用。
- [ ] 所有 Run/Skill/Batch 调用都传 app user id。
- [ ] `CUSTOM_SKILL_DIRECTORIES_JSON` 中的每个额外 Skill 根目录都包含 `<name>/SKILL.md`。
- [ ] Skill frontmatter `name` 等于目录名。
- [ ] 需要 Planner 参选的 Skill 都有 `agentloop:` 元数据。
- [ ] 工具 `execute` 内部做业务数据级鉴权。
- [ ] 有副作用工具使用 `executionMode: "exclusive"`，并正确设置 `replaySafe`。
- [ ] `workspaceRoot` 指向应用私有工作区。
- [ ] 密钥只来自环境变量、KMS 或 Vault，不写入数据库和 Run 事件。
- [ ] 生产服务启动后调用 `reconcileInterruptedRuns()`。

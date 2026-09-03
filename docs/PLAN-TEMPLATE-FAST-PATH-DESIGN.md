# Plan Template Fast Path 设计方案

版本：v0.1
日期：2026-09-02
状态：设计稿

配置操作说明见：[Plan Template 插件配置说明](./PLAN-TEMPLATE-PLUGIN-CONFIGURATION.md)。

## 1. 设计结论

Plan Template Fast Path 的目标不是取消规划，而是在不破坏 AgentLoop canonical Runtime 权威链路的前提下，把历史成功 Run 中稳定、重复、可验证的 Plan 结构沉淀为模版，用于降低新任务的首轮 Planner 大模型调用成本。

最终范式：

```text
历史 Run
  -> TemplateMiner 离线提炼
  -> PlanTemplateStore 模版库
  -> TemplateEvaluator 持续质量统计

新任务
  -> TaskProfiler 生成任务指纹
  -> TemplateMatcher 匹配候选模版
  -> TemplatePlanInstantiator 实例化 PlanProposal
  -> PlanAdmission
  -> Runtime / Tool / Assessment / TerminalCommitter
```

权威边界保持不变：

- Template 只负责产生候选 `PlanProposal`。
- PlanAdmission 决定候选 Plan 是否进入 Runtime。
- Runtime 只执行已接纳的 canonical Plan。
- Tool / executor 只返回执行事实、receipt 或受约束 mutation intent。
- Assessment 判断当前证据是否满足 Plan / Step contract。
- TerminalCommitter 才能提交 Delivery 和 Outcome。

一句话约束：

> Template 是 Planner 前置的候选生成器，不是新的 Runtime 权威，也不能直接声明任务完成。

包形态结论：

```text
@zhujun/agentloop
  只提供 planning extension SPI、PlanProposal admission 入口和 canonical Runtime 权威链路。

@zhujun/agentloop-plan-template
  作为内核可选插件包发布，自闭环实现 TaskProfiler、TemplateMatcher、
  TemplatePlanInstantiator、TemplateMiner、TemplateEvaluator 和 PlanTemplateStore。

apps/agentloop-app 或其他宿主应用
  只负责从应用配置读取是否绑定插件、插件发现位置和 opaque options 覆盖项，
  不理解 PlanTemplate 的匹配、生命周期、提炼和持久化逻辑。
```

因此 Plan Template 不是参考应用模块，也不是 Skill / Tool 插件，而是 **kernel planning extension package**。

## 2. 不做的设计

本方案不做以下形态：

- 不用关键词 if/else 为 PPT、HTML、邮件、报告、网页调研等任务硬编码流程。
- 不让 Template 直接写 Delivery、Outcome、Assessment 或 RuntimeAction。
- 不把历史失败 Run、证据不完整 Run、仅有模型 prose 的 Run 提炼为正向模版。
- 不因为模版命中而放宽 PlanAdmission、Tool binding、Assessment 或 TerminalCommitter。
- 不把模版文本塞进全局 prompt；只在当前任务的 Planner 路由中动态使用。
- 不把模版匹配失败视为 `blocked`；普通失败应降级到正常 Planner 或 recover / replan。
- 不引入兼容旧状态机的双轨完成判断。
- 不把 PlanTemplate 的表结构、匹配算法或生命周期管理写进 `apps/agentloop-app`。
- 不要求宿主应用理解 PlanTemplate 业务逻辑；宿主只做依赖装配、配置和运维展示。
- 不复用宿主应用的数据库连接、ORM 或 DAL；PlanTemplate 存储连接由插件包自己创建和管理。

## 3. 真实运行契约

需要建立的契约：

> 对于高频同构任务，系统可以用历史成功 Plan skeleton 生成候选 Plan，从而跳过首轮 LLM Planner；但候选 Plan 必须经过同一套 PlanAdmission、Runtime 执行、Assessment 和 TerminalCommitter。

这个契约修复的是规划成本问题，而不是完成判断问题。它不能替代下面的 canonical loop：

```text
Canonical Context
  -> GoalGap
  -> RuntimeAction
  -> typed handler
  -> RuntimeContextWriter
  -> recompute GoalGap
  -> Assessment
  -> DeliveryCandidate
  -> TerminalCommitter
  -> Outcome
```

### 3.1 包与所有权边界

Plan Template 的正确所有权是独立内核插件包，而不是参考应用。

```text
packages/agentloop
  定义 PlanningExtension SPI。
  负责调用 extension、接纳 PlanProposal、执行 canonical Runtime。
  不保存 PlanTemplate 数据。
  不实现 template matching / mining / lifecycle 业务。

packages/agentloop-plan-template
  实现 Plan Template 完整闭环。
  自带 schema、migration、store、matcher、miner、evaluator。
  自己创建和管理 Sqlite / PostgreSQL 等数据库连接。
  输出符合内核 SPI 的 PlanProposal 或 plannerContext。

apps/agentloop-app
  参考宿主，只在启动时按应用配置动态装配插件。
  提供插件绑定开关、发现位置、opaque options 覆盖和可选管理 API/UI。
  不写 PlanTemplate 的核心逻辑。
```

物理数据落在 PlanTemplate 插件自己的数据库或独立 schema 中，不接入宿主应用主库连接。表、migration、repository、查询语义和连接生命周期都归 `@zhujun/agentloop-plan-template` 包所有。这样可以同时满足：

- 应用部署时通过配置指定数据库位置、备份、安全和多租户边界。
- PlanTemplate 逻辑不泄漏到应用层。
- 其他宿主应用可以复用同一个插件包，而不是复制 app 内部实现。

### 3.2 不是 Skill / Tool 插件

Plan Template 不应建模为 Tool：

- Tool 在 Plan admitted 之后才被调用。
- Plan Template 的目标是在 Planner 之前提供候选 Plan。
- 如果做成 Tool，系统仍需先让 Planner 规划“调用模板工具”，无法节省首轮 Planner 调用。

Plan Template 也不应建模为 Skill：

- Skill 拥有领域工作流、素材约束和执行策略。
- Plan Template 拥有跨领域的规划结构复用、匹配、提炼和生命周期。
- 放进 Skill 容易演变成任务类型特例，而不是中性的规划优化层。

正确形态是：

```text
kernel planning extension package
```

它处在 Planner 之前，输出仍受 PlanAdmission 管束。

## 4. 核心对象

### 4.1 TaskFingerprint

`TaskFingerprint` 是新任务进入 TemplateMatcher 的低成本结构化画像。第一阶段应尽量由 deterministic profiler 生成，不依赖大模型。

```ts
interface TaskFingerprint {
  schema: "agentloop.taskFingerprint/v1";
  language: "zh" | "en" | "mixed";
  intentHints: string[];
  sourceNeed:
    | "none"
    | "uploaded_file"
    | "visible_directory"
    | "web_research"
    | "existing_conversation_context";
  sourceTypes: string[];
  artifactKind:
    | "none"
    | "html"
    | "pdf"
    | "pptx"
    | "docx"
    | "xlsx"
    | "image"
    | "code";
  sideEffectKind:
    | "none"
    | "write_file"
    | "send_email"
    | "external_api"
    | "browser_operation";
  requiredCapabilities: string[];
  skillHints: string[];
  outputConstraints: string[];
  riskLevel: "low" | "medium" | "high";
  textEmbeddingRef?: string;
  confidence: number;
}
```

示例：

```json
{
  "schema": "agentloop.taskFingerprint/v1",
  "language": "zh",
  "intentHints": ["analyze", "report"],
  "sourceNeed": "uploaded_file",
  "sourceTypes": ["xlsx"],
  "artifactKind": "html",
  "sideEffectKind": "write_file",
  "requiredCapabilities": [
    "spreadsheet_parse",
    "artifact_write",
    "artifact_acceptance"
  ],
  "skillHints": [],
  "outputConstraints": ["business_analysis_report"],
  "riskLevel": "low",
  "confidence": 0.86
}
```

### 4.2 PlanTemplate

Template 保存的是结构化 Plan skeleton 和适用边界，不是 prompt 片段。

```ts
interface PlanTemplate {
  schema: "agentloop.planTemplate/v1";
  id: string;
  version: number;
  status: "draft" | "candidate" | "active" | "retired";
  intentFamily: string;
  sourceNeed: TaskFingerprint["sourceNeed"];
  acceptedSourceTypes: string[];
  artifactKind: TaskFingerprint["artifactKind"];
  sideEffectKind: TaskFingerprint["sideEffectKind"];
  requiredCapabilities: string[];
  requiredEvidenceKinds: string[];
  riskCeiling: TaskFingerprint["riskLevel"];
  planSkeleton: PlanStepSkeleton[];
  positiveExampleRefs: string[];
  negativeExampleRefs: string[];
  reliability: TemplateReliability;
}

interface TemplateReliability {
  completedRuns: number;
  admittedRuns: number;
  failedRuns: number;
  planAdmissionFailureRate: number;
  assessmentFailureRate: number;
  repairRate: number;
  avgPlannerSavedMs: number;
  updatedAt: string;
}
```

### 4.3 PlanStepSkeleton

Skeleton 表达阶段角色、依赖、能力和证据 contract。

```ts
interface PlanStepSkeleton {
  id: string;
  role:
    | "fact_acquisition"
    | "analysis"
    | "produce"
    | "qa"
    | "deliver"
    | "repair";
  operationRef: string;
  dependsOn: string[];
  inputBindings: Record<string, string>;
  requiredEvidenceKinds: string[];
  producedEvidenceKinds: string[];
  requiredCapabilities: string[];
  skillRoleHints: string[];
}
```

示例：

```json
{
  "id": "file_data_to_html_report.v1",
  "version": 1,
  "status": "active",
  "intentFamily": "file_data_to_report",
  "sourceNeed": "uploaded_file",
  "acceptedSourceTypes": ["xlsx", "csv"],
  "artifactKind": "html",
  "sideEffectKind": "write_file",
  "requiredCapabilities": [
    "source_read",
    "spreadsheet_parse",
    "artifact_write",
    "artifact_acceptance"
  ],
  "requiredEvidenceKinds": [
    "source_summary",
    "analysis_summary",
    "artifact_acceptance",
    "delivery_receipt"
  ],
  "riskCeiling": "medium",
  "planSkeleton": [
    {
      "id": "read_sources",
      "role": "fact_acquisition",
      "operationRef": "read_uploaded_sources",
      "dependsOn": [],
      "inputBindings": {
        "sources": "{uploaded_sources}"
      },
      "requiredEvidenceKinds": [],
      "producedEvidenceKinds": ["source_summary"],
      "requiredCapabilities": ["source_read", "spreadsheet_parse"],
      "skillRoleHints": ["source_provider"]
    },
    {
      "id": "analyze_facts",
      "role": "analysis",
      "operationRef": "derive_key_findings",
      "dependsOn": ["read_sources"],
      "inputBindings": {
        "sourceSummary": "{evidence.source_summary}"
      },
      "requiredEvidenceKinds": ["source_summary"],
      "producedEvidenceKinds": ["analysis_summary"],
      "requiredCapabilities": [],
      "skillRoleHints": ["primary_builder"]
    },
    {
      "id": "write_report",
      "role": "produce",
      "operationRef": "write_artifact",
      "dependsOn": ["analyze_facts"],
      "inputBindings": {
        "analysisSummary": "{evidence.analysis_summary}",
        "artifactKind": "{task.artifactKind}"
      },
      "requiredEvidenceKinds": ["analysis_summary"],
      "producedEvidenceKinds": ["artifact_path"],
      "requiredCapabilities": ["artifact_write"],
      "skillRoleHints": ["primary_builder"]
    },
    {
      "id": "verify_report",
      "role": "qa",
      "operationRef": "verify_artifact_acceptance",
      "dependsOn": ["write_report"],
      "inputBindings": {
        "artifactPath": "{evidence.artifact_path}"
      },
      "requiredEvidenceKinds": ["artifact_path"],
      "producedEvidenceKinds": ["artifact_acceptance"],
      "requiredCapabilities": ["artifact_acceptance"],
      "skillRoleHints": ["qa"]
    },
    {
      "id": "deliver_report",
      "role": "deliver",
      "operationRef": "deliver_artifact",
      "dependsOn": ["verify_report"],
      "inputBindings": {
        "artifactAcceptance": "{evidence.artifact_acceptance}"
      },
      "requiredEvidenceKinds": ["artifact_acceptance"],
      "producedEvidenceKinds": ["delivery_receipt"],
      "requiredCapabilities": [],
      "skillRoleHints": []
    }
  ]
}
```

### 4.4 PlanTemplateFastPathConfig

Template fast path 必须有全局开关，且默认关闭。开关关闭时，在线入口不得执行 TemplateRetriever、ConstraintVerifier、MatchScorer 或 TemplatePlanInstantiator，也不得向 Planner 注入 template hint。系统应保持现有 Planner 主路径行为。

建议配置对象：

```ts
interface PlanTemplateFastPathConfig {
  schema: "agentloop.planTemplateFastPathConfig/v1";
  enabled: boolean;
  mode: "off" | "observe" | "planner_context" | "direct_use";
  allowDirectUse: boolean;
  minDirectUseScore: number;
  minPlannerContextScore: number;
  allowedRiskCeiling: "low" | "medium" | "high";
  allowedIntentFamilies?: string[];
  disabledIntentFamilies?: string[];
  requireActiveTemplateForDirectUse: boolean;
}
```

插件还应单独接收自己的存储配置。宿主传入的是配置值，不是数据库连接对象。

```ts
type PlanTemplateStorageConfig =
  | {
      type: "sqlite";
      databasePath: string;
      busyTimeoutMs?: number;
      migrateOnStart?: boolean;
    }
  | {
      type: "postgres";
      connectionString: string;
      schemaName?: string;
      poolSize?: number;
      migrateOnStart?: boolean;
    };
```

推荐默认值：

```json
{
  "schema": "agentloop.planTemplateFastPathConfig/v1",
  "enabled": false,
  "mode": "off",
  "allowDirectUse": false,
  "minDirectUseScore": 0.9,
  "minPlannerContextScore": 0.7,
  "allowedRiskCeiling": "low",
  "requireActiveTemplateForDirectUse": true
}
```

语义：

- `enabled=false` 或 `mode="off"`：完全不启用模版链路，直接走正常 LLM Planner。
- `mode="observe"`：只生成 TaskFingerprint 和观测记录，不影响 Planner 输入，不启用匹配结果。
- `mode="planner_context"`：允许将高质量候选作为 compact template hint 注入 Planner，但不跳过 Planner。
- `mode="direct_use"`：允许高置信 active 模版实例化 PlanProposal；仍必须通过 PlanAdmission。
- `allowDirectUse=false` 时，即使 `mode="direct_use"`，也只能降级为 `planner_context` 或 normal Planner。

配置来源分两层：

1. 插件包拥有代码默认值，也可以拥有自己的插件配置文件。
2. 应用配置决定是否绑定该插件、从哪里发现插件，并可以用 opaque `options` 覆盖插件配置。

参考应用只做通用装配，不解析 PlanTemplate 字段语义：

```json
{
  "enabled": true,
  "planningExtensions": [
    {
      "enabled": true,
      "module": "@zhujun/agentloop-plan-template",
      "factory": "createPlanTemplatePlugin",
      "optionsPath": "./plan-template.defaults.json",
      "options": {
        "storage": {
          "type": "sqlite",
          "databasePath": "../data/agentloop-plan-template.db",
          "migrateOnStart": true
        },
        "config": {
          "enabled": true,
          "mode": "planner_context",
          "allowDirectUse": false
        }
      }
    }
  ]
}
```

其中 `optionsPath` 是插件配置基线，`options` 是应用配置覆盖项。参考应用只做 schema-agnostic JSON merge，最终 options 原样交给插件 factory。PlanTemplate 字段校验、默认值归一化、SQLite / PostgreSQL 存储解释和 migration 仍由 `@zhujun/agentloop-plan-template` 完成。

该配置只控制“是否尝试模版匹配与复用”，不控制 Assessment、Delivery 或 Outcome 的完成规则。

## 5. 在线匹配链路

### 5.1 TaskProfiler

输入：

- 用户原始消息。
- 上传文件、visible directory、已有 conversation context。
- 当前 Tool catalog / capability availability。
- Skill catalog metadata。
- 风险与 side effect 检测结果。

输出：

- `TaskFingerprint`。
- profiler confidence。
- 无法确定的字段列表。

规则：

- 只做中性结构推断，不做业务结论。
- 低置信字段保留 unknown / caveat，不用猜测填满。
- 发现安全或不可逆 side effect 时，不允许进入 direct template fast path。

### 5.2 TemplateRetriever

第一阶段可以用数据库条件查询和内存相似度，不必立即引入独立向量库。

候选召回顺序：

```text
1. status in ("candidate", "active")
2. sourceNeed / artifactKind / sideEffectKind 粗过滤
3. acceptedSourceTypes 交集过滤
4. requiredCapabilities 可用性过滤
5. intentFamily / intentHints 匹配
6. embedding 或文本样例相似度召回
```

模版数量较小时，embedding 可以存储为 JSON 或 blob，服务启动后加载到内存计算 cosine。模版量增大后再接 sqlite-vec 或独立向量索引。

### 5.3 ConstraintVerifier

硬约束不满足时直接 reject，不进入打分。

```text
sourceNeed 不兼容 -> reject
sourceTypes 不兼容 -> reject
artifactKind 不兼容 -> reject
sideEffectKind 不兼容 -> reject
requiredCapabilities 当前不可用 -> reject
riskLevel 超过 template.riskCeiling -> reject
requiredEvidenceKinds 当前任务无法产生 -> reject
template.status 非 active/candidate -> reject
Skill 或 Tool contract version 不兼容 -> reject
```

硬约束失败必须记录到 `plan_template_matches.rejection_reasons_json`，用于后续负例分析。

### 5.4 MatchScorer

通过硬约束的候选再计算软分。

```text
score =
  0.30 * intentScore
  + 0.20 * inputScore
  + 0.15 * artifactScore
  + 0.15 * capabilityScore
  + 0.10 * skillAffinityScore
  + 0.10 * historicalReliabilityScore
```

建议阈值：

```text
score >= 0.90 且 template.status == "active":
  decision = direct_use

0.70 <= score < 0.90:
  decision = planner_context

score < 0.70:
  decision = rejected
```

`direct_use` 只表示跳过 LLM Planner 生成 PlanProposal，不表示跳过 PlanAdmission。

### 5.5 TemplatePlanInstantiator

Instantiator 将 skeleton 填充为具体 `PlanProposal`。

绑定来源：

- `{uploaded_sources}` 来自 intake source refs。
- `{visible_directory}` 来自授权目录 refs。
- `{task.artifactKind}` 来自 TaskFingerprint。
- `{task.outputConstraints}` 来自用户显式要求。
- `{skill.primary_builder}` 来自 SkillRoleSelection。
- `{evidence.*}` 只允许绑定前序 step produced evidence。

实例化校验：

- 所有 placeholder 必须可解析或明确标记为待执行时绑定。
- 每个 step 的 dependencies 必须引用同一 Plan 内已有 step。
- 每个 executable step 必须拥有明确 role、operationRef、evidence contract。
- side effect step 必须保留权限和确认边界。

输出仍是 `PlanProposal`，随后进入 PlanAdmission。

## 6. Planner 路由策略

```text
config = load PlanTemplateFastPathConfig

if !config.enabled or config.mode == "off":
  call normal LLM Planner
  return

if config.mode == "observe":
  create TaskFingerprint
  record observation only
  call normal LLM Planner
  return

if direct_use:
  require config.mode == "direct_use"
  require config.allowDirectUse
  PlanProposal = instantiate(template, task)
  admission = PlanAdmission.admit(PlanProposal)
  if admission.ok:
    use admitted Plan
  else:
    record negative match
    fall back to LLM Planner

if planner_context:
  require config.mode in ("planner_context", "direct_use")
  call LLM Planner with compact template context
  Planner still owns final PlanProposal

if rejected:
  call normal LLM Planner
```

降级规则：

- TemplateMatcher 失败：正常 Planner。
- Instantiator 失败：正常 Planner。
- PlanAdmission 失败：正常 Planner，并记录负例。
- Runtime 执行中发现输入不满足：正常 recover / replan。
- Assessment 不通过：正常 repair，不因模版来源放宽。
- Tool capability 临时不可用：记录能力变化，降级 Planner 或 fail 为 runtime protocol issue。
- 全局开关关闭：完全跳过 template matcher，正常 Planner。

普通模版匹配失败不产生 `blocked`。只有 canonical 安全、权限或用户输入缺失等真实 blocker 才能进入 ask_user / blocked 类路径。

## 7. 离线 TemplateMiner

TemplateMiner 是后台任务，不影响当前用户请求的在线时延。

### 7.1 正例来源

只有满足以下条件的 Run 可以进入正例池：

```text
Outcome.completed
Delivery 存在
Assessment accepted
关键 evidenceKinds satisfied
无未解决 GoalGap
无 protocol_error
repair 次数低于阈值
PlanAdmission 成功
TerminalCommitter 提交 Delivery / Outcome
```

禁止进入正例池：

- 只有 artifact 文件但没有 Assessment / Delivery / Outcome。
- 只有 UI / SSE / model prose 成功描述。
- Tool success 但 evidence contract 不完整。
- 因特殊 fallback 或人工修补才完成的 Run。
- 失败、取消、budget exhausted、runtime_no_progress_detected 的 Run。

### 7.2 负例来源

负例同样重要，用于降低错误命中率：

```text
相似任务但 PlanAdmission 失败
相似任务但 Assessment 失败
相似任务但 repair 过多
相似任务但 Outcome.failed
相似任务但 capability / side effect 不兼容
```

负例不删除模版，但会影响：

- historicalReliabilityScore。
- status 升降级。
- hard constraint 规则。
- future match rejection reason。

### 7.3 提炼流程

```text
1. 读取 completed Run 的 canonical Plan、Step、ToolRun、ActionResult、Assessment、Delivery、Outcome。
2. 归一化用户任务为 TaskFingerprint。
3. 抽取 Plan DAG 的 step role、operationRef、依赖和 evidenceKinds。
4. 去除 run-specific 参数，例如文件名、日期、收件人、主题。
5. 将参数位置替换为 placeholder。
6. 与已有 template 聚类合并。
7. 更新 positive / negative examples 和 reliability。
8. 满足阈值后从 draft 升级为 candidate 或 active。
```

TemplateMiner 只能从 canonical persisted facts 提炼，不能从模型最终总结里反推完成链路。

## 8. 模版生命周期

```text
draft:
  自动提炼或人工创建，不能参与线上匹配。

candidate:
  可以作为 planner_context，不能 direct_use。

active:
  满足成功样本数、低失败率和能力版本一致性后，可以 direct_use。

retired:
  近期失败率升高、工具/Skill contract 变更、能力不可用或被人工下线。
```

建议默认阈值：

```text
candidate:
  completedRuns >= 3
  planAdmissionFailureRate <= 0.15

active:
  completedRuns >= 10
  planAdmissionFailureRate <= 0.05
  assessmentFailureRate <= 0.08
  repairRate <= 0.20

retired:
  recent planAdmissionFailureRate > 0.15
  or recent assessmentFailureRate > 0.20
  or required capability unavailable
  or Skill / Tool contract major version changed
```

这些阈值应作为配置，不写死在业务逻辑中。

## 9. 持久化设计

PlanTemplate 数据不写入 `@zhujun/agentloop` 内核的 Run / Plan 主 schema，也不由 `apps/agentloop-app` 自行管理。`@zhujun/agentloop-plan-template` 插件包自带 database connection、storage layer、schema migration 和 repository。

宿主只提供插件装配配置和 opaque options，不提供数据库连接。

直接嵌入推荐形态：

```ts
import { createPlanTemplatePlugin } from "@zhujun/agentloop-plan-template";
import { AppDatabase, RunService } from "@zhujun/agentloop";

const database = new AppDatabase("./data/app.db");

const planTemplates = createPlanTemplatePlugin({
  storage: {
    type: "sqlite",
    databasePath: "./data/agentloop-plan-template.db",
    migrateOnStart: true,
  },
  config: {
    enabled: true,
    mode: "planner_context",
    allowDirectUse: false,
  },
});

await planTemplates.migrate();

const runs = new RunService({
  database,
  planningExtensions: [planTemplates.extension()],
});
```

参考应用推荐形态：

```json
{
  "enabled": true,
  "planningExtensions": [
    {
      "enabled": true,
      "module": "@zhujun/agentloop-plan-template",
      "factory": "createPlanTemplatePlugin",
      "optionsPath": "./plan-template.defaults.json",
      "options": {
        "config": {
          "mode": "planner_context"
        }
      }
    }
  ]
}
```

在这个形态下，app 不 import `@zhujun/agentloop-plan-template`。app 启动时读取 `PLANNING_EXTENSIONS_CONFIG_PATH` 指向的 JSON，动态 import 插件 module，调用 factory，并把返回的 `PlanningExtension` 注入 `RunService`。

PostgreSQL 推荐形态：

```ts
import { createPlanTemplatePlugin } from "@zhujun/agentloop-plan-template";

const planTemplates = createPlanTemplatePlugin({
  storage: {
    type: "postgres",
    connectionString: await secrets.get("agentloop-plan-template-postgres-url"),
    schemaName: "agentloop_plan_template",
    migrateOnStart: true,
  },
  config,
});

await planTemplates.migrate();
```

规则：

- 插件拥有 `plan_template_*` 表结构、migration、repository、索引策略、连接创建和连接生命周期。
- 宿主只拥有插件绑定配置、插件发现位置、部署位置、备份策略和权限配置。
- 内核只通过 `PlanningExtension` 接口调用插件，不直接读写插件表。
- 参考应用可以暴露管理 API/UI，但只能调用插件公开 API，不复制内部查询逻辑。
- 插件表与 Run / Plan 主表不建立数据库外键；`run_id`、`agent_run_id` 等只是不透明引用。

第一阶段表结构由插件包管理：

```sql
CREATE TABLE plan_templates (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  intent_family TEXT NOT NULL,
  source_need TEXT NOT NULL,
  accepted_source_types_json TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  side_effect_kind TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  required_evidence_json TEXT NOT NULL,
  risk_ceiling TEXT NOT NULL,
  plan_skeleton_json TEXT NOT NULL,
  reliability_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plan_template_examples (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  example_type TEXT NOT NULL,
  task_text_hash TEXT NOT NULL,
  task_fingerprint_json TEXT NOT NULL,
  outcome_status TEXT NOT NULL,
  evidence_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES plan_templates(id)
);

CREATE TABLE plan_template_matches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  template_id TEXT,
  task_fingerprint_json TEXT NOT NULL,
  score REAL,
  decision TEXT NOT NULL,
  rejection_reasons_json TEXT NOT NULL,
  admission_result_json TEXT,
  outcome_status TEXT,
  created_at TEXT NOT NULL
);
```

SQLite / PostgreSQL 差异由插件 storage adapter 封装：

```text
PlanTemplateStorageConfig
  -> PlanTemplateConnectionFactory
  -> PlanTemplateSqlDialect
  -> SqlitePlanTemplateStore
  -> PostgresPlanTemplateStore
```

两种 store 暴露相同接口：

```ts
interface PlanTemplateStore {
  migrate(): Promise<void>;
  listCandidates(fingerprint: TaskFingerprint): Promise<PlanTemplate[]>;
  getTemplate(id: string): Promise<PlanTemplate | null>;
  upsertTemplate(template: PlanTemplate): Promise<void>;
  recordExample(example: PlanTemplateExample): Promise<void>;
  recordMatch(match: PlanTemplateMatch): Promise<void>;
  recordOutcome(outcome: PlanTemplateOutcome): Promise<void>;
  updateReliability(templateId: string, reliability: TemplateReliability): Promise<void>;
}
```

实现约束：

- 插件包可以复用内核导出的低层 SQL adapter 类型，也可以维护自己的 adapter，但调用方不得传入 `AppDatabase.connection` 或宿主 ORM 对象。
- 插件连接不得参与 Run / Plan 主库事务；跨库关联只记录 `run_id`、`conversation_id`、`agent_run_id` 等不透明 ID。
- SQLite 默认使用独立文件，例如 `./data/agentloop-plan-template.db`。
- PostgreSQL 默认使用独立 database 或独立 schema，例如 `agentloop_plan_template`。
- migration 由插件包显式执行；参考应用启动时只能调用 `planTemplates.migrate()` 或启用 `migrateOnStart`。

后续增强：

- `plan_template_embeddings`：存储 task / template embedding refs。
- `plan_template_versions`：保留 skeleton 版本历史。
- `plan_template_contracts`：记录 Tool / Skill contract version。
- `plan_template_metrics_daily`：按天聚合质量指标。

## 10. 模块边界

建议新增一个独立 workspace package：

```text
packages/agentloop-plan-template/
  package.json
  tsconfig.json
  src/
    index.ts
    config.ts
    types.ts
    plugin.ts
    profiler/
      task-profiler.ts
    matching/
      template-retriever.ts
      constraint-verifier.ts
      match-scorer.ts
    planning/
      template-plan-instantiator.ts
      planner-template-router.ts
    storage/
      connection-factory.ts
      storage-config.ts
      plan-template-store.ts
      sqlite-plan-template-store.ts
      postgres-plan-template-store.ts
      migrations.ts
    mining/
      template-miner.ts
      template-normalizer.ts
    evaluation/
      template-evaluator.ts
```

`packages/agentloop` 只新增最小 SPI：

```ts
interface PlanningExtension {
  name: string;
  beforePlanning(input: PlanningExtensionInput): Promise<PlanningExtensionDecision>;
  afterPlanAdmission?(input: PlanAdmissionObservation): Promise<void>;
  afterOutcome?(input: RuntimeOutcomeObservation): Promise<void>;
}

type PlanningExtensionDecision =
  | {
      kind: "none";
    }
  | {
      kind: "planner_context";
      context: unknown;
    }
  | {
      kind: "plan_proposal";
      proposal: PlanProposal;
      source: {
        kind: "planning_extension";
        extensionName: string;
        templateId?: string;
        score?: number;
      };
    };
```

`@zhujun/agentloop-plan-template` 实现：

```text
TaskProfiler
  生成 TaskFingerprint。

PlanTemplateStore
  负责模版、样例、匹配记录的持久化读取。

TemplateRetriever
  粗过滤和候选召回。

ConstraintVerifier
  执行硬约束验证。

MatchScorer
  给候选模版打分。

TemplatePlanInstantiator
  将 Plan skeleton 变成 PlanProposal。

PlannerTemplateRouter
  决定 direct_use / planner_context / normal_planner。

TemplateMiner
  离线从成功 Run 提炼模版。

TemplateEvaluator
  根据 admission / assessment / outcome 结果更新 reliability 和生命周期。
```

职责禁止：

- TemplateMatcher 不调用 Tool。
- TemplatePlanInstantiator 不写 canonical context。
- TemplateMiner 不修改历史 Run。
- TemplateEvaluator 不改变 Runtime outcome。
- PlannerTemplateRouter 不绕过 PlanAdmission。
- `@zhujun/agentloop` 不 import `@zhujun/agentloop-plan-template`，避免内核依赖可选插件。
- `apps/agentloop-app` 不静态 import `@zhujun/agentloop-plan-template`，不实现 template matching / mining / lifecycle，只按配置动态装配插件和暴露可选管理面。

## 11. 与 Planner / Runtime 的集成点

在线入口：

```text
runtime chat intake
  -> create AgentRun / RuntimeContext
  -> invoke registered PlanningExtension.beforePlanning()
  -> PlanTemplate plugin checks its own config
  -> if disabled/off: extension returns none
  -> if observe: extension records observation, returns none
  -> if planner_context/direct_use: extension runs TaskProfiler + TemplateMatcher
  -> PlanProposal source:
       direct template
       or LLM Planner with template context
       or normal LLM Planner
  -> PlanAdmission
  -> RuntimeLoop
```

`planner_context` 模式下，给 LLM Planner 的上下文应非常短：

```json
{
  "templateHint": {
    "id": "file_data_to_html_report.v1",
    "intentFamily": "file_data_to_report",
    "recommendedShape": "fact_then_produce",
    "stepRoles": ["fact_acquisition", "analysis", "produce", "qa", "deliver"],
    "requiredEvidenceKinds": [
      "source_summary",
      "analysis_summary",
      "artifact_acceptance",
      "delivery_receipt"
    ],
    "knownMismatches": []
  }
}
```

不要注入完整历史 Run、长 prompt 或大量案例文本。

核心调用关系：

```text
RunService
  -> PlanningExtension.beforePlanning()
       @zhujun/agentloop-plan-template
         -> TaskProfiler
         -> PlanTemplateStore
         -> TemplateMatcher
         -> TemplatePlanInstantiator
  -> PlanAdmission
  -> PlanningExtension.afterPlanAdmission()
  -> RuntimeLoop
  -> TerminalCommitter
  -> PlanningExtension.afterOutcome()
```

`beforePlanning()` 只能返回三类结果：

- `none`：内核继续正常 Planner。
- `planner_context`：内核调用 LLM Planner，并附加短 template hint。
- `plan_proposal`：内核跳过 LLM Planner，但该 proposal 必须进入 PlanAdmission。

`afterPlanAdmission()` 和 `afterOutcome()` 只用于记录 match / admission / outcome 反馈，不能改变已经发生的 canonical 状态。

## 12. 可观测性

建议记录事件：

```text
planning.task_fingerprint.created
planning.template.retrieved
planning.template.constraint_rejected
planning.template.match_scored
planning.template.direct_use_selected
planning.template.planner_context_selected
planning.template.instantiation_failed
planning.template.admission_failed
planning.template.admitted
planning.template.outcome_recorded
```

核心指标：

```text
template_match_rate
direct_use_rate
planner_context_rate
planner_call_saved_rate
plan_admission_failure_rate
assessment_failure_rate
repair_rate
outcome_success_rate
avg_planning_latency_saved_ms
false_positive_match_rate
fallback_to_planner_rate
```

必须区分：

- 命中模版。
- PlanAdmission 成功。
- Runtime 执行成功。
- Assessment 通过。
- TerminalCommitter 完成 Outcome。

不能把命中率当成成功率。

## 13. 测试策略

### 13.1 单元测试

- TaskProfiler 对上传文件、网页调研、邮件 side effect、无工具回答生成正确 fingerprint。
- ConstraintVerifier 对 source、artifact、capability、side effect、risk 不兼容给出 reject。
- MatchScorer 对正例高分、负例低分、能力缺失 reject。
- TemplatePlanInstantiator 能解析 placeholder，不能解析时失败并给出原因。

### 13.2 集成测试

- `active` 模版高置信命中后生成 PlanProposal，并通过 PlanAdmission。
- PlanAdmission 失败时降级 LLM Planner，并记录 negative match。
- `candidate` 模版只进入 planner_context，不 direct_use。
- Assessment 失败时进入正常 repair，不因模版来源被接受。

### 13.3 回归测试

- 相同 intent 但 sourceNeed 不同不能误匹配。
- 相同 artifactKind 但 sideEffectKind 不同不能误匹配。
- Tool / Skill contract version 变化后 active 模版应暂停或降级。
- 失败 Run 不会被 TemplateMiner 提炼为正例。

### 13.4 真实 E2E

至少覆盖三类高频任务：

- 上传 XLSX / CSV 生成分析报告。
- 网页调研生成中文简报。
- 生成 artifact 并通过 artifact acceptance 后交付。

每个 E2E 需要记录：

```text
TaskFingerprint
Template match decision
PlanAdmission result
Tool / ActionResult evidence
Assessment result
Delivery / Outcome
```

## 14. 实施批次

### Batch 1：记录与观测

目标：

- 新增 workspace package `@zhujun/agentloop-plan-template`。
- 在 `@zhujun/agentloop` 新增最小 `PlanningExtension` SPI。
- 新增全局配置 `PlanTemplateFastPathConfig`，默认 `enabled=false`、`mode=off`。
- 新增 TaskFingerprint 生成。
- 在插件包内新增 `plan_template_matches` store / migration，默认不影响现有 Planner。
- 在现有 Planner 前后记录是否存在潜在可复用 shape。

验收：

- 默认配置下不改变现有任务执行行为。
- `mode=observe` 下只产生观测记录，不改变 Planner 输入。
- 可以从 DB 看到 fingerprint、候选、rejection reason、Planner latency。
- `@zhujun/agentloop` 不依赖 `@zhujun/agentloop-plan-template`。
- SQLite 和 PostgreSQL store 至少有迁移与基础 CRUD 覆盖。

### Batch 2：人工种子模版与 planner_context

目标：

- 在插件包内新增 `plan_templates` / `plan_template_examples`。
- 人工配置 2 到 3 个低风险模版。
- 在全局配置 `mode=planner_context` 时启用 compact template hint，不跳过 LLM Planner。

验收：

- Planner 能看到 compact template hint。
- PlanAdmission / Assessment 成功率不下降。
- 不出现全局 prompt 膨胀。

### Batch 3：高置信 direct_use

目标：

- 仅在全局配置 `enabled=true`、`mode=direct_use`、`allowDirectUse=true` 时启用 direct_use。
- 对 `active` 且 `score >= minDirectUseScore` 的低风险模版启用 direct_use。
- PlanAdmission 失败自动降级 LLM Planner。

验收：

- direct_use 任务确实减少首轮 Planner 调用。
- admission 失败有负例记录。
- 完成仍由 Assessment / TerminalCommitter 证明。

### Batch 4：离线 TemplateMiner

目标：

- 从 completed Run 提炼 skeleton。
- 自动更新正例、负例、reliability。
- 支持 draft -> candidate -> active -> retired 生命周期。

验收：

- 只从 canonical completed evidence 提炼。
- 失败 Run 进入负例，不进入正例。
- Skill / Tool contract 变化会影响模版状态。

### Batch 5：质量闭环

目标：

- 引入 dashboard 或审计查询。
- 按 intentFamily 跟踪 savings 和失败率。
- 根据 reliability 自动降级不稳定模版。

验收：

- 能回答每个 direct_use 任务为什么命中、为什么可用、最终是否真的完成。
- 模版质量下降时可追溯到具体 negative examples。

## 15. 风险与处理

### 15.1 错误命中

风险：

文本相似但 sourceNeed、artifactKind、sideEffectKind 不同。

处理：

- 先硬约束 reject，再计算相似度。
- 维护 negative examples。
- 低于阈值只作为 Planner context。

### 15.2 模版绕过完成判断

风险：

Template 被误当成完成权威。

处理：

- Template 只能输出 PlanProposal。
- PlanAdmission、Assessment、TerminalCommitter 不因 template source 改变规则。
- 测试断言 Template 不可写 Delivery / Outcome。

### 15.3 模版库膨胀

风险：

过多相似模版导致维护和匹配噪音。

处理：

- 按 intentFamily 聚类合并。
- 只提升低失败率模版。
- 低使用、低质量模版自动 retired。

### 15.4 历史数据污染

风险：

历史上靠 fallback、模型 prose 或 artifact existence 完成的 Run 被误提炼。

处理：

- 正例必须检查 canonical Assessment、Delivery、Outcome。
- TemplateMiner 不读取 UI 文案作为完成证据。
- 缺失 evidenceKinds 的 Run 只能作为观察样本或负例。

## 16. 阶段性成功标准

第一阶段成功不是“模版命中率高”，而是：

```text
direct_use 任务的 PlanAdmission 失败率低
Assessment 失败率不高于普通 Planner
最终 Outcome 成功率不下降
Planner 调用和规划时延显著下降
所有 direct_use 都可追溯到 template、examples、match score、admission、evidence、delivery
```

最终目标：

> 高频同构任务不再每次都消耗完整 LLM Planner，但系统仍然保留 Plan-first、证据驱动 Assessment 和 TerminalCommitter 交付权威。

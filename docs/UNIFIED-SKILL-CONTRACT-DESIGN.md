# AgentLoop 统一 Skill 契约与快速扩展设计

版本：v1.0-draft

日期：2026-10-20

状态：设计方案，尚未实现

范围：`@zhujun/agentloop-skills`、应用 Custom Skills、用户上传 Skills、Skill 发现、适配、部署绑定、Runtime readiness、Planner、Admission 与执行授权

## 1. 结论

AgentLoop 不应为内置 Skill、Custom Skill 和第三方 Skill 维护不同的规划、准入或执行语义。三类 Skill 必须经过同一个契约编译边界，并生成同一种运行时对象：

```text
ResolvedSkillContract
  = EffectivePackageDeclaration
  intersect DeploymentBinding
  intersect RuntimeReadiness
  intersect Run/StepCapabilityGrant
```

其中：

- `EffectivePackageDeclaration` 描述 Skill 是什么、适用于什么任务、能提供什么工作流和执行接口；
- `DeploymentBinding` 描述当前部署允许该 Skill 使用哪些接口和 Host 策略；
- `RuntimeReadiness` 是 Host 对命令、模块、MCP、配置引用和可写范围的实测结果；
- `Run/StepCapabilityGrant` 是当前 Run 和 Step 的最小授权；
- 四者按交集收敛，任何一层缺失都不能由另一层补权。

所谓“内核 Skill”当前实际上来自独立发布包 `@zhujun/agentloop-skills`。它们可以拥有官方声明和默认绑定，但仍不得跳过统一契约编译、Runtime readiness、Admission 或 Run/Step grant。Bundled 与 Custom 的区别只在声明和绑定的发布者、默认选择策略与信任来源，不在运行时语义。

本设计的核心不是让所有 Skill 作者手写更多 AgentLoop 字段，而是把接入复杂度分层：

1. 纯说明 Skill 通过 `reference` 模板快速接入，只能加载指令；
2. 普通 builder、support、qa Skill 通过少量结构化选择生成契约草稿；
3. source 或 executable Skill 必须声明可验证的执行接口、依赖和证据生产者；
4. 自动分析只能生成草稿，不能直接生成执行授权；
5. Runtime 只消费编译后的 `ResolvedSkillContract`，不在 Planner、Admission 和 Executor 中重复解释源文件。

## 2. 当前问题

### 2.1 一个 frontmatter 承担了三种职责

当前 `SKILL.md` 的 `agentloop:` 块同时包含：

- 召回提示：`semanticTags`、`intentExamples`；
- 工作流契约：`roles`、`artifactKinds`、`sourceKinds`、`qaKinds`、`requiredSkillNames`；
- 执行与证据语义：`executionProfiles`、`producesEvidenceKinds`。

这些字段的风险等级不同。召回提示填错通常只影响候选排序，但执行 profile 会影响能力要求，证据类型会参与 Planner、Admission 和 Assessment。把它们作为同一组“元数据”要求扩展作者一次填写正确，会导致以下问题：

- 第三方 Skill 必须理解 AgentLoop 内部规划语义才能被选中；
- 自动推断很容易被误当成授权；
- 同一个声明在 frontmatter 和 executor action 中重复，可能发生漂移；
- 错误往往到 Plan Admission 或执行后才暴露，接入反馈过晚；
- Bundled 和 Custom 容易逐渐形成两套特例。

### 2.2 发现、适配、授权和就绪没有被明确分开

当前一个目录中存在合法 `SKILL.md`，只证明它是可检查的 Skill Package，不证明：

- Planner 应把它用于什么角色；
- Host 允许它执行脚本或访问网络；
- 所需命令、Python/Node 模块、MCP Server 或配置已经存在；
- 它声明的 evidence 确实能由某个 action 或 Host capability 产生；
- 当前 Run 和 Step 获得了相应授权。

因此必须保留以下不变量：

```text
Package discovery != Deployment approval
Deployment approval != Runtime readiness
Runtime readiness != Run authorization
Tool success != Step completion
```

### 2.3 内置 Skill 已共享发现入口，但未共享显式编译产物

Runtime Host 当前把 `bundledSkillDirectories()` 和应用配置的 Custom Skill 目录合并，再统一调用 `SkillService.syncSkillDirectories()`。这已经提供了统一发现入口。

缺少的是统一的契约编译结果。当前消费者仍直接读取 `skill.agentLoop`，不同字段分别影响候选选择、PlanningCapability、Admission 和工具能力。契约解释散落在多个运行边界，增加了迁移和一致性成本。

## 3. 目标与非目标

### 3.1 目标

1. Bundled、Custom、用户上传和未修改第三方 Skill 使用同一个运行时契约。
2. 第三方包可以保持字节不变，由部署方在包外适配并绑定。
3. AgentLoop-native Skill 可以携带版本化声明，不再依赖特定 YAML frontmatter 解析。
4. 自动化工具能够生成适配草稿、执行 doctor 和 smoke test，但不能自行授权。
5. Planner、Admission、Executor、Assessment 只消费 `ResolvedSkillContract`。
6. Skill 的执行接口、证据生产、环境依赖和授权范围在激活前可验证。
7. Multi Runtime 能用稳定 hash 判断 Host 是否具备同一份 Skill 契约。
8. 迁移期间保持现有行为可比较，迁移完成后删除长期双读。

### 3.2 非目标

- 不把领域 Skill 的业务语义迁入 Kernel。
- 不让 Skill 包直接携带 secret、设备路径或用户凭据。
- 不把 MCP 协议、供应商身份或外部 API 细节加入 Kernel schema。
- 不允许模型输出直接成为 Deployment Binding。
- 不因为 bundled 来源受信就给予无限执行权限。
- 不在本设计中引入 Skill Marketplace、远程自动更新或组织级审批产品流程。
- 不以兼容 fallback 掩盖无效声明、缺失依赖或 binding/package hash 不一致。

## 4. 术语与权威边界

| 对象 | 所有者 | 是否授权 | 作用 |
|---|---|---:|---|
| Skill Package | Skill 作者/发布者 | 否 | 保存 `SKILL.md`、脚本、资产、声明和 executor manifest |
| Package Declaration | Skill 发布者，或部署方 adapter | 否 | 描述角色、输入输出、QA、依赖关系和可执行接口 |
| Executor Manifest | Skill 发布者 | 否 | 描述 package action、输入模板、命令和 evidence 输出 |
| Deployment Binding | Runtime/部署管理员 | 是，但只能收紧 | 批准模式、action、Host policy、配置引用和依赖 |
| Runtime Readiness | Runtime Host | 否 | 记录当前 Host 对依赖和配置的实测结果 |
| Resolved Skill Contract | Kernel 编译器 | 否 | 形成 Planner、Admission、Executor 的统一不可变输入 |
| Run/Step Capability Grant | Runtime/Admission | 是 | 给当前执行叶子最小化授权 |

`ResolvedSkillContract` 本身不是额外授权来源。它只保存此前各层的交集和来源证明。真正执行时仍必须与当前 Run/Step grant 再取交集。

## 5. 包与配置布局

### 5.1 AgentLoop-native Skill

```text
skills/pptx/
├── SKILL.md
├── agentloop.skill.json
├── agentloop.executors.json
├── scripts/
├── assets/
└── references/
```

- `SKILL.md`：模型使用说明、领域流程和按需参考入口；
- `agentloop.skill.json`：版本化 Package Declaration；
- `agentloop.executors.json`：现有 package-owned executor action 接口；
- 包内所有文件继续参与 `agentloop.skillPackage/v1` hash。

### 5.2 未修改第三方 Skill

```text
team-skills/
├── third-party-ocr/
│   ├── SKILL.md
│   └── scripts/
├── third-party-ocr.source.json
└── third-party-ocr.agentloop.json
```

`third-party-ocr.agentloop.json` 是部署方拥有的包外 Binding：

- 必须绑定准确的 package name 和 `packageSha256`；
- 可以在 `adaptation` 中补充缺失的 Package Declaration；
- 可以批准该包的运行模式和 action；
- 不改变第三方包字节，因此不会伪装成上游内容；
- package hash 变化后立即失效，必须重新检查和批准。

### 5.3 Bundled Skill 的默认绑定

`@zhujun/agentloop-skills` 发布：

```text
@zhujun/agentloop-skills/
├── skills/
│   ├── pptx/
│   ├── docx/
│   └── ...
└── bindings/
    ├── pptx.agentloop.json
    ├── docx.agentloop.json
    └── ...
```

Bundled binding 由官方包发布者签发或通过发布包完整性建立信任。Host 可以禁用 action、收紧 policy 或完全禁用某个 bundled Skill，但不能扩大官方声明之外的能力。

现有 Local Runtime 文档中“内核 Skill 始终加载”的产品语义调整为：

> 官方 bundled Skills 默认绑定到每个 Runtime，用户清空 Custom Skill 时不会移除它们；但它们仍经过统一契约编译、Host readiness、Admission 和 Run/Step grant。

“默认绑定”不是“绕过绑定”。

## 6. Package Declaration

### 6.1 Schema 草案

文件：`agentloop.skill.json`

```json
{
  "schema": "agentloop.skillDeclaration/v1",
  "identity": {
    "name": "data-platform-query"
  },
  "activation": {
    "semanticTags": ["data-platform", "metadata-query", "data-governance"],
    "intentExamples": [
      "查询数据表字段、主键和上下游表级血缘"
    ]
  },
  "workflow": {
    "roles": ["source_provider"],
    "artifactKinds": ["none"],
    "sourceKinds": ["api", "database"],
    "qaKinds": [],
    "requiredSkills": []
  },
  "execution": {
    "manifest": "agentloop.executors.json"
  }
}
```

### 6.2 字段归属

#### `identity`

- `name` 必须与 `SKILL.md` frontmatter name 和目录发现名称一致；
- v1 不引入独立可变 display name；展示名称可以由应用投影；
- declaration 不声明 package hash，避免包内容对自身 hash 形成循环依赖。

#### `activation`

- `semanticTags` 和 `intentExamples` 只用于召回和 Planner 语义判断；
- 它们不是授权、能力或完成证明；
- 自动分析可以生成草稿，但必须在 binding 激活前确认。

#### `workflow`

- `roles`：`primary_builder | source_provider | support | qa`；
- `artifactKinds`：保持当前通用 artifact vocabulary；
- `sourceKinds`：描述来源类别，不描述供应商或业务实体；
- `qaKinds`：描述 Skill 自己要求的 QA 类别；
- `requiredSkills`：声明工作流依赖，必须在编译期解析并检测环。

这些字段描述 Skill 的能力上限，不产生权限。

#### `execution`

- 只引用 package-owned executor manifest；
- 不在 declaration 中重复 command、args、action inputs 或 evidence kinds；
- 无 package action 的 Skill 可以省略该字段；
- v1 不再在 declaration 中使用 `executionProfiles`。

### 6.3 Evidence 的唯一来源

`producesEvidenceKinds` 不再要求同时出现在顶层 Skill metadata 和 executor action 中。

规则如下：

1. Package action 产生的 evidence 以 `agentloop.executors.json` 中 action 声明为事实来源；
2. Host policy 产生的 evidence 以已注册的 Host capability profile 为事实来源；
3. 编译器按获批 action 和 Host policy 汇总 `resolvedEvidenceProducers`；
4. `source_provider` 必须至少有一个可验证的 evidence producer；
5. declaration、binding 或旧 frontmatter 中出现无生产者支持的 evidence kind 时拒绝编译；
6. Runtime 执行后仍需验证回执与 action 声明一致，声明本身不是 evidence。

示例：

```text
query action declares source_summary
  + Deployment Binding approves query
  + Runtime verifies command and config readiness
  -> Resolved contract exposes source_summary

query action not approved
  -> source_summary is not exposed by that action
```

## 7. Executor Manifest

保留现有文件名和 schema：

```text
agentloop.executors.json
agentloop.skillExecutors/v1
```

它继续描述：

- bare executable；
- package-relative script；
- action ID、说明和输入；
- 参数模板；
- result 说明；
- action 产生的 evidence kinds；
- Human-in-the-Loop decision binding。

必须继续满足：

- manifest 只描述如何调用已获批 package action，不授予 capability；
- action ID 在 package 内唯一；
- script 必须存在于同一不可变 package；
- evidence input 必须占据完整参数，并由 Runtime 捕获不可变输入身份；
- command、script、args 和 result schema 不得由 Deployment Binding 改写；
- Binding 只能选择 action 子集和附加更严格策略。

后续如需扩展运行依赖，应发布 `agentloop.skillExecutors/v2`，不在 v1 中塞入无法验证的自由字段。

## 8. Deployment Binding

### 8.1 Schema 草案

文件：`<skill-name>.agentloop.json`，或由 Local Agent/Cloud Host 配置存储保存等价对象。

```json
{
  "schema": "agentloop.skillBinding/v1",
  "package": {
    "name": "data-platform-query",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "publisher": {
    "kind": "deployment",
    "id": "local-agent-device"
  },
  "mode": "source",
  "approvedActions": ["query"],
  "policies": ["read-only-source", "task-workspace-write"],
  "requirements": {
    "configurationRefs": ["API_QUERY_ENV_FILE"],
    "mcpSources": [],
    "pythonModules": [],
    "nodeModules": []
  }
}
```

未修改第三方包没有 native declaration 时，Binding 可以增加 `adaptation`：

```json
{
  "schema": "agentloop.skillBinding/v1",
  "package": {
    "name": "third-party-ocr",
    "sha256": "..."
  },
  "publisher": {
    "kind": "deployment",
    "id": "team-a"
  },
  "mode": "builder",
  "adaptation": {
    "activation": {
      "semanticTags": ["ocr"],
      "intentExamples": ["从扫描件中提取文字"]
    },
    "workflow": {
      "roles": ["primary_builder"],
      "artifactKinds": ["document"],
      "sourceKinds": ["document"],
      "qaKinds": ["content"],
      "requiredSkills": []
    },
    "execution": {
      "manifest": "agentloop.executors.json"
    }
  },
  "approvedActions": ["extract"],
  "policies": ["task-workspace-write"],
  "requirements": {
    "configurationRefs": []
  }
}
```

### 8.2 Binding 的能力边界

Binding 可以：

- 将 package 绑定到准确 hash；
- 选择 `reference | builder | source | support | qa` 模式；
- 批准 package 声明 action 的子集；
- 选择 Host 已知的安全策略；
- 声明 manifest 无法表达的模块、MCP 和非 secret 配置引用；
- 禁用或收紧官方默认 binding。

Binding 不可以：

- 修改 package 中 command、script 或 args；
- 声明 package/Host 都不能生产的 evidence；
- 引入包外任意脚本路径；
- 内嵌 token、password、API key 或 credential value；
- 扩大 package declaration 的 roles、artifact kinds 或 source kinds；
- 绕过 ToolRegistry、Admission、sandbox manifest 或 Run/Step grant。

`adaptation` 是第三方无声明包的显式例外：它由部署方承担声明责任，但仍不能改变 package bytes 或声明不存在的 executor action。

获批 action 使用的 executable 由 executor manifest 自动汇总，Binding 不重复填写 command。静态扫描可以提出 Python/Node 模块候选，但只有经部署方确认后才能进入 `requirements`。

### 8.3 模式模板

| mode | 最小要求 | 默认可用能力 | 典型用途 |
|---|---|---|---|
| `reference` | 合法 `SKILL.md` | `load_skill` | 规范、方法、写作指南 |
| `builder` | `primary_builder` 与 artifact contract | 由 artifact/Host policy 决定 | 文档、表格、演示、代码生成 |
| `source` | `source_provider`、source kind、evidence producer | 只读来源策略，按需工作区写入回执 | API、数据库、Web、仓库查询 |
| `support` | `support` role | 不独立完成任务 | 主题、规范、领域辅助 |
| `qa` | `qa` role 和 qa kinds | 只读输入、受控 QA 输出 | 内容、视觉、openability 检查 |

模板只生成 Binding 草稿和校验要求，不是运行时特例。所有模板最终编译到同一对象。

## 9. Runtime Readiness

### 9.1 Readiness 是实测状态，不是声明

Runtime Host 在激活 Skill 前检查：

- package 和 Binding hash 是否匹配；
- declaration 和 executor manifest 是否可解析；
- action 引用的 script 是否存在且属于 package；
- command 是否存在并符合 Host allowlist；
- Python/Node 模块是否可加载；
- 必需 MCP source 是否已绑定且完整完成 initialize、session 和 `tools/list`；
- 配置引用是否存在，但不得读取或输出 secret value；
- 所需可写范围是否能由 Host policy 提供；
- required Skill 是否存在、ready 且无依赖环；
- evidence producer 是否覆盖 source contract。

Readiness 结果示例：

```ts
interface SkillRuntimeReadiness {
  readonly schema: "agentloop.skillRuntimeReadiness/v1";
  readonly runtimeId: string;
  readonly packageName: string;
  readonly packageSha256: string;
  readonly bindingSha256: string;
  readonly status: "ready" | "needs-runtime" | "rejected";
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed" | "failed";
    readonly code?: string;
    readonly message: string;
  }[];
  readonly checkedAt: number;
}
```

不得把凭据值、完整环境变量、MCP header 或上游错误正文写入 readiness。

### 9.2 状态模型

```text
discovered
  -> catalog-only
  -> needs-binding
  -> needs-runtime
  -> ready

任何阶段发现不可接受的结构、安全或契约矛盾
  -> rejected
```

语义：

- `catalog-only`：结构合法，但未绑定；不能进入 Planner candidates；
- `needs-binding`：缺少部署批准，或包 hash 更新使旧 binding 失效；
- `needs-runtime`：契约有效，但当前 Host 缺依赖或配置；
- `ready`：可以进入当前 Runtime 的 Skill catalog；
- `rejected`：结构、安全、声明或依赖关系不可接受，需要修改包或 binding。

状态不得静默降级。例如 `source` Skill 缺少 evidence producer 时不能自动变成 `reference`；管理员可以显式新建 `reference` Binding。

## 10. ResolvedSkillContract

### 10.1 统一对象

```ts
interface ResolvedSkillContract {
  readonly schema: "agentloop.resolvedSkillContract/v1";
  readonly identity: {
    readonly skillId: string;
    readonly name: string;
    readonly source: "bundled" | "custom_directory" | "uploaded";
    readonly packageSha256: string;
    readonly bindingSha256: string;
    readonly contractSha256: string;
  };
  readonly activation: {
    readonly semanticTags: readonly string[];
    readonly intentExamples: readonly string[];
  };
  readonly workflow: {
    readonly roles: readonly ("primary_builder" | "source_provider" | "support" | "qa")[];
    readonly artifactKinds: readonly string[];
    readonly sourceKinds: readonly string[];
    readonly qaKinds: readonly string[];
    readonly requiredSkillIds: readonly string[];
  };
  readonly execution: {
    readonly approvedActions: readonly ResolvedSkillAction[];
    readonly policyIds: readonly string[];
    readonly requiredCapabilityIds: readonly string[];
    readonly evidenceProducers: readonly {
      readonly kind: string;
      readonly producer: { readonly actionId: string } | { readonly capabilityId: string };
    }[];
  };
  readonly readiness: {
    readonly status: "ready";
    readonly attestationId: string;
  };
  readonly provenance: {
    readonly declarationSource: "package" | "legacy-frontmatter" | "binding-adaptation";
    readonly bindingPublisher: string;
  };
}
```

`ResolvedSkillAction` 是已校验 executor action 的不可变投影，保留 package action ID、command、script、输入、args 模板、result 描述、evidence kinds 和 decision binding。

### 10.2 合并规则

契约编译器使用以下固定规则：

1. native declaration 与 package identity 必须一致；
2. 没有 native declaration 时，只能使用 hash-bound `binding.adaptation`；
3. 旧 frontmatter 仅在迁移期作为 declaration source；
4. binding mode 必须与 declaration roles 相容；
5. approved actions 必须是 manifest actions 的子集；
6. binding policy 只能收紧，不能覆盖 package action；
7. required Skill 名称在同一已绑定 catalog 中解析为 ID；
8. dependencies 必须形成有向无环图；
9. evidence kinds 从获批 producer 汇总，不从自由文本猜测；
10. readiness 不是 `ready` 时不生成可调度 contract；
11. 对语义字段做稳定排序和规范化后计算 `contractSha256`；hash 排除自身、`runtimeId`、`checkedAt` 和 readiness attestation ID；
12. 相同 package、binding 和 Host capability catalog 必须产生相同 contract hash。

任何矛盾都 fail closed，不使用“以 binding 为准”“以内置为准”或“继续使用旧 frontmatter”等优先级 fallback。

`RuntimeReadiness` 是 Host 对该 contract 的独立证明和发布门禁。它决定当前 Host 能否发布 contract，但不把实例身份或检查时间混入跨 Host 比较使用的 `contractSha256`。

## 11. 运行链路

### 11.1 启动与同步

```text
Bundled directories + selected Custom/uploaded packages
  -> inspect immutable packages
  -> load native declaration or hash-bound adaptation
  -> load Deployment Binding
  -> validate executor manifest
  -> run Host readiness checks
  -> compile ResolvedSkillContract
  -> atomically publish Runtime Skill Catalog revision
```

只有编译成功且 ready 的 contract 能进入 Planner catalog。发现列表和拒绝诊断可以保留给管理界面，但不能进入 Run 可用集合。

### 11.2 Planner

Planner 只读取 contract 的：

- identity；
- activation hints；
- workflow roles；
- artifact/source/QA compatibility；
- required Skill graph；
- 可用 evidence kinds 和 capability IDs。

Planner 不读取 Deployment Binding 原文、Host 文件路径、环境变量名或 readiness 诊断。

### 11.3 Admission

Admission 校验：

- Plan 选择的 Skill contract 属于当前 catalog revision；
- Step 使用的 Skill role 在 contract 中存在；
- required Skill 已一并绑定；
- required capabilities 是 contract 暴露能力的子集；
- source evidence contract 有获批 producer；
- artifact 和 QA 要求与当前 Step contract 相容；
- 当前 grant 可以覆盖解析后的 capability requirements。

Admission 不再回头解析 `SKILL.md` frontmatter。

### 11.4 执行

执行前再计算：

```text
EffectiveStepCapabilities
  = ResolvedSkillContract.requiredCapabilityIds
  intersect StepExecutionBinding.resolvedCapabilityIds
  intersect RunCapabilityGrant
  intersect HostPolicy
```

模型不能通过 Skill 文本、命令参数或工具名扩大这个集合。

执行 action 时，ToolRegistry 使用 contract 中已经解析的 action；Runtime 验证输入、decision binding、immutable evidence input、sandbox manifest 和回执。执行成功只产生 Action/Tool evidence，不直接证明 Step 或 Run 完成。

### 11.5 Assessment 与 TerminalCommitter

Assessment 使用 contract 中的 QA 和 evidence contract 检查 Step 结果。TerminalCommitter 仍只接受已 Assessment 的 Step 结果和正式 delivery evidence。

Skill ready、Skill 被加载、action 返回成功、文件存在或模型声称完成，都不能替代这条完成链路。

## 12. Multi Runtime 一致性

Runtime catalog 对 Router 只发布调度必要摘要：

```ts
interface RuntimeSkillCapabilitySummary {
  readonly skillName: string;
  readonly packageSha256: string;
  readonly bindingSha256: string;
  readonly contractSha256: string;
  readonly roles: readonly string[];
  readonly artifactKinds: readonly string[];
  readonly sourceKinds: readonly string[];
  readonly capabilityIds: readonly string[];
}
```

Router 不接收：

- `SKILL.md` 正文；
- package 本地路径；
- executor args；
- 配置文件路径；
- secret 或 MCP 凭据；
- readiness 详细诊断。

调度规则：

- 任务指定 Skill 时，只能选择发布匹配 `contractSha256` 的 Host；
- 同一 Runtime pool 中同名 Skill contract 不一致时，标记 catalog drift，不能假设 Host 等价；
- 新 contract revision 只有在 Host 原子发布后用于新 Run；
- 已开始 Run 固定使用创建时记录的 contract revision，不热切换；
- Host 重启或 readiness 变化只影响后续调度，不篡改历史 Run。

## 13. 快速接入工具

第一期提供 CLI，不先依赖管理 UI：

```bash
agentloop skill inspect <package-dir>
agentloop skill adapt <package-dir> --template reference|builder|source|support|qa
agentloop skill doctor <package-dir> --binding <binding-file>
agentloop skill smoke-test <package-dir> --binding <binding-file>
agentloop skill activate <package-dir> --binding <binding-file>
```

### 13.1 `inspect`

输出：

- package identity、hash、文件数和大小；
- native declaration、legacy frontmatter 和 executor manifest 状态；
- 脚本、解释器、模块、MCP 和配置引用候选；
- 敏感文件、符号链接、越界路径和可写状态风险；
- 推荐模板；
- 不产生或修改 Binding。

### 13.2 `adapt`

- 从 `SKILL.md` 和 manifest 生成 Binding 草稿；
- 对 `semanticTags`、`intentExamples` 和角色给出候选；
- 不能自动确认 action、网络、命令、配置或写入授权；
- 输出文件默认未激活；
- 显示每个字段的推导依据和待确认项。

### 13.3 `doctor`

- 执行完整静态校验和 Host readiness；
- 输出稳定错误码；
- 不调用有业务副作用的 action；
- 配置检查只验证引用是否存在，不打印值；
- MCP 检查执行完整 initialize/session/`tools/list`；
- 结果可供本地 UI 展示，但不是运行授权。

### 13.4 `smoke-test`

- 只运行 Binding 明确批准且声明为可 smoke test 的 action；
- 使用隔离工作区和非生产 fixture；
- 验证 result schema、evidence kinds、输入回指和敏感信息泄漏；
- 不将 smoke test 成功当作真实外部数据、生产连通性或业务结果证明。

### 13.5 `activate`

- 校验 package hash 和 Binding；
- 要求 doctor 通过；
- 原子写入或更新 Runtime binding；
- 触发 catalog revision 构建；
- 不在运行中的 Runtime 热替换 contract；
- Multi Runtime 环境按部署策略滚动激活。

## 14. 持久化建议

### 14.1 Package Store

继续使用不可变 package store，并保存：

- package name/hash；
- 文件 inventory；
- `SKILL.md` hash；
- native declaration hash；
- executor manifest hash；
- verified upstream source lock（如有）。

### 14.2 Binding Store

Binding 是部署/Runtime 配置，不写回 package。建议保存：

```ts
interface SkillBindingRecord {
  readonly runtimeId: string;
  readonly skillName: string;
  readonly packageSha256: string;
  readonly bindingJson: string;
  readonly bindingSha256: string;
  readonly publisherKind: "bundled" | "deployment" | "user";
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
```

Local Runtime 使用 Runtime 私有 binding；Cloud Runtime 可以使用部署级 binding 集合，但每个 Host 必须发布实际解析结果。现有目录发现配置继续只负责“可以检查哪些包”，不得等同于“哪些包已经授权”。

### 14.3 Contract Snapshot

Run 创建时记录：

- catalog revision；
- selected Skill IDs；
- 每个 Skill 的 package、binding、contract hash；
- Admission 使用的 resolved capability IDs。

不需要把整份 Skill 正文或 secret 复制进 Run。历史诊断通过不可变 package snapshot 和 contract hash 回溯。

## 15. 安全规则

1. Skill Package、Binding、readiness 和 Run grant 分层存储，不能互相代替。
2. 包内 `.env`、私钥、credential 文件和设备配置覆盖文件拒绝接入。
3. Binding 只保存配置引用，不保存 secret value。
4. Skill scripts 默认在只读 package root、受控 task workspace 和 Host 生成 sandbox manifest 下执行。
5. 包外 adapter 不得引用包外 script。
6. package hash 或 binding hash 变化使旧 readiness 和 contract 立即失效。
7. 自动生成的 adaptation 必须经过明确批准。
8. Bundled publisher trust 只证明声明来源，不替代 Host policy。
9. Runtime 不根据 Skill 文本中的命令、业务关键词或供应商名称动态加权授权。
10. 所有拒绝使用稳定错误码和可审计原因，不静默回退到较宽能力。

建议错误码：

```text
SKILL_DECLARATION_MISSING
SKILL_DECLARATION_INVALID
SKILL_BINDING_MISSING
SKILL_BINDING_HASH_MISMATCH
SKILL_BINDING_ESCALATES_DECLARATION
SKILL_EXECUTOR_MANIFEST_INVALID
SKILL_ACTION_NOT_DECLARED
SKILL_EVIDENCE_PRODUCER_MISSING
SKILL_DEPENDENCY_UNAVAILABLE
SKILL_DEPENDENCY_CYCLE
SKILL_RUNTIME_REQUIREMENT_MISSING
SKILL_CONTRACT_CATALOG_DRIFT
```

## 16. 与现有设计的关系

### 16.1 Local Runtime Skill/MCP 配置

本设计保留以下既有结论：

- Custom/上传 Skill 必须由具体 Runtime 显式选择；
- 发现或安装不等于授权；
- 运行态配置不可变；
- MCP 配置和 secret 属于 Local Agent/Runtime；
- Factory 只加载当前 Runtime 已绑定的扩展能力。

需要细化的表述是“内核 Skills 固定加载”：

- 产品上仍默认对所有 Runtime 启用 bundled Skills；
- 实现上它们是默认 Binding，不是绕过 Binding；
- Host 可以按部署策略禁用或收紧；
- 它们仍必须 readiness=ready，仍受 Run/Step grant 约束。

### 16.2 Capability-first Planning

本设计不改变 `TaskProfile -> SkillRoleSelection -> OutcomePlan -> Admission -> ExecutionBinding` 主链路，只替换 Skill metadata 的权威来源：

```text
旧：多个边界直接读取 skill.agentLoop
新：多个边界只读取 ResolvedSkillContract
```

### 16.3 MCP ToolSource

MCP 仍由 App/Host 物化为 Runtime tools。Skill contract 只能声明需要某个已配置的 MCP source/capability，不能携带连接 URL、header 或 secret，也不能让 Kernel 理解 MCP 协议。

### 16.4 Runtime Result 与完成语义

Skill action evidence 继续进入正式 Runtime Result/Evidence 链路。统一 Skill contract 不创建第二套结果对象，也不改变 Assessment 和 TerminalCommitter 的完成权威。

## 17. 迁移方案

### 阶段 0：建立行为基线

- 枚举 bundled、Custom 和测试 fixture 的当前 metadata；
- 记录每个 Skill 的 Planner role、artifact/source/QA、required Skill 和 capability 行为；
- 检查顶层 evidence 与 executor action evidence 的一致性；
- 为当前 bundled Skills 建立 selection/Admission 快照测试。

### 阶段 1：引入统一编译器

- 新增 declaration、binding、readiness 和 resolved contract 类型；
- 让现有 `agentloop:` frontmatter 编译为 legacy Package Declaration；
- 让现有 executor manifest 进入同一编译过程；
- `PrivateSkill` 暂时同时保留旧字段和 resolved contract，但新消费者优先迁移；
- 增加相同输入产生稳定 contract hash 的测试。

本阶段不改变现有 Skill 行为。

### 阶段 2：迁移消费者

按权威链顺序迁移：

1. Skill catalog projection；
2. `selectPlanningSkillRoles()`；
3. `planningCapabilitiesFromSkills()`；
4. required Skill companion binding；
5. Admission capability requirements；
6. execution action binding；
7. Assessment QA/evidence contract；
8. Runtime catalog summary。

迁移完成后，Planner、Admission 和 Executor 不再直接解析 frontmatter。

### 阶段 3：迁移 bundled Skills

- 为 `@zhujun/agentloop-skills` 中每个包新增 `agentloop.skill.json`；
- 为需要 package action 的 Skill 补齐或校正 executor manifest；
- 发布 bundled default bindings；
- 对每个 Skill运行“legacy frontmatter 与 declaration 编译等价”测试；
- 对具备脚本的 Skill运行 doctor 和 fixture smoke test。

Bundled Skills 先迁移，用来验证 schema 是否足够通用。不得为了某个 bundled Skill 给编译器添加产品或业务特例。

### 阶段 4：接入 Custom 与第三方 Skill

- 实现 package 外 Binding；
- 提供五种模板和 CLI；
- Local Agent 创建/编辑 Runtime 时保存明确 binding；
- 上传 Skill 默认进入 `catalog-only` 或 `needs-binding`，不能自动 ready；
- Cloud Host 使用部署配置管理 binding。

### 阶段 5：删除旧路径

- 停止从 `SKILL.md` 读取 `agentloop:`；
- 删除 `SkillAgentLoopMetadata` 在 Planner/Admission 中的直接消费；
- 删除顶层 `producesEvidenceKinds` 重复声明；
- 删除迁移期 dual-read 和等价性适配器；
- 更新 Skill creator、文档和发布检查，只生成新 declaration。

这是有期限的迁移，不保留永久兼容 fallback。

## 18. 测试方案

### 18.1 Schema 与编译器

1. native declaration 正常编译；
2. 无 native declaration 的第三方包可通过 hash-bound adaptation 编译；
3. package hash 变化后 Binding 失效；
4. Binding 试图扩大 roles、source/artifact kinds 或 action 时拒绝；
5. action evidence 与未知 evidence kind 不一致时拒绝；
6. required Skill 缺失或形成环时拒绝；
7. 输入顺序不同但语义相同产生相同 contract hash；
8. package/binding/Host capability 任一变化产生不同 contract hash。

### 18.2 Bundled 与 Custom 等价性

对相同 declaration、manifest、binding 和 readiness：

- bundled 与 custom 产生相同 workflow/execution contract；
- Planner role selection 相同；
- Admission requirements 相同；
- executor action binding 相同；
- 只有 `identity.source` 和 publisher provenance 不同。

### 18.3 权限收敛

1. package 声明 action、Binding 未批准：不可执行；
2. Binding 批准 action、package 未声明：启动拒绝；
3. contract ready、Step grant 不含 capability：ToolRegistry 拒绝；
4. bundled Skill 缺少 Runtime command：`needs-runtime`，不能绕过；
5. reference Skill 只能加载指令，不能调用 package script；
6. source Skill 没有 evidence producer：不能进入 ready；
7. Skill 文本要求危险命令不能扩大 sandbox manifest。

### 18.4 Multi Runtime

1. 相同 pool 中 contract hash 一致时可以等价调度；
2. 同名不同 contract hash 产生 drift 诊断；
3. 缺少 selected Skill 的 Host 不参与调度；
4. Run 固定旧 catalog revision，Host 更新不改变运行中 Run；
5. Router 不接收 package path、正文、配置引用值或 secret。

### 18.5 端到端验收

至少覆盖：

- 一个 bundled artifact builder；
- 一个无脚本 reference Skill；
- 一个 custom local-script builder；
- 一个 API source provider；
- 一个数据库 source provider及下游 analysis Skill；
- 一个使用 required Skill graph 的组合任务；
- 一个 readiness 失败后修复配置、重启 Runtime、再提交新 Run 的流程。

验证链路必须包含：

```text
package/binding inspection
  -> readiness
  -> catalog revision
  -> planning.skills.role_selected
  -> admitted execution binding
  -> action/evidence receipt
  -> Assessment
  -> TerminalCommitter
  -> Outcome
```

只验证文件存在、schema 可解析、单元测试通过或 action 返回成功，不构成完整 E2E 证明。

## 19. 验收标准

设计实现完成必须同时满足：

1. Bundled、Custom 和第三方适配 Skill 最终使用同一种 `ResolvedSkillContract`。
2. Planner、Admission、Executor 不再分别解释 Skill 源 metadata。
3. 未绑定 Skill 不进入 Planner；未 ready Skill 不进入 Runtime 可调度 catalog。
4. Binding、readiness 和 Run grant 均只能收紧，不能扩大 package 声明。
5. Package action evidence 只有一个结构化事实来源。
6. Bundled Skill 不享有绕过 readiness 或 Run/Step grant 的特殊路径。
7. 第三方包可保持字节不变，并通过 hash-bound Binding 接入。
8. Custom Skill 可以通过模板、doctor 和 smoke test 快速完成接入。
9. package、binding 和 contract hash 可以稳定审计并用于 Multi Runtime drift 检测。
10. 旧 frontmatter 路径在迁移完成后被删除，而不是长期保留 fallback。

## 20. 推荐实施顺序

建议先实现以下最小闭环：

1. `agentloop.skillDeclaration/v1`；
2. `agentloop.skillBinding/v1`；
3. `ResolvedSkillContract` 编译器与稳定 hash；
4. legacy frontmatter 到 declaration 的一次性迁移适配；
5. bundled Skill 等价性测试；
6. Planner 和 Admission 改为消费 resolved contract；
7. readiness/doctor；
8. Custom/第三方 Binding 与 CLI；
9. Multi Runtime contract hash 发布；
10. 删除 legacy metadata 读取。

这个顺序先统一权威边界，再改善扩展体验。不能先做一个只服务 Custom Skill 的上传或 metadata 向导，然后让 bundled Skill 继续走旧路径；那会把临时接入方案固化成第二套运行时语义。

# Capability-First Planner 与执行绑定调整方案

版本：v0.1
日期：2026-09-07
状态：下一阶段修改方案

## 1. 目标结论

轻量 Plan-first 的 Planner 不应该直接感知全量执行工具目录。Planner 的职责是形成最小 Outcome Plan，表达当前 leaf 需要什么能力、什么证据、什么来源类型和什么副作用等级；具体工具名、参数 schema、工具暴露策略应由 Runtime 在执行 leaf 前解析。

目标链路：

```text
TaskProfile
  -> SkillRoleSelection
  -> Capability-first OutcomePlan
  -> Admission capability binding
  -> StepExecutionBinding
  -> Leaf-local Tool materialization
  -> EvidenceAssessment
  -> TerminalCommit
```

核心变化：

- Planner 输出 `requiredCapabilities`，不再输出执行工具名。
- Planner 输入只包含 capability catalog，不包含全量 `availableTools` 名称与描述目录。
- Admission 负责把 capability 解析成当前 Run 授权范围内的 `resolvedToolNames`。
- 执行层继续使用工具名执行，但工具名来源是 Runtime 绑定结果，不是 Planner 建议。

## 2. 当前实现断点

当前实现已经做到 Planner 可调用工具很轻：模型调用阶段只暴露 `submit_outcome_plan`，执行工具不会作为 function tools 暴露给 Planner。

但 Plan 合约仍然是工具名驱动：

- `OutcomeLeaf` schema 强制要求 `recommendedToolNames`。
- `planningRuntimeContext()` 将 `availableToolNames` 和 `availableTools` 放入 Planner 可见上下文。
- `RunService.toolSummaries()` 将授权工具压缩成 `{ name, description, dangerous }` 后传给 Planner。
- Admission 校验 leaf 推荐工具名是否属于当前授权集合。
- 执行上下文、StepSemanticFrame、progress policy、Assessor 继续从 `recommendedToolNames` 推断来源、操作类型和评估策略。

因此，当前状态不是“schema 太重”，而是 Planner 和执行层之间的语义边界仍然以具体工具名为中介。

## 3. 非目标

本方案不做这些事：

- 不保留 `recommendedToolNames` 作为长期双轨兼容字段。
- 不把 `availableTools` 改名后继续给 Planner 看全量工具摘要。
- 不在 Planner prompt 里通过文字要求“少用工具”来代替 schema 收敛。
- 不把 MCP、web、visible directory、uploaded source、PPT、HTML 等场景写成 Planner 特例。
- 不削弱 `CapabilityGrant`、ToolRegistry、Assessment 或 TerminalCommitter 的权威边界。
- 不让执行层失去工具名；只改变工具名的所有权来源。

## 4. 新契约对象

### 4.1 PlanningCapability

Planner 可见的是能力目录，不是工具目录。

```ts
interface PlanningCapability {
  id: string;
  label?: string;
  produces: EvidenceKind[];
  sourceKinds: SourceKind[];
  sideEffect: "none" | "workspace_read" | "workspace_write" | "external_read" | "external_write";
  risk: "low" | "medium" | "high";
  constraints?: string[];
}

type SourceKind =
  | "uploaded_source"
  | "visible_directory"
  | "workspace_file"
  | "web"
  | "conversation_workset"
  | "generated_artifact";
```

示例：

```json
{
  "id": "uploaded_source_read",
  "produces": ["source_summary", "explicit_caveats"],
  "sourceKinds": ["uploaded_source"],
  "sideEffect": "none",
  "risk": "low",
  "constraints": ["requires uploaded source grant"]
}
```

### 4.2 Capability-First OutcomeLeaf

Planner 输出 leaf 时表达能力需求：

```ts
interface OutcomeLeaf {
  id: string;
  objective: string;
  dependsOn: string[];
  role: "fact_acquisition" | "produce" | "deliver" | "repair";
  skillIds: string[];
  requiredCapabilities: string[];
  evidenceContract: EvidenceContract;
}
```

`requiredCapabilities` 是 Planner 与 Admission 的接口；它不是执行授权，也不是工具调用清单。

### 4.3 StepExecutionBinding

Admission 成功后写入执行绑定：

```ts
interface StepExecutionBinding {
  schema: "agentloop.stepExecutionBinding/v1";
  requiredCapabilities: string[];
  resolvedToolNames: string[];
  sourceKinds: SourceKind[];
  sideEffect: "none" | "workspace_read" | "workspace_write" | "external_read" | "external_write";
  evidenceKinds: EvidenceKind[];
}
```

执行层消费 `StepExecutionBinding`，而不是再从 Planner 原始字段推断工具语义。

## 5. 分阶段修改方案

### 5.1 第一阶段：收窄 Planner 输入输出

修改点：

- 在 `PlanStepProposal` / `PlanStep` 中增加 `requiredCapabilities`。
- 在 `submit_outcome_plan` schema 中将 `recommendedToolNames` 替换为 `requiredCapabilities`。
- `planningRuntimeContext()` 去掉模型可见的 `availableToolNames` / `availableTools`。
- RunService 为 Planner 构造 `availableCapabilities`。
- 保留 Runtime 内部的 `allowedToolNames`，但不投影给 Planner。

验收：

- Planner request 的 function tools 仍然只有 `submit_outcome_plan`。
- Planner runtime context 不包含 `computer_read_file`、`websearch`、`read_source` 等执行工具名。
- Planner 可基于 capability catalog 生成 source、artifact、direct answer 等 Plan。

### 5.2 第二阶段：Admission 解析能力到工具

修改点：

- Admission 校验 `requiredCapabilities` 是否来自 server 提供的 capability catalog。
- Admission 根据 `CapabilityGrant.allowedToolNames`、工具元数据、Skill metadata 和 sources/visible directories 解析 `resolvedToolNames`。
- Admission 将 `StepExecutionBinding` 写入 admitted `PlanStep`。
- 如果 capability 当前不可满足，Admission fail-fast，并给出缺失 capability 或授权原因。

绑定原则：

- 同一个 capability 可以解析到多个工具，例如 artifact production 可能包含 write、run、acceptance。
- 同一个工具可以服务多个 capability，但工具选择仍由 Runtime 统一解析。
- Skill-required tools 仍由 Skill metadata 注入，但写入 execution binding，而不是回写 Planner 字段。

### 5.3 第三阶段：执行层改读绑定结果

这些模块要从 `recommendedToolNames` 迁移到 `executionBinding`：

- `run-service.ts`：step started event、direct delivery 判断、file output 判断、lookup convergence 判断。
- `execution-context-policy.ts`：`currentPlanStep`、`downstreamPlanSteps`、evidence acquisition discipline。
- `step-semantic-frame.ts`：web、visible directory、uploaded source、workspace file、artifact production 分类。
- `tool-progress-policy.ts`：exploratory/evidence-producing/acceptance tool 识别。
- `assessor.ts`：lookup evidence 和 source caveat policy。
- `plan-repository.ts`：持久化 Plan step 新字段。
- `operation-profiles.ts`：从能力或 binding 推断 operation profile。

执行层仍然通过 `ToolRegistry.materialize()` 暴露完整工具 schema。区别是 step grant 的来源变成：

```text
root CapabilityGrant.allowedToolNames
  + StepExecutionBinding.resolvedToolNames
  + StepExecutionStrategy narrowing
  -> current model step materialized tools
```

### 5.4 第四阶段：Plan Template 改为能力语义

Plan Template 当前已经有 `requiredCapabilities` 语义，但仍可能从旧工具名反推。

修改点：

- template mining 读取 leaf `requiredCapabilities`，不再把 `recommendedToolNames` 当 capability。
- template matching 只比较 task capability、operation、source need、artifact kind 和 instruction affinity。
- direct-use 实例化 Plan 时输出 capability-first leaf。

验收：

- API 查询、web research、MCP source、artifact build 不因工具名相似而误匹配。
- 具体执行工具可变时，模板仍然按能力稳定匹配。

## 6. 执行层影响评估

这不是一个 Planner-only 改动。执行层会受影响，但影响是可控的，因为执行授权与工具物化本来就不应依赖 Planner。

不会受影响的边界：

- `CapabilityGrant` 仍然是 Run/step 授权来源。
- `ToolRegistry.prepare()` 仍然负责工具名可用性和参数 schema 校验。
- `ToolRegistry.materialize()` 仍然是完整工具 schema 暴露点。
- Assessment 和 TerminalCommitter 仍然根据 canonical evidence 判断完成。

会受影响的边界：

- `recommendedToolNames` 目前同时承担 Planner 建议、执行语义、评估策略、上下文说明和持久化字段五种职责。
- 迁移后这些职责要拆开：
  - Planner 建议 -> `requiredCapabilities`
  - 执行工具 -> `executionBinding.resolvedToolNames`
  - 来源语义 -> `executionBinding.sourceKinds`
  - 评估语义 -> `evidenceContract`
  - 工具暴露 -> `StepExecutionStrategy`

风险点：

- 如果只删 `recommendedToolNames`，source/web/artifact 识别会退化。
- 如果同时保留旧字段和新字段，Planner 仍可能继续按工具名规划，形成双轨污染。
- 如果 binding 缺少 sourceKinds/sideEffect/evidenceKinds，执行层会重新从工具名猜语义。

## 7. 数据与迁移策略

建议做一次 schema 升级，而不是长期兼容：

- 新 Plan 使用 `required_capabilities_json` 与 `execution_binding_json`。
- 旧 `recommended_tool_names_json` 可以保留为历史只读字段，当前执行链不再依赖它。
- 对未完成的旧 Run，不做透明兼容执行；需要恢复时进入 recovery/replan，由新 Planner 生成 capability-first Plan。
- UI 展示层可以将 execution binding 渲染为“能力/工具解析结果”，避免继续把 Planner 推荐工具当主要语义。

这符合 clean-break 原则：历史记录可读，当前执行不走双轨。

## 8. 回归测试清单

必须新增或调整这些测试：

1. Planner request 只包含 `submit_outcome_plan`，runtime context 不包含执行工具名或工具描述。
2. Planner 输出 `requiredCapabilities` 后，Admission 解析出 `read_source`。
3. visible directory capability 解析出 `visible_*` 工具，并生成正确 StepSemanticFrame。
4. web research capability 解析出 web source 工具，并触发 source caveat policy。
5. artifact build capability 解析出 file-producing tool 和必要 acceptance tool。
6. direct delivery leaf 没有 capability 时不暴露工具，并走 deterministic assessment。
7. action-aware step execution strategy 继续基于 evidence state 缩窄 `resolvedToolNames`。
8. Plan Template mining/matching/direct-use 不依赖旧工具名。
9. persisted Plan step 能保存并恢复 `requiredCapabilities` 和 `executionBinding`。
10. recovery/replan 不接受旧 `recommendedToolNames` 作为新 Plan schema 字段。

## 9. 建议实施顺序

建议按以下顺序提交，避免大爆炸，但不保留旧 `recommendedToolNames`
语义通道，也不从旧字段反向构造当前执行绑定：

1. 引入 capability catalog 与类型，不改变现有行为。
2. Admission 直接从 `requiredCapabilities` 生成 `executionBinding`，缺失 binding 的旧未完成 Plan 进入 recovery/replan，不透明兼容执行。
3. 执行层消费点全部切到 `executionBinding`。
4. Planner schema 从 `recommendedToolNames` 切到 `requiredCapabilities`。
5. Planner context 去掉全量 tool summaries，只保留 capability catalog。
6. Plan Template 迁移到 capability-first。
7. 删除旧字段在当前执行链上的依赖，只保留历史只读投影。

第二步是过渡实现，不是长期兼容模式。它的目标是降低迁移风险：先让执行层具备新消费契约，再切 Planner 输出。

## 10. 完成定义

本方案完成必须同时满足：

- Planner 首轮输入不包含执行工具目录。
- Planner 输出不包含执行工具名。
- Admission 能从 capability 生成 step-local execution binding。
- 执行层所有语义判断不再读取 Planner 产出的工具名。
- ToolRegistry 仍然只在执行阶段暴露完整工具 schema。
- Assessment 与 TerminalCommitter 的完成权威不变。
- focused tests 覆盖 Planner、Admission、Execution、Assessment、Plan Template 和持久化。

最终状态不是“工具信息少一点”，而是 Planner 与执行层之间的语义接口从 tool-name-first 变成 capability-first。

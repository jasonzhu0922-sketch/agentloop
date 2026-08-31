# 首轮轻量 Planner 目标方案

版本：v1.0
日期：2026-08-22
状态：目标设计

## 1. 目标结论

AgentLoop 的目标不是让 Planner 通过多轮修正得到一个可执行计划，而是让首轮 Planner 在受控输入下直接产出合理的最小 Outcome Plan。

最终范式：

```text
TaskProfile
  -> SkillRoleSelection
  -> OutcomePlan
  -> LeafLocalExecution
  -> EvidenceAssessment
  -> TerminalCommit
```

首轮 Planner 的职责降到最小：

- 确认用户目标。
- 选择最小 PlanShape。
- 表达必要事实边界和交付 leaf。
- 绑定 primary/source Skill。
- 声明核心交付证据。

首轮 Planner 不再负责：

- 预测完整执行 workflow。
- 预置 inspect / repair_if_needed / final_verify 链路。
- 展开未加载 Skill 的内部流程。
- 决定 support/qa Skill 是否进入首轮。
- 通过多轮 patch 修到 Admission 通过。

质量不降低。质量从首轮 Plan 的预置步骤中移回三个权威边界：

- Skill contract: leaf 内部怎么做、是否需要领域 QA。
- Assessment: 当前 leaf 的核心证据是否满足。
- TerminalCommitter: 是否可以原子提交 Delivery / Outcome。

## 2. 不做的设计

本方案不设计兼容、回退或双轨分支。目标是替换旧链路，而不是在旧链路旁边再加一个轻量模式。

禁止的实现形态：

- 不保留 `legacyPlannerMode`、`fallbackPlannerMode`、`useOldAdmission` 这类开关。
- 不让首轮 Planner 失败后自动进入多轮 `submit_plan_patch` 修正主路径。
- 不在 system prompt 中加入 `html-ppt`、`DCMM`、某个 Skill 名称、某类业务材料等场景词。
- 不用 if/else 为 PPT、HTML、网页、海报、报告等任务定制流程模板。
- 不让 Admission 自动把业务宽步骤拆成领域步骤。
- 不让 Tool success、artifact existence、UI event 或模型 prose 替代 Assessment / TerminalCommitter。

允许的一次性迁移动作：

- 更新 Plan schema。
- 更新 Skill package metadata。
- 更新既有测试 fixture。
- 对开发环境中的旧运行记录做只读诊断，不为它们保留运行时兼容路径。

## 3. 当前断点

当前断点不是某个案例的 prompt 不够强，而是首轮 Planner 的表达空间过宽、职责过重：

```text
用户目标
  -> Planner 同时判断任务类型、Skill、事实边界、生产工序、QA、修复策略
  -> Admission 用宽步骤规则拒绝
  -> Planner patch 或全量重交
  -> 形成多轮修正
```

正确的目标链路应是：

```text
用户目标
  -> RunService 产出 deterministic TaskProfile
  -> SkillSelector 只暴露角色化候选
  -> Planner 填充最小 OutcomePlan
  -> Admission 只判断结构硬错误
  -> Runtime 执行 leaf-local workflow
```

因此首要优化点不是继续压缩 prompt，而是让 Planner 的输入和输出都更窄。

## 4. 核心对象

### 4.1 TaskProfile

`TaskProfile` 由 Runtime deterministic 生成，是 Planner 的上游输入，不是 Planner 自己推理出的自由文本。

```ts
interface TaskProfile {
  schema: "agentloop.taskProfile/v2";
  intent: "reply" | "execute" | "continue" | "recover" | "clarify";
  planShape:
    | "single_leaf"
    | "fact_then_produce"
    | "multi_deliverable"
    | "pipeline"
    | "recovery_patch";
  evidenceProfile:
    | "deterministic"
    | "evidence_gate"
    | "lookup_lite"
    | "source_grounded"
    | "risk_sensitive";
  riskProfile:
    | "no_tool"
    | "read_only"
    | "workspace_write"
    | "external_network"
    | "external_side_effect"
    | "dangerous_or_irreversible";
  artifactKind?: "html" | "document" | "presentation" | "spreadsheet" | "image" | "code" | "none";
  sourceNeed?: "none" | "lookup_lite" | "source_grounded" | "strict_user_source";
}
```

`html-ppt` 不进入 system prompt。它只应被归一为：

```text
artifactKind = html
planShape = fact_then_produce
evidenceProfile = source_grounded
```

其中 `source_grounded` 用于 DCMM 事实整理；生产 leaf 如果要求 `artifact_acceptance` receipt，Assessment profile 应收敛为 `evidence_gate`，只做原则性证据门校验。

### 4.2 SkillRoleSelection

Skill 选择从 Top-N 相关性排序升级为角色化选择。

```ts
type SkillRole = "primary_builder" | "source_provider" | "support" | "qa";

interface SelectedSkillRole {
  skillId: string;
  role: SkillRole;
  reason: string;
}
```

首轮 Planner 默认只看到：

- `primary_builder`
- `source_provider`

`support` 和 `qa` 不进入首轮 Planner 上下文，除非：

- 用户明确要求该能力。
- 已加载 primary Skill 的 contract 要求。
- Assessment 已产生真实失败边界。

这不是 fallback。它是单一选择规则：首轮只暴露完成用户价值链路所需的 Skill 角色。

### 4.3 OutcomePlan

首轮 Planner 的输出从“完整可执行 workflow”收敛为 OutcomePlan。

```ts
interface OutcomePlan {
  schema: "agentloop.outcomePlan/v2";
  goal: string;
  shape: TaskProfile["planShape"];
  selectedSkillRoles: SelectedSkillRole[];
  leaves: OutcomeLeaf[];
}

interface OutcomeLeaf {
  id: string;
  objective: string;
  dependsOn: string[];
  role: "fact_acquisition" | "produce" | "deliver" | "repair";
  skillIds: string[];
  recommendedToolNames: string[];
  evidenceContract: EvidenceContract;
}
```

Planner 不再自由编写大量 success criteria。它只能填 `evidenceContract` 的核心槽位。

```ts
interface EvidenceContract {
  requiredKinds: Array<
    | "source_summary"
    | "source_urls"
    | "artifact_path"
    | "artifact_non_empty"
    | "artifact_acceptance"
    | "artifact_openable"
    | "format_matches_request"
    | "basic_navigation"
    | "delivery_receipt"
    | "explicit_caveats"
  >;
  caveatPolicy: "none" | "mark_unverified_facts" | "strict_fail_on_missing_source";
}
```

这能从 schema 层面减少“视觉更专业、案例更丰富、完整响应式适配”等可选项混入 Admission 的机会。

## 5. 模块调整

### 5.1 RunService

RunService 成为首轮轻量化的入口。

职责：

- 从用户输入、conversation working set、workspace facts、tool catalog 生成 `TaskProfile`。
- 产出 `SkillRoleSelection`。
- 构造 Planner 可见上下文。
- 记录 `planning.profile.created` 和 `planning.skills.role_selected` 事件。

不再做：

- 把全部相关 Skill 都暴露给 Planner。
- 把历史 transcript 里的能力当授权。
- 把 support/qa Skill 放进首轮候选，让 Planner 自己过滤。

### 5.2 Skill Package Metadata

Skill package 必须声明角色和产物能力。

```yaml
agentloop:
  roles:
    - primary_builder
  artifactKinds:
    - html
  sourceKinds: []
  qaKinds:
    - openability
```

Metadata 字段、类型和可选值由 `packages/agentloop/src/skills/agentloop-metadata.ts` 统一定义。`sourceKinds` 是通用源类型枚举（`api` / `database` / `dataset` / `document` / `repository` / `rubric` / `web`），不能写入领域业务分类；领域语义由 Skill 正文和 references 承载。

没有角色声明的 Skill 不进入 Planner catalog。通过一次性 metadata 更新修正内置 Skill，不设计运行时 fallback 推断。

### 5.3 Dynamic Prompt

System prompt 保持稳定、短小，只描述 Runtime 权威边界。

动态上下文注入：

- `TaskProfile`
- `SkillRoleSelection`
- Tool summary
- workspace facts
- conversation working set

工具说明来自工具定义自身的 prompt snippet / guideline。Skill catalog 只包含目录和角色摘要，Skill 正文仍在 leaf 执行时通过 `load_skill` 进入。

### 5.4 Planner

Planner 从“流程规划器”改为“OutcomePlan 填充器”。

规则：

- 首轮只调用一次模型。
- 只允许提交 `submit_outcome_plan`。
- 不允许提交 patch。
- 不允许调用执行工具。
- 不允许创建 QA / repair leaf，除非 `TaskProfile.planShape = recovery_patch`。
- 对 `single_leaf` 默认生成 1 个 leaf。
- 对 `fact_then_produce` 默认生成 2 个 leaf。
- 对 `pipeline` 只拆 durable evidence boundary，不拆内部工具动作。

Planner 模型输出 schema 无效时，Runtime 记录 `planning.contract_failed`，该问题作为模型/上下文设计缺陷处理，不在同一 Run 中多轮修 prompt。

### 5.5 Admission

Admission 从“流程质量审查”降级为“结构硬准入”。

只拒绝：

- schema 无效。
- leaf id / dependency 非法。
- Tool / Skill 不存在。
- `support` / `qa` Skill 出现在首轮非 recovery Plan。
- leaf 违反安全或授权边界。
- 一个 leaf 明显包含多个独立用户交付物。

不再拒绝：

- leaf 内包含同一产物的写入、运行、回读、receipt。
- artifact 生产 leaf 内包含基本 openability / navigation evidence。
- 没有独立 QA / repair / final_verify 步骤。

Admission 不再触发 Planner repair turn。硬错误就是 runtime contract failure，后续通过改 TaskProfile、Skill metadata、Planner schema 或 prompt 解决根因。

### 5.6 Scheduler

Scheduler 只调度 OutcomePlan leaf。

规则：

- 按 dependency 选择 ready leaf。
- 不调度 milestone。
- 不创建默认 QA leaf。
- 不创建默认 repair leaf。
- 如果 Assessment 拒绝 leaf，Scheduler 进入 recovery action。

### 5.7 Executor / AgentLoop

Executor 承担 leaf-local progressive execution。

执行 `produce` leaf 时可以在 leaf 内完成：

```text
load_skill
read skill contract
write artifact
run local build/check command
readback artifact
emit delivery receipt
```

这些是 leaf 内部动作，不回写成首轮 Planner steps。

工具副作用采用 DeepSeek Harness 方向的生命周期：

```text
tool.effect_pending
tool.dispatched
tool.result_committed
```

并发 Tool 可以执行，但结果提交必须保持可审计顺序。Tool 只能提交事实和 receipt，不能推进 Step 或声明完成。

### 5.8 Assessment

Assessment 判断 evidence contract，而不是判断 Planner 是否预写了完整 workflow。QA 属于 Skill / Tool / acceptance provider；Assessment 只确认 Runtime 终结所需的 receipt 存在、可解析、未失败，并且 caveat 符合策略。

HTML presentation 类产物的核心证据示例：

```text
artifact_path
artifact_non_empty
artifact_acceptance
source_urls
explicit_caveats
delivery_receipt
```

Assessment 不应因为以下原因拒绝普通 artifact leaf：

- 没有独立 polish step。
- 没有独立 final_verify step。
- 没有高级响应式适配。
- 没有案例、练习、复杂视觉系统，除非用户明确要求。

Assessment 拒绝时必须输出 `failedBoundary`：

```ts
interface FailedBoundary {
  stepId: string;
  missingEvidenceKinds: string[];
  violatedSkillRequirements: string[];
  reusableEvidenceRefs: string[];
  suggestedRepairShape: "repair_leaf" | "ask_user" | "fail";
}
```

### 5.9 Recovery

Recovery 只从真实失败边界启动。

规则：

- 不重跑首轮 Planner。
- 不全量重写 OutcomePlan。
- 只允许针对 `failedBoundary.stepId` 生成 repair leaf 或用户澄清。
- repair leaf 完成后仍走 Assessment 和 TerminalCommitter。

Recovery 是失败后的正式状态，不是首轮 Planner 的隐性 fallback。

### 5.10 TerminalCommitter

TerminalCommitter 保持严格，不随首轮 Planner 轻量化而放宽。

完成条件：

- 所有 required leaf 完成。
- 每个 leaf 有 approved Assessment。
- DeliveryCandidate 来源于 approved evidence。
- TerminalCommitter 原子写入 Outcome。
- `runs.status = completed`。
- `run_outcomes.reason_code = plan_assessed_and_completed` 或明确 caveat reason。

## 6. 首轮 Plan 示例

输入：

```text
帮我做一个 DCMM 4 评级的培训材料，html-ppt 格式的
```

TaskProfile：

```json
{
  "schema": "agentloop.taskProfile/v2",
  "intent": "execute",
  "planShape": "fact_then_produce",
  "evidenceProfile": "source_grounded",
  "riskProfile": "external_network",
  "artifactKind": "html",
  "sourceNeed": "source_grounded"
}
```

SkillRoleSelection：

```json
[
  {
    "skillId": "discovered:web-artifacts-builder",
    "role": "primary_builder",
    "reason": "The requested deliverable is a browser-presentable HTML artifact."
  }
]
```

OutcomePlan：

```json
{
  "schema": "agentloop.outcomePlan/v2",
  "goal": "制作并交付一套面向 DCMM 4 级评级培训的中文 HTML-PPT。",
  "shape": "fact_then_produce",
  "selectedSkillRoles": [
    {
      "skillId": "discovered:web-artifacts-builder",
      "role": "primary_builder",
      "reason": "The requested deliverable is a browser-presentable HTML artifact."
    }
  ],
  "leaves": [
    {
      "id": "research_dcmm_level4",
      "objective": "整理 DCMM 4 级评级培训所需的来源事实、适用边界和必要 caveat。",
      "dependsOn": [],
      "role": "fact_acquisition",
      "skillIds": [],
      "recommendedToolNames": ["websearch", "webfetch"],
      "evidenceContract": {
        "requiredKinds": ["source_summary", "source_urls", "explicit_caveats"],
        "caveatPolicy": "mark_unverified_facts"
      }
    },
    {
      "id": "produce_dcmm_html_ppt",
      "objective": "基于已整理事实制作并交付可浏览器演示的中文 DCMM 4 级培训 HTML-PPT。",
      "dependsOn": ["research_dcmm_level4"],
      "role": "produce",
      "skillIds": ["discovered:web-artifacts-builder"],
      "recommendedToolNames": ["load_skill", "materialize_paginated_html", "verify_artifact_acceptance"],
      "evidenceContract": {
        "requiredKinds": [
          "artifact_path",
          "artifact_non_empty",
          "artifact_acceptance",
          "delivery_receipt"
        ],
        "caveatPolicy": "mark_unverified_facts"
      }
    }
  ]
}
```

这是合理首轮 Plan。它不需要再拆 `inspect_ppt`、`repair_ppt_if_needed`、`final_verify_ppt`。

## 7. 实施路径

实施按替换目标推进，不保留旧模式。

### Step 1: Schema replacement

- 新增 `agentloop.taskProfile/v2`。
- 新增 `agentloop.outcomePlan/v2`。
- 替换 Planner tool 为 `submit_outcome_plan`。
- 删除首轮 `submit_plan_patch` 机制。

验收：

- Planner 首轮只有一次 model turn。
- 普通 artifact / factual artifact 测试不出现 `planning.repair_requested`。
- system prompt 不出现业务场景词。

### Step 2: Skill role metadata

- 更新 Skill package schema，要求声明 roles 和 artifactKinds。
- 更新内置 Skill metadata。
- RunService 只将 primary/source Skill 投影给首轮 Planner。

验收：

- HTML artifact 请求只暴露 HTML primary builder。
- 未显式请求主题/样式时，support Skill 不进入首轮 Planner catalog。
- qa Skill 只在 Skill contract 或 failedBoundary 后进入。

### Step 3: Admission simplification

- Admission 只保留结构、权限、安全、依赖、角色合法性检查。
- 移除通过 Planner repair 解决普通 Plan 质量问题的路径。
- artifact receipt/readback 作为同一 leaf 证据，不作为拆步理由。

验收：

- `fact_then_produce` 的两 leaf Plan 直接 admitted。
- artifact 生产 leaf 内含 write/run/readback 不被判为过宽。
- 首轮 Plan 缺少 QA tail 不被拒绝。

### Step 4: Leaf-local execution

- Executor 在 leaf 内加载 Skill contract。
- leaf 内动作以 runtime action / tool event 记录。
- Tool result 只提交事实和 receipt。

验收：

- leaf 内能形成完整 action trace。
- Skill package 保持只读，写入都进入 conversation workspace。
- artifact receipt 可以被 Assessment 直接引用。

### Step 5: Evidence assessment and recovery

- Assessment 改为读取 `EvidenceContract`。
- 拒绝时输出 `FailedBoundary`。
- Recovery 只针对 failedBoundary 创建 repair leaf 或 ask_user。

验收：

- 普通 artifact 不因缺少 polish/QA step 被拒。
- 真实缺失 artifact_path/openability/source caveat 时能被拒绝。
- repair 只修失败 leaf，不全量重跑 Plan。

## 8. 可观测指标

必须把首轮 Planner 轻量化变成可度量目标。

新增或强化事件：

```text
planning.profile.created
planning.skills.role_selected
planning.outcome_plan.submitted
planning.outcome_plan.admitted
planning.contract_failed
assessment.failed_boundary
recovery.repair_leaf_created
terminal.delivery_committed
```

核心指标：

```text
first_plan_admission_rate
planning_model_turn_count
planning_repair_turn_count
initial_plan_leaf_count
support_skill_exposed_in_first_plan_count
qa_leaf_in_initial_plan_count
assessment_reject_by_missing_evidence_kind
recovery_scope_leaf_count
```

目标：

- 普通回答：首轮 1 leaf admitted。
- 普通 artifact：首轮 1 leaf admitted。
- 需事实支撑的 artifact：首轮 2 leaf admitted。
- 首轮 Planner repair turn 数量为 0。
- QA / repair leaf 不出现在初始 Plan，除非 TaskProfile 是 recovery 或用户明确要求。

## 9. 判断标准

方案完成后，合理链路应表现为：

```text
planning.profile.created
planning.skills.role_selected
planning.turn.started
planning.turn.completed
planning.outcome_plan.submitted
planning.outcome_plan.admitted
leaf execution...
assessment approved...
terminal delivery committed
```

不应再把以下现象视为正常：

```text
planning.turn.started x3
planning.repair_requested
plan rejected because missing generic QA tail
support Skill selected only because task asks for artifact
artifact exists but Run has no approved Assessment / Outcome
```

最终标准不是“这次 DCMM HTML-PPT 过了”，而是任意类似任务都按同一通用范式成立：

```text
轻首轮 Planner
+ 角色化 Skill 选择
+ leaf 内渐进执行
+ evidence-based Assessment
+ strict TerminalCommit
```

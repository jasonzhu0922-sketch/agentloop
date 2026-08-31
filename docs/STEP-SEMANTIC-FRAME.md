# Step Semantic Frame 设计标准

版本：v0.1
日期：2026-08-31
状态：Runtime 派生式语义协议，已接入执行上下文

## 1. 设计结论

`StepSemanticFrame` 是每个 Plan step 的统一语义帧，用来让执行模型稳定理解：

- 当前 step 是取证、分析、产物生产、交付还是修复。
- 当前 step 应优先获取新证据，还是复用依赖或会话中的既有证据。
- 第一动作应该是检查目录、读取上传源、联网查询、复用上游摘要、写产物、验收产物，还是修复失败边界。
- Runtime 完成边界是什么，Skill QA 和 Tool 信号分别归谁所有。

它不是新的 Planner 表单，也不是 Admission 硬规则。它由 Runtime 从已有事实派生：

- admitted Plan step
- `TaskProfile`
- `OperationProfile`
- `evidenceContract`
- step dependencies
- visible directories
- uploaded sources
- conversation working set
- bound Skill metadata

真实契约：

> Runtime 向每个执行 step 注入一份稳定、可审计、非业务特化的语义帧；模型先按该语义帧决定证据来源和第一动作，再围绕 `evidenceContract` 形成完成候选。QA 深度仍由 Skill rubric 或具体 Tool 信号承担，不能变成 Runtime 通用完成门槛。

## 2. 非目标

`StepSemanticFrame` 不做这些事：

- 不让 Planner 直接填写复杂的 step semantic schema。
- 不作为 Admission 的重型拒绝规则。
- 不硬编码 xlsx、HTML、PPT、网页报告等具体业务流程。
- 不替代 `evidenceContract`、Assessment 或 TerminalCommitter。
- 不把 Skill QA、视觉 QA、浏览器导航、交互 polish 变成 Runtime 通用 required evidence。
- 不根据模型 prose 推断完成，只使用 Plan、Tool receipt、上下文工作集等结构化事实派生。

## 3. 标准结构

当前协议版本：

```ts
interface StepSemanticFrame {
  schema: "agentloop.stepSemanticFrame/v1";
  stepId: string;

  phaseRole:
    | "evidence_acquisition"
    | "analysis"
    | "artifact_production"
    | "delivery"
    | "repair";

  operation:
    | "data_analysis"
    | "content_generation"
    | "code_change"
    | "web_research"
    | "artifact_build"
    | "direct_answer";

  evidenceMode:
    | "acquire_new_evidence"
    | "reuse_dependency_evidence"
    | "reuse_conversation_evidence"
    | "verify_existing_artifact"
    | "produce_without_external_evidence";

  evidenceSources: readonly StepEvidenceSource[];

  firstAction:
    | "inspect_available_sources"
    | "read_bound_source"
    | "query_web_sources"
    | "reuse_prior_summary"
    | "reuse_prior_artifact"
    | "write_artifact"
    | "verify_artifact"
    | "answer_from_context"
    | "repair_failed_boundary";

  completionBoundary: readonly EvidenceKind[];
  forbiddenMoves: readonly string[];

  qaOwnership: {
    runtimeCore: readonly EvidenceKind[];
    skillRubric: readonly string[];
    toolSignals: readonly string[];
  };
}

interface StepEvidenceSource {
  kind:
    | "visible_directory"
    | "uploaded_source"
    | "web"
    | "dependency_step"
    | "conversation_workset"
    | "workspace_file"
    | "none";

  required: boolean;
  refs?: readonly string[];
  reusePolicy?: "must_reuse_first" | "may_reuse" | "fresh_required";
}
```

## 4. 字段语义

### 4.1 phaseRole

`phaseRole` 表达 step 在用户价值链路中的阶段位置：

| 值 | 含义 |
|---|---|
| `evidence_acquisition` | 获取、读取、索引或整理源材料，产出可复用证据。 |
| `analysis` | 基于已获取证据进行分析、归纳、计算或判断。 |
| `artifact_production` | 生成、修改、导出或验收用户可见文件。 |
| `delivery` | 交付对话答案或最终说明。 |
| `repair` | 修复 Assessment 或 Recovery 指出的失败边界。 |

### 4.2 evidenceMode

`evidenceMode` 表达当前 step 对证据的默认策略：

| 值 | 第一原则 |
|---|---|
| `acquire_new_evidence` | 先读取、搜索、索引或解析授权 source。 |
| `reuse_dependency_evidence` | 先查看 `dependencyEvidenceBindings`，复用上游已满足 evidence。 |
| `reuse_conversation_evidence` | 先查看 `conversationReuseContext` 和 evidence ledger。 |
| `verify_existing_artifact` | 先验收或检查现有 artifact，不重新生产。 |
| `produce_without_external_evidence` | 不需要外部 source，直接围绕当前 step 生产或回答。 |

### 4.3 firstAction

`firstAction` 是给执行模型的首要动作约束。它不是 Tool 名称，不限制模型只能调用某个工具，而是明确认知顺序：

- `inspect_available_sources`：先定位授权目录、工作区或数据文件。
- `read_bound_source`：先读取上传源或已绑定 source。
- `query_web_sources`：先用完整意图查询外部来源。
- `reuse_prior_summary`：先读上游或会话中的 source summary。
- `reuse_prior_artifact`：先读上游 artifact receipt 或路径。
- `write_artifact`：先生成目标产物。
- `verify_artifact`：先验收既有产物。
- `answer_from_context`：直接基于上下文回答。
- `repair_failed_boundary`：只修复当前失败边界。

## 5. QA 所有权

`qaOwnership` 把完成证据和 QA 信号分开：

| 字段 | 所有者 | 用途 |
|---|---|---|
| `runtimeCore` | Runtime / Assessment | `evidenceContract` 中的核心完成证据，例如 `source_summary`、`artifact_path`、`artifact_acceptance`、`delivery_receipt`。 |
| `skillRubric` | Skill | Skill frontmatter 或 Skill body 声明的 QA 深度，例如 browser QA、visual QA、domain validation。 |
| `toolSignals` | Tool | 工具可报告的检查信号，例如 `basic_navigation`。这些可以被 Skill 或模型参考，但不是 Runtime 通用 required evidence。 |

原则：

> Tool 可以报告 QA 信号；Skill 可以要求 QA；Runtime 只把 core evidence 当通用完成门槛。

## 6. 示例：目录 xlsx 分析

用户请求：

```text
分析目录下面的数据，对比分析，最后出结果
```

第一步应是证据获取或数据分析：

```json
{
  "schema": "agentloop.stepSemanticFrame/v1",
  "stepId": "profile_xlsx_data",
  "phaseRole": "evidence_acquisition",
  "operation": "data_analysis",
  "evidenceMode": "acquire_new_evidence",
  "evidenceSources": [
    {
      "kind": "visible_directory",
      "required": true,
      "refs": ["visible_dir_1"],
      "reusePolicy": "fresh_required"
    }
  ],
  "firstAction": "inspect_available_sources",
  "completionBoundary": ["source_summary", "explicit_caveats"],
  "forbiddenMoves": [
    "do not answer from assumptions when authorized source material is available",
    "do not write the downstream final artifact before source evidence is captured",
    "do not bypass visible_* source refs with workspace-root reads for visible directory material",
    "do not make Skill-owned QA or optional tool signals a Runtime completion blocker"
  ],
  "qaOwnership": {
    "runtimeCore": ["source_summary", "explicit_caveats"],
    "skillRubric": [],
    "toolSignals": []
  }
}
```

下游报告生产 step 应先复用上游证据：

```json
{
  "schema": "agentloop.stepSemanticFrame/v1",
  "stepId": "write_analysis_report",
  "phaseRole": "artifact_production",
  "operation": "artifact_build",
  "evidenceMode": "reuse_dependency_evidence",
  "evidenceSources": [
    {
      "kind": "dependency_step",
      "required": true,
      "refs": ["profile_xlsx_data"],
      "reusePolicy": "must_reuse_first"
    }
  ],
  "firstAction": "reuse_prior_summary",
  "completionBoundary": [
    "artifact_path",
    "artifact_non_empty",
    "artifact_acceptance",
    "delivery_receipt"
  ],
  "forbiddenMoves": [
    "do not reacquire source data solely to recreate already satisfied prior evidence",
    "do not make Skill-owned QA or optional tool signals a Runtime completion blocker"
  ],
  "qaOwnership": {
    "runtimeCore": [
      "artifact_path",
      "artifact_non_empty",
      "artifact_acceptance",
      "delivery_receipt"
    ],
    "skillRubric": [],
    "toolSignals": ["basic_navigation"]
  }
}
```

## 7. 接入点

当前落地位置：

- 派生器：`packages/agentloop/src/runtime/step-semantic-frame.ts`
- 执行上下文注入：`packages/agentloop/src/runtime/execution-context-policy.ts`
- 回归测试：`packages/agentloop/tests/execution-context-policy.test.ts`

执行上下文中 `stepSemanticFrame` 与 `currentPlanStep` 并列出现。旧字段保持不变，新字段用于给模型提供更稳定的 step 理解顺序。

## 8. 演进边界

后续可以扩展：

- 增加更细的 `evidenceSources.kind`，例如 database、api、mailbox。
- 让 Planner 在 runtime context 中看到 frame 标准，但仍不直接填写 frame。
- 在 UI 展示每个 step 的 `phaseRole`、`firstAction` 和 `evidenceMode`，帮助诊断链路。
- 将 repeated reacquisition、错误 source surface 等问题归因到 semantic frame 偏差。

不建议扩展：

- 不要把每个 `firstAction` 绑定成固定 Tool。
- 不要把 frame 字段变成大规模 Admission 拒绝条件。
- 不要把业务 Skill 的 QA 标准复制到 Runtime 通用 schema。

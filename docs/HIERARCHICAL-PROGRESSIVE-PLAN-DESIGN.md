# 分层渐进式 Plan 设计方案

版本：v0.3
日期：2026-08-21
状态：设计稿 / 第一阶段落地中

## 1. 设计结论

当前 Planner 不稳定的根因不是某条提示词不够强，也不是 Admission 需要更多场景化规则，而是 Plan-first 的职责层级不够明确：

> Runtime 现在要求 Planner 在第一阶段提交一份完整、可执行、可 Admission 的扁平 Plan；于是模型容易把 context intake、Skill workflow、质量检查、修复兜底都提前塞进 Plan，导致计划过重且不稳定。

因此，第一阶段合理的目标不是“猜出完整执行细节”，而是建立 **Context facts -> Skill selection -> Outcome Plan -> Progressive Actions** 的轻量范式：

- Context Intake 先收集运行事实和显式指令，但不是默认 Plan leaf。
- Planner 先基于 context facts 和 Skill catalog 选择可能需要的 Skill，不提前复制 Skill 内部流程。
- 顶层 Plan 表达用户价值链路、阶段边界、关键依赖和交付门槛。
- 只有 `leaf` Step 可以被 Scheduler 调度执行。
- `milestone` Step 不能执行；第一阶段只作为非执行阶段边界、层级归属和上下文提示。
- 具体 leaf 执行时再 `load_skill`，由 Skill contract 决定领域动作、artifact 工序和必要 QA。
- Planner 不默认生成通用 `inspect -> repair_if_needed -> final_verify` 质量纠正链路。
- `requiredFacts` 和 `refinementState` 第一阶段只作为可持久化的规划元数据，不作为强制事实门禁。
- 自动 refinement、fact index、CAS Plan Revision 是后续增强层；启用前不能影响 leaf-only 执行和完成判定。
- 完成仍只来自 leaf Step 的 Assessment、全局 Goal Assessment 和 Terminal Committer Outcome。

这保留 Plan-first 的核心：运行前必须有可审计计划；同时避免让 Planner 在缺少证据时把“探索、生产、验证”硬塞进同一个可执行步骤。

节制原则：

> 先让 Plan 表达“用户价值链路”和“阶段尚未细化”，不要把每个任务推进到事实门禁、自动修订、独立 QA 和复杂状态机。质量由 Skill contract 与 Assessment 承担，repair 由失败触发。

## 2. 要修复的运行契约

真实契约：

> Runtime 必须始终基于同一份 canonical Plan 调度任务；Planner 的首轮 Plan 只应表达用户价值链路和必要依赖，context intake 不默认进入 Plan，Skill 内部流程和 QA 不默认提前展开。

该设计不允许以下捷径：

- 让 Admission 把模型生成的宽步骤自动拆成业务步骤。
- 用更多 retry/patch prompt 逼模型重写同一份扁平 Plan。
- 把 `milestone` 当成执行 Step，让 Tool 或模型在其中自行推进状态。
- 把 workspace/context intake 包装成用户可见 leaf，除非用户目标确实要求探索现有项目。
- 默认追加 `inspect_*`、`repair_*_if_needed`、`final_verify_*` 这类通用质量模板。
- Runtime 或 Planner 代替 Skill 决定领域 QA 流程。
- 用 artifact、Tool success、UI 事件或模型文本跳过 Assessment / Terminal Committer。
- 为某类任务、某个 Skill 或某个网页/报告场景硬编码流程模板。

## 3. 问题复盘：run `7f96ac93`

输入是：

```text
8 月底，哔哩哔哩 up 主小精灵，法老将在上海举办演唱会，请帮忙设计一个网页用来宣传这个事情。相关人物信息，你可以联网查找
```

持久化事实显示：

- Run 失败于 `PLANNING_ERROR`，没有写入 `plans` 记录。
- Planner 三轮均提交结构化规划动作，但没有形成 admitted Plan。
- 第一轮把“活动与人物公开资料确认”和“工作区项目识别”合并到同一步。
- 第一轮和第三轮都把构建、源码检查、事实追溯核验和缺陷记录合并到一个验证步骤。
- 第二轮只 patch 了实现步骤，没有解决前后两个阶段边界。

这说明第一处语义缺失在 **Plan 表达能力与职责分层**：系统只有“可执行步骤”一种形态，于是 Planner 必须在首轮同时完成架构分解、context intake 和执行级拆分。Admission 只能拒绝宽步骤，却不能表达“这个阶段可以先作为 milestone 被 admitted，等证据回来后再 refine”。

### 3.1 补充复盘：run `8e3965f5`

该 Run 的首个 admitted step 是“勘察工作区中的现有前端项目、入口文件、技术栈与可用资源”。实际持久化结果只是确认 conversation workspace 为空，并建议新建 standalone HTML。

这个信息有用，但它不该作为用户价值链路中的 leaf：

- conversation workspace 是否为空是 Runtime / Context Assembler 可以直接提供的 context fact。
- 用户任务的主要不确定性是外部活动和人物事实，而不是项目结构。
- 把空 workspace 勘察放入 Plan 会消耗 model/tool/assessment，并把关键事实核验后置。

结论：**Context Intake 不是默认 Plan leaf**。只有当用户要求修改现有项目、提供 visible directories、或入口/技术栈确实未知且影响交付时，Planner 才应生成 workspace inspection leaf。

### 3.2 补充复盘：run `a6dc56e6`

该 Run 的首步 `research_event` 是合理的：它直接对应用户“搜索相关内容”的目标，并形成结构化研究记录。但后续 Plan 预置了：

```text
create_poster -> inspect_poster -> repair_poster_if_needed -> final_verify_poster
```

这暴露出另一类过重问题：

- `inspect_poster`、`repair_poster_if_needed`、`final_verify_poster` 是通用质量模板，不是用户显式目标。
- 如果 `canvas-design` Skill 要求独立 QA，可以在该 Skill 的执行策略或 Skill compliance assessment 中体现。
- 如果 Assessment 发现 artifact 技术无效、文案错误或 Skill compliance 不达标，再触发 repair，而不是预先把 repair 作为必经 leaf。
- `create_poster` 本身没有明确 artifact production strategy，执行中先写了“视觉哲学” Markdown，而非 PNG/PDF 海报。这说明 Plan 应该收紧交付产物边界，而不是追加更多后置 QA。

结论：**Plan 应轻，质量不应消失，但应回到 Skill contract、leaf success criteria 和 Assessment 失败后的 repair 机制。**

## 4. 核心概念

### 4.1 PlanNode

Plan 从扁平 `PlanStep[]` 演进为有层级的 `PlanNode[]`。每个节点仍属于同一份 canonical Plan。

```ts
type PlanNodeKind = "milestone" | "leaf";

interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  parentId?: string;
  position: number;
  objective: string;
  dependencies: string[];
  status: PlanNodeStatus;
  refinementState?: RefinementState;
  requiredFacts: RequiredFact[];
  successCriteria: SuccessCriterion[];
  skillIds: string[];
  requiredToolNames: string[];
}
```

语义：

- `milestone` 是阶段边界，只表达目标、依赖、未知事实和细化条件；它不能绑定执行 Tool，不能产生 ToolCall，也不能直接完成用户目标。
- `leaf` 是可执行工作单元，必须足够小，拥有明确 Tool surface、成功标准和 Assessment 方法。
- `parentId` 只表达计划层级，不表达子 Agent 或委派。
- 同一 Plan Revision 内，任一节点的依赖只能指向同 Plan 中已经存在的节点。

### 4.2 RefinementState

```ts
type RefinementState =
  | "not_refinable"
  | "pending_facts"
  | "ready_to_refine"
  | "refining"
  | "refined";
```

规则：

- `leaf` 固定为 `not_refinable`。
- `milestone` 初始通常是 `pending_facts` 或 `ready_to_refine`。
- 第一阶段不由 Scheduler 自动创建 `planning_refinement` Action。
- 后续启用 fact-gated refinement 时，当 `requiredFacts` 全部由 canonical evidence 满足后，Scheduler 才可创建 `planning_refinement` Action。
- Planner refine 后，原 milestone 变为 `refined`，新增 children 成为 canonical Plan 的一部分。
- `refined` milestone 自身不再被执行；完成由其 children 的完成状态归约。

### 4.3 RequiredFact

`RequiredFact` 不是业务事实硬编码，而是细化所需的证据槽：

```ts
interface RequiredFact {
  id: string;
  description: string;
  evidenceKinds: string[];
  satisfiedBy?: string[];
}
```

示例：

- `public_event_facts`: 需要来源 URL、日期/场地/票务确定性、冲突标记。
- `workspace_frontend_shape`: 需要项目入口、框架、可写目标文件、运行脚本。
- `skill_workflow_loaded`: 需要指定 Skill 的 `load_skill` ToolResult 和 package hash。

这些是中性 evidence contract，不是“网页宣传任务”的硬编码流程。

## 5. 首轮 Plan 应该长什么样

首轮 Planner 不应该生成完整执行细节，也不应该把 Context Intake 和 Skill QA 链路提前展开。它应该先遵循四段式输入和输出范式：

```text
Context facts:
  - 用户原始目标与显式约束
  - conversation workspace / visible directories / prior artifacts
  - 可用 Tool surface
  - Skill catalog summary
  - 历史上下文中已经持久化的 facts

Skill selection:
  - 只基于 catalog 选择可能需要的 Skill
  - 不加载 Skill 正文来生成首轮仪式化步骤
  - 不复制 Skill 内部 QA 或模板到 Plan schema

Outcome Plan:
  - 只表达用户价值链路和必要依赖
  - leaf 是可交付推进单元，不是每个内部动作
  - milestone 只表示阶段边界或待细化区域

Progressive Actions:
  - 执行 leaf 时再 load_skill
  - Skill 解析后决定该 leaf 内部动作策略
  - Skill 要求 QA 时才执行 QA；Assessment 失败时才触发 repair
```

对 `8e3965f5` 这类网页任务，如果 workspace fact 已显示是空 conversation workspace，首轮 Plan 应类似：

```text
goal: 设计并交付一个宣传网页，且活动事实可追溯

leaf: collect_public_event_facts
  - websearch/webfetch
  - 产出结构化事实记录

leaf: create_promotional_page
  - dependsOn: collect_public_event_facts
  - bind Skill only if catalog indicates frontend/page design workflow is needed
  - 产出可打开的 HTML/CSS/asset 文件
  - 成功标准包含事实文案与研究记录一致、交付路径和使用方式可由 TerminalCommitter 汇总
```

对 `a6dc56e6` 这类海报任务，首轮 Plan 应类似：

```text
goal: 搜索 2025 MC法老「生于未来」巡回演唱会相关内容，并生成一张原创海报

leaf: collect_event_facts
  - websearch/webfetch
  - 写结构化研究记录
  - 区分可用事实、视觉灵感和禁用信息

leaf: create_and_export_poster
  - dependsOn: collect_event_facts
  - bind canvas-design
  - load_skill 后按 Skill 生成可渲染源文件和 PNG/PDF
  - 如果 Skill 明确要求 QA，则在该 leaf 内执行或生成 Skill-driven QA action
  - 成功标准包含最终文件路径、格式、尺寸和来源约束，供 TerminalCommitter 交付
```

首轮 Plan 的正确性来自用户价值链路、事实依赖和交付边界，而不是预先猜出所有内部动作，也不是默认追加通用质量纠正链路。

允许生成独立 QA / repair leaf 的条件：

- 用户明确要求独立验收、逐项检查、E2E、浏览器验收或正式发布前质检。
- 已加载 Skill 的 contract 明确要求独立 QA 或多阶段渲染检查。
- 任务风险很高，且没有独立 QA 会导致不可接受的外部副作用、法律/财务/安全风险。
- Assessment 已拒绝当前 leaf，需要进入 repair/recovery。

不满足这些条件时，质量要求应进入 leaf success criteria、Skill compliance assessment 或最终 DeliveryCandidate 校验，而不是成为默认 Plan steps。

## 6. 调度模型

第一阶段 Scheduler 的核心规则：

```text
ready leaf        -> 创建 model_turn / tool_call / assessment Action
ready milestone   -> 不创建执行 Action，不参与 Assessment
parent milestone  -> 其 dependencies 会约束 child leaf 的 ready 判断
completed goal    -> 进入 Goal Assessment 与 Terminal Committer
```

伪流程：

```text
while run is active:
  plan = load current canonical Plan revision
  frontier = find dependency-ready nodes

  if exists ready leaf:
    dispatch executable step under Capability Grant
    assess leaf result
    persist evidence facts
    continue

  if all leaves under goal are assessed:
    run Goal Assessment
    Terminal Committer commits Delivery / Outcome
```

Scheduler 不解释业务含义；第一阶段只看节点类型、依赖、父级依赖和 leaf 状态。`requiredFacts` 可以被持久化和展示，但不驱动调度。

后续启用 D3 后，再增加：

```text
ready milestone   -> 创建 planning_refinement Action
pending milestone -> 等待依赖 leaf 产生 requiredFacts
refined milestone -> 根据 children 状态归约
```

## 7. Planner 协议

### 7.1 初始规划输入

Planner 的首轮输入应明确区分事实层，不把它们合并成一个泛化 user prompt：

```text
section: user_objective
section: context_facts
section: workspace_facts
section: prior_artifacts
section: available_skills_catalog
section: available_tools
section: planning_contract
```

`workspace_facts` 是 Runtime 直接可得的事实，例如 conversation workspace 是否为空、visible directories、已有文件摘要。除非用户目标要求探索现有项目，否则这些事实不得被 Planner 再规划成 workspace inspection leaf。

### 7.2 初始规划输出

第一阶段继续使用现有 `submit_plan`，只扩展 Step 的可选字段：

```ts
{
  goal: string,
  selectedSkillIds: string[],
  steps: PlanNodeProposal[]
}
```

约束：

- 顶层必须覆盖用户显式目标。
- 至少要有一个可执行 leaf。
- 允许 milestone 暂时没有 requiredFacts；这表示轻量阶段边界，而不是事实门禁。
- milestone 不能要求执行 Tool。
- Planner 可以基于 Skill catalog 选择 Skill，但不得把未加载 Skill 的内部流程展开成 Plan steps。
- 选择的 Skill 可以绑定到 milestone 或 leaf；真正执行前必须在 leaf 中通过 `load_skill` 激活精确版本。
- Plan 不默认生成 `inspect_*`、`repair_*_if_needed`、`final_verify_*` steps。
- QA / repair step 只有在用户明确要求、已加载 Skill 明确要求、风险等级要求或 Assessment 失败后才允许出现。
- Artifact-producing leaf 必须说明交付边界，例如可渲染源文件、导出格式、目标路径或可验证文件类型；不能只写“生成成品”。

### 7.3 运行中细化

Refinement Planner 只看一个目标 milestone、其 ancestors、已满足 facts、相关 siblings 和可用能力：

```ts
{
  mode: "refine",
  targetNodeId: string,
  expectedPlanVersion: number,
  replaceNodeId: string,
  children: PlanNodeProposal[],
  dependencyRewrites: DependencyRewrite[]
}
```

Admission 规则：

- `replaceNodeId` 必须是 `ready_to_refine` 的 milestone。
- children 必须共同覆盖 parent objective 和 successCriteria。
- children 的依赖只能引用 parent dependencies、同批 children 或明确允许的 previous evidence nodes。
- 若 child 是 leaf，必须通过 leaf 粒度规则。
- 若 child 仍是 milestone，必须说明新的 requiredFacts，且不能无限细化同一语义边界。

### 7.4 修订而非补丁提示

现有 `submit_plan_patch` 更像错误修补工具。新协议应统一为 Plan Revision：

- `initial`: 创建 Plan v1。
- `refine`: 将 milestone 展开为 children。
- `repair`: 针对失败 leaf 或 failed boundary 修订局部子树。
- `resume`: 从 conversation workset 继承未完成 Plan。

这些模式共享同一 Writer、CAS、Admission 和审计事件。

## 8. Admission 职责

Admission 从“拒绝整个扁平 Plan”变成“按节点类型校验”：

| 节点类型 | Admission 重点 |
|---|---|
| `milestone` | 目标覆盖、依赖合法、requiredFacts 可由现有或后续 leaf 产生、没有执行 Tool、没有宣称完成 |
| `leaf` | Tool 可用、Skill 已选择且可加载、步骤足够小、成功标准可评估、不会混合不相干的 discovery/production；不默认承担独立 QA/repair 模板 |
| `revision` | CAS 版本正确、替换范围合法、显式目标未丢失、未绕过失败边界、不退休未评估的必要工作 |

Admission 不负责：

- 自动拆业务步骤。
- 根据 task 文本选择固定流程模板。
- 将某个 Skill 的工作流复制进 runtime schema。
- 要求每个 artifact 任务都有独立 inspect/repair/final verify。
- 根据 artifact 存在判断完成。

## 9. Canonical 存储

### 9.1 Plan 表

第一阶段保留现有 `plans` 头和 `plan_steps` 表，只做兼容扩展。后续启用自动 refinement 时，再把 version 语义从单次创建扩展为 revision chain：

```text
plans(id, run_id, current_version, goal, selected_skill_ids_json, status, ...)
plan_revisions(plan_id, version, mode, target_node_id, proposal_json, reason, action_id, created_at)
```

### 9.2 Plan Nodes

第一阶段先兼容扩展 `plan_steps`：

```text
plan_steps(
  kind default leaf,
  parent_step_id,
  refinement_state default not_refinable,
  required_facts_json default []
)
```

后续需要完整 revision history 时，`plan_steps` 可演进为 `plan_nodes`：

```text
plan_nodes(
  plan_id,
  node_id,
  version_from,
  version_to,
  parent_node_id,
  kind,
  position,
  objective,
  dependencies_json,
  required_facts_json,
  refinement_state,
  skill_ids_json,
  required_tool_names_json,
  success_criteria_json,
  status,
  output,
  evidence_json,
  error,
  started_at,
  finished_at
)
```

规则：

- 节点不可原地覆盖；revision 通过 `version_from/version_to` 形成可审计历史。
- UI 可以投影当前版本树，也可以查看旧版本。
- Step Assessment 只绑定 leaf。
- Milestone 完成是归约结果，不单独写 Skill Compliance Assessment。

### 9.3 Evidence Facts

后续 D3 需要一个中性 fact index，供 `requiredFacts` 绑定：

```text
run_facts(
  id,
  run_id,
  plan_id,
  node_id,
  kind,
  payload_json,
  evidence_refs_json,
  created_by_action_id,
  created_at
)
```

ToolResult、Assessment、source intake、artifact receipts 都可以投影为 facts。Fact 只表达“已观察到什么”，不表达“任务完成”。

## 10. Context Assembler

规划上下文要分层输入，而不是把所有内容混在一个 user JSON 中。第一阶段只需要把用户目标、context facts、workspace facts、Skill catalog、可用能力和 Planner 协议约束表达清楚；D3 再加入 satisfied/pending facts：

```text
system: Planner authority and protocol
section: user_objective
section: context_facts
section: workspace_facts
section: prior_artifacts
section: current_plan_tree
section: frontier_nodes
section: satisfied_facts              # D3
section: pending_required_facts       # D3
section: available_skills_catalog
section: available_tool_catalog
section: revision_contract
section: prior_failed_boundaries
```

Context Assembler 应尽量把廉价、确定、非业务的运行事实直接提供给 Planner。例如：

- conversation workspace 是空目录，还是已有项目目录。
- visible directories 是否存在。
- prior artifacts 是否可以复用。
- 当前 Run 是否允许写文件、执行命令或联网。

这些事实只作为规划输入，不自动成为 Plan leaf。Planner 只有在这些事实不足以决定交付路径时，才生成探索 leaf。

Refinement 请求只给 Planner 足够细化目标 milestone 的内容，不把全量 transcript 和所有 Tool 输出重复塞回去。这个能力属于 D3+；第一阶段不引入新的强制 refinement 调用。

## 11. Skill 边界

Skill 的职责不变：

- Skill owns domain workflow, templates, quality rules and artifact-specific process.
- Runtime owns Plan graph, grants, evidence, scheduling, assessment and terminal outcome.

分层 Plan 下的 Skill 使用方式：

- 首轮 Planner 只根据 catalog 摘要选择 Skill，并把它绑定到相关 milestone 或 leaf。
- 首轮 Planner 不读取 Skill 正文，也不把 Skill 内部 workflow / QA checklist 复制成 Plan steps。
- 当 milestone refine 到具体 leaf 时，leaf 必须显式绑定所需 Skill。
- 执行 leaf 前仍走 `load_skill`，加载精确 Package hash。
- Skill 正文可以影响 leaf 的具体 workflow、artifact 生成方式和 QA 要求，但不能直接决定 Plan admitted、Step completed 或 Run outcome。
- 如果 Skill 明确要求 QA，Runtime 可以在该 leaf 内执行 QA 动作，或生成 Skill-driven QA action；这不是 Planner 默认质量模板。

这避免两种错误：

- 首轮 Planner 没加载 Skill 就假装知道完整 workflow。
- Runtime 为某个 Skill 硬编码拆分模板。
- Planner 把每个 artifact 任务都拖成 inspect/repair/final verify。

## 12. Completion 边界

完成条件保持严格：

```text
all required leaf nodes completed
  -> latest Assessment for every leaf approved
  -> selected Skill compliance satisfied or explicit caveat assessed
  -> Goal-level coverage assessment approved
  -> DeliveryCandidate admitted
  -> TerminalCommitter writes run_outcome
```

Milestone 不能直接完成 Run。它只证明“这一阶段已经被细化并且其 children 完成”。

严格完成不等于重 Plan：

- Assessment 可以拒绝不满足成功标准或 Skill compliance 的 leaf。
- 被拒绝后再进入 bounded repair / recovery。
- 不为了防止可能失败而在首轮 Plan 中预置 repair leaf。

## 13. UI 投影

UI 不需要暴露复杂内部机制，但应显示层级：

```text
✓ 收集公开活动事实
▾ 生成宣传网页
  ✓ 创建页面文件
  ✓ 按 Skill 要求完成必要检查
✓ TerminalCommitter 交付结果
```

关键是让用户看到：

- 哪些阶段只是计划边界。
- 哪些 leaf 正在执行。
- 哪些 QA 来自 Skill 要求或失败后的 repair，而不是默认模板。
- 失败发生在 acquisition、preservation、interpretation、admission、execution、skill_compliance 还是 assessment。

## 14. 迁移路径

### D1：引入 leaf/milestone 概念和兼容持久化

- 新增 `kind = leaf` 默认值，现有 Plan 全部视为 leaf。
- `plan_steps` 兼容新增 `parent_step_id`、`refinement_state`、`required_facts_json`。
- `submit_plan` schema 接受可选层级字段。
- 保证现有测试和行为不变。

### D2-lite：允许 initial Plan 包含轻量 milestone

- Admission 接受 milestone，但 Scheduler 不执行 milestone。
- milestone 不能要求执行 Tool，但不强制 requiredFacts。
- Scheduler 只调度 leaf，并让 child leaf 继承 parent milestone 的前置依赖。
- TerminalCommitter 只要求 active leaf 完成和通过 Assessment。
- UI/current-step/failure summary 排除 milestone，避免把阶段边界误显示为执行中。

### D2.5：Outcome Plan 瘦身与 Skill-driven QA

- Context Assembler 提供 workspace facts，Planner 不再默认生成 workspace inspection leaf。
- Planner 先基于 context facts 和 Skill catalog 选择 Skill，再生成用户价值链路 Plan。
- Planner prompt 明确禁止默认 `inspect_*`、`repair_*_if_needed`、`final_verify_*` 尾巴。
- Artifact-producing leaf 必须说明产物边界；例如源文件、导出格式、目标路径或可验证文件类型。
- Skill QA 只来自已加载 Skill contract；Assessment 失败后才进入 repair/recovery。

### D2-full：受控 refinement Action

- 若 frontier 出现 `ready_to_refine` milestone，创建 `planning_refinement` Action。
- Planner 增加 `mode: refine` 协议。
- Plan Revision 经 Admission、CAS 和事件持久化。

### D3：Fact-gated progressive refinement

- 引入 `run_facts` 和 `requiredFacts` satisfaction。
- ToolResult / Assessment / artifact receipt 投影为 neutral facts。
- Refinement Context 只包含目标 milestone 所需 facts。
- 对 `7f96ac93` 形态增加真实 E2E：首轮骨架 admitted，事实收集后逐步细化实现和验证阶段。

### D4：Repair / Resume 统一进 Plan Revision

- 弱化或移除单独 `submit_plan_patch`。
- 失败 leaf 的修复、conversation resume、recovery revision 都使用同一 Plan Revision 协议。
- Plan Revision Assessor 检查目标覆盖和安全退休。

## 15. 回归测试矩阵

第一阶段必须覆盖：

1. 首轮 Plan 可以包含 `milestone`，但 `milestone` 不会被 Scheduler 当作可执行 step。
2. Leaf 仍会被 Admission 拒绝过宽的 discovery/production/verification 混合。
3. Milestone 要保持非执行，且 Plan 至少包含一个 leaf。
4. Child leaf 不会绕过 parent milestone 的前置依赖。
5. 空 conversation workspace 作为 context fact 进入 Planner，不生成默认 workspace inspection leaf。
6. 普通 artifact 任务的首轮 Plan 不默认包含 inspect/repair/final verify 三段尾巴。
7. Skill 要求 QA 时，QA 来自 Skill-bound leaf 的执行/assessment，而不是 Planner 泛化模板。
8. Artifact 存在但 leaf Assessment 未批准时，Run 不完成。
9. 全部 leaf 完成但 Goal Assessment 未批准时，TerminalCommitter 不写 completed outcome。

D3+ 再覆盖：

1. RequiredFacts 满足后，Scheduler 创建 `planning_refinement` Action。
2. Refinement 只能替换目标 milestone 子树，不能改写无关 Plan 节点。
3. Refinement 后 dependencies 被正确重写，后续 Scheduler 只调度 children leaf。
4. Skill 绑定在 milestone 时不会暴露 Skill 正文；只有 leaf 执行前 `load_skill`。
5. Conversation resume 能从 current Plan tree 和 facts 继续，而不是重启首轮骨架。

## 16. 实施风险

| 风险 | 处理 |
|---|---|
| Plan tree 过复杂，模型过度层级化 | 第一阶段只支持轻量 milestone；后续才限制最大深度和每次 refine 子节点数量 |
| Milestone 被滥用为模糊占位 | milestone 不可执行、不计完成，且不能没有可执行 leaf frontier |
| Plan 被 QA/repair 尾巴拖重 | 默认禁止通用 inspect/repair/final verify；QA 只来自用户指令、Skill contract、风险等级或 Assessment 失败 |
| Plan 过轻导致质量下降 | leaf success criteria、Skill compliance assessment 和 TerminalCommitter 保持严格；失败后触发 bounded repair |
| 细化导致重复读取/执行 | Facts 成为 Planner 输入；已满足 facts 不允许要求重复产生，除非显式过期或冲突 |
| Revision 漂移丢失用户目标 | Plan Revision Assessor 对照 original goal、显式 constraints 和 unfinished nodes |
| UI 难懂 | UI 展示“阶段/执行项”两级，不暴露 schema 细节 |
| 兼容现有代码成本高 | D1 先把现有 step 全部视为 leaf，再逐步启用 milestone |

## 17. 非目标

- 不实现多 Agent 或子任务委派。
- 不让 Planner 直接调用执行 Tool。
- 不引入业务模板库。
- 不让 Admission 依据中文关键词自动生成子步骤。
- 不改变 TerminalCommitter 权威边界。
- 不把 Skill workflow 复制到 Runtime schema。
- 不把质量检查做成所有任务默认必经流程。

## 18. 最小验收标准

该方案的第一个可验收版本不是“某个网页任务跑通”，而是以下通用链路成立：

```text
initial Plan with leaf/milestone admitted
  -> Scheduler executes only leaf
  -> Context facts are not re-planned as default leaf work
  -> Skill-bound leaf loads Skill at execution time
  -> QA is Skill-driven or failure-driven, not template-driven
  -> child leaf respects parent milestone dependencies
  -> Assessment approves executable leaf
  -> TerminalCommitter commits only after active leaf completion and assessment
```

D3+ 的完整渐进式验收再扩展为：

```text
initial hierarchical Plan admitted
  -> leaf facts collected
  -> milestone becomes ready_to_refine
  -> Planner submits Plan Revision
  -> Admission accepts refined leaf children
  -> Scheduler executes only leaf
  -> Assessment approves leaf
  -> Goal Assessment approves coverage
  -> TerminalCommitter commits Outcome
```

若这个链路成立，`7f96ac93` 这类任务就不需要首轮猜完整细节，也不需要靠 retry prompt 修补宽步骤；Planner 可以随着持久事实推进而逐步细化，同时保持 Plan-first、Assessment 和 TerminalCommitter 的 canonical 边界。

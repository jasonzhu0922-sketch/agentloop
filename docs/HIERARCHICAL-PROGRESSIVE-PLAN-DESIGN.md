# 分层渐进式 Plan 设计方案

版本：v0.1  
日期：2026-08-21  
状态：设计稿

## 1. 设计结论

当前 Planner 不稳定的根因不是某条提示词不够强，也不是 Admission 需要更多场景化规则，而是 Plan-first 的结构层级不够明确：

> Runtime 现在要求 Planner 在第一阶段提交一份完整、可执行、可 Admission 的扁平 Plan；但许多真实任务必须先完成信息核验、工作区探查、Skill 读取和约束提取，后续步骤才能被正确拆小。

因此，第一阶段合理的目标不是“猜出完整执行细节”，而是提交一份稳定的 **分层骨架 Plan**：

- 顶层 Plan 表达用户目标、阶段边界、依赖关系、未知事实和完成门槛。
- 只有 `leaf` Step 可以被 Scheduler 调度执行。
- `milestone` Step 不能执行，只能在前置证据满足后由 Planner 细化为更小的子 Step。
- 每次细化都是 canonical Plan Revision，必须经 Admission、CAS 和事件持久化，不是模型临时补丁。
- 完成仍只来自 leaf Step 的 Assessment、全局 Goal Assessment 和 Terminal Committer Outcome。

这保留 Plan-first 的核心：运行前必须有可审计计划；同时避免让 Planner 在缺少证据时把“探索、生产、验证”硬塞进同一个可执行步骤。

## 2. 要修复的运行契约

真实契约：

> Runtime 必须始终基于同一份 canonical Plan 调度任务；当下一段工作依赖尚未获取的事实时，Plan 应持久化这个未知边界，并在事实到位后通过受控 refine 生成可执行 leaf，而不是要求首轮 Planner 预先猜完所有细节。

该设计不允许以下捷径：

- 让 Admission 把模型生成的宽步骤自动拆成业务步骤。
- 用更多 retry/patch prompt 逼模型重写同一份扁平 Plan。
- 把 `milestone` 当成执行 Step，让 Tool 或模型在其中自行推进状态。
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

这说明第一处语义缺失在 **Plan 表达能力**：系统只有“可执行步骤”一种形态，于是 Planner 必须在首轮同时完成架构分解和执行级拆分。Admission 只能拒绝宽步骤，却不能表达“这个阶段可以先作为 milestone 被 admitted，等证据回来后再 refine”。

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
- 当 `requiredFacts` 全部由 canonical evidence 满足后，Scheduler 可创建 `planning_refinement` Action。
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

对 `7f96ac93` 这类任务，首轮 Planner 不应该生成完整执行细节，而应该提交稳定骨架：

```text
goal: 设计并交付一个宣传网页，且活动事实可追溯

leaf: collect_public_event_facts
  - websearch/webfetch
  - 产出结构化事实记录

leaf: inspect_workspace_frontend
  - list/find/read
  - 产出项目入口、技术栈、可写文件范围

milestone: design_and_implement_webpage
  dependsOn: collect_public_event_facts, inspect_workspace_frontend
  requiredFacts: public_event_facts, workspace_frontend_shape, frontend_skill_workflow
  refineInto: content_spec, page_structure, visual_style, asset_integration

milestone: verify_and_deliver_webpage
  dependsOn: design_and_implement_webpage
  requiredFacts: produced_files, build_command, verification_surface
  refineInto: build_check, source_check, factual_traceability_check, browser_acceptance_if_available
```

首轮 Plan 的正确性来自阶段边界和事实依赖，而不是预先猜出所有 leaf。

## 6. 调度模型

Scheduler 的核心规则：

```text
ready leaf        -> 创建 model_turn / tool_call / assessment Action
ready milestone   -> 创建 planning_refinement Action
pending milestone -> 等待依赖 leaf 产生 requiredFacts
refined milestone -> 根据 children 状态归约
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

  if exists ready milestone:
    assemble refinement context from milestone + satisfied facts
    Planner submits PlanRevision
    Admission validates revision
    Writer commits revision with CAS
    continue

  if unresolved facts require user input:
    ask_user through canonical gap

  if all leaves under goal are assessed:
    run Goal Assessment
    Terminal Committer commits Delivery / Outcome
```

Scheduler 不解释业务含义；它只看节点类型、依赖、requiredFacts 和状态。

## 7. Planner 协议

### 7.1 初始规划

首轮工具从 `submit_plan` 演进为 `submit_plan_revision` 的初始模式：

```ts
{
  mode: "initial",
  goal: string,
  selectedSkillIds: string[],
  nodes: PlanNodeProposal[]
}
```

约束：

- 顶层必须覆盖用户显式目标。
- 至少要有一个可执行 leaf，除非任务确实只能先 ask_user。
- 不允许首轮 milestone 没有 requiredFacts 且没有细化条件。
- 选择的 Skill 可以绑定到 milestone，但执行前必须在 leaf 中通过 `load_skill` 激活精确版本。

### 7.2 运行中细化

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

### 7.3 修订而非补丁提示

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
| `leaf` | Tool 可用、Skill 已选择且可加载、步骤足够小、成功标准可评估、不会混合 discovery/production/verification |
| `revision` | CAS 版本正确、替换范围合法、显式目标未丢失、未绕过失败边界、不退休未评估的必要工作 |

Admission 不负责：

- 自动拆业务步骤。
- 根据 task 文本选择固定流程模板。
- 将某个 Skill 的工作流复制进 runtime schema。
- 根据 artifact 存在判断完成。

## 9. Canonical 存储

### 9.1 Plan 表

现有 `plans` 可保留 Plan 头，但需要把 version 语义从单次创建扩展为 revision chain：

```text
plans(id, run_id, current_version, goal, selected_skill_ids_json, status, ...)
plan_revisions(plan_id, version, mode, target_node_id, proposal_json, reason, action_id, created_at)
```

### 9.2 Plan Nodes

`plan_steps` 可演进为 `plan_nodes`，或先兼容扩展：

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

需要一个中性 fact index，供 `requiredFacts` 绑定：

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

规划上下文要分层输入，而不是把所有内容混在一个 user JSON 中：

```text
system: Planner authority and protocol
section: current_user_request
section: current_plan_tree
section: frontier_nodes
section: satisfied_facts
section: pending_required_facts
section: available_skills_catalog
section: available_tool_catalog
section: revision_contract
section: prior_failed_boundaries
```

Refinement 请求只给 Planner 足够细化目标 milestone 的内容，不把全量 transcript 和所有 Tool 输出重复塞回去。这样能同时减少重复读取、重复执行和上下文漂移。

## 11. Skill 边界

Skill 的职责不变：

- Skill owns domain workflow, templates, quality rules and artifact-specific process.
- Runtime owns Plan graph, grants, evidence, scheduling, assessment and terminal outcome.

分层 Plan 下的 Skill 使用方式：

- 首轮 Planner 可根据 catalog 选择 Skill 并把它绑定到相关 milestone。
- 当 milestone refine 到具体 leaf 时，leaf 必须显式绑定 Skill。
- 执行 leaf 前仍走 `load_skill`，加载精确 Package hash。
- Skill 正文可以影响 leaf 的具体 workflow，但不能直接决定 Plan admitted、Step completed 或 Run outcome。

这避免两种错误：

- 首轮 Planner 没加载 Skill 就假装知道完整 workflow。
- Runtime 为某个 Skill 硬编码拆分模板。

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

## 13. UI 投影

UI 不需要暴露复杂内部机制，但应显示层级：

```text
✓ 收集公开活动事实
✓ 识别工作区前端结构
▾ 设计并实现宣传网页
  ✓ 形成内容与视觉规格
  ✓ 编写页面结构
  ✓ 编写响应式视觉样式
▾ 验证并交付网页
  ✓ 构建检查
  ✓ 源码结构检查
  ✓ 事实追溯检查
  ○ 浏览器验收
```

关键是让用户看到：

- 哪些阶段只是计划边界。
- 哪些 leaf 正在执行。
- 哪些 evidence 解锁了下一轮细化。
- 失败发生在 acquisition、preservation、interpretation、admission、execution 还是 assessment。

## 14. 迁移路径

### D1：只引入概念和持久化，不改执行语义

- 新增 `kind = leaf` 默认值，现有 Plan 全部视为 leaf。
- 新增 Plan Revision 表，先记录当前 initial proposal。
- Context / UI 可读取树结构但仍显示扁平列表。
- 保证现有测试和行为不变。

### D2：允许 initial Plan 包含 milestone

- Admission 接受 milestone，但 Scheduler 不执行 milestone。
- 若 frontier 出现 `ready_to_refine` milestone，创建 `planning_refinement` Action。
- Planner 增加 `mode: refine` 协议。
- 增加 leaf-only Tool Grant：只有 leaf 的 requiredToolNames 可以进入执行模型。

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

必须覆盖：

1. 首轮 Plan 可以包含 `milestone`，但 `milestone` 不会被 Scheduler 当作可执行 step。
2. Leaf 仍会被 Admission 拒绝过宽的 discovery/production/verification 混合。
3. Milestone 如果没有 requiredFacts 或 refine 条件，会被 Admission 拒绝。
4. RequiredFacts 满足后，Scheduler 创建 `planning_refinement` Action。
5. Refinement 只能替换目标 milestone 子树，不能改写无关 Plan 节点。
6. Refinement 后 dependencies 被正确重写，后续 Scheduler 只调度 children leaf。
7. Skill 绑定在 milestone 时不会暴露 Skill 正文；只有 leaf 执行前 `load_skill`。
8. Artifact 存在但 leaf Assessment 未批准时，Run 不完成。
9. 全部 leaf 完成但 Goal Assessment 未批准时，TerminalCommitter 不写 completed outcome。
10. Conversation resume 能从 current Plan tree 和 facts 继续，而不是重启首轮骨架。

## 16. 实施风险

| 风险 | 处理 |
|---|---|
| Plan tree 过复杂，模型过度层级化 | Admission 限制最大深度和每次 refine 子节点数量；初期深度最多 2 |
| Milestone 被滥用为模糊占位 | 必须有 requiredFacts、细化条件和覆盖关系；不能没有可执行 frontier |
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

## 18. 最小验收标准

该方案的第一个可验收版本不是“某个网页任务跑通”，而是以下通用链路成立：

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

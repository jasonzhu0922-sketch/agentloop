# Canonical Run State 强化方案

日期：2026-10-12
状态：阶段 1 已完成；Repair canonical gap 与终态原子化边界已提前收口

## 1. 目标

AgentLoop 的任务理解、Plan、执行事实、Assessment、Repair 与终态提交必须围绕同一个 Run 级权威状态工作：

```text
CanonicalRunState
  -> Planner / Admission
  -> Executor / Tool Result
  -> Assessment / GoalGap
  -> Repair / Plan Revision
  -> TerminalCommitter
```

各阶段可以追加自己拥有的事实，但不得复制后重新解释用户意图，也不得建立可独立修改的任务状态。Plan 是执行策略，Result 是观察事实，Assessment 是判定；三者都不是第二份任务真相。

## 2. 实质契约

同一个 Run 的所有阶段必须读取相同的 `CanonicalRunState` 身份与版本：

- `intent`：用户原始输入、跨轮目标/产物绑定、结构化目标、交付对象、约束、证据要求和验收目标；由 Runtime 在 Planning 前冻结。
- `plan`：当前 admitted Plan 的身份与版本；只能改变执行策略，不能改写 intent。
- `steps`：Step 的实际推进、证据引用和最新 Assessment 状态。
- `gaps`：由 Assessment 形成的未满足义务；Repair 直接消费这些结构化 gap。
- `terminal`：只由 TerminalCommitter 提交。

所有 mutation 通过唯一 writer，以 `expectedRevision` 做 CAS。调用方不能原地修改 state，也不能提交陈旧版本。

## 3. 禁止的实现形态

- 不新增 Intent DTO -> Planner DTO -> Assessment DTO 的多段转换链。
- 不允许 Assessor 从 Step objective 重新分类用户任务。
- 不用模型文本、文件存在、Tool success 或 Plan completed 反推 intent 已满足。
- 不让 Repair 修改用户锁定的 deliverable、constraint 或 evidence obligation。
- 不维护 canonical/legacy 双读、fallback mapping 或业务类型特判。
- 不把 prompt context、UI projection 或 ConversationWorkingSet 当作当前 Run 的权威状态。

## 4. 状态推进

```text
understood
  -> planned
  -> executing
  -> blocked | executing
  -> ready_for_terminal
  -> completed | failed | cancelled
```

Step 状态：

```text
pending -> running -> satisfied
                   -> repairable | blocked
repairable | blocked -> retired（仅经已批准的 Plan revision）
```

Assessment 拒绝不能删除已有事实。它应保留 `evidenceRefs`，并追加一个带分类、缺失证据和建议动作的 `GoalGap`。

## 5. 分阶段实施

### 阶段 1：建立 canonical aggregate 和首条纵向链路

- 增加 `CanonicalRunState`、纯 mutation 和持久化 repository。
- SQLite/PostgreSQL/TiDB 使用相同的数据契约。
- Task Understanding 后创建 state；Planner、Admission 读取 state.intent。
- Assessment 读取同一 state.intent，不再重新调用 intent classifier。
- Plan admitted、Step started、Assessment、Step completed 和 Terminal 追加同一 state。
- 添加 CAS、意图身份、gap 保真和 Assessment 不重分类回归。

完成情况：以上项目均已实现。`TaskSpec` 不再另带 `input`/`turnResolution`，Planner、Admission、执行与 Recovery 均从 `CanonicalRunState.intent` 读取同一份用户输入、跨轮绑定和结构化理解。Planner prompt 只发送 canonical state，不再额外生成 `planningTask` 语义副本。Plan 只持有 canonical state identity reference；新 schema 与新写入均不再包含 `task_semantics_json`。

### 阶段 2：收敛执行与 Repair

- `buildStepRuntimeContext` 直接读取 canonical state，不接收重复 task/profile/progress 参数。
- `RuntimeStepEvidenceState` 并入 canonical step progress，由工具结果 mutation 驱动。
- Recovery/Repair 只读取 canonical gaps；Plan revision 记录解决的 gap ID。
- 删除从错误文本、Step objective 和事件摘要重建 repair context 的路径。

完成情况：Recovery Action 已通过 `canonicalGapId` 回读 open gap，Plan revision 会退休原 Step、保留其 evidence refs 并关闭对应 gap。执行上下文和逐 Tool evidence 的进一步合并仍属于后续工作。

### 阶段 3：终态原子化与旧路径删除

- Terminal Outcome 与 canonical terminal mutation 在同一数据库事务提交。
- 删除 Plan 上重复保存的 `task_semantics_json` schema、写入和读取路径。
- 删除 Assessment/Recovery 的 task intent 重推断和兼容读取。
- UI、Router、ConversationWorkingSet 仅从 canonical state 与正式 Result/Outcome 派生展示。

完成情况：Terminal Outcome 与 canonical terminal mutation 已在同一事务提交，并有故障注入回归证明 Outcome 冲突会回滚 canonical terminal revision。旧展示投影和剩余执行上下文收敛仍按后续阶段推进。

## 6. 验收条件

1. 一个新 Run 只有一个 `intentId`，所有阶段记录相同 `stateId` 与单调递增 revision。
2. Planner、Admission、Assessment、Repair 不扫描 Step 文本重建 intent。
3. 能力不足形成明确 gap/blocked 状态，不直接丢失 intent 或伪造 completion。
4. 审核失败保留候选产物和证据引用，Repair 能指向同一 gap。
5. 陈旧 writer 更新被 CAS 拒绝。
6. Terminal 只能提交 `ready_for_terminal` 且没有 blocking gap 的 state。
7. focused tests、Kernel build 通过；重启 Host 后用 fresh Run 再做真实链路验证。

当前源码验证：Kernel build、Unit 113/113、Kernel 122/122、Multi Runtime contracts 11/11、App 59/59、PlanTemplate 13/13 与全 workspace typecheck 均通过。重启 Host 后的 fresh Run 属于部署验证，不由源码测试替代。

## 7. 意图入口的终态交付边界

`CanonicalRunState` 只能统一正确的事实，不能把 resolver 的语义污染变成全流程共同错误。会话入口因此还必须满足：

- `taskIntent.deliverables` 只记录用户要求验收的终态输出，不记录脚本、临时文件、manifest、转换中间物和验证产物。
- 每个 deliverable family 必须显式携带正整数 `expectedArtifactCount`；单件也必须写 `1`，缺失或非法时 Resolver contract repair，禁止默认和推断。
- Canonical state 初始化时立即把 family 展开为稳定 target identity（例如 `split_pdf_parts.1` 到 `.4`），此后 Planner、Admission、Executor、Assessment 与 Terminal 均读取这一份 immutable inventory。
- 过程产物可以进入 Tool evidence、Step progress 和 artifact catalog，但不得自动成为 `terminalRequired` target。
- 对既有产物的后续变换是新的 `refine_prior` 意图边，不得以 `continue_prior` 覆盖当前 `effectiveGoal`。
- 既有产物变换可以继承原产物族；新增其他终态产物族必须由最新用户请求明确提出，否则 resolver 必须在 Planning 前修复。
- Resolver repair 是有界的 canonical contract repair，不是整份结构回退：最多三次模型修正；模型选择的 artifact path 若能在 Runtime 的 reusable-artifact 目录中唯一解析，Runtime 负责规范其 owner Run、`inputMode=prior_artifact` 与 `relation=refine_prior`；无法唯一解析或 `taskIntent` 不合法时继续 repair，耗尽后以 `PLANNING_ERROR` fail closed。
- prior artifact 与 prior Result 是互斥的当前输入所有权；一旦绑定 concrete artifact，后续继承逻辑不得再将其覆盖成 `prior_result`。
- 每次 resolver 拒绝持久化一个有界的 `conversation.turn.resolution_rejected` 诊断事件，记录失败类别和字段形状；禁止 lexical/deterministic fallback，也不从缺失字段推断 resolution。

Run `bf4d62a6-1443-4f2f-bdb0-443fa37be36d` 暴露了该边界：用户只要求把合并 PDF 拆为四份，resolver 却把实现脚本加入 terminal deliverables，导致 canonical format 被投影为 `py`，Planner 两轮都无法通过原生变换契约。后续 fresh Run `9ff5e940-eb0e-4da6-9020-5bb7d0f4748c` 又暴露了局部字段错误触发整份 fallback 的问题：两次模型响应都携带 prior artifact 线索，却最终退化为 `new_goal + inputMode=none`。该事故组的回归验收是：canonical intent 仅包含 PDF 拆分目标，当前目标不被上一轮“合并 PDF”覆盖，过程脚本不进入 `artifactTargets`，artifact binding 不因 lineage/inputMode 局部漂移而丢失。

Fresh Run `addeae1b-d6bf-456b-9be2-56d5816859c3` 进一步暴露了交付集合基数缺口：四个 PDF 文件都实际生成，但 canonical intent 只有一个 target，Runtime 因而只调度并接受了一个文件的 acceptance receipt。修复后的通用契约是：`expectedArtifactCount=4` 在 Planning 前展开为四个 target；同一文件路径不能重复满足多个 target；Runtime progress 与 Assessor 都按“当前 evidence kind + distinct artifact path”做一对一覆盖；自动验收逐个选择尚未验收的匹配产物。只有四个目标分别获得所需 acceptance、openability、format 与 delivery evidence 后，Step 才能进入完成链路。

## 8. Repair 的分层边界

Repair 必须针对第一处语义损失，不能把所有失败都退回重新理解意图：

- 意图/交付错误：canonical intent 或 artifact target 本身错误，只能在 Planning 前做有界 contract repair；不能进入执行后靠文件名或产物扫描改写目标。
- 引用/协议错误：模型选择了正确的 Result，但 Tool 参数没有精确保留其 opaque identity。Runtime 必须用统一 Result schema fail closed，并把精确格式重新暴露给下一轮；禁止按前缀补全、别名映射或自动猜测。
- 执行/供应商错误：canonical intent、Result 和下一动作都正确，但模型流返回空 completion、协议中断或服务不可用。应保留私有原始流证据并按供应商失败处理，不能改写 intent，也不能把阶段性脚本或 Tool success 晋升为交付结果。

Run `fbc0d39c-4e68-4566-9bd4-c4eb8616c5ec` 同时给出了后两类证据。Step 7 把五个完整 `resultId` 缩写为八位 UUID 前缀，Runtime 全部拒绝；Step 8 从同一 canonical Result context 取回完整 ID 后读取成功，因此这不是意图错误。Run 最终在只生成 Excel builder、尚未执行并验收 XLSX 时连续收到两次 `stop + empty content`，Runtime 正确以 `STEP_NOT_COMPLETED` 失败，未把过程脚本当成终态产物。针对引用错误，`resultId` 的完整格式现在由 canonical Result 模块统一定义，并直接进入 Tool schema 与所有解析边界；不会增加任何兼容或 fallback。

## 9. Evidence producer 的统一绑定

仅统一 evidence kind 和 required capability 仍不够。Admission 必须在 Step execution binding 中为每种必需证据冻结实际 producer：

```text
evidenceKind -> capabilityId -> resolvedToolNames
```

执行、Assessment 与 Repair 都读取这份 `evidenceProducers`，不得再从 evidence kind、错误文本或 Tool 名称重新猜测生产路径。Admission 若找不到 blocking evidence 的 producer binding，Plan 必须 fail closed；PlanRepository 也拒绝缺少该字段的新 Plan，不提供 legacy 双读或默认补全。

Run `154bf17f-3281-43ed-a3b3-4f08e6c4eb28` 进一步证明，producer 绑定本身正确仍不足以修复一个错误的终态契约：`fact_acquire_table_profile` 把聚合计算建模成独立 evidence kind，Runtime 因而要求额外的 command computation receipt；模型实际已经写出目标 JSON 产物，却因缺少该过程 receipt 被 Assessor 拒绝。这不是单纯的 producer 选择错误，而是把“生成产物的过程”提升成了“完成时必须交付的对象”。

最终决策是从 EvidenceKind、Planner schema、Admission、Progress、Assessment 和 Repair 中删除该聚合证据类型，不做兼容映射或旧值转换。`computer_aggregate_table_artifact` 仍是可选的过程工具，完整读取只证明 `table_coverage`；`agentloop.commandComputationReceipt/v1` 仍保留输入、输出和哈希 provenance，但不再满足任何聚合完成门禁。Step 是否完成只由正式 artifact target、artifact receipt、artifact acceptance 及仍然有效的来源证据契约决定。携带旧 evidence kind 的持久化或模型 Plan 必须 fail closed 并重新规划。

## 10. 输入资源命名空间的单一所有权

Canonical intent 不仅拥有“需要什么来源”，还必须拥有来源 identity 所属的命名空间。`ToolSource`、uploaded source、visible directory、Skill 和 Runtime Result 是不同资源类型；即使字符串 ID 恰好相同，也不得跨命名空间解释。

- `CanonicalRunState.intent.requiredToolSourceIds` 是当前 Run 的 ToolSource 需求唯一权威，由 Runtime 在 Planning 前根据用户输入和已注册 ToolSource 解析并冻结。
- Planner 只能为 Step 选择 `requiredCapabilities`。Admission 根据 canonical ToolSource 需求、capability declaration 和实际 Tool catalog 派生 execution binding；模型不能提交 `tool_source` binding。
- Planner Tool schema 只暴露当前 Run 实际存在的 uploaded source 和 visible directory 命名空间，且 ID 必须是 Runtime-issued enum；两者都不存在时，`sourceConstraint` 的 schema 只能是 `null`。
- Planner parser 与 Admission 都必须校验资源 namespace。未知 ID 或跨 namespace ID 直接 fail closed，不能把 ToolSource 名称当目录、把 Skill 名称当 ToolSource，也不能在 repair 中猜测转换。
- Recovery 继续读取同一个 canonical intent 和 admitted execution binding，不得从 Step 文本或失败消息重建 ToolSource 需求。

Run `a49a8249-e3cb-4db6-bcef-adf3bba664f1` 暴露了首个断点：Resolver 已正确得到 `sourceBinding.mode=none`、空 `visibleDirectoryIds` 和对话交付面，Runtime 也已注册 `ontoflow-jtbc` ToolSource；Planner 却把该 ToolSource ID 写入 `visible_directory` binding，Admission 因而正确报出目录不可用。修复不放宽 Admission，也不新增 ID 映射，而是把 `requiredToolSourceIds` 收回 canonical intent、按当前 canonical inputs 动态约束 Planner schema，并在 parser 首边界拒绝跨 namespace 输出。同一修复还消除了意图摘要的独立重分类：当 resolver 已给出 conversation deliverable 时，`classifyTaskIntent` 不得再因 `kind=document` 将其改写为 workspace artifact。

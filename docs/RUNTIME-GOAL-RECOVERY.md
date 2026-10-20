# 用户目标、结果验收与恢复契约

本次优化沿用 `CanonicalRunState → Plan/Step → 工具证据 → Assessment/GoalGap → Recovery → TerminalCommitter`。目标、缺口和完成状态继续由同一个 Run 聚合保存；Plan 是可修订的执行策略。

## 1. 保留需求与观察

- Resolver 的结构化决策确定证据需求。不能因为用户说“比较”“分析”就通过关键词把已有输入处理升级成外部资料研究。已有 Result、原生文件转换与 `refresh_sources` 保持各自的输入语义。
- 阻塞性结果条件携带 `basis`，包含原始 intent ID、关联 target IDs、原文引用及推导理由。准入检查身份、引用和目标关系；前置步骤可以引用依赖它的后续交付目标，但不取得目标所有权。
- 明确标为 `execution_method` 的条件不能成为阻塞性用户义务。引用原文并不证明推导正确；Assessor 仍需检查必要条件是否扩大了用户要求。
- 当前有界 `computer_read_file` 正文和 ranges 正文与 Result 读取窗口一样保留。上下文投影只改变模型视图，不能让刚读到的内容只剩路径和哈希。

## 2. 分开执行检查与结果判断

`model_judged` 选择评估方法，不自动要求网页、书面引用或某种来源。`result_judged` 评估原始用户要求；文件类目标也包含 `requested_goal`，不能凭文件回执通过内容验收。

工具观察只能证明实际检查过的属性。文件存在、非空、可解码、尺寸正确不能证明未观察的内容质量。Assessor 可以把缺少支持的内容属性保留为 unverified，也可以用 `contractIssue` 指出计划增添了无依据的要求；后者进入 Plan 修订，不能静默豁免已准入条件。

`FailedBoundary.unmetCriteria` 保存具体条件、target、状态、理由和证据引用，直接进入已有 `CanonicalGoalGap`。`missingEvidenceKinds` 只表示执行证据种类；目标 ID 和任意业务条件文本不再冒充证据种类。

## 3. 收敛与 Recovery

候选拒绝缓存绑定“当前决策依据 + 输出 + 交付候选”。同证据上的改正答案会重新验收；完全相同的重复候选复用拒绝结果。局部候选预算耗尽进入既有 Recovery，不直接等同于全局失败。

Recovery 读取同一个 canonical state/Gap、已尝试策略、授权能力目录及已有证据。修订后的多个前置/交付叶子共享原 Gap；单个前置步骤通过不会关闭结果缺口。预算按策略修订次数累计，换 Step ID 不重置；当前上限为每个 Gap 两次自动修订。

Plan 修订与 canonical 修订在同一个事务内提交。此前已提交的工具证据可在修订范围内继续使用。未知外部作用仍遵守既有恢复安全边界。无效 Recovery 响应会收束为停止 Outcome，不留下仍在运行的 Run，也不生成交付收据。

## 4. 阶段产物与正式交付

同一产物投影三个独立状态：

| 状态 | 依据 |
| --- | --- |
| `verification.file` | 当前文件 SHA-256/bytes 与真实文件检查回执一致 |
| `verification.result` | 当前目标绑定、已接受 claim 的版本/哈希/大小一致，且所属步骤已通过 |
| `verification.delivery` | 上述结果成立，且 canonical terminal 已完成 |

只有最后一种状态可以显示为正式交付。未通过的文件仍可预览、下载，并显示结果缺口与当前版本检查的 caveats。覆写文件不会继承旧版验收；下载时也会校验已观察的哈希。Router 持久化同一份只读投影，Web 根据该状态显示“阶段产物”“文件检查通过，结果尚未验收”或“已交付”。

## 5. 迁移与验证

- Runtime `0009_result_assessment_profile` 增加 `result_judged`；SQLite 重建保留所有字段、记录、显式索引和触发器。PostgreSQL/TiDB 只替换相关 profile CHECK。Router `0005_artifact_verification_projection` 增加只读投影列。
- 原 Local Runtime SQLite 数据库通过只读备份复制后执行迁移：593 条历史 Assessment 的全字段摘要相同，31 张表行数相同，外键检查无错误，重复执行结果不变。原数据库未用于此次迁移演练。
- `npm test` 覆盖单元、内核和 Multi Runtime 合同；另验证候选收敛、数据库约束迁移、Router catalog 持久化及 Web 阶段文件卡片。PostgreSQL/TiDB 已验证 SQL 适配分支，未连接真实服务器执行升级。
- 更宽的 `agent-loop.test.ts` 有 5 项初始工作区已存在的失败，已用保存的初始工作区副本复现；它们涉及既有步骤预算及产物进展建议，未纳入本次修复。Multi Runtime 全量类型检查的 3 项既有错误涉及 MCP JS 声明、缺失 `liveProgressForEvent` 导出及事件测试夹具类型。

2026-10-19 使用已有 DeepSeek 配置，在临时数据库和工作区完成真实模型 Run `3a24aab3-71e4-4915-a2a4-449fdad906f6`：生成离线 HTML 比较给定数值，49.3 秒、9 次模型调用。文件检查成功后，首次内容验收因缺少正文观察被拒绝；读取已生成文件后第二次 `result_judged` 通过，目标与 Gap 收束，最终出现 `terminal.delivery_committed`。浏览器渲染驱动不可用的检查限制保留在原始回执中，并由产物投影展示。

这次真实验证证明内核链路可以运行；未启动或重启 Web/Router/Local Runtime 服务，未复跑原始人物肖像 Run，也未证明图像相似度观察能力。正式服务生效与视觉质量验收仍需相应运行环境的独立证据。

## 6. 统一当前决策与恢复入口

执行循环在每个模型决策和候选评估边界读取最新提交的 `CanonicalRunState`。`currentDecisionContext` 是读取回调，不保存启动时的状态引用；Plan 身份由 canonical state 提供。当前决策视图的 `identity.canonicalState.revision` 标明实际读取的版本。

`currentGap.assessmentGaps` 投影当前 Step 或其修复范围内仍未解决的 canonical Gap，保留具体验收条件、理由、证据引用、修复方向及累计次数。`currentGap.receipts` 只表示工具回执缺口，`evidence.receiptNextAction` 只表示回执层的准备状态。来源摘要回执成立，不会关闭所问事实的评估缺口；新证据提交后仍需 Assessment 接受对应结果。初始交付目标尚未完成不等同于已经发生评估失败，其他 Step 和已解决 Gap 不进入当前评估缺口。

当前 `nextAction` 和提示投影以这些 canonical Gap 为依据，区分补充观察、修正答案、修订计划、请求输入与停止。缺少观察时保留已授权执行工具，不因为回执齐全进入仅候选收敛；已有观察足够时允许直接修正解释或答案。提示不再同时催促“立即返回替代答案”和“继续补证”。修复方向不扩大或缩减 Run 的工具授权，不指定领域来源或具体工具。

普通执行、人工输入恢复和计划修订后执行，统一通过 `repairFailedExecution` 把可修复的评估失败交回同一个 canonical Gap。局部候选尝试耗尽不能由恢复入口直接提交失败；原人工输入恢复 Action 先收束，后续修订继续沿原 Gap 预算。正式交付仍由 Assessment 与 TerminalCommitter 决定。`step_execution.policy_applied.currentDecision` 保存决策版本、视图身份、方向和 Gap ID，作为该轮只读审计快照。

回归覆盖回执齐全但事实未核实、修复范围继承、同证据答案修正，以及普通执行和人工恢复后局部耗尽再修订、补证、验收与交付。完整单元测试 170 项、内核测试 198 项及包构建通过；额外执行循环用例的 5 项失败已在本次修改前的隔离副本中同样复现。以上不代表正在运行的服务已重启或新真实 Run 已验收。

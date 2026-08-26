# AgentLoop 应用构建心得与思考总结报告

日期：2026-08-25
范围：基于当前 AgentLoop 仓库实现、设计文档、阶段性故障诊断与上游源码核验形成的建设复盘。PI Agent、OpenCode 与 DeepSeek Harness 的上游引用均以项目文档中固定核验提交为准，避免主分支变化影响结论。

## 一、核心结论

AgentLoop 的建设过程证明，应用化智能体不能只停留在“模型聊天 + 工具调用 + 流式输出”的形态。真正可进入业务系统的智能体，需要一条能够被审计、恢复、评估和交付的运行链：

```text
用户目标
-> 身份与会话
-> Skill 目录与授权
-> TaskProfile
-> OutcomePlan
-> Admission / Capability Grant
-> Step 调度与执行
-> Canonical Evidence
-> Assessment
-> Delivery Candidate
-> Terminal Committer
-> Outcome
```

PI Agent 和 OpenCode 给了 AgentLoop 很重要的工程启发：Prompt 和工具上下文要动态组装，Skill 要渐进披露，工具结果要有序回填，长上下文要压缩，工具集不能是静态全局常量。但 AgentLoop 最终没有照搬它们的会话式 Agent Loop，而是把这些机制收束到 Plan-first Runtime 中。

这一选择的底层判断是：模型可以负责理解、规划、生成、调用已授权工具和基于证据修复；系统必须负责身份、授权、事实、调度、预算、评估和终态提交。只要这个分工被破坏，智能体就会退回到“看起来完成，但无法证明完成”的状态。

## 二、项目建设主线

### 1. 从单 Agent Loop 到应用 Runtime

早期的目标很容易被误解为“做一个更强的 ReAct 循环”。实际建设中逐步明确：AgentLoop 的核心不是循环本身，而是循环外围的应用级控制面。

当前项目已经形成两个平面：

- 控制面：用户登录、私有 Skill、会话、Run、Batch、Provider 配置、Source 绑定和审计。
- 运行面：Planner、Admission、Capability Grant、Agent Loop、Tool Registry、Context Assembler、Assessor、Terminal Committer。

Loop 仍然保持简单：组装上下文，调用模型，执行工具，持久化结果，再进入下一轮。复杂性不应塞进 Loop，而应由 Plan、Grant、Evidence 和 Assessment 这些边界承接。

### 2. 从自由计划到 Outcome Plan

最关键的一次认知变化，是不再让 Planner 同时承担“任务分类、Skill 选择、完整 workflow 设计、QA 设计、修复策略设计”。这个职责过宽会导致首轮计划不稳定，并让 Admission 不断要求 patch。

新的方向是：

```text
TaskProfile
-> SkillRoleSelection
-> OutcomePlan
-> LeafLocalExecution
-> EvidenceAssessment
-> TerminalCommit
```

Planner 首轮只提交最小 Outcome Plan：目标是什么、计划形态是什么、有哪些 leaf、每个 leaf 需要哪些核心证据、绑定哪些 primary/source Skill。它不负责预置一堆 inspect、repair、final_verify 步骤，也不默认把可选 QA 加成阻塞条件。

这个调整不是降低质量，而是把质量放回正确位置：

- Skill contract 决定领域执行方法。
- ToolResult 和 Source facts 提供证据。
- Assessment 判断证据是否满足当前 leaf。
- Terminal Committer 负责唯一完成提交。

### 3. 从“生成了文件”到“可证明完成”

建设中最反复出现的问题，是模型或工具已经生成了 Artifact，但 Run 没有完整结束。表面看这是体验问题，实质是完成语义问题。

AgentLoop 的结论很明确：Artifact、Tool success、UI 事件、模型文字都不能单独代表完成。完成必须有持久链路：

- Plan Step 有明确成功标准。
- 执行产生结构化 Evidence。
- Assessment 对 Step 与已激活 Skill 给出通过结论。
- Delivery Candidate 指向真实交付物或最终回复。
- Terminal Committer 原子写入 Run Outcome。

这个边界让系统在失败时能够诚实回答：断在规划、授权、工具、证据、评估、交付还是终态提交，而不是用一句“已完成”掩盖断点。

## 三、与 PI Agent 的对比

### 1. PI Agent 值得学习的地方

PI Agent 的价值在于把 Agent 运行态做成动态系统，而不是一次性静态 Prompt。

项目核验中，PI 的核心机制包括：

- 每轮模型调用前重建 system prompt 和工具上下文。
- 工具定义自身提供 prompt snippet 和 guideline，而不是 central prompt 硬编码全部工具说明。
- `SYSTEM.md`、`APPEND_SYSTEM.md`、`AGENTS.md` / `CLAUDE.md`、Skill 目录和工具状态共同进入模型边界。
- Skill 只在稳定上下文中披露名称、描述和位置，完整正文按需读取。
- 上下文压缩发生在模型边界，不应改写原始会话事实。
- 并行工具可以并发完成，但交给模型的 ToolResult 需要按原始调用顺序回填。

这些设计对 AgentLoop 的直接启发是：Runtime 给模型看的内容应该是当前状态的投影，而不是一段永久静态的总提示词。工具和 Skill 越多，越要用动态目录和渐进披露控制上下文噪音。

### 2. AgentLoop 不能照搬 PI Agent 的地方

PI 更接近单机开发者 Agent。它可以允许模型按提示自觉读取 Skill，也可以让项目里的 `SYSTEM.md` 替换默认 prompt，还可以通过 extension 临时覆盖本轮 system prompt。

这些在 AgentLoop 里不能直接采用：

- Skill 激活不能依赖模型自觉。AgentLoop 必须由 Runtime 在 Planner 或 Step 边界强制 `load_skill`，否则 Skill Compliance 没有稳定证据。
- 项目文件不能替换服务端 persona。AgentLoop 的身份、权限、Plan、Assessment 和 Terminal Committer 是系统权威，只能被受限 project instruction 补充，不能被工作区文件覆盖。
- Extension 改 prompt 必须可审计。若未来支持扩展临时改变上下文，必须持久化来源、作用范围、hash 和生效回合。
- 工具可见性不能由 prompt 文本授予。工具必须来自 Capability Grant、Step binding、副作用策略和用户授权。

换句话说，PI 的动态 prompt 是很好的模型边界投影机制，但 AgentLoop 不能让 prompt 成为权限和完成的权威。

## 四、与 OpenCode / Opencode 的对比

### 1. OpenCode 值得学习的地方

OpenCode 的优势在于 Session 运行时每回合重新物化 Skill、MCP 和 Tool 快照，并且把 Skill 目录与 Skill 正文分开。

项目核验中，OpenCode 的关键经验包括：

- 每个模型回合按当前权限生成可见工具集合。
- Skill Registry 内部保存完整正文，但模型先看到的是权限过滤后的目录。
- `skill` Tool 经权限确认后才返回完整正文和资源根。
- 上下文溢出不是按消息条数判断，而是结合模型上下文、输入上限、输出预算和 compaction reserve。
- 旧 Tool 输出可以从模型可见上下文中裁剪，但近期交互和受保护 ToolResult 需要保留。

AgentLoop 采用了其中两个核心思想：工具快照在模型边界动态物化，Skill 正文只能通过受控工具进入 transcript。

### 2. AgentLoop 对 OpenCode 的调整

OpenCode 面向本地交互式 coding session，它的权限模型、持久化语义和恢复要求与多用户应用不同。AgentLoop 因此做了更严格的调整：

- OpenCode 的本地 Skill 来源不等同于 SaaS 多租户隔离。AgentLoop 在数据库查询、Agent-Skill 绑定、`load_skill` 和 Package Store 多个边界重复校验所有权。
- OpenCode 可以在 session 内标记旧 Tool Part 为 compacted 并影响后续可见内容；AgentLoop 的事件存储同时承担审计和恢复权威，因此原始 `tool.completed` 事件和 Tool evidence 不应被改写，只能在 Context Projection 中替换可见输出。
- OpenCode 的会话摘要主要服务“继续聊天”；AgentLoop 的摘要不能替代 Plan、Assessment、Skill Compliance、Delivery 和 Outcome。
- OpenCode 的工具快照是交互运行能力；AgentLoop 的工具快照还必须服从 Plan Step、Capability Grant、危险工具授权和副作用策略。

因此，OpenCode 更像一个优秀的本地 Agent 运行壳；AgentLoop 要把它的动态上下文思想应用到一条可审计的 Plan-first 执行链中。

## 五、建设中的关键心得

### 1. Runtime 权威必须高于模型自述

模型文字只能是内容，不能是状态。模型说“我完成了”、工具返回“成功”、页面显示“已生成”，都只是候选事实。真正状态必须由 Runtime 根据持久化对象推进。

这条原则贯穿多个模块：

- Run 状态来自数据库，不来自 UI 局部状态。
- Step 完成来自 Assessment，不来自模型自然语言。
- Skill 使用来自 `load_skill` 证据，不来自 Planner 提到 Skill 名称。
- 文件读取来自 Source Tool evidence，不来自上传成功。
- 终态来自 Terminal Committer，不来自最后一条 assistant 消息。

### 2. 事实层与投影层要严格分开

AgentLoop 的长期可维护性来自一个分层原则：

- Canonical transcript、ToolResult、Plan、Action、Assessment、Outcome 是事实。
- Runtime Context、SSE、Web UI、摘要、候选展示是投影。

投影可以压缩、裁剪、重排和增强展示，但不能反向修改事实。这个原则解决了上下文压缩、前端状态漂移、Run 恢复和审计追责之间的冲突。

### 3. Skill 是版本化工作流事实，不是 Prompt 片段

Skill 如果只是拼进 prompt 的长文本，很快会带来上下文膨胀和权限混乱。AgentLoop 的建设结论是：

- Skill 目录常驻，正文按需加载。
- `load_skill` 是受控 ToolResult，进入证据链。
- Step 绑定哪个 Skill，就只评估实际激活过的那个版本。
- Package Skill 原样托管，只读、hash 校验、来源可追溯。
- Skill 可以指导模型如何工作，但不能扩大工具权限。

这样 Skill 才能成为可复用、可审计、可评估的能力单元。

### 4. 文件和目录是 Source，不是聊天附件

文件上传、大目录选择和可见目录搜索把一个边界暴露得很清楚：外部材料不能直接塞进用户输入。

正确做法是把它们纳入 Source Intake：

- 文件有 owner、conversation、sha256、抽取状态、chunk、summary 和错误码。
- 目录有 bounded index、field profile、source summary 和 caveat。
- 读取行为通过 `read_source` 或 visible directory tools 产生 evidence receipt。
- 大结果用 compact projection 和 content-addressed reference 降噪。

上传成功、目录可见、搜索命中都不是完成。它们只是后续 Plan 和 Assessment 可使用的证据来源。

### 5. 研究类工具要减少模型操作噪音

Web 工具验证说明，通用 shell/curl 虽然灵活，但会把模型预算消耗在重定向、HTML 噪音和重复搜索上。应用化工具应该把低层复杂度收束掉：

- `websearch` 返回结构化搜索结果和来源。
- `webfetch` 负责正文抽取、重定向、大小限制、SSRF 防护和错误分类。
- Source summary 和 caveat 让模型知道哪些事实已验证，哪些事实不可用。
- 达到证据条件后，Runtime 应能机械收敛到候选输出，而不是等待模型自觉停手。

这不是限制模型能力，而是把模型从低价值操作中解放出来。

### 6. 可恢复性是产品化分水岭

单进程 Demo 可以“卡住就重跑”。产品级 Runtime 不能这样。它必须能回答：

- 当前未闭合动作是什么？
- 属于哪个 Run、Plan 和 Step？
- 是否已经发生外部副作用？
- 是否可以安全重放？
- lease 是否过期？
- 是否需要用户确认？
- 最终失败或完成是否已经写入 Outcome？

AgentLoop 的可恢复 Runtime 方向，是把 `runtime_actions`、lease、deadline、fence、replay policy 和 recovery decision 变成持久事实。这样才能避免长期 `running`、重复副作用和恢复时跳过评估。

### 7. 不要为单个失败 Run 写捷径

建设过程中最重要的工程纪律之一，是每次失败先查 `data/agentloop.db`，看 `runs`、`plans`、`plan_steps`、`runtime_actions`、`run_events`、`skill_compliance_assessments` 和 `run_outcomes`，找到第一处语义断点。

如果断点是 Planner 输出太重，就修 TaskProfile / OutcomePlan；如果断点是证据没有被识别，就修 typed evidence；如果断点是 UI 未同步，就修投影合并；如果断点是 Assessment 语义不稳，就修评估协议。不能用“看到文件就完成”“看到某类任务就特殊放行”这类捷径。

### 8. 设计、实现、E2E、发布必须分清

AgentLoop 的建设过程里有不少设计先行或分阶段落地的内容，例如 Redis Skill Cache、可恢复 Runtime 的 D2-D3，以及 Source Intake 的生产化增强。当前 Source Intake MVP 已经落地，不能再按“待实施 MVP”描述；仍需区分的是基础能力、增强能力、真实 E2E 和生产发布状态。

面向团队协作，至少要分清四种状态：

- 设计稿：有方案，但不能按实现对外承诺。
- 已实现：代码链路存在，并有单元或集成测试。
- 已真实 E2E：通过真实认证、真实 Run、真实 Artifact / Outcome 证据验证。
- 已生产发布：部署到目标环境并通过生产回归。

这能避免“文档写了”被误解为“系统已经具备”。

## 六、AgentLoop 相比上游的定位

| 维度 | PI Agent | OpenCode / Opencode | AgentLoop 的选择 |
|---|---|---|---|
| 主要场景 | 本地开发者 Agent | 本地 coding session | 多用户应用化智能体 Runtime |
| 核心状态 | 会话与 mutation | Session、Tool/Skill 快照 | Run、Plan、Step、Evidence、Assessment、Outcome |
| Prompt | 每轮动态拼装，支持项目文件和 extension 影响 | 每轮重建系统上下文与工具快照 | 服务端权威上下文投影，项目内容只能受控注入 |
| Skill | 目录披露，模型或命令读取正文 | 权限过滤目录，`skill` Tool 读取正文 | Runtime 强制激活，Skill 原文成为版本化证据 |
| 工具授权 | 会话级 active tools | session 权限与工具快照 | Plan Step + Capability Grant + 危险工具授权 |
| 上下文压缩 | 摘要 + 近期尾部，不改写原会话 | prune + compaction，保护部分 ToolResult | 只改模型投影，不改 canonical evidence |
| 完成判定 | 会话产出导向 | 交互任务产出导向 | Assessment + Terminal Committer 唯一终态 |
| 恢复目标 | 本地会话可继续 | session 可继续 | 未闭合 action 可解释、可领取、可恢复或可失败 |
| 多租户 | 非核心目标 | 非核心目标 | 登录、所有权、私有 Skill、会话工作区隔离是核心边界 |

总结来看，PI Agent 和 OpenCode 是 AgentLoop 的重要技术来源，但 AgentLoop 的目标不是复刻一个本地 coding agent。它要解决的是企业应用里更难的问题：谁授权、谁执行、证据在哪里、如何判断完成、失败后如何恢复、交付如何追责。

## 七、下一阶段建设建议

1. 完成可恢复 Runtime 的 D2-D3：补齐 runtime action lease、deadline、fence、heartbeat、replay policy 和 recovery review。
2. 将 Source Intake 从已完成 MVP 推向生产化：在现有文本、HTML、PDF、DOCX、XLSX、PPTX 上传、抽取、chunk、summary、`read_source` 与 `run_sources` 基础上，补齐抽取版本记录、删除/清理策略、更丰富 Office 结构解析、OCR/安全扫描、跨会话资料库或向量检索，以及真实 E2E 证据。
3. 巩固首轮 Planner 轻量化的已落地主链：`TaskProfile -> OutcomePlan`、`submit_outcome_plan`、首轮 Skill role selection、禁止普通任务 QA/repair tail、旧 `submit_plan_patch` 非正常路径已经实现；后续重点是用真实 Run 指标继续压缩 Planner 启发式和首轮失败率。
4. 扩展已落地的统一证据门：`verify_artifact_acceptance` 和 `agentloop.artifactAcceptance/v1` 已覆盖普通文件、HTML/HTML-PPT、OpenXML Office、PDF、Markdown、图片、JSON 与 provider 注入；后续重点是接入更多真实渲染器、补齐 Office/PDF/图片全保真验收，并把真实 E2E 证据沉淀到诊断视图。
5. 建立 Run 诊断视图：按 Run 汇总模型回合、token、工具时间、Plan、Evidence、Assessment、Outcome 和首个语义断点。
6. 固化投影原则：SSE 和 Web UI 只做派生展示，终态后必须回源合并权威 Conversation / Run。
7. 将上游学习沉淀为协议，而不是代码依赖：继续吸收 PI / OpenCode 的动态上下文和 Skill 机制，但保持 AgentLoop 的 Plan-first、Grant、Evidence、Assessment、Terminal Commit 主链。

## 八、结语

AgentLoop 的建设价值，不在于把某个模型、某个 Skill 或某个页面跑通一次，而在于形成了一套应用化智能体的工程纪律：

- 模型可以强，但权威事实必须在系统里。
- 工具可以多，但授权必须可解释。
- Skill 可以复杂，但激活和评估必须有版本化证据。
- Artifact 可以生成，但完成必须经过 Assessment 和 Terminal Committer。
- 上下文可以压缩，但证据不能消失。
- UI 可以实时，但终态必须回到持久事实。

这套纪律会让早期系统显得更重，但它换来的是后续扩展时的稳定性。面向真实业务，AgentLoop 最值得坚持的方向就是把所有新能力纳入同一条 canonical evidence chain，让每一次运行都能被解释、被恢复、被评估、被交付。

# AgentLoop 应用构建心得与思考总结报告

日期：2026-08-21  
范围：基于当前 AgentLoop 仓库实现、设计文档与阶段性建设复盘形成的工程总结

## 一、建设背景与核心判断

AgentLoop 的建设目标不是再做一个“模型聊天 + 工具调用”的外壳，而是构建一个可审计、可恢复、可扩展的智能体运行框架。项目从 PI Agent、OpenCode、DeepSeek Harness 的固定提交中吸收了会话追加、动态工具快照、Skill 渐进披露、有界工具执行、副作用前置记录等机制，但最终形成的是一条以 Plan-first 为主线的本地参考实现。

在建设过程中，最重要的判断是：智能体系统的可靠性不能建立在模型自述上。模型可以规划、推理、调用被授权的工具、整理交付内容，但不能决定自己是否拥有某项能力，不能凭一句“已完成”跳过评估，也不能因为文件已经生成就绕过终态提交。项目因此把完成定义收束为一条明确链路：

```text
用户任务
-> Skill 目录与授权
-> 结构化 Plan
-> Admission / Capability Grant
-> Step 调度与执行
-> Canonical Evidence
-> Assessment
-> Delivery Candidate
-> Terminal Committer
-> Outcome
```

这条链路看起来比传统 ReAct 循环更重，但它解决的是应用化智能体必须面对的问题：权限边界、证据归属、失败可诊断、运行可恢复、交付可追责。

## 二、最关键的工程收获

### 1. Plan-first 是运行秩序，不只是提示词

早期容易把“让模型先写计划”理解成 Prompt 约束。AgentLoop 的实践表明，Plan-first 必须成为运行时协议：

- Planner 只能通过结构化 `submit_plan` 提交计划。
- Admission 校验依赖、工具、Skill 绑定和安全约束。
- Scheduler 只能选择依赖已满足的 Step。
- 执行阶段的工具集合来自当前 Step 的 Capability Grant，而不是来自用户提示或模型请求。
- 每个 Step 必须通过 Assessment，最终再由 Terminal Committer 提交 Outcome。

因此，Plan 不是展示给用户看的说明文字，而是 Runtime 后续授权、调度、评估和恢复的骨架。这个设计带来的最大价值，是把“模型想做什么”和“系统允许做什么”分开。

### 2. 完成必须有持久证据，不能靠 Artifact 或模型文本

项目建设中反复出现一类问题：Artifact 已生成、工具也返回成功，但 Run 仍然不能算完成。这个判断一开始会显得严格，但后来证明它是系统可靠性的底线。

真正的完成需要同时满足：

- Plan 中相关 Step 已执行到可评估状态。
- 证据来自结构化 ToolResult、文件观察、运行事件或受控 Source facts。
- Assessment 对 Step 成功标准和已激活 Skill 约束给出通过结论。
- Terminal Committer 原子提交 Delivery 与 Outcome。
- `runs.status` 和 `run_outcomes.reason_code` 与终态一致。

这条边界避免了三类风险：模型误报完成、工具输出被误读为业务完成、UI 投影先于权威状态变化。

### 3. Skill 的价值在于“按需激活的可信上下文”

AgentLoop 没有把 Skill 做成一组硬编码业务流程，也没有让前端用户手动选择一堆 Skill。当前更成熟的边界是：

- 服务端发现和托管 Skill Package。
- Skill Package 原样复制到用户隔离的只读存储。
- Planner 初始只看 Skill 元数据目录，不看完整正文。
- 只有 Step 绑定 Skill 时，Runtime 才暴露 `load_skill`。
- `load_skill` 的 ToolResult 进入当前 Run transcript，成为后续 Assessment 的证据。
- Assessment 只评估实际激活过的 Skill，不把候选目录当成已使用事实。

这个设计把 Skill 从“提示词拼接素材”提升成了“授权后按需加载的版本化工作流事实”。它也避免了 Skill 数量增加后上下文膨胀、权限扩张和评估口径不清的问题。

### 4. 上下文压缩不能改写事实，只能改变模型视图

长任务中上下文膨胀是必然问题。建设过程中，一个重要认识是：compaction 不能成为事实层的改写器。

AgentLoop 的正确分层是：

- Canonical transcript、Plan、ToolResult、Assessment、Outcome 保持持久、可回放。
- Context Assembler 为下一次模型调用生成有预算的投影视图。
- `context.assembled` 记录每次模型调用前的视图组装。
- `context.compacted` 只代表模型输入投影被压缩，不代表原始证据消失。
- 若 Skill 激活证据离开近期尾部，下一步需要重新 `load_skill`，不能用摘要替代 Skill 原文。

这带来一个清晰原则：压缩是模型输入优化，不是运行事实优化。

### 5. 会话工作区隔离要落在执行链路，而不是工具说明

“同一会话多轮复用工作区、不同会话物理隔离”看似是一个路径配置问题，实际必须贯穿 RunService 到 ComputerExecutor 的运行上下文链。

最终形成的边界是：

- 每个 conversation 使用 `WORKSPACE_ROOT/conversations/<conversationId>`。
- 同一会话后续轮次复用该目录。
- 不同会话目录物理隔离。
- server-managed Skill Package Store 与会话工作区分离，并保持只读。
- Computer Tool 只能使用相对路径，防止绝对路径逃逸。

这个设计把“用户连续创作体验”和“租户/会话隔离”同时保住了。

### 6. 模型配置必须服务端所有，前端只选择受控 key

多模型支持中最容易犯的错误，是让前端或 Run API 直接携带 provider URL、API key、协议参数。AgentLoop 的建设结论是：

- Provider 持有 endpoint、credential、protocol 和 retry 策略。
- ModelProfile 持有 `modelKey`、展示名、真实 `providerModel`、上下文限制和协议覆盖。
- Run 只持久化服务端白名单中的 `modelKey`。
- Planner、执行 AgentLoop、Assessor、Recovery 必须复用同一个 Run-level `modelKey`。
- 展示名不能当成 provider model id 发送。

这不仅是安全问题，也是可诊断问题。只有模型选择被服务端收束，后续才能解释一个 Run 到底用了哪个模型、哪个协议、哪个预算。

### 7. 文件上传应进入 Source Intake，而不是拼进用户输入

文件能力的设计暴露了另一个核心边界：附件不是聊天消息的装饰，也不应该被前端读取后塞进 Prompt。合理链路是：

```text
Upload
-> Auth / ownership
-> Source Intake
-> storage + extraction + chunks + summary
-> run_sources binding
-> Planner source facts
-> read_source Tool
-> Assessment / Terminal Committer
```

这样做的好处是显性的：文件有 owner、hash、状态、抽取错误、chunk locator、Run 绑定关系；LLM 的读取行为也能成为证据。上传成功或抽取成功本身仍不代表任务完成。

### 8. Web 工具要给模型“低噪音结果”，否则预算会被研究动作耗尽

Web 工具验证中，一个失败 Run 把大量步骤耗在 curl、重定向、HTML 解析和低质量搜索上，真正的目标步骤没有开始。后续引入 `websearch` / `webfetch` 后，工具承担了去噪、重定向、正文提取、搜索结果归一化、SSRF 防护和 token 上限控制。

这说明应用级工具不只是“把外部能力暴露给模型”，还要负责降低模型操作复杂度。工具输出越结构化、越低噪音，模型越可能把预算用在判断和产出上，而不是重复探索。

## 三、建设过程中的典型教训

### 1. 不能为单个失败场景加定制绕路

项目中多次遇到某个 Run 失败但表面上“差一点就成功”的情况。最危险的修法是为该场景补一个旁路：看到某类文件就认为完成、看到某段模型文本就触发提交、遇到某个 Skill 就特殊处理。

后来的实践原则是：先查 SQLite 中的 Run、Plan、Step、Event、Action、Assessment、Outcome，找到第一处语义断点，再修通用边界。比如 Planner 规划粒度不对，就修 Plan Admission 或 Step 拆分；证据识别不对，就修 typed evidence；评估没提交，就修 Assessor 协议或模型约束，而不是跳过评估。

### 2. UI/SSE 是投影，不是权威状态

Web 前端曾出现终态后仍显示 RunningPlaceholder 的问题。根因不是 Run 没结束，而是终态 SSE 后前端只更新了 `currentRun`，没有重新拉取权威 Conversation 并合并到 `conversation.runs`。

这类问题提醒我们：UI 状态必须从权威 Run/Conversation 投影而来。SSE 可以提升实时性，但不能替代最终一致的权威读取。

### 3. 模型的“工具调用文本”必须和真实 tool call 分开

当工具在收敛阶段被隐藏时，模型可能仍然在自然语言里写出类似工具调用的文本。Runtime 不能把这种文本当成工具执行，也不能因为它看起来像 DSML 或命令就执行。正确做法是拒绝这类未授权行为，并改善规划、工具可见性或收敛证据。

这个教训本质上是：Provider tool call 是协议对象，模型文本只是内容。

### 4. 预算问题常常不是工具慢，而是上下文与模型回合过多

对某些长 Run 的分析显示，成功工具耗时很短，真正的耗时集中在模型调用、上下文膨胀和重复研究上。优化方向因此不能只盯着工具执行速度，还要看：

- Step 是否过粗，导致模型反复自我探索。
- ToolResult 是否过大，挤占上下文。
- 是否缺少收敛条件，导致已具备证据后继续搜索。
- 是否需要更早 compaction 或更明确的 research discipline。
- 是否应按任务类型选择更经济的模型 profile。

### 5. 设计文档也要明确“未实施”

文件摄取和 Redis 缓存目前是设计稿，不是已完成能力。这一点必须在报告、README 或交付说明中明确。否则团队很容易把“已有设计”误当成“已有实现”，进而在验证或部署中产生错误预期。

## 四、对应用化智能体的进一步思考

### 1. 智能体工程的核心不是让模型更自由，而是让自由发生在受控边界内

AgentLoop 的建设过程说明，模型自由规划和系统确定性约束并不冲突。合理分工是：

- 模型负责理解目标、提出计划、组织内容、选择已授权工具、根据证据修正方案。
- Runtime 负责身份、授权、预算、事实持久化、调度、恢复、评估入口和终态提交。
- Tool 负责执行受控动作并返回事实。
- Assessor 负责判断候选结果是否满足标准。
- Terminal Committer 负责唯一终态。

边界越清晰，模型可发挥的空间反而越稳定。

### 2. “证据优先”比“流程优先”更适合长期演进

如果系统围绕固定流程搭建，新增 Skill、工具、模型、文件来源时很容易膨胀出大量分支。AgentLoop 更合理的方向是围绕 canonical facts 演进：

- Plan 是事实。
- Grant 是事实。
- ToolResult 是事实。
- Source chunk 是事实。
- Assessment 是事实。
- Delivery/Outcome 是事实。

只要新能力能进入这套事实链，就可以被调度、评估、恢复和审计，而不必为每种业务写一套完成逻辑。

### 3. 可恢复 Runtime 是从 Demo 到产品的分水岭

单进程 Demo 可以接受“进程挂了就重跑”。应用化系统不行。可恢复 Runtime 的关键不是把 running 超时改成 failed，而是能回答：

- 当前未闭合动作是什么？
- 它属于哪个 Plan Step？
- 是否已经发生外部副作用？
- 是否可以安全重放？
- 是否还有重试预算？
- 是否需要用户确认？
- 最终失败原因是否由 Terminal Committer 持久化？

`runtime_actions`、lease、deadline、fence、replay policy 和 recovery decision 是后续生产化必须补齐的方向。

### 4. 插件与工具越多，越需要统一授权与证据模型

Web、Computer、文件读取、Skill Package、未来 MCP/浏览器/企业系统接入，都会增加能力面。如果每个工具各自解释权限和完成，系统会很快失控。AgentLoop 已经形成的方向是：

- 工具注册是能力目录。
- Plan Step 声明需要的工具。
- Capability Grant 决定可见工具。
- ToolResult 进入同一证据流。
- Assessment 和 Terminal Committer 不关心工具类型，只关心证据是否满足目标。

这能支撑工具体系扩大，而不让 Runtime 退化成一堆业务 if-else。

## 五、下一阶段建议

1. 补齐可恢复 Runtime 的 D2-D3：实现 runtime action lease、deadline、fence、recovery review 和 replay policy，消除无法解释的长期 running。
2. 实施 Source Intake MVP：先支持文本、PDF、DOCX、XLSX、PPTX 的安全上传、抽取、chunk、`read_source` 与 `run_sources` 绑定。
3. 推进 Redis Skill Cache 的 Phase 1：先做接口、Noop/Memory、本地测试和完整性正向缓存，不急于接入网络 Redis。
4. 强化研究类任务收敛：在证据充足时机械触发 no-tool candidate，减少重复 websearch/webfetch 消耗。
5. 完善 Run 诊断工具：提供按 Run 汇总 Plan、Action、Model turn、Tool time、token、Assessment、Outcome 的诊断视图。
6. 把 UI 投影明确为只读派生层：终态后统一回源合并 Run/Conversation，避免局部状态漂移。
7. 建立“设计稿、已实现、已真实 E2E、已生产发布”的标识体系，避免交付状态混淆。

## 六、结语

AgentLoop 的建设价值，不在于把某个模型或某个 Skill 跑通一次，而在于逐步形成了一套应用化智能体的工程纪律：模型可以强，但权威事实必须在系统里；工具可以多，但授权必须可解释；Artifact 可以生成，但完成必须被评估和提交；上下文可以压缩，但证据不能消失；UI 可以实时，但终态必须回到持久事实。

这套纪律会让早期实现显得更复杂，但它换来的是后续扩展时的稳定性。面向真实业务场景，AgentLoop 最值得坚持的方向就是继续把所有能力纳入同一条 canonical evidence chain，让每一次运行都能被解释、被恢复、被评估、被交付。

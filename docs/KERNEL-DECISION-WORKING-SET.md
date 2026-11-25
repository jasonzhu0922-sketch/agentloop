# 内核当前决策工作集

## 运行契约与第一处缺口

默认决策顺序是：目标 → 当前状态 → 当前产物 → 历史提示 → 决策与行动 → 更新状态。完整记录继续持久化，模型输入是记录在当前决策边界的投影。

本次源码核实发现，已有 `CanonicalRunState`、`CurrentDecisionView` 和 `WorkProductContext` 能表达当前目标、产物版本与问题适用性。第一处缺口在执行上下文装配：`runtimeContext` 中的当前视图与追加式 `messages` 并存；`projectExecutionHistory` 主要合并相邻、相同、已知的读取失败，已成功交换的参数和正文仍驻留，随后才进入容量驱动压缩。独立 Assessment 路径也可能重新复制执行证据。

修复位于内核的投影和 Provider 编码边界，未按 SQL、表名、指标、Skill 或宿主回执字段设计。关键实现：

- `runtime/decision-working-set.ts`：从已有已提交事件派生语义承接、修订、来源、适用性和未承接入口。
- `runtime/decision-context-transport.ts`：把同一 progress updates 编码到原生工具参数；执行领域工具前移除内核元数据，原始 Provider 参数继续留在正式 checkpoint。
- `runtime/context-assembler.ts`：每轮先重建工作集，满足语义承接和协议条件后移出完整交换，再执行已有容量保护。
- `runtime/canonical-decision-basis.ts`：规划、恢复和评估的 Canonical 模型视图；权威 reducer、Admission 和终态提交仍消费完整状态。
- `runtime/runtime-result-repository.ts`、`tools/result-tool.ts`：复用 Result 授权和原有事件账本，按需定位历史。

审查也发现 `ActionTrackedModel` 原先未透传新增 Provider 释放能力。已与 steer 包装层一并透传，宿主级回归经过真实 `RunService`、Action 持久化与 Assessment，而非只测直接 assembler。

## 单一权威与四类内容

没有新增业务状态表、历史库、快照数据库或第二个 Canonical 写入器。工作集是可丢弃、可重建的投影缓存，权威来源如下：

| 内容 | 来源与语义 |
| --- | --- |
| 目标、约束和授权 | 原始用户输入、Canonical intent/amendments、HIL 问题及答案、决策 ledger。精确原文和作用范围保留，模型承接不能授权、改写目标或扩大范围。 |
| 当前事实和缺口 | 已提交工具结果、Canonical open gaps、CurrentDecisionView，以及明确标为 model authority 的语义条目。观察的模型解释、推断、未知和冲突分开表达。 |
| 当前产物 | 复用 WorkProduct 观察、版本、check 绑定、删除状态和目标绑定；通用研究结论、计算依据等通过有来源的语义条目及原始 Result 表达。 |
| 历史提示 | 仍影响当前决策的 decision、commitment、失败条件、冲突与依赖；另给原始账本的定位入口，不复制全过程。 |

`observation` 仍是模型对观察的解释，`certainty=observed` 不会使它升级为 Runtime 验证事实。工具成功、事实成立、产物有效、Assessment 通过、正式交付和 Run 完成保持不同边界。

语义条目的 `resolved` 只表达有新增成功证据支持的模型判断；不会关闭 Canonical gap、接受交付或覆盖用户选择。内核验证引用和生命周期，领域上的证据是否足以支持结论仍归 Agent/Skill 和已有 Assessment。

## 一次行动如何更新下一轮

1. 仍先完成正式 Action/Result 与事件提交；未完成或未知效果不能靠声明消除。
2. 已有 WorkProduct reducer 从提交回执更新存在、版本、check 和问题适用性。当前视图在下一模型边界重新派生。
3. 模型在**下一次正常工具调用**的 `_agentloopContext.updates` 中携带当前条目。内核核对前序已提交证据的 Run/Plan/Step、精确 revision、观察到的产物版本和来源。这里没有每轮独立 summarizer 调用。
4. assembler 从完整已提交事件重建条目，退役被明确替代、解决或版本失效的旧条目，保留当前冲突、未知、承诺和拒绝声明的缺口。
5. 在历史读入口和 Provider 条件满足时，已承接的**完整调用及其全部结果**退出常驻输入；下一轮装配当前内容与尚需保留的协议交换。

当前版本只有一个上下文更新入口：正常工具调用参数中的 `_agentloopContext: { updates: [...] }`。对象 Tool schema 在已有观察时提供这个字段；空 updates 保留未承接交换。领域工具的参数校验、执行函数和授权收到剥离元数据后的原始参数，Provider checkpoint 保存完整原参数。已有同名宿主字段或无法承载对象元数据的 schema 不重写，相关观察继续保留。

条目字段为 `id`、`category`、`text`、`scope`、`certainty`、`evidence`、`disposition`，可选 `version` 和 `resolves`。`evidence` 接受本请求公开的短引用、精确 Result ID 或精确 ToolCall ID，由请求冻结的唯一绑定解析；跨作用域、未来、歧义和伪造引用拒绝。只持久化实际引用的绑定。

`disposition=carry` 是模型对必要内容已完整承接的明确声明；`retain` 保留原文。仅引用不足以承接当前任务必需的实际内容。条目属于模型解释，不升级为 Runtime 权威事实。

同一主题与范围更新稳定 id，Runtime 只使用请求实际展示并保存的 `contextItemRevisions` 校验修订；模型无需填写 hash。`resolves` 明确退役旧条目或解决旧未知，须引用新增成功证据，并校验旧条目 revision、相关产物版本；所有校验通过后原子应用。同 id 的 finding 可显式解决其旧 unknown，同时作为当前 finding 保留。完成一次行动不表示事实过期。

不再接受上下文更新中的 `absorbs`、`status`、`replaces`，也不再解释正文中的 context progress 声明。不提供旧契约迁移或兼容分支。原始历史继续保留；旧声明不能借恢复升级为新状态。正常终态回答直接消费待处理回执，无需先清理状态或补发维护调用。

可选 `version={path,versionId}` 必须绑定该声明时已观察到、且有相关证据调用的精确版本。产物被替换或删除后，旧版本问题退出当前视图；重建产生新版本，旧版本 check 不会验证新版本。上下文条目中的版本不制造文件存在事实。

## 历史何时退出、如何重新取得

退出必须同时满足：

- 语义条目明确承接了交换；引用已提交、身份和作用域有效。
- 原生交换完整配对，调用 outcome 已知。失败写操作即使 invocation 完成，也可能有部分效果，继续驻留。
- 不是必须保留的 Skill 正文，也没有该交换的原生 reasoning continuation。
- adapter 明确声明 `completedExchangePolicy=releasable`。未知 adapter 默认保留；开启加密 Responses reasoning 的内置 adapter 保留。
- 模型当前确实可调用提供两个 history view 的 `read_result`，且有本 Step 的正式 Tool Result 锚点。

没有最近 N 条切片、关键词删除或静默截断。已有容量压缩仍作为未承接或协议必须保留内容的容量保护；没有通过降低阈值触发本次优化。

历史读取复用原 Result 工具：

```text
read_result(resultId=history.anchor.resultId, view="step_history", pointer="/entries", offset=0, limit=20)
read_result(resultId=同一锚点, view="producer_exchange", toolCallId=原调用, assistantEventSeq=索引序号)
```

`producer_exchange` 返回公开 assistant 正文、原始调用与提交回执，并指出缺失/未知 outcome；不返回公开或私有 reasoning。重用 ToolCall id 时必须用 `assistantEventSeq` 消除歧义，不能误取其他 Step 的同名调用。原参数使用 `argumentsRef` 时，通过已有 `ToolArgumentsReferenceStore` 从实际持久化根恢复；宿主未提供 resolver 时明确报告缺口。

流式执行的回执可先于最终 `assistant.committed`。读取器利用更早的正式 `assistant.tool_call.committed` 校验同作用域、同模型轮次、名称、原参数及参数引用后绑定回执；无原调用、参数不符或跨 Step 的回执不会绑定。

保留既有 JSON pointer、数组窗口和字符串窗口。读取范围只能覆盖被存储的 Result/交换，不能把一个窗口冒充整个原文件。本 Step 锚点不扩大跨 Step/Run 授权；普通依赖和跨 Run Result 继续遵守既有绑定规则。历史索引读取不会错误地标记原始绑定 Result 已被消费。

读取细节可进入当前工作集，并通过请求冻结的 revision 合并到同一条目。原文被承接后可再退出输入，而非每次读取生成一份永久副本。读取未知效果的历史不得触发重新执行外部操作。

## 各阶段与恢复

| 阶段 | 使用的共同基础及职责 |
| --- | --- |
| 规划 | Canonical intent、精确用户权威、当前有效接受结果、依赖和 open gaps；退役 Step 和关闭 gap 不作为当前问题重复注入。完整状态仍交给 Admission。 |
| 执行 | CurrentDecisionView + 版本化产物 + 有来源的语义条目 + 必要历史提示，按行动重装输入。WorkProductContext 对所有 leaf 可用，不局限于文件交付 leaf。 |
| 恢复 | 同一事件重建 transcript、语义条目和 WorkProduct；保留未完成调用、失败边界与未知效果 ledger。事件按失败依赖选择，不固定截取最近 100 条。缺少宿主版本基础时明确报告适用性缺口。 |
| 评估 | 同一 Canonical 当前视图、候选、当前有效产物与条目来源；仅装配相关 evidenceTimeline。必要时可用同一 grant 调用只读 `read_result`，最多 8 次读取，不预复制全部执行史。 |

Assessment 的原文读取进入已有 Action ledger，精确选择参数可审计；该观察不发布第二个 Result。混合 read/submit 工具批次对每个调用保持原生配对，先读证据，尚未读取前的提交不执行、不获得接受。

评估的同值证据在同一输入内用本地 JSON Pointer 共用完整内容；canonical JSON 结果只有在 `JSON.stringify` 可逐字还原时才改为结构化编码。原始文本、非 canonical JSON、用户权威和意图保持原文。这里不改变证据选择、权限或事实；相关 timeline 不再固定裁成最近 200 条，也不再静默截断 error。详见 [2026-11-25 后续优化与验证](KERNEL-WORKING-SET-OPTIMIZATION-20261125.md)。

取消、HIL、重启与恢复仍由原 Action/replayPolicy 管理效果边界。只有提交结果和完整 checkpoint 能被承接；未知或失败写边界保留，不从“模型已不见正文”推导“效果未发生”。恢复读取经过已有大参数引用还原，语义工作集与新进程从相同记录重建。

## 测量、回放与验收

**以下为前期版本的历史测量。当前唯一原生契约、最终样本与未通过边界见 [内容生命周期优化](KERNEL-CONTEXT-LIFECYCLE-20261125.md)，不得把下文旧协议样本当作最终版本性能结论。**

复用 `model.request.started/contextComposition`、`context.assembled` 和 Provider usage。新增的是计数、字符数、估算、摘要 hash 与不含正文的读取遥测：

- 当前状态/产物、语义条目、历史提示、历史明细、native/reasoning 分开观察；系统指令和工具定义保留既有组件计量。
- 诊断子组件不能再与顶层 totals 相加。字符数、估算 tokens、Provider 实报 tokens、cache 字段与账单分开；没有价格/完整 cache 信息时不推算费用或缓存命中率。
- 原生参数 schema 有固定输入开销；状态声明有输出开销，历史读取可能增加正常模型调用。输入变短不等于总成本、耗时或业务正确性更好。

离线固定任务/配置的 assembler 回放：

| 已解决历史步骤 | canonical 输入字符 | current 输入字符 |
| ---: | ---: | ---: |
| 10 | 19,773 | 10,326 |
| 100 | 157,835 | 10,337 |
| 1,000 | 1,542,037 | 10,348 |

目标、有效值、范围与一条当前状态固定，历史增加 100 倍；当前输入增加 22 字符，差异来自计数/定位字段。无 summarizer 调用，未触发容量压缩。该表是固定 Tool definitions 的 assembler 测量，不能替代真实 Provider wire usage；宿主与原生参数通道另有集成回归。

脱敏证据目录：`packages/agentloop/verification/decision-working-set/`。JSON 保存每次调用的 composition、实报 usage、耗时、模型 key、配置 hash、源码指纹、历史读数和正确性；不保存凭据或原始模型输出。

真实模型使用既有配置中的 `deepseek-v4-flash` key，在独立内存数据库运行合成任务，未访问业务数据、更新宿主依赖或启动/重启共享服务。每个 A/B 对照内部使用相同任务、已加载源码和配置；这些是单次样本，不是统计性能结论。

对照开关为同一源码中的 `executionHistoryProjection=canonical/current`，隔离新工作集与原生承接分支；不是干净旧提交与最终二进制的整包对比。工作区已有大量无关改动，未为取得基线而还原或覆盖它们。final JSON 的源码指纹标记实际参与对照的源码。

| 真实场景 | canonical | current | 判断 |
| --- | --- | --- | --- |
| 已承接长历史，必须读取 source17 精确标记 | 输入 108,102 tokens；输出 636；3 次模型/2 次历史读；5,270 ms | 输入 19,410；输出 679；3 次模型/2 次历史读；4,400 ms | 两者均正确。输入减少约 82%；原文确实被读取，日期冲突与未知保留。以 `live-final.json` 为准。 |
| 从零开始的八次连续观察 | 输入 55,115；输出 1,077；9 次模型/0 次历史读；10,814 ms | 输入 88,286；输出 3,998；13 次模型/4 次历史读；23,345 ms | 两者正确。current 自主承接，最终仅 1 个当前条目、9 个已释放交换；后续每轮约 2.2–2.9 万字符，canonical 升至 3.9 万。但额外读取和状态输出使总输入增加约 60%，耗时也增加。见 `live-sequential-final.json`。 |
| 无预置状态的短历史读取任务 | 输入 14,671；输出 560；3 次模型/3 次历史读；4,208 ms | 输入 18,038；输出 967；3 次模型/2 次历史读；5,688 ms | 两者正确，current 自主生成了语义条目并释放 1 个交换，但总输入增加约 23%。见 `live-fresh-final.json`。 |

三个 final 对照具有相同源码指纹 `8dda33b5739be70dd13f96e9a379dcd2bcab83deb929c0acc8f5cde4a1d7937f` 和相同配置 hash。历史读数统计模型发出的 Result 读取请求，成功与失败另由工具事件区分；单次调用时延和少量 cache 字段不能外推缓存命中率或账单。

实现过程中的旧试跑保留为 `live.json`、`live-sequential.json`、`live-fresh.json`，不与 final 文件混用。试跑包括：只有可选正文标签时模型没有生成承接；过于宽松的原生 schema 造成字段缺失而被拒绝；一次真实模型输出内部 progress 标签，被 Runtime 拒绝完成（旧回放器未记录所属对照分支，不能据此归因）。没有以更短输入或放宽终态条件掩盖这些失败；当前回放器在失败时也保存脱敏失败码，并返回非零退出码。

正确性覆盖：

| 范围 | 回归依据与实际边界 |
| --- | --- |
| 编码/产物 | 旧错误对新版本失效、验证必须绑定实际观察版本、删除与重建；复用 WorkProduct suites 验证正式交付生命周期。 |
| 研究 | 必需结论、原始来源入口、日期冲突和未知范围继续可见；不把模型解释升级为事实。 |
| 数据分析 | 范围、计算依据和必要结果内容承接；原始精确数值可通过 Result 窗口读取。无领域字段进入内核。 |
| 长运行 | 10/100/1,000 步固定工作集，按每轮投影；完整历史仍在账本。 |
| 原文依赖 | 必须查询旧 source17 才能取得的精确标记；真实与离线回放均检查答案，不只检查输入大小。 |
| HIL/重启/效果 | 同一事件还原相同条目；精确用户约束保留；已承接提交写在恢复时不重复执行；失败写和未知效果不被释放。 |
| Provider | 工具参数与结果整批配对、部分批次保留、reasoning/加密 continuation 保守保留、宿主字段冲突不被剥离；Assessment 混合读/提交也完整配对。 |
| 权限与完整性 | 拒绝未提交/错误 Step/错误 revision/错误版本证据；同名 ToolCall 不跨 Step 误读；参数引用缺失明确报告；索引不充当原始证据消费。 |

运行命令（仓库根目录）：

```sh
npm run build:kernel
npm run test:unit --workspace packages/agentloop
npm run test:kernel --workspace packages/agentloop
node --test packages/agentloop/tests/decision-working-set.test.ts packages/agentloop/tests/runtime-result-contract.test.ts packages/agentloop/tests/assessment-contract.test.ts packages/agentloop/tests/planner-source-constraints.test.ts packages/agentloop/tests/content-reference-flow.test.ts
node packages/agentloop/scripts/replay-decision-working-set.mjs --output /tmp/decision-offline.json
```

真实回放另外显式指定 `--live --config <现有模型配置> --env <现有凭据文件> --output <测量JSON>`；可加 `--sequential` 或 `--fresh`。这些参数读取现有配置，不打印或复制凭据。脚本失败也会交付测量，不能只筛选成功样本。

最终全量结果：unit 333 通过、1 失败；kernel 659 通过、1 失败、2 项可选网络测试跳过。专项 143/143 通过（含新增工作集 23/23）；`build:kernel`、typecheck 和 `git diff --check` 通过。两项全量失败分别为 TiDB CHECK 迁移断言与 no_progress 的 `RUN_LIMIT_EXCEEDED/STEP_NOT_COMPLETED` 断言，关闭本次 current 投影仍可复现。额外 work-product replay 的两项既有候选修复失败也在 feature-disabled 回放复现；这不等于对干净仓库基线作过证明。没有修改这些无关语义以取得全绿。

## 尚未验证的边界

2026-11-25 已补充 data-agent / Report Agent 宿主真实任务对照，见 [宿主实际任务验证](KERNEL-HOST-WORKING-SET-VALIDATION.md)。下列条目记录此前验收边界；以补充报告中明确覆盖的范围为准。补充验证同时发现复杂 HR 任务约 +94% 累计输入和产物覆盖遗漏，**不表示整体性能与业务验收已通过**。

- 没有宣称 Desktop、Local Runtime、Report Agent、data-agent 或其他宿主已部署验收；未更新消费应用依赖、提交、推送或重启共享服务。宿主级验证覆盖内核 `RunService`，真实回放覆盖模型 API 和合成只读工具。
- 模型语义承接的充分性仍依赖模型/Skill；schema 不合规或内容不充分不能靠内核猜测补齐。原文保留和缺口显式化是保真行为，不能宣称这种情况下也有有界输入。
- reasoning continuation、未承接结果、Skill 精确正文和未知副作用可能使常驻内容继续增长。所有 Provider/加密 continuation 的真实服务端恢复尚未逐一实测。
- 真实八轮任务验证了状态自主承接；千轮规模结论来自可重复离线投影，不是千轮真实业务或生产压力验收。公开研究的真实来源质量、真实编码工程和业务数据库均未外部实跑。
- history view 目前按需扫描既有 Run ledger，再返回有界窗口；没有完成超大生产账本的后端读取性能基准。模型窗口有界不等于后端扫描成本恒定。
- Assessment 历史读取有 8 次预算；更大必要读取、跨 Step 私有交换及全 Provider 的真实协议兼容仍需宿主后续验收，不能通过扩大授权绕过。

# 当前工作集优化：方案、实现与验证

日期：2026-11-25。本轮承接 [三个实际 Run 复核](KERNEL-THREE-RUN-REVIEW-20261125.md)，已完成内核修改、离线回放、模拟回归、构建及两个消费应用的本地依赖更新。未提交、推送、重启共享服务或重新执行用户业务任务。仓库及父目录未发现适用 AGENTS.md；无关的未提交和未跟踪内容保留。

## 优化顺序与第一处缺口

目标仍是：目标 → 当前状态 → 当前产物 → 历史提示 → 决策与行动 → 更新状态。已有权威状态没有重建一套。

原始架构缺口在 `ContextAssembler`：结构化 runtimeContext 与追加 messages 并存，已有当前状态不能自动使完成的交换退出模型输入。上一版工作集已补上承接与释放机制，本轮核实发现它尚未可靠兑现。三个真实 Run 的声明分别接受/拒绝 25/17、1/9、3/10，成功样本同样有输入增长；不能把成功终态当作上下文验收。

本轮按依赖推进三项修复：

1. **先恢复历史可读性。** bef6367b 的结果 seq85/112 早于最终 assistant checkpoint seq86/113；旧读取器只在最终 checkpoint 后查找回执，原始证据存在却返回缺失。先修该边界，才有可信的历史释放。
2. **降低状态承接的纯语法失败，保留语义校验。** context 专用原生通道缺 kind、缺 absorbs 及同 id 修订的版本表达出错，导致必要状态未接入、正文继续常驻。只正规化无歧义语法，版本必须绑定实际请求。
3. **评估对同一有效证据只编码一份。** 复用已有 modelEvidence、工作集与 Result；对选中证据做无损共享，不增加独立摘要模型调用，不按业务关键词删历史。

字段发现不足、金额含义、均价授权等领域问题仍由宿主与 Skill 处理，本轮没有向内核加入 SQL、指标、表名或应用回执特例。

## 复用权威来源与每轮更新

`CanonicalRunState`、精确用户修订/HIL、WorkProduct 观察与版本、Action/Result 和正式事件继续为权威来源。`DecisionWorkingSet` 仍是既有 transcript 的可重建投影；没有新业务状态表、历史存储或授权写入器。

一次行动仍先持久化 Action/Result 和事件。WorkProduct reducer 更新观察、版本和验证适用性；下一正常工具调用可携带对前序结果的 context updates。内核检查 Run/Plan/Step、已提交证据、修订版本、产物版本及未解决项，然后在下一轮重新派生当前工作集。新观察的解释保留 `authority=model`，不能授权、关闭 Canonical gap、验收产物或完成 Run。

原生通道可省略 kind（只补 context 标签）；省略 absorbs 仅等于空数组，不补事实或吸收声明。同 id 更新省略 replaces 时，必须有本次实际展示的 `contextItemRevisions`，并与当前修订完全一致。这个请求依据保存于既有 assistant checkpoint；无该依据的旧记录仍要求精确显式 revision。错版本、同一旧版本重复更新、未提交/越界证据、未观察产物版本及无新成功证据的解决声明继续拒绝。拒绝诊断增加 expectedRevision / missingFields，便于修复而非反复猜测。

## 历史退出与精确取回

完整历史始终保留。只有明确承接、结果已知、整批原生协议配对、存在可授权历史入口且 adapter 允许释放的交换才退出输入。未知效果、失败写、必要 reasoning continuation、Skill 正文和未承接内容继续保留。省略 absorbs 不会自动退出，也没有固定最近 N 条或静默截断。

读取继续使用原 `read_result` 的 step_history / producer_exchange、原 Result 锚点及 pointer/window。流式早回执仅绑定更早的正式调用 checkpoint，并核对作用域、模型轮次、工具名称、精确参数和参数引用。重复 toolCallId 用 assistantEventSeq 消歧；孤立、错误参数、跨 Step 或取消后无结果均明确报告缺口，不猜结果，不建议重做效果未知的行动。私有 reasoning 不进入公开历史读取。

需要的历史细节进入本轮输入后，可以按稳定 id 修订到同一当前条目；承接后整批交换才可再退出，避免原文反复读取后留下多份常驻副本。

## 阶段一致性与 Provider 边界

规划、执行、恢复和评估继续复用 Canonical、CurrentDecisionView、WorkProduct 与 Result，按职责投影。规划看范围、依赖与缺口；执行看当前行动内容；恢复保留 Action 效果边界与可复用证据；评估看候选、有效成果、来源和未解决问题，必要时沿既有授权读取明细。

本轮没有更改 Plan Admission、HIL、Assessment 接受条件、产物验收或终态提交。工具成功、模型解释、版本有效和任务完成仍分别判断。Provider 原始调用参数持久化；内核 context 元数据在宿主工具执行前剥离。成批工具配对及 reasoning continuation 的保留策略不变。

评估新增 `projectAssessmentContext`，只编码已经选择的证据：

- JSON 结果仅在解析后 JSON.stringify 能逐字还原时改为结构化内容，并标明还原方式和 SHA-256。空白、重复键、不安全数字等不能逐字还原时继续使用原文本。
- 相同大值保留一份完整内容，其余为同一 assessment_context 内的 JSON Pointer；无需额外工具读取。引用不是对缺失正文的替代，也不修改原始记录或授权。
- 用户权威与原始意图保持直接可读；已有编码元数据不覆盖。所有本地引用都必须能展开还原。
- 相关 evidenceTimeline 不再静默保留最近 200 条或截断 4,000 字符 error；仍按已有引用集合选择事件。输入大小由有效证据决定，不能靠丢证据制造缩短。

遥测继续复用 model.request.started/contextComposition/provider usage。assessment_context 内的状态、工作集与历史明细现在有分项诊断，避免此前零值误导；新增仅字符、估算及计数，不记录证据正文或凭据。诊断子项不能再次加到总量，字符、估算 tokens、实际 provider/cache tokens 和账单分别解释。

## 相同真实证据的离线前后对照

数据源为三个已校验的私有 Run 归档及改前 reduction；未调用模型或查询业务数据库。`replay-working-set-evidence.mjs` 对完全相同的完整工具证据和完整相关 timeline 应用新编码，逐项展开本地引用、验证 hash、还原结果文本并 deepEqual。原始私有正文不写入仓库。

| Run | 相同选中证据编码前字符 | 编码后字符 | 减少 | 原文无损还原 |
| --- | ---: | ---: | ---: | --- |
| e154278b | 812,824 | 575,276 | 29.2% | 通过 |
| bef6367b | 365,796 | 270,843 | 26.0% | 通过 |
| ff2bfa74 | 241,055 | 177,089 | 26.5% | 通过 |

这是证据编码字符对照，不是完整原请求还原，也不是实际 provider tokens、缓存、账单或耗时收益。e154278b 没有因此变成成功任务。

将旧原生参数按新语法重解释，bef6367b 的接受/拒绝从 1/9 变为 7/3，明确吸收从 4 增至 12；ff2bfa74 从 3/10 变为 5/8，吸收仍为 2；e154278b 不变。旧事件没有请求版本钉扎数据，不伪造它以消除版本拒绝。此结果不能当成新模型行为或新 Run 完成率。

bef6367b 两次 producer_exchange 原来都缺 outcome，新读取器均与 seq85/112 的结果正文逐字一致，gaps 为空。授权仍由既有 Result 契约独立验证，回放没有假装验证实际账户授权。

机器证据：`packages/agentloop/verification/host-working-set/optimization-replay-20261125.json`，包含源码指纹、输入归档 hash、计数和还原断言结果。复现命令（每个私有目录包含 evidence.json 与改前 reduction.json）：

```sh
node packages/agentloop/scripts/replay-working-set-evidence.mjs <private-run-dir>... --output /tmp/working-set-replay.json
```

## 特别验收：连续任务增加约 60%

新增 100 → 160 已解决原生轮次回归，固定目标、一个有效状态、必要值、未知项及授权；每轮通过正常原生通道承接旧结果，使用请求版本钉扎。实际装配输入为 10,064 → 10,068 字符（约 +0.04%），仅剩一个当前条目和最后一组未承接交换。没有额外摘要调用，没有容量压缩。模拟 streamed receipt-before-assistant 的重启重建与原状态完全一致，精确用户约束保持。

这覆盖“历史步骤增加 60%，有效工作集稳定”的输入增长契约。此前八轮真实模型约 +60% 累计输入/耗时、后续复杂 HR 任务约 +94% 输入及遗漏问题，仍见 [宿主验证报告](KERNEL-HOST-WORKING-SET-VALIDATION.md)。本轮离线改进**不能证明那些真实回归已消除**。后续手工同题验证需固定模型、配置、任务与源码包，同时比较业务完整性、模型调用次数、历史读取次数、实际输入/输出/cache tokens 和耗时；不能只比较末轮输入。

## 正确性验证与已知失败

最终 `build:kernel`、专项 121/121、两个宿主 typecheck、git diff --check 通过。专项包括：

| 契约 | 覆盖 |
| --- | --- |
| 编码与产物 | 旧错误随版本替代/删除失效，新验证绑定观察到的版本，重建不继承旧验收 |
| 研究与问数 | 来源范围、计算依据、必要数值、分歧和未知继续可见，旧原文精确可读 |
| 文档与交付 | 当前版本、未验证状态及候选/正式交付区分，多领域评估证据逐字还原 |
| 连续任务 | 100/160 原生轮次，以及已有 10/100/1000 轮固定工作集回归 |
| 真实历史缺陷 | 两种提交顺序、同名调用多次出现、错 turn/参数/Step、失败写和无回执 |
| HIL/恢复/副作用 | 原约束、未知效果、已完成写不重放、恢复投影一致；RunService 实际持久化请求版本钉扎 |
| Provider | 配对、部分批次、reasoning continuation 保守保留、宿主同名字段不被剥离 |
| 评估 | 原始非 canonical 文本、精确引用还原、320 条相关事件不被最近 N 条切掉、分项诊断无正文 |

本轮首次全量 unit 为 341 通过/1 失败；kernel 为 663 通过/4 失败，其中三个是沙箱本地端口测试触发的 Node 原生断言崩溃。三组在放行临时测试端口后隔离重跑 67 通过、0 失败、2 项可选网络测试跳过。另两项真实断言失败分别是 TiDB profile CHECK 迁移 SQL 期望、no_progress 的 STEP_NOT_COMPLETED / RUN_LIMIT_EXCEEDED 期望，均已用本轮改动前源码快照复现。本轮未改它们以追求全绿。最后新增边界测试和代码的专项结果为上述 121/121，未将分批结果误报为全量全绿。

## 消费应用安装与后续边界

按用户后续授权，data-agent（独立仓库 `/Users/zhujun/coding/data-agent`）与 report-agent 都已离线安装同一包：

```text
zhujun-agentloop-0.1.0-context-622632a0d730.tgz
SHA-256: 622632a0d7301859c00f8752a8c4079b9afcc794fde2b39d210574f1f475818a
```

每个宿主安装后的 390 个 dist 文件逐项与构建结果一致，typecheck 通过。package/lock 的本轮差异仅内核依赖 spec、resolved 和 integrity；旧 vendor 包与其他改动保留。安装使用 offline/ignore-scripts，无发布或服务操作。安装证据见 `optimization-install-20261125.json`。

共享服务没有重启，**正在运行的进程不保证已加载新包**；用户手动验证需自行重启对应进程后创建新 Run。Desktop、Local Runtime 未安装或重启，只共享已构建内核源码的实现。

仍未完成的验收：同题真实模型 A/B 对照及实际 token/耗时收益；复杂 HR 内容完整性；全部真实 Provider 的服务端 continuation 恢复；大账本扫描开销。若模型持续不承接、有效证据本身增长或协议要求保留，输入仍可能增长，内核不能制造一个看似完整的小状态。新包提供这些边界的可观测输入，不宣称它们已全部通过。

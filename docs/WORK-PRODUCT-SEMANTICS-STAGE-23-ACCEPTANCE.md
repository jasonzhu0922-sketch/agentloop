# 工作成果语义统一：阶段 2、3 验收记录

日期：2026-09-16。范围：可溯源的模型用途/问题声明，以及当前 leaf 的 Runtime 上下文投影。

## 结论与放行范围

- 阶段 2 已实现：事实与模型判断分别保存；用途、诊断、计划动作和解决依据不混为“完成”。
- 阶段 3 已接入新建文件产出 leaf：由 Runtime 每轮重建共享状态，摘要压缩不能抹去事实；完整内容按不可变引用读取。
- 定向测试 51/51 通过（含阶段 0、1 的 28 项、语义 10 项、上下文 7 项、执行策略 6 项）；Kernel 构建通过。
- 隔离 Host 真实模型 A/B 各 3 次及两个控制样本均成功；后续真实模型冒烟 4/4 成功。最后的自定义策略边界修复另经定向测试及脚本化 Host 4/4 验证。
- 较大选定回归集 347/357 通过，10 项失败；Multi Runtime 类型检查仍失败。仅确认本切片的限定范围验证，不宣称全仓全绿、生产部署完成或普遍稳定性提升。
- 本轮不修改 Assessment、终态放行、工具授权或 Recovery 继承；不推进阶段 4—6，不重启现有生产 Host，不触发历史 Run，不暂存或提交代码。

## 阶段 2：事实、判断与待执行动作分层

内部纯模块 `packages/agentloop/src/runtime/work-product-semantics.ts` 消费阶段 1 观察与可选声明，不读写独立业务状态表。

声明格式为正常工具调用回合中的 `<work_product_progress>{"updates":[...]}</work_product_progress>`。
只从 `assistant.committed` 且 `finishReason=tool_calls`、存在工具调用的事件解析；不从工具 stdout 或最终回答提取。
没有声明时用途为 `unknown`，不从扩展名、路径名称、写入脚本或未来意图推断用途/完成。

| 记录 | 必要关联 | 语义 |
|---|---|---|
| role | 已观察的 path、versionId | input / generator / experiment / candidate / unknown |
| issue | issueId、path、versionId、symptom、evidenceToolCallIds | 模型诊断、已尝试调用、待执行动作、open/resolved 声明 |
| resolutionSupport | 声明引用的调用及其实际结果 | none / successful_operation / version_scoped_check，均不证明整体任务完成 |

Runtime 补充 Run、workspace、goal、modelStep、证据水位及声明原文 SHA-256。
目标 ID 包含 Plan ID、Plan version 与 leaf ID，避免将目标修订前后的判断混为一谈。
声明引用必须在其证据水位前可观察，不能凭声明创建文件、修改 bytes/hash 或发布实际交付状态。
只有明确 `replaces` 原声明 ID 才能替换同路径用途或同一 issueId；其他声明继续保留。
文件覆盖后旧用途变为历史判断，当前用途回到 unknown；旧声明 ID 可供显式修订，旧问题不会被静默清除。
非法格式、未知引用、前向引用或缺少修订关系仅拒绝对应声明，不让整个 Run 失败。

`claimedStatus=resolved` 是模型声明；成功调用是操作依据；当前对象版本上的 passed check 才标为版本范围检查依据。
三者都不替代现有 Assessment/TerminalCommitter。其他文件的检查、旧版本检查和失败调用不能提供该版本的检查依据。

## 阶段 3：在事实丢失的上下文边界修复

内部 `WorkProductContext` 接收真实 tool completed/failed/rejected 与 assistant committed 事件；先归约完整适用记录，再选择展示项。
新增 provenance 附加在原事件的 `workProductSequence` / `workProductDeclaration` 中，保留持久化回溯能力，不新增模型审核轮或专用工具。
`loop_observation` 明确表示本 leaf 的观察序号，与数据库 durable seq 区分；不声称等于并发文件修改顺序。

接入条件：`recovery === undefined && fileOutputStep && computer_read_file 已授权`。
范围明确为当前 leaf；授权依赖、原始约束和 Skill 继续由现有 execution context 提供，尚未汇总为跨 leaf/跨 Run 共享事实。
普通问答不注入该块。未授权读完整引用的步骤不启用此切片。显式 Recovery 不继承新状态，此部分留待阶段 5。

每轮模型可见信息包括目标、观察水位、对象与版本、用途、历史用途、检查、问题/诊断、待执行动作及失败历史。
失败历史不自动等于仍未解决的阻塞。模型可以选择有依据的替代动作，不强制唯一 nextAction。
诊断/声明文本标为数据而非指令；模型判断不升级为 Runtime 事实。

共享投影替换重复的 legacy 成果语义块与 frame 的 currentEvidenceState；传统执行反馈仅展示最近失败，完整失败历史保留在共享状态中。
工具目录、推荐工具和完成门槛仍使用原逻辑。自定义策略即使忽略新字段，Runtime 在 ContextAssembler 边界仍注入共享状态，避免关闭旧投影后又漏掉新投影。

内联共享状态上限为 8,000 字符，显式记录对象/问题/失败的总数与省略数量。
完整 snapshot 含观察、语义、原工具结果和声明事件，复用 ComputerExecutor 的内容寻址存储。
通过既有 `computer_read_file` 的 expectedSha256 + characterOffset/characterLimit（每次至多 12,000 字符）按需取回；状态未变化时复用缓存。
大量对象时不承诺全部内联，但必须保留省略计数和可读取的完整引用，不靠扩大工具预览窗口补救。

固定 B fixture 的预算：旧 loop frame 3,711 字符，新 frame 7,721 字符，其中共享状态 5,679 字符、估算 1,720 tokens。
这是 frame 对比，不是全 prompt 的净增量：重复 legacy 状态块同时被移除。完整 runtimeContext 还含现有目标、约束、Skill 等，不能把其字符数误当共享块超限。

## 确定性验证

- A/B 实际 `runAgentLoop` 模型输入在小工具预览下保留已有文件、脚本、实验用途、错误依据和待执行动作；声明不增加专用模型回合。
- 80 个文件观察后追加 80 个无关结果，预算保持有界；通过实际 ComputerExecutor 分窗、校验 SHA-256 读回完整 snapshot。
- 实际触发 ContextAssembler 压缩，故意让模型摘要遗漏全部产物；新 Runtime frame 仍保留产物与完整引用。
- 无声明、坏声明、无 emit sink、自定义旧策略均有回归；不用跳过失败来获得通过。
- 同一格式的实验/候选保持不同用途；覆盖、删除、修订、水位、来源作用域、解决依据均有纯函数测试。

```sh
node --test --test-isolation=process packages/agentloop/tests/work-product-observations.test.ts packages/agentloop/tests/work-product-replay.test.ts packages/agentloop/tests/work-product-semantics.test.ts packages/agentloop/tests/work-product-context.test.ts packages/agentloop/tests/step-execution-strategy.test.ts
node --test --test-isolation=process packages/agentloop/tests/execution-context-policy.test.ts packages/agentloop/tests/step-execution-strategy.test.ts packages/agentloop/tests/agent-loop.test.ts packages/agentloop/tests/planning-runtime.test.ts packages/agentloop/tests/context-assembler.test.ts packages/agentloop/tests/work-product-observations.test.ts packages/agentloop/tests/work-product-replay.test.ts packages/agentloop/tests/work-product-semantics.test.ts packages/agentloop/tests/work-product-context.test.ts
npm run build:kernel
npm run typecheck --workspace agentloop-multi-runtime
```

较大回归当前失败名称均在阶段 0 基线已有记录：agent-loop 的 artifact progress policy、execution-context 的 global source semantics，以及 planning-runtime 的 visible spreadsheet、structured dependency、Skill QA、conversation admission、presentation Skill 路径、OutcomePlan contract、large source receipts、structured upload extraction，共 10 项。
未修改这些失败断言，命令仍诚实返回失败。当前范围总计 357 项，347 通过、10 失败、无跳过。
执行期间工作区有其他 checkpoint/recovery 实现和测试持续变化，中途曾出现 17 项失败；最终结果仅代表最后测试快照，不能将失败数减少归因于本切片，也不能声称前后为同一干净基线。
类型检查错误为 `tests/multi-runtime.test.ts:56 TS2305`：`local-runtime-tools.mjs` 的 `requiredLocalRuntimePythonModules` 缺少匹配 `.d.mts` 导出声明，本轮未修改该问题。

## 隔离 Host 与真实模型观察

脚本：`apps/agentloop-multi-runtime/scripts/work-product-stage23-probe.mts`。
每批启动真正的 AgentLoopRuntimeHost/HTTP 服务，使用新临时 DB、workspace 和随机 loopback 端口，经 RunService、现有 Assessment 和终态链执行。
不注册到生产 Router。固定 Planner 将变量限定在执行上下文，`--live` 在确定性初始现场之后调用配置默认模型 `gpt-5.6-terra`。

```sh
npm run build:kernel
node apps/agentloop-multi-runtime/scripts/work-product-stage23-probe.mts
node apps/agentloop-multi-runtime/scripts/work-product-stage23-probe.mts --live
node apps/agentloop-multi-runtime/scripts/work-product-stage23-probe.mts --live --repeats=1
```

A：已有 draft 目标文件与尚未执行的 finalize 脚本，续做必须保留标题/条目并得到 final 内容。
B：生成器 API 不兼容、已有实验文件且命令失败，续做必须修复生成器并交付目标文件，不能拿实验文件充当目标。
控制：无文件的 2+2 普通问答，以及正常创建/检查 control.json。
这是保留原故障语义的合成 JSON 任务，不是原 PPTX/字体完整链路复现，不证明历史空响应或恢复按钮已修复。

| 批次 | 结果 | 说明 |
|---|---|---|
| 初始脚本化 Host | 4/4 | 无真实模型调用 |
| 真实模型三次重复 | 8/8 | A/B 各 3 次，加两个控制；均内容正确且完成终态 |
| 后续真实模型冒烟 | 4/4 | 增补历史用途、Plan version、失败历史措辞后复验 |
| 最终脚本化 Host | 4/4 | 最后自定义策略边界修复后；核对 Plan、Assessment、Outcome |

真实模型主批次的 A 三次分别用了 3/3/3 次 live 调用、7/7/6 次工具调用；B 为 3/4/3 次 live 调用、6/6/6 次工具调用。
对应输入 tokens：A 26,901 / 26,949 / 26,891；B 31,267 / 39,894 / 30,410。
B 两次主动发表有效用途/问题声明，另一次没有声明仍完成任务；声明保持可选，不能保证模型每次都写。

后续真实模型冒烟：

| 场景 / Run 前缀 | live 调用 | 工具调用 | 输入 / 输出 tokens | 相同请求重复次数 |
|---|---:|---:|---:|---:|
| A / dabb21e9 | 4 | 7 | 36,649 / 555 | 1 |
| B / 124c49af | 3 | 6 | 31,384 / 605 | 1 |
| answer / ae3843f2 | 3 | 0 | 7,307 / 185 | 0 |
| file / 3cce9e60 | 3 | 2 | 25,982 / 176 | 0 |

这四次均有 completed Plan、approved Assessment 和 `Outcome=completed / plan_assessed_and_completed`，并独立核验文件内容；answer 未启用共享块。
重复请求按工具名和参数完全相同计数，包含修复后重跑相同命令，不能直接当成无效探索。没有“关闭本功能”的真实模型对照组，不能宣称降低 token 或统计性提高完成率。
最后的 Runtime 注入边界改动仅额外跑了脚本化 Host，没有再次消耗真实模型预算。

四批精简结果与最终选定源文件/构建文件指纹保存在 [stage23-host-results.json](../packages/agentloop/tests/fixtures/work-product/stage23-host-results.json)。
其中历史批次运行于中间构建；最终文件 hash 不追认历史构建。脚本打印的 kernelIndexSha256 仅为 index 文件 hash，不是整个 Kernel 构建指纹。
完整 DB/workspace 保留在记录中的临时路径以供审计，但不依赖临时目录作为唯一验收记录。

## 改动归属、回退与剩余限制

本切片新增 work-product-semantics/context 两个模块、对应测试、Host probe 和本验收/结果记录。
在 stage 1 observations 中补充观察序号来源；agent-loop 捕获和投影状态；step-execution-strategy 接收新状态；RunService 只新增上述 opt-in 配置块；阶段 1 测试的离线断言更新为“不接入硬性 gate/public export”。
工作区其他已有或并发变更不属于本次成果，包括 checkpoint/recovery、Host 部署依赖、规划/数据库等；不将整个 RunService diff 归入本轮。

回退阶段 3：撤掉 RunService 的 workProductContext opt-in 块即可停止线上接入，保留阶段 1/2 的纯观察与声明解释；事件附加字段可被旧路径忽略，无需迁移历史数据。
旧 hard gate 仍可能有原来的用途推断；本阶段仅修模型可见信息，不借机改变放行结果。
下一步须先审查较大回归和并发变更的整合结果，再决定阶段 4；不自动扩大到跨 leaf 继承、Recovery 调度或 UI 恢复按钮。

# Vercel AI SDK provider 接入与验证

日期：2026-11-10。状态：源码已统一接入并完成构建、契约与百炼真实验证；未重启或替换运行中的 Desktop，未发布安装包。

## 接入结果

AgentLoop 的 `ModelAdapter` 现在直接调用 AI SDK provider 的公开 `LanguageModelV4.doGenerate()` / `doStream()`。没有引入 `ai` 主包、Gateway、独立代理、SDK Agent 或自动多步工具执行。

- Chat Completions：`@ai-sdk/openai-compatible` **3.0.87**，显式 `.chatModel(modelId)`。
- Responses：`@ai-sdk/openai` **4.0.111**，显式 `.responses(modelId)`。
- 公共类型：`@ai-sdk/provider` **4.0.37**。
- Schema 依赖：`zod` **4.6.7**。
- 原始响应边界的 SSE framing：`eventsource-parser` **3.1.1**。

版本已写入 kernel dependencies，根 lockfile 锁定完整依赖树。未引入 Alibaba 专有 provider；当前百炼 DeepSeek 的 `enable_thinking`、`reasoning_effort` 等已有配置使用通用 Chat provider 传递。

```text
Planner / Executor / Assessor / Recovery / Steer
  -> 现有 ModelAdapter
  -> 公共 prompt / 预算 / 超时 / 重试 / 回执策略
  -> LanguageModelV4 doGenerate / doStream
  -> SDK provider
  -> 同一条保留原始证据的 fetch 响应流
  -> 上游模型
```

`OpenAICompatibleModel`、`ResponsesModel` 的公开名称和 options 保留，registry 和调用端无需改变。现有 provider key、model key、protocol 和密钥配置继续使用。SDK 不执行工具、不修改 Run、不做验收或终态提交。

## 代码边界

| 文件 | 职责 |
| --- | --- |
| `packages/agentloop/src/runtime/models.ts` | 两个公开 adapter 的共同实现；Invocation/SDK 映射、响应和事件桥接 |
| `runtime/model-provider-options.ts` | 原有公开 options 与按模型 profile、Run 隔离的私有推理 continuation store |
| `runtime/model-provider-policy.ts` | 从原实现提取的预算、超时、重试、错误、工具参数有界解析与回执策略 |
| `runtime/model-provider-transport.ts` | 单次上游请求、原始字节取证、协议表示规范化；文本/推理/工具输出由 SDK 解码 |
| `tests/ai-sdk-provider-contract.test.ts` | 新增迁移边界回归；已加入 Kernel 常规测试入口 |

已删除原来的两套完整供应商流内容解码实现。生产没有旧 adapter 回退路径。没有根据模型名或域名选择兼容逻辑。

## 保留的兼容契约

1. **外部工具 Schema 保持原始约束。** Responses SDK 会移除部分 `propertyNames`、正则 lookaround；传输公共边界恢复原始 Schema 和 strict，防止约束静默放宽。Runtime 自有 Schema 之前的标准 `anyOf` 修复继续保留，SDK 本身不会修复此前的 Schema 400。
2. **显式配置优先。** 保留 vendor 参数、planner thinking、toolChoiceMode、sampling 及隐藏推理语义。Responses 的 effort/summary 由已有配置决定，避免 SDK 模型目录吞掉自定义代理模型的推理配置或新增默认 summary；继续不发送 Responses sampling 字段。
3. **工具执行仍由 Runtime 决定。** Chat 完整调用暂存到正常流终态后才发布 ready；length、error、截断不发布 ready。Responses 保留逐项参数完成后的 ready。没有原生 call ID 的调用不得由 SDK 补 ID 后授权执行。SDK 自动展开的 parallel wrapper 恢复成上游原始意图，交 Runtime 验证。
4. **同一个响应只请求一次。** Responses 流请求收到 HTTP 200 JSON 时按实际表示选择解码；终态 snapshot 用同一个 SDK provider 离线解码已有 envelope。离线 fetch 只返回内存中的响应，不产生第二次上游请求。
5. **取证先于规范化。** 原始 bytes、SHA-256、网络块数、异常捕获均在改写前记录。对象工具参数可规范化成协议字符串；缺少最后空行的 SSE 尾事件保留解析，并明确记录异常。未知事件仍计数并捕获原文。响应流不使用无界 clone/tee。
6. **保留单一重试权威。** 由现有 adapter 策略重试，SDK provider 不增加重试；输出后不自动重放。HTTP 400 仍沿用原有重试契约，没有借接入改变全局策略。请求等待、流空闲、总时长、取消和累计输出预算保留。
7. **推理续接保持私有隔离。** 密文 continuation 按 profile + Run 存储、受大小限制；远端 store 策略未改变。Chat reasoning 继续随工具历史续接，隐藏只影响公开展示。
8. **失败证据保真。** Runtime/sink 的首个消费错误优先于传输预读错误。流结束后发生 continuation 拒绝仍能重建原始回执。HTTP 错误读取有界，事件和错误中的反射密钥脱敏。

## 自动化验证

- 模型与 registry/config 共 **106 项**，包含新增 **10 项** SDK 迁移契约；全部通过，已纳入 Kernel suite。
- Unit suite：**276 通过，0 失败**。
- Kernel suite（沙箱外执行）：**397 项，393 通过、2 失败、2 条环境条件跳过**。
- 两条失败均为 `run-service-language.test.ts:292` 的意图解析测试。将接入前备份的 `models.ts` 放入隔离源码副本后，同样复现这两条失败；它们使用测试替身模型，没有进入 SDK。保留工作区原有实现和测试，未为迁移改写断言。
- 沙箱内 Kernel 的命令隔离测试触发 Node 26 原生崩溃；沙箱外同一测试为 **4 通过、2 条环境条件跳过**。最终 Kernel 结果使用沙箱外运行。
- kernel TypeScript `--noEmit`、正式 build、`git diff --check` 通过。

新增测试覆盖外部 Schema、对象 arguments 与原始哈希、工具截断不执行/不重放、原生 call ID、parallel 意图、JSON 不重发、未知事件原文、终态后 continuation 拒绝的回执、idle timeout、错误凭据脱敏。原有 tests/models.test.ts 的调用契约断言保留。

日志位于 `/private/tmp/ai-sdk-{model-tests,contract-final,unit-final,kernel-final,build,typecheck}.log`。独立模型日志与最终 Kernel 均已包含全部 106 项模型与配置测试。

## 真实百炼验证

只读读取隔离测试账户的现有模型配置；密钥只在内存中解密使用。所有 Run 写入新建的临时数据库，没有修改历史账户库或执行外部有副作用工具。沙箱 DNS 返回 ENOTFOUND 后，在允许联网的环境完成请求。

| 模型 | 完整 Runtime Run | 推理开/关各两次工具续接 | 真实 Assessor 通过/拒绝 |
| --- | --- | --- | --- |
| `deepseek-v4-pro` | completed，规划/执行/验收均成功 | 两种模式均三轮完成，输出 `alpha beta` | approved=true / approved=false，均符合预期 |
| `deepseek-v4.1-flash` | completed，规划/执行/验收均成功 | 两种模式均三轮完成，输出 `alpha beta` | approved=true / approved=false，均符合预期 |

两条完整 Run 均存在 `terminal.delivery_committed`、`run.completed`，持久化 outcome 为 `completed / plan_assessed_and_completed`。没有模型请求失败或 HTTP 400。

- Pro Run：`b08eb26f-478c-450f-928a-b34410da127a`。
- Flash Run：`e8196e2e-6d2f-455f-a6aa-c86556f62576`。
- Pro 通过/拒绝验收 request ID：`7ecf2f90-ba5b-90ee-a0b5-01ffb65e3a18` / `8ca59841-cea4-94b8-b53f-6faad8ec653a`。
- Flash 通过/拒绝验收 request ID：`d61a20c5-589a-97bf-b08d-ac57a9401df7` / `cdfc9388-18b1-9f43-a82a-f326360d11ba`。

推理开启时三轮均返回 reasoning；关闭时均为零。两次工具调用均有原生 ID、参数和 ready，且按回执续接后正常收敛。拒绝验收返回结构化 failedBoundary，没有用“通过”隐藏错误输出。

证据：`/private/tmp/ai-sdk-live-results.jsonl`、`ai-sdk-live-network.log`、`ai-sdk-live-tools.log`、`ai-sdk-live-assessment.log`；脚本为 `/private/tmp/ai-sdk-live-probe.mjs`。JSONL 保留了初次沙箱 DNS 失败及之后成功的各次结果。

当前账户仅配置百炼 Pro/Flash。Responses、自定义 Chat 的真实请求尚未验收；它们的 Schema、参数、JSON/SSE、工具调用、推理续接、错误和重试由模拟协议回归覆盖，不能将这些测试算作其他供应商真实验收。

## 打包与加载边界

- 以真实 `runtime/models.ts` 为入口生成 ESM/CJS bundle，约 **1.47 MB/份**（未压缩），两种格式的 Chat 和 Responses 均加载并完成假响应调用。
- 实际调用 Desktop 的 `copyRuntimeDependencies()`，递归复制 kernel 及依赖到 `/private/tmp/ai-sdk-desktop-copy`，确认全部新增依赖进入 inventory；从该目录独立加载两种 adapter 并完成假响应调用。
- 完整 Local Runtime 入口 bundle 被现有 `playwright-core` 对两个 `chromium-bidi` 模块的未解析依赖阻断。对接入前 models.ts 做同入口构建也得到相同两条错误；本次未修改无关浏览器依赖或通过 external 标记隐藏缺包。
- provider 依赖、打包复制和 adapter 加载验证通过，不等于完整 Local Runtime SEA、Windows/macOS 安装包或已安装 Desktop 验收。没有生成、签名、发布或安装新包，也没有重启用户正在使用的程序。

第三方依赖与许可证记录已补充到 `packages/agentloop/THIRD_PARTY_NOTICES.md`。

## 排摸来源

接入前的 27 项隔离原型位于 `/private/tmp/agentloop-ai-sdk-audit-20261110/`，用于确认 SDK 发布包中的实际行为，不能单独视为迁移验收。其中发现的对象参数、SSE 尾事件、Responses JSON、外部 Schema、推理能力推断和工具截断问题已在共同边界处理并加入回归。此文的验收结果来自上述正式接入后的测试与真实请求。

## 后续 Run fd2c1671：能力证据与恢复提案修复

检查对象为开发模式 `/tmp/agentloop-desktop-goal-loop` 的实际账户 `runtime.db`，不是 sibling runtime 的 `agentloop.db`。原 Run 为 `fd2c1671-32ea-448e-8396-f8ec3eb144d9`，用户输入是“你有什么能力？”。读取使用只读连接，原 Run 未被修改或重试。

持久化因果链：

1. seq=2/3 已创建 run_authorized / runtime_configured 快照；本次 sources 均为空。
2. 执行阶段通过 `runtime:available-skill-catalog` 收到了 11 个已注册 Skill 的描述。
3. 能力 scope 仅由原始输入的词汇匹配决定。普通问句没有显式范围词，导致快照未传入执行/验收；Skill 清单也只进入执行 prompt，未进入 Assessor。
4. seq=90 验收拒绝，反馈明确缺少 runtimeCapabilitySnapshot 和同一份能力证据。
5. seq=100 后续恢复规划收到百炼 HTTP 400，错误体明确为 `grammar validation or compilation failed: sandbox grammar compile timed out`，request ID 为 `716c2ef4-b062-9f9c-9552-53a3a08c92b2`。只发生一次 retry，后续两次规划 Action 均 succeeded；不是持续 HTTP 400 直接结束 Run。
6. seq=143 最终失败为本地 `PLANNING_ERROR`：恢复提案提交了禁止由模型生成的 `delivery_target:runtime_capability_overview` 条件。旧恢复上下文直接提供完整的 admitted criteria，模型可以抄回 Runtime 派生字段，而提案 parser 明确禁止这些字段。

本次修复：

- 所有 reply 继续携带描述性 Skill 元数据，并始终获得明确标注为 run_authorized 的本次快照；显式请求更广范围仍只使用对应 host 快照，缺失时不替代为本次授权清单。没有增加自然语言关键词或供应商分支。
- 新增 `StepAssessmentInput.runtimeSkillCatalog`，执行与验收共享同一份 id/name/description 投影；激活的 `skills` 和注册元数据保持独立，元数据不授予工具、凭据或执行成功证明。评估复用 signature 同步纳入该元数据。
- Recovery 的 currentPlan 现在是提案可编辑投影。Runtime 派生验收项保留在 `runtimeDerivedSuccessCriteria` 供观察，不进入可提交的 successCriteria；basis 只投影模型可提交字段。完整原 Plan、目标绑定和 canonical provenance 均保留，Admission 单独重建派生义务，原 parser 拒绝规则继续生效。

新增 4 项回归在旧实现均失败，修复后通过。定向能力/恢复/Planner 测试 **73/73**；最新 Unit **277/277**；Kernel **400 项，396 通过、2 条原有失败、2 条环境跳过**。类型检查、正式 kernel build、diff whitespace 检查通过。

真实验证：

- Pro 对原 Run 的只读恢复上下文返回 `revise_plan`，模型返回提案通过 parser，未提交 delivery_target 派生条件，且无重试。request ID：`0685e28f-c89f-9e30-a693-d50fe5cb5139`。提案没有执行，也未声明已通过 Plan Revision Assessor/Admission。
- 新隔离 Run `b95714da-600d-45a7-8c34-b09e1cef05a0` 使用原来的 11 个 Skill 包（只读发现），同问“你有什么能力？”；真实 Pro 首次 Assessor approved=true，最终 completed，工具派发为 0。证据库：`/private/tmp/fd2c1671-capability-fixed-1794296260917.db`。
- 该完成 Run 仍发生一次 planning HTTP 400 后成功重试，request ID 为 `d75b08c9-e7ea-9aa6-9088-5070802fe0fa`。此测试 reporter 仅保留 status/request ID，不能据此断言该次错误体也一定是 grammar timeout。供应商偶发 400 尚未消除；没有关闭 Schema 约束、静默降级或改变其他模型的重试契约。

原事件副本：`/private/tmp/fd2c1671-events.json`。新验证脚本和结果：`/private/tmp/fd2c1671-sdk-verification.mjs`、`fd2c1671-live.log`、`fd2c1671-live-capability.log`、`fd2c1671-live-results.jsonl`。首轮测试建内联 Skill 时遇到其 500 字描述限制，因此正式验收改用只读发现原包；失败尝试未调用模型，也未修改原包。

上述修复已写入源码并重新构建；运行中的 Desktop 没有自动重启，原失败 Run 的历史状态没有改写。首次 SDK 接入的真实验证未覆盖 RecoveryPlanner 本身的真实 Schema，这次补齐了恢复提案解析验证，仍不等于恢复提案已执行成功。

最终合并工作区检查：发现另一个正在进行的任务同步修改了 Assessor 的验收规则和相关测试。本次未覆盖或回退这些变更。当前文件的类型检查与 build 通过，本次 4 项新增契约仍全部通过，最新 Unit 为 **281/281**。最新 Kernel 为 **400 项：395 通过、3 失败、2 跳过**：其中两项仍为原有 intent-resolution 测试；新增的一项是 `source-evidence-recovery.test.ts:247` 仍断言 assessment context 包含 `factualSupport`，而并行验收规则修改移除了该 policy 字段。完整 Kernel 目前不能声明全绿。对应日志使用 `/private/tmp/fd2c1671-final-{typecheck,build,contracts,unit,kernel}.log`。

本轮真实 Pro Run 和恢复提案探针运行于本次修复构建；并行任务之后的验收语义改动只做了上述源码回归，没有再次计作真实模型验收。

# 默认当前证据工作集：实现与验收边界

2026-11-25。本轮已实现并构建内核。没有提交、推送、更新消费应用或重启共享服务。**局部生命周期与恢复回归通过；完整自然任务的输入稳定性、模型轮次与业务正确性仍未验收通过。**

## 第一处实际缺口

先前原生工具 schema 要求 `_agentloopContext`，但 `updates: []` 合法；`deriveDecisionWorkingSet` 只有模型明确 carry 才承接正文。`agent-loop` 持续追加完整交换，`ContextAssembler` 最终仍依赖容量摘要。c0bb6860 的 41 次可声明行动和 6a3f4c13 的 26 次可声明行动均为空 updates、零语义条目。手工逐轮预填 carry 的长历史测试无法覆盖这个自然路径。见 [原始 Run 证据与业务错误审查](KERNEL-RUNS-C0BB6860-6A3F4C13-REVIEW.md)。

## 本轮运行契约

复用 CanonicalRunState、CurrentDecisionView、WorkProductContext、Action/Result 和已提交事件；没有新增状态表、历史库或事实写入协议。

1. 正式 Result/checkpoint 提交后，`committedDecisionRecords` 从原事件重建观察。
2. `deriveDecisionWorkingSet` 验证原有语义提议，同时由 `current-evidence.ts` 默认承接适合常驻的精确结果、生产参数、Result 身份和 invocation/operation 状态。空 updates 不再阻止这条路径。
3. `latestCommittedAction` 呈现最新 checkpoint 及正式回执状态。模型条目与 assistantStatement 形成于来源行动执行前，其中“待执行”不得推翻后来的正式结果。未知效果继续明确为 unknown。
4. 当前条目引用的小型精确来源继续保留；模型摘要不成为仅存的来源内容。只读、同工具/参数/正文/模型前置表述/操作状态的重复观察合并为一份，保留次数与最新入口。不同范围、窗口、版本、错误和写操作不按值合并。
5. 内核读取回执的 path/hash 与权威当前产物对应、已有后续行动消费、当前 hash 确实不同且没有当前依赖时，旧读内容可退出。文件删除本身不证明旧内容无关，历史不等于问题解决。
6. 为下一轮重新装配。`_agentloopContext` 改为可选，仅承接改变的语义判断；仍校验证据、范围、revision 和解决依据。无独立维护模型、维护工具或回答前清空 pending 的要求。模型解释不升级为领域事实、授权、产物验收或任务完成。

单个正文超过既有 `largeToolResultProjectionCharacters` 或总量超出预留预算时，留在 native 消息，继续原来的首次消费保护、内容窗口和容量保护；不重新展开并永久钉在固定工作集。批内一项退回时整批保留配对，避免两通道重复常驻。预算决定输入通道，不决定事实是否成立。

## 历史、阶段与协议

历史仍由原 Action/Result/checkpoint 持久化，通过授权的 `read_result`、`producer_exchange`、`step_history` 和窗口精确重取参数、正文、旧版本。历史索引不是原文消费证明，不能授权重跑副作用。

自动释放 native 交换要求 adapter 明示 releasable、存在授权历史 reader、完整批次、唯一有效身份与已知效果。reasoning、opaque provider、未知效果、失败写入、不完整批次和身份歧义继续保守保留。Responses 加密 reasoning 的 retain 策略不变。取消/重启不删除正式记录、不改变 Action 重放权限。

执行和评估共用 `evidence-context-projection.ts` 无损编码，复用既有同块 JSON Pointer 引用。仅展开 JSON.stringify 可精确还原的 JSON；命令 JSON streams 可共享并记录前后空白及 SHA-256。重复键、不可逆数字表示和普通文本保留原文，正式 Result 不变。

评估排除明确历史内容，但当前问题、绑定依赖、未知效果、失败调用和明确重开的历史仍可强制纳入；执行 pruning 不决定评估事实。恢复使用同一 reducer 与较小内容预算，保留失败边界/未知效果；规划继续使用 Canonical 与当前产物的职责视图。Plan Admission、HIL、终态提交和产物验收权限未改变。

相关保真修复：`computer_read_json` 对能放入现有读取窗口的深层对象返回精确选中值，避免深度 4 后变成类型摘要。query.complete 明示选区完整性；更大的受限对象仍有 caveats，遗漏细节须用更窄的源 selector 取得。数组窗口保留范围和 nextOffset。

## 固定真实事件对照

脚本 `scripts/replay-current-evidence.mjs` 使用安装旧 dist 与当前源码的 SHA-256、同份私有事件导出哈希、相同目标/当前视图/reader/2,000,000 token 容量，排除容量摘要干扰。未调用模型、工具或业务查询。这是组件对照，不能当完整宿主重执行或实际 provider tokens。

| Run | 累计字符：旧 → 新 | 变化 | 最后一轮：旧 → 新 |
| --- | ---: | ---: | ---: |
| c0bb6860，43 次决策 | 10,080,305 → 9,120,037 | -9.53% | 392,021 → 331,872 |
| 6a3f4c13，28 次决策 | 4,616,488 → 3,640,090 | -21.15% | 307,331 → 228,422 |

中途曾将一份约 32 万字符的读取重新完整展开，造成 c0 回退约 48%。仅无损去重不足，随后修正大正文迁移边界。没有把消息减少当作优化成功。

新版真实片段第 10→16 次决策，c0 字符仍从 108,281 增至 145,617，6a 从 92,741 增至 145,116。存在新增且未证明无关的证据，不能强行按“已解决”删除。**真实片段尚未证明自然任务已达到稳定工作集目标。**

报告：`verification/host-working-set/exact-evidence-frozen-runs-20261125.json`。

## 已解决历史增加 60% 的离线验证

固定目标/配置、adapter 禁止维护模型调用，不由测试逐轮预填 carry：

| 场景 | 100 → 160 次时输入字符 | 保真要求 |
| --- | ---: | --- |
| 空 updates，同一不可变选择的重复读取 | 9,875 → 9,876 | 原值、窗口缺失、范围未知和次数保留 |
| 权威当前 hash 替代的旧版本读取 | 10,066 → 10,067 | 新版本验证正确绑定；未解决问题引用的旧来源仍保留 |

重复读取旧 canonical 路径为 301,640→499,305 字符。其他既有语义 carry 测试单独保留，不能混为自然行为证据。8 次顺序读取的空 updates 确定性回放，新旧均 9 次模型调用、0 历史读取并正确完成。

## 真实隔离 Provider 回放

同一 `synthetic-sequential-v1`、8 个链式只读合成观察、deepseek-v4-flash 配置。每份报告有版本/配置哈希；原始事件仅写私有临时文件。未访问业务源。sandbox 内首次不可达，放开网络后的结果如下。

| 版本 | 执行正确 | 模型调用 | 业务读取尝试 | 历史读取 | 实际 input/output tokens | 耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 安装基线 | 是 | 9 | 8 | 0 | 59,885 / 2,945 | 16.674s |
| 中间版本 1 | 否，额外尝试 inspect | 11 | 9 | 1 | 78,569 / 2,311 | 16.836s |
| 增加正式行动边界 | 是 | 11 | 8 | 2 | 75,985 / 1,516 | 16.373s |
| 当前版本，保留当前精确来源 | 是 | 10 | 8 | 1 | 77,912 / 1,537 | 13.216s |

当前样本耗时下降 20.74%，但 input tokens 增加 30.10%，调用增加一次。最后一次 read_result 在模型已说无需更多调用后发生，仍是未消除的多余读取。不能报轮次优化通过，不能为减轮次禁止历史读取或硬编码第 8 次行动就是终点。

cacheReadInputTokens 仅部分响应提供：基线已报告 8,192、新版 7,040，各有一轮未提供，不是完整缓存总量。字符、估算 tokens、provider usage、cache、账单分开，没有推算费用。报告位于 `verification/host-working-set/exact-evidence-live-{baseline,current,current-attempt2,current-attempt3}-20261125.json`；中间失败保留。

## 验证与剩余工作

- build、TypeScript、diff --check 通过。14 个相关文件 329 项通过，覆盖多领域内容、历史、真实循环、HIL、恢复、取消、Provider 工具协议与 continuation。JSON 读取专项 3 项通过。
- 扩展 unit 为 345/346，剩余 TiDB schema migration fixture 断言与实现不符，两文件均非本轮修改。
- 扩展 kernel 在最终小改前为 699/703；no_progress 的 STEP_NOT_COMPLETED/RUN_LIMIT_EXCEEDED 断言差异在安装旧 dist 也复现。另三个文件进程在 Node 26 execution_async_id 原生断言终止，单独串行仍复现，原因未确定，不计通过。
- computer-tools 的 append 缺失目标、visible directory 权限和 aggregation coverage 三个失败均用旧 dist 复现；新 complete 字段的断言已更新，JSON 专项通过。
- 没有给 data-agent/report-agent 更新本轮包或重新执行真实业务题。c0 的跨公司补充值错误尚未证明根治。
- 不同、仍当前且缺少可信生命周期依据的证据仍可增长。身份/hash 无法证明模型语义 carry 充分或业务结论正确。本轮改善默认承接与时序保真，尚未完成所有自然任务的稳定工作集与轮次验收。下一项未完成工作是验证模型能否基于当前已充分证据正确收束，不能用压缩阈值、禁止读取或内核推断业务完成代替。

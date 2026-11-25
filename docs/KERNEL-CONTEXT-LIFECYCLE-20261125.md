# 当前上下文的内容生命周期与证据绑定

后续默认精确证据承接、正式行动时序及真实回放结果见 [当前证据工作集实现与验收边界](KERNEL-CURRENT-EVIDENCE-20261125.md)。本文保留前一轮实现与测量。

2026-11-25。这一轮在既有 committed-context 实现上继续优化，默认仍是：目标 → 当前状态 → 当前产物 → 历史提示 → 决策与行动 → 更新状态。产品尚未上线，直接采用唯一新契约，不维护旧状态声明兼容分支。

**内容交付和状态身份回归已通过；普遍提速、真实业务正确性及不增加模型轮次的验收尚未通过。** 没有提交、推送、重启服务或重新执行原业务问题。真实模型测试仅使用两宿主冻结配置和隔离合成工具。

## 首个内容丢失边界

此前已完成从已提交事件派生工作集，而非仅从 Provider transcript 取语义状态。继续核对 `80fbadfc` 发现：action 7 已读取所选 JSON，但 request seq 227 前的装配受合并值预算影响，5 个选中值只实际交付 4 个；下一次行动又读取同一列定义。`496dbd17` 也有一个刚读取的选中值在下一决策中消失。

问题在 `ContextAssembler` 的正文投影边界：读取成功、Result 身份正确，并不意味着模型实际收到所选内容。最新完成读取中的必要内容不能因为整个 envelope 较大就先变成目录。

现在 `computer_read_json`、`computer_read_file`、`read_result` 最新完成批次中的明确读取内容必须交付给下一次决策。该条件由持久化 transcript 顺序推导，无进程内 seen 缓存。超出模型容量时显式报告无法满足必要输入，不静默删值。消费后仍按既有版本/窗口生命周期投影，并由显式语义承接决定完整交换能否退出常驻输入。

只读组件回放检查 496 的 10 个、80 的 9 个真实请求，各恢复 1 个被遗漏值。80 对应请求的工具消息字符从 92,789 增至 100,852：这是修复必要内容交付，不是输入降幅。回放不迁移旧状态声明、不发模型请求、不运行工具，不能据此宣称完整业务耗时下降。

证据：[read-delivery-20261125.json](../packages/agentloop/verification/host-working-set/read-delivery-20261125.json)，脚本 `packages/agentloop/scripts/replay-context-read-delivery.mjs`。

## 唯一状态契约与单一真源

权威仍是原用户输入、CanonicalRunState、正式 Action/Result、已提交事件、WorkProduct 版本与验证、HIL 和决策 ledger。没有新增状态表、历史库、授权来源或独立摘要模型。工作集是这些证据的可重建投影。

正常工具调用中只有一个更新入口：

```json
{
  "_agentloopContext": {
    "updates": [{
      "id": "stable-subject",
      "category": "observation",
      "text": "当前任务需要的实际内容、来源范围与限定条件",
      "scope": "适用对象、范围与时效",
      "certainty": "observed",
      "evidence": ["@e1"],
      "disposition": "carry"
    }]
  }
}
```

`category` 区分 observation / inference / unknown / conflict / decision / commitment。`observed` 是模型对证据的解释，不能授权、扩大目标、关闭 Canonical gap、验收产物或提交任务完成。

`carry` 明确承接所引证据中下一决策需要的内容，`retain` 保留原始正文。只发送变化；同主题同范围复用稳定 id，避免把步骤日志改名为当前状态。空 updates 保留未承接证据。工具 schema 不支持元数据或宿主已占用字段时，不注入、不剥离，也不释放相关历史。

模型不再填写 `status`、`replaces`、`absorbs`。旧字段拒绝，正文中的 context progress 不再解释为状态更新。派生条目仍有内部 active/resolved 和 supersedes，用于生命周期表达，不是第二套模型输入协议。

同 id 更新用请求发出前冻结并提交的 `contextItemRevisions` 做并发校验；过期或未展示的版本不能覆盖当前条目。可选 `resolves:[当前条目 id]` 明确退役旧观察或解决未知，要求新增成功证据、请求展示的 revision 和相关已观察产物版本全部有效后原子应用。可以同 id 解决旧 unknown，留下当前 finding。工具成功本身不能自动解决领域问题。

## 证据身份绑定

真实合成回放曾发现模型引用真实 `rr_...` Result ID，但旧字段期待 ToolCall ID，导致有效引用被拒绝。现在模型只面对 `evidence`：可使用当前请求公开的短引用、精确 Result ID 或精确 ToolCall ID。

短名来自正式观察序号，不是新身份库。内核在请求前冻结唯一绑定；checkpoint 只持久化本次实际引用的别名及标准调用身份，避免每轮把所有历史身份复制进 checkpoint。歧义 Result、与调用身份冲突的别名、未来、未提交、跨 Run/Plan/Step 和伪造引用不接受。恢复使用原请求绑定，不拿恢复时的新视图猜测旧引用。

这只证明身份、版本、来源和生命周期一致性，不证明模型文本与证据在领域语义上必然一致。仍需 Agent/Skill 和既有评估负责判断。

## 行动、历史与各阶段

一次行动先提交正式结果与事件，由原 WorkProduct reducer 更新版本和验证绑定；下一次正常决策可将刚取得的证据承接进稳定条目，并同时发出下一行动。随后 assembler 从同一已提交记录重建工作集，不调用独立维护模型。

任务可以交付时直接回答，待处理回执可直接消费，无需补做状态更新。元数据拒绝只产生非阻塞诊断，不成为新的业务义务。

完整交换只有在内容被明确承接、结果效果已知、Provider 允许释放、工具调用完整配对且有授权历史入口时才退出常驻输入。原始正文与 checkpoint 始终保留。失败写、未知效果、未完成批次、Skill 正文及必要 reasoning/continuation 继续受原协议限制，不能因为输入被投影而重放副作用。

历史复用 `read_result` 的 Result 正文/窗口、`step_history` 索引和 `producer_exchange` 精确交换。按需读取缺少的细节、旧版本或结论依据；读到的正文先交付下一决策，再按相同契约承接。引用不能代替必需内容；未知效果不能解释为未发生。

规划、执行、恢复、评估继续消费 Canonical 当前状态和相同证据体系，根据职责选视图。评估使用当前有效条目、候选和必要原证据，必要时按原 grant 审计读取；不先复制完整执行史。恢复从正式事件重建条目、原请求身份绑定和原生 continuation。Plan Admission、HIL、授权、产品验收和终态提交的权威边界未改变。

## 回归与测量

冻结基线是本轮开始时完整源码的构建快照，包含此前已授权的脏工作区改动，**不是 git HEAD**。38 个真实模型样本（包括全部中间失败/退化样本）保存在脱敏聚合 [context-lifecycle-20261125.json](../packages/agentloop/verification/host-working-set/context-lifecycle-20261125.json)。聚合不含模型正文、工具正文或凭据，保留源码/配置 hash、各轮 composition、实际 usage、cache、时长、历史读数与可用的动作审计。

字符、估算 tokens、实报 provider tokens 分开记录；cache 字段可能缺失或与输入总量重叠，不相加推算账单。不同中间契约不能混作最终版本样本，缓存和部分并发样本也不能用来证明因果加速。

| 宿主配置 | 冻结基线 3 次模型轮数 | 基线输入 tokens | 最终唯一原生入口轮数 / 输入 / 时长 | 严格执行结果 |
| --- | --- | --- | --- | --- |
| data-agent | 9 / 15 / 9 | 57,689 / 95,878 / 58,799 | 9 / 58,374 / 19,516 ms | 精确内容、8 次有序行动、0 次历史读、0 状态拒绝通过 |
| report-agent | 9 / 11 / 10 | 57,311 / 81,692 / 64,448 | 10 / 65,327 / 18,162 ms | 答案检查通过，但尝试第 9 次 inspect，被工具拒绝；严格行动契约未通过 |

最终源码 hash 两者同为 `5e68b1625be10efc550d9a61edd333b6a849c5adca53b72aeee680c2689b67fc`。单次最终样本不证明稳定性能改善。此前还观察到独立虚构 `_agentloopContext` 工具、末轮正文状态标签、已承接值的重新核验、多次失败历史定位和不必要日志条目。未删除这些样本，也没有放松最终输出、证据或效果校验来取得更少轮数。

回放原先 `correct` 主要检查答案和成功观察数，不能证明没有多余/被拒绝行动。现在回放补充独立 `answerCorrect` 与严格 `executionContractPassed`；聚合对有私有事件的旧样本追加 `executionAudit`，保留旧 `correct` 原值而不改写历史。没有私有事件的基线动作审计标为未验证。

| 可重复离线场景 | 100 步 | 160 步（+60%） | 保真检查 |
| --- | ---: | ---: | --- |
| 内容生命周期输入字符 | 6,725 | 6,728 | 精确事实、冲突、未知、用户原文和恢复等价 |
| 事件驱动执行输入字符 | 9,440 | 9,444 | 以最终日志为准；同事件重建 |
| 评估选中证据字符 | 2,180 | 2,180 | 必需原文及未知效果保留 |

上述有界性以有效工作集固定且正确承接为条件，不代表任意模型都能自动生成充分状态。源码的长期工作集测试也检查千步增长、版本替换/删除/重建、来源范围、历史精确读取、HIL、取消、重启、未知副作用、工具批次配对和 reasoning 延续。

最终专项 159/159 通过；kernel 686 通过、4 失败，其中 3 个文件受沙箱限制，同源码脱离限制单独重跑为 67 通过、2 可选跳过、0 失败；余下是既有 no_progress 错误码断言。此前 unit 344 通过、1 TiDB CHECK 迁移断言失败。本轮未修改这些无关语义。`build:kernel` 通过。

可复现命令：

```sh
npm run build:kernel
node --test packages/agentloop/tests/decision-context-lifecycle.test.ts packages/agentloop/tests/decision-working-set.test.ts packages/agentloop/tests/committed-decision-basis.test.ts packages/agentloop/tests/context-assembler.test.ts
node packages/agentloop/scripts/replay-decision-working-set.mjs --sequential --policy current --output /tmp/context-replay.json
node packages/agentloop/scripts/summarize-context-lifecycle.mjs <私有回放目录> <脱敏聚合输出>
```

真实回放额外指定 `--live --config ... --env ...`；只有无预置状态的 `--sequential` 可用于本轮旧 dist / 新源码同题比较，不能把新格式预置状态交给旧内核做兼容性 A/B。

## 仍未完成的验收

不增加实际轮次的验收仍未通过，Report 样本保留了额外行动。不能以 100→160 输入有界或单个正确答案代替这一结论。完整 data-agent/report-agent 业务任务、真实代码工程、外部研究来源、真实产物交付、跨所有 Provider 的服务端 continuation 和大账本读取成本均未在本轮覆盖。原有真实 Run 的归因限制仍见 [496/80 诊断](KERNEL-RUNS-496DBD17-80FBADFC-REVIEW.md)。

## 本地安装记录

两个消费应用已更新为 `file:vendor/zhujun-agentloop-0.1.0-lifecycle-2a6a31a1224c.tgz`，包 SHA256 为 `2a6a31a1224c2a65f7ba29fe1dfdadab44cd01d423fd2cd337152599fca52434`。

逐文件验证两个应用安装的 394 个 dist 文件与本轮构建一致，两个宿主 typecheck 通过。package.json 的变化仅为内核依赖，lock 仅为该依赖的 spec/resolved/integrity；旧 vendor 包与无关改动保留。详见 [安装校验](../packages/agentloop/verification/host-working-set/lifecycle-installation-20261125.json)。

这是供手动验证的候选版本，性能验收状态如上，不能称为业务部署通过。未重启共享服务；运行中的 Node 进程需要由用户先停止再执行 `npm run start`，才会加载磁盘上的新内核。

# 已提交状态驱动的当前上下文：实现与验证

后续契约已收敛为唯一原生参数入口；本页保留当时实现与测量。最新变更、验证及未通过边界见 [内容生命周期优化](KERNEL-CONTEXT-LIFECYCLE-20261125.md)。

2026-11-25。本轮落实语义输入、Provider 延续和评估选证据之间的架构解耦，更新 data-agent、report-agent 的本地内核包供手动验证。没有提交、推送或重启共享服务。**这不是完整业务验收或普遍降本结论。**

## 第一处缺口及修复

原 `deriveDecisionWorkingSet` 从 `ModelMessage[]` 找完整原生交换，再接受其中的上下文提议。实时循环会去掉 prepare-rejected 的原生调用；恢复曾重新放入这些调用。相同正式记录因此产生不同语义状态。b79ee9ca 的离线原记录复现为实时 8 项、恢复 10 项。

新路径：

```text
CanonicalRunState / 原用户修订 / HIL / Action 与 Result / WorkProduct
    ↓ 同一已确认提交的 checkpoint、观察与请求基准
committedDecisionRecords → deriveDecisionWorkingSet + CurrentDecisionView
    ├─ 执行：当前内容与未处理观察 + 单独判定的 Provider 延续
    ├─ 恢复：相同语义投影 + 失败与未知效果边界
    └─ 评估：当前依据 + 明确依赖的原始证据 + 按需历史读取
```

`committedDecisionRecords` 是原事件的可丢弃投影，不新增持久化表、授权来源、历史存储或事实写入 API。`DecisionWorkingSet` 仍是模型判断视图；`observation` 项也不被升级为 Runtime 已验证事实。Canonical、Action、Result、产品检查和终态提交保持原权限。

在四份固定档案上只读重建：b79 的实时/恢复均为 10 项，另外三个样本保持各自的 7/6/5 项。两条 prepare 拒绝仍不进入原生调用配对；语义提议的成立不意味着业务动作发生。

## 一次行动如何影响下一轮

1. 模型请求前冻结已有证据身份；响应中的提议引用只与该请求之前实际已有的证据绑定。只持久化提议引用的交集，不复制不断增长的完整证据清单。
2. 完整 `assistant.committed` 提议可独立校验；同回合动作 prepare 失败或尚未完成不抹除有效提议。截断输出、没有完整最终 checkpoint 的流式半截提议不被接受。
3. 正式结果及事件由既有 sink 确认后，才更新语义投影和 WorkProduct 观察。`WorkProductContext.prepare` 只生成同事件的来源元数据；`capture` 在提交确认之后生效。
4. 会改变状态的事件串行经过 prepare → sink → capture；流式 readiness/planning 通知不等待这条队列，避免阻塞工具调度。
5. 下一轮按新记录重新派生状态，验证证据范围、精确 revision、当前产品版本与问题适用性。当前状态与 Provider messages 不再互相充当真源。

没有增加状态整理模型、选材模型、审计模型或必调维护工具。模型仍通过正常行动响应提出变化。最终回答可以直接使用待整理的正式回执；pending 身份不是回答前必须清空的队列。

## 历史退出与重新读取

- 语义承接仍须明确表达。新原生声明要求显式填写 `absorbs`；`[]` 表示保留。旧 checkpoint 省略该字段继续按 `[]` 兼容，绝不推断其已承接。
- 只有通过来源/版本校验的明确承接，才允许既有完整交换释放规则继续判定。模型判断不能关闭 canonical gap、解决未知副作用或接受产物。
- 释放还要求 adapter 明示支持、存在已授权精确历史入口、完整工具配对、已知效果。reasoning continuation、失败写操作及未知效果继续保守保留。
- `read_result` 的 Result 原文、`producer_exchange`、`step_history` 和窗口能力继续使用原身份与授权。历史索引不算读取原始证据；不会通过重跑动作恢复输出。
- 拒绝的可选上下文提议标为 `taskBlocking:false`，并提供准确的无效字段或 revision 诊断。提议未生效不等于产生新任务义务；旧状态与原始观察保留，不要求为清除元数据错误额外读取历史。

重复调用身份或重复结果的歧义不能任选一个作为来源。请求期间提前完成的同轮结果不能被引用为请求前已知事实。

## 评估与各阶段

规划继续消费现有 Canonical 决策投影、授权依赖与 gap；恢复规划现在直接消费同一已提交语义记录，不再先根据 Provider 可重放消息决定哪些语义存在。

执行装配器的状态输入改为已提交事件。历史消息仍服务 Provider 的原生延续与尚未承接内容，容量压缩继续作为最后的容量保护。

评估在实际候选边界重新派生最新依据，所有候选分支经过同一个选择点。`projectToolEvidence` 保留兼容入口，但不再根据执行 pruning、compaction 或 Provider 必须保留的消息选材。

选择依据包括：尚未承接观察、明确选择的当前产物及对应版本检查、当前问题、canonical open concerns、已绑定依赖和未知效果。已明确承接的来源不会仅因当前项还引用它，就再复制整份原结果。未分类文件保持未分类，不能按名称、扩展名或“还存在”就把整个原始回执选入评估。

已确定需要的验证/产品来源直接携带选中的正式正文，避免已知内容先给引用再强迫额外补读。选中正文不继承执行阶段的截短标记。需要更多原文时，评估仍可通过既有授权、审计的只读 Action 获取。服务端规则评估、证据验证、Plan Admission 与终态提交仍收到完整正式证据。

这不是普遍内容选择问题的终结：任意领域的未知必要窗口仍由模型/Skill 判断；没有新增模型选材器。没有证明所有原生延续都可以释放。

## 验证及测量

以下计数与字符均不等于 provider tokens 或账单。真实 tokens 来自成功响应的 usage；缺失 cache 字段保持缺失，不补成已测量的 0。没有估算账单。

| 验证 | 结果 |
| --- | --- |
| 聚焦上下文、恢复、产物、评估、流式调度回归 | 191/191 通过 |
| 单元全套 | 344 通过，1 项既有 TiDB CHECK 查询断言失败 |
| 内核全套最后一次 | 671 通过；1 项既有 no_progress 错误码断言失败；3 个测试文件受沙箱本机监听限制崩溃 |
| 上述 3 个文件独立放宽沙箱重跑 | 67 通过、2 个可选跳过、0 失败 |
| 内核 build / 两个消费应用 typecheck / diff check | 通过 |
| 真实档案重建 | 四份档案，零模型调用、零工具调用；实时与恢复语义相同 |

新增有意义的断言包括：prepare 拒绝但完整语义提议保留；截断/半流不接受；同轮提前结果不能回填请求依据；重复身份拒绝；持久化失败不发布文件版本；未知写效果独立保留；reasoning 必须保留但评估不重复其安全历史；显式版本检查所需原文直接装入；无需状态维护回合就能恢复完成。已有编码、研究冲突、分析范围、删除/重建、HIL、取消和 Result 授权回归保持通过。

固定内容模拟：已解决步骤 100 → 160（+60%），执行装配字符 **9,375 → 9,379（+0.043%）**，选中的评估证据正文编码 **2,180 → 2,180**。用户范围、值、来源及未知保留，模型调用仍为真正业务决策所需的数量。派生目前仍全量扫描同叶记录，CPU/内存没有被宣称为常数；单次毫秒数受并行测试影响，不作性能结论。

### 隔离真实模型对照

使用两套独立消费应用各自的模型配置，固定配置 hash、任务与八步合成观察；旧版本为 `context-622632a0d730`，最终版本为本页下方包。只访问真实模型，工具和数据在隔离进程/内存中，不访问业务 DB、不启动共享应用。它检验真实模型行为，**不是 data-agent/report-agent 完整业务端到端回放**。

| 配置 | 版本 | 正确性 | 调用 | 历史读 | 实报 input | 实报 output | 墙钟 ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| data | 旧包 | 通过 | 9 | 0 | 56,292 | 2,902 | 16,775 |
| data | 最终包 | 通过 | 9 | 0 | 54,586 | 2,255 | 14,360 |
| report | 旧包 | 通过 | 9 | 0 | 55,859 | 2,596 | 15,938 |
| report | 最终包 | 通过 | 9 | 0 | 59,866 | 2,544 | 14,993 |

最终样本 data input -3.0%，report +7.2%；没有增加决策轮次。但每版本/配置只做一次随机模型样本，跨宿主并行，不能据此声明稳定收益或延迟显著改善。

必须保留的反例：中间版本 data 出现 10 次调用、input 96,385（比旧包 +71.2%），模型没有显式处置原文；report 的中间样本出现 10/11/10 次调用及额外历史读取。另一次选材实验若把全部当前来源及所有已观察文件原结果放回评估，证据组件比旧投影增加约 60%–96%；该选择规则已撤回。不能只展示最后通过样本。

所有实际模型样本及配置/代码 hash、字符/估算/实报 tokens/cache 分开保存于 `packages/agentloop/verification/host-working-set/current-context-basis-20261125.json`。离线档案组件测量缺少完整 canonical criteria 和产品角色，已明确标为组件测量，不能视作完整评估请求压缩率。

## 安装与复现

两个消费应用安装同一文件：

```text
file:vendor/zhujun-agentloop-0.1.0-basis-02982d06ecab.tgz
SHA256 02982d06ecabe5831109075124d59386bf067121ecd41840dfcdcb63e30f7527
```

逐文件核对每个应用安装的 394 个 dist 文件，与本轮构建完全一致。package/lock 的改动仅限内核 spec、resolved、integrity；旧 vendor 包和所有无关改动保留。未重启服务；已经运行的 Node 进程不会因磁盘换包自动切换内核，需用户自行重新启动相应应用进程。不要在已有进程仍占端口时误以为再执行 start 已替换它。

可重复的检查：

```sh
node --test packages/agentloop/tests/committed-decision-basis.test.ts packages/agentloop/tests/decision-working-set.test.ts
node packages/agentloop/scripts/replay-decision-working-set.mjs --sequential
# 真实回放必须显式给固定 config/env；不把凭据写入报告。
node packages/agentloop/scripts/replay-decision-working-set.mjs --live --sequential --policy current --kernel-dist packages/agentloop/dist --config <固定配置文件> --env <凭据环境文件> --output /tmp/replay.json
# 从旧 vendor 包解出 dist 后，用相同私有档案复现新旧状态差异。
node packages/agentloop/scripts/replay-committed-decision-basis.mjs <私有档案目录> --baseline-dist <旧包dist目录> --output /tmp/counts.json
```

私有原始证据和执行日志在 `/tmp/agentloop-context-basis-20261125`，仓库只保存不含正文/凭据的中性测量。

## 尚未验收的边界

- 两个宿主的新业务 Run、真实产物和恢复验收仍由后续实际运行确认。b79 的主体/合并范围未证明问题没有通过通用内核改动被“算作修复”。
- 真实模型可能选择保留原文、读历史或额外验证。新代码不机械添加维护轮次，但不能保证任何真实任务总轮次永不增加。
- 长历史的后端扫描成本、任意必要窗口的直接物化、更多 Provider 的加密/服务端 continuation 仍需分别验证。
- 当前观察产品不等于语义必要产品；未分类和未处理观察继续显式保留，不能为达成短输入而静默删除。

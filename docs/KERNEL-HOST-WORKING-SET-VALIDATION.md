# 内核当前工作集的宿主实际任务验证

2026-11-25 补充验收。结论：data-agent 的真实只读连续问数及 Report Agent 的连续 DOCX 交付完成；HR 真实源任务生成了 HTML，数值复算通过，但覆盖与展示验收不通过。当前工作集释放确实在宿主生效，**累计成本和调用数尚未获得稳定改善，不能据此宣称默认范式已完成性能验收**。

## 隔离、版本与可重复入口

- 使用实际 `createDataAgent` / `createReportAgent`、Intent resolver、Planner、Skill、工具策略、Assessment、正式产物接受和终态提交链；没有用 fake model 替代宿主。
- 每个分支使用独立 SQLite、workspace、conversation、runtimeId 和进程内宿主实例；每轮终态后关闭并重新打开同一私有数据库，再执行连续追问。
- Report Agent 的包解析仅在验证进程中通过 Node `registerHooks` 指向冻结的内核源码。没有安装依赖、更新应用包/lockfile、重启共享服务、提交或推送。
- 首轮快照源指纹 `8cf30b98a3e6f43a27601212e82d88df3be949062176a168e3de087953f1e8f7`；最终快照 `ed383c454c088ba882d081ef40809d32220836b1fc2e8229a8cdb8c8eb010b47`。宿主源码、Skill 和模型配置指纹记录在 JSON 的 `source` 中。最终两分支使用同一冻结源码/配置，仅私有 canonical 副本切换原有 `executionHistoryProjection` 对照开关。
- data-agent 使用既有 TiDB 目录及业务 Skill：业务取数只读，Skill 正常记录查询审计。Report 财务任务使用本次独立端口的 HTTP 模拟源；HR 使用既有受控 Eplat 服务，源回执明确 `dataMode=live`。两个 HR/问数来源不能当成相同数据库或相同月份快照。
- 完整原始事件、结果、产物和凭据副本仅留在权限为 0700 的 `/tmp/agentloop-host-validation-20261125[-v2]`，仓库仅保留脱敏计数、hash 和 composition；私有证据不应提交。

验证器：`packages/agentloop/scripts/verify-host-working-set.mjs`。`--prepare` 拒绝覆盖已有快照；执行前核对冻结内核、宿主和配置指纹。模型及工具失败保留，不只筛选成功样本。基础用法：

```sh
node packages/agentloop/scripts/verify-host-working-set.mjs --prepare --snapshot /tmp/new-host-replay
node packages/agentloop/scripts/verify-host-working-set.mjs --snapshot /tmp/new-host-replay --host data --suite latest --policy current --output /tmp/data-current.json
node packages/agentloop/scripts/verify-host-working-set.mjs --snapshot /tmp/new-host-replay --host data --suite latest --policy canonical --output /tmp/data-canonical.json
# report 支持 finance / hr / enterprise；--repeat 区分重复样本，不覆盖旧私有证据。
```

真实调用需要现有网络/数据授权。没有调用企业信息服务；`enterprise` 只是可复用入口，不计入已验证范围。

## 约 60% 增长的归因和修改

原八次连续观察对照的 current 累计输入 88,286，对照 55,115，约 +60%；13 对 9 次模型调用，4 对 0 次历史读取，23.3 对 10.8 秒，输出 3,998 对 1,077 tokens。增长不是单轮工作集仍按历史长度线性增长：已释放交换使常驻状态趋稳，但额外读取、重复 schema 和状态输出抵消了节约。

真实宿主进一步证实了确定的编码开销：16 个工具的原生参数各自重复完整状态声明 schema；首轮还没有本地工具证据也携带该 schema。data-agent 首轮 execution 的工具定义从 canonical 28,272 增至 current 53,392 字符；同一请求其余差异必须另计，字符不是 Provider tokens。

本次在通用内核编码边界修改：

1. 没有本地已提交观察时不提供状态承接参数，防止把前 Run 可见回答误当成本 Step 的工具证据。
2. 保留原生 schema 的类型、必填身份和枚举，移除每个工具重复的长描述及由持久化 reducer 已强制执行的长度约束。没有放松 reducer 的引用、作用域、版本、权限或完整交换验证。
3. 明确保留目标要求的精确值；只有内容已充分承接才列入 `absorbs`，避免声明一份状态却持续驻留同一原文。没有自动猜测哪些值可以删除，没有为某个 SQL、Skill 或应用字段增加内核条件。

不是降低压缩阈值；没有额外状态更新模型调用；没有新增状态库或语义协议。

同一八次观察任务、相同模型配置的两次最终实测：

| 样本 | canonical 输入/输出 | current 输入/输出 | 模型次数/历史读取 canonical→current | 耗时 canonical→current |
| --- | ---: | ---: | --- | --- |
| 原始记录 | 55,115 / 1,077 | 88,286 / 3,998 | 9/0 → 13/4 | 10.814 → 23.345 秒 |
| 最终第一次 | 54,576 / 918 | 55,548 / 2,794 | 9/0 → 9/0 | 9.758 → 15.629 秒 |
| 最终重复 | 54,869 / 1,050 | 64,719 / 2,627 | 9/0 → 10/1 | 11.041 → 16.661 秒 |

所有样本答案检查通过。累计输入增长降为 +1.8% / +18.0%，但输出仍约 2.5–3 倍，耗时仍 +51–60%。不能把第一次样本的 +1.8% 当成稳定收益。原始样本与最终样本源码不同；每个 A/B 对内部源码相同，跨版本改善包含模型随机性，未隔离各修改的因果贡献。

## 最终宿主对照

以下累计覆盖所有阶段；tokens 为 Provider 成功响应实报，调用数为取得响应的模型调用，失败且无 usage 的请求另见事件。耗时受网络、服务及并行验证负载影响，只是样本值。

| 实际任务 | canonical 输入/输出；调用；耗时 | current 输入/输出；调用；耗时 | 结果与含义 |
| --- | --- | --- | --- |
| data-agent：最新月份，重开宿主后追问最近三个月份 | 519,068 / 5,638；17；40.6 秒 | 662,998 / 5,972；19；41.8 秒 | 两轮结论对应正式查询结果；current 输入 +27.7%，多 2 次调用。不能宣称节省。 |
| Report：DEMO001 预付报告，重开后生成同月 DEMO002 并保留第一份 | 333,405 / 5,777；14；40.9 秒 | 366,436 / 6,642；14；34.3 秒 | 两份各自独立正式 DOCX，两分支源文件与 document.xml hash 相同；current 输入 +9.9%。业务数据为 mock。 |
| Report HR：最新月份、全公司人数/青年率/党员率、自包含 HTML | 成功重复：658,816 / 5,179；18；43.4 秒 | 1,280,936 / 7,399；29；66.3 秒 | current 输入约 +94.4%，多 11 次调用；两边均有下述覆盖缺口，不能作全通过样本。 |

HR canonical 第一次 26 次响应、输入 1,238,646 后因模型 HTTP 400 失败；保留 `report-hr-canonical-v2.json`。成功重放另存 `report-hr-canonical-v2-repeat.json`，没有覆盖失败。首轮源码试跑的 data canonical 连续追问也有失败，均保留原 JSON。

current 在 data-agent 最多释放 3 个交换，Report 财务最多释放 1 个，HR 最多释放 3 个。释放有内容承接及完整提交证据；没有承接/错误引用时保守保留。data-agent 最终测量出现 2 次声明拒绝，没有放宽跨 Run 引用来获取更短输入。

逐次阶段、系统指令、工具定义、runtimeContext、原生结果、状态内容与历史入口的字符/估算值，以及实际 input/output/cache 字段都保留于每次 `calls`。`cost-breakdown.json` 与 `sequential-cost-breakdown.json` 便于比较。旧合成回放 cache 字段并非每个响应都有，不拿缺失值当零缓存，不按这些字段估算账单。

HR 多出的执行主要发生在 HTML 已生成之后：错误的 Result JSON pointer、重复读取分析 bundle、查排名，再用 workspace 只读辅助命令寻找最终答复数值。canonical 也发生部分路径读取失败。这是当前真实模型/Skill协作的剩余成本与正确性边界，不能归结为 Provider continuation 必需内容，也不能靠内核硬编码某个 HR 结果路径来解决。

## 正确性和恢复核验

独立脚本 `packages/agentloop/scripts/check-host-replay-evidence.py` 从本次正式 Skill 结果和文件复核，**不再次向业务数据库发查询**：

- data-agent：最新月份与正式 MAX 结果一致；最近三个月份与正式有序结果逐项一致；一列月份，无人员明细；保留 catalog revision、source signature 和 query plan 验证。
- 财务：两账套各 2 条模拟源记录；独立求和核对金额、万元换算、供应商与记录数；DOCX 中金额、主体、供应商名称、模拟标记与确定性生成的 XML 一致。第二次任务及重开后，第一份报告文件 hash 未改变。
- HR：源 `live`，2,095 行；独立复算所提供的 2,000 个指标观测和全部 1,393 个子集比例，均匹配；3 条重复粒度的归并与源一致。总指标系列 2,092，分析仅返回 2,000 项且 `truncated=true`，HTML 没有暴露该覆盖缺口。脚本输出 `businessAcceptance=incomplete` 并以 **退出码 2** 结束，不能把静态接受当成完整业务验收通过。
- 两宿主所有终态样本在关闭、重开后，状态、输出、事件数量与产物身份完全一致。这里只验证终态持久化恢复；未伪称完成这些业务任务中途 kill/取消、未知外部副作用或 HIL 真人答复验收。

HR 的缺口位于现有 Skill 的 `analyze_hr_report.py:325`（有界段落 `totalCount/items/truncated`）到 `render_hr_report.py:191` 后的展示边界。源数据与分析已明确标记不完整，展示和最终评估没有忠实说明。没有把这套领域结构写入内核；本轮没有修改 Report Agent 的 Skill/模板或放宽产物接受条件。报告首屏列出大量组织，页面高度约 178,524 px，虽可打开但不应视为可读性验收通过。

额外视觉检查：

- HR 独立无头 Chromium 成功打开，无 JS 错误、无外网资源请求、无页面横向溢出。结果 `hr-browser-v2.json`；私有截图未进入仓库。
- 使用 bundled LibreOffice 和 documents 技能渲染两个 DOCX，每份 3 页，逐页看图。初次 bundled renderer 缺 CJK 字形；仅给渲染进程配置临时 Fontconfig 系统字体目录后重渲染，未修改源 DOCX。正文与模拟标记可读，但表格列很窄、金额及日期断行，第二页留白大；视觉质量不能记为全通过，也没有修改业务模板掩盖它。

## 回归结果和剩余验收

`build:kernel` 通过。专项 193/193 通过（工作集 25/25、Assessment、Result、内容引用、Provider），`git diff --check` 和验证器语法检查通过。新增回归证明首轮无证据不接受跨 Run 状态、16 工具编码开销受控、缩减 native schema 后 oversized 声明仍由持久化 reducer 拒绝、原文没有错误释放。固定 10/100/1,000 步工作集投影保持有界。

性能、完整业务交付、最终状态必须分别判断：本轮有真实任务成功，也明确暴露了 HR 覆盖遗漏和较大开销；没有作生产推广、账单下降或全宿主验收通过的结论。后续优先解决短中任务重复 schema/状态输出的固定成本、复杂任务反复读取与覆盖说明；必须继续保留确切证据、权限和未知效果边界，不能通过删历史、跳评估或领域特例取得更短输入。

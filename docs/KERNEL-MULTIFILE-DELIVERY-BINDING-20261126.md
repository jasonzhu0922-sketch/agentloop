# 内核多文件交付与版本绑定修复（2026-11-26）

Plan 描述逻辑交付目标；执行期选择实际文件集合与不可变版本。文件核验、交付归属、目标完成分别记录，不能互相代替。

## 实际事件与首个失真点

只读查询 `/Users/zhujun/coding/report-agent/data/runtime.sqlite` 中 Run `3bd5f265-106c-41a6-a99b-519de80c3949` 的 `run_events`，并用 Report Agent 已安装内核与本地源码 reducer 对同一组结构化回执分别回放。回归 fixture 只保留相关结构化文件事实、核验回执与原始 result 的 SHA-256，不解析 stdout 作为产物身份。

| seq | 事实 | 已安装 reducer | 修复后 reducer |
| --- | --- | --- | --- |
| 105 | 原版成功，显式绑定 report target | 原版 | 原版 |
| 135 | 原版结构验收通过，视觉渲染不可用 | 原版 | 原版 |
| 164 | 原路径重试 exitCode=2，没有文件变更 | 原版 | 原版 |
| 190 | v2 成功，显式绑定同一 target | 空集合 | v2 |
| 219 | v3 成功，显式绑定同一 target | 空集合 | v3 |
| 239 | v3 核验在 prepare 阶段被拒绝 | 空集合 | v3 |

首个失真点是 seq 190 后 `work-product-semantics.ts` 的 receipt binding 投影：它从所有仍存在的历史路径找候选，再要求 `matches.length === 1`。原版和 v2 相互竞争，成功提交的最新显式选择丢失。后续核验资格检查又要求当前绑定，放大为核验拒绝。partial 命令中的辅助文件也被统一记成 `target_not_admitted`，造成误导。

## 最终机制

- 按可信已提交观察顺序选择同一逻辑实例的最新显式文件集；一次命令中相同 `targetId` 的多个路径是完整原子集合。历史文件版本、回执和声明继续保留。
- 先选择最新集合，再检查集合当前性；不能先过滤删除/改写的文件后回退旧集合。`deliverySelections` 保留失效的最新选择，使 canonical reducer 能撤销旧绑定。
- `outputBindings` 允许同一 target 多路径，禁止同一路径重复。执行器对所有声明成员生成 `outputArtifacts` 的真实 bytes/SHA-256，包括未改写的附件；缺失成员不能被静默丢弃。
- 对事后发现的附件，可用版本化 `delivery_target` 声明的 `artifacts` 一次选择完整集合，无需修改 Plan。核验、读取、普通辅助文件与失败操作不创建选择。
- `verify_artifact_acceptance` 可核验当前已观察文件，不要求其已归属目标。核验不会创建 target，也不会使它满足其他目标；格式兼容、集合覆盖与内容评估仍约束完成。
- 自动验收和 delivery candidate 使用同一组当前语义绑定。验收关联依赖已提交观察中的 path/version/SHA-256，避免同路径相同字节改写复用旧验收，也不依赖投影后证据的排列顺序。
- canonical binding 保存逻辑实例 ID：用户明确要求的数量按准入实例核对，附件数量不能冒充多个必需实例；每个当前物理成员都必须有匹配验收。
- 保留工作区原有“局部观察不清空无关目标”的修改；移除以旧 canonical 文件填补语义绑定丢失的兜底。CurrentDecisionView 展示完整当前集合。
- Recovery 使用相同 target namespace 和 WorkProductContext 重放。TerminalCommitter 通过当前 canonical claim 与既有内容评估/Step 完成契约检查；下载侧检查完整集合和实际文件摘要，成员变化时撤销整套最终交付标记，下载仍校验所选文件 SHA-256；已完成 Run 中被 recovery 退休的生产 Step 不会抹掉其独立已接受交付。
- 未绑定诊断分别记录 unknown target、未选择文件、绑定不完整，不再把所有 partial 文件报成 target 未准入。

未增加任何报告名称、供应商场景、v2/v3 文件名或 stdout 内容特例。没有调整 Planner 的交付清单要求。

## 回归验证

`artifact-version-binding.test.ts` 的 17 项测试，加 `delivery-target-lifecycle.test.ts` 的完整 Run 回归，覆盖：

1. 原版→v2→v3、历史追溯与真实事件回放。
2. 原版已验收后绑定新版，新版未验收不能完成。
3. 失败重试、失败改写、读取、旧版验收均不抢占当前选择。
4. 同路径改写（含相同字节）、跨路径替换、修改与删除后不回退。
5. 一个逻辑报告执行产生主文件与两个附件，逐文件验收、内容评估、TerminalCommitter 完成及全部下载项贯通。
6. 多目标、完整多文件集合、明确数量与格式约束、重复物理身份隔离。
7. prepare/ack 边界、恢复重放和在线执行一致；投影顺序变化不改变验收身份。
8. 未绑定/unknown-target 已观察文件可核验，但不自动获得目标归属；完整选择中未被观察的成员阻止完成。
9. 替换主文件时保留未变化附件的真实身份，自动验收不会沿用旧 incarnation 的验收。

验证日志位于 `packages/agentloop/verification/delivery-binding-20261126/`：

| 检查 | 结果 |
| --- | --- |
| focused-final.log（8 个相关测试文件） | 125/125 通过 |
| producer-tests.log（真实命令、同一 target 多文件与未变化成员） | 1/1 通过 |
| version-tests.log（新增版本机制回归） | 17/17 通过，包含于 focused suite |
| 内核 npm build、git diff --check | 通过 |
| unit-final.log | 364/365 通过；TiDB migration 断言失败在修改前源码快照同样存在 |
| kernel-final.log | 731/735 通过；no_progress 旧断言及 3 个 Node 26 原生进程崩溃，均在修改前源码快照复现 |
| computer-tools-final.log | 100/103 通过；append missing、visible-directory 与 table coverage 的 3 个既有失败均在基线复现 |
| agent-artifact.log / baseline.log | artifact 范围的 2 个旧投影断言失败也在基线复现；未改写这些断言 |

`baseline.log`、`baseline-kernel-failures.log`、`baseline-computer-failures.log` 保存对照结果。基线从 HEAD 源码复制到 `/tmp` 独立运行，没有覆盖当前工作区。`real-replay.json` 保存实际回执在已安装与修复后 reducer 上的对照。

真实历史 Run 回放只证明绑定失真已修复、54 个文件观察得以保留；它不补造附件归属、视觉验收或历史完成状态。完整多文件完成链路由新建的隔离测试 Run 验证。

本任务未修改历史 Run，未提交或推送代码，未升级消费端，未重启服务。修复仍属于源码工作区状态。

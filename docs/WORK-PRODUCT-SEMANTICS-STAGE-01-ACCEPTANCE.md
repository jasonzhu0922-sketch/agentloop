# 工作成果语义统一：阶段 0、1 验收记录

日期：2026-09-16。范围：离线基线、归一化、事实归约；没有接入执行上下文、Assessment 或 Recovery。

## 验收结论

- 阶段 0：两个历史 Run 的最小脱敏样本已固定；真实 agent loop 的脚本化模型/工具回放可重复，无外部调用。
- 阶段 1：离线事实归约和版本/检查绑定测试通过，Kernel 构建通过；没有新增线上消费者或 public export。
- 新增测试 28/28 通过，无跳过。选定既有回归改动前后均为 289 项、278 通过、11 失败，失败名称相同。
- 这是离线切片验收，不是全仓全绿或线上问题修复证明。既有失败保留为后续接入的风险，不自动推进阶段 2/3。
- 额外 Multi Runtime 类型检查未通过：既有 `.d.mts` 缺少 `.mjs` 已存在的导出声明，详见下文。

## 阶段 0：冻结了什么

基线 commit 为 `8e2d6725005a03bc6b1213ffd063b0ea0f201591`，但工作区并非干净基线：原有 27 个 tracked 文件存在修改。
`packages/agentloop/tests/fixtures/work-product/baseline.json` 记录这些文件的 SHA-256、整体 tracked diff 指纹、Node/npm/依赖版本与构建文件指纹。
实现结束后逐项复核，27 个原有文件和 tracked diff 均未改变。没有暂存、提交或覆盖既有工作。

历史 DB 仅以 read-only 打开；未恢复、重试或修改这两个 Run。选取 13 个工具事件及 8 个空模型响应事件，各保存原始 seq、调用 ID 和原始 payload SHA-256。
21 个原始事件指纹均已回查验证。详情及脱敏规则见 `packages/agentloop/tests/fixtures/work-product/README.md`。

这不是完整 Run E2E：回放跳过无关探索与 Plan 构建，使用固定工具结果、四次空回复，以及拒绝/复用拒绝的脚本化 Assessment。
测试证明该边界的行为可重复，不证明 provider 空响应原因、按钮可用性、`waiting_recovery` 调度或终态交付。

DB 中两个 Run 分配给 `general-02`，endpoint 为 `http://127.0.0.1:8792`。配置启动入口为
`start:local -> runtime-host-main.ts`，Kernel 通过包导出加载 dist。本次不重启 Host；在磁盘记录的 dist 指纹不能证明进程实际加载版本，后者标记为 unknown。

## 阶段 1：恢复的事实契约

新增内部模块 `packages/agentloop/src/runtime/work-product-observations.ts`，只从传入的完整适用事件集派生状态，不访问文件系统/数据库、不发起工具调用、不建立新业务状态表。

1. 以 workspace 和规范化相对路径标识对象；以持久化 Run/seq/调用 ID/结果摘要/pointer 回溯每条观察。
2. 创建、修改、删除、重新出现分别留痕。观察版本 ID 不冒充内容 hash；无法确认 hash 时保持缺失。
3. 命令非零退出、超时等操作失败不抹去结构化 `fileChanges`；留下文件不代表文件完整或任务成功。
4. 重复事件幂等；输入遍历顺序不影响持久化 seq 顺序。相同 seq 的冲突、同一事件内的矛盾元数据保留为 unknown 与问题记录，不任意选取胜者。
5. 检查只保存显式对象/版本/检查项绑定。覆盖、删除、重建后旧检查变为历史；无 hash 的检查绑定为 unknown。不同文件不能借用检查。
6. 原始 stdout/stderr 内容引用保留，不从任意 stdout 文字推导“文件存在”或“已验收”。失败验收中的有效文件元数据与具体检查结果仍可分别保留。
7. 不推断用途、目标关联、内容充分性或实际交付。实验稿与目标稿的语义区分属于阶段 2。

### 两个样本的离线结果

| 样本 | 本阶段可确认 | 本阶段不宣称 |
|---|---|---|
| A | `themed.pptx` 创建，3,429,079 bytes；`remap_fonts.py` 写入；校验命令结果引用保留 | stdout 的 PASSED 自动变成版本绑定验收；字体脚本已经执行；已经交付 |
| B | `generator.js` 删除、`generator.cjs` 创建；三次命令失败；`test_fill.pptx` 创建，45,978 bytes | 实验文件满足用户目标；错误已修复；已生成真正目标稿 |

没有目标稿观察只能表述为“未观察到”，不能据此证明文件系统中不存在。`presence` 是截至事件水位的已观察状态，不是在线磁盘检查。

### 适用范围与明确限制

- 当前只接受同一 Run、同一 workspace 的 durable seq；其他作用域排除。授权依赖的跨 Run 合并尚未接入。
- 支持现有 command fileChanges、write/patch、JSON 文件元数据、来源 materialization 与 canonical artifact receipts/acceptance 的结构边界。
  未识别的文本/搜索命中不升格为文件事实；第三方 receipt 仅保留引用，不能发布 Runtime 检查。
- `fileChangesTruncated` 产生不完整观察标记，不用缺失条目推导删除。不反查历史工作区来伪造事件发生时的 hash。
- seq 表示持久化观察顺序，不保证并发命令实际副作用顺序；本阶段不新增并发写入的版本控制机制。
- 没有把新状态塞进 `RuntimeStepEvidenceState`、提示词或工具结果，也未改当前 collector，因此旧线上行为仍存在。

## 验证结果及复现命令

```sh
node --test --test-isolation=process packages/agentloop/tests/work-product-observations.test.ts packages/agentloop/tests/work-product-replay.test.ts
node --test --test-isolation=process packages/agentloop/tests/execution-context-policy.test.ts packages/agentloop/tests/step-execution-strategy.test.ts packages/agentloop/tests/agent-loop.test.ts packages/agentloop/tests/planning-runtime.test.ts
npm run build:kernel
npm run typecheck --workspace agentloop-multi-runtime
```

| 检查 | 结果 |
|---|---|
| 新增观察与脚本化回放 | 28/28 通过；A/B 各在测试内重复回放并比对 |
| 既有四文件回归，改动前/后 | 均 278/289 通过，11 项失败名称相同 |
| Kernel build | 通过 |
| Multi Runtime typecheck | 失败：`multi-runtime.test.ts:56` 导入的 `requiredLocalRuntimePythonModules` 未在对应 `.d.mts` 声明 |
| 原始事件、原有工作区指纹 | 21 个原始事件、27 个原有 tracked 文件均一致 |

### 改动前后均存在的 11 项失败

完整名称保存在 baseline JSON；以下列出定位与直接失败原因，不将其扩大为已经证明的根因：

| 文件/行 | 失败断言或边界 |
|---|---|
| `agent-loop.test.ts:2719` | nextAction 为 `acquire_source_evidence`，预期 `produce_artifact` |
| `execution-context-policy.test.ts:8` | 全局 policy 仍含 source evidence kinds，预期仅 delivery |
| `planning-runtime.test.ts:1091` | visible spreadsheet Plan 所需 schema/record/extraction evidence 不可生产 |
| `planning-runtime.test.ts:1161` | structured dependency Plan 所需 evidence 不可生产 |
| `planning-runtime.test.ts:1809` | Skill QA evidence contract 为 undefined，预期 artifact contract |
| `planning-runtime.test.ts:1987` | conversation-only data Plan admission 拒绝 source evidence contract |
| `planning-runtime.test.ts:4776` | 测试引用的 presentation Skill 目录不存在 |
| `planning-runtime.test.ts:5441` | OutcomePlan admission 无法生产 `artifact_openable` |
| `planning-runtime.test.ts:10154` | 大型 source result 测试在 Plan admission 被拒 |
| `planning-runtime.test.ts:10527` | extraction 测试在 Plan admission 被拒 |
| `planning-runtime.test.ts:11794` | 未进入预期 `waiting_recovery`，实际 undefined |

没有跳过或放宽上述断言，也没有用失败 allowlist 把原命令变成成功。Multi Runtime `.mjs`、`.d.mts`、相关测试均与改动前指纹一致；该额外类型错误另列，不归为本轮修复内容。

## 回退与下一阶段边界

本轮仅新增观察模块、两个测试、fixture/基线和本记录。没有 schema 迁移、事件写入、线上接入、Host 重启或恢复操作；撤回这些新增文件即可撤回本阶段实现。
Kernel 构建更新了生成的 dist，不代表已部署到运行中的 Host。

保持阶段 2 未开始。未来接入执行/Assessment/Recovery 前，应明确处理影响该接入的既有失败，并为接入重新取得基线；不能用本轮离线测试代替新 Host/新 Run 验证。

# 可恢复 Runtime 与 Planner 决策链设计

版本：v1 设计稿  
日期：2026-08-18  
状态：D1 已实施；D2-D3 待实施

## 1. 目标与结论

本设计解决的不是“超时后把 Run 改成失败”，而是以下运行契约：

> Worker、模型调用或 Tool 执行中断后，Runtime 必须从持久化事实确定一个未闭合动作的安全恢复路径；只有在 Planner 的结构化决策、Assessment 和 Terminal Commit 均满足约束时，Run 才能继续或结束。

任何时刻均不得存在无法解释的 `runs.status = running`。每个运行中的 Run 都必须有一个可领取的 Runtime Action，或处于显式的 `waiting_recovery` / `waiting_user` 状态。

该设计不允许以下捷径：

- 看到 Artifact 或模型文本就直接提交完成。
- 仅依据最后一条事件时间，把所有 `running` Run 改为失败。
- 对 `effect_pending` 的写操作自动重放。
- 让 Planner 以普通文本跳过 Plan、Assessment 或 Terminal Committer。

## 2. 问题复盘

现有单进程实现已经持久化了 Plan、Step、Assessment、Outcome 和事件，但没有持久化“当前由哪个 Worker 执行的哪个动作、何时失效、能否重放”。例如：

```text
context.assembled
  -> model.complete(...)
  -> [进程退出]
```

数据库只能看到 Run 仍为 `running`，不能区分：

1. 模型仍在正常响应；
2. 模型超时；
3. Worker 已死亡；
4. Tool 已开始但结果尚未提交；
5. 外部写副作用是否已经发生；
6. 当前 Plan 是否需要恢复、修订、等待用户或失败。

因此，第一处语义缺失在 **Runtime Action 的持久化与归属边界**，不在 Assessment。Assessment 只处理已形成的完成候选与证据，不能承担 Worker liveness 判断。

`ac499bba-2988-4019-8547-6ce5247e7ae2` 是这一缺口的实例：前三个 Step 已有批准 Assessment；第四个 Step 在模型调用发出后没有后续事件。它不能被诚实地标记为完成，但也不应无限期保持 `running`。

## 3. 上游参考与采用边界

| 参考 | 可采用的机制 | 不直接照搬的部分 |
|---|---|---|
| PI Agent | 会话以有序追加 mutation 构成状态；`operation_started` 与 `operation_finished` 可推导未闭合操作；分支和上下文从持久会话重建 | PI 主要是本地单进程会话，不提供多 Worker fenced lease 或副作用恢复策略 |
| OpenCode | 每回合按当前权限重新物化 Skill、MCP 与 Tool 快照；上下文投影不反向改写会话事实 | 本地交互 Session 的权限与恢复策略不等同于多租户 Run 控制面 |
| DeepSeek Harness | Tool 调用前的 `effect_pending`、并发执行但按调用顺序提交结果、未启动调用补合成结果、子 Agent 自己的终态 | Harness Loop 不应拥有租户、Plan 修订或业务完成判断 |
| AgentLoop 既有设计 | Plan-first、Capability Grant、Step Assessment、Terminal Committer、投影式 Context Assembler | 当前 SQLite 单进程事件不足以提供可领取动作、租约和 crash recovery |

设计原则是组合这些机制，而不是复制某个上游的控制流：

```text
PI 的 append-only open operation
  + OpenCode 的每回合动态上下文/工具快照
  + Harness 的 effect_pending 与有序 ToolResult
  + AgentLoop 的 Plan / Assessment / Terminal Commit 权威边界
  = 可恢复的 Plan-first Runtime
```

## 4. 职责边界

| 组件 | 拥有的决定 | 不能决定的事项 |
|---|---|---|
| Runtime Scheduler | 下一可执行动作、动作 deadline、重试预算、恢复入口 | 用户目标是否已经满足 |
| Worker / Executor | 领取 lease、执行模型或 Tool、提交事实和 heartbeat | 改写 Plan、完成 Run |
| Tool | 返回结果、进度、外部 receipt | 自己推进 Step 或声明完成 |
| Recovery Evaluator | 根据 Action 状态和 replay policy 分类恢复风险 | 直接跳过 Step |
| Planner | 提交 `resume_step`、`revise_plan`、`ask_user` 或 `fail` 的结构化建议 | 越过 Grant、绕过不安全副作用规则、提交 Outcome |
| Plan Revision Assessor | 检查修订是否仍覆盖用户显式目标、是否安全退休未完成工作 | 执行 Tool 或提交 Outcome |
| Step Assessor | 判断候选是否满足当前 Step 成功标准与 Skill 约束 | 判断 Worker 是否失联 |
| Terminal Committer | 原子提交 Delivery / Outcome | 推测 Artifact 是否代表完成 |

## 5. 权威状态模型

### 5.1 Run 状态

```text
queued -> running -> waiting_recovery -> running -> completed
                    |                    -> failed
                    -> waiting_user ------> running | cancelled
```

`waiting_recovery` 和 `waiting_user` 是 Run 的可见状态，不再把一切都投影为 `running`。仅 `completed`、`failed`、`cancelled` 写入终态 Outcome。

### 5.2 Runtime Action

新增 `runtime_actions`，一条记录代表一个可独立领取、可审计和可关闭的逻辑动作。

```text
id, run_id, plan_id, step_id
kind: planning | model_turn | tool_call | assessment | compaction | recovery_review
state: ready | leased | dispatched | waiting_result | succeeded |
       expired | recovery_required | waiting_user | failed | closed
attempt, max_attempts
replay_policy: safe | idempotent | unsafe
deadline_at, lease_until, fence, revision
request_ref, result_ref, evidence_refs_json
created_at, updated_at, closed_at
```

规则：

- `runtime_actions` 是当前动作状态的权威记录；`run_events` 是同一事务追加的审计流和 UI 投影来源。
- 每个状态转移使用 `revision` 条件更新；Worker 领取时递增 `fence`。旧 Worker 即使晚到也不能提交结果。
- 一个 Run 同时只允许一个驱动性 Action 被领取；同一步中已授权的并行 Tool 可有多个子 Action，但必须关联同一父模型回合。
- `request_ref` 和 `result_ref` 指向不可变事件、消息或对象存储内容，而不是把大结果重复写入 Action 表。
- Action 的创建、事件写入与 Run/Plan 投影更新必须处于一个数据库事务。

### 5.3 Action Attempt 与事件

一次重试不覆盖原始事实。Action 保持逻辑身份，`attempt` 单调递增；每次 dispatch 产生以下最小事件：

```text
action.created
action.leased
action.dispatched
action.heartbeat
action.result_committed
action.deadline_expired
action.recovery_required
recovery.decision_submitted
recovery.decision_admitted | recovery.decision_rejected
```

现有 `assistant.committed`、`tool.effect_pending`、`tool.completed`、`skill.compliance.assessed` 仍保留，且应带上 `actionId` 与 `fence`。

## 6. Lease、deadline 与进度

### 6.1 领取与 fencing

Worker 只能通过条件更新领取 Action：

```text
state in (ready, recovery_required)
and lease_until < now
and revision = expected_revision
```

领取成功后写入新的 `lease_until`、递增 `fence` 与 `revision`。任意结果提交均须匹配当前 `fence`；不匹配的迟到结果仅记录审计，不改变权威状态。

生产环境使用 PostgreSQL 行锁或 compare-and-set，加队列 wake signal；Redis/NATS 只做唤醒，不保存权威状态。单节点 SQLite 仍使用同一模型，但不能宣称多进程高可用。

### 6.2 deadline

没有统一“无进展 N 分钟”阈值。Scheduler 在创建 Action 时确定 `deadline_at`：

| Action | deadline 来源 | 默认策略 |
|---|---|---|
| `model_turn` / `planning` / `assessment` | Provider `timeoutMs` + 15 秒提交宽限 | 当前默认 120 秒时为 135 秒 |
| `tool_call` | Tool 声明的最大执行时间 | Tool 未声明则不得无限执行，Admission 拒绝或注入部署策略上限 |
| `compaction` | 摘要模型的 Provider deadline | 可从不可变会话事实重新执行 |
| `recovery_review` | 较短的 Planner deadline | 失败后进入受控 retry 或 `waiting_user` |

`tool.progress` 和 `action.heartbeat` 可以续租，但不能无限延长：每个 Action 仍有总墙钟预算。只有“超过 deadline 且无合法延展”或“lease 已过期”才进入恢复。

### 6.3 正常超时与进程失联

- Provider 在同一 Worker 内超时：Adapter 返回结构化 `MODEL_ERROR`，Runtime 先关闭该 attempt，再依据策略决定是否创建恢复 Action。
- Tool 正常超时：Executor 终止受控资源、提交 ToolResult 或明确的 `tool.failed` 事实。
- Worker 崩溃：新的 Worker 发现 lease 过期，写入 `recovery_required`，不假设原请求已返回。

## 7. 恢复分类与 Planner 决策

### 7.1 Runtime 先分类，Planner 后决策

Recovery Evaluator 对未闭合 Action 写入以下事实：

```text
reason: worker_lease_expired | deadline_expired | result_commit_interrupted
replay_policy: safe | idempotent | unsafe
external_effect_state: none | pending | receipt_confirmed | unknown
attempts_remaining: number
```

Planner 只读取这一受控 Recovery Context，不能通过模型文本把 `unsafe` 改成 `safe`。

### 7.2 `submit_recovery_decision` 协议

Planner 通过专用结构化 Tool 提交：

```ts
{
  actionId: string,
  expectedActionRevision: number,
  decision: "resume_step" | "revise_plan" | "ask_user" | "fail",
  rationale: string,
  evidenceRefs: string[],
  // revise_plan 时必填：完整、版本化、可 Admission 的 Plan Revision
  planRevision?: PlanProposal,
  // ask_user 时必填：精确说明无法由 Runtime 推断的事实
  question?: string
}
```

Admission 规则：

| 决策 | 允许条件 | Runtime 后续动作 |
|---|---|---|
| `resume_step` | Action 为 `safe` 或 `idempotent`；存在重试预算；Grant 与 Plan Revision 未漂移 | 创建下一 attempt，从持久化 transcript / 证据重建上下文 |
| `revise_plan` | 修订保留显式用户目标；被退休 Step 未出现不安全未确认副作用；Plan Revision Assessor 通过 | 原子写入新 Plan revision，旧 Step 标为 `superseded`，再调度下一步 |
| `ask_user` | `unsafe` 写副作用状态未知，或缺少只能由用户提供的事实 | Run 进入 `waiting_user`，保留证据与可恢复 Action |
| `fail` | 重试耗尽、协议不完整、或无法安全恢复 | Terminal Committer 写失败 Outcome 与完整 reason code |

Planner 不可提交 `completed`。`revise_plan` 后仍要让修订后 Plan 的每一个未退休 Step 经过 Assessment，最后由 Terminal Committer 提交。

### 7.3 不安全 Tool 的恢复

`tool.effect_pending` 后的行为按 Tool 能力而定：

- `safe`：读取、纯计算、可重新执行的本地检查，可由 Runtime 自动重试一次。
- `idempotent`：必须携带 `runId/toolCallId` 幂等键或查询 receipt 的协议；先做状态核对，再决定是否重试。
- `unsafe`：禁止自动重放。若没有可验证 receipt，进入 `ask_user` 或由专用 reconciliation Tool 查询外部系统。

Tool 的 `replaySafe` 现有布尔字段应演进为上述三态协议，避免把“可读取”与“具有外部幂等键”混为一类。

## 8. 上下文与恢复重建

恢复不能依赖 Worker 内存。下一次模型调用从持久事实重建：

```text
用户原始输入
+ 已 admitted 的 Plan revision 与当前 Step
+ Capability Grant / Skill 版本与激活状态
+ 完整 Assistant / Tool 协议事件
+ Context summary 与 compaction 位置
+ 最新 Assessment、修复反馈和 Recovery Context
-> Context Assembler
-> provider-neutral ModelInvocation
```

沿用现有的投影式 Context Assembler：压缩只改变下一轮模型视图，不改写原始 ToolResult。若 Skill 原文已离开保留尾部，恢复时失效对应 Skill activation lease，先重新执行 `load_skill`，再恢复其他执行 Tool。

## 9. Plan Revision 与目标覆盖

恢复时的 Plan Revision 解决“Plan 自身扩展了用户未请求的终态工作”问题，但不能成为任意跳步接口。

Plan Revision Assessor 至少验证：

1. 原始用户显式目标仍被保留或被更具体地解释；
2. 被退休 Step 没有未确认的 unsafe external effect；
3. 已有 Assessment 和 Evidence 仍能指向修订后的成功标准；
4. 依赖图、Skill 绑定、Tool Grant 与版本约束重新通过 Admission；
5. Revision 原因、旧 Step、替代 Step 与证据引用均持久化。

对于本次首页 Run，合法的候选修订是：在证明用户目标已被“首页实现 + 浏览器验证”覆盖后，退休无输出、无外部副作用的额外 `critique-polish` Step。它不是直接把 `index.html` 当完成证据。

## 10. 旧 Run 与迁移策略

历史 Run 没有 `runtime_actions`，不能假装可精确恢复。

迁移策略：

1. 为仍在运行的历史 Run 创建 `recovery_review` Action，标记 `legacy_state_incomplete`。
2. 从 Plan、Assessment、Step Evidence 和事件生成只读 Recovery Context。
3. 禁止自动 Tool 重放；只允许 Planner 提交 `revise_plan`、`ask_user` 或 `fail`。
4. 对不存在 Plan 的历史 Run，直接给出 `fail` 或 `ask_user`，不能伪造 Plan。
5. 迁移完成前，启动器不得批量把所有 `running` Run 直接改为失败。

此前临时的 `reconcileInterruptedRuns()` 应在本设计实施时替换为“创建 recovery review”，而不是最终的启动失败策略。

## 11. API、可观测性与 UI

新增或调整的 API：

```text
GET  /v1/runs/:id                 -> Run + 当前状态摘要
GET  /v1/runs/:id/actions         -> 当前与历史 Runtime Action
GET  /v1/runs/:id/recovery        -> Recovery Context 与决策状态
POST /v1/runs/:id/messages        -> 用户回答 waiting_user 问题
POST /v1/runs/:id/cancel          -> 终止 lease、资源与未启动动作
GET  /v1/runs/:id/events          -> SSE / 可续传审计投影
```

UI 必须区分：

```text
运行中：当前 Action、deadline、已领取 Worker、最近 heartbeat
恢复中：原因、replay policy、Planner 决策状态
等待用户：所需确认及其影响范围
终态：Outcome、最后 Assessment、Delivery 证据
```

不得把“产物已生成”展示成“任务已完成”。它应显示为当前 Step 的 Evidence，并同时显示终态是否已经提交。

指标与告警：

- `runtime_action_lease_expired_total`
- `runtime_action_recovery_total{decision,replay_policy}`
- `runtime_action_stuck_seconds`
- `runtime_unsafe_effect_waiting_total`
- `planner_recovery_decision_latency_seconds`
- `plan_revision_recovery_total`
- 每 Run 的连续恢复次数与最大墙钟时间

## 12. 故障注入验收矩阵

| 注入点 | 预期结果 |
|---|---|
| 模型请求发出前 kill Worker | 无外部副作用；Action lease 过期后可重领；Planner 可继续同一步 |
| 模型响应返回、`assistant.committed` 前 kill Worker | 不把未持久化响应当事实；从上一个完整动作恢复 |
| `tool.effect_pending` 前 kill Worker | Tool 未开始；按 replay policy 恢复 |
| `tool.effect_pending` 后、ToolResult 前 kill Worker | `unsafe` 不自动重跑；进入 `ask_user` 或 receipt reconciliation |
| ToolResult 已持久化、下一模型回合前 kill Worker | 从完整 ToolResult 重建 Context，不能重复 Tool |
| Assessment 请求中断 | 评估可安全重试；没有批准 Assessment 不得完成 Step |
| Planner Recovery 决策超时 | 有限重试；耗尽后 `waiting_user` 或 `fail`，不能无限循环 |
| 两个 Worker 同时恢复同一 Run | 只有 fence 最新者能写结果；迟到结果不能改变 Run |
| Context 已压缩且 Skill 激活失效 | 恢复先重新 `load_skill`，不以摘要代替 Skill 正文 |
| 多余 Step 的恢复修订 | 必须有 Plan Revision Assessor；Terminal Commit 只认修订后 Plan |

验收标准：上述任一点 kill Worker 后，不出现无限 `running`、重复 unsafe effect、丢失 Tool 协议对、绕过 Assessment 或错误完成。

## 13. 分阶段实施

### D0：设计评审

- 确认本文件中的状态命名、三态 replay policy、Plan Revision Assessor 边界。
- 决定生产目标数据库与队列；SQLite 仅保留单节点开发实现。
- 确认 Provider 和 Tool 的 deadline 配置来源。

### D1：动作持久化与单节点恢复

- 已增加 `runtime_actions`、事件中的 `actionId/fence`、lease/deadline/revision。
- 已将模型、Tool、Assessment、Compaction 调用包裹为 Action。
- 已将启动恢复改为创建 `recovery_review` 或标记过期 Action 为 `recovery_required`，不再批量终态化 `running` Run。
- 已覆盖 legacy Run 与过期 Action；完整 Worker kill/reclaim 压测属于 D3。

### D2：Planner Recovery 与 Plan Revision

- 增加 `submit_recovery_decision`、Admission 和 Plan Revision Assessor。
- 实现 `waiting_recovery`、`waiting_user`、用户继续消息。
- 为历史 Run 提供只读 Recovery Context 与受限修订策略。

### D3：生产 Worker 模式

- PostgreSQL 事务、fenced lease、队列 wake signal、SSE 重放。
- Sandbox 资源注销、幂等外部连接器、receipt reconciliation。
- 多副本和 Worker 崩溃压测。

## 14. 实施顺序与非目标

实现必须按 D1 -> D2 -> D3 推进；不要先做 UI 或 Planner Prompt 修改来掩盖没有 Action 状态的问题。

本设计不在本阶段承诺：

- 对任意外部写操作 exactly-once；
- 不具备幂等键或查询 receipt 的系统自动恢复；
- 从历史内存丢失的模型调用中还原未持久化模型响应；
- 用一次 Planner 判断替代 Assessment 与 Terminal Commit。

## 15. 来源

- PI Agent，固定核验提交 `58302d34e703e0453ea13bdd10c7e423589ce177`：Session State、Agent Loop、Skill 与 Context Compaction。
- OpenCode，固定核验提交 `4d68d30b48a99379b2baaf597dbad576707ea36d`：动态 Tool/Skill 快照与 Session Context。
- DeepSeek Harness，固定核验提交 `47f943859bef60e4160492346772ded9b24f765a`：Tool 调度、`effect_pending`、子 Agent 生命周期。
- 本仓 [上游核验](UPSTREAM-RESEARCH.md) 与 [总体架构](ARCHITECTURE.md)。

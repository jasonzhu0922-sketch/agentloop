# AgentLoop 统一 Runtime Result 契约

版本：v1.1
日期：2026-09-22
状态：已实现全局语义收敛阶段
范围：Tool Action、Plan Step、Run Outcome、上下文压缩、恢复、跨 Step 与跨 Run 读取

## 1. 核心结论

AgentLoop 只有一种正式结果对象：

```text
agentloop.runtimeResult/v1
```

Tool 执行事实、Assessment 后的 Step 成果、TerminalCommitter 发布的 Run 交付使用同一份对象结构、同一种不透明引用和同一个读取工具：

```text
RuntimeResultRecord
  -> agentloop.resultRef/v1
  -> read_result
```

统一的是结果身份、来源、输入关系、发布状态、完整性和授权规则，而不是把所有结果复制进一张新表。

当前实现明确不创建独立 Result/WorkProduct 数据库。结果原子保存在生产者原有的权威记录中：

| Result kind | 权威生产边界 | 原子存储位置 |
|---|---|---|
| `tool` | 成功的 Runtime Action | `runtime_actions.result_ref` + `metadata_json.runtimeResult` |
| `step` | `StepResultCommitter`，且必须经过 Assessment | `plan_steps.evidence_json.publishedResult` |
| `run` | `TerminalCommitter` | `run_outcomes.result_ref` + `result_json` |

这避免了 Action、Step、Outcome 与独立结果表之间的双写、漂移和所有权竞争。

## 2. 全局对象规范

```ts
interface RuntimeResultRef {
  readonly schema: "agentloop.resultRef/v1";
  readonly resultId: `rr_${string}`;
}

interface RuntimeResultRecord {
  readonly schema: "agentloop.runtimeResult/v1";
  readonly ref: RuntimeResultRef;
  readonly kind: "tool" | "step" | "run";
  readonly producer: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly actionId?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
  };
  readonly inputs: readonly RuntimeResultRef[];
  readonly publication: {
    readonly status: "committed" | "published";
    readonly assessmentRef?: string;
    readonly decision?: "approved" | "caveated";
  };
  readonly payload: {
    readonly content: string;
    readonly contentFormat: "json" | "text";
    readonly resultSchema?: string;
    readonly characters: number;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly createdAt: number;
}

interface RuntimeResultBinding {
  readonly schema: "agentloop.resultBinding/v1";
  readonly result: RuntimeResultRef;
  readonly relation:
    | "dependency"
    | "continue_prior"
    | "refine_prior"
    | "correct_prior"
    | "challenge_prior";
}

interface RuntimeResultCard {
  readonly schema: "agentloop.resultCard/v1";
  readonly result: RuntimeResultRef;
  readonly kind: "tool" | "step" | "run";
  readonly producer: RuntimeResultRecord["producer"];
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly characters: number;
  readonly goal: string;
  readonly artifactPaths: readonly string[];
  readonly evidenceRefs: readonly string[];
}
```

`resultId` 是模型可见的唯一读取身份。`sha256` 只由 Runtime 计算并用于内部完整性校验；模型不提交、不回放 hash，也不能用路径、Run ID 或摘要替代 ResultRef。

`RuntimeResultBinding` 是全局唯一的 Result 消费关系。Step 依赖和跨 Run 接续不再拥有各自的 binding schema；两者只通过 `relation` 表达消费语义。

`RuntimeResultCard` 是 Runtime 对同一 Result 的有界服务端视图，不创建第二个结果身份，不拥有独立内容，也不能作为读取授权。它只在 WorkingSet 和规划上下文中提供可发现性；Resolver 选中候选后，Turn Resolution 立即收敛回 `RuntimeResultRef`，随后直接形成 `RuntimeResultBinding`，不会把 Card 持久化成第二种权威状态。

压缩后的执行上下文使用 `agentloop.resultContext/v1`，其中每个 `RuntimeResultContextEntry` 仍携带完整 `RuntimeResultRef`、同一 kind 和 producer。它替代旧的 Tool-only `runtimeResultCatalog`，不再维护只含裸 `resultId` 的第二套目录身份。

代码中不再存在 Conversation 专属 Result 类型。以下名称已经退出当前契约：

- `ConversationResultReference`
- `ConversationReusableResult`
- `ConversationInputBinding`
- `completedStepHandoffs`
- `reusableResults`

`ConversationStepContext` 只描述步骤过程上下文，不是 Result，不能替代 `RuntimeResultRecord`、`RuntimeResultRef` 或 `RuntimeResultBinding`。

`plan_steps.output`、`runs.output` 和 `run_outcomes.output` 仍可作为 UI、审计和终端交付的展示投影，但它们不是 Result 身份，也不是跨 Step/Run 的正式输入。下游只能通过 `RuntimeResultBinding` 携带的 `RuntimeResultRef` 调用 `read_result` 获取正式内容。`StepContext`、Plan cursor 和 WorkingSet 不携带 Step Result 正文；摘要也不能被提升为正式结果。

## 3. 发布状态与所有权

### 3.1 Tool Result

Tool 调用成功后，Runtime 在同一个 Action 成功事务中：

1. 创建 `kind = tool`、`status = committed` 的 RuntimeResult；
2. 校验 producer 与 Action 的 Run/Plan/Step/Action 完全匹配；
3. 同时写入 Action 状态、`result_ref` 和 `metadata_json.runtimeResult`；
4. 将 ResultRef 附加到模型可见 Tool result 和 `tool.completed` 事件。

操作语义失败、Action 失败或 lease 丢失时不得提交 Tool Result。

### 3.2 Step Result

Step 候选不能直接成为正式成果。唯一发布入口是 `StepResultCommitter`：

```text
candidate output
  -> Assessment
  -> StepResultCommitter
  -> published RuntimeResult(kind=step)
  -> completeStep
```

发布条件：

- Assessment 已批准；或
- Assessment 明确记录了非阻断的 unverified/process caveat；或
- Runtime 明确进入 `repair_limit` / `evidence_boundary` 的可交付边界。

任意 `completionCaveat` 字段不能覆盖 blocking conflict。Step Result 必须记录 Assessment ID，并把以下输入写入 `inputs`：

- 依赖 Step 已发布的 ResultRef；
- 当前 Step 成功 Tool Action 的 ResultRef。

### 3.3 Run Result

只有 `TerminalCommitter` 可以发布 `kind = run` 的 RuntimeResult。它要求每个 active leaf Step 都已完成并拥有正式 Step Result，然后把 leaf Step ResultRefs 作为 Run Result 的 `inputs`。

`runs.output` 与 `run_outcomes.output` 目前仍作为展示投影保留，但正式结果身份与完整正文来自 `run_outcomes.result_ref/result_json`。它们不能被 Planner、Resolver 或 downstream Step 当作输入来源。

## 4. 下游消费链

同 Run 的 Step 依赖链：

```text
Tool Result
  -> Assessment
  -> Step Result
  -> resultBinding(relation=dependency)
  -> downstream Step
  -> read_result(resultId)
  -> downstream Step Result.inputs
```

下游 Step 不依赖上游 prose、摘要或 `plan_steps.output` 猜测输入身份。上下文只暴露 Runtime 创建的 ResultRef；内容过长或被压缩时，ResultRef 仍保留并可按窗口读取。若依赖 Step 尚未发布 Result，不能用它的 output 字段、handoff 文本或 WorkingSet 摘要替代发布。

执行上下文统一暴露 `resultBindings`：Plan 绑定与 Step 依赖绑定使用完全相同的对象。`stepDependencyContexts` 只携带目标、证据状态和有界 Tool evidence 等过程信息，其中的正式结果关系仍然是 `RuntimeResultBinding`，不再创建 `dependencyEvidenceBinding` 结果语义。

跨 Run 链：

```text
published Step Result or completed Run Result
  -> Resolver 选择 opaque candidate
  -> persisted Plan input binding
  -> read_result authorization
```

WorkingSet 的 active Result 选择遵循同一成果链：完成 Run 已发布 Run Result 时，Run Result 作为聚合成果覆盖其 leaf Step Results；Run 尚未发布正式 Run Result（例如后续 Step 失败）时，已经通过 Assessment 发布的 Step Results 仍进入同一 `RuntimeResultCard` 候选集合，并可被后续 Plan 用同一个 `RuntimeResultBinding` 显式消费。这不是 Step/Run 两套复用协议，而是同一 Result 图上的发布与聚合关系。

跨 Run 读取必须同时满足：

- 当前 Plan 显式绑定该 `resultId`；
- 原 Outcome 为 `completed`；
- 原 Run 与当前 Run 属于同一 owner 和 conversation；
- 当前调用拥有 Plan/Step 范围的 Runtime grant。

仅知道 ResultRef、Run ID、摘要或内部 hash 均不足以读取。

## 5. 单一读取协议

旧入口已退出代码所有权：

- `read_tool_result`
- `read_conversation_result`
- `agentloop.toolResultRef/v1`
- `agentloop.conversationResultRef/v1`
- `agentloop.conversationInputBinding/v1`

统一入口：

```text
read_result({
  resultId,
  pointer?,
  offset?,
  limit?,
  characterOffset?,
  characterLimit?
})
```

JSON Result 支持 JSON Pointer 与数组窗口；文本或完整序列化内容支持字符窗口。单次读取有固定上限，防止大结果重新淹没上下文。

## 6. 完整性与恢复

RuntimeResult 读取时重新验证：

- ResultRef 格式；
- kind 与 publication 状态的组合；
- Step Result 的 Plan/Step/Assessment 发布字段；
- payload 字符数、字节数和 SHA-256；
- JSON payload 的可解析性；
- 输入 ResultRef 的格式。

恢复转录从持久化 `tool.completed.resultRef` 重建模型可见 Tool result。上下文压缩、结构化投影和摘要都必须保留通用 ResultRef；它们不能生成新的身份，也不能把摘要提升为正式结果。

## 7. 数据库决策

当前阶段不创建 `results`、`work_products` 或新的专用结果数据库。

原因：

1. Action、Step、Outcome 已经是各自产物的事务权威；
2. 独立表会引入额外双写、迁移、清理和一致性协议；
3. 当前问题的第一断点是协议分裂和发布边界缺失，不是缺少通用存储容器；
4. 统一读取可以通过 ResultRef 和 producer record 完成，不要求物理集中存储。

旧数据库中历史遗留的 `tool_results` 表不会被新代码读取或写入，也不执行破坏性自动删除。新建数据库不再创建该表。

## 8. 已实现验收

- 每个成功 Tool Action 原子提交统一 ResultRef；
- Tool 结果压缩和恢复仍保留 ResultRef；
- Step 只有经过 Assessment 才能发布正式 Result；
- blocking Assessment 不能被任意 caveat 绕过；
- Step 2 可以读取 Step 1 的正式 ResultRef；
- Step 2 的正式 Result inputs 包含 Step 1 ResultRef；
- Run Result 只聚合正式 leaf Step Results；
- 跨 Run 读取要求显式绑定、同 owner、同 conversation 和已发布正式 Result；
- Plan 输入和 Step 依赖统一使用 `agentloop.resultBinding/v1`；
- WorkingSet 和 Planner 使用 `RuntimeResultCard` 发现结果；Turn Resolution、Plan 和 execution context 使用同一个 `RuntimeResultRef`/`RuntimeResultBinding` 消费结果；
- ResultRef、ResultBinding、ResultCard 的解析校验集中在 Runtime Result 模块；
- 失败 Run 中已经发布的 Step Result 可进入同一跨 Run 绑定和 `read_result` 授权链；
- 模型读取协议不再包含 hash 或文件路径；
- 代码不再拥有专用 Tool Result/Conversation Result repository 和 reader。

## 9. 后续边界

以下能力不属于本阶段，不应通过恢复旧协议或增加旁路表提前实现：

- 多产品 Step Result；
- Result 生命周期折叠、归档和清除；
- Artifact/事实/交付的更细粒度产品角色；
- 全量历史 Outcome 的一次性正式 Result 回填。

这些能力若继续推进，应扩展同一 `RuntimeResult`/`ResultRef` 权威模型，或经过新的架构评审升级为 WorkProduct Graph；不得重新引入 Tool、Step、Conversation 各自独立的结果身份。

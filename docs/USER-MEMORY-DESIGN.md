# AgentLoop 用户级 Memory 设计方案

版本：v0.2
日期：2026-10-09
状态：设计稿，尚未实施

相关设计：

- [Plan Template Fast Path 设计方案](./PLAN-TEMPLATE-FAST-PATH-DESIGN.md)
- [会话统一成果图谱与跨 Run 接续方案](./CONVERSATION-WORK-PRODUCT-GRAPH-DESIGN.md)
- [Multi Runtime 负载均衡设计](./MULTI-RUNTIME-LOAD-BALANCING-DESIGN.md)
- [动态 System Prompt 设计](./PI-DYNAMIC-SYSTEM-PROMPT.md)

## 1. 设计结论

AgentLoop Memory 不是“把历史对话切片后做向量检索”，而是一套用户级、可审计、可撤销的长期上下文系统。它必须根据记忆类型采用不同的形成方式、生命周期和应用方式。

Memory 的身份边界固定为：

```text
tenantId + ownerUserId
```

当前 AgentLoop 没有稳定的 Project 实体；workspace 只是某个任务或会话的文件边界。因此 Project 和 workspace 均不参与 Memory 所有权判断。`conversationId`、`runId`、workspace 路径只能作为来源、适用条件或审计引用，不能改变 Memory 的用户归属。

目标架构：

```text
用户消息 / Run / 用户反馈
          |
          v
   Memory Intake
          |
          v
 Candidate -> Policy -> Revisioned Memory Store
                            |
             +--------------+----------------+
             |              |                |
             v              v                v
     Interaction Profile  Context Recall  Experience Consolidation
             |              |                |
             +--------------+----------------+
                            |
                            v
                   Typed Memory Projection
                            |
          +-----------------+------------------+
          |                 |                  |
          v                 v                  v
   Response Prompt    Planner Context    Artifact / HIL Prompt
```

核心规则：

1. Memory 一级类型收敛为偏好、事实、经验；具体应用由 subtype 和正交属性决定。
2. 常驻交互偏好必须按用户主键确定性加载，不能依赖向量召回。
3. 私人事实只在任务确实相关时召回；秘密永不进入 Memory。
4. 历史成功 Run 先形成 `experience/episode`，多次独立验证后才能晋升为 `experience/procedure`。
5. maturity=`procedure` 的经验只提供 Planner 建议，不直接创建 canonical Plan，不授予 Tool/Skill/Capability，不改变 Assessment 和完成条件。
6. 成熟、稳定的 Plan skeleton 应晋升到现有 PlanTemplate 体系，Memory 不再实现第二套模板实例化和 Admission 旁路。
7. Markdown 是模型可读内容和用户可导出视图；结构化数据库记录才是权限、版本、冲突、删除与应用语义的权威。
8. 每次实际使用 Memory 都必须生成带版本和原因的投影记录，保证 Run 可复现、可解释。
9. 不同 AgentLoop Kernel 实例通过同一 `AgentLoopMemoryPlugin` SPI 消费同一用户级权威 Memory；实例之间只共享 revision 语义，不共享可变 Prompt 状态或数据库连接。
10. Memory 通过专用 `AgentLoopMemoryPlugin` SPI 接入 Kernel；它不是 Skill、Tool 或 `PlanningExtension`。Kernel 固化调用时机与优先级，插件实现召回、沉淀和持久化，Runtime 只负责启动时注册插件。
11. Loop 终局后 AgentLoop 只异步调用 `enqueueSettlement(runId, terminalCommitRef)`；该接口只能完成持久化入队，Plugin worker 再联合 Router 与 canonical Run 数据完成提炼、归并和写入，AgentLoop 不传递一份自造的“执行总结”。

一句话约束：

> Memory 可以提供用户偏好、相关事实、历史经验和规划先验，但永远不是 Runtime 权限、执行证据、Assessment、Delivery 或 Outcome 的权威。

## 2. 需要建立的真实契约

### 2.1 用户体验契约

当用户明确表达长期意图时，例如：

```text
以后都叫我“军爷”。
以后回复直接、专业一些，不要过度赞美，也不用太客套。
```

系统必须：

1. 识别这是跨会话持续生效的显式偏好，而不是当前消息中的临时信息。
2. 在向用户确认“已记住”之前完成持久化；写入失败时不得声称已保存。
3. 从当前回复或下一次适用的模型调用开始生效。
4. 在后续每个 Turn 确定性加载，不依赖语义相似度是否命中。
5. 支持“这次不要这样”“以后改成……”“忘掉这条”的临时覆盖、修订和遗忘语义。

### 2.2 历史学习契约

当某些历史任务同时具备可靠完成证据、良好质量、合理成本和用户正反馈时，系统可以提炼其执行方法：

```text
历史 Run
  -> experience/episode
  -> 多个相似经验的归并
  -> experience/procedure
  -> 新任务的 PlanningPrior
```

但历史成功只能产生建议：

- 新任务仍需重新生成或实例化 PlanProposal。
- PlanProposal 仍需经过同一 PlanAdmission。
- 当前 Tool、Skill、Capability、数据授权和风险边界必须重新验证。
- 历史完成不能作为当前任务的证据。

### 2.3 隐私与控制契约

用户必须能够：

- 查看系统保存了什么。
- 查看每条 Memory 的来源、更新时间和使用范围。
- 修改或删除 Memory。
- 禁止某类信息再次沉淀。
- 查看某个 Turn/Run 实际使用了哪些 Memory。

删除 Memory 与删除原始会话是两个不同操作，产品必须明确展示其区别。

## 3. 非目标

本方案不做以下事情：

- 不把全部聊天记录复制成长期 Memory。
- 不把 Conversation WorkingSet 当作用户 Memory。
- 不把一个持续增长的 `memory.md` 作为线上权威数据库。
- 不对所有 Memory 统一使用 embedding 检索。
- 不把原始用户文本不加边界地拼入 System Prompt。
- 不从 Assistant 自己的陈述推导用户事实。
- 不保存密码、Token、Cookie、私钥或支付凭据。
- 不让 Memory 增加 Capability、授予目录权限或批准危险操作。
- 不让历史高分 Run 绕过 Planner、PlanAdmission、Assessment 或 TerminalCommitter。
- 不复制 PlanTemplate 的 matcher、instantiator、evaluator 和 direct-use 生命周期。
- 不因为用户点赞就认定执行流程正确或值得复用。
- 不把 Memory 检索失败视为任务失败；非必要 Memory 不可用时应继续正常任务路径。

## 4. 概念分层

Memory 系统包含五层，不能压缩成单一文本表。

```text
Source
  用户消息、用户设置、Run/Plan/Evidence/Outcome、用户反馈

Candidate
  尚未成为长期记忆的类型化提议

Memory Record / Revision
  经过策略验证的权威用户级记录

Retrieval Artifact
  搜索关键词、embedding、派生 chunk、聚合指标

Projection
  某个 Turn/Run 实际使用的有界、类型化视图
```

其中：

- Source 是事实依据。
- Candidate 是提炼结果，不具备应用权威。
- Revision 是 Memory 的持久化权威。
- Chunk/embedding 是可重建索引，不是 Memory 本体。
- Projection 是对单次执行的不可变快照，不会因后续 Memory 更新而改变。

## 5. Memory 分类与应用契约

### 5.1 三个一级类型

```ts
type MemoryKind =
  | "preference"
  | "fact"
  | "experience";
```

`suppression` 是生命周期控制对象，不是注入模型的 MemoryKind。

### 5.2 类型矩阵

| 类型 | 示例 | 默认形成方式 | 默认激活方式 | 应用位置 | 是否可直接约束行为 |
| --- | --- | --- | --- | --- | --- |
| `preference` | 称呼、语气、篇幅、交付风格、未明确要求不 push | 用户明确表达；低风险行为只能生成候选 | always 或 task_match | Response / Planner / Execution / Artifact / HIL | default 只补缺；constraint 只能收窄行为 |
| `fact` | 时区、职业、常用技术环境、私人信息 | 用户明确表达；私人信息通常需确认 | task_match 或 explicit_only | Context | 否 |
| `experience` | 历史任务、失败教训、诊断方法、执行流程 | Run 终态提炼、多个经验归并或用户确认 | task_match | Planner 历史参考或 PlanningPrior | 否，只提供建议 |

三个一级类型回答“这是什么记忆”；subtype 和正交属性回答“它何时生效、作用于哪里、能否约束行为”。推荐 subtype 体系：

```text
preference
  +-- interaction.address
  +-- interaction.language
  +-- interaction.tone
  +-- interaction.verbosity
  +-- artifact.style
  +-- workflow.default
  +-- workflow.constraint

fact
  +-- profile.timezone
  +-- profile.location
  +-- profile.occupation
  +-- profile.identity
  +-- environment.technology
  +-- domain.context
  +-- personal.private

experience
  +-- episode.success
  +-- episode.failure
  +-- lesson
  +-- procedure
  +-- template_candidate
```

### 5.3 正交属性

主类型不足以决定完整行为，每条 Memory 还必须保存以下属性：

```ts
type MemoryAuthority =
  | "explicit_user"
  | "user_confirmed"
  | "verified_run"
  | "inferred";

type MemorySensitivity =
  | "normal"
  | "private"
  | "restricted"
  | "secret";

type MemoryTemporalClass =
  | "stable"
  | "time_bound"
  | "ephemeral";

type PreferenceEffect =
  | "default"
  | "constraint";

type ExperienceMaturity =
  | "episode"
  | "pattern"
  | "procedure"
  | "template_candidate";

type MemoryActivation =
  | { readonly mode: "always" }
  | {
      readonly mode: "task_match";
      readonly taskKinds?: readonly string[];
      readonly domains?: readonly string[];
      readonly artifactKinds?: readonly string[];
      readonly sourceKinds?: readonly string[];
    }
  | { readonly mode: "explicit_only" };

type MemoryApplicationTarget =
  | "response"
  | "planner"
  | "execution"
  | "artifact"
  | "human_loop";
```

`secret` 不允许进入持久化 Memory。`restricted` 在第一阶段默认拒绝持久化，后续如需支持，必须具备显式授权、字段级加密和独立访问审计。

`PreferenceEffect` 只适用于 `preference`：

- `default` 在当前请求没有明确值时补充默认选择。
- `constraint` 表达持续性用户约束，只能收窄允许行为，不能授予新的权限或绕过更高层策略。

`ExperienceMaturity` 只适用于 `experience`：

- `episode` 是一次具体经历。
- `pattern` 是多个独立 `experience/episode` 中出现的共同规律。
- `procedure` 是适用条件和验证证据已经稳定的可复用方法。
- `template_candidate` 可以被提议晋升为 user-scoped PlanTemplate，但自身仍不能 direct use。

持久化层必须拒绝非法字段组合：

```text
kind=preference
  -> preferenceEffect required
  -> experienceMaturity forbidden

kind=fact
  -> preferenceEffect forbidden
  -> experienceMaturity forbidden

kind=experience
  -> experienceMaturity required
  -> preferenceEffect forbidden
```

### 5.4 常驻交互偏好

称呼、语言、语气、回复篇幅等偏好属于 `preference`，但必须是确定性加载的 `always` 类型：

```yaml
kind: preference
subtype: interaction.address
preferenceEffect: default
activation:
  mode: always
applicationTargets:
  - response
  - human_loop
authority: explicit_user
value:
  preferredAddress: 军爷
contentMarkdown: 用户希望在需要称呼时被称为“军爷”。
```

```yaml
kind: preference
subtype: interaction.tone
preferenceEffect: default
activation:
  mode: always
applicationTargets:
  - response
  - human_loop
authority: explicit_user
value:
  directness: high
  formality: professional
  warmth: restrained
  avoid:
    - excessive_praise
    - unnecessary_politeness
contentMarkdown: 用户偏好直接、专业、克制的语气，并希望避免过度赞美和不必要的客套。
```

结构化 `value` 用于去重、冲突、UI 和规则计算；`contentMarkdown` 保存模型可读的中性语义；PreferenceApplicator 再将其渲染为受控指令。用户原始表达保存在 Source 中用于审计，不直接拼入 Prompt。

### 5.5 事实记忆与私人信息

私人信息可以进入 `fact`，但需要满足：

1. 来源是用户本人明确表达。
2. 对未来任务具有稳定价值。
3. 用户具有合理的持久化预期，或系统已取得确认。
4. 敏感等级允许保存。
5. 只在任务真正相关时召回。

例如：

- “我常驻上海，默认按上海时区处理”可以拆成稳定时区事实和位置事实。
- “我今天在北京”默认只属于当前会话或 `ephemeral`，不自动进入长期 Memory。
- 健康、财务、身份证件等 `restricted` 信息在 v1 不自动保存。

## 6. Memory 权威与优先级

Memory 不能与系统指令、当前请求处于同一权威层。应用优先级为：

```text
System / Developer / Organization policy
  > 当前用户消息中的明确要求
  > 当前 Conversation 的临时覆盖
  > effect=constraint 的用户持久化 preference
  > effect=default 的用户持久化 preference
  > 产品默认值
```

事实类 Memory 还必须遵循：

```text
当前可验证证据
  > 当前用户明确更正
  > 较新的用户确认事实
  > 较旧的稳定事实
  > inferred candidate
```

Memory 不得成为以下对象的来源：

- Capability Grant
- Tool authorization
- Local directory scope
- Data residency permission
- Assessment approval
- Delivery receipt
- Terminal Outcome

## 7. 核心数据模型

### 7.1 MemoryItem 与 MemoryRevision

`MemoryItem` 是稳定逻辑身份；内容更新通过 append-only `MemoryRevision` 完成。

```ts
interface MemoryItem {
  readonly schema: "agentloop.userMemory/v1";
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly kind: MemoryKind;
  readonly subtype: string;
  readonly canonicalKey?: string;
  readonly status: "active" | "superseded" | "deleted";
  readonly currentRevisionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface MemoryRevision {
  readonly schema: "agentloop.userMemoryRevision/v1";
  readonly id: string;
  readonly memoryId: string;
  readonly revision: number;

  readonly authority: MemoryAuthority;
  readonly sensitivity: Exclude<MemorySensitivity, "secret">;
  readonly temporalClass: MemoryTemporalClass;
  /** Present only when the owning MemoryItem kind is preference. */
  readonly preferenceEffect?: PreferenceEffect;
  /** Present only when the owning MemoryItem kind is experience. */
  readonly experienceMaturity?: ExperienceMaturity;
  readonly activation: MemoryActivation;
  readonly applicationTargets: readonly MemoryApplicationTarget[];

  readonly value: Readonly<Record<string, unknown>>;
  readonly contentMarkdown: string;
  readonly applicability: {
    readonly conditions: readonly string[];
    readonly exclusions: readonly string[];
  };

  readonly confidence: number;
  readonly validFrom: number;
  readonly expiresAt?: number;
  readonly supersedesRevisionId?: string;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly changeReason: string;
  readonly createdAt: number;
}
```

### 7.2 来源引用

```ts
interface MemorySourceRef {
  readonly type:
    | "user_message"
    | "user_setting"
    | "run"
    | "plan"
    | "assessment"
    | "outcome"
    | "user_feedback";
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly runId?: string;
  readonly planId?: string;
  readonly assessmentId?: string;
  readonly outcomeId?: string;
  readonly userFeedbackId?: string;
  readonly sourceHash?: string;
  readonly quotedText?: string;
}
```

`quotedText` 只允许保存最小必要片段，并受敏感信息检查；不能复制整段会话作为所谓来源。

### 7.3 MemoryCandidate

```ts
interface MemoryCandidate {
  readonly schema: "agentloop.userMemoryCandidate/v1";
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly proposedKind: MemoryKind;
  readonly proposedSubtype: string;
  readonly proposedCanonicalKey?: string;
  readonly proposedValue: Readonly<Record<string, unknown>>;
  readonly proposedContentMarkdown: string;
  readonly persistenceIntent: "explicit" | "future_oriented" | "inferred";
  readonly authority: MemoryAuthority;
  readonly sensitivity: MemorySensitivity;
  readonly proposedPreferenceEffect?: PreferenceEffect;
  readonly proposedExperienceMaturity?: ExperienceMaturity;
  readonly activation: MemoryActivation;
  readonly applicationTargets: readonly MemoryApplicationTarget[];
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly confidence: number;
  readonly reason: string;
  readonly decision: "pending" | "accepted" | "confirmation_required" | "rejected";
}
```

Candidate 不能参与召回和 Prompt 注入。

### 7.4 UserInteractionProfile

常驻交互偏好编译成物化 Profile，避免每次 Turn 做向量检索和自由文本归并。

```ts
interface UserInteractionProfile {
  readonly schema: "agentloop.userInteractionProfile/v1";
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly revision: number;
  readonly preferredAddress?: string;
  readonly language?: string;
  readonly tone?: Readonly<Record<string, unknown>>;
  readonly verbosity?: string;
  readonly formatting?: Readonly<Record<string, unknown>>;
  readonly sourceMemoryRevisionIds: readonly string[];
  readonly compiledPromptMarkdown: string;
  readonly contentHash: string;
  readonly updatedAt: number;
}
```

Profile 是派生视图，可以从 active revisions 重建，不是第二套权威。

### 7.5 Experience Episode

`ExecutionEpisode` 是 `kind=experience`、`experienceMaturity=episode` 的专用结构化视图，用于保存一次历史执行的可复用摘要和效果指标。

```ts
interface ExecutionEpisode {
  readonly schema: "agentloop.executionEpisode/v1";
  readonly id: string;
  readonly memoryRevisionId: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly taskFingerprint: Readonly<Record<string, unknown>>;
  readonly strategy: string;
  readonly planSkeleton: readonly {
    readonly role: string;
    readonly objective: string;
    readonly dependsOn: readonly number[];
    readonly requiredEvidenceKinds: readonly string[];
    readonly producedEvidenceKinds: readonly string[];
  }[];
  readonly keyDecisions: readonly string[];
  readonly successfulRecoveries: readonly string[];
  readonly failureLessons: readonly string[];
  readonly quality: {
    readonly terminalCommitted: boolean;
    readonly assessmentApproved: boolean;
    readonly artifactVerified?: boolean;
    readonly userFeedback?: "positive" | "negative";
    readonly laterCorrected: boolean;
    readonly laterDisputed: boolean;
    readonly evidenceCoverage?: number;
  };
  readonly efficiency: {
    readonly durationMs: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly retryCount: number;
  };
  readonly environment: {
    readonly modelKey?: string;
    readonly skillIds: readonly string[];
    readonly capabilityIds: readonly string[];
    readonly runtimeProfile?: string;
  };
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly occurredAt: number;
}
```

Experience Episode 只保存可复用的执行结构和指标，完整 Action/Event/Evidence 仍保留在 canonical Run 存储中。

### 7.6 Experience Procedure 与 PlanningPrior

`ProcedureMemory` 是 `kind=experience`、`experienceMaturity=procedure` 的专用视图。它不引入新的一级 MemoryKind。

```ts
interface ProcedureMemory {
  readonly schema: "agentloop.procedureMemory/v1";
  readonly memoryRevisionId: string;
  readonly taskApplicability: {
    readonly intentHints: readonly string[];
    readonly taskKinds: readonly string[];
    readonly sourceKinds: readonly string[];
    readonly artifactKinds: readonly string[];
    readonly conditions: readonly string[];
    readonly exclusions: readonly string[];
  };
  readonly strategy: string;
  readonly suggestedPlanSkeleton: readonly Readonly<Record<string, unknown>>[];
  readonly decisionRules: readonly string[];
  readonly evidenceExpectations: readonly string[];
  readonly warnings: readonly string[];
  readonly reliability: {
    readonly successfulEpisodes: number;
    readonly failedEpisodes: number;
    readonly positiveFeedbackCount: number;
    readonly correctionCount: number;
  };
  readonly sourceEpisodeIds: readonly string[];
}

interface PlanningPrior {
  readonly schema: "agentloop.planningPrior/v1";
  readonly id: string;
  readonly source: "plan_template" | "experience_procedure" | "experience_episode";
  readonly applicability: string;
  readonly strategy: string;
  readonly suggestedSteps: readonly Readonly<Record<string, unknown>>[];
  readonly evidenceExpectations: readonly string[];
  readonly warnings: readonly string[];
  readonly confidence: number;
  readonly sourceRefs: readonly string[];
}
```

`PlanningPrior` 是 Planner 的统一消费契约。PlanTemplate 与 Memory 通过同一个先验输入面协作，但保持各自生命周期。

### 7.7 MemoryProjection

```ts
interface MemoryProjectionBase {
  readonly schema: "agentloop.memoryProjection/v1";
  readonly id: string;
  readonly runId: string;
  readonly target: MemoryApplicationTarget;
  readonly memoryEpoch: number;
  readonly profileRevision?: number;
  readonly memoryRevisionIds: readonly string[];
  readonly retrievalReasons: readonly string[];
  readonly projectionContextHash?: string;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface InteractionMemoryProjection extends MemoryProjectionBase {
  readonly target: "response" | "human_loop";
  readonly guidance: {
    readonly preferredAddress?: string;
    readonly language?: string;
    readonly tone?: Readonly<Record<string, unknown>>;
    readonly verbosity?: string;
    readonly formatting?: Readonly<Record<string, unknown>>;
  };
  /** Plugin-compiled, bounded model projection; Kernel does not reinterpret source text. */
  readonly promptMarkdown: string;
}

interface PlanningMemoryProjection extends MemoryProjectionBase {
  readonly target: "planner";
  readonly relevantFacts: readonly {
    readonly memoryRevisionId: string;
    readonly subtype: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly stale: boolean;
  }[];
  readonly preferenceConstraints: readonly Readonly<Record<string, unknown>>[];
  readonly planningPriors: readonly PlanningPrior[];
}

interface RuntimeGuidanceMemoryProjection extends MemoryProjectionBase {
  readonly target: "execution" | "artifact";
  readonly augmentations: readonly {
    readonly id: string;
    readonly contentMarkdown: string;
    readonly reason: string;
  }[];
}

type MemoryProjection =
  | InteractionMemoryProjection
  | PlanningMemoryProjection
  | RuntimeGuidanceMemoryProjection;
```

`MemoryProjection` 是 Kernel 可移植消费契约，不携带 `tenantId`、`ownerUserId`、访问凭证或后端 transport 信息。Plugin 必须根据可信 `runId` 解析 canonical Run subject，再以 `tenantId + ownerUserId` 执行隔离；Kernel 不接受调用方在 recall 参数中自由声明用户身份。

`memoryEpoch` 是该用户 Memory 变更代次，用于阻止删除或显式修订后继续使用旧缓存。普通后台归并不会改变一个 Run 已固定的 Projection；显式记住、修改或遗忘成功后，后续模型调用必须进入新 epoch 并重新获取受影响 target 的 Projection。

Projection 必须按 target 使用可辨识联合类型，而不是只提供一个通用 Markdown 字段。Memory Plugin 负责把权威 Revision 编译为结构化语义和必要的受控 Prompt；不同 Kernel 实例只消费同一协议，不各自重新解释原始 Memory。

## 8. Memory 沉淀机制

### 8.1 三条写入链

```text
显式用户意图       -> 同步写入链
Run 终态与反馈      -> 异步 Experience Episode 提炼链
多个历史 Memory    -> 周期性归并链
```

三条链共享同一个 `MemoryPolicy` 和 `MemoryWriter`，不能各自直接写表。

### 8.2 显式同步写入

适用表达：

- “以后都叫我……”
- “从现在开始默认……”
- “记住我……”
- “以后不要……”
- “把之前那条改成……”
- “忘掉……”

链路：

```text
User Message
  -> plugin.commitExplicit(runId, message)
  -> Plugin MemoryIntentResolver
  -> Plugin MemoryMutationProposal
  -> Plugin Sensitivity / Persistence Policy
  -> Plugin ConflictResolver
  -> Plugin MemoryWriter CAS commit
  -> MemoryCommitReceipt
  -> 当前 Turn Context
```

Kernel 不解析 Memory subtype，也不直接写表；显式意图识别和写入事务都封装在 Plugin 内。只有收到 `MemoryCommitReceipt` 后，用户可见回复才能确认“已记住”。如果语义不确定或涉及 private/restricted 数据，则 Plugin 创建 `confirmation_required` Candidate，不得擅自持久化。

显式写入成功后，应使当前 Turn 后续用户可见生成应用新偏好；已经开始流式输出的内容不做中途重写。

### 8.3 Run 终态后的经验提炼

`experience/episode` 提炼必须在 canonical Outcome 后异步执行，不能占用或阻塞用户交付路径。Kernel 只向 post-commit executor 提交 `plugin.enqueueSettlement(runId, terminalCommitRef)`；该方法完成 durable enqueue 后立即返回，Plugin worker 再自行读取以下持久化事实，不由 Kernel 拼装一份经验 payload。

正向经验候选至少检查：

```text
TerminalCommitter 已提交 completed/caveated Outcome
+ 所需 Assessment 已批准
+ 交付物或结果有可验证证据
+ 没有已知 dispute / supersede
+ 过程包含未来可复用的方法信息
```

用户点赞、耗时、模型调用数、Tool 调用数和 retry 数是评估信号，不是单独的准入条件。

失败 Run 也可形成 `experience/episode.failure`，但只产生 `failureLessons` 或 Planning warning，不得作为推荐执行过程。

提炼器只能读取中性、持久化的 Run 事实：

- Task fingerprint
- admitted Plan skeleton
- Step 状态与依赖
- Tool/Action 成功失败摘要
- Evidence kinds
- Assessment
- Delivery/Outcome
- 用户反馈与后续纠正关系

模型 prose、文件存在或 `completed` 字符串本身均不足以证明高质量成功。

### 8.4 周期性归并

Consolidator 对相似的 experience revisions 做聚类与冲突检查：

```text
多个独立成功 experience/episode
  -> 相同适用条件
  -> 相似策略和证据结构
  -> 排除环境偶然性
  -> experience/pattern
  -> experience/procedure Candidate
  -> Policy / 人工或用户确认
  -> active experience revision
```

禁止自我强化：

```text
Memory 被召回
  -> Assistant 复述
  -> 新 Run 再引用同一 Memory
```

这条链不算独立证据。只有新的用户确认、独立执行事实、Assessment 或 Outcome 才能强化可靠性。

### 8.5 冲突和修订

Candidate 与现有 Memory 比较后只能产生四种结果：

```text
new         -> 创建 MemoryItem + revision 1
reinforce   -> 创建新 revision，追加独立 sourceRef 和评估信息
refine      -> 创建新 revision，补充适用条件或例外
contradict  -> 创建新 revision，并 supersede 旧 revision
```

不允许原地覆盖历史 revision。

显式用户更正优先于 inferred/verified historical pattern。例如：

```text
v1: 用户偏好正式称呼
v2: 用户明确要求以后称呼为“军爷”
```

召回只使用 v2，审计仍可解释变化。

### 8.6 临时覆盖与持久修改

```text
“这次别叫我军爷”
  -> Conversation/Turn 临时覆盖，不修改 Memory

“以后别叫我军爷了”
  -> 新 revision 取消 interaction.address

“以后叫我老朱”
  -> 新 revision supersede 原称呼
```

MemoryIntentResolver 必须区分当前作用域和未来持久化意图。

### 8.7 遗忘与抑制

用户要求遗忘时：

1. 将 MemoryItem 标记为 `deleted`。
2. 删除或失效其 embedding、chunk 和物化 Profile 投影。
3. 写入 `MemorySuppression`，防止从仍保留的历史会话再次提炼。
4. 后续 Projection 不得包含该 Memory。

```ts
interface MemorySuppression {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly canonicalKey?: string;
  readonly semanticFingerprint: string;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly reason: "user_forgot" | "privacy_policy" | "incorrect";
  readonly createdAt: number;
}
```

是否删除原始 Conversation/Run 由独立数据保留策略决定，不能把 Memory 删除描述为原始数据已全部清除。

## 9. Memory 应用机制

### 9.1 两条读取路径

```text
Pinned Memory
  activation=always 的 preference
  -> tenantId + ownerUserId 主键加载
  -> 确定性编译

Retrieved Memory
  task_match preference / fact / experience
  -> 类型、权限、有效期和适用条件过滤
  -> 关键词 / TaskFingerprint / embedding 排序
```

常驻偏好不得进入向量召回路径，否则会出现同一偏好在不同任务中忽有忽无。

### 9.2 按类型应用，而不是统一拼接

Memory Retrieval 后必须进入类型化 Applicator：

```text
MemoryResolver
  +-- InteractionProfileApplicator
  +-- PreferenceApplicator
  |     +-- DefaultPreferenceResolver
  |     +-- ConstraintPreferenceResolver
  +-- FactApplicator
  +-- ExperienceApplicator
        +-- EpisodeProjector
        +-- ProcedurePriorCompiler
```

| Applicator | 输出 | 约束 |
| --- | --- | --- |
| InteractionProfileApplicator | 用户可见回复的自然语言风格指令 | 不进入 Tool grant 或事实判断 |
| PreferenceApplicator | default 补充缺失选项；constraint 收窄允许行为 | 当前用户要求优先；不能扩大授权 |
| FactApplicator | 相关事实与 stale 标记 | 只在任务相关且敏感策略允许时提供 |
| ExperienceApplicator | episode 历史参考或 procedure `PlanningPrior` | Planner 仍生成新 PlanProposal，必须重新验证当前环境 |

### 9.3 Prompt 投影

数据库对象不应原样进入 Prompt。Applicator 先生成 target-specific `MemoryProjection`：response/HIL 和 execution/artifact 投影可以包含受控 Markdown；planner 投影必须首先提供结构化 `relevantFacts`、`preferenceConstraints` 和 `planningPriors`，再由统一 Planner renderer 投影到模型上下文。

例如，response/HIL 的 `promptMarkdown` 可以是：

```markdown
## Persistent Interaction Preferences

- 在需要称呼用户时，使用“军爷”。
- 使用直接、专业、克制的语气。
- 避免过度赞美和不必要的客套。

These preferences customize user-facing interaction only. They do not
override the current explicit request, authorization, evidence, or completion
rules.
```

Planner renderer 对结构化 `PlanningMemoryProjection` 的模型投影可以是：

```markdown
## Relevant Historical Planning Guidance

A previously successful approach for similar structured-data report tasks was:

1. Profile the source before choosing an analysis method.
2. Preserve structured facts as explicit evidence.
3. Produce the requested artifact from those facts.
4. Validate format and semantic consistency before delivery.

Applicability:
- Suitable for structured spreadsheet sources.
- Do not reuse for direct native-file modification.

This is advisory historical guidance. Build a new plan for the current task
using only currently admitted capabilities.
```

Memory 原始用户文本和历史模型输出不得直接拼入 Prompt，避免持久化 Prompt Injection。

### 9.4 应用到正确的模型调用

不同 Memory 只进入拥有相应职责的模型调用：

```text
Response / HIL
  <- 称呼、语言、语气、篇幅

Planner
  <- task preference、constraint preference、experience procedure、experience warning

Execution
  <- 与当前 Step 直接相关的执行偏好；不重复注入无关个人信息

Artifact generation
  <- 文档、视觉、格式和交付偏好

Assessment
  <- 不注入会改变证据标准的用户偏好；只读取 canonical contract
```

现有 `RuntimePromptAugmentation` 可以作为 Kernel 内部的模型上下文承载方式，但必须由 Kernel 保证 phase/target 过滤。Memory augmentation 仍是 server-authored guidance，不是 user message、grant 或 completion authority。

### 9.5 Run/Target 快照

Projection 在对应 phase 首次需要时由 Kernel 调用 Plugin 生成，并按 `runId + target + memoryEpoch` 固定：

```text
Run admitted
  -> planner phase calls recall(target=planner)
  -> Plugin loads always-on and contextual revisions
  -> Plugin compiles immutable target Projection
  -> Kernel persists projection ID/revision/hash
  -> same Run/target/epoch reuses the immutable Projection
```

execution/artifact 可以额外包含有界 `stepContext`，其 Projection 还必须绑定对应 Step 或上下文 hash。后台 consolidation 不得在同一 Run 的同一 epoch 中悄然改变已固定的模型行为；新 Run 才默认读取新的 active revision。

显式 Memory mutation 是例外：只有 `plugin.commitExplicit` 返回 committed receipt 后才提高 `memoryEpoch`，并在当前 Run 的下一次模型调用前重新获取受影响 target 的 Projection。已经发给模型或已经流式输出的内容无法撤回，但旧 Projection 不得再用于后续调用。

## 10. 历史执行记忆与 PlanTemplate

### 10.1 统一而不重复

Memory 和 PlanTemplate 解决不同阶段的问题：

```text
experience/episode
  记录一次任务如何执行及效果

experience/procedure
  表达某用户经过验证的工作方法

PlanTemplate
  表达可实例化、可约束检查的稳定 Plan skeleton
```

Memory v1 只允许 maturity=`procedure` 的经验记忆生成 `planner_context` 类型的 `PlanningPrior`，不允许 direct use。

二者的扩展形态也不同：

| 维度 | Memory | PlanTemplate |
| --- | --- | --- |
| Kernel 定位 | 专用 Run lifecycle / reinforcement plugin | planning-scoped plugin/extension |
| 影响范围 | Turn、Planner、Execution、Artifact、HIL、Response | Planner 前置匹配和 PlanProposal 生成 |
| 身份与隐私 | tenant/user 权威、删除和敏感策略是核心契约 | 只消费已授权的模板目录 |
| 禁用语义 | 显式无个性化运行，不能隐式切换用户存储 | 回到普通 Planner 路径 |
| 可替换部分 | 整个 Plugin 实现及其 Store/index/transport 可替换，SPI 语义不可替换 | matcher/provider/plugin 实现可替换 |

因此 PlanTemplate 可以继续实现 `PlanningExtension`；Memory 则实现专用 `AgentLoopMemoryPlugin`，覆盖 Run 内多阶段召回、显式写入和终局沉淀。两者不复用同一个扩展接口，只通过 `PlanningPrior` 在 Planner 输入面汇合。

当经验记忆满足以下条件时，可以把 maturity 晋升为 `template_candidate`，并提议生成 user-scoped PlanTemplate candidate：

- 来自多个独立成功 experience/episode。
- TaskFingerprint 与适用边界稳定。
- Plan skeleton、能力和证据 contract 稳定。
- 没有较高的纠正、争议或 Assessment 失败率。
- 当前 PlanTemplate Store 已支持 `tenantId + ownerUserId` 隔离。

晋升后复用现有：

- TemplateMatcher
- ConstraintVerifier
- TemplatePlanInstantiator
- TemplateEvaluator
- PlanAdmission

Memory 不重新实现这些组件。PlanTemplate candidate 一旦被接受，其模板生命周期由 PlanTemplate Store 负责；Memory 只保留来源和晋升关系。

### 10.2 Experience Episode 准入与质量评估

不能使用单一总分决定沉淀。至少保留：

- TerminalCommitter 状态
- Assessment 状态
- Artifact/Delivery 验证
- 用户正负反馈
- 后续 correction/dispute
- duration
- model/tool calls
- retry/repair 次数
- 环境、模型、Skill 和 Capability 快照

时间短、用户点赞只能提高候选价值，不能覆盖证据不足或失败 Outcome。

### 10.3 召回排序

Experience 的 procedure/episode 排序综合：

```text
TaskFingerprint 匹配
+ 输入/输出类型匹配
+ 当前 Capability/Skill 兼容
+ 多次独立成功
+ 用户正反馈
+ 时间新鲜度
- 后续纠正/争议
- 失败和 repair 比例
- 环境或 contract 版本不兼容
```

硬不兼容先拒绝，再做软排序。embedding 仅参与软相关性，不得覆盖权限、类型、时效和 contract 过滤。

### 10.4 使用反馈闭环

```ts
interface PlanMemoryInfluence {
  readonly schema: "agentloop.planMemoryInfluence/v1";
  readonly runId: string;
  readonly planId: string;
  readonly planningPriorIds: readonly string[];
  readonly selectedMemoryRevisionIds: readonly string[];
  readonly rejectedMemoryRevisionIds: readonly string[];
  readonly selectionReasons: readonly string[];
  readonly createdAt: number;
}
```

Run 结束后，Evaluator 可以判断该 Prior 是否真正被 Plan 采用以及采用后的效果。未实际采用的 Memory 不能因最终成功而增加可靠性。

## 11. Markdown、分片与索引

### 11.1 存储结论

推荐形态：

```text
结构化 relational records
+ 每个 revision 的 contentMarkdown
+ 可重建的 retrieval chunks / embeddings
+ 可导出的用户级 MEMORY.md
```

不采用：

```text
每个用户一个不断增长的 MEMORY.md
```

原因：单文件无法可靠承担并发写入、CAS 修订、字段级隐私、冲突、精确删除、TTL、租户隔离和使用审计。

### 11.2 语义原子

一条 MemoryRevision 应表达一个可以独立更新、删除和判断适用性的语义：

```markdown
用户在代码问题中偏好先定位首个语义断点，再实施修改；
不接受针对某个 Run、文件格式或关键词增加特殊旁路。
```

不能按固定字符数把这条完整偏好拆成相互独立的 Memory。

### 11.3 派生 Chunk

短 preference/fact：

```text
MemoryRevision = RetrievalChunk
```

较长 experience/procedure 或 experience/episode：按语义标题派生 chunk：

```text
MemoryRevision
  +-- Applicability
  +-- Strategy
  +-- Evidence expectations
  +-- Failure lessons
```

```ts
interface MemoryChunk {
  readonly id: string;
  readonly memoryRevisionId: string;
  readonly ordinal: number;
  readonly heading?: string;
  readonly text: string;
  readonly tokenCount: number;
  readonly embeddingRef?: string;
}
```

Chunk 是索引，不可独立编辑。命中 chunk 后必须回到父 Revision，再由 Applicator 投影必要字段，避免断章取义。

### 11.4 检索顺序

```text
1. tenantId + ownerUserId 强隔离
2. active 状态、敏感等级、有效期过滤
3. MemoryKind / subtype / applicationTarget 过滤
4. activation 和 TaskFingerprint 硬条件过滤
5. canonicalKey / 关键词检索
6. embedding 或文本相似度排序
7. 冲突、重复、时效和 token budget 归并
8. 类型化 Applicator 投影
```

第一阶段不要求独立向量数据库。数量较小时可以保存 embedding JSON/blob，并使用数据库条件查询加进程内相似度。先验证类型、应用和反馈闭环，再决定索引基础设施。

## 12. 所有权与系统边界

Memory 不定义为“Router 插件”或“Runtime 插件”，而是注册在 AgentLoop Kernel 上的 Run 生命周期插件。所有权按职责明确划分：

| 层 | 拥有什么 | 不拥有什么 |
| --- | --- | --- |
| AgentLoop Kernel | `AgentLoopMemoryPlugin` SPI、可信 Run scope、各 phase 调用点、优先级和失败语义 | Store、索引、检索算法和 Memory 提炼实现 |
| Memory Plugin | Revision、Policy、Retrieval、Mutation、Consolidation、Projection、Audit | PlanAdmission、Tool 授权、Assessment 和 Outcome 权威 |
| Runtime/Application | 从配置加载并注册一个 Plugin 实现 | Memory 调用时序、召回内容解释和沉淀判断 |
| Router | 认证用户并把 tenant/user subject 绑定到 Run admission | Memory 生命周期；除非所选 Plugin 的后端恰好部署在 Router |

依赖方向变为：

```text
Runtime/Application config
  -> register AgentLoopMemoryPlugin once

AgentLoop Kernel Run lifecycle
  -> plugin.recall(runId, phase context)
  -> plugin.commitExplicit(...)
  -> postCommitExecutor.submit(plugin.enqueueSettlement(...))

Plugin implementation
  -> local shared store OR remote Memory Service
```

是否启用以及选择哪个实现可以配置，但调用时机和 Projection 应用规则是 Kernel 契约。例如插件不能决定把 response preference 注入 Assessment，也不能改变 Memory 与当前用户指令的优先级。

### 12.1 AgentLoopMemoryPlugin SPI

AgentLoop 在 Run 创建、规划、执行、用户回复和终态提交等既有生命周期点调用同一个注册插件。Plugin 实现可以使用共享数据库，也可以调用独立 Memory Service；Kernel 和 Runtime 均不感知后端部署位置。

插件负责：

- 根据 Kernel 提供的 `runId` 读取可信 Run subject，并执行 tenant/user 隔离。
- 显式 Memory mutation、revision、suppression 和 commit receipt。
- pinned preference 和 contextual Memory 召回。
- 编译 target-specific `MemoryProjection`。
- 在 canonical Outcome 后可靠接管 settlement enqueue，并由异步 worker 生成 experience candidate。
- 管理 Store、索引、归并、审计和用户管理能力。

Kernel 不直接读写 Memory 表，也不解释 Plugin 的 Store schema。

### 12.2 可信 Run Scope

`runId` 是 Kernel 与插件之间的主关联键，但不能单独作为用户授权边界。Run admission 必须持久化 canonical subject；插件收到 `runId` 后从可信 Run 数据源解析该 scope：

```ts
interface MemoryRunScope {
  readonly runId: string;
  readonly subject: {
    readonly tenantId: string;
    readonly ownerUserId: string;
  };
  readonly conversationId?: string;
  readonly parentRunId?: string;
}
```

当前 `RunRecord` 只有 `ownerUserId`。要满足已确定的 `tenantId + ownerUserId` 边界，实施时必须把 `tenantId` 作为 canonical Run subject 的组成部分持久化，或持久化一个只能由可信 admission 解析的 opaque subject ref。不能让 Plugin 根据调用参数中的任意 user ID 自行拼 scope，也不能只凭可枚举的 `runId` 放行；远程实现还必须验证调用插件实例对该 Run 的服务访问权。

### 12.3 AgentLoopMemoryPlugin 契约

Kernel 只依赖一个进程级注册的插件实例。调用参数使用 `runId` 关联当前执行，不传 `tenantId`、`ownerUserId`、Router grant、数据库连接或完整 Run 内容：

```ts
interface MemoryProjectionBudget {
  readonly maxItems: number;
  readonly maxTokens: number;
}

interface ExplicitMemoryCommitRequest {
  readonly runId: string;
  readonly messageId: string;
  readonly userText: string;
}

interface MemoryCommitReceipt {
  readonly id: string;
  readonly memoryEpoch: number;
  readonly affectedTargets: readonly MemoryApplicationTarget[];
}

type ExplicitMemoryCommitResult =
  | { readonly kind: "not_applicable" }
  | {
      readonly kind: "confirmation_required";
      readonly candidateId: string;
      readonly prompt: string;
    }
  | {
      readonly kind: "committed";
      readonly receipt: MemoryCommitReceipt;
    };

interface MemorySettlementEnqueueReceipt {
  readonly kind: "enqueued" | "duplicate";
  readonly settlementJobId: string;
  readonly enqueuedAt: number;
}

interface AgentLoopMemoryPlugin {
  readonly name: string;

  recall(input: {
    readonly runId: string;
    readonly target: MemoryApplicationTarget;
    readonly taskFingerprint?: Readonly<Record<string, unknown>>;
    readonly stepContext?: Readonly<Record<string, unknown>>;
    readonly budget: MemoryProjectionBudget;
  }): Promise<MemoryProjection | undefined>;

  commitExplicit(input: ExplicitMemoryCommitRequest):
    Promise<ExplicitMemoryCommitResult>;

  enqueueSettlement(input: {
    readonly runId: string;
    readonly terminalCommitRef: string;
  }): Promise<MemorySettlementEnqueueReceipt>;

  close?(): Promise<void>;
}
```

三个入口的语义不同：

- `recall` 返回最终、不可变、带 revision/hash 的 target-specific Projection，不返回 Memory row、任意搜索结果或原始历史文本。
- `commitExplicit` 由插件完成显式意图识别、敏感性判断、冲突处理和同步持久化。Kernel 只有收到 `kind=committed` 及其 `MemoryCommitReceipt` 才能向用户确认“已记住”；`confirmation_required` 必须进入正常 HIL 语义。
- `enqueueSettlement` 是 canonical Outcome 之后的异步投递接口。它只能校验触发、执行幂等判断并把 job 持久化入队；不得在接口调用内读取完整执行轨迹、调用提炼模型、归并 experience 或写入最终 Memory。返回 `enqueued` 只表示插件已经可靠接管任务，不表示已经生成 Memory；相同 `runId + terminalCommitRef` 重复调用必须返回 `duplicate` 或等价结果。

`terminalCommitRef` 必须由 TerminalCommitter 成功提交后产生，并可供插件验证对应的 canonical Outcome；推荐使用 opaque outcome ID，或由 outcome ID + commit version/hash 构成。它不能使用 `reasonCode`、状态字符串或 Assistant 输出代替。调用方也不能用任意 `runId` 伪造一次成功沉淀。

插件不是模型 Tool。模型不能直接选择其他用户、扩大 target、任意搜索 Memory 或调用 `enqueueSettlement`。这些入口只由 Kernel 在固定生命周期点调用。

Kernel 的终局主链不得直接 `await plugin.enqueueSettlement(...)`：

```ts
const terminalCommitRef = await terminal.commitOutcome(...);

postCommitExecutor.submit(async () => {
  await memoryPlugin.enqueueSettlement({ runId, terminalCommitRef });
});

return committedRun;
```

`postCommitExecutor` 必须有界、可观测并捕获失败，不能产生 unhandled rejection。它负责等待 enqueue receipt 和安排重试；Plugin 的 durable queue/worker 负责真正沉淀。若进程在 executor 完成入队前退出，则由 canonical Outcome 对账补偿。

### 12.4 Agent 执行阶段的消费时序

```text
Application startup
  -> load configured AgentLoopMemoryPlugin
  -> register plugin when constructing RunService

Run admitted and canonical subject persisted
  -> Kernel calls commitExplicit(runId, current user message) when enabled
  -> committed mutation raises memoryEpoch before later model calls
  -> Kernel derives preliminary TaskFingerprint
  -> Kernel calls recall(runId, planner, fingerprint, budget)
  -> Plugin resolves tenant/user from canonical Run/Router data
  -> Plugin returns PlanningMemoryProjection
  -> Planner builds a fresh PlanProposal from PlanningPrior
  -> PlanAdmission remains unchanged
  -> Kernel calls recall only for the execution/artifact target needed by a Step
  -> Kernel calls recall for response/HIL before user-visible generation
  -> Kernel persists projection id/revision/hash in canonical Run context

TerminalCommitter commits Outcome
  -> Kernel submits plugin.enqueueSettlement(...) to postCommitExecutor
  -> user delivery continues without waiting for extraction
  -> Plugin durably enqueues or de-duplicates the trigger
  -> Plugin worker independently reads Router + canonical Run records
  -> Plugin worker extracts Candidate and commits Memory revisions
```

具体消费点：

| 阶段 | Kernel 行为 | 模型看到的内容 |
| --- | --- | --- |
| Run 接纳后 | 处理显式记住、修改、遗忘并取得 commit receipt | 成功后的新 preference 可影响本 Run 后续调用 |
| TaskFingerprint 形成后、Planner 前 | `recall(target=planner)` | `PlanningPrior` 和相关事实，不是历史原文 |
| Step 执行前 | 按 Step 和预算 `recall(target=execution)` | phase-filtered `RuntimePromptAugmentation` |
| Artifact 生成前 | `recall(target=artifact)` | 格式、视觉、交付偏好 |
| HIL/最终回复前 | `recall(target=human_loop/response)` | 称呼、语言、语气、篇幅 |
| Assessment/TerminalCommitter | 不召回会改变证据标准的 Memory | canonical contract 和当前 Run evidence |
| Outcome 提交后 | 异步投递 `enqueueSettlement(runId, terminalCommitRef)` | 不等待提炼，不再影响已经提交的 Outcome |

Planner 应增加一等字段 `planningPriors`，不要把 Memory 伪装成普通 `PlanningExtension`；执行与产物阶段可以复用现有 `RuntimePromptAugmentation`，但需增加 `target`、`projectionId`、`memoryEpoch` 和 `contentHash`，并由 `ContextAssembler` 按 phase 过滤。所有 Memory 内容都是 server-authored context，不能伪装成 user message。

### 12.5 Runtime/Application 只负责装配

Runtime/Application 是 composition root，只在启动时选择、构造和注册插件，不参与每个 Run 的 Memory 召回、应用和沉淀决策：

```yaml
memoryPlugin:
  enabled: true
  module: "@agentloop/memory-plugin"
  factory: "createAgentLoopMemoryPlugin"
  optionsPath: "./config/memory.json"
```

插件自己的配置可以包含其后端连接和预算，例如：

```yaml
backend:
  kind: "control_plane" # control_plane | shared_database
  endpoint: "http://router:8788"
  serviceCredentialEnv: "AGENTLOOP_MEMORY_SERVICE_TOKEN"
requestTimeoutMs: 1200
budgets:
  planner: { maxItems: 8, maxTokens: 1200 }
  execution: { maxItems: 4, maxTokens: 600 }
  artifact: { maxItems: 4, maxTokens: 600 }
  response: { maxItems: 8, maxTokens: 500 }
  human_loop: { maxItems: 8, maxTokens: 500 }
```

装配链只有一次：

```text
Runtime/Application config
  -> load plugin module and factory
  -> create AgentLoopMemoryPlugin(plugin options and backend clients)
  -> new RunService({ memoryPlugin })
  -> Kernel owns all per-Run hook invocation
```

```ts
const memoryPlugin = await loadMemoryPlugin(runtimeConfig.memoryPlugin);

const runs = new RunService({
  ...kernelDependencies,
  ...(memoryPlugin === undefined ? {} : { memoryPlugin }),
});
```

必须区分：

- `module/factory/optionsPath` 是应用装配配置，不是 Kernel Memory 语义。
- endpoint、service credential、数据库连接和 Router client 都封装在具体插件实现内部，不进入 `RunService.startConversation` 参数。
- `tenantId/ownerUserId` 不是配置项，也不由 Kernel recall 参数提供；插件从可信 Run/Router 关系解析。
- 插件实例可以是进程级对象，但所有 Projection、缓存和审计必须以 Run 及其解析出的 subject 隔离。
- `enabled=false` 表示明确不注册插件；`enabled=true` 但插件加载失败时应启动失败，不能静默退化成另一套本地用户存储。

这使 Memory 与 Runtime 生命周期实现无关：Single Runtime、Multi Runtime 和未来其他宿主只要能注册同一 SPI，就不需要分别实现 Memory session、dispatch binding 或 prompt 注入流程。

### 12.6 终局触发与插件内沉淀

AgentLoop 在 loop 结束时不向插件复制 Plan、Action、Evidence 或 Assistant 总结，只提交最小触发信息：

```text
canonical Outcome committed
  -> postCommitExecutor submits plugin.enqueueSettlement(...)
  -> Plugin verifies trigger and durably inserts settlement job
  -> enqueue receipt returned; no extraction has run yet
  -> Plugin worker resolves Run subject
  -> Plugin worker reads canonical Run / Plan / Action / Evidence / Assessment / Outcome
  -> Plugin worker joins Router assignment / conversation / feedback when needed
  -> experience Candidate
  -> policy / consolidation
  -> new Memory revision when admitted
```

因此“结合 Router 数据沉淀”是插件实现能力，而不是 Router 或 Runtime 的 Memory 生命周期职责。一个插件可以直接访问共享数据库，也可以使用 Router 内部 API；两种实现对 Kernel 都表现为相同 SPI。

`enqueueSettlement` 必须满足：

- 调用发生在 TerminalCommitter 成功之后；未提交 Outcome 不得生成正向经验。
- Kernel 通过独立 post-commit executor 调用，不把 enqueue、提炼或 Memory 写入作为 Outcome 提交和用户交付的完成条件。
- 插件在返回 `enqueued` 前必须可靠保存待处理 job；接口内严禁执行提炼，实际处理只能由异步 worker 完成。
- 使用 `runId + terminalCommitRef` 幂等，允许 Kernel 在超时或进程恢复后重试触发。
- `enqueueSettlement` 是终局后的边沿触发；Plugin 应维护 settlement ledger，并可周期性对账 canonical Outcome，以补偿进程崩溃或网络中断造成的漏触发。
- 插件必须自行读取 canonical 证据，不能信任 Assistant 最终文本或调用方提交的“成功摘要”。
- 沉淀失败只影响 Memory 学习并产生可观测事件，不反向修改、撤销或伪造已经提交的 Outcome。
- 后续 correction、dispute 或反馈变化可以让插件重新评价已有 episode，并通过新 revision 修订，不能原地覆盖。

这里的“异步”不等于进程内 fire-and-forget。仅执行 `void plugin.enqueueSettlement(...)` 而没有 durable job，会在进程退出时丢失沉淀请求。插件可以使用数据库 outbox/job table、消息队列或等价的可靠任务设施，但必须具备持久化状态、attempt、backoff、dead-letter/人工重放和幂等键。

### 12.7 多 Kernel 一致性与降级

多个 Kernel 实例共享 Memory 的条件不是共享进程对象，而是它们注册的插件实现指向同一个权威后端，并遵守同一 revision/epoch 协议：

```text
Kernel A -> Memory Plugin A --+
                              +-> shared Memory authority
Kernel B -> Memory Plugin B --+
```

一致性和失败规则：

- Projection 只可按 `runId + target + memoryEpoch` 缓存；不得把一个 Run 的 Projection 复用于另一个 Run。
- 插件每次 recall 都必须从 canonical Run subject 解析 `tenantId + ownerUserId`，并验证 Run 归属和状态。
- 普通 recall 失败时，Kernel 记录 `memory.projection_unavailable` 并无个性化继续；不得使用另一用户、另一后端或过期跨 Run 缓存兜底。
- 显式记住、修改和遗忘失败时 fail closed，用户回复不得声称成功。
- settlement enqueue 失败应记录 `memory.settlement.enqueue_failed` 并允许幂等重试，但不得把已提交任务改判失败。
- 删除成功后，旧 Projection 内容不得用于本 Run 的后续模型调用；审计可以保留 ID/hash，不能保留已删除内容副本。
- 数据驻留或 sensitivity policy 不允许内容离开某边界时，插件返回空/受限 Projection；不能降级泄露到其他后端。
- 配置为共享后端却不可用时，不能偷偷回退到某个本地 `memory.md` 或另一套用户存储。

### 12.8 包边界建议

```text
packages/agentloop
  定义 AgentLoopMemoryPlugin、MemoryProjection、PlanningPrior、hook 调用时机、
  target 应用规则和失败语义；不拥有 Memory schema、SQL、检索或提炼实现。

packages/agentloop-memory
  提供一个可注册的 AgentLoopMemoryPlugin 实现；拥有 schema、migration、
  store、policy、extractor、retriever、consolidator、applicator、projection
  compiler，以及 Router/canonical Run 数据读取 adapter。

apps/agentloop-app / runtime-host / local-agent-runtime
  只负责从配置加载插件模块、构造后端依赖并在创建 RunService 时注册。

apps/agentloop-multi-runtime/router
  继续拥有认证、Assignment、Conversation、反馈和用户管理 API；可以向某个
  Memory Plugin 实现提供可信数据 API，但不拥有 Kernel hook 时序。
```

`packages/agentloop-memory` 是否独立发布、直接连接数据库还是远程调用 Memory Service，可在实施阶段决定。这些都是插件内部部署选择，不改变 Kernel SPI，也不能把 Memory SQL 和领域生命周期散落进 Router handler、Runtime Host 或 `ContextAssembler`。

## 13. 持久化建议

建议最小表组：

```text
user_memories
user_memory_revisions
user_memory_sources
user_memory_candidates
user_memory_chunks
user_memory_suppressions
user_interaction_profiles
user_memory_experience_episodes
memory_settlement_jobs
memory_projections
memory_usage_feedback
```

关键约束：

- 所有读取都必须包含 `(tenant_id, owner_user_id)`。
- `user_memories` 的 logical key 可在 `(tenant_id, owner_user_id, kind, canonical_key)` 上建立条件唯一约束。
- Revision 通过 `(memory_id, revision)` 唯一，并以 CAS 更新 current revision。
- Settlement job 通过 `(run_id, terminal_commit_ref)` 唯一，至少记录 `queued/processing/succeeded/failed/dead_letter`、attempt、next attempt 和错误摘要。
- Chunk、Profile 和 embedding 都是可重建派生状态。
- SourceRef 只保存 opaque ID 和最小必要引用，不复制秘密或完整日志。
- Memory schema 通过现有版本化 migration 体系管理，并分别验证 SQLite/PostgreSQL/TiDB 语义。
- 删除 active Memory 和刷新物化 Profile 必须处于同一事务，避免已删除偏好继续被加载。

## 14. API 与用户界面

### 14.1 用户 API

建议提供：

```text
GET    /api/v1/memories
GET    /api/v1/memories/:id
POST   /api/v1/memories
PATCH  /api/v1/memories/:id
DELETE /api/v1/memories/:id
GET    /api/v1/memory-profile
GET    /api/v1/memory-projections?conversationId=...&runId=...
POST   /api/v1/memory-candidates/:id/confirm
POST   /api/v1/memory-candidates/:id/reject
```

所有 ID 都通过当前 Principal 推导用户范围，不接受调用方用 request body 覆盖 `tenantId/ownerUserId`。

### 14.2 插件后端 API

Kernel SPI 不规定 HTTP，也不要求 Memory 部署在 Router。若某个 `AgentLoopMemoryPlugin` 实现采用远程 Memory Service，它可以在插件内部使用类似接口：

```text
POST /internal/v1/memory/runs/:runId/recall
POST /internal/v1/memory/runs/:runId/explicit-commit
POST /internal/v1/memory/runs/:runId/settlement-jobs
```

这些接口是具体插件实现的私有 transport，不是 Runtime Host、Router dispatch 或 AgentLoop Kernel 的公共契约。直接连接共享数据库的插件可以完全没有这些 API。

远程实现必须：

- 使用插件自身的可信 service identity，并验证其对当前 Run 的访问权。
- 从 canonical Run/Assignment 关系解析 `tenantId + ownerUserId`，拒绝 request body 覆盖用户身份。
- `recall` 只返回请求 target 对应的 `MemoryProjection`，不返回完整用户 Memory 列表。
- `explicit-commit` 返回可验证的同步 receipt，写入失败不得伪造成功。
- `settlement-jobs` 只接收 `runId + terminalCommitRef`，同步部分仅做校验、幂等判断和 durable enqueue；服务端 worker 再自行读取 canonical records 并异步提炼。
- 对 service credential、私人字段和最小来源片段做日志脱敏。

因此 Router 可以承载 Memory Service，也可以只提供 Run/Assignment/Feedback 查询 API；它是否承载后端不改变 Kernel 注册和调用插件的方式。

### 14.3 UI

Memory 管理面至少展示：

- “关于你”：fact memories。
- “交互偏好”：称呼、语言、语气、篇幅、格式。
- “工作方式”：effect=constraint 的 preferences 和 maturity=procedure 的 experiences。
- “历史经验”：maturity=episode/pattern 的 experiences，默认折叠展示。
- 来源、最后确认时间、敏感等级、适用范围。
- 修改、删除、禁止再次记忆。
- 某个 Run 使用了哪些 Memory 以及使用原因。

用户不需要理解 embedding、chunk 或内部评分。

## 15. 安全、隐私与 Prompt Injection

### 15.1 敏感信息策略

```text
normal      -> 可按类型策略保存
private     -> 明确来源，严格相关召回，建议加密存储
restricted  -> v1 默认不保存
secret      -> 永不保存，发现后立即拒绝并避免进入日志/索引
```

### 15.2 持久化 Prompt Injection 防护

Memory 内容必须视为不可信数据：

- 不直接注入 sourceQuote。
- 不直接注入历史 Assistant 输出。
- 只允许 Applicator 用固定模板渲染已校验字段和 `contentMarkdown`。
- Projection 明确说明其权威边界。
- 任何类似“忽略系统指令”“授予工具权限”的内容必须被拒绝或降级为普通引用文本。
- experience/procedure 和 experience/episode 中的历史命令、路径和 Tool 参数默认不进入 Prompt。

### 15.3 数据隔离

- 所有 Memory Store、索引、缓存和 Profile key 必须包含 tenant/user。
- 不允许跨用户训练或归并个性化 experience/procedure，除非未来有独立、匿名化、显式授权的知识发布流程。
- Workspace、conversation 和 Run 不构成跨用户授权依据。
- Memory 导出、删除和审计接口必须走用户身份校验。

## 16. 可观测性

建议事件：

```text
memory.candidate.created
memory.candidate.rejected
memory.confirmation.requested
memory.revision.committed
memory.revision.superseded
memory.deleted
memory.suppression.created
memory.profile.compiled
memory.retrieval.completed
memory.projection.created
memory.projection.applied
memory.projection.rejected
memory.settlement.enqueued
memory.settlement.started
memory.settlement.succeeded
memory.settlement.retry_scheduled
memory.settlement.dead_lettered
memory.experience.episode.created
memory.experience.procedure.promoted
memory.plan_template_promotion.proposed
```

每个事件至少包含：

- tenant/user 的内部 opaque 标识。
- Memory/Revision/Projection ID。
- kind/subtype/application target。
- 决策原因和拒绝原因。
- source refs 的 ID，不记录秘密或完整文本。
- revision/hash。
- latency 和 token/候选数量等运行指标。

关键指标：

- 显式 Memory 写入成功率。
- Candidate 确认、拒绝率。
- Memory correction/delete 率。
- always-on Profile 加载一致性。
- contextual recall 命中和最终采用率。
- settlement enqueue latency、队列深度、处理延迟、重试率和 dead-letter 数量。
- experience/procedure 使用后的成功、repair、dispute 和用户反馈变化。
- stale/private Memory 被过滤数量。
- 跨用户访问拒绝数量。

## 17. 测试策略

### 17.1 分类和沉淀

- “以后叫我军爷”同步落为 `interaction.address`，写入成功后才确认。
- “这次叫我军爷”只形成临时覆盖。
- “以后别这样叫我” supersede 旧 revision。
- Assistant 自己声称的用户事实不能生成 active Memory。
- secret/restricted 数据按策略拒绝。
- 写入失败时不得向用户声称已记住。

### 17.2 隔离和生命周期

- 相同 canonical key 在不同 tenant/user 下完全隔离。
- 删除后 Profile、chunk、embedding 和 Projection 都不再包含该记录。
- suppression 阻止旧 Conversation 再次生成同一 Memory。
- 并发更新通过 revision CAS 避免丢失更正。
- 过期事实不进入 active Projection。

### 17.3 应用

- always preference 不依赖 embedding，所有新 Turn 稳定生效。
- 当前用户指令覆盖持久 preference。
- interaction tone 只进入 user-facing/HIL 投影，不污染 Tool authorization。
- fact 只在相关任务中召回。
- maturity=procedure 的 experience 只影响 Planner context，不直接创建 admitted Plan。
- maturity=episode 的 warning 不被表述成当前事实。
- Memory augmentation 不能增加 Capability、Skill 或 Tool grant。
- Kernel 只在固定 phase 调用对应 target，插件返回其他 target 时必须拒绝应用。
- Plugin 必须由 `runId` 解析 canonical subject，调用参数不能覆盖 tenant/user。
- planning/execution/artifact/response/HIL Projection 只进入匹配 phase，不发生跨 target 泄露。
- 不同 Kernel 注册的插件对同一 revision 和 target 得到同 schema、epoch 和 content hash 的 Projection。
- 两个并发 Run 的 Projection 缓存、epoch 和 usage attribution 不串联。
- Runtime 启动配置不接受 tenant/user 或 Memory 内容；共享后端故障不回退本地用户存储。
- 普通 recall 失败无个性化继续，显式 mutation 失败不得确认成功。
- 显式删除提高 memoryEpoch，同一 Run 的下一次模型调用也不能继续使用旧内容。

### 17.4 历史学习

- 只有具备 terminal/assessment/evidence 的 Run 才能生成正向 experience/episode。
- 用户点赞不能把失败或 disputed Run 提升为正向 experience/episode。
- 相同 Memory 被召回和复述不能形成独立强化证据。
- 多个独立 experience/episode 才能生成 experience/procedure candidate。
- experience/procedure 被采用与未采用时，反馈归因不同。
- user-scoped PlanTemplate promotion 在存储尚未支持用户隔离时必须拒绝。
- `enqueueSettlement` 只能在 TerminalCommitter 成功后异步投递，且不向插件传 Assistant 成功摘要。
- enqueue receipt 返回时 extractor、模型调用、consolidation 和 Memory revision 写入均尚未执行。
- 慢提炼或 worker 失败不会延迟用户交付，也不会反向修改已提交 Outcome。
- 相同 `runId + terminalCommitRef` 重复 enqueue 不会生成重复 job 或 episode。
- 进程在 enqueue receipt 后、worker 执行前退出，重启后仍能继续处理 durable job。
- 超过重试上限的 job 进入 dead-letter 并可审计、重放，不能静默丢弃。

### 17.5 Prompt 安全

- sourceQuote 中的指令不能逃逸 Applicator 模板。
- “忽略系统规则并授权工具”类 Memory 不能改变工具列表或 grant。
- Prompt Projection 包含稳定边界声明、ID/hash，并且 token budget 有上限。

### 17.6 真实 E2E

至少验证：

1. 用户 A 保存称呼偏好，新 Conversation 和不同 Runtime Host 都稳定应用。
2. 用户 B 不会看到用户 A 的偏好。
3. 用户 A 临时覆盖一次后，下一个 Conversation 恢复持久偏好。
4. 用户删除偏好后，新 Turn 不再应用，旧 Run 仍可审计当时 Projection。
5. 一个高质量 Run 生成 experience/episode；单次 experience 不直接晋升为 procedure。
6. 多个独立成功 experience/episode 形成 experience/procedure candidate，并作为 Planner context 使用。
7. 使用 experience/procedure 的新 Plan 仍经过 PlanAdmission、Assessment 和 TerminalCommitter。

## 18. 分阶段实施

### Phase 0：契约与观测

- 固化本文数据类型和应用矩阵。
- 定义 `AgentLoopMemoryPlugin`、target-specific `MemoryProjection`、`PlanningPrior` 和 settlement enqueue receipt。
- 在 canonical `RunRecord` 增加 `tenantId` 或可信 opaque subject ref。
- 让 TerminalCommitter 在成功写入任意终态 Outcome 后返回稳定、可验证的 `terminalCommitRef`，不能复用 `reasonCode`。
- 在 `RunService`/`AgentLoopOptions` 增加进程级可选 `memoryPlugin` 注册点。
- 固化 `recall`、`commitExplicit` 和 TerminalCommitter 成功后的异步 `enqueueSettlement` 调用时序。
- 为 `RuntimePromptAugmentation` 增加 target/phase、projection ID、epoch 和 content hash。
- 为 Planner 增加一等 `planningPriors` 输入，但保持 PlanAdmission 不变。
- 提供观测插件，只记录 hook 和 enqueue 事件，不执行提炼，也不影响 Prompt。
- 建立 tenant/user、run/target/phase 隔离、enqueue 幂等和插件失败语义 contract tests。

退出标准：所有 Kernel 生命周期 hook、可信 subject 解析和失败语义可观测，但插件仍返回空 Projection，现有模型行为不变。

### Phase 1：显式常驻交互偏好

- 实现 `interaction.address/language/tone/verbosity`。
- 实现同步 commit receipt。
- 实现 UserInteractionProfile。
- 只向 response/HIL 生成受控 Projection。
- 提供查看、修改、删除 UI/API。

退出标准：跨 Conversation、跨 Host 稳定应用；写入失败不虚假确认；删除立即停止后续应用。

### Phase 2：事实记忆、时效和隐私

- 支持 normal/private fact memories。
- 增加 TTL、重新确认、stale 标记和 suppression。
- 实现 contextual retrieval，但先使用结构化过滤和关键词。

退出标准：事实只在相关任务中出现，过期和删除记录不可召回，跨用户隔离通过真实数据库测试。

### Phase 3：Experience Episode

- 在 TerminalCommitter 成功后通过 post-commit executor 调用 `plugin.enqueueSettlement(runId, terminalCommitRef)`。
- 实现 durable settlement job、独立 worker、重试、dead-letter 和 canonical Outcome 对账。
- 从 canonical Run/Assessment/Outcome 生成 kind=experience、maturity=episode 的 candidate。
- 接入用户反馈、correction/dispute 和效率指标。
- 只提供历史参考和 warning，不影响 Plan。

退出标准：正负 experience/episode 分类有持久证据，失败/点赞/完成边界不混淆。

### Phase 4：Experience Procedure 与 Planner Context

- 实现 experience/episode consolidation 和 pattern 归并。
- 使用现有 TaskFingerprint 做 experience/procedure 检索。
- 输出 `PlanningPrior`，只采用 planner_context 模式。
- 记录 Prior 的选择、采用和执行结果。

退出标准：相似任务获得有界规划建议，低匹配或环境不兼容时正常走原 Planner，Runtime 权威链不变。

### Phase 5：与 PlanTemplate 晋升闭环

- 为 PlanTemplate Store 增加严格的 user scope，或明确拒绝个性化晋升。
- 将 maturity=template_candidate 的稳定 experience 提议为 PlanTemplate candidate。
- 复用现有 matcher、constraint verifier、instantiator 和 evaluator。
- direct_use 仍按 PlanTemplate 自身门槛和开关控制。

退出标准：Memory 没有第二套 Plan 实例化机制；晋升模板仍通过相同 PlanAdmission 和 Runtime 完成链。

### Phase 6：索引和规模化

- 在结构化过滤和关键词检索不足时引入 embedding。
- 评估 sqlite-vec、PostgreSQL 向量扩展或独立索引。
- 增加分层缓存、归档、重新索引和配额策略。

退出标准：规模化没有改变 Memory 权威、删除、隔离和应用语义。

## 19. 阶段性成功标准

第一阶段成功不是“模型看起来更懂用户”，而是可以从持久化事实证明：

1. 明确偏好被正确分类、持久化、修订和遗忘。
2. always-on 偏好在所有新 Turn 确定性加载。
3. 不同类型 Memory 只影响其拥有的模型调用和阶段。
4. 私人信息没有因为相似度命中而出现在无关任务中。
5. 每个 Run 能说明使用了哪些 Memory、哪个 revision、为什么使用。
6. 历史执行经验按 episode -> pattern -> procedure 成熟，不从一次成功直接推广。
7. maturity=procedure 的 experience 只提供 PlanningPrior，PlanAdmission 和 Runtime 权威链保持不变。
8. 删除、跨用户隔离和 Prompt Injection 防护经过真实 E2E 验证。

## 20. 待实施前确认的决策

以下问题不影响总体边界，但需要在实施前固定：

1. `packages/agentloop-memory` 是否作为独立发布的 Plugin 包，还是先作为应用可加载模块实现；无论哪种形式都必须实现同一 Kernel SPI。
2. 显式 MemoryIntentResolver 使用现有模型、专用低成本模型，还是“确定性规则 + 不确定时模型”的组合。
3. private facts 是否在 v1 开放，以及采用应用级字段加密还是数据库级加密。
4. 用户反馈的等待窗口：点赞后多久、出现何种 correction/dispute 时重新评价 experience/episode。
5. PlanTemplate Store 的 user scope 改造时机；在此之前 experience/procedure 只允许 planner_context。
6. Memory 导出格式是否直接采用 Markdown + JSON manifest 的组合。

这些决定不得改变已经确定的核心契约：身份边界是 `tenantId + ownerUserId`，一级类型固定为 preference/fact/experience，subtype 和正交属性决定具体应用方式，Memory 不成为 Runtime 权威，历史 experience/procedure 不复制 PlanTemplate 执行链。

# 统一 Skill 契约研发路线

版本：v1.0

日期：2026-10-24

状态：研发策划

研发分支：`codex/unified-skill-contract-roadmap`

关联设计：[统一 Skill 契约与快速扩展设计](./UNIFIED-SKILL-CONTRACT-DESIGN.md)

## 1. 研发目标

本分支把 Bundled Skill、Custom Skill、用户上传 Skill 和未修改第三方 Skill 收敛到同一条契约链：

```text
Package Declaration
  -> Deployment Binding
  -> Runtime Readiness
  -> ResolvedSkillContract
  -> Planner / Admission / Executor / Assessment
```

Run 和 Step 的能力授权在执行前继续与已解析 contract 取交集：

```text
EffectiveStepCapabilities
  = ResolvedSkillContract
  intersect StepExecutionBinding
  intersect RunCapabilityGrant
  intersect HostPolicy
```

研发完成的判断标准是：所有运行边界只消费统一的 `ResolvedSkillContract`，而不是“增加一套 custom Skill 配置并保留 bundled 特例”。

## 1.1 首要设计决策：metadata 不再写入 `SKILL.md`

本分支先固定存储边界，再开始编译器和上传功能。`SKILL.md` 只保留正文以及兼容性的 `name`/`description` 头部；AgentLoop 的角色、artifact/source/QA、召回提示、required Skill 和执行证据不再写入其中。

```text
Skill Package（不可变）
  SKILL.md + agentloop.skill.json + agentloop.executors.json

Package/Runtime 外部存储（可审计、可版本化）
  SkillMetadataDraft
  SkillDeclarationAdaptation（准确绑定 packageSha256）
  SkillBinding（部署/Runtime 批准和环境引用）
```

三类 Skill 的落点：

| 形式 | declaration | draft/binding | 备注 |
|---|---|---|---|
| 内核 Bundled | 随 `@zhujun/agentloop-skills` 发布的 `agentloop.skill.json` | 官方默认 Binding + Host/Runtime 收紧配置 | 默认启用不等于绕过 readiness/grant |
| 云端 Custom Skills | 有维护者时放入 custom package sidecar；历史包由 Cloud Declaration Store 保存 hash-bound adaptation | Cloud Control Plane 的 Declaration/Binding Store | 不把部署策略写回包或 `SKILL.md` |
| 用户上传 Skill | 原始包只读；没有 sidecar 时由用户编辑产生外部 adaptation | Local Agent SQLite 或 Cloud Control Plane 的 Draft/Binding Store | 上传先是 `catalog-only`/`needs-binding`，明确激活后才进入 Runtime |

包内 declaration 是发布者声明的上限；外部 adaptation 只为没有原生 declaration 的准确 hash 提供适配，Binding 只能收紧。任何 native declaration 与外部 metadata 的冲突都 fail-closed，不设“以用户编辑为准”的隐式优先级。

`name`、`description` 是 package identity，metadata editor 只读展示；用户若要修改它们，必须生成新的 package revision/hash。列表可以保存外部 `displayLabel`，但不把它作为 Planner identity 或语义输入。

## 2. 当前基线

当前代码已经具备可复用的基础：

- `@zhujun/agentloop-skills` 通过 `bundledSkillDirectories()` 提供独立发布的 Bundled Skill；
- Runtime Host 将 bundled 目录和配置的 Custom 目录合并后调用 `SkillService.syncSkillDirectories()`；
- `packages/agentloop/src/skills/skill-package.ts` 负责包检查、hash、复制和旧 `agentloop:` frontmatter 解析；
- 当前 `skill-package.ts` 仍从 `SKILL.md` 读取 `agentloop:`，这只是迁移输入，不是目标存储方案；
- `packages/agentloop/src/skills/agentloop-metadata.ts` 定义当前角色、artifact、source、QA 和 evidence vocabulary；
- `agentloop.executors.json` 已经描述 package-owned action，但它目前与顶层 Skill metadata 存在 evidence 声明重复；
- `discovered_skills.agent_loop_json` 和 `SkillSummary.agentLoop` 仍是旧 projection，迁移期只能用于诊断/等价性快照，不能成为用户编辑 metadata 的存储；
- Planner、Admission 和 Runtime Service 已经消费 `skill.agentLoop`，但没有统一的编译产物；
- Custom Skill 目录和已发布 `custom-skills.zip` 的同步、重启和部署验证仍然是独立操作。

因此第一阶段应同时建立契约编译边界和用户上传的识别草稿边界。上传流程可以尽早可用，但上传结果必须停在可编辑草稿，不能把自动识别结果直接变成运行授权。

## 3. 分支边界

本分支允许：

- 新增 declaration、binding、readiness、resolved contract 的类型和解析器；
- 新增 legacy frontmatter 到 declaration 的迁移适配器；
- 为 bundled Skill 增加声明文件和默认 binding fixture；
- 逐步改造 Planner、Admission、Executor、Assessment 的读取边界；
- 增加用户上传、自动识别、metadata 草稿编辑、doctor/smoke-test 的端到端入口；
- 增加 contract hash、catalog revision 和 drift 检测所需的纯函数。

本分支暂不做：

- Marketplace、远程下载和自动更新；
- Skill 业务逻辑迁入 Kernel；
- MCP 协议实现下沉到 Kernel；
- 批量重写所有 Custom Skill 的业务说明；
- 组织级审批、多人协作编辑和远程发布中心；
- 将当前工作树里与本主题无关的部署、发布、Web 或数据迁移修改混入提交。

## 4. 阶段路线

### P0：建立基线和契约样本

目标：明确旧行为，防止迁移过程中把 selection、Admission 或 evidence 行为悄悄改变。

工作项：

1. 枚举 Bundled、Multi Runtime Custom 和测试 fixture 的 Skill 包、旧 metadata、executor manifest 和依赖图。
2. 选取代表性样本：无脚本 reference、Bundled builder、Custom local-script builder、API source provider、数据库 source provider、required Skill 组合。
3. 固化旧 frontmatter 解析结果、Planner role selection、planning capability 和 Admission 结果。
4. 检查顶层 `producesEvidenceKinds` 与 action-level evidence 的不一致。

产物：

- `packages/agentloop/tests/skill-contract-baseline.test.ts`；
- 一份可重放的样本 catalog fixture；
- 每个样本的旧行为快照和已知缺陷清单。

退出条件：迁移前后能够比较“角色、能力、required Skill 和 evidence producer”是否发生变化。

### P1：定义版本化 Declaration 和 Binding

目标：把 Package Declaration 与 Deployment Binding 变成可独立解析、可独立 hash 的对象。

建议新增：

```text
packages/agentloop/src/skills/skill-declaration.ts
packages/agentloop/src/skills/skill-binding.ts
packages/agentloop/src/skills/skill-contract-errors.ts
```

工作项：

1. 实现 `agentloop.skillDeclaration/v1` 解析和结构校验。
2. 规定 `SKILL.md` 只保留兼容性的 `name`/`description`，并校验它们与 declaration identity 一致。
3. 实现 Declaration/Adaptation Store：包内 declaration、cloud/user adaptation、legacy migration 必须有不同来源和状态。
4. 实现 `agentloop.skillBinding/v1` 解析和结构校验。
5. 约束 binding 只能收紧 declaration，不得新增 role、artifact/source kind 或不存在的 action。
6. 绑定 package name、package hash、declaration hash 和 publisher provenance。
7. 对 required Skill 建立名称解析和依赖环检测。
8. 统一稳定排序、规范化和错误码。

退出条件：缺少 declaration、hash 不匹配、action 不存在、binding 扩权、native/external metadata 冲突和依赖环都在编译前得到稳定错误；声明相同的输入产生相同 hash。

### P2：实现 ResolvedSkillContract 编译器

目标：生成 Planner、Admission 和 Executor 共同消费的唯一中间契约。

建议新增：

```text
packages/agentloop/src/skills/resolved-skill-contract.ts
packages/agentloop/src/skills/skill-contract-compiler.ts
packages/agentloop/tests/skill-contract-compiler.test.ts
```

编译输入：

- immutable package inspection；
- native declaration 或 hash-bound adaptation；
- executor manifest；
- Deployment Binding；
- Host capability profile；
- readiness attestation。

编译规则：

1. 无 native declaration 时，只允许使用绑定到准确 package hash 的 adaptation。
2. `approvedActions` 必须是 executor manifest action 的子集。
3. command、script、args 和 result schema 从 manifest 派生，binding 不重复覆盖。
4. evidence producer 从获批 action 和 Host capability 汇总。
5. `source_provider` 没有可验证 evidence producer 时拒绝生成 ready contract。
6. contract hash 只包含语义字段，不包含 `runtimeId`、检查时间或 readiness attestation ID。

退出条件：Bundled declaration、legacy frontmatter、第三方 adaptation 三种输入可以生成同一种 contract shape；编译器没有 Planner、Admission 或业务 Skill 特例。

### P3：用户上传、自动识别和 metadata 编辑

目标：让用户上传自己的 Skill 后，系统能够快速识别候选元数据，并提供可解释、可编辑、可校验的草稿，不要求用户直接编辑 YAML 或 JSON。

产品主链路：

```text
上传 Skill 包
  -> 包安全检查和 hash
  -> 结构化识别 declaration 草稿
  -> 用户编辑 metadata 和 action 绑定
  -> 预览 ResolvedSkillContract
  -> doctor / smoke-test
  -> 用户明确激活
```

自动识别分成两层：

1. 确定性识别：优先读取 `agentloop.skill.json`、`agentloop.executors.json`、文件结构和 package scripts，再读取 `SKILL.md` 兼容头部；只有没有 native declaration 时才读取旧 `agentloop:` frontmatter；
2. 语义建议：根据 Skill 名称、description、正文标题和示例提出 roles、artifact/source/QA、semantic tags 和 intent examples 候选，并保留置信度和推导依据。

编辑器至少支持：

- `roles`、`artifactKinds`、`sourceKinds`、`qaKinds`；
- `semanticTags`、`intentExamples`；
- required Skill；
- executor action 的启用/停用；
- configuration refs、MCP source refs 和已声明依赖；
- reference/builder/source/support/qa 模式；
- 每个字段的来源：包内声明、自动识别、用户修改或部署策略；
- 校验错误、冲突字段和仍需确认的高风险字段。

编辑器不能把以下内容交给自动识别直接确认：命令执行授权、网络访问、写入范围、secret、MCP 凭据和 evidence producer 的最终批准。用户可以编辑候选 declaration，但 action 授权仍需经过 Binding、doctor 和 Host policy。

建议新增对象：

```ts
interface SkillMetadataDraft {
  readonly schema: "agentloop.skillMetadataDraft/v1";
  readonly packageId: string;
  readonly packageName: string;
  readonly packageSha256: string;
  readonly ownerScope: string;
  readonly revision: number;
  readonly baseDeclarationSha256?: string;
  readonly status: "draft" | "needs_user_review" | "invalid" | "ready_to_validate";
  readonly fields: Readonly<Record<string, {
    readonly value: unknown;
    readonly origin: "package" | "detected" | "suggested" | "user" | "deployment";
    readonly confidence?: "high" | "medium" | "low";
    readonly editable: boolean;
    readonly evidence: readonly string[];
  }>>;
  readonly unresolved: readonly string[];
}
```

产物：上传 API、不可变原始包存储、草稿持久化、metadata editor、字段级校验、编辑后 contract preview 和脱敏诊断。编辑器只写外部 Draft/Adaptation，不回写 `SKILL.md`；用户取消编辑时只保留 `catalog-only` 包，不进入任何 Runtime 的可用 Skill 集合。

退出条件：一个只有 `SKILL.md` 的上传包能够生成外部草稿；用户可以修改角色、来源和 action；系统能清楚显示哪些字段是自动识别、哪些字段需要人工确认；草稿未激活前不进入 Planner，且原始包 hash 不因编辑而改变。

### P4：接入 SkillService 和 Runtime Catalog

目标：把 contract 编译放在 Skill 同步边界，形成可审计的 catalog revision。

涉及模块：

- `packages/agentloop/src/skills/skill-service.ts`；
- `packages/agentloop/src/skills/skill-package.ts`；
- `packages/agentloop/src/skills/skill-directory.ts`；
- Runtime Host 的启动同步路径；
- Skill discovery persistence 和 package store。

工作项：

1. `inspectSkillPackage()` 同时发现 native declaration、legacy frontmatter 和 executor manifest。
2. 将 package record 与 Declaration/Adaptation Store 的引用关联起来，不把用户编辑后的字段塞回 `discovered_skills.agent_loop_json`。
3. 将 `catalog-only`、`needs-binding`、`needs-runtime`、`ready`、`rejected` 写入 discovery projection。
4. 仅 `ready` contract 进入 Planner catalog；其他状态保留脱敏诊断。
5. 保存 package hash、declaration hash、binding hash、contract hash 和 catalog revision。
6. bundled 和 custom 继续走相同的 `syncSkillDirectories()`，来源只作为 provenance 保存。
7. 任何 package hash 或 declaration hash 变化都使旧 binding/readiness 失效。

退出条件：Runtime 启动能够明确报告每个 Skill 的状态和原因；未绑定或未 ready Skill 不会出现在 Planner candidates。

### P5：迁移 Planner、Admission 和 Executor

目标：删除运行边界对旧 `skill.agentLoop` 的直接依赖。

迁移顺序：

1. `skill-context.ts`：catalog 和 loaded Skill context 使用 resolved contract 投影。
2. `run-service.ts`：`selectPlanningSkillRoles()` 使用 contract 的 activation/workflow 字段。
3. `step-execution-binding.ts`：source provider capability 从 contract producer 派生。
4. `planner.ts`：required Skill、artifact/source/QA 和 evidence contract 使用 contract。
5. `admission.ts`：能力、action、required Skill 和 evidence contract 只从 contract 校验。
6. Executor/ToolRegistry：只能执行 contract 中 approved action，不能从文本或工具名补能力。
7. Assessment：QA 和 evidence contract 使用同一 contract snapshot。

迁移期允许保留 legacy 字段作为投影，但新消费者必须优先读取 resolved contract，并为旧/新结果增加等价性测试。

退出条件：删除一个 Skill 的旧 frontmatter 后，只要 declaration/binding 仍存在，Planner、Admission 和执行行为保持一致；没有任何运行边界为了兼容而重新解析原始 frontmatter。

### P6：迁移 Bundled Skills

目标：让官方 Skill 率先验证 schema 的通用性。

顺序建议：

1. `pptx`、`docx`、`xlsx`、`pdf` 等 artifact builder；
2. `canvas-design` 等带 executor 的 local-script Skill；
3. `webapp-testing`、`skill-creator` 等 support/QA 或复杂包；
4. 无脚本 reference Skill。

每个包增加：

```text
agentloop.skill.json
agentloop.executors.json（需要时）
官方默认 binding fixture
旧 frontmatter 与新 declaration 等价测试
```

退出条件：所有 bundled Skill 均可编译；官方包不需要 Planner、Admission 或 Executor 的特殊分支；官方默认 binding 仍可被 Host 收紧。

### P7：接入部署级 Custom 和第三方 Adapter

目标：提供快速扩展路径，同时保持包与授权分离。

工作项：

1. 实现包外 `<name>.agentloop.json` binding 的发现和 hash 校验。
2. 实现 `reference|builder|source|support|qa` 模板。
3. 实现 `inspect -> adapt -> doctor -> smoke-test -> activate` CLI，作为编辑器的批量和诊断入口。
4. Local Runtime 只加载当前 Runtime 显式选择的 Custom/上传 binding。
5. Cloud Host 使用部署级 binding，并在 catalog 中发布 contract hash。
6. 第三方包保留原始 bytes，adapter 只承担 declaration 和 binding 责任。

退出条件：编辑器保存的草稿和包外 binding 使用同一编译器；一个 source/executable 包必须经过 doctor、批准 action 和 readiness 才能进入 ready。

### P8：删除旧路径和发布收敛

目标：完成一次性迁移，避免双轨长期存在。

工作项：

- 删除 Planner、Admission、Executor 对旧 metadata 的直接读取；
- 删除向 `SKILL.md` 回写 AgentLoop metadata 的路径；
- 删除顶层 `producesEvidenceKinds` 与 action-level evidence 的重复事实源；
- 删除 legacy frontmatter 的长期 fallback，只保留明确迁移工具；
- 更新 Skill creator、包检查、部署脚本、README 和发布归档流程；
- 将 package hash、binding hash、contract hash 纳入 Runtime catalog drift 检查；
- 更新运行手册，明确 source/test、Host restart 和真实 Run 证明的差异。

退出条件：新包只需要 declaration/binding/manifest 这一套契约；旧格式继续存在会被诊断为迁移未完成，而不是被静默接受。

## 5. 第一开发迭代

第一迭代做 P0、P1、P2 和 P3 的最小闭环，目标是先固定 metadata 存储边界，再让用户上传后可以看到并编辑外部 metadata 草稿：

1. 定义 declaration、binding、readiness attestation 和 resolved contract 类型；
2. 定义包内 `agentloop.skill.json` 与 `SKILL.md` 兼容头部的一致性校验；
3. 建立 Declaration/Adaptation Store 和 `SkillMetadataDraft` 外部持久化；
4. 完成 legacy frontmatter adapter；
5. 完成 executor action 与 evidence producer 的单一汇总逻辑；
6. 编译一个 bundled builder、一个云端 custom source provider、一个用户上传无脚本 reference fixture；
7. 为 package hash、declaration hash、metadata 冲突和错误边界补充单元测试；
8. 增加最小上传 API、草稿持久化和 metadata editor；
9. 不让草稿进入 Planner，不改 Runtime 启动产品流程。

第一迭代的结果是一个可由后续消费者逐步接入的纯函数编译器，而不是一次性重写整个 Skill 系统。

## 6. 研发分支和提交纪律

分支：

```text
codex/unified-skill-contract-roadmap
```

建议后续按边界拆分提交：

```text
skill-contract: add declaration and binding schemas
skill-contract: compile legacy metadata and executor evidence
skill-contract: add resolved contract hash and compiler tests
skill-service: publish contract readiness and catalog revision
planner: consume resolved skill contracts
admission: enforce resolved contract capabilities
skills: migrate bundled declarations and bindings
runtime: add inspect doctor and smoke-test entrypoints
```

每个提交只包含一个可审阅边界。部署、生成归档、运行中 Host 重启和 Custom Skill zip 重建不应与 Kernel contract 提交混合。

当前工作树已有与本主题无关的修改和删除。本分支创建时保留它们，但后续提交只应显式选择本路线涉及的文件；不使用 `git add -A`，不把工作树全部修改视为本分支成果。

## 7. 验收矩阵

| 阶段 | 关注事实 | 必须有的证据 | 不能替代的证据 |
|---|---|---|---|
| P0 | 旧行为已量化 | fixture、快照、错误清单 | 设计文档本身 |
| P1 | schema 和边界可解析 | parser tests、稳定错误码 | JSON 能读取 |
| P2 | 编译结果一致且 fail-closed | compiler tests、hash tests | 某个 Skill 能加载 |
| P3 | 用户上传可识别且可编辑 | upload、draft、字段来源、编辑校验、contract preview | 文件上传成功 |
| P4 | Runtime catalog 正确 | readiness、catalog revision、状态投影 | 目录存在 |
| P5 | Planner/Admission/Executor 使用统一契约 | role、capability、action、evidence 回归测试 | typecheck 通过 |
| P6 | Bundled 迁移无语义漂移 | old/new equivalence、代表性 Run | 包构建成功 |
| P7 | Custom/第三方可快速接入 | inspect/doctor/smoke、hash-bound binding | adapter 文件存在 |
| P8 | 旧路径已退出 | 全局引用扫描、完整测试、发布包检查 | 说明文档更新 |

完整运行证明仍需单独记录：Host 重启、fresh Run、真实依赖连接、持久化事件、Assessment 和 TerminalCommitter 的最终结果。焦点测试通过不代表部署或生产已完成。

## 8. 风险与停止条件

遇到以下情况时暂停扩展范围，先修复契约边界：

- 为了迁移某个 Skill 需要在 Planner 或 Admission 增加业务名称特例；
- Binding 可以通过覆盖字段扩大 package declaration；
- evidence kind 只能靠模型描述或 action 成功日志证明；
- bundled Skill 需要绕过 readiness、sandbox 或 Run grant；
- contract hash 依赖 Host 本地路径、时间或 secret；
- 为了通过测试而删除 source evidence 要求或放宽 target/format guard；
- 旧 frontmatter 与新 declaration 不一致但系统选择“以旧值为准”继续运行。

这些情况说明第一处语义损失仍在契约边界，而不是说明需要更多兼容分支。

## 9. 完成定义

本路线完成时，以下链路应成立：

```text
immutable package
  -> declaration / adaptation
  -> binding
  -> manifest validation
  -> readiness attestation
  -> ResolvedSkillContract
  -> catalog revision
  -> Planner selection
  -> Admission binding
  -> Run/Step grant
  -> action evidence
  -> Assessment
  -> TerminalCommitter
```

其中任何一环缺失，都只能报告对应状态或错误，不能用“Skill 已发现”“脚本返回 0”“文件存在”推断最终完成。

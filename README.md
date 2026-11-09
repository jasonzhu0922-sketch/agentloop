# AgentLoop

AgentLoop source code is licensed under the [Apache License 2.0](LICENSE).
Earlier releases may remain available under their original licenses; see
[`LICENSING.md`](LICENSING.md) for the migration boundary and third-party
license details.

AgentLoop 是一个 Plan-first 的单 Agent Runtime。它围绕用户目标按需规划和执行多个 Round，每轮通过结构化 Plan 调度 Skill、Tool、Evidence 和 Assessment；目标完成由 Terminal Committer 基于权威状态提交，模型文本、Tool 成功、文件存在或 UI 事件本身都不能单独判定任务完成。

当前仓库是 npm workspaces monorepo：

```text
agentloop/
├── packages/agentloop/           Runtime 内核：planning/runtime/tools/storage
├── packages/agentloop-skills/    可发布的内置 Skills 包
├── packages/agentloop-identity/  独立账号权威与共享认证协议
├── packages/agentloop-plan-template/
│                                 可选的 Plan Template / fast-path 插件
├── apps/agentloop-multi-runtime/ 多 Runtime 参考应用：Web、Router、Runtime Host 与 Local Runtime Agent
├── apps/agentloop-desktop/       Desktop App：标准 Local Runtime 的独立本机宿主
├── apps/agentloop-account-service/ Desktop 独立云端账号服务（本机可联调）
└── docs/                         架构、集成、运维和设计文档
```

## 应用形态与定位

`packages/agentloop` 是可复用的 Runtime 内核；`apps/` 目录提供不同应用形态与部署拓扑，并不是同一个服务的不同开关。Desktop 开发态也使用真实账号流程；独立账号服务的启动、共享身份与部署边界见 [Account Service README](apps/agentloop-account-service/README.md)，本机应用见 [Desktop README](apps/agentloop-desktop/README.md)。

| 入口 | 定位 | 运行边界 | 适用场景 |
|---|---|---|---|
| [`apps/agentloop-desktop`](apps/agentloop-desktop/) | **Desktop App** | 独立的本机 Local Runtime 宿主，通过 Account Service 认证，账号数据和工作区保存在设备上；界面在浏览器中运行。 | 个人设备上的本机任务与目录操作。 |
| [`apps/agentloop-multi-runtime`](apps/agentloop-multi-runtime/) | **多 Runtime 参考应用** | Web 以同一会话工作台表达云端与已配对设备上的本机执行；Router 负责云端会话入口、附件与调度；多个 Runtime Host 分别加载内核并完整执行一个 Run，共享状态库和任务工作区。本机数据仍留在 Local Runtime Agent 的设备数据面。 | 需要按会话分流、扩展 Host 容量，或把控制面与执行面分离，同时保留受控本机执行的部署。 |

两者各自拥有入口、配置和运行数据。Multi Runtime 的一个 Run 始终由一个 Host 完整执行，不会将同一 Run 的 Plan 或 Step 拆到多个 Host，也不支持运行中的 Run 在 Host 间迁移。云端与本机的统一交互不会隐式同步附件、目录或工作区；云端 `attachmentIds` 与设备 `localUploadedSourceIds` 是两条受控数据面。第三方业务系统应依赖 `@zhujun/agentloop` 内核包，而不是把应用当作 SDK。

Multi Runtime 采用独立进程边界：`Router API` 只负责 HTTP 接入、身份、会话、附件、Assignment 和 Runtime 控制；`RouterService` 负责调度、容量、状态观察和持久化端口编排；`Runtime Host API` 只接收 Router 的受控 dispatch，并由 `RuntimeHostService` 驱动 AgentLoop 内核完整执行 Run；`Local Runtime Agent API` 只负责设备侧配对、目录授权、上传源、子 Runtime 生命周期和本机 Run。Router 与 Runtime Host 通过版本化的 `src/shared/contracts.ts` 交互，Router 不直接导入 Host 实现，Host 也不直接导入 Router 实现；Local Runtime Agent 只依赖共享契约和内核，不依赖云端角色。

Multi Runtime Web 是其业务工作台，但不是执行权威。本机 Runtime 的选择、目录授权、上传和执行展示通过 Router 的受控设备接口或明确的 `strict_local` loopback 路径访问 Local Runtime Agent。Desktop 则是独立宿主，不依赖 Router 或设备配对。

可按下文启动 Desktop App 或 Multi Runtime 本地拓扑；分角色启动和部署方式见 [Multi Runtime README](apps/agentloop-multi-runtime/README.md)。

## 核心机制

AgentLoop 的执行链路是：

```text
登录用户任务
→ Skill 目录选择
→ Goal Loop：为当前 Round 制定 Capability-first Plan
→ Plan Admission / StepExecutionBinding
→ 依赖调度
→ Step Agent Loop
→ Computer / Plugin Tools
→ Canonical Evidence
→ Success Criteria + Skill Compliance Assessment
→ 修复或进入下一 Step
→ Round Result + 目标进展评估
→ 目标仍开放：基于结果规划下一 Round / 目标满足：Terminal Committer
```

### GoalPlan：渐进式 Round 与 Steer

- `CanonicalRunState` 维护整个 Run 的目标、约束和进展；Plan 表达当前 Round 的策略，Result 记录事实，Assessment 判断完成情况。多 Step 本身不等于多 Round。
- `RoundScope` 区分 `prerequisite` 和 `delivery`：研究轮先取得有明确完成边界和后续用途的证据，不必猜测完整交付计划；交付轮承担当前范围内的交付。每轮形成正式 Result，后轮通过显式绑定复用结果；未满足的全局目标保持开放。
- Round 完成后评估目标与开放事项，必要时启动下一轮。累计预算和无进展判定跨轮延续；仅有新 Plan 或新 Result ID 不证明进展。预算耗尽或停滞时保留部分成果和开放事项。
- 活动 Run 中发送的输入先进入会话草稿队列，点击 **Steer** 才提交给 Run。Runtime 持久化消息，并在规划、模型与工具、Step、Round 和终态等安全边界处理；进度问答保留原目标，明确的目标调整经过修订与重新准入。已发生的工具动作和回执保留，不因修订自动重放。需要澄清时进入持久化的人机交互流程。

设计与实现、升级和验收边界分别见 [GoalPlan 与 Steer 设计](docs/GOALPLAN-STEER-DESIGN.md)及[实现记录](docs/GOALPLAN-STEER-IMPLEMENTATION.md)。

### 单个 Step 的执行闭环

依赖调度选中一个依赖已满足的叶子 Step 后，Runtime 在该 Step 内运行一个有明确完成边界的闭环：

```text
领取依赖就绪的 Step
→ 建立执行上下文与 Run 授权快照
→ 模型提出 Tool 调用或完成候选
→ Tool 返回 Canonical Evidence
→ 证据进入下一模型回合
→ Success Criteria + Skill Compliance Assessment
→ 完成当前 Step / 注入反馈定向修复 / 进入 Recovery
```

其中各层职责明确分离：

1. **Dependency Scheduler** 只选择尚未完成、依赖均已满足的 leaf Step；没有就绪 Step 的未完成 Plan 会被拒绝，避免死锁。
2. **Runtime Context** 为当前 Step 注入目标、依赖产物、成功标准、证据契约、可见目录、上传资源和关联 Skill。
3. **Capability Grant** 以 Run 级用户授权为工具执行边界（包括危险工具开关）；`StepExecutionBinding` 指引当前目标、优先能力和证据要求，但不会撤回已获 Run 授权的工具。上传资源、可见目录和 Skill 指令仍按 Step 隔离。
4. **Step Agent Loop** 在有界模型回合中执行“模型 → Tool → Evidence → 下一回合”。模型或 Tool 都不能自行把 Step 标记为完成。
5. **Tool / Action** 先经参数与授权校验，再持久化执行 Action；Tool 只返回结果、收据、诊断和副作用事实。
6. **Canonical Evidence** 将每个 Tool 结果持久化并投影给下一回合；成功 `load_skill` 会记录该 Skill 的激活证据。
7. **Assessment** 对完成候选核对 Success Criteria、证据契约、产物收据和已激活 Skill 的合规性；通过后才完成 Step。
8. **Repair / Recovery** 评估不通过时，把失败边界和反馈注入当前 Step 做有界修复；仍无法满足时进入 Recovery 或 Plan Revision，而不是以模型文本或文件存在冒充成功。

### Step Agent Loop 的两阶段推进

这里的“两阶段”发生在**同一个已准入的 Plan Step 内**，不是把任务强制拆成两个 Plan Step，也不是让当前 Step 提前执行下游 Step。Runtime 在每个模型回合生成一个紧凑的 `loopStepFrame`，把该回合组织为：

```text
阶段一：Current Stage
  根据当前证据状态选择唯一优先动作
  （采集来源证据 / 产出或修复产物 / 验证既有产物 / 补齐证据 / 提交完成候选）
→ 阶段二：Next Stage
  仅声明进入下一动作的触发条件与目标，并交接可复用证据
→ 下一模型回合重新根据最新 Canonical Evidence 决策
```

- `RuntimeStepEvidenceState` 从已持久化的 Tool Evidence 派生 `nextAction`、缺失证据、产物状态、诊断和可用工具类别；它只投影继续当前 Step 所需的紧凑状态，而非重放完整历史。
- 当前阶段优先推进证据缺口：已有明确诊断时允许读取必要上下文、修复、重跑或验证；不会因为已存在中间文件就一概禁止写入或修复。无关的重复浏览、搜索或读取仍会被进度策略拒绝。
- 下一阶段只在其触发条件满足后才成为新的当前阶段；`handoffContract` 保留可复用输出并禁止重复动作。它不能越过当前 Step 的成功边界，也不能替代 Dependency Scheduler 对下游 Plan Step 的调度。
- 收敛或没有可用 Tool 时，Loop 切换为 `terminal_candidate`，由 Assessment 决定完成或返回定向修复，而不是由模型自行宣布成功。

当前 Round 的 leaf Step 完成后评估目标进展；只有满足整个 Run 的终态条件，才由 **Terminal Committer** 提交 Delivery 与 Outcome。

多 Runtime 部署下，Router 将不同用户的不同会话任务分派给不同的、各自加载 AgentLoop 内核的 Worker；单个任务仍由一个 Worker 完整执行，不拆分其 Plan 或 Step。设计见 [MULTI-RUNTIME-LOAD-BALANCING-DESIGN.md](docs/MULTI-RUNTIME-LOAD-BALANCING-DESIGN.md)。

主要能力：

- 多用户注册、登录、注销；密码和会话 Token 只保存摘要。
- 用户私有 Skill，支持内联定义或完整 Package 导入。
- 内置 Skills 独立在 `@zhujun/agentloop-skills` 包中发布和发现。
- Capability-first Planner：Planner 只声明 `requiredCapabilities`，Admission 解析为 StepExecutionBinding；Runtime 再在 Run 授权范围内物化执行工具。
- 可选 MCP ToolSource：宿主可用别名和 capability 注册外部来源，仍由 Admission、Step binding 与危险工具授权统一约束。
- Computer Tool 支持目录、读文件、文本搜索、写文件、命令执行和可插拔 GUI/浏览器驱动。
- 危险 Tool 默认开启；需要受限执行时，Run/Batch 可显式设置 `allowDangerousTools: false`。
- SQLite 持久化 Run、Plan、Step、Evidence、Assessment、Outcome、Batch 和 Event。
- React + Vite Web 前端展示聊天、实时进度、Plan 和最终结果。
- Responses Provider 的 reasoning summary 会在 Run 进行中实时展示；最终回复出现后不再渲染该实时面板。
- 可选 Plan Template 插件用于观察历史 Run、挖掘候选模板和启用低风险 fast-path。

## 快速启动：Desktop App

要求 Node.js 26+ 和本机 Python 3。在仓库根目录执行：

```bash
npm install
npm run build
npm run build:desktop
npm run start:desktop
```

启动器先启动本机 Account Service，再启动 Desktop；访问 `http://127.0.0.1:8796/`，注册或登录后在设置中添加模型 Provider、API Key 和模型，再显式选择模型开始任务。开发实例默认使用独立数据目录；启动参数、账号隔离、模型配置和打包说明见 [Desktop README](apps/agentloop-desktop/README.md)。当前根目录 `npm run build` 仍包含旧应用的 Web 构建；删除旧应用时需同步调整该脚本及其他依赖它的工作区脚本。

## 快速启动：agentloop-multi-runtime（多 Runtime）

要求 Node.js 26 或更高版本，且根目录已执行过 `npm install`。本地启动器会先重启并等待本机 Account Service 的健康检查，然后启动一个 Router、一个 Web 和两个 Runtime Host；Provider 密钥仅传给 Runtime Host，不会传给 Router 或 Web。Local Runtime Agent 是独立的设备进程，不会被云端拓扑隐式启动。

1. 创建多 Runtime 自有的 Provider 配置和本地密钥文件：

```bash
cp apps/agentloop-multi-runtime/config/llm-providers.example.json \
  apps/agentloop-multi-runtime/config/llm-providers.json
cp apps/agentloop-multi-runtime/.env.example \
  apps/agentloop-multi-runtime/.env
```

2. 编辑 `apps/agentloop-multi-runtime/config/llm-providers.json` 中的 Provider、Base URL、默认模型和 `apiKeyEnv`；在 `apps/agentloop-multi-runtime/.env` 填入该变量对应的密钥（例如 `OPENAI_API_KEY`）。不要把密钥写入 JSON 配置或提交到 Git。

3. 从仓库根目录启动：

```bash
npm run start:multi-runtime
```

默认 Web 地址为 `http://127.0.0.1:5174/`，Router API 为 `http://127.0.0.1:8788/`。以 4 个 Host 启动：

```bash
npm run start:multi-runtime -- --runtimes 4
```

可用 `RUNTIME_COUNT=4`、`--runtime-count 4` 或 `-n 4` 指定 Host 数量。`Ctrl-C` 会同时停止启动器创建的所有进程；端口冲突时可通过 `PORT`、`WEB_PORT` 和 `RUNTIME_BASE_PORT` 覆盖默认值。分角色启动、Docker Compose、共享 PostgreSQL/POSIX workspace 等部署方式见 [Multi Runtime 运行说明](apps/agentloop-multi-runtime/README.md)。

如需启用本机 Runtime，另行启动设备侧 Agent：

```bash
npm run start:local-agent --workspace agentloop-multi-runtime
```

它默认监听 loopback `127.0.0.1:8790`，拥有独立的设备身份、Supervisor 数据库、目录授权和本机 Runtime 状态；不要向它传递 Router/云端 Host 的 PostgreSQL、TiDB 或共享状态凭据。浏览器通过配对后的 Router 控制面使用普通 `local` 路径；只有明确的严格本地入口才使用 `strict_local`。

## 本地数据与配置

Desktop 按账号隔离本机 Run、附件、工作区及模型等配置。macOS 开发数据默认位于 `~/Library/Application Support/AgentLoop Desktop Development`；可通过 `--data-dir` 指定独立目录。模型和搜索凭据在 Desktop 设置中配置并保存在账号本机密钥库中。账号服务本机联调数据、Multi Runtime 的 `.env`、Provider 配置、数据库、附件和工作区也属于本地状态，不应提交 Git。详细路径与安全边界见 [Desktop README](apps/agentloop-desktop/README.md) 和 [Multi Runtime 运行说明](apps/agentloop-multi-runtime/README.md#存储模式切换)。

Provider 配置不应包含密钥值；部署环境使用对应的密钥管理方式。推送前可检查 `git status --short --untracked-files=all` 和已跟踪文件，确认没有误提交本地状态。

## Skills

内置 Skills 位于 `packages/agentloop-skills/skills/`，由 `@zhujun/agentloop-skills` 通过 `bundledSkillDirectories()` 暴露给宿主，例如 `presentation-skill`、`xlsx`、`pdf`、`docx`、`frontend-design` 等。

Skill 加载边界：

- Planner 初始只看到 Skill 名称、描述、版本和位置。
- Skill 正文只在对应 Step 通过 `load_skill` 进入上下文。
- Assessment 对照同一版本 Skill 原文和运行证据判断是否满足。
- Package 导入会复制到用户隔离的只读 store，并在关键执行点复核 hash。

更多 Skill 设计见 [APP-DEVELOPMENT-GUIDE.md](docs/APP-DEVELOPMENT-GUIDE.md) 和 [INTEGRATION.md](docs/INTEGRATION.md)。

## Plan Template 插件

`packages/agentloop-plan-template/` 是可选的独立规划扩展，由宿主显式配置和启用。离线挖掘产生候选模板，需要显式审核后才能启用；使用方式见 [插件 README](packages/agentloop-plan-template/README.md)。

## API 与集成

Desktop 的本机 API 和账号边界见 [Desktop README](apps/agentloop-desktop/README.md)，Multi Runtime 的接入与部署见 [Multi Runtime README](apps/agentloop-multi-runtime/README.md)。第三方宿主可直接集成 headless 内核，参见 [内核 README](packages/agentloop/README.md) 和 [集成指南](docs/INTEGRATION.md)。

## 常用脚本

```bash
npm run build
npm run build:kernel
npm run build:skills
npm run build:plan-template
npm run test                         # 内核、宿主与 Multi Runtime 契约测试
npm run test:unit
npm run test:kernel
npm run test:multi-runtime:contracts
npm run test:all-workspaces          # extended workspace suites
npm run typecheck
npm run build:desktop
npm run start:desktop
npm run test:desktop
npm run start:multi-runtime
npm run start:multi-runtime -- --runtimes 4
```

## 上游来源

AgentLoop 的 Runtime 设计参考并源码级核验了：

- PI Agent `58302d34e703e0453ea13bdd10c7e423589ce177`
- OpenCode `4d68d30b48a99379b2baaf597dbad576707ea36d`
- DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`

完整映射见 [UPSTREAM-RESEARCH.md](docs/UPSTREAM-RESEARCH.md)，第三方许可见 [THIRD_PARTY_NOTICES.md](packages/agentloop/THIRD_PARTY_NOTICES.md)。

## 部署边界

Desktop App 是独立本机宿主，使用账号隔离的本机数据和工作区；开发态使用本机 Account Service，正式账号服务与安装包有各自的部署验收边界。Multi Runtime 提供 Router、独立 Runtime Host 和设备侧 Local Runtime Agent；生产多副本需要共享状态库和工作区、fenced lease、独立 Worker 以及受部署环境管理的鉴权与密钥。本机 Local Runtime 数据不与云端状态库混用。SQLite 不适合放在 NFS/RWX 卷上供多节点共享。

详细架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

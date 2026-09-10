# AgentLoop

AgentLoop 是一个 Plan-first 的单 Agent Runtime。它把用户任务先转成结构化 Plan，再按 Step 调度 Skill、Tool、Evidence、Assessment 和 Terminal Committer；模型文本、Tool 成功、文件存在或 UI 事件本身都不能单独判定任务完成。

当前仓库是 npm workspaces monorepo：

```text
agentloop/
├── packages/agentloop/           Runtime 内核：planning/runtime/tools/storage
├── packages/agentloop-skills/    可发布的内置 Skills 包
├── packages/agentloop-plan-template/
│                                 可选的 Plan Template / fast-path 插件
├── apps/agentloop-app/           参考应用：HTTP API、登录鉴权、React Web
├── apps/agentloop-multi-runtime/ 多 Runtime Web、Router、Host 的参考设计与构建模块
└── docs/                         架构、集成、运维和设计文档
```

## 核心机制

AgentLoop 的执行链路是：

```text
登录用户任务
→ Skill 目录选择
→ Capability-first Outcome Plan
→ Plan Admission / StepExecutionBinding
→ 依赖调度
→ Step Agent Loop
→ Computer / Plugin Tools
→ Canonical Evidence
→ Success Criteria + Skill Compliance Assessment
→ 修复或进入下一 Step
→ Terminal Committer
```

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

全部 leaf Step 完成后，才由 **Terminal Committer** 提交整个 Run 的 Delivery 与 Outcome。

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

## 快速启动

要求 Node.js 26 或更高版本。

1. 安装根依赖：

```bash
npm install
```

2. 安装 Web 前端依赖：

```bash
cd apps/agentloop-app/web
npm install
cd ../../..
```

3. 创建本地配置文件：

```bash
cp apps/agentloop-app/.env.example apps/agentloop-app/.env
cp apps/agentloop-app/config/llm-providers.example.json apps/agentloop-app/config/llm-providers.json
```

4. 编辑本地配置：

- 在 `apps/agentloop-app/config/llm-providers.json` 中配置 Provider、Base URL、默认模型和公开的 `modelKey`。
- 在 `apps/agentloop-app/.env` 中填写对应的环境变量值，例如 `MY_LLM_API_KEY` 或 `OPENAI_API_KEY`。
- `LLM_PROVIDER_CONFIG_PATH` 默认指向 `./config/llm-providers.json`。
- 可选 MCP 来源在 `apps/agentloop-app/config/mcp-servers.json` 中注册；认证信息通过 `secretEnv` 引用 `.env` 或部署环境变量，不能写入注册文件。

5. 初始化空 SQLite 数据库：

```bash
npm run init-db
```

6. 启动开发模式：

```bash
npm run dev
```

打开 `http://localhost:5173/` 使用 Web 前端。后端 API 默认在 `http://127.0.0.1:8787`，开发脚本会自动选择可用端口并配置前端 CORS。

只启动 API：

```bash
npm start
```

## 本地数据与 Git 边界

仓库只提交源码、示例配置和文档，不提交本机运行数据。

这些文件和目录是本地状态，已被 `.gitignore` 排除：

```text
apps/agentloop-app/.env
apps/agentloop-app/config/llm-providers.json
apps/agentloop-app/data/
apps/agentloop-app/conversations/
apps/agentloop-app/uploads/
apps/agentloop-app/outputs/
apps/agentloop-app/workspace/
data/
conversations/
uploads/
outputs/
node_modules/
dist/
```

默认数据库路径是 `apps/agentloop-app/data/agentloop.db`。数据库文件不进入 Git；新用户通过 `npm run init-db` 创建空库，启动服务时也会复用 Runtime 的迁移逻辑补齐表结构。

Provider JSON 只保存 Provider 类型、地址、模型和 `apiKeyEnv` 变量名；密钥值放在本地 `.env` 或部署环境变量中，不写入 JSON、SQLite 或 Run 记录。

推送前可以检查是否误跟踪了本地状态：

```bash
git status --short --untracked-files=all
git ls-files | rg '(^|/)\.env$|\.db$|llm-providers\.json|conversations|uploads|outputs|workspace'
```

第二条命令如有输出，应先确认是否需要从索引移除。

## 运行配置

参考应用读取 `apps/agentloop-app/.env`。常用变量：

| 变量 | 说明 |
|---|---|
| `PORT` / `HOST` | API 监听端口和地址 |
| `WEB_ORIGINS_JSON` | 允许跨域访问 API 的前端 Origin 列表 |
| `DATABASE_PATH` | SQLite 数据库路径，默认 `./data/agentloop.db` |
| `WORKSPACE_ROOT` | Run 工作区根目录，默认 `./workspace` |
| `SESSION_TTL_HOURS` | 登录会话有效期 |
| `LLM_PROVIDER_CONFIG_PATH` | Provider 注册表路径 |
| `STEP_EXECUTION_STRATEGY_CONFIG_PATH` | 可选 Step 执行策略配置路径；未设置时读取 `./config/step-execution-strategy.json`，缺失时使用 `full-catalog` |
| `CUSTOM_SKILL_DIRECTORIES_JSON` | 额外 Skill 根目录列表 |
| `SKILL_IMPORT_ROOTS_JSON` | 允许导入 Skill Package 的服务端目录 |
| `TRUSTED_EXECUTABLE_ALIASES_JSON` | 可暴露给 Computer Tool 的受信任命令别名 |
| `TRUSTED_COMMAND_ENV_JSON` | 注入受信任命令的非敏感环境变量 |

`mcp-servers.json` 是可选的宿主侧 ToolSource 注册表。每个服务可声明 `aliases` 与 `capabilities`，让 Planner 按来源能力规划；Admission 再将其绑定到当前 Step 的实际工具。服务认证使用 `secretEnv` 指向环境变量，密钥不应进入该文件、SQLite 或 Run 记录。

Responses 协议的 Provider 或模型可设 `reasoningSummary: "auto"`。服务会在 Run event stream 中向所有者保留 Provider 返回的 reasoning 内容，Web 前端只在 Run 活跃时显示它，并在最终回答取代实时卡片后隐藏。

Step 执行策略可控制工具目录投影与提示上下文；它提供进度建议，不会构成第二套授权边界。工具是否可用由 Run Capability Grant 和 ToolRegistry 决定；StepExecutionBinding 则约束当前目标、证据契约及 Step 资源范围。

`CUSTOM_SKILL_DIRECTORIES_JSON=["./custom-skills"]` 会把 `apps/agentloop-app/custom-skills/` 作为额外 Skill 根目录。当前参考应用保留了：

- `review-contract`
- `statistical-analysis`

## Skills

内置 Skills 位于 `packages/agentloop-skills/skills/`，由 `@zhujun/agentloop-skills` 通过 `bundledSkillDirectories()` 暴露给参考应用。当前内置目录包含 18 个 Skill Package，例如 `presentation-skill`、`xlsx`、`pdf`、`docx`、`frontend-design`、`web-artifacts-builder`、`explore-data` 等。

Skill 加载边界：

- Planner 初始只看到 Skill 名称、描述、版本和位置。
- Skill 正文只在对应 Step 通过 `load_skill` 进入上下文。
- Assessment 对照同一版本 Skill 原文和运行证据判断是否满足。
- Package 导入会复制到用户隔离的只读 store，并在关键执行点复核 hash。

更多 Skill 设计见 [APP-DEVELOPMENT-GUIDE.md](docs/APP-DEVELOPMENT-GUIDE.md) 和 [INTEGRATION.md](docs/INTEGRATION.md)。

## Plan Template 插件

`packages/agentloop-plan-template/` 是独立的可选规划扩展。参考应用通过 `PLANNING_EXTENSIONS_CONFIG_PATH=./config/planning-extensions.json` 显式启用，不默认改写 Planner 行为。

示例配置：

```bash
cp apps/agentloop-app/config/planning-extensions.example.json apps/agentloop-app/config/planning-extensions.json
cp apps/agentloop-app/config/plan-template.defaults.example.json apps/agentloop-app/config/plan-template.defaults.json
```

常用命令：

```bash
npm run mine --workspace @zhujun/agentloop-plan-template -- --config apps/agentloop-app/config/plan-template.defaults.json
npm run templates --workspace @zhujun/agentloop-plan-template -- list --config apps/agentloop-app/config/plan-template.defaults.json
```

更多操作见 [PLAN-TEMPLATE-OPERATIONS.md](docs/PLAN-TEMPLATE-OPERATIONS.md)。

## API

参考应用提供纯 HTTP API，主要路径：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/v1/auth/register` | 注册并签发会话 |
| `POST` | `/v1/auth/login` | 登录 |
| `POST` | `/v1/auth/logout` | 注销 |
| `GET` | `/v1/me` | 当前用户 |
| `GET/POST` | `/v1/skills` | 私有 Skill 列表和创建 |
| `GET` | `/v1/skills/discovered` | 服务端已发现 Skill 目录 |
| `POST` | `/v1/skills/import-directory` | 从批准目录导入 Skill Package |
| `GET` | `/v1/tools` | 当前部署的 Tool 目录 |
| `POST` | `/v1/runs` | 执行一个 Plan-first Run |
| `GET` | `/v1/runs/:id` | 读取 Run 权威状态 |
| `GET` | `/v1/runs/:id/plan` | 读取 Plan、Step、Evidence、Compliance |
| `GET` | `/v1/runs/:id/events` | 读取 Run 事件 |
| `GET` | `/v1/conversations` | 当前用户会话列表 |
| `GET` | `/v1/conversations/:id` | 单个会话和轮次 |
| `POST` | `/v1/batches` | 创建并执行批次 |
| `GET` | `/v1/batches/:id` | 批次汇总 |
| `GET` | `/v1/batches/:id/items` | 批次逐项结果 |

外部宿主集成可使用 `/v1/host/protocol`、`/v1/host/runs`、`/v1/host/runs/async` 和 host event stream。详见 [INTEGRATION.md](docs/INTEGRATION.md)。

## 常用脚本

```bash
npm run build
npm run build:kernel
npm run build:skills
npm run build:plan-template
npm run build:web
npm run test
npm run typecheck
npm run init-db
npm run dev
npm start
```

## 上游来源

AgentLoop 的 Runtime 设计参考并源码级核验了：

- PI Agent `58302d34e703e0453ea13bdd10c7e423589ce177`
- OpenCode `4d68d30b48a99379b2baaf597dbad576707ea36d`
- DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`

完整映射见 [UPSTREAM-RESEARCH.md](docs/UPSTREAM-RESEARCH.md)，第三方许可见 [THIRD_PARTY_NOTICES.md](packages/agentloop/THIRD_PARTY_NOTICES.md)。

## 部署边界

当前参考应用适合单节点本地或内网部署：SQLite、单进程 API、同步 Run、Vite 前端独立托管。生产多副本部署建议替换为 PostgreSQL、队列、fenced lease、独立 Worker、HttpOnly Cookie、CSRF/OIDC/MFA，并把不可信命令放入容器或 WASM Sandbox。

详细架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

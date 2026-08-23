# AgentLoop

AgentLoop 是一个从 PI Agent、OpenCode 和 DeepSeek Harness 固定提交进行源码级移植，并加入 Plan-first、私有 Skill、多用户登录、会话式单 Agent 执行、Computer Tool 与批次调度的智能体框架。

当前主链不是“模型一直 ReAct，直到它说完成”，而是：

```text
登录用户任务
→ Skill 选择
→ 结构化 Plan
→ Admission / Skill-Step Binding
→ 依赖调度
→ 当前 Step Agent Loop
→ Computer / Plugin Tools
→ Canonical Evidence
→ Success Criteria + Skill Compliance Assessment
→ 同一步修复或继续下一步
→ Terminal Commit
```

Tool 成功、模型文本、Artifact 或事件 Trace 都不能单独建立完成；只有所有 Plan Step 均有通过的持久评估时，Terminal Committer 才能提交 `Run.completed`。

## 已实现功能

- 用户注册、登录、注销；密码和会话 Token 只保存摘要。
- 用户级私有 Skill，支持内联定义或完整 Package；Package 原样复制到用户隔离的只读存储，并锁定来源提交与全包 hash。
- `ModelPlanner` 强制模型调用结构化 `submit_plan`；Markdown/纯文本计划失败关闭。
- DAG Admission：校验未知依赖、环、Skill 选择与 Step 绑定、Plan 声明的 Tool 可用性，并只为 Skill-bound Step 加入通用 `load_skill` 激活能力。
- 依赖感知调度；每个 Step 单独物化 Capability Grant、Skill 目录和 Tool Schema，Skill 正文只能经 `load_skill` ToolResult 进入当前对话。
- 候选完成评估、Skill Compliance 持久化、评估不通过后的同一步修复循环。
- Terminal Committer 唯一提交完成或失败 Outcome。
- 单 Agent 会话执行：服务端使用固定 persona 驱动每个 Run，没有 Agent 定义、Skill 绑定或委派；后续轮次通过 `conversationId` 继承同一会话上下文，工具集只由 `allowDangerousTools` 门控。
- Computer Tool：目录、读文件、文本搜索、写文件、无 Shell 命令执行；每个会话固定使用 `WORKSPACE_ROOT/conversations/<conversationId>`，同会话多轮复用该目录，不同会话物理隔离；GUI/浏览器通过 `ComputerDriver` 插件接入。
- Workspace containment、会话目录隔离、符号链接逃逸防护、命令参数数组、超时/强杀、输出上限。
- 写文件、命令执行、点击/输入/导航等危险 Tool 默认不授权，Run/Batch 必须显式 `allowDangerousTools`。
- Batch 一等实体：`Batch → BatchItem → Run → Plan`，支持 1–32 并发、幂等键、`continue`/`fail-fast` 和逐项结果。
- 登录后用户级 Web 前端（独立 React + Vite 应用，位于 `web/`）：对话式智能助手（聊天、实时进度、计划与最终结果），支持在同一个对话流里连续下达多轮指令（后续 Run 会把此前轮次作为上下文喂给 Planner 与执行模型）。后端作为纯 HTTP API 对外服务。
- OpenAI-compatible Model；所有 Provider Adapter 进入同一条结构化 Plan-first 主链。
- SQLite 权威 Plan/Step/Evidence/Assessment/Outcome/Batch/Event 存储。

## 上游移植

- PI Agent `58302d34e703e0453ea13bdd10c7e423589ce177`：Loop 结构、Skill 目录/正文渐进披露、并行执行后按模型调用顺序回填、截断 Tool Call 拒绝和有界并发映射。
- OpenCode `4d68d30b48a99379b2baaf597dbad576707ea36d`：权限过滤的 Skill 目录、`skill` Tool 正文加载、每个模型步骤重新物化 Tool 快照和 Tool 注册身份边界。
- DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`：独占 Tool 屏障、有界并发结算、子 Agent 深度和由子 Run 自身终态决定结果。

完整源码映射见 [上游核验](docs/UPSTREAM-RESEARCH.md)，MIT 归属见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

## 快速启动

要求 Node.js 26 或更高版本，无第三方运行时依赖。

```bash
npm test
npm start
```

后端现在只暴露纯 HTTP API（`/healthz` 与 `/v1/*`），不再托管前端页面。面向用户的对话式智能助手是独立的 React + Vite 前端，位于 `web/`。开发模式分两个进程启动：

```bash
# 终端 1：启动 API
npm start

# 终端 2：启动前端开发服务器（自动代理 /v1/* 到 8787）
cd web && npm install && npm run dev
```

然后打开 `http://localhost:5173/` 即可使用。登录后输入任务即可开始对话，界面展示实时进度、Plan 与最终结果。默认数据库是 `./data/agentloop.db`。`WORKSPACE_ROOT` 默认是启动目录，服务会为每个会话创建独立的 Computer Tool 根目录 `WORKSPACE_ROOT/conversations/<conversationId>`：

```bash
WORKSPACE_ROOT=/absolute/workspace DATABASE_PATH=./data/agentloop.db npm start
```

生产部署时，先 `cd web && npm run build` 产出 `web/dist`，再用任意静态服务器托管该目录，并把 `WEB_ORIGINS_JSON`（后端 `.env`）配置为前端的 Origin 以允许跨域 API 调用；或通过反向代理把 `dist/` 与 `/v1/*` 放在同一 Origin 下。

LLM Provider 由服务端 JSON 注册表配置，服务端按注册表决定 Run 使用的默认 Provider，模型 ID 可覆盖该 Provider 的默认模型；Run API 不能传任意 Base URL、密钥或超时参数。当前注册表支持 `openai-compatible` Adapter（例如 DeepSeek、OpenAI-compatible 网关和本地兼容服务），后续 Provider 以新的 Adapter 接入，不改变 Runtime 主链。

先复制 [llm-providers.example.json](config/llm-providers.example.json) 为被 `.gitignore` 排除的 `config/llm-providers.json`，填写 Provider 类型、地址和默认模型；再把 `apiKeyEnv` 指向的 Key 写入本机 `.env` 或部署环境。`npm start` 会在 `.env` 存在时自动加载它，部署环境已注入的同名变量保持优先。模板不包含任何密钥：

```bash
cp config/llm-providers.example.json config/llm-providers.json
# 编辑 config/llm-providers.json，并在 .env 或部署环境中设置：
export MY_LLM_API_KEY=server-secret
LLM_PROVIDER_CONFIG_PATH=./config/llm-providers.json \
npm start
```

每个 Provider 的 `apiKeyEnv` 只保存环境变量名，密钥本身不进入 JSON 配置、SQLite 或 Run 记录。可选字段 `maxAttempts`（1–5）和 `retryDelayMs`（0–30000）控制单个模型请求的重试；其余省略项采用 `128000 / 8192 / 120000 / 3 / 250` 的默认值。HTTP `400` 与 `408/429/5xx` 一样按同一预算重试（默认最多 3 次尝试），每次重试都会持久化为 `model.retry` 事件并在 Web 前端实时显示「正在重试（N/M）」。默认 `toolChoiceMode` 为 `native`；对于 DeepSeek Thinking 一类会拒绝 `required` 或命名函数选择、但支持 `auto` 的 Provider，设为 `constrained-as-auto`。该策略只转换上游 wire-protocol；Runtime 仍然拒绝遗漏的必需 Skill 加载、Plan 或 Assessment。

模型 profile 可以覆盖 Provider 的默认协议、工具选择模式与上限。需要使用 GPT5.6 时，在 `models` 中注册 `gpt-5.6`，把 `providerModel` 设为 `gpt-5.6`，并声明 `protocol: "responses"`；如果兼容网关拒绝命名函数选择，同时声明 `toolChoiceMode: "constrained-as-auto"`。Adapter 会使用该模型 profile 调用 Provider 的 `/responses` 端点，Run 只需要选择公开的 `modelKey`。

`runtimeContextPlacement` 默认是 `system`：Adapter 会保留真实的 `user / assistant / tool` transcript，并把服务端产生的 Plan、当前 Step、Skill 目录、压缩摘要与修复指令包进带 `source="server"`、snapshot ID 和 phase 的 `<runtime_context>`，追加到 Provider 的 `system` message。这是 DeepSeek/OpenAI-compatible Provider 的推荐设置。只有某个 Provider 明确不接受动态 System 内容时才设为 `user-envelope`；它只是最后一公里兼容编码，内部仍然保持 Runtime Context 与用户消息分离，且 Runtime 不会根据模型文本授予权限或判定完成。控制台通过 `/v1/providers` 读取无密钥 Provider 目录。

需要让 Agent 调用不在系统 `PATH` 中的受信任运行时时，由服务端配置可执行别名。模型只能提交别名和参数数组，不能提交绝对可执行路径；Runtime 在无 Shell 的进程边界把别名解析到固定二进制：

```bash
TRUSTED_EXECUTABLE_ALIASES_JSON='{"artifact-node":"/absolute/path/to/trusted/node"}' npm start
```

受信任工具需要运行时路径等非敏感环境变量时，可由服务端通过 `TRUSTED_COMMAND_ENV_JSON` 注入。该通道拒绝名称中含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`AUTH` 等敏感词的变量；模型密钥不得进入 Computer 子进程：

```bash
TRUSTED_COMMAND_ENV_JSON='{"RUNTIME_NODE":"/absolute/path/to/trusted/node"}' npm start
```

## Skill 定义

```json
{
  "name": "internal-research",
  "description": "内部研究流程",
  "instructions": "先核验资料，再形成结论。只使用已核验资料，并逐条记录证据；完成前复核所有关键结论均能指向已读取的证据。"
}
```

Skill 原文是唯一领域工作流权威，不再有框架侧的规划提示、Tool 清单、完成标准或绑定模式副本。Planner 初始只看到当前用户的私有 Skill 与正式 `skills/` 目录自动发现并物化的 Skill 目录；目录只含名称、描述、版本和位置。Planner 依据这些元数据直接提交结构化 Plan，不在规划阶段加载 Skill 正文。每个 Skill-bound Step 开始时才开放 `load_skill`，原文进入该 Step 的 ToolResult 后再开放 Plan 授权的执行 Tool。Assessment 直接对照同一版本 Skill 原文和运行证据，Skill 仍不能扩张 Capability Grant。

正式发现目录可通过 `SKILL_DIRECTORY` 指定，默认是启动目录下的 `skills/`。每个直接子目录只要以自己的 Skill 名命名并包含标准 `SKILL.md`，即可进入 Agent Loop；不要求同级 `.source.json`。若提供合法的 `<skill-name>.source.json`，其中的 HTTPS 来源、提交和 Package 指纹会作为可选溯源元数据记录，且始终放在 Package 外部，不改变第三方包的字节和 hash：

```bash
SKILL_DIRECTORY=/srv/agentloop/skills \
SKILL_PACKAGE_STORE_ROOT=/srv/agentloop-workspace/.agentloop/skill-packages \
npm start
```

### 原样安装现成 Skill Package

Package 模式用于验证现成 Skill 本身；安装过程只提取标准 `SKILL.md` 的名称、描述和完整原文，不叠加框架自定义语义。服务端先配置导入白名单与只读托管目录。托管目录由服务端统一管理，不能作为 Computer Tool 的可写会话目录；`load_skill` 只向当前 Step 注入已授权的包内容和服务端包路径：

```bash
WORKSPACE_ROOT=/srv/agentloop-workspace \
SKILL_PACKAGE_STORE_ROOT=/srv/agentloop-workspace/.agentloop/skill-packages \
SKILL_IMPORT_ROOTS_JSON='["/srv/approved-skill-imports"]' \
npm start
```

`POST /v1/skills/import-directory` 接受服务端可见目录、HTTPS 来源、40 位提交 SHA 和调用者预先核验的 Package SHA-256：

```json
{
  "sourceDirectory": "/srv/approved-skill-imports/presentation-skill",
  "sourceUrl": "https://github.com/siril9/presentation-skill",
  "sourceRevision": "3a22eed290fa2205b6a1e2de5549b4429c5fffd0",
  "expectedPackageHash": "0ad72f96b57398a95e04ba4b2fd3a1db2d4e11548d34ca16c44cfd189cfb1842"
}
```

安装器拒绝符号链接、路径逃逸和超额文件，逐文件复制后复算全包 hash 并把副本设为只读。Run 在开始、Step 执行、Assessment 和 Terminal Commit 前重新核验；任何变化都会以 `SKILL_PACKAGE_MUTATED` 终止，而不是修改 Skill 或切换替代实现。

### 原始 presentation-skill 真实 E2E

仓库顶层 `skills/` 是正式的 Skill 发现目录。Runtime 启动时扫描每个直接子目录的标准 `SKILL.md`，并在用户首次列出 Skill 或发起 Run 时原样物化到该用户隔离的只读 Package Store；Planner 只看元数据并据此出 Plan，真正的 `load_skill` 发生在对应 Step 的执行阶段。`skills/presentation-skill` 的 Package 内容、文件数和 Package hash 都在复制及每个运行关键点重新核验；若同级来源锁存在且匹配，才额外显示来源与提交。`scripts/run-presentation-e2e.ts` 通过这条正式发现链路调用 Package 自带的 builder 与 QA，不包含框架定制 renderer。

同一目录还收录了来自 Anthropic Skills 的多个 Apache-2.0 Package。来源锁并非准入条件：任何结构有效的直接子目录均会被发现；部署方须只放入有权运行和复制的 Package。如需从目录中隔离某个 Package，可在同级提供有效的 `<skill-name>.disabled.json`；该显式隔离优先于 Package 发现。

用新的 DeepSeek Key 手工运行，Key 通过标准输入传入，不写入源码、命令行参数、环境文件或证据：

```bash
(read -s "DEEPSEEK_API_KEY?DeepSeek API Key: "; printf '\n'; printf '%s\n' "$DEEPSEEK_API_KEY" | node scripts/run-presentation-e2e.ts; e2e_status=$?; unset DEEPSEEK_API_KEY; exit $e2e_status)
```

成功与失败都会在新建的 `outputs/presentation-skill-e2e/<timestamp>/evidence.json` 中留下 Package 前后 hash、持久 Run/Plan/Assessment/Outcome、Tool 调用以及 PPTX/QA 证据。脚本还会独立记录实际转换引擎及版本、PDF 光栅器、操作系统、QA 声明字体和 Fontconfig 的实际字体匹配，明确区分“原始 Skill 自动 QA 通过”与“该渲染环境对目标查看器具有可信视觉等价性”。当前 8 页案例只有在原始 builder、原始 QA、8 页实际渲染、零 overflow/overlap/design error、渲染环境证据已记录、Package 未变和 Terminal Outcome 全部成立时才返回成功；字体替代会把自动视觉证据标记为 `environment-limited`，但不会伪装成人工检查失败或擅自修改第三方 Skill。人工逐页视觉检查仍是独立验收，不由 Agent 自报替代。

## Computer Tool

内置 Tool：

| Tool | 风险 | 作用 |
|---|---:|---|
| `computer_list_directory` | 只读 | 列出当前会话 Workspace 目录 |
| `computer_read_file` | 只读 | 有上限地读取当前会话目录中的 UTF-8 文件 |
| `computer_search_text` | 只读 | 在当前会话目录中递归字面量搜索 |
| `computer_write_file` | 危险 | 在当前会话目录创建/覆盖文件 |
| `computer_run_command` | 危险 | 在当前会话目录中 `spawn(command, args)`，不使用 Shell 字符串 |
| `computer_snapshot` | 只读 | 由 ComputerDriver 截屏 |
| `computer_click/type_text/press_key/navigate` | 危险 | 由 ComputerDriver 控制 GUI/浏览器 |

一个 Tool 只有同时满足“已注册、当前 Plan Step 已声明、Run 已授权危险工具”才会出现在模型 Tool Schema 中。

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/v1/auth/register` | 注册并签发会话 |
| `POST` | `/v1/auth/login` | 登录 |
| `POST` | `/v1/auth/logout` | 注销 |
| `GET` | `/v1/me` | 当前用户 |
| `GET/POST` | `/v1/skills` | 私有 Skill 目录/创建 |
| `GET` | `/v1/skills/discovered` | 已核验的服务端 Skill 发现目录 |
| `POST` | `/v1/skills/import-directory` | 从服务端批准目录原样安装并锁定 Skill Package |
| `GET` | `/v1/skills/:id` | 读取自己的 Skill 正文 |
| `GET` | `/v1/tools` | 当前部署的 Computer/Plugin Tool 目录 |
| `POST` | `/v1/runs` | 执行一个 Plan-first Run（可选 `conversationId` 追加到既有对话） |
| `GET` | `/v1/runs` | 当前用户顶级 Run 历史（新→旧，供会话列表） |
| `GET` | `/v1/conversations` | 当前用户对话列表（新→旧，含轮数/终态） |
| `GET` | `/v1/conversations/:id` | 单个对话及其按时间排序的 Run 轮次 |
| `GET` | `/v1/runs/:id` | Run 权威状态 |
| `GET` | `/v1/runs/:id/plan` | Plan、Step、Evidence、Compliance |
| `GET` | `/v1/runs/:id/events` | Run 事件日志 |
| `POST` | `/v1/batches` | 创建并执行批次 |
| `GET` | `/v1/batches/:id` | 批次汇总 |
| `GET` | `/v1/batches/:id/items` | 批次逐项结果 |

## 部署边界

当前实现是可运行的单节点参考内核：SQLite、同步 HTTP Run、单进程 Worker。生产多副本部署仍应替换为 PostgreSQL + 队列 + fenced lease + SSE，并将不可信代码/命令放进容器或 WASM Sandbox；浏览器登录也应升级为 HttpOnly Cookie、CSRF、OIDC/MFA。详细边界和演进路径见 [架构设计](docs/ARCHITECTURE.md)。

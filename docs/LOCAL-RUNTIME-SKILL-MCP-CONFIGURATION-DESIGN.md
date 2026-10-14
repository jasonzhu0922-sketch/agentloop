# Local Runtime Skill 与 MCP 配置设计方案

> 状态：第一期实现中
>
> 范围：`agentloop-multi-runtime` 的用户侧 Local Runtime Agent 及 Web 配置界面
>
> 不包含：Cloud Runtime 配置化、模型策略、Runtime 配置版本/哈希、Agent 草稿/发布模型

## 1. 结论

短期将 Local Runtime 直接作为用户的专项 Agent 执行单元：

```text
一个 Local Runtime
  = 默认加载的内核 Skills
  + 零个或多个显式选择的 Custom / 用户上传 Skills
  + 零个或多个 Runtime 私有 MCP Server 配置
  + 独立的 Run 数据、目录授权和生命周期
```

用户创建 Local Runtime 时完成以下操作：

1. 填写 Runtime 名称；
2. 按需从本机已经安装的 Custom Skills 中选择，或者上传自己的 Skill；
3. 按需要配置零个或多个 MCP Server，并直接填写连接参数和凭据；
4. 对已选择的扩展 Skill 和 MCP 配置完成校验后创建并启动 Runtime。

即使用户不选择 Custom Skill、不上传 Skill、也不配置 MCP，Runtime 仍会加载内核自带的 Skills，因此它不是空 Runtime。系统不引入 `LocalAgentProfile`、草稿、Release 或 Deployment 等额外领域对象。Runtime 停止后，用户可以重新选择或上传扩展 Skill、增删 MCP Server、修改 MCP 连接参数和凭据，然后再次启动同一个 Runtime。

Cloud Runtime 继续保持当前固定能力池模式。本设计不修改 Cloud Runtime 的配置来源、调度或管理界面。

## 2. 背景与当前断点

当前 Local Runtime Supervisor 已经支持一个 Local Agent 管理多个 Runtime，并为每个 Runtime 提供独立的 SQLite、RunService、上传源、目录授权和生命周期。这个隔离基础可以直接承载专项 Agent。

但当前的能力配置仍是设备级统一配置：

- 新建 Runtime 只提交 `displayName`；
- 所有 Runtime 从同一个 `skill-directories.json` 加载 bundled/custom Skill 目录；
- 所有 Runtime 从同一个 `mcp-servers.json` 加载 MCP Server；
- `LocalRuntimeFactory` 在每个实例启动时注入同一组 Skill 和 MCP tools；
- Web 配置页只能改名和执行启动、停止、重启、删除操作。

因此，当前实现提供的是“多个隔离执行空间”，还不能表达“数据资产 Runtime 只具备数据资产 Skills 和数据 MCP”“合同审核 Runtime 只具备合同 Skills 和合同 MCP”。

本设计要恢复的真实契约是：

> 每个 Local Runtime 始终加载内核 Skills；除此之外，只能发现和执行用户明确选择给它的 Custom/上传 Skill 与 MCP tools。运行中不得改变扩展能力集合，停止后才允许重新配置。

第一个需要修复的边界是 Local Runtime 的创建和装配：`LocalRuntimeDefinition` 目前只有身份和展示字段，`LocalRuntimeFactory` 却直接读取设备级全局 Skill/MCP 配置。能力归属必须先进入 Runtime 自身的持久配置，再由 Factory 按 Runtime 配置构造执行环境。

## 3. 设计原则

### 3.1 Runtime 是唯一用户对象

不在 Runtime 之上再建立“专项 Agent 草稿”或“Agent 发布版”。用户在产品中创建、选择和维护的仍然是 Local Runtime，只是它具备明确的专项能力。

名称可以体现其用途，例如“数据资产 Agent”或“合同审核 Agent”，但后端实体仍是 `LocalRuntime`。

### 3.2 创建时一次性提交可选扩展配置

创建请求可以不包含 Custom/上传 Skill 和 MCP 配置；此时 Runtime 使用内核 Skills 正常创建。只要请求包含扩展 Skill 或 MCP，就必须在创建前完成相应校验。

Skill 上传先安装到设备本地的 Skill catalog，再由当前创建流程选择绑定；它不代表已经创建 Runtime 草稿，也不会自动授权给任何 Runtime。创建提交时，Runtime 记录、可选的 Custom/上传 Skill 绑定和 MCP 配置必须在一个本地事务中生效；失败时不能留下半创建的 Runtime。

### 3.3 运行态配置不可变

`ready`、`draining`、`restarting` 状态下不允许修改 Skill 或 MCP 配置。

只有 `stopped` 状态允许保存配置。运行中的配置变更请求返回稳定的冲突错误，不进行隐式 stop、restart 或热替换。

### 3.4 Skill 发现不等于 Runtime 授权

设备级 Skill 目录和用户上传区只负责形成“本机可选 Skill 目录”。一个 Skill 被发现或安装，不代表所有 Runtime 都能使用它。

Runtime 实际可用 Skill 必须是：

```text
内核 Skills
  ∪（本机已安装且校验通过的扩展 Skill
      ∩ 当前 Runtime 显式选择的扩展 Skill）
```

内核 Skills 是所有 Runtime 的稳定基础能力，不要求用户选择。Custom Skill 和用户上传 Skill 是 Runtime 级可选扩展；Runtime 不得回退到“加载全部已发现的 Custom/上传 Skill”。

### 3.5 MCP 配置归属 Runtime

MCP Server 连接配置直接归属某个 Runtime，不建立第一期的共享 MCP 注册中心。这样可以保证：

- 修改合同审核 Runtime 的 MCP 不会影响数据资产 Runtime；
- MCP 凭据不会因为“复用连接”而意外扩大授权范围；
- 删除 Runtime 时可以明确回收其 MCP 配置和凭据；
- Factory 可以只物化当前 Runtime 的 MCP tools。

未来如需减少重复输入，可以增加“从另一个连接复制”或设备级模板，但复制结果仍然形成 Runtime 私有配置，不共享可变连接记录。

### 3.6 配置和凭据保留在用户设备

Skill 包、MCP URL、认证参数和凭据都由 Local Agent 持久化。包含 Skill 包内容或 MCP 凭据的请求只能走 Browser 到 loopback Local Agent 的本机数据面，不通过 Router 控制转发。

Router 只接收 Runtime catalog、生命周期状态、容量和调度所需信息，不接收：

- 上传的 Skill 包；
- Skill 文件内容；
- MCP URL 中的敏感查询参数；
- MCP headers、token、用户名或密码；
- Runtime 的完整 Skill/MCP 配置。

## 4. 产品流程

### 4.1 新建 Runtime

```text
打开“新建本机 Runtime”
  -> 填写名称
  -> 可选：选择已安装 Custom Skill，或上传自己的 Skill
  -> 可选：新增一个或多个 MCP Server
  -> 校验已选择的扩展 Skill
  -> 测试已配置的 MCP 连接并执行 tools/list
  -> 提交创建
  -> Local Agent 原子保存配置并启动 Runtime
  -> Runtime ready 后发布到 Router catalog
```

约束：

- Custom/上传 Skill 可以不选择，此时只加载内核 Skills；
- 同一个 Skill 不能重复绑定；
- MCP 服务标识（协议字段 `key`）在 Runtime 内必须唯一；它用于形成工具命名空间，不是 `.env` 凭据变量名；
- MCP 服务标识规范化后的工具命名空间不能冲突；
- Token、API Key、密码等认证值由用户直接填写并进入设备本机加密存储，不保存为 `.env` 变量引用；
- 创建过程中任一必需校验失败，不创建 Runtime；
- 用户上传成功但最终取消创建时，Skill 只保留在本机已安装 catalog 中，不形成 Runtime，也不进入任何 Runtime 的授权集合。

### 4.2 停止后重新配置

```text
ready
  -> 用户点击停止
  -> draining（如仍有活动 Run）
  -> stopped
  -> 编辑 Skills / MCP Servers
  -> 保存并校验
  -> 仍保持 stopped
  -> 用户点击启动
  -> ready 或 failed
```

保存配置和启动是两个明确动作。这样用户可以连续修改、测试连接，确认无误后再启动，不会因一次保存立即恢复接单。

重新配置时保留：

- Runtime ID 和名称；
- 历史 Run、事件和产物；
- 已授权目录 scope，除非用户主动撤销；
- Runtime 独立数据库和工作区。

重新配置时替换：

- 当前 Runtime 的 Custom/上传 Skill bindings；
- 当前 Runtime 的 MCP Server 配置及其本机凭据。

内核 Skills 不属于可编辑绑定，不会因为用户清空 Custom Skill 而被移除。

### 4.3 MCP 连接配置

第一期支持 HTTP MCP transport，并复用当前 MCP loader 的初始化、session 和 `tools/list` 行为。配置界面至少包含：

- 显示名称；
- 唯一 `key`；
- URL；
- 协议版本；
- 超时时间；
- 认证方式；
- 可选 tool allowlist/blocklist。

认证方式第一期支持：

- 无认证；
- Bearer Token；
- API Key Header；
- Basic Auth；
- Query 参数；
- 自定义 Headers。

用户直接在界面填写凭据，不要求用户理解或选择“凭据引用”。内部仍必须安全保存凭据：

- 前端提交成功后立即清空输入值；
- API 读取配置时只返回 `credentialConfigured: true/false`，永不回传原值；
- 日志、错误、Run 事件和 MCP 启动诊断不得包含凭据；
- 凭据由 Local Agent 的本机 SecretStore 保存，MCP 配置表只保存内部定位键；
- 第一实现如暂不能接入操作系统凭据库，必须使用 Local Agent 安装级密钥加密后落盘，并限制文件权限，不能明文写入 SQLite、JSON 或 `.env`。

这里的内部定位键是存储实现细节，不是面向用户的“集成凭据引用”配置能力。

### 4.4 MCP 测试

“测试连接”执行完整但无业务副作用的协议检查：

1. 解析 URL 和认证配置；
2. 建立连接；
3. 执行 `initialize`；
4. 保留服务端返回的 MCP session ID；
5. 执行 `tools/list`；
6. 返回工具数量、工具名称和已脱敏诊断。

测试接口可以接收尚未保存的凭据，但不得持久化，除非用户随后提交创建或保存配置。

连接失败应区分 URL/协议错误、网络失败、鉴权失败、initialize 失败和 `tools/list` 失败，不能只返回“配置失败”。

## 5. 前端设计

### 5.1 入口调整

保留 Local Runtime Agent 设置中的“子 Runtime 管理”，但扩展两个现有弹窗：

- “新建本机 Runtime”：名称 + `Skills` / `MCP Servers` 两个配置页签；
- “配置子 Runtime”：名称和 Runtime 状态 + `Skills` / `MCP Servers` 两个配置页签。

两个页签只控制当前可见区域，不改变提交语义；创建或保存时仍一次提交两个页签中的完整配置。PC 端弹窗宽度控制在 720px 内，高度不超过 760px 或视口高度减 40px，内容过长时只在弹窗内部滚动，提交操作栏保持可见。移动端切换为单列表单，禁止产生横向滚动。

Runtime 列表卡片增加：

- 已选择扩展 Skill 数量及名称摘要；
- 已配置 MCP Server 数量及名称摘要；
- 最近一次配置检查结果；
- `配置` 按钮仅在 `stopped` 时可用；`failed` 状态下先执行 stop，将生命周期统一回到 `stopped`。

### 5.2 Skill 区域

```text
扩展 Skills（可选，内核 Skills 默认加载）
[x] 数据资产分析
[ ] 合同条款审核
[ ] HTML 报告生成

[上传 Skill]
```

上传完成后显示：

- Skill 名称和描述；
- 来源：本机 Custom Skill / 用户上传；
- 校验结果；
- 声明的执行依赖和 MCP ToolSource 需求（如有）；
- 移除按钮。

不在界面中暴露 Skill 包目录绝对路径。

### 5.3 MCP 区域

```text
MCP Servers（可选）
┌ 已连接 · 12 tools                 [测试连接] [删除图标]
│ 数据目录服务        data-catalog
│ https://...
└ Bearer Token        ********

[新增 MCP Server]
```

每个 MCP 条目使用“紧凑工具栏 + 完整字段网格”：测试状态位于左侧，测试连接和删除位于右上角；删除使用带 tooltip 和可访问标签的图标按钮，不占用独立表单列。编辑区域根据认证方式动态显示字段。编辑现有连接时不回填 secret，只显示“已配置”；用户只有主动选择“替换凭据”时才输入新值。

### 5.4 提交路径

前端继续从 Router 获取短期 Local Session，但配置请求直接发送到 Local Agent loopback API：

```text
Browser --短期 Local Session--> Local Agent loopback
Browser --普通会话/设备管理--> Router
Local Agent --Runtime catalog/heartbeat--> Router
```

前端不得把 Skill ZIP 或 MCP credential 放入 localStorage、sessionStorage、URL、Router 请求或错误遥测。

## 6. 本地数据模型

以下表均存放在 Local Agent 的 Supervisor SQLite 中，而不是每个 Runtime 的 Run 数据库中。Supervisor 是 Runtime 配置和生命周期的本机权威。

### 6.1 已安装 Skill 目录

```sql
CREATE TABLE local_skill_packages (
  package_id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('custom_directory', 'uploaded')),
  storage_key TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK(validation_status IN ('valid', 'invalid')),
  validation_detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

说明：

- `custom_directory` 表示从当前 Custom Skill 目录同步得到的本机可选项；
- `uploaded` 表示用户通过配置界面上传并安装到 Local Agent package store；
- `storage_key` 是 Local Agent 管理的相对存储键，不是外部绝对路径；
- 包校验可以内部计算内容摘要用于完整性和去重，但第一期不建立 Runtime 配置版本/配置哈希产品能力。

### 6.2 Runtime Skill 绑定

```sql
CREATE TABLE local_runtime_skill_bindings (
  runtime_id TEXT NOT NULL REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES local_skill_packages(package_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (runtime_id, package_id)
);
```

该表只记录 Custom/上传 Skill 绑定，可以没有记录。内核 Skills 不写入该表，由 Local Runtime 装配时固定加载。

### 6.3 Runtime MCP 配置

```sql
CREATE TABLE local_runtime_mcp_servers (
  mcp_server_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport = 'http'),
  url TEXT NOT NULL,
  protocol_version TEXT,
  timeout_ms INTEGER,
  auth_kind TEXT NOT NULL CHECK(auth_kind IN ('none', 'bearer', 'api_key_header', 'basic', 'query_parameter', 'custom_headers')),
  auth_config_json TEXT NOT NULL,
  secret_storage_key TEXT,
  tool_policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (runtime_id, source_key)
);
```

`auth_config_json` 只能保存非敏感结构，例如 API Key header 名称。Token、密码和自定义 header 值进入 SecretStore，不进入该列。

第一期不增加独立配置版本表，也不计算整份 Runtime 配置哈希。`updated_at` 只用于界面展示和并发保存检查，不承担 Run 审计版本语义。

## 7. Local Agent API

### 7.1 API 所有权

新增 API 只存在于 loopback Local Agent，并要求：

- 合法的 Web Origin；
- Router 签发并由 Local Agent 验证的短期 Local Session；
- 会话用户拥有当前设备和目标 Runtime；
- 请求体大小、上传大小、解压数量和超时均有上限。

Router 不新增 Skill/MCP 配置存储表，也不代理包含 secret 或包内容的请求。

### 7.2 建议端点

```text
GET    /v1/local-skill-packages
POST   /v1/local-skill-package-uploads
POST   /v1/local-mcp-servers/test

POST   /v1/local-runtimes
GET    /v1/local-runtimes/:runtimeId/configuration
PUT    /v1/local-runtimes/:runtimeId/configuration

POST   /v1/local-runtimes/:runtimeId/start
POST   /v1/local-runtimes/:runtimeId/stop
```

最小创建请求只需要名称；`skills` 和 `mcpServers` 省略或传空数组都表示只使用内核 Skills：

```json
{
  "displayName": "通用本机 Runtime"
}
```

包含可选扩展配置的创建请求示例：

```json
{
  "displayName": "数据资产 Agent",
  "skills": [
    { "packageId": "local_skill_data_asset" },
    { "uploadId": "skill_upload_01" }
  ],
  "mcpServers": [
    {
      "displayName": "数据目录服务",
      "key": "data-catalog",
      "transport": "http",
      "url": "https://catalog.example.com/mcp",
      "protocolVersion": "2024-11-05",
      "timeoutMs": 15000,
      "auth": {
        "kind": "bearer",
        "token": "<submitted-to-local-agent-only>"
      }
    }
  ]
}
```

配置读取响应中的认证信息必须脱敏：

```json
{
  "auth": {
    "kind": "bearer",
    "credentialConfigured": true
  }
}
```

### 7.3 稳定错误

建议提供以下稳定错误码：

- `skill_package_not_found`：本机 Skill 不存在；
- `skill_package_invalid`：Skill 校验失败；
- `skill_upload_invalid`：上传格式或安全检查失败；
- `runtime_must_be_stopped_for_configuration`：目标 Runtime 不是 `stopped`；
- `mcp_source_key_conflict`：Runtime 内 MCP 服务标识或规范化命名空间冲突；
- `mcp_configuration_invalid`：字段或认证配置非法；
- `mcp_connection_failed`：连接失败；
- `mcp_authentication_failed`：鉴权失败；
- `mcp_initialize_failed`：MCP initialize 失败；
- `mcp_tools_list_failed`：`tools/list` 失败；
- `runtime_configuration_apply_failed`：事务或本机存储失败。

错误响应只能包含脱敏诊断，不得回显请求 header、URL 敏感查询值、token、密码或 secret。

## 8. Runtime 装配

### 8.1 Factory 输入

`LocalRuntimeFactory.create()` 不再自行读取设备级完整 Skill/MCP 配置，而是接收 Supervisor 已解析并验证的 Runtime 配置：

```ts
interface ResolvedLocalRuntimeConfiguration {
  readonly customSkillDirectories: readonly string[];
  readonly mcpServers: readonly McpServerRegistration[];
  readonly integrationEnvironment: Readonly<Record<string, string | undefined>>;
}
```

其中：

- `customSkillDirectories` 只包含该 Runtime 选择的有效 Custom/上传 Skill package roots，可以为空；
- `mcpServers` 只包含该 Runtime 私有 MCP 配置；
- secret 在创建 MCP client 前由 Local Agent SecretStore 解析；
- 解析后的 secret 只存在于进程内存，不进入 `RunService`、Run context 或事件。

### 8.2 SkillService

设备级 package store 可以共享不可变 Skill 文件。每个 Runtime 的 `SkillService` 固定加载内核 Skill 目录，并且只能追加当前 Runtime 选择的扩展目录：

```text
bundledSkillDirectories()
  + resolveCustomBindings(runtimeId)
  -> validate selected package roots
  -> SkillService({ skillDirectories: kernelRoots + selectedCustomRoots })
```

没有 Custom/上传 Skill 绑定时，`selectedCustomRoots` 合法地为空，Runtime 仍加载 `bundledSkillDirectories()`。绑定解析失败时必须拒绝启动，禁止回退到全部 Custom Skill 目录。内核 Skill 与 Custom/上传 Skill 的来源分类必须保留，不能因为最终都传入 `SkillService` 而丢失授权边界。

### 8.3 MCP tools

Local Agent 对当前 Runtime 的每个 MCP Server 独立加载：

- 一个 Server 失败不能把另一个 Server 的工具误归入当前来源；
- 工具仍使用 `mcp_<normalized-source-key>_<tool>` 命名；
- Runtime 启动失败时记录按 Server 区分的脱敏诊断；
- 未绑定的 Server 不得连接，也不得出现在 Planner capability catalog；
- Kernel 继续只接收物化后的 `RuntimeTool[]`，不感知 MCP 配置界面或 secret 存储。

如果 Skill manifest 显式声明必需 ToolSource，启动前必须确认对应 MCP source 已绑定且 `tools/list` 成功。未声明依赖时，不通过名称猜测 Skill 与 MCP 的关系。

## 9. Skill 上传安全

上传 Skill 是本机代码/指令供应链入口，不能只检查是否存在 `SKILL.md`。第一期至少执行：

1. 限制压缩包字节数、文件数、单文件大小、总解压大小和压缩比；
2. 拒绝绝对路径、`..`、符号链接、硬链接和目标目录逃逸；
3. 拒绝包内 `.env`、私钥、常见凭据文件和设备配置覆盖文件；
4. 在隔离临时目录解包，校验通过后再移动到 Local Agent 管理的 package store；
5. 校验 `SKILL.md`、AgentLoop metadata 和执行 manifest 的结构；
6. 检查声明的命令、解释器和 Python/Node 依赖，不能因为发现 Skill 就假定 Runtime 已具备依赖；
7. 上传包不能自行获得目录、MCP、网络、命令或凭据授权；
8. 删除正在被 Runtime 绑定的 Skill 包时返回冲突，不级联破坏 Runtime 配置。

包内脚本即使存在，也只能通过 Runtime 已有 Tool/command policy 执行。Skill 上传不能成为绕过 Admission、ToolRegistry 或 `allowDangerousTools` 的旁路。

## 10. 并发与一致性

### 10.1 创建事务

创建服务应按以下顺序执行：

1. 校验请求与所有 Skill/MCP 输入；
2. 确认引用的已安装 Skill 仍有效；
3. 打开 Supervisor 数据库事务；
4. 插入 `local_runtime_instances`；
5. 插入可选的 Custom/上传 Skill bindings；
6. 保存 MCP 非敏感配置并写入 SecretStore；
7. 提交数据库事务；
8. 启动 Runtime；
9. 启动成功后发布 Runtime catalog。

若步骤 6 前失败，回滚数据库事务。若数据库提交后启动失败，保留 Runtime 及配置并标记为 `failed`，便于用户停止后修正，不能删除诊断现场。

SecretStore 与 SQLite 无法组成真正的跨存储事务，因此先生成随机加密键，再提交只引用这些键的 SQLite 事务；事务失败时立即回收本次生成的键，Local Agent 下次启动还会扫描并清理由进程中断留下的无引用 secret。

### 10.2 更新事务

更新配置时：

- 先在事务内再次确认 Runtime 状态为 `stopped`；
- 原子替换 Custom/上传 Skill bindings 和 MCP 非敏感配置；
- 新 secret 先写入随机加密键；
- 数据库提交后回收已不再引用的旧 secret；
- 保存成功后 Runtime 仍为 `stopped`；
- 不调用设备级 `reloadRunningInstances()`，不重启其他 Runtime。

### 10.3 生命周期竞争

配置保存、start、stop、restart、drain、remove 及活动 Run 结束后的生命周期收敛，必须在 Supervisor 内按 `runtimeId` 串行化。不能依赖前端按钮禁用防止竞争。

当保存与 start 并发时，只允许一个操作取得 Runtime 锁；另一个返回冲突。这样 Factory 不会读到半更新的绑定。

## 11. 迁移方案

### 11.1 现有 Runtime

升级时执行一次性物化迁移：

- 将当前每个 Runtime 实际能够发现的 Custom Skills 写成显式 `local_runtime_skill_bindings`；
- 将当前设备级 MCP 配置复制为每个现有 Runtime 的私有 MCP 配置；
- 迁移完成后，Factory 不再把全局 Custom Skill/MCP 文件作为 Runtime 扩展能力 fallback；内核 Skill 仍按固定路径加载；
- 无法安全迁移的 MCP secret 标记为“需重新填写”，相关 Runtime 直接保持 `stopped`，由用户补齐后显式启动；
- 新建 Runtime 从第一天起必须使用新配置模型。

迁移是一次性的当前状态物化，不保留“全局配置 + Runtime 配置”双读模式。

### 11.2 配置文件定位

现有 `skill-directories.json` 可继续作为本机 Custom Skill 的发现来源，但不再等于 Runtime 的授权集合。

现有 `mcp-servers.json` 仅作为升级导入源。完成迁移后，用户维护的 Runtime MCP 配置以 Supervisor 数据库和 SecretStore 为唯一权威；继续修改该文件不会热更新或覆盖 Runtime 配置。

## 12. 实施拆分

### 阶段一：本地领域与持久化

- 扩展 Supervisor schema；
- 增加 Skill package catalog 和上传暂存服务；
- 增加 Runtime Skill bindings 与 Runtime 私有 MCP 配置；
- 增加 SecretStore port；
- 实现按 Runtime 串行化的创建、更新和生命周期规则。

### 阶段二：Runtime 装配

- `LocalRuntimeFactory` 改为消费已解析 Runtime 配置；
- `SkillService` 接收固定内核 Skill roots 和当前 Runtime 选择的扩展 Skill roots；
- MCP loader 只物化当前 Runtime 的 Servers；
- 保留固定内核 Skill 加载，去除全局 Custom Skill/MCP 的运行时 fallback；
- Runtime catalog 更新保持现有 Supervisor -> Router 路径。

### 阶段三：Loopback API 与前端

- 新增 Skill 列表、上传、MCP test、Runtime 创建和配置 API；
- 扩展创建/配置弹窗；
- secret 输入和响应脱敏；
- 配置按钮受生命周期状态约束；
- 用户保存配置后显式点击启动。

### 阶段四：迁移与清理

- 一次性物化现有 Runtime Skill/MCP 配置；
- 更新安装模板与本地配置说明；
- 将 Runtime 创建迁移到 Local Agent loopback API；名称-only 与携带可选扩展配置的创建使用同一入口；
- 移除 Factory 全量加载 Custom Skill/MCP 的路径，保留内核 Skill 基线；
- 清理迁移完成后的兼容读取代码。

## 13. 验收标准

### 13.1 功能验收

1. 不选择 Custom Skill、不上传 Skill 时，Runtime 可以创建并只加载内核 Skills。
2. 选择一个 Custom Skill 后，Runtime 加载内核 Skills 和该 Custom Skill。
3. 上传合法 Skill 后可以在同一次创建流程中绑定并启动。
4. 上传非法、越界或包含禁止敏感文件的包会被拒绝；用户移除该上传项后仍可只使用内核 Skills 创建 Runtime。
5. 用户可以配置无认证、Bearer、API Key、Basic、Query 参数和自定义 Header MCP Server。
6. MCP 测试能够区分连接、鉴权、initialize 和 `tools/list` 失败。
7. `ready` Runtime 无法修改 Skill/MCP；停止后可以修改并重新启动。
8. 重启 Local Agent 后，Runtime 的 Skill/MCP 配置和生命周期状态保持一致。

### 13.2 隔离验收

1. 所有 Runtime 都能发现相同的内核 Skills。
2. 数据资产 Runtime 在内核 Skills 之外，只能发现其选择的 Custom/上传 Skills 和 MCP tools。
3. 合同审核 Runtime 无法发现数据资产 Runtime 的 Custom/上传 Skills，也无法调用其 MCP tools。
4. 修改一个 stopped Runtime 的配置不会重启、阻塞或改变其他 Runtime。
5. 未选择的 Custom/上传 Skill 即使存在于设备 package store，也不会进入 Planner candidates。
6. 未绑定 MCP 即使配置存在于其他 Runtime，也不会建立连接或暴露工具。

### 13.3 安全验收

1. Router 数据库、请求日志和控制消息中不存在 Skill 包内容或 MCP secret。
2. Local Agent 配置读取 API 不回传 secret。
3. Local Agent 启动日志、MCP 错误和 Run 事件不包含 secret。
4. 上传包无法通过路径穿越写出临时目录或 package store。
5. 上传 Skill 无法自行扩大 Tool、目录、MCP 或命令授权。

### 13.4 回归验收

1. 原有 Runtime stop/drain/restart/remove 行为保持有效。
2. 活动 Run 仍阻止 Runtime 完成 stop 和 remove。
3. 本地目录 scope、上传源、Run 历史和产物仍按 Runtime 隔离。
4. Router 仍只根据 Runtime catalog 和生命周期进行调度，不承担 Skill/MCP 配置权威。
5. Cloud Runtime 的配置、启动和调度路径没有变化。

## 14. 明确不做

第一期不包含以下能力：

- Cloud Runtime 的 Skill 或 MCP 配置化；
- Runtime 级模型选择、默认模型或模型策略；
- 面向用户的凭据引用、凭据库选择或跨 Runtime 凭据共享；
- Runtime 配置版本、配置哈希、回滚和历史配置审计；
- Agent Profile、草稿、Release、Deployment；
- Runtime 运行中的 Skill/MCP 热更新；
- 设备级共享可变 MCP 连接；
- MCP stdio transport、OAuth 授权流程或组织级密钥管理；
- 用户上传 Skill 的云端同步、市场分发或跨设备同步。

这些能力后续如需引入，应在不改变本设计两个核心不变量的前提下扩展：Runtime 始终加载内核 Skills，扩展能力必须由当前 Runtime 显式选择；运行中能力集合不可变。

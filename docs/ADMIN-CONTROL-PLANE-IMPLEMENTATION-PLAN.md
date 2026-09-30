# AgentLoop 管理控制面执行方案

本方案落实[管理控制面整体设计](./ADMIN-CONTROL-PLANE-DESIGN.md)。实施目标是将可运营配置从部署文件迁移为有版本、有范围、有回执的控制面，同时保持 AgentLoop 内核不依赖管理服务或数据库。

## 1. 不可违反的实施约束

1. 管理端是独立应用：代码位于 `apps/agentloop-multi-runtime/` 内的 `admin-api/` 与 `admin-web/`，但有独立入口、构建、部署和接口，不在 Multi Runtime 用户 `web/` 添加管理功能。
2. Kernel 不访问控制面：`packages/agentloop` 只消费 Host/Local Agent 组装的内存运行环境，不 import HTTP、SQL、Admin、secret 或设备实现。
3. 不允许双写或双源长期存在：文件配置只能作为显式 baseline/rollback release；切换后不按字段 fallback 到 JSON 或 `.env`。
4. 配置以新 Run 为边界：每个 admission 固化 snapshot；不得热改并发或在途 Run 的模型、Skill、Integration、Policy。
5. 不传递明文 secret：浏览器、Router 用户 API、Run/Plan/Event/Outcome、Skill 包、模型上下文和普通 command environment 均不得出现密钥。
6. Admin 不能直接写 Router 调度或 Runtime 内核表；会话/Run 仅经只读 projection 查询，drain/recovery 等操作经受控 Port。
7. SQLite、PostgreSQL、TiDB 必须维持可移植；配置迁移由独立 job 执行，Admin API/Router/Host 启动路径不隐式建表或修改 schema。

## 2. 目标工作区与分层

### 2.1 新增目录

```text
apps/agentloop-multi-runtime/
  admin-api/
    src/
      bootstrap/                # process composition; no business rules
      transport/
        admin-http/             # /admin/v1 decode/auth/respond
        delivery-http/          # /delivery/v1 workload-only API
      application/              # command/query use cases, transactions, idempotency
      domain/
        releases/               # state machine and validation
        scopes/                 # effective-config resolution
        integrations/           # resource semantics, never secret values
        skills/
        audit/
      ports/                    # repository/secret/package/operational query interfaces
      persistence/              # cp_* SQL adapters and read views
      infrastructure/           # Vault/KMS, package store, signing, clock
      authorization/            # admin/workload principals and policy
      observability/            # structured audit/metric adapters
    migrations/                 # immutable, dialect-aware definitions
    tests/
      unit/ contract/ integration/ boundary/
    scripts/migrate.mjs         # one-shot migration job entrypoint

  admin-web/
    src/
      app/                      # routing, auth boundary, shell
      features/                 # integration, skill, policy, runtime, user, audit features
      entities/                 # readonly view models; no HTTP calls
      shared/api/               # typed Admin API client
      shared/ui/ shared/lib/
    tests/

  control-plane/
    contracts/                  # versioned JSON DTOs, error codes, snapshot/receipt contracts
    domain/                     # pure domain types, ports, release/scope rules
    tests/

  src/
    shared/                     # Router—Cloud Host execution contracts only
    router/ runtime-host/        # existing roles; no Admin implementation imports
  local-agent-runtime/          # existing device role; no Admin implementation imports
```

### 2.2 依赖规则

```text
admin-web -> control-plane/contracts
admin-api -> control-plane/domain -> control-plane/contracts
admin-api -> infrastructure/persistence adapters
router / cloud-host / local-agent -> control-plane/contracts
runtime composition -> control-plane delivery client -> control-plane/contracts
kernel -> neither control-plane module nor Admin application
```

`control-plane/contracts` 不含 SQL、Node `fs`、HTTP server、React 或 secret 类型；`control-plane/domain` 不含数据库客户端、网络调用、环境变量读取和全局时间。所有副作用经过 `ports/` 注入。根 `tsconfig.json` 扩展 include 至 `admin-api/**/*.ts`、`control-plane/**/*.ts` 和相应测试；Admin Web 保持单独的前端构建/类型检查配置，避免与用户 `web/` 混编。

CI 新增依赖闭包测试，沿用现有 Router/Host 隔离测试的模式，至少断言：

- Admin Web 不 import Admin API、Router、Runtime Host、Local Agent 或数据库驱动。
- Admin API 不 import `apps/agentloop-multi-runtime/web/**`、`router/application/**` 或 `runtime-host/**`。
- Router/Host/Local Agent 不 import Admin API 的 domain/persistence/infrastructure。
- Kernel 不 import control-plane/admin 路径。
- transport 不 import persistence；domain 不 import transport/persistence/infrastructure。

## 3. 数据与迁移执行

### 3.1 数据域

在 Router control-plane database 内新增 `cp_*` 表，由 control-plane migration job 独立拥有：

```text
cp_resources                 # stable resource id, type, tenant/global owner
cp_releases                  # immutable payload, schema_version, SHA-256, author, state
cp_target_assignments        # plane/target/scope/priority/rollout state
cp_apply_receipts            # target acknowledged release/hash, loaded/failed and reason
cp_integration_bindings      # release -> secret reference -> allowed target
cp_skill_artifacts           # package URI/digest/signer/compatibility
cp_secret_references         # opaque provider/key/version/rotation metadata
cp_audit_events              # append-only actor/action/resource/before/after refs
cp_delivery_cursors          # target pull cursor and idempotency/replay protection
```

不复制 `mr_identity_*`、`mr_tasks`、`mr_assignments`、`mr_turns` 或 Runtime 内核表。Admin API 对 `mr_*` 使用明确的 read model/view 和只读数据库角色；用户和成员管理先通过抽取后的 Identity Port 写入，而不是 Admin repository 直接修改 identity/session 表。

### 3.2 迁移流程

1. 新增 `control-plane` migration ledger；每条 migration 有不可变 ID、定义文本和 SHA-256 checksum，复用当前跨 SQLite/PostgreSQL/TiDB 的 fail-closed 思路。
2. 在 `agentloop-multi-runtime` package 内实现独立 `npm run migrate:control-plane`。部署流水线在 Admin API、Router、Host 启动前执行它；应用启动仅检查所需版本已存在。
3. 每项 DDL 先提供 SQLite/PostgreSQL/TiDB 的 source-level 方言实现；对 TiDB 的 `LONGTEXT` 默认值、nullable backfill、索引长度和 `BIGINT` 时间戳单独测试。
4. 首次迁移只创建 `cp_*`，不修改现有 `mr_*`。后续若需 Run snapshot 外键/投影，采用新增 nullable reference + backfill + strict constraint 的独立迁移。
5. 在空 SQLite、PostgreSQL、TiDB 上验证迁移账本、表/索引和回滚 release；生产切换前只做只读计数与备份确认。

## 4. 配置与凭据的实现契约

### 4.1 Delivery API

`/delivery/v1` 不是 Admin Web 的后门；仅接受 Cloud workload identity 或已配对 Local Agent device identity。

| 操作 | 作用 |
|---|---|
| `GET /desired-configuration` | 取得目标已授权、已验证的 release manifest 与 revision |
| `GET /skill-releases/:id` | 取得签名包元数据和受限下载授权 |
| `POST /apply-receipts` | 报告 validate/download/load/failed，带 release/hash/idempotency key |
| `POST /credential-grants` | 申请特定 Run/Step/Integration 的短期凭据能力，不能批量导出 secret |

Target identity 由 Cloud runtime ID/workload credential 或 Local device registration 导出，不接受请求 body 声明 tenant、plane、device 或 runtime。

### 4.2 RuntimeConfigurationClient

在 Multi Runtime 新增一个 Host/Agent 适配层，而非加入 Kernel：

```text
runtime-host/application/configuration/
local-agent-runtime/application/configuration/
  RuntimeConfigurationClient
  SnapshotVerifier
  SnapshotCache
  RunEnvironmentResolver
  IntegrationSecretBrokerClient
```

实施步骤：

1. 将现有 Provider、Web Search、Skill directory、Step strategy、Practice Profile 的 parser 输出适配为 baseline snapshot。
2. 建立 control-plane snapshot parser/validator，逐字段复用现有 schema validator，而不是重新定义一个宽松 JSON 格式。
3. `RunEnvironmentResolver` 在 admission 前取得**已确认加载**的 snapshot，并创建不可变 provider registry、Tool adapter、Skill catalog 和 policy selection。
4. 扩展 Run/Plan 的持久化 contract，记录 `configurationSnapshotId`、每个 release ID/version/content hash 和必要的 skill package hash。
5. 将现在 startup 中的文件 loader 迁移为 bootstrap-only loader；目标进入 control-plane mode 后，正常运行不再读 JSON。

`LlmProviderRegistry.fromConfigObject()` 可作为 Provider 配置的内存构造入口。其 `apiKeyEnv` 解析应演进为 Host-owned `SecretResolver`/内存 secret slot，不在 Kernel 读取 `process.env`。任何新 Provider adapter 均以 `modelKey` 为唯一用户可见选择，endpoint、协议、secret 和限额始终为服务端配置。

### 4.3 IntegrationSecretBroker 与 enterprise-info

先实现通用 broker，再迁移具体 Skill：

```text
Skill executor -> IntegrationInvocation(runId, stepId, skillDigest, integration, action, args)
  -> broker verifies snapshot binding + Step authorization
  -> broker resolves a short-lived secret grant and calls upstream/proxy
  -> broker returns redacted typed result + integration receipt
```

首个契约必须包括 `enterprise_info.search` 和 `enterprise_info.detail`。迁移 `enterprise_info.py`：

1. 保留参数长度、候选主体、identity-ref、一致性校验、Evidence 与 HIL 语义。
2. 删除读取 `ENTERPRISE_INFO_ENV_FILE` 的 `read_config()`、dotenv 解析和直接持有 `client_secret` 的 token 交换。
3. 通过受保护的 broker adapter 发起已声明动作；脚本看不到 base URL、client ID、client secret 或 access token。
4. Broker 把 binding/release/secret version reference 写入 invocation receipt；响应经 schema 验证和 redaction 后才返回脚本。

不能用短期 token、key 文件或敏感环境变量作为“临时迁移”；它们仍可被不恰当的命令/日志路径暴露。Cloud broker 使用 workload identity；Local broker 使用设备身份和本机安全存储/受限 envelope。

## 5. 分阶段工作包与验收

### WP-0：基线、边界与脚手架

**改动**：在 `agentloop-multi-runtime/` 内创建 `admin-api/`、`admin-web/`、`control-plane/contracts/`、`control-plane/domain/`，增加独立 process/build/typecheck/test scripts、contracts/domain skeleton，调整根 TypeScript include 与依赖闭包测试；不接入用户流量。

**产物**：baseline inventory（现有 JSON、环境变量、Skill `.env` 路径、当前 hash、consumer/target 清单）；migration design；Admin API OpenAPI/DTO 草案。

**验收**：所有既有 Multi Runtime 合约测试不变；新 dependency test 通过；Admin/Router/Host/Local 的生产依赖图无反向 import。

### WP-1：控制面数据与发布内核

**改动**：`cp_*` migration、release state machine、scope resolver、audit writer、optimistic `expectedRevision`、baseline importer、Admin API 的 release/assignment/receipt endpoints。

**验收**：SQLite/PostgreSQL/TiDB migration；相同 scope 冲突被拒绝；release payload hash 不可修改；audit 可关联 actor/resource；baseline import 的内容 hash 与文件一致。

### WP-2：Cloud snapshot delivery（不切流）

**改动**：Cloud `RuntimeConfigurationClient`、缓存、验证、receipt 和 shadow resolver。继续由现有文件配置执行，只记录 control-plane 与文件配置差异。

**验收**：一个 Cloud Host 拉取、校验并回报 baseline；篡改 hash/release/target 被拒绝；delivery 不可用不影响旧文件模式；差异清单为零才允许该 target 进入下一工作包。

### WP-3：Cloud Provider 切流与 Run snapshot

**改动**：`RunEnvironmentResolver`、Run/Plan snapshot reference、in-memory Provider registry/Tool adapter 构造；目标级 `configurationSource=control_plane`，不再读文件。

**验收**：两个并发 Run 分别绑定旧/新 release 时模型 endpoint/策略不串用；fresh Run 的持久链中可查询 release/hash；无有效 snapshot 返回 `configuration_unavailable`；Host 重启后能恢复已确认 snapshot 并重新 receipt。

### WP-4：IntegrationSecretBroker 与 enterprise-info

**改动**：Cloud broker、credential grant/revocation、`enterprise-info` manifest/invocation/script 迁移、secret/audit redaction。

**验收**：脚本源码和 child-process environment 不包含可读 key 路径/值；合法 search/detail 通过且保留 identity binding/HIL/Evidence；无授权 binding、过期 secret、上游失败分别给出稳定错误；日志、Run 事件和数据库不含 secret/token。

### WP-5：Local Agent delivery

**改动**：device-scoped snapshot、Local cache、encrypted envelope/secure storage、Local receipt 和 broker implementation。

**验收**：同一 Provider release 可有 Cloud/Local binding；Local 不获得 Cloud secret，Cloud 不获得 Local secret；离线缓存遵循 `validUntil`；设备撤销后拒绝新 grant/receipt；本机 SQLite/文件不回传云端。

### WP-6：Skill 与 Policy release

**改动**：签名 Skill artifact、下载授权、Local/Cloud install receipt、Practice Profile/Step strategy/Plan Template snapshot adapters。

**验收**：未验签或未加载 Skill 不进入可调度 catalog；Profile 只影响其允许的 guidance；策略发布不改变已有 Run；新 Run 同时记录 Skill package hash 和 policy release。

### WP-7：运营与管理前端

**改动**：Admin Web 的 Integration/Model、Skill、Policy、Runtime、用户/成员、会话/Run trace、Audit 页面；Identity Port 抽取并实现成员管理；Router Runtime operation port。

**验收**：Admin Web 不直连数据库；只读 trace 可完整显示 Router/Runtime 已有事实或明确缺失边界；drain/recovery 有权限、expected revision、审计和状态回读；普通用户 token 不能调用 `/admin/v1`。

### WP-8：去除文件权威性

**改动**：逐 target 移除正常运行文件 loader，JSON/.env 只保留安装 bootstrap、开发显式模式和受控 emergency rollback import；更新部署清单。

**验收**：Cloud/Local 代表性 Run、Host/Agent 重启、secret 轮换、Skill 安装、回滚和审计均通过；没有任何 control-plane target 依赖未记录的文件 fallback。此时才可删除旧生产文件路径。

## 6. 管理端前后端实现顺序

Admin Web 不等待全部能力完成。每个页面只在对应 API/resource 已稳定后建立：

1. WP-1 后：release 列表、详情、校验错误、audit 时间线；只读/发布基础页。
2. WP-2/3 后：Provider/Model 路由、target assignment、receipt 与差异视图。
3. WP-4/5 后：Integration binding、secret rotation status、Cloud/Local target 状态；不展示 secret。
4. WP-6 后：Skill/Policy 发布、签名、安装/加载和 observe/canary/rollback。
5. WP-7 后：用户、租户、Runtime 和事实追踪页。

前端 feature 只请求自己的 typed query/command client；不允许在 React component 中组装 release payload、scope precedence 或权限判断。该类规则必须由 domain/API 统一执行，前端只做输入友好校验和展示。

## 7. 首个实施 PR 的精确范围

首个 PR 只完成 WP-0，不触碰 Cloud/Local 执行行为：

- 新建上述应用内目录和独立 process/build/typecheck/test scripts；
- 定义 `RuntimeConfigurationSnapshot`、release/assignment/receipt/error DTO；
- 提供 control-plane domain 的无副作用 scope/release state-machine 单元测试；
- 增加 import-boundary CI 测试；
- 编写 baseline inventory（不读取或提交任何真实 secret）；
- 为后续 `cp_*` migration 写测试夹具和 dialect contract，但不运行生产迁移。

这样先锁住代码分层和跨应用协议，再创建表或改变 Host/Kernel 行为。首个会实际改变一条运行链路的 PR 应是 WP-2（shadow delivery），不是 Admin 页面。

## 8. 全程证明要求

每个工作包提交前运行其范围内类型检查、单元/合约测试和 migration dialect 测试。切流工作包还必须进行 fresh Cloud/Local Run 验证，保存：

```text
release + target assignment + apply receipt
→ admission snapshot
→ selected model / integration / skill evidence
→ Assessment
→ TerminalCommitter
→ Outcome
```

页面可见、release 显示 active、Host 日志说“已加载”或配置表有行都不单独构成完成证明。不得因测试通过而声称 Host/Agent 已重启、设备已安装、浏览器流已验证或生产密钥已轮换。

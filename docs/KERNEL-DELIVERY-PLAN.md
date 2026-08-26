# AgentLoop 内核化交付改造方案

> 状态：方案评审稿 v2（未实施）
> 目标读者：agentloop 维护团队
> 关联文档：[架构设计](ARCHITECTURE.md)、[部署边界](../README.md)

## 1. 背景与目标

当前 agentloop 是单体应用：内核（runtime/planning/tools/skills/storage）、HTTP 层、auth、前端耦合在同一进程入口 `src/app.ts`。

交付目标：把 agentloop 作为**智能体内核**发布为 npm 包，专业应用安装后构建各自领域的智能体（数据资产管理、生态环境评估、合同法审等）。核心诉求：

| # | 诉求 | 结论 |
|---|---|---|
| 1 | 内核发布为 npm 包，新应用直接使用 | 出口拆分与打包（P0-5） |
| 2 | 外部应用对接自己的用户体系 | 内核只认不透明 `userId` 字符串，已天然满足（§2.2） |
| 3 | 应用自己配置数据访问层管理 skill 持久化 | 需要 **SkillStore 存储 SPI**（P0-3） |
| 4 | 团队自有 skill 放在自己目录，与内置 skill 共存 | 需要**多 Skill 目录支持**（P0-1） |
| 5 | 自定义 skill 目录在运行时进入持久化 | 需要**目录发现持久化**（P0-4，依赖 P0-3） |
| 6 | 扩展的 skill 对应用所有用户全局可见可选 | `SKILL_DIRECTORY` 发现机制已是全局语义；多目录落地即满足 |
| 7 | 按用户控制可见 skill 范围 | 需要**可见性钩子**（P0-2） |
| 8 | 配置可用模型 | 现成：`LlmProviderRegistry.fromConfigFile` 或自定义 `modelFactory` |
| 9 | 注册可被发现的 MCP 服务 | 需要 **MCP 桥接层**（P1-1） |
| 10 | 配置产物目录 | 现成：`workspaceRoot` + 会话隔离布局 |

## 2. 总体架构

### 2.1 资产 → 出口映射

```text
@yourorg/agentloop（单一包，子路径出口）
├── "."            → src/index.ts      内核：RunService / SkillService /
│                                      planning / tools / skills / storage / mcp
├── "./server"     → src/server.ts     可选层：createAgentLoopServer +
│                                      AuthService（独立部署场景才需要）
├── skills/        随包发布的内置 Skill 集合，宿主配进 skillDirectories 即生效
└── web/           不进包。前端本就走 HTTP API，作为独立 React 应用单独交付
```

内核内部新增模块：`src/mcp/`（MCP 客户端桥接）、`src/storage/stores/`（SkillStore 默认实现）。

### 2.2 边界契约

**身份**：`RunService` 对用户体系零依赖——`actorUserId` 只是不透明归属字符串（落库为 `owner_user_id`，按其隔离查询），不存在 users 表外键校验，也不 import `AuthService`。宿主直接传自己应用的用户 ID。

```text
宿主应用（自有登录/会话/OIDC/权限 + 自有数据访问层）
   │ runs.execute(userId, input)          ← 唯一身份接缝
   │ new SkillService(db, { skillStore }) ← 存储接缝（可替换为宿主 DAL）
   ▼
agentloop 内核（userId 不解释、不验证；持久化经 SPI 抽象）
```

内置 email+密码 `AuthService` 仅属于 `./server` 可选层；嵌入式宿主不创建它。

**持久化（两级抽象）**：

| 层级 | 接口 | 默认实现 | 宿主替换 |
|---|---|---|---|
| 连接级 | `SqlConnection`（storage/connection.ts） | `SqliteConnection` | 提供 PG/MySQL 等连接，跑内核自有 schema |
| 仓储级 | `SkillStore` SPI（P0-3 新增） | `SqliteSkillStore`（基于 SqlConnection + 内核 schema） | 宿主用自己的 ORM/表结构实现同一接口 |

规则：宿主只传 `SqlConnection` → 内核建自己的表（现状行为）；宿主传 `skillStore` → skill 持久化完全由宿主数据层接管，内核不再要求 skills 表存在。Run/Plan/Batch 等其余仓储暂维持连接级注入，SPI 化按同一模式后续扩展（见 P2）。

注意事项（写入集成文档）：SQLite 单写者；嵌入式场景每应用实例独立库文件，禁止多进程共享同一库文件。

**配置**：嵌入模式下一切经构造参数（`skillDirectories`、`skillStore`、`mcpServers`、`tools`、`workspaceRoot`、`systemPrompt` 等）；环境变量解析只存在于 `./server` 层的 `app.ts`。

### 2.3 宿主装配形态

```ts
import {
  AppDatabase, RunService, SkillService, LlmProviderRegistry, createWebTools,
} from "@yourorg/agentloop";
import { contractTools } from "@team/contract-tools";
import { HostAppSkillStore } from "./host-skill-store";   // 宿主自己的 DAL 实现

const database = new AppDatabase("./data/app.db");
const providers = await LlmProviderRegistry.fromConfigFile("./llm-providers.json");

const skills = new SkillService(database, {
  // 内核自带 skills/（随包路径）+ 团队自己的目录共存（P0-1）
  skillDirectories: [
    resolve(require.resolve("@yourorg/agentloop/package.json"), "../skills"),
    "/srv/team-app/skills",
  ],
  // skill 持久化交给宿主数据访问层（P0-3；缺省则用内核默认 SQLite 存储）
  skillStore: new HostAppSkillStore(hostOrm),
  // 目录发现的 skill 运行时同步进持久层（P0-4，随 skillStore 能力接口生效）
  // 按用户控制可见范围（P0-2 钩子）
  selectVisibleSkills: async ({ userId, skills }) =>
    filterByHostPermission(userId, skills),
});

const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, key) => providers.create(key, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot: "/srv/team-app/artifacts",
  systemPrompt: "你是合同法审专家……",
  tools: [
    ...contractTools,
    // 搜索 key 由宿主自己的密钥源提供（§P0-7）
    ...createWebTools({ searchProvider: "bing", searchApiKey: await secrets.get("search-key") }),
  ],
  // 注册可被发现的 MCP 服务（P1-1）
  mcpServers: [
    { key: "contract-db", transport: "stdio",
      command: "/srv/team-app/bin/contract-mcp", args: ["--readonly"] },
    { key: "env-data", transport: "http", url: "https://mcp.internal/env" },
  ],
});

// 宿主用自己的 userId 直接发起
await runs.execute(hostAppUserId, "审查这份合同的付款条款");
```

## 3. 边界契约依据（已核实）

以下结论均已在源码核实，是本方案的前提：

| 结论 | 位置 |
|---|---|
| `actorUserId` 无用户表校验，纯归属键 | `run-service.ts` 全部经 `getByOwner/listByOwner/findConversation(actorUserId,…)` |
| Skill 三条消费路汇聚一点 | `listAvailable`(skill-service.ts:138)、`resolveForConversation`(:146)、`resolveForAgent`(:142) 全部经 `availableForOwner`(:347) |
| 目录 Skill 天然全局 | `discoveredPrivateSkills(ownerUserId)` 对任意 userId 映射同一份 `directoryEntries`(:356)，按用户物化只读 Package |
| 同名保护：全局优先、用户不可遮蔽 | `assertNotDiscoveredSkillName`(:388)；`availableForOwner` 过滤撞名私有 Skill(:350) |
| metadata 是参选资格而非发现条件 | 无 `agentloop:` 块可被发现，但 `selectFirstRoundSkillRole` 第一行即排除（run-service.ts:2717），永不进入 Planner |
| 工具注入点现成 | `RunService` 构造参数 `tools: RuntimeTool[]` → `createCoreTools.pluginTools`（compose.ts:20） |
| 存储接口抽象现成（连接级） | `SqlConnection`（storage/connection.ts），SQLite 只是其一 |
| Skill 仓储方法面小而稳定，适合 SPI 化 | `SkillRepository` 共 8 个公开方法，签名与 SQL 无耦合（skill-repository.ts:32-167） |
| 目录发现当前为内存态 | 发现结果仅存 `directoryEntries` 内存字段；DB 行只有显式导入的 Package（`installFromDirectory`） |

## 4. 改造项明细

### P0-1 多 Skill 目录支持

**改动触点**

| 文件 | 改动 |
|---|---|
| `src/skills/skill-service.ts:58` | `SkillServiceOptions` 新增 `skillDirectories?: readonly string[]`；保留 `skillDirectory?` 单数兼容 |
| 同上 :79-88 构造 | 归一化为 `configuredSkillDirectories: readonly string[]`（单数并入数组首位） |
| 同上 :95 getter | 新增 `get skillDirectories()`；`get skillDirectory()` 保留、返回首个，标注 deprecated |
| 同上 :99 `refreshSkillDirectory()` | 遍历全部目录调用 `discoverSkillDirectory` 并合并；**跨目录重名 fail-closed 抛错**（与单目录内重名拒绝行为一致） |
| `src/runtime/run-service.ts:254` | readOnlyRoots 收录全部目录：`[..., ...skills.skillDirectories]` |
| `src/runtime/run-service.ts:1119` | 刷新条件改为 `skillDirectories.length > 0` |
| `src/app.ts:20` | 新增 `SKILL_DIRECTORIES_JSON`（JSON 数组），与 `SKILL_DIRECTORY` 合并去重；启动日志列出全部目录 |

**语义决策**：跨目录同名 = 启动/刷新失败（fail-closed）。理由：静默先到先得会让"哪个团队的 skill 生效"取决于目录顺序，排障成本高；显式失败逼部署方解决冲突或用 `<name>.disabled.json` 显式隔离。

**验收测试**（`tests/skill-directory-discovery.test.ts` 扩展）：
- 两个目录的 skill 均被发现，catalog 按 name 合并排序
- 跨目录重名 → `refreshSkillDirectory` 抛错且错误信息含两个来源目录
- 单数 `skillDirectory` 行为回归不变
- `.disabled.json` / `.source.json` 在各目录内独立生效

### P0-2 Skill 可见性钩子 `selectVisibleSkills`

**设计**

```ts
// SkillServiceOptions 新增
selectVisibleSkills?: (context: {
  userId: string;
  /** 全量候选：全局目录 Skill + 用户私有 Skill（已按同名规则合并） */
  skills: readonly PrivateSkill[];
}) => readonly PrivateSkill[] | Promise<readonly PrivateSkill[]>;
```

**应用点**：`availableForOwner`（skill-service.ts:347）内部末尾调用。因三条消费路（目录 API / 会话规划 / 子 Agent 绑定）都经过它，一处生效即全覆盖，杜绝"目录看不到、Planner 却能选中"。

**语义要点**

| 要点 | 说明 |
|---|---|
| 异步 | 宿主几乎必然查自己的权限存储 |
| fail-closed | 钩子抛错向上传播：该请求无可用 Skill / Run 失败，绝不回退全量 |
| 可见性 ≠ 授权 | 钩子只管"进 Planner 视野"；实际能力仍由 Capability Grant + Admission 把关，两层独立 |
| 未配置 = 行为不变 | 默认全量通过，零破坏 |

**验收测试**：
- 钩子过滤后：`GET /v1/skills`、Planner 候选、`resolveForAgent` 三处一致收敛
- 钩子抛错 → Run 以明确错误失败（不静默回退全量）
- 未配置钩子 → 全部现有测试原样通过

### P0-3 SkillStore 存储 SPI（宿主数据访问层）

**目标**：宿主应用可以用自己的 ORM/表结构管理 skill 持久化，而不是被迫接受内核 schema。

**设计**

```ts
// src/storage/stores/skill-store.ts —— 接口从现有 SkillRepository 方法面原样提升
export interface SkillStore {
  findIdByOwnerAndName(ownerUserId: string, name: string): { id: string } | undefined;
  listByOwner(ownerUserId: string): SkillRecord[];
  listPackageSkills(): SkillRecord[];
  listPackageSkillsWithoutSourceProvenance(): SkillRecord[];
  findByIdAndOwner(skillId: string, ownerUserId: string): SkillRecord | undefined;
  insert(input: SkillInsertRecord): void;            // 重名 → 抛 conflict 语义错误
  updatePackageMetadata(input: PackageMetadataRecord): void;
  deletePackageSkillById(id: string): void;
}

export class SqliteSkillStore implements SkillStore { /* 现 SkillRepository 平移 */ }
```

**接入方式**：`SkillServiceOptions.skillStore?: SkillStore`。未提供时 `new SkillService(database)` 行为与现状逐字节一致（内部构造 `SqliteSkillStore(database)`）；提供后 `SkillService` 全部读写经 SPI，不再触碰 skills 表。

**契约要点**
- 记录类型用宿主友好的驼峰命名（`SkillRecord`），替代现在的 snake_case 行对象——转换边界收在 `SqliteSkillStore` 内
- `insert` 重名冲突必须在 SPI 层表现为统一 conflict 错误（现由 SQLite UNIQUE 约束映射而来，SPI 契约显式化）
- 同步方法面保持现状（内核调用点均为同步）；异步扩展留到需要时
- 本期 SPI 范围仅 skill；Run/Plan/Batch 维持连接级注入，避免一次性大爆炸重构

**验收测试**：
- 以内存 Map 实现 `SkillStore` 注入，跑通完整 Run 主链（创建/列出/选择/物化校验/更新元数据）
- 缺省路径回归：不传 `skillStore` 时全部现有测试零修改通过
- SPI 实现抛 conflict → HTTP 层仍返回 409 语义

### P0-4 目录发现持久化（运行时入持久层）

**现状差距**：目录发现的 skill 只存内存（`directoryEntries`），文件系统是唯一权威；DB 中只有显式导入的 Package 行。宿主的 DAL 看不到"全局目录里现在有哪些 skill"，也无版本变更轨迹。

**设计**：`refreshSkillDirectory()` 在合并扫描后，将发现快照同步进持久层。采用**附加式能力接口**，避免强制所有 SkillStore 实现方跟进：

```ts
// 可选能力：宿主 SkillStore 可以选择性实现
export interface SkillDiscoveryPersistence {
  /** 全量对账：upsert 当前发现集，移除已消失条目；packageHash 变更 → 版本递增 */
  syncDiscoveredSkills(records: readonly DiscoveredSkillRecord[]): void;
  listDiscoveredSkills(): DiscoveredSkillRecord[];
}

export interface DiscoveredSkillRecord {
  name: string; description: string;
  sourceDirectory: string;                       // 来源目录（多目录后可区分团队）
  packageHash: string; fileCount: number; totalBytes: number;
  agentLoop?: SkillAgentLoopMetadata;
  syncedAt: number; version: number;
}
```

- `SqliteSkillStore` 默认实现两者（新增 `discovered_skills` 表，schema 由内核迁移负责）
- `refreshSkillDirectory()` 末尾：若 store 实现了该能力接口 → 对账写入；否则维持纯内存（现状）
- 备选方案（否决）：复用 skills 表加 `source_kind='discovered'` + 保留属主——查询路径改动大、与同名保护逻辑纠缠，收益不抵风险
- 与 P0-1 协同：`sourceDirectory` 字段天然记录"来自哪个团队的目录"

**价值**：宿主 DAL 统一看到三类记录（内联/导入包/目录发现）；hash 变更轨迹可用于审计；`selectVisibleSkills` 钩子可关联宿主业务数据做范围决策。

**验收测试**：
- 默认 store：启动刷新后 `discovered_skills` 有行且与目录一致；修改 SKILL.md 再刷新 → version+1、hash 更新；删除目录条目再刷新 → 行被清理
- 仅实现基础 SPI 的宿主 store：不触发同步、无报错（能力探测）

### P0-5 出口拆分与打包发布

**改动触点**

| 文件 | 改动 |
|---|---|
| `package.json` | `"exports": { ".": "./src/index.ts", "./server": "./src/server.ts" }`；`"files": ["src", "skills", "README.md", "THIRD_PARTY_NOTICES.md"]`；发布前去除 `"private": true`；`engines.node: ">=26"` 保留并写明原因（TS 源码直发，Node 原生类型剥离运行） |
| `src/index.ts:1-2` | `AuthService` 导出迁移到 server 出口；主入口保留一行过渡 re-export，注释标注迁移目标 |
| `src/index.ts:46` | `createAgentLoopServer` 同上处理 |
| 新增 `src/server.ts` | re-export server 层全部符号，作为正式出口 |

**发布渠道**：私有 npm registry 为主，git tag 兜底，monorepo `file:` 用于联调。

**验收**：`npm pack` tarball 在干净目录 `file:` 安装后跑通 §2.3 裁剪版装配脚本；`import("agentloop")` 与 `import("agentloop/server")` 均可解析。

### P0-6 集成契约文档 `docs/INTEGRATION.md`

内容清单：
1. 五分钟装配示例（§2.3 完整版）
2. **userId 契约**：不透明字符串、宿主全权负责鉴权与授权
3. **持久化契约**：两级抽象（`SqlConnection` / `SkillStore` SPI）、默认 schema 归属、SQLite 单写者限制、宿主 DAL 实现指引与 conflict 语义
4. **SKILL.md 契约**：frontmatter 必填字段、`agentloop:` metadata 字段表（roles / artifactKinds / sourceKinds / qaKinds / executionProfiles 枚举）、无 metadata = 不会参选规划的行为说明
5. **RuntimeTool 规范**：接口字段语义（executionMode / replaySafe / timeoutMs / maxResultCharacters）、危险工具门控、`web-tools.ts` 参考实现
6. **MCP 注册规范**（P1-1 落地后）：服务配置、工具命名、风险分级、超时与截断
7. **配置与密钥专章**（§P0-7）：模型四条路、搜索 key 注入、apiKeyEnv 引用模式、environment 自定义密钥源、密钥红线
8. **产物目录**：`workspaceRoot` 会话隔离布局、`visibleDirectories` 只读授权、归档建议
9. **钩子规范**：`selectVisibleSkills` 语义（异步/fail-closed/可见性≠授权）
10. **安全边界清单**：`allowDangerousTools`、Workspace containment、密钥不入 Computer/MCP 子进程

### P1-1 MCP 服务注册与桥接

**目标**：宿主注册 MCP Server，其工具自动进入 Planner 可用工具目录，与本地 `RuntimeTool` 同台竞争、同受 Admission 与危险门控管住。

**配置形态**

```ts
// RunService 构造参数新增
mcpServers?: readonly McpServerRegistration[];

interface McpServerRegistration {
  key: string;                          // 工具命名空间前缀来源，kebab-case
  transport: "stdio" | "http";
  command?: string; args?: readonly string[]; env?: Record<string, string>;  // stdio
  url?: string; headers?: Record<string, string>;                            // http
  trust?: "trusted" | "untrusted";      // 默认 untrusted → 全部工具按危险门控处理
  timeoutMs?: number;                   // 单次工具调用上限，默认沿用内核 Tool deadline
}
```

**桥接机制**
- 新模块 `src/mcp/`：最小 MCP 客户端（JSON-RPC over stdio/HTTP），或引入 `@modelcontextprotocol/sdk`（见待拍板 #7）
- 每个 Run 启动时建立/复用连接并 `tools/list`，把每个 MCP 工具包装为 `RuntimeTool`：
  - 名称规范化：`mcp_<key>_<tool>`（符合内核 tool name 约束，杜绝跨服务器撞名）
  - `inputSchema` 透传 MCP 的 JSON Schema
  - `executionMode: "exclusive"`、`replaySafe: false`（外部副作用未知，保守默认）
  - 结果封 `toolEvidenceReceipt`（`sourceType: "mcp"`、含 serverKey），纳入既有证据链
  - 服务器失联 → 该服务器工具本轮缺席，Run 不失败（降级可见性）
- 与现有链路零特判：包装后的工具走 `composeRunTools` → Planner 目录 → Admission 校验 → Capability Grant 门控，无任何新旁路
- 快照一致性沿用现有哲学：每步重新物化 Tool Schema（OpenCode 移植边界），MCP 工具列表变化自然反映

**安全红线**：stdio 子进程环境由服务端构造，拒绝含 KEY/TOKEN/SECRET/PASSWORD/AUTH 字样的变量名（与 `TRUSTED_COMMAND_ENV_JSON` 同规则）；`untrusted` 服务器的工具必须 Run 显式 `allowDangerousTools` 才暴露给模型。

**验收测试**：
- 内存 stub MCP server：注册后工具出现在 `/v1/tools` 与 Planner 目录；Plan 声明后可调用并产出 receipt
- 服务器宕机 → 该前缀工具缺席，其余照常
- untrusted + 未授权危险工具 → 模型 Schema 中不可见
- 工具名跨 server 冲突 → 启动报错

### P0-7 配置与密钥接入面

**总原则**：包本身不读环境变量、不碰密钥文件；一切配置经构造参数注入，密钥来源是宿主的责任。内核只保证"密钥永不落盘、落库、进 Run 记录、进子进程"。

**模型配置（宿主四条路）**

| 方式 | 现状 | 说明 |
|---|---|---|
| `LlmProviderRegistry.fromConfigFile(path)` | ✅ 现成 | JSON 注册表只存环境变量名（`apiKeyEnv`），`create()` 时才解析密钥 |
| `fromConfigFile(path, environment)` | ✅ 现成 | 第二参数可传任意查找表——宿主用自己的 KMS/配置中心缓存替代 `process.env` |
| `LlmProviderRegistry.fromConfigObject(config, environment?)` | ⚠️ 需新增 | 把现有私有静态 `fromJson`（provider-registry.ts:172）提升为公开入口；宿主从自己配置中心拉到 JS 对象时无需落盘临时文件。约 10 行改动 + 测试 |
| `modelFactory: () => myAdapter` | ✅ 现成 | 完全自定义，连注册表都不用 |

**搜索 key**：`createWebTools({ searchProvider, searchEndpoint, searchApiKey })` 已完全程序化；app.ts 的 `WEB_SEARCH_*` 环境变量解析属于 server 层，嵌入式宿主不经由它。

**密钥红线**（写入 INTEGRATION.md 专章）：
1. 配置文件/对象只存密钥引用（环境变量名或宿主侧句柄），不存密钥本体
2. 密钥不进入 SQLite、Run 记录、事件日志
3. Computer 子进程与 MCP stdio 子进程环境拒绝含 KEY/TOKEN/SECRET/PASSWORD/AUTH 字样的变量名（沿用 `TRUSTED_COMMAND_ENV_JSON` 规则）

**验收测试**：`fromConfigObject` 与文件式产出等价注册表；environment 注入自定义查找表后密钥解析正确且不出现在任何持久化记录中。

### P1-2 治理项（评审拍板后实施）

| 项 | 设计 | 缺省 |
|---|---|---|
| `allowInlineSkills?: boolean` | false 时 `POST /v1/skills` 与 `POST /v1/skills/import-directory` 返回 403；目录发现不受影响 | true（现状） |
| 内联 Skill 创建时 metadata 校验 | `create` 解析 instructions 中 `agentloop:` 块，缺块或非法 → 422，消除静默不可参选 | 关闭，选项开启 |
| HTTP auth 适配点 | `createAgentLoopServer({ auth })` 已注入；文档给出对接外部账号的同签名实现规范 | — |

### P2 远期（记录在案，不在本期）

- `selectVisibleTools` 对称钩子：挂在 `composeRunTools` / `allowedToolNames`（run-service.ts:1162-1174）
- 其余仓储（Run/Plan/Batch/Event）按 `SkillStore` 同模式 SPI 化
- PostgreSQL `SqlConnection` 实现；多副本部署演进（PG + 队列 + fenced lease + SSE）

## 5. 兼容性承诺

1. `SKILL_DIRECTORY` 单数环境变量与 `skillDirectory` 选项持续生效
2. 主入口既有导出符号不删除（auth/server 符号保留过渡期 re-export）
3. 全部现有测试（`npm test`）零修改通过
4. 未配置新选项时（`skillStore`/`mcpServers`/钩子等），运行时行为与改造前逐字节一致
5. 内核 schema 变更仅限**新增** `discovered_skills` 表，不改既有表

## 6. 实施顺序

| 步骤 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| 1 | P0-1 多 Skill 目录 + 测试 | 0.5 天 | — |
| 2 | P0-2 可见性钩子 + 测试 | 0.5 天 | — |
| 3 | P0-3 SkillStore SPI + 测试 | 1 天 | — |
| 4 | P0-4 发现持久化 + 测试 | 1 天 | 步骤 3 |
| 5 | P0-5 出口拆分 + npm pack 冒烟 | 0.5 天 | — |
| 6 | P0-6 INTEGRATION.md（含配置与密钥专章） | 0.5 天 | 步骤 1–5 |
| 6.5 | P0-7 `fromConfigObject` 公开入口 + 测试 | 0.5 天 | — |
| 7 | P1-1 MCP 桥接 + 测试 | 2–3 天 | 步骤 5 |
| 8 | P1-2 治理项（拍板后） | 各 1–2 小时 | — |

步骤 1–5 完成即可支撑第一个试点团队接入（MCP 可先以 `tools:` 手工包装过渡）；步骤 7 让 MCP 成为正式能力。

## 7. 待拍板事项

| # | 事项 | 建议 |
|---|---|---|
| 1 | 跨目录重名策略 | fail-closed（§P0-1） |
| 2 | 包名 | `@yourorg/agentloop`（占位，定正式 scope） |
| 3 | 发布渠道 | 私有 registry 优先，git tag 兜底 |
| 4 | 是否允许终端用户自建内联 Skill 与全局共存 | 默认允许；严格领域由宿主设 `allowInlineSkills: false` |
| 5 | 内联创建 metadata 强校验是否默认开启 | 默认关闭，集成文档强烈建议开启 |
| 6 | SkillStore SPI 是否本期覆盖 Run/Plan 等其余仓储 | 否——本期仅 skill，其余 P2 按同模式跟进（§P0-3 契约要点） |
| 7 | MCP 客户端实现方式 | 优先最小自研 JSON-RPC 客户端（延续近零依赖哲学）；若 stdio/http 之外的传输或复杂能力（sampling/roots）成为需求再引入官方 SDK |
| 8 | MCP 工具默认风险分级 | 默认 `untrusted`（全按危险门控），宿主逐服务器显式信任 |

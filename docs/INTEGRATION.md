# AgentLoop 内核集成指南

面向把 `agentloop` 作为智能体内核嵌入自己应用的开发团队。读完本篇，你将完成一次最小可运行装配，并了解全部边界契约。

> 内核改造方案见 [KERNEL-DELIVERY-PLAN](KERNEL-DELIVERY-PLAN.md)；架构背景见 [ARCHITECTURE](ARCHITECTURE.md)。

## 1. 安装与五分钟装配

```bash
# 私有 registry（发布后）
npm install @zhujun/agentloop
# 或 git tag
npm install git+ssh://git@your-vcs/you/agentloop.git#v0.1.0
```

要求 Node.js ≥ 26。包以编译后 JS + `.d.ts` 发布（`exports` 指向 `dist/`）。

```ts
import {
  AppDatabase,
  RunService,
  SkillService,
  LlmProviderRegistry,
  createWebTools,
} from "@zhujun/agentloop";
// 注意：内核是 headless 库，不包含 HTTP Server 与账号体系。
// 参考实现（HTTP API + AuthService + Web 前端）见仓库内 apps/agentloop-app。

const database = new AppDatabase("./data/app.db");
const providers = await LlmProviderRegistry.fromConfigFile("./llm-providers.json");

const skills = new SkillService(database, {
  skillDirectories: ["./skills"],           // 见 §3
  // selectVisibleSkills: ({ userId, skills }) => filterByScope(userId, skills),  // 见 §4
});

const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, key) => providers.create(key, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot: "/srv/your-app/artifacts", // 见 §8
  tools: [...createWebTools({ searchApiKey: process.env.SEARCH_KEY })],
});

const run = await runs.execute("your-user-id-42", "帮我整理这份报表");
```

就这些——Plan、Admission、依赖调度、Step 执行、评估、Terminal Commit、事件流全部由内核完成。

### 本地 sidecar 模式

如果宿主应用不是 Node 26 进程，先不要把包装进宿主。把参考应用作为本地 sidecar 启动，让宿主通过 HTTP 调用稳定 Host Protocol：

```bash
cd /path/to/agentloop
npm start
```

宿主只依赖以下协议面：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/v1/host/protocol` | 返回 `agentloop.hostProtocol/v1`，声明可用 endpoint 和契约版本 |
| `POST` | `/v1/host/runs` | 同步执行并返回 `agentloop.hostRun/v1` 投射 |
| `POST` | `/v1/host/runs/async` | 异步启动并返回可跟踪的 `agentloop.hostRun/v1` 投射 |
| `GET` | `/v1/host/runs/:id` | 读取 Run、Outcome、Plan 摘要、Artifact 和事件游标 |
| `GET` | `/v1/host/runs/:id/events` | 读取 `agentloop.hostRunEvent/v1` 事件列表 |
| `GET` | `/v1/host/runs/:id/events/stream` | SSE 订阅 `agentloop.hostRunEvent/v1` |

Host Protocol 是给 Python/FastAPI、Java、Go 等宿主适配层用的稳定投射。它只暴露 Outcome/Plan/Artifact/Event 的紧凑视图；宿主不读取 AgentLoop SQLite，也不把普通工具成功当作完成。

## 2. 用户体系契约（最重要）

**内核只认一个不透明字符串 `userId`。**

- 你传什么，内核就把数据归属到什么（runs/conversations/skills/sources/batches 全部按它隔离）
- 内核不验证、不解释、不要求该 id 在任何内置表里存在；业务表对内核自带 `users` 表**没有外键**
- 鉴权与授权完全在你的应用内完成：谁能调 `execute`、能用哪些工具、能看哪些 Skill，由你的调用方代码决定
- 内置 email+密码 `AuthService` 与 HTTP Server 不在内核包内，参考实现在 `apps/agentloop-app`（可直接复制改造）；嵌入宿主自带身份时不创建它们

## 3. Skill 目录

```ts
new SkillService(database, {
  skillDirectories: [
    "./skills/team-a",
    "/srv/shared/approved-skills",
  ],
})
```

- 每个目录下的直接子目录若包含标准 `SKILL.md` 即被发现；发现结果对**所有用户全局可见可选**（每个用户首次使用时物化出隔离的只读副本并锁定 hash）
- **跨目录重名 = fail-closed 报错**（启动及每次 Run 前刷新时暴露）；用同级 `<name>.disabled.json` 显式隔离某个包
- 可选的 `<name>.source.json` 提供上游来源核验（HTTPS URL + 40 位 commit + 包 hash），不影响准入
- 单数选项 `skillDirectory` 与环境变量 `SKILL_DIRECTORY` 继续兼容；新代码请用复数
- 发现快照会同步进默认持久层（`discovered_skills` 表：内容变更版本递增、包删除即清理），宿主自研 Store 可实现 `SkillDiscoveryPersistence` 能力接口参与同步

### SKILL.md 契约

```markdown
---
name: my-domain-skill            # 必填，kebab-case ≤80 字符，须等于目录名
description: 一句话说明用途        # 必填，1–2000 字符，Planner 依据它选择
agentloop:                        # 强烈建议：没有它，Skill 不会参选规划！
  roles:
    - primary_builder             # primary_builder | source_provider | support | qa
  artifactKinds:
    - document                    # html | document | presentation | spreadsheet | image | code | none
  sourceKinds:
    - document                    # api | database | dataset | document | repository | rubric | web
  qaKinds: []
  executionProfiles:              # local_script → 自动要求 computer_run_command 授权
    - local_script
---

正文（唯一领域工作流权威；相对路径相对 Skill 根目录）。
```

注意：无 `agentloop:` 块的 Skill 能被**发现**但永远不会进入 Planner 视野（参选资格硬门槛）。用户级内联 Skill 的 instructions 里同样可以携带该块。

`agentloop:` metadata 是 Runtime/Planner 的通用契约，不承载领域业务分类。字段、类型和可选值以 `packages/agentloop/src/skills/agentloop-metadata.ts` 的 `SKILL_AGENT_LOOP_METADATA_FIELDS` 为权威；领域材料名称、评分模型、行业规则等只能写在 Skill 正文或 references 中。

| 字段 | 类型 | 必填 | 可选值 |
|---|---|---:|---|
| `roles` | list | 是 | `primary_builder`, `source_provider`, `support`, `qa` |
| `artifactKinds` | list | 是 | `html`, `document`, `presentation`, `spreadsheet`, `image`, `code`, `none` |
| `sourceKinds` | list | 否 | `api`, `database`, `dataset`, `document`, `repository`, `rubric`, `web` |
| `qaKinds` | list | 否 | `browser`, `content`, `openability`, `playwright`, `visual` |
| `executionProfiles` | list | 否 | `local_script` |

## 4. 可见性钩子

```ts
selectVisibleSkills: async ({ userId, skills }) => {
  const scope = await yourAuthzStore.skillScope(userId); // 宿主自己的权限数据
  return skills.filter((skill) => scope.has(skill.name));
}
```

- 一个钩子同时管住三处消费：目录 API、会话规划候选、子 Agent 绑定
- **fail-closed**：钩子抛错 = 该请求失败，绝不回退全量
- 异步支持：随便查你的数据库/中台
- 可见性 ≠ 授权：真正的能力执行仍由 Capability Grant + Plan Admission 把关
- 未配置 = 行为不变

## 5. 专业工具注入

实现 `RuntimeTool<T>` 接口即可，注入后自动进 Planner 工具目录、Admission 校验、危险门控：

```ts
import type { RuntimeTool } from "@zhujun/agentloop";

export const assessContractTool: RuntimeTool<{ docId: string }> = {
  name: "contract_assess",
  description: "对给定合同执行法审评估并产出结构化结果",
  inputSchema: {
    type: "object",
    properties: { docId: { type: "string" } },
    required: ["docId"],
  },
  executionMode: "exclusive",     // 有副作用用 exclusive；纯读用 parallel
  replaySafe: false,              // 是否可在恢复重放中安全重复执行
  timeoutMs: 60_000,              // 单次执行上限（进 Runtime Action deadline）
  maxResultCharacters: 50_000,    // 结果截断阈值
  parse(input) {                  // 校验并返回强类型输入；抛错=400
    if (typeof (input as any).docId !== "string") throw new Error("docId required");
    return input as { docId: string };
  },
  async execute({ grant, signal }, input) {
    // grant.workspaceRoot / grant.actorUserId 可用；signal 支持取消
    return await callYourService(input.docId, signal);
  },
};

new RunService({ ..., tools: [assessContractTool] });
```

参考实现：`src/tools/web-tools.ts`（含证据回执 evidenceReceipt 范式）。危险工具（写文件/命令/GUI）默认不授权，Run/Batch 必须显式 `allowDangerousTools`。

## 6. 配置模型与密钥

四条路：

| 方式 | 适用 |
|---|---|
| `LlmProviderRegistry.fromConfigFile(path)` | 标准 JSON 注册表 |
| `fromConfigFile(path, environment)` | 密钥来自 KMS/vault 缓存而非进程 env |
| `LlmProviderRegistry.fromConfigObject(obj, environment?)` | 配置对象来自你自己的配置中心 |
| `modelFactory: () => myAdapter` | 完全自定义 ModelAdapter |

JSON schema（`apiKeyEnv` 只存环境变量名，密钥本体永不入配置/DB/日志）：

```json
{
  "defaultProvider": "deepseek",
  "providers": {
    "deepseek": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "YOUR_KEY_ENV_NAME",
      "defaultModel": "deepseek-chat"
    }
  }
}
```

搜索 key：`createWebTools({ searchProvider: "bing" | "baidu", searchEndpoint?, searchApiKey })`。

## 7. 数据访问层（Skill 持久化）

缺省：内核用自有 SQLite schema（含 `discovered_skills`）。要用自己的 ORM/表结构：

```ts
import type { SkillStore } from "@zhujun/agentloop";

class MySkillStore implements SkillStore { /* 8 个方法 */ }
new SkillService(databaseOrNone, { skillStore: new MySkillStore(myOrm) });
```

契约要点：
- `insert`/`updatePackageMetadata` 遇重名必须抛内核 conflict 错误（409 语义）
- 方法面是同步的（与内核调用点一致）
- 提供了 `skillStore` 后，内核不再读写默认 `skills` 表
- Run/Plan/Batch 等其余仓储本期仍走连接级注入（`SqlConnection`），SPI 化在路线图中

SQLite 注意：单写者；每应用实例独立库文件，勿多进程共享。

## 8. 产物目录

- `workspaceRoot`：所有会话工作区根；产物落在 `<workspaceRoot>/conversations/<conversationId>/`
- 写操作严格限制在工作区内（符号链接逃逸防护）
- `visibleDirectories`（按对话 PATCH `/v1/conversations/:id/visible-directories`）：授权只读访问工作区外目录
- 归档建议：会话结束后由宿主侧搬运到你的受控存储；不要为写外部目录而放宽 containment

## 9. 安全红线清单

1. 密钥不进配置文件、SQLite、Run 记录、事件日志
2. Computer/MCP 子进程环境拒绝名称含 `KEY/TOKEN/SECRET/PASSWORD/AUTH` 的变量
3. 危险工具默认拒绝；`allowDangerousTools` 必须显式
4. Skill 正文只能经 `load_skill` 进入对话；目录展示不含正文
5. 模型文本不能自我授权或宣告完成——一切以持久化证据与 Terminal Commit 为准

## 10. 最小装配核对清单

- [ ] Node ≥ 26
- [ ] 安装 `@zhujun/agentloop`
- [ ] `AppDatabase` 指向你应用的 DB 路径（或提供 `skillStore`）
- [ ] 至少一个 LLM Provider 配置 + 密钥注入方式确定
- [ ] `workspaceRoot` 指向产物根
- [ ] Skill 目录就绪且每个 SKILL.md 带 `agentloop:` metadata
- [ ] （可选）`tools:` 注入专业工具、`selectVisibleSkills` 接权限系统
- [ ] 用真实业务 userId 发起首个 Run 并检查事件流

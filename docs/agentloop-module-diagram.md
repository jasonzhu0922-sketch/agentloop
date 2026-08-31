# AgentLoop 应用层次结构图

本文描述当前 monorepo 的代码归属、包依赖和参考应用的运行时装配。它以实际入口与 `package.json` 依赖为准。

## 1. 代码归属与包边界

```mermaid
flowchart TB
  subgraph Repo["agentloop-monorepo"]
    Root["根 package.json\n构建、打包、开发启动脚本"]

    subgraph Packages["packages/"]
      Kernel["@zhujun/agentloop\nheadless 内核 npm 包"]
      SkillPackage["@zhujun/agentloop-skills\n内置 Skill npm 包"]
      KernelSource["src/\nruntime · planning · tools · skills\nstorage · computer · acceptance · batch"]
      BundledSkills["skills/\n可发布的内置 Skill 目录"]
      Kernel --> KernelSource
      SkillPackage --> BundledSkills
    end

    subgraph Apps["apps/"]
      subgraph ReferenceApp["agentloop-app：参考应用"]
        AppMain["src/main.ts\n应用装配入口"]
        Auth["src/auth/\n登录、会话、用户表"]
        Http["src/http/\nREST、SSE、Host Protocol"]
        Web["web/\nReact + Vite 前端"]
        AppConfig[".env / runtime-config.ts\n应用级路径和配置"]
      end
    end
  end

  Host["外部业务应用\n未来的 npm 消费者"]

  Root --> Kernel
  Root --> SkillPackage
  Root --> ReferenceApp
  AppMain -->|包依赖| Kernel
  AppMain -->|包依赖| SkillPackage
  AppMain --> Auth
  AppMain --> Http
  AppMain --> AppConfig
  Web <-->|REST + SSE| Http
  Host -->|安装 dist 包| Kernel
  Host -->|可选：内置 Skill 目录| SkillPackage
```

### 边界结论

| 层 | 负责内容 | 不负责内容 |
|---|---|---|
| `@zhujun/agentloop` | Agent Loop、计划、工具授权与执行、Skill 服务、运行态存储、产物与评估 | HTTP、登录、业务用户表、前端、环境变量解析 |
| `@zhujun/agentloop-skills` | 随 npm 包发布的标准 Skill 目录和 `bundledSkillDirectories()` | Runtime、Tool、Skill 持久化、应用配置 |
| `apps/agentloop-app` | 参考装配、认证、HTTP API、React 前端、应用扩展 Skill 配置 | 不能作为其他应用的内核依赖 |
| 外部业务应用 | 自己的身份、权限、业务 Tool、配置和 UI；通过 npm 包装配内核 | 不应导入参考应用源码或 `packages/agentloop/src` |

## 2. 参考应用启动与依赖注入

`apps/agentloop-app/src/main.ts` 是唯一应用装配入口。它先解析应用配置，再创建内核实例，最后注入 HTTP Server。

```mermaid
flowchart LR
  Env[".env\nPORT · DATABASE_PATH\nWORKSPACE_ROOT · LLM_PROVIDER_CONFIG_PATH\nCUSTOM_SKILL_DIRECTORIES_JSON"] --> Config["resolveApplicationRuntimePaths()"]

  Config --> DBPath["databasePath"]
  Config --> Workspace["workspaceRoot"]
  Config --> ProviderPath["providerConfigPath"]
  Config --> ExtraSkillDirs["customSkillDirectories"]

  DBPath --> Database["AppDatabase"]
  ProviderPath --> Providers["LlmProviderRegistry"]

  Builtins["@zhujun/agentloop-skills\nbundledSkillDirectories()"] --> SkillDirs["skillDirectories"]
  ExtraSkillDirs --> SkillDirs
  Workspace --> PackageStore["workspace/.agentloop/skill-packages"]
  Database --> Skills["SkillService"]
  PackageStore --> Skills
  SkillDirs --> Skills
  Skills --> Sync["syncSkillDirectories()\n发现、对账、刷新元数据"]

  Database --> Auth["AuthService"]
  Database --> Runs["RunService"]
  Skills --> Runs
  Providers -->|modelFactory| Runs
  Workspace --> Runs
  WebTools["createWebTools()\n可选 Web Search"] --> Runs
  Acceptance["可选 Playwright 验收 Provider"] --> Runs
  Runs --> Batches["BatchService"]

  Auth --> Server["createAgentLoopServer()"]
  Skills --> Server
  Runs --> Server
  Batches --> Server
  Providers --> Server
  Server <-->|HTTP / SSE| Frontend["apps/agentloop-app/web"]

  Database --> Sqlite[("data/agentloop.db")]
  Workspace --> ConversationFiles["workspace/conversations/"]
  Workspace --> Uploads["workspace/uploads/"]
```

## 3. 内核内部关系

`RunService` 组织一次 Run，但具体职责由内核的独立模块承担。应用只在构造时注入数据库、Skill 服务、模型工厂、工作区和扩展 Tool。

```mermaid
flowchart TB
  RunService["RunService"]

  subgraph Kernel["@zhujun/agentloop"]
    Runtime["runtime/\nAgent Loop · Context · Provider\nEvent Hub · Recovery · Terminal Commit"]
    Planning["planning/\nTask Profile · Admission\nScheduler · Assessor"]
    Tools["tools/\nTool Registry · Core Tools\nSource · Skill Loader · Web"]
    Skills["skills/\nDiscovery · Package Inspection\nSkillService · Identity"]
    Storage["storage/\nSqlConnection · Database\nRepositories · SkillStore"]
    Computer["computer/\nCommand / File Executor"]
    Acceptance["acceptance/\nArtifact Acceptance"]
    Batch["batch/\nBatchService"]
  end

  RunService --> Runtime
  Runtime --> Planning
  Runtime --> Tools
  Runtime --> Skills
  Runtime --> Storage
  Tools --> Computer
  Runtime --> Acceptance
  Batch --> RunService

  Model["应用注入的 ModelAdapter\nLlmProviderRegistry"] <-->|模型调用| Runtime
  UserTools["应用注入的业务 Tool"] --> Tools
  SkillRoots["内置 / 应用 / 外部 Skill 目录"] --> Skills
  Sql["SQLite 或注入的 SqlConnection"] --> Storage
```

## 4. 运行时数据流

```mermaid
sequenceDiagram
  participant UI as React Web
  participant API as HTTP Server
  participant Auth as AuthService
  participant Runs as RunService
  participant Skills as SkillService
  participant Model as LLM Provider
  participant Tools as Tool Registry
  participant Store as Database + Workspace

  UI->>API: 启动 Run（modelKey、conversationId、输入）
  API->>Auth: 认证并取得 app user.id
  API->>Runs: start(user.id, input, options)
  Runs->>Store: 创建 Run、Plan、事件记录
  Runs->>Skills: 解析可见 Skill，按需 load_skill 激活
  Runs->>Model: 规划或执行回合
  Model->>Runs: Tool Call / 完成候选
  Runs->>Tools: 授权、校验并执行 Tool
  Tools->>Store: 写入证据、产物、命令输出
  Runs->>Store: 评估、Terminal Commit、Outcome
  Runs-->>API: Run Event
  API-->>UI: SSE 实时投影
```

## 5. Skill 目录的优先级和落点

参考应用将两个来源合并为一个 `skillDirectories` 列表，并在启动时统一同步：

1. `@zhujun/agentloop-skills` 的发布目录：随 Skills 包发布的通用 Skill。
2. `CUSTOM_SKILL_DIRECTORIES_JSON`：应用或部署环境额外指定的 Skill 目录。

发现的目录包仍保留在其原始目录；用户显式安装的包才会写入由 `WORKSPACE_ROOT` 派生的 `.agentloop/skill-packages/`。跨目录同名 Skill 会失败，不按目录顺序静默覆盖。

## 6. 常用入口

| 目的 | 入口 |
|---|---|
| 内核公共 API | `packages/agentloop/src/index.ts` → `@zhujun/agentloop` |
| 内置 Skill 目录 | `packages/agentloop-skills/src/index.ts` → `bundledSkillDirectories()` |
| 参考应用装配 | `apps/agentloop-app/src/main.ts` |
| 应用路径配置 | `apps/agentloop-app/src/runtime-config.ts` |
| HTTP 与 SSE API | `apps/agentloop-app/src/http/server.ts` |
| Web 前端 | `apps/agentloop-app/web/src/` |
| 根构建、打包、启动命令 | `package.json` |

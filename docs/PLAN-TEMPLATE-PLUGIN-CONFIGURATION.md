# Plan Template 插件配置说明

日期：2026-09-02
适用范围：`agentloop-app` 参考应用 + `@zhujun/agentloop-plan-template` 可选规划插件

## 1. 配置结论

Plan Template 有两层开关：

```text
app planning extension binding
  决定是否动态 import 并绑定某个插件。

PlanTemplate plugin config
  决定插件被绑定后，是否持续记录 observe，以及是否启用 planner_context / direct_use。
```

默认情况下不启用 Plan Template。也就是说，直接 `npm run dev` 可以启动应用，但如果没有配置 `PLANNING_EXTENSIONS_CONFIG_PATH`，或者配置里插件 entry 仍是 `enabled=false`，系统不会加载 PlanTemplate，也不会创建 PlanTemplate 数据库。

## 2. 快速启用

在仓库根目录执行：

```bash
cp apps/agentloop-app/config/planning-extensions.example.json apps/agentloop-app/config/planning-extensions.json
cp apps/agentloop-app/config/plan-template.defaults.example.json apps/agentloop-app/config/plan-template.defaults.json
```

修改 `apps/agentloop-app/config/planning-extensions.json`：

```json
{
  "enabled": true,
  "planningExtensions": [
    {
      "enabled": true,
      "module": "@zhujun/agentloop-plan-template",
      "factory": "createPlanTemplatePlugin",
      "optionsPath": "./plan-template.defaults.json",
      "options": {
        "config": {
          "observeEnabled": true,
          "mode": "observe"
        }
      }
    }
  ]
}
```

在 `apps/agentloop-app/.env` 中增加：

```bash
PLANNING_EXTENSIONS_CONFIG_PATH=./config/planning-extensions.json
```

然后启动：

```bash
npm run dev
```

第一次体验建议使用 `mode="observe"`。该模式只记录任务画像和匹配观测，不改变 Planner 输入，也不会跳过 LLM Planner。

## 3. 配置文件职责

### 3.1 app 插件绑定配置

文件示例：`apps/agentloop-app/config/planning-extensions.json`

```json
{
  "enabled": true,
  "planningExtensions": [
    {
      "enabled": true,
      "module": "@zhujun/agentloop-plan-template",
      "factory": "createPlanTemplatePlugin",
      "optionsPath": "./plan-template.defaults.json",
      "options": {
        "config": {
          "observeEnabled": true,
          "mode": "planner_context"
        }
      }
    }
  ]
}
```

字段含义：

- `enabled`：全局插件绑定开关。为 `false` 时，所有 planning extension 都不加载。
- `planningExtensions[].enabled`：单个插件绑定开关。为 `false` 时，该插件不会被 import。
- `module`：插件发现位置，可以是 npm 包名、绝对路径、相对配置文件目录的路径或 `file:` URL。
- `factory`：插件 factory 导出名。PlanTemplate 当前使用 `createPlanTemplatePlugin`。
- `optionsPath`：插件自己的默认配置文件路径，相对 `planning-extensions.json` 所在目录解析。
- `options`：应用侧覆盖项。app 不理解字段语义，只做通用 JSON 合并后传给插件 factory。
- `observeEnabled`：独立观测开关。为 `true` 时，每次前置规划都会额外写入 `decision=observed`，不影响后续 `mode` 路由。
- `mode`：路由开关。`off` 不路由，`planner_context` 注入模板提示，`direct_use` 允许直接返回模板 PlanProposal。

- `observeEnabled`：独立观测开关。为 `true` 时，每次前置规划都会写入 `decision=observed`，不影响后续 mode 路由。
- `mode`：路由开关。`off` 不做路由，`planner_context` 只注入模板上下文，`direct_use` 允许直接返回模板 PlanProposal。

### 3.2 PlanTemplate 插件配置

文件示例：`apps/agentloop-app/config/plan-template.defaults.json`

```json
{
  "storage": {
    "type": "sqlite",
    "databasePath": "../data/agentloop-plan-template.db",
    "migrateOnStart": true
  },
  "config": {
    "enabled": true,
    "observeEnabled": true,
    "mode": "off",
    "allowDirectUse": false,
    "minDirectUseScore": 0.9,
    "minPlannerContextScore": 0.7,
    "allowedRiskCeiling": "low"
  },
  "mining": {
    "minCompletedRunsForCandidate": 3,
    "maxObservedMatchesPerRun": 500,
    "allowedRiskCeiling": "low",
    "excludedSideEffectKinds": ["send_email", "external_api", "browser_operation"]
  }
}
```

这个文件由 `@zhujun/agentloop-plan-template` 解释。app 只把它读出来，与 app 覆盖项合并后传入插件。

## 4. 应用覆盖插件配置

覆盖规则是 schema-agnostic JSON deep merge：

- object 与 object：递归合并。
- scalar、array、null：应用侧 `options` 直接替换 `optionsPath` 中的值。
- `optionsPath` 缺省时，只使用 `options`。
- `options` 缺省时，只使用 `optionsPath`。

示例：

`plan-template.defaults.json`：

```json
{
  "storage": {
    "type": "sqlite",
    "databasePath": "../data/agentloop-plan-template.db",
    "migrateOnStart": true
  },
  "config": {
    "enabled": true,
    "observeEnabled": true,
    "mode": "off",
    "allowDirectUse": false
  },
  "mining": {
    "minCompletedRunsForCandidate": 3
  }
}
```

`planning-extensions.json`：

```json
{
  "enabled": true,
  "planningExtensions": [
    {
      "enabled": true,
      "module": "@zhujun/agentloop-plan-template",
      "factory": "createPlanTemplatePlugin",
      "optionsPath": "./plan-template.defaults.json",
      "options": {
        "config": {
          "observeEnabled": true,
        "mode": "observe"
        }
      }
    }
  ]
}
```

最终传给 PlanTemplate factory 的 options 等价于：

```json
{
  "storage": {
    "type": "sqlite",
    "databasePath": "../data/agentloop-plan-template.db",
    "migrateOnStart": true
  },
  "config": {
    "enabled": true,
    "mode": "observe",
    "allowDirectUse": false
  }
}
```

## 5. SQLite 数据库位置

SQLite 配置：

```json
{
  "storage": {
    "type": "sqlite",
    "databasePath": "../data/agentloop-plan-template.db",
    "migrateOnStart": true
  }
}
```

相对路径由 PlanTemplate 插件按 app 传入的 `configDir` 解析。对于参考应用，`configDir` 通常是：

```text
/Users/zhujun/coding/agentloop/apps/agentloop-app/config
```

因此：

```text
../data/agentloop-plan-template.db
```

会落到：

```text
/Users/zhujun/coding/agentloop/apps/agentloop-app/data/agentloop-plan-template.db
```

也可以直接使用绝对路径：

```json
{
  "storage": {
    "type": "sqlite",
    "databasePath": "/var/lib/agentloop/agentloop-plan-template.db",
    "migrateOnStart": true
  }
}
```

## 6. PostgreSQL 配置

PostgreSQL 配置示例：

```json
{
  "storage": {
    "type": "postgres",
    "connectionString": "postgres://user:password@localhost:5432/agentloop_plan_template",
    "schemaName": "agentloop_plan_template",
    "poolSize": 5,
    "migrateOnStart": true
  },
  "config": {
    "enabled": true,
    "mode": "observe",
    "allowDirectUse": false
  }
}
```

生产环境不要把明文密码提交到仓库。可以由部署系统生成未纳入版本管理的 `plan-template.defaults.json`，或者用后续 secret resolver 注入 `connectionString`。

## 7. 模式选择

`config.mode` 支持：

- `off`：插件被绑定也不会做模板路由。
- `planner_context`：命中高质量模板时，只给 Planner 注入短上下文提示，不跳过 Planner。
- `direct_use`：允许模板生成 `PlanProposal`，但仍必须经过 `PlanAdmission`。

`observeEnabled` 单独控制是否持续写观测样本。它可以和 `planner_context` / `direct_use` 同时开启。

`direct_use` 还需要：

- `config.enabled=true`
- `config.observeEnabled=true`
- `config.allowDirectUse=true`
- 候选模板为 active
- 匹配分数达到 `minDirectUseScore`
- 风险不超过 `allowedRiskCeiling`

## 8. 启动时的真实行为

启动链路：

```text
apps/agentloop-app/.env
  -> PLANNING_EXTENSIONS_CONFIG_PATH
  -> loadPlanningExtensions()
  -> dynamic import(module)
  -> call factory(options, context)
  -> RunService({ planningExtensions })
```

关键边界：

- `agentloop-app` 不静态 import `@zhujun/agentloop-plan-template`。
- `agentloop-app` 不解析 PlanTemplate 的 `storage` / `config` 字段语义。
- `@zhujun/agentloop` 内核只接收 `PlanningExtension[]`。
- PlanTemplate 数据库连接、migration、表结构和生命周期由 `@zhujun/agentloop-plan-template` 自己管理。

## 9. 离线 Miner 与手动管理

第一阶段不做前端管理界面。PlanTemplate 包提供 CLI 和 package API，用于离线挖掘和人工批准。

运行 Miner：

```bash
npm run mine --workspace @zhujun/agentloop-plan-template -- --config apps/agentloop-app/config/plan-template.defaults.json
```

查看候选模板：

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- list --config apps/agentloop-app/config/plan-template.defaults.json --status candidate
```

批准 candidate 为 active：

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- approve --config apps/agentloop-app/config/plan-template.defaults.json --id template_xxx
```

退役模板：

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- retire --config apps/agentloop-app/config/plan-template.defaults.json --id template_xxx
```

Miner 第一版只会把满足阈值的 observed 样本生成或更新为 `candidate`，不会自动进入 `active`。进入 `active` 必须人工调用 approve。

可挖掘正例必须同时满足：

- observed match 已记录 `PlanProposal` 快照。
- `admissionResult.admitted=true`。
- `outcomeStatus=completed`。
- canonical outcome reason 为 `plan_assessed_and_completed`。
- 风险不超过 mining 配置的 `allowedRiskCeiling`。
- side effect 不在 mining 配置的排除列表中。
- 相同 task fingerprint + plan shape 聚类数量达到 `minCompletedRunsForCandidate`。

历史 observed 记录如果没有 `PlanProposal` 快照，会被 Miner 跳过。新版本会在 `afterPlanAdmission` 写入 proposal 快照，在 `afterOutcome` 写入 outcome reason。

## 10. 常见问题

### 10.1 执行 `npm run dev` 后没有创建 PlanTemplate 数据库

检查：

- `apps/agentloop-app/.env` 是否设置了 `PLANNING_EXTENSIONS_CONFIG_PATH`。
- `planning-extensions.json` 顶层 `enabled` 是否为 `true`。
- PlanTemplate entry 的 `enabled` 是否为 `true`。
- PlanTemplate `config.enabled` 是否为 `true`。
- PlanTemplate `config.mode` 是否不是 `off`。

`off` 模式下不创建数据库是预期行为。

### 10.2 报 `module not found`

检查 `planningExtensions[].module`：

- workspace 开发时可以用 `"@zhujun/agentloop-plan-template"`。
- 本地文件插件可以用 `"./my-plugin.mjs"`，相对 `planning-extensions.json` 所在目录解析。
- 生产部署需要确保该 npm 包或文件存在于应用可 import 的位置。

### 10.3 怎么只观察不影响规划

使用：

```json
{
  "config": {
    "enabled": true,
    "mode": "observe",
    "allowDirectUse": false
  }
}
```

该模式不会向 Planner 注入 template hint，也不会跳过 Planner。

### 10.4 怎么切到给 Planner 提示

使用：

```json
{
  "config": {
    "enabled": true,
    "observeEnabled": true,
    "mode": "planner_context",
    "allowDirectUse": false
  }
}
```

该模式仍会调用 LLM Planner，只是在匹配到合适模板时附加短 template hint。

### 10.5 怎么切到直接用模板 Plan

使用：

```json
{
  "config": {
    "enabled": true,
    "observeEnabled": true,
    "mode": "direct_use",
    "allowDirectUse": true
  }
}
```

直接使用模板仍不会绕过内核：模板产物必须先通过 `PlanAdmission`，之后才进入 Runtime / Assessment / TerminalCommitter。

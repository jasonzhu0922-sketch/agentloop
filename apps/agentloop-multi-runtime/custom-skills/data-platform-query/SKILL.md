---
name: data-platform-query
description: >
  只读查询宝武数据中台的 API、数据模型、数据表、数据标准和数据质量元数据。适用于检索定义、字段、参数、关联关系或已登记血缘；不用于写入、发布、变更或业务数据明细查询。
---

# 数据中台查询

本 Skill 是宝武数据中台元数据的统一只读查询入口。它内部包含 API、模型、表、标准和质量五个查询模块；模块是本包的实现细节，不是可单独发现或授权的 Runtime Skill。

## 路由

- API 用途、入参、出参、关联表或相似 API：使用 `api-*` 动作。
- 维度、事实或 ER 模型，以及其关联表和字段：使用 `model-*` 动作。
- 数据表字段、主键、所属模型或上下游血缘：使用 `table-*` 动作。
- 数据分类、业务对象、数据元及字段落标：使用 `standard-*` 动作。
- 质量规则、质量步骤或已挂载规则的质量任务：使用 `quality-*` 动作。

创建、修改、删除、发布、启停或审批任何数据中台对象不属于本 Skill。表业务数据明细查询也不属于本 Skill。

## 配置边界

聚合入口和五个查询模块只读取本 Skill 根目录的 `.env`。部署时将 `.env.example` 复制为同目录 `.env`，填写 `DAM_TEST_SQL_ENDPOINT`、`DAM_TEST_CLIENT_ID` 和 `DAM_TEST_CLIENT_SECRET`；示例值面向测试 SQL API，生产需填写实际值。缺少文件或必填项时明确报错。

不读取 Runtime/Local Agent 的 `.env`、全局环境变量或外部配置路径，不再使用代码内默认端点和默认凭据。真实 `.env` 不进入 Git 或分发 ZIP，不要读取或回显其中的凭据到模型上下文、日志或交付物。每次部署或安装 Skill 后，在实际执行的 Skill 根目录维护此文件。

## 结果边界

结果只陈述接口实时返回的已登记元数据及其明确限制。空结果、同名多候选、未解析血缘或接口失败必须如实返回；不得按名称补猜对象、字段、映射、发布状态或数据权限。

## 执行请求

运行 `query` 动作前，在受授权工作区写入一个 `agentloop.dataPlatformQuery/v1` JSON 请求文件，并将该文件作为动作的 `request` 输入。文件只包含非敏感查询条件：

```json
{"schema":"agentloop.dataPlatformQuery/v1","family":"table","operation":"detail","identifier":"T_DWD_FACT_ORDER"}
```

可用 `family` 为 `api`、`model`、`table`、`standard`、`quality`。`operation` 和字段约束如下：

- `api`: `search` / `detail` / `similar`；分别使用 `query` 或 `identifier`。
- `model`、`table`: `search` / `detail`；分别使用 `query` 或 `identifier`。
- `standard`: `search` / `detail`；必须提供 `kind`（`classification`、`business-object` 或 `data-element`），另加 `query` 或 `identifier`。
- `quality`: `rules`、`rule-detail`、`tasks`、`task-detail`；搜索使用 `query`，详情使用 `identifier`。

## 模块资料

- API 查询的口径与 SQL 解析规则在 `modules/api/references/`。
- 各模块的边界和原有路由样例在相应 `modules/*/reference.md` 与 `modules/*/tests/` 中。

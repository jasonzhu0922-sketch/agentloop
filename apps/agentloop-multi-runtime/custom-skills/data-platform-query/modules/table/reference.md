---
name: table-query
description: >
  查询宝武数据中台的数据表元数据，返回表详情、字段定义与已登记的上下游表血缘。
---

# 数据表查询

## Scope

用于查询已有数据表的名称、描述、状态、所属模型、字段和表级血缘；表与字段作为同一个查询对象返回。

- 只读：是，仅允许 `SELECT` 或 `WITH` 查询。
- 不用于：创建、修改、删除表或字段，执行表业务数据查询，申请表权限。
- 用户确认：不需要。

## Inputs

```text
required:
  - keyword                 # search：表英文名、中文名、描述或 UUID
    or table_identifier     # detail：表 UUID、精确英文名或精确中文名
```

## Workflow

在 Skill 目录中运行稳定脚本：

```bash
python3 scripts/table_query.py search "采购订单"
python3 scripts/table_query.py detail "T_DWD_FACT_ORDER"
```

`detail` 固定返回表基本信息、字段清单及血缘。血缘通过 `T_ODS_TBEDG91` 同时匹配表的 `UUID` 和 `GUID`，再解析为表资产；不能解析为表的节点会保留在 `unresolved`，不补猜。

## Tool Contract

- Allowed tools: `run_skill_script`（`scripts/table_query.py`）
- Data access: 直接 POST 到用户指定的测试 SQL API；不使用 Connector。
- Forbidden: 非只读 SQL、输出接口凭证、用临时脚本替换主流程。

## Data And Compliance

- 数据来源：宝武数据中台测试 SQL API，ODS 元数据表。
- 权限边界：只读取本 Skill 根目录 `.env` 中的 `DAM_TEST_SQL_ENDPOINT`、`DAM_TEST_CLIENT_ID` 和 `DAM_TEST_CLIENT_SECRET`；缺项时报错，不读取全局环境变量或回显凭据。
- 数据分级：内部。默认输出元数据，不读取业务数据行。
- 输出限制：结果以接口实时返回为准，不代替数据权限审批、数据发布或变更依据。

## Error Handling

- 接口不可达、SQL 执行失败：返回结构化错误并停止。
- 空结果：明确返回空列表或“未找到”，不生成示例。
- 多个同名候选：`search` 返回候选，要求调用方以 UUID 或精确英文名继续 `detail`。
- 不循环重试确定性失败。

## Output Format

`detail` JSON 包含 `table`、`fields`、`lineage.upstream`、`lineage.downstream`、`lineage.unresolved`。结果说明数据来源、查询时间和“表级血缘”的口径；不将未解析节点误报为数据表。

## Tests And Acceptance

- 路由正例、反例、边界和冲突样例：`tests/test_route_cases.json`。
- 脚本 smoke：`tests/test_script_smoke.py`，mock HTTP 响应，不访问真实接口。

## Change Log

- `1.0.0`：首次试运行版本；直接查询测试 SQL API，返回表、字段与血缘。

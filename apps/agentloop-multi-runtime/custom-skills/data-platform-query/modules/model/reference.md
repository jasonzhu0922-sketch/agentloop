---
name: model-query
description: >
  查询宝武数据中台的维度模型、事实模型和 ER 模型，返回关联数据表、字段与表级血缘。
---

# 数据模型查询

## Scope

仅检索维度、事实和 ER 三类现有模型。模型详情通过表元数据的 `MODEL_UUID` 关联数据表，并为每张关联表带出字段和表级血缘；同时返回已核验的维度-事实关系或 ER 类目关系。

- 只读：是。
- 不用于：模型设计、修改、发布，其他模型类型查询，业务数据查询。
- 用户确认：不需要。

## Inputs

```text
required:
  - keyword                # search：模型中英文名、描述或 UUID
    or model_identifier    # detail：模型 UUID、精确英文名或精确中文名
```

## Workflow

```bash
python3 scripts/model_query.py search "采购"
python3 scripts/model_query.py detail "DY_MO_FM_00_xxx"
```

主表范围固定为：维度 `T_ODS_TBEDF5203`、事实 `T_ODS_TBEDF5204`、ER `T_ODS_TBEDF5209`。不把这三张表之外的模型混入结果。

## Tool Contract

- Allowed tools: `run_skill_script`（`scripts/model_query.py`）
- Data access: 用户指定的测试 SQL API，直连 HTTP，不使用 Connector。
- Forbidden: 非只读 SQL、创建/修改模型、补猜模型关系。

## Data And Compliance

- 数据来源：宝武数据中台测试 SQL API，ODS 元数据表。
- 权限边界：只读取本 Skill 根目录 `.env` 中的 `DAM_TEST_SQL_ENDPOINT`、`DAM_TEST_CLIENT_ID` 和 `DAM_TEST_CLIENT_SECRET`；缺项时报错，不读取全局环境变量或回显凭据。
- 数据分级：内部；输出仅为模型和表元数据。
- 输出限制：表血缘是 `T_ODS_TBEDG91` 的已登记关系，不替代模型设计审查。

## Error Handling

接口失败或无权限即停止并报告；空结果如实返回。若模型存在但关联表为空，报告“未登记关联表”，不根据名称推断。

## Output Format

`detail` JSON 包含 `model`、逐表的 `table` / `fields` / `lineage`、`relations`，以及模型表关联口径说明。

## Tests And Acceptance

- 路由验收：`tests/test_route_cases.json`。
- HTTP mock smoke：`tests/test_script_smoke.py`。

## Change Log

- `1.0.0`：首次试运行版本；覆盖维度、事实和 ER 模型。

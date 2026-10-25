---
name: quality-query
description: >
  查询宝武数据中台的质量规则和已挂载质量规则的质量任务，返回规则、步骤与任务关系。
---

# 数据质量查询

## Scope

用于只读查询质量规则和质量任务。质量任务必须经过已核验关联链挂载至少一条质量规则，避免将普通开发任务混入结果。

- 只读：是。
- 不用于：创建、修改、启停、删除规则或任务，执行质量检查，提交上线申请。
- 用户确认：不需要。

## Inputs

```text
required:
  - keyword or UUID
optional:
  - mode: rules | rule-detail | tasks | task-detail
```

## Workflow

```bash
python3 scripts/quality_query.py rules "空值"
python3 scripts/quality_query.py rule-detail "DS_TK_DQ_00_xxx"
python3 scripts/quality_query.py tasks "质量监控"
python3 scripts/quality_query.py task-detail "DS_JB_MC_00_xxx"
```

规则表为 `T_ODS_TBEDD0506`。质量任务口径固定为 `质量规则 -> 质量步骤(T_ODS_TBEDD01) -> 任务步骤关系(T_ODS_TBEDD0104) -> 任务(T_ODS_TBEDD0101)`。

## Tool Contract

- Allowed tools: `run_skill_script`（`scripts/quality_query.py`）
- Data access: 用户指定的测试 SQL API，直连 HTTP，不使用 Connector。
- Forbidden: 非只读 SQL、质量规则/任务维护、把接口查询成功表述为任务已上线。

## Data And Compliance

- 数据来源：宝武数据中台测试 SQL API，ODS 元数据表。
- 权限边界：只读取本 Skill 根目录 `.env` 中的 `DAM_TEST_SQL_ENDPOINT`、`DAM_TEST_CLIENT_ID` 和 `DAM_TEST_CLIENT_SECRET`；缺项时报错，不读取全局环境变量或回显凭据。
- 数据分级：内部；规则内容可能含表名、字段和条件，按最小范围展示。
- 输出限制：现有 ODS 任务表未核验独立的发布状态字段；不得推断任务上线或审批状态。

## Error Handling

接口失败、空结果和未找到对象都如实报告。任务名匹配到多个任务时保留 UUID，要求后续精确查询；不采用通用开发任务替代质量任务。

## Output Format

规则详情固定返回规则对象及关联质量任务；任务详情固定返回任务对象和关联质量规则，保留步骤 UUID 以说明关联来源。

## Tests And Acceptance

- 路由验收：`tests/test_route_cases.json`。
- HTTP mock smoke：`tests/test_script_smoke.py`。

## Change Log

- `1.0.0`：首次试运行版本；覆盖质量规则与已挂载规则的质量任务。

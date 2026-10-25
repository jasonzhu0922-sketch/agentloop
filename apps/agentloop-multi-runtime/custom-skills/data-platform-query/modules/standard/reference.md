---
name: standard-query
description: >
  融合查询数据分类、业务对象和数据元，返回三类标准对象及其已登记的关联关系。
---

# 数据标准查询

## Scope

用于只读查询数据分类、业务对象、数据元及它们的关联。数据元详情还查询已登记的表字段落标关系。

- 只读：是。
- 不用于：创建、发布或修改标准；查询业务术语、业务指标；根据名称猜测字段落标。
- 用户确认：不需要。

## Inputs

```text
required:
  - kind: classification | business-object | data-element
  - keyword or UUID
```

## Workflow

```bash
python3 scripts/standard_query.py search classification "采购"
python3 scripts/standard_query.py search business-object "合同"
python3 scripts/standard_query.py detail data-element "DY_FD_00_xxx"
```

数据分类来自 `T_ODS_TBEDF32`，业务对象来自 `T_ODS_TBEDF15`，数据元来自 `T_ODS_TBEDF12`。详情把三类对象按 `AREA_UUID` 和 `OBJECT_UUID` 融合；字段落标只接受 `T_ODS_TBEDG2102.DATA_ELEMENT = 数据元 UUID` 的精确登记。

## Tool Contract

- Allowed tools: `run_skill_script`（`scripts/standard_query.py`）
- Data access: 用户指定的测试 SQL API，直连 HTTP，不使用 Connector。
- Forbidden: 非只读 SQL、标准写入、将名称相似当作字段映射事实。

## Data And Compliance

- 数据来源：宝武数据中台测试 SQL API，ODS 元数据表。
- 权限边界：只读取本 Skill 根目录 `.env` 中的 `DAM_TEST_SQL_ENDPOINT`、`DAM_TEST_CLIENT_ID` 和 `DAM_TEST_CLIENT_SECRET`；缺项时报错，不读取全局环境变量或回显凭据。
- 数据分级：内部；输出是治理元数据。
- 输出限制：空的字段映射仅代表未发现该精确登记关系，不能据此判断标准是否无效。

## Error Handling

接口失败、参数类型错误或对象未找到时停止并报告。结果为空时返回空，不生成建议、匹配或样例数据。

## Output Format

`detail` 返回目标对象及其分类、业务对象、数据元或字段映射；每个关联均附带原始 UUID，方便后续精确追查。

## Tests And Acceptance

- 路由验收：`tests/test_route_cases.json`。
- HTTP mock smoke：`tests/test_script_smoke.py`。

## Change Log

- `1.0.0`：首次试运行版本；融合数据分类、业务对象和数据元查询。

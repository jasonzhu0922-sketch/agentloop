# 数据语义结构提供说明（供数据平台对接）

## 1. 对接目标

我方指定一个数据库连接及该连接下的两张表，请数据平台提供这两张表对应的结构化数据语义，供我方 NL2SQL 技能理解业务含义、生成查询 SQL。

**数据平台只需提供语义定义；问题理解、SQL 生成、执行及结果分析由我方负责。** 首期可通过一个接口一次性返回，不需要另外建设查询规划或 SQL 校验接口。

## 2. 建议接口

`POST /api/metadata/semantics`

接口地址可按数据平台现有规范调整，也可通过现有元数据接口组合提供；以下重点约定输入及返回的数据结构。

请求示例：

```json
{
  "connection_id": "conn_demo",
  "table_names": ["demo.sales_detail", "demo.organization"]
}
```

| 参数 | 说明 |
| --- | --- |
| `connection_id` | 数据平台中的数据库连接标识，不传连接密码 |
| `table_names` | 该连接下的两张表，使用包含数据库或 schema 的限定名称，避免同名歧义 |

## 3. 需要提供的语义结构

| 结构 | 主要内容 | 用途 |
| --- | --- | --- |
| 来源信息 `source` | 连接标识、数据库类型、语义版本或更新时间 | 确认语义属于哪个数据库，识别定义变化 |
| 表说明 `tables` | 物理表名、中文名称、业务说明、数据粒度、主键 | 明确一行数据代表什么，例如一条销售明细、一家公司 |
| 字段说明 `tables[].columns` | 物理字段名、中文名称、数据类型、业务含义、字段角色；适用时提供单位、倍率、枚举值 | 区分编码、名称、期间、维度和数值，避免猜字段含义 |
| 指标定义 `metrics` | 指标名称、业务定义、来源字段、计算公式、必要筛选条件、单位、允许汇总的维度 | 明确“怎么算”，避免金额混加、人数重复计数或比率直接平均 |
| 业务术语 `terms` | 规范名称、业务定义、别名、对应指标或字段 | 将用户的业务表达映射到正确的数据含义 |
| 表间关系 `relationships` | 两端表、关联字段、关系基数、关联方式及附加条件 | 判断两表能否关联，避免一对多造成重复汇总 |
| 时间口径 `time_fields` | 所属表、时间字段、存储格式、粒度、发生额/快照/累计值；适用时提供时区和财务日历 | 正确转换查询期间，避免把月末快照或累计值跨期相加 |
| 实体定义 `entities` | 组织、客户、产品等对象的编码字段、名称字段；已有别名或字典时提供映射或引用 | 帮助识别业务对象，后续按真实编码查询 |

补充说明：

- **数据粒度必须明确。** “销售表”不够，应说明是订单、订单明细，还是组织月度汇总。
- **指标必须有实际口径。** 不只提供“销售额”名称，还应说明对应字段、SUM/COUNT/COUNT DISTINCT 等公式、含税与否、实际/计划及必要状态条件。若指标存储在报表长表中，还需提供项目字段和精确项目值。
- **表间关系必须有依据。** 不仅说明“可以关联”，还需提供具体键及一对一、一对多或多对一关系；历史维表需补充有效期条件。
- **字典与样例要区分。** 已有枚举、组织编码等字典可直接提供或引用现有字典接口；样例值需标注为样例，不当作完整值域。无需返回全部业务明细。
- **特殊计算规则随指标提供。** 比率补充分子、分母及汇总方式；去重计数补充去重键；快照、累计值补充时间汇总规则；有空值或零除规则时明确说明。

## 4. 返回结构示例

以下为虚构数据，仅演示结构。字段名可与平台现有规范对齐，需保留相同的信息含义。

```json
{
  "source": {
    "connection_id": "conn_demo",
    "database_type": "mysql",
    "semantic_version": "v1",
    "updated_at": "2026-11-16T10:00:00+08:00"
  },
  "tables": [
    {
      "table_name": "demo.sales_detail",
      "display_name": "销售明细表",
      "description": "记录每笔销售订单的明细行，金额均为人民币",
      "grain": "一行代表一笔销售订单中的一个明细行",
      "primary_key": ["order_id", "line_no"],
      "columns": [
        {"name": "order_id", "display_name": "订单编号", "data_type": "varchar(32)", "description": "销售订单的唯一编号，同一订单可包含多条明细", "role": "identifier"},
        {"name": "line_no", "display_name": "明细行号", "data_type": "int", "description": "订单内的明细序号", "role": "identifier"},
        {"name": "org_code", "display_name": "组织编码", "data_type": "varchar(32)", "description": "销售业务归属组织的编码", "role": "dimension"},
        {"name": "sale_date", "display_name": "销售日期", "data_type": "date", "description": "销售业务发生日期", "role": "time"},
        {"name": "net_amount", "display_name": "净销售金额", "data_type": "decimal(18,2)", "description": "不含税且已扣除折让的明细金额", "role": "measure", "unit": "元", "scale": 1},
        {"name": "status", "display_name": "订单状态", "data_type": "varchar(16)", "description": "订单当前业务状态", "role": "dimension", "values": [{"value": "COMPLETED", "meaning": "已完成"}, {"value": "CANCELLED", "meaning": "已取消"}]}
      ]
    },
    {
      "table_name": "demo.organization",
      "display_name": "组织信息表",
      "description": "维护组织编码和名称，不包含历史版本记录",
      "grain": "一行代表一个组织",
      "primary_key": ["org_code"],
      "columns": [
        {"name": "org_code", "display_name": "组织编码", "data_type": "varchar(32)", "description": "组织唯一编码", "role": "identifier"},
        {"name": "org_name", "display_name": "组织名称", "data_type": "varchar(200)", "description": "组织规范全称", "role": "dimension"}
      ]
    }
  ],
  "metrics": [
    {
      "metric_id": "net_sales",
      "name": "净销售额",
      "definition": "已完成订单的不含税净销售金额，已扣除折让，按销售日期统计",
      "source_table": "demo.sales_detail",
      "source_fields": ["net_amount", "status", "sale_date", "org_code"],
      "formula": "SUM(net_amount)",
      "filters": [{"field": "status", "operator": "=", "value": "COMPLETED"}],
      "unit": "元",
      "currency": "CNY",
      "scale": 1,
      "aggregation": "sum",
      "additive_dimensions": ["org_code", "sale_date"],
      "time_aggregation": "sum",
      "null_rule": "忽略空金额；全部为空时返回NULL，不自动补零"
    }
  ],
  "terms": [
    {
      "name": "净销售额",
      "definition": "已完成订单的不含税净销售金额，已扣除折让",
      "aliases": ["不含税净销售额"],
      "related_metric_ids": ["net_sales"],
      "related_fields": ["demo.sales_detail.net_amount"]
    }
  ],
  "relationships": [
    {
      "left_table": "demo.sales_detail",
      "right_table": "demo.organization",
      "join_keys": [{"left_field": "org_code", "right_field": "org_code"}],
      "cardinality": "many_to_one",
      "join_type": "left",
      "additional_conditions": [],
      "description": "销售明细关联所属组织；组织编码在组织表中唯一，未匹配组织的销售明细仍保留"
    }
  ],
  "time_fields": [
    {
      "table_name": "demo.sales_detail",
      "field": "sale_date",
      "format": "YYYY-MM-DD",
      "granularity": "day",
      "calendar": "gregorian",
      "time_semantics": "event",
      "description": "按业务发生日期统计；月度查询取该自然月的日期范围"
    }
  ],
  "entities": [
    {
      "name": "组织",
      "table_name": "demo.organization",
      "key_field": "org_code",
      "name_field": "org_name",
      "description": "通过组织编码与销售明细关联；组织名称不作为唯一标识"
    }
  ],
  "missing_definitions": []
}
```

结构约定：`role` 可使用 `identifier`（标识）、`dimension`（维度）、`measure`（数值）、`time`（时间）；`cardinality` 使用 `one_to_one`、`one_to_many`、`many_to_one`、`many_to_many`；`time_semantics` 使用 `event`（发生额）、`snapshot`（时点快照）、`cumulative`（累计值）。有多种角色时可按平台规范使用数组。

`formula` 中的字段默认属于 `source_table`；跨表指标应列明全部来源及依赖关系。`scale` 表示“实际基础单位数值 = 存储数值 × scale”，例如金额按万元存储时，基础单位为元、scale 为 10000。

## 5. 提供要求

1. 表名、字段名、编码和计算公式应对应指定连接中的真实数据；业务语义由平台已有目录或业务确认提供，不能凭名称补写为已确认定义。
2. 表和字段基础信息应完整提供；指标、术语、关系、时间及实体定义按已维护情况提供，缺失项明确列入 `missing_definitions`，例如 `{"scope":"demo.sales_detail", "type":"metric", "description":"尚未维护指标口径"}`。不适用与尚未维护应在说明中区分。
3. 返回范围以用户指定的两张表及其相关业务定义为准。若指标依赖其他表，只列明依赖，不自动扩大查询范围。
4. 首期以结构清晰、口径准确、能够返回 JSON 为目标；也可先按相同结构提供 JSON 文件确认，再对接接口。鉴权沿用平台现有机制。

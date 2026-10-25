# 钢材数据库表结构与数据语义

本文件是 `mysql-steel-data` 对钢材库的字段级语义说明，也是上层 `steel-market-analysis` 读取数据库事实时应引用的唯一静态说明。它定义**可查询的映射字段与两表关系**，不代表数据库中所有物理列均可向模型暴露或可用于 SQL。

`schema-map.json` 是部署侧确认的标识符映射；每次 `preflight-catalog` 返回的 `dataContract` 是当前部署的最终事实。若此文档、映射和预检结果不一致，以预检结果为准，停止猜测并由数据库所有者修正映射。

## 表与关联

| 表 | 业务粒度 | 本 Skill 的用途 |
| --- | --- | --- |
| `MB_INDEX_MAIN_INFO` | 一行是一个已定义的市场指标 | 目录预检、语义字段定位、指标身份确认 |
| `MB_INDEX_MAIN_DATA` | 一行是一个指标在一个观测日期的原始数值记录 | 在精确指标和日期范围已确定后读取原始观测 |

唯一允许的跨表关联是：

```text
MB_INDEX_MAIN_INFO.INDEX_CODE = MB_INDEX_MAIN_DATA.INDEX_CODE
```

这是“一个指标定义对应多期观测”的一对多关系。两表各自的 `MS_ID` 不是跨表关联键；不得以相近名称、城市、品种或任何展示文本代替 `INDEX_CODE` 连接或混合数据。

## 指标目录表：`MB_INDEX_MAIN_INFO`

| 逻辑字段 | 物理列 | 语义与 SQL 使用规则 |
| --- | --- | --- |
| `indicator_id` | `INDEX_CODE` | 一个已定义指标的稳定业务标识。只有确认这个值后，才可读取数值表。 |
| `indicator_name` | `INDEX_NAME` | 目录实际保存的展示名称。可作为受控包含匹配条件；模型不得拼造新名称。 |
| `province_name` | `PROVINCE_NAME` | 省份行政区划；不可替代城市、大区或市场。 |
| `city_name` | `CITY_NAME` | 城市行政区划；不可用 `REGION_NAME` 代替。 |
| `county_name` | `COUNTY_NAME` | 区县；仅在映射且目录有值时作为条件。 |
| `region_name` | `REGION_NAME` | 大区，例如华北；不是城市或省份。 |
| `breed_name` | `BREED_NAME` | 品种/品名，例如热轧盘螺；不是牌号或报价条件。 |
| `caliber_name` | `CALIBER_NAME` | 规格/牌号；字段为空时不得将整段名称强塞入该字段。 |
| `metric_name` | `METRIC_NAME` | 指标口径，例如工程采购价；独立于产品与名称。 |
| `frequency_name` | `FREQUENCY_NAME` | 日度、周度、月度等观测频率；不同频率不能混算。 |
| `unit_name` | `UNIT_NAME` | 计量单位；不同单位不能直接比较或加总。 |
| `producer_name` | `CP_NAME` | 生产企业全称；不是数据来源。 |
| `producer_short_name` | `CP_SHORT_NAME` | 生产企业简称；仅与生产企业语义匹配。 |
| `source_name` | `SOURCE_NAME` | 数据来源；不是钢厂、品牌或市场。 |
| `market_name` | `MARKET_NAME` | 交易/报价市场；不能与城市或来源互换。 |
| `description` | `DESCRIPTION` | 含税、送到价、过磅等报价条件说明；不是规格牌号。 |

候选定位只能使用 `schema-map.json` 实际启用的逻辑字段。条件间采用 AND；零候选、多候选或截断候选都不构成指标选择。`preflight-catalog` 中的高频样例是受限样本，不是完整值域，也不能证明某值不存在。

## 指标观测表：`MB_INDEX_MAIN_DATA`

| 逻辑字段 | 物理列 | 语义与 SQL 使用规则 |
| --- | --- | --- |
| `indicator_id` | `INDEX_CODE` | 外部关联到目录表的 `INDEX_CODE`；查询必须被一个精确指标 ID 约束。 |
| `observation_date` | `DATA_DATE` | 观测日期。单日读取仅接受一个 `date`；多日读取仅接受起止不同的 `start-date`/`end-date`。上层计算前仅把可解析的 ISO 日期视为时间序列日期。 |
| `value` | `DATA_VALUE` | 原始观测数值。它本身不天然表示价格、增量或库存，业务含义由同一 `INDEX_CODE` 的目录口径、单位和频率决定。 |

一个最小原始事实单位是：

```text
一个 INDEX_CODE 的指标定义 + 一个 DATA_DATE 的原始 DATA_VALUE
```

同日多条记录不天然等于重复。单日链路如实返回该日所有原始行和行数；多日链路如实返回全部日期的原始行。上层可基于实际返回的数据形态做日期集合、区间或其他分析，但不能在缺少区分字段时断言底表行完全重复或擅自选择代表价。

## SQL 编译边界

下层只使用上述映射生成参数化 SQL：

- 目录查询：受控语义字段 → `MB_INDEX_MAIN_INFO` 候选。
- 明细查询：目录签发的选择证明绑定精确 `INDEX_CODE`，再按单日或多日日期条件 → 两表按 `INDEX_CODE` 关联的原始行。
- 轻量目录聚合：固定的总行数、非空数、去重数与高频值，用于确认选择器质量。

不接受原始 SQL、表名、列名或自定义表达式；不做价格深度聚合、跨指标汇总、趋势计算或市场解释。这些分析职责属于上层。

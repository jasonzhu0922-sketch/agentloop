# 受控 NL2SQL 正反向案例

这份参考用于 `mysql-steel-data` 在**下层**把受控选择器编译成简单、只读的 MySQL SQL。上层 `steel-market-analysis` 只说明采用什么方法、需要哪些证据、使用哪一个 `INDEX_CODE` 或已映射语义字段；它不生成 SQL、不传表名/列名，也不做数据库口径推断。

案例使用当前映射的名称展示：

```text
MB_INDEX_MAIN_INFO.INDEX_CODE = MB_INDEX_MAIN_DATA.INDEX_CODE
```

实际标识符只能从 `schema-map.json` 读取。值一律使用驱动参数 `%s` 绑定；文中的 SQL 是下层编译器的固定模板说明，绝不是模型可提交、可拼接或可执行的原始 SQL。

## 边界

- 下层负责：把 `indicatorId`、已映射 `filters` 和日期范围编译为简单明细行查询；为目录预检编译固定的 `COUNT`、去重数和高频值等轻量聚合。
- 上层负责：选择分析方法、决定最小取数计划、在取得原始回执后进行计算、跨指标归并与报告。
- 不做：任意 `SELECT`、自定义表/列/表达式、写入、DDL、跨库查询、价格深度聚合、跨指标汇总、趋势或业务结论。
- 本参考**不接收原始 SQL**。读取只能走目录到数据的受控链路：单日使用 `locate-day`/`query-day-by-selection`，多日使用 `locate-series`/`query-series-by-selection`；`execute-query-plan` 的裸 `indicatorId` 必须携带目录签发的 `selectionToken`。

## 正向：语义选择器到数据

### 1. 已映射的语义字段 → 指标目录候选

上层先给出已经过预检确认的字段，而不是一句自然语言或猜测的列名：

```json
{
  "city_name": "唐山市",
  "breed_name": "热轧盘螺",
  "metric_name": "工程采购价",
  "producer_short_name": "河钢",
  "indicator_name": "HRB400E"
}
```

下层根据 `schema-map.json` 编译为候选定位 SQL。所有条件是独立语义槽位的 AND；`HRB400E` 若只出现在展示名称中，就只绑定到 `INDEX_NAME`：

```sql
SELECT DISTINCT i.`INDEX_CODE` AS indicator_id,
       i.`INDEX_NAME` AS indicator_name,
       i.`CITY_NAME` AS city_name,
       i.`BREED_NAME` AS breed_name,
       i.`METRIC_NAME` AS metric_name,
       i.`CP_SHORT_NAME` AS producer_short_name
FROM `MB_INDEX_MAIN_INFO` i
WHERE i.`CITY_NAME` LIKE CONCAT('%', %s, '%')
  AND i.`BREED_NAME` LIKE CONCAT('%', %s, '%')
  AND i.`METRIC_NAME` LIKE CONCAT('%', %s, '%')
  AND i.`CP_SHORT_NAME` LIKE CONCAT('%', %s, '%')
  AND i.`INDEX_NAME` LIKE CONCAT('%', %s, '%')
ORDER BY i.`INDEX_NAME` ASC
LIMIT 50;
```

参数顺序为：`("唐山市", "热轧盘螺", "工程采购价", "河钢", "HRB400E")`。结果只能是候选；候选不唯一时，下层不选一个代替上层或用户。

### 2. 目录选择证明 + 多日日期范围 → 原始行数据

当目录已确认唯一指标，它返回 `indicatorId` 与不透明 `selectionToken`。`query-series-by-selection` 或计划中的 `selector.indicatorId` + `selector.selectionToken` 才能让下层生成固定关联和明细行返回。模型不得自造或替换 `INDEX_CODE`。

```sql
SELECT i.`INDEX_CODE` AS indicator_id,
       i.`INDEX_NAME` AS indicator_name,
       v.`DATA_DATE` AS observation_date,
       v.`DATA_VALUE` AS value
FROM `MB_INDEX_MAIN_INFO` i
INNER JOIN `MB_INDEX_MAIN_DATA` v
  ON v.`INDEX_CODE` = i.`INDEX_CODE`
WHERE i.`INDEX_CODE` = %s
  AND v.`DATA_DATE` >= %s
  AND v.`DATA_DATE` <= %s
ORDER BY indicator_name ASC, observation_date DESC
LIMIT 200;
```

参数示例：`("ID00001915", "2025-11-03", "2025-12-04")`，另有与 `ID00001915` 绑定的 `selectionToken`。下层返回原始行、精确 ID、实际覆盖和行数；上层随后自行决定如何计算首末变化、每日区间或比较结果。

### 3. 目录选择证明 + 单日 → 原始日内观测集合

单日请求不复用多日时序入口。`query-day-by-selection` 用相同的目录选择证明和一个 `date` 查询，返回 `agentloop.steelMarketDayEvidence/v1`。若该日有多个 `DATA_VALUE`，全部保留；下层既不去重，也不选择代表价。

### 4. 已映射目录字段 → 简单聚合数据返回

`preflight-catalog` 不读取价格行。它对一个确认映射字段生成固定的目录质量聚合，用于判断字段可否作为选择器，而不是作市场分析：

```sql
SELECT COUNT(*) AS total_count,
       COUNT(`CITY_NAME`) AS populated_count,
       COUNT(DISTINCT NULLIF(TRIM(`CITY_NAME`), '')) AS distinct_count
FROM `MB_INDEX_MAIN_INFO`;

SELECT TRIM(`CITY_NAME`) AS value,
       COUNT(*) AS occurrences
FROM `MB_INDEX_MAIN_INFO`
WHERE `CITY_NAME` IS NOT NULL AND TRIM(`CITY_NAME`) <> ''
GROUP BY TRIM(`CITY_NAME`)
ORDER BY occurrences DESC, value ASC
LIMIT 20;
```

这类简单聚合只返回目录的总量、非空量、去重数与高频值。它不接受任意聚合函数或 `GROUP BY`，更不据此推导价格趋势、涨跌或市场结论。

### 5. 上层数据计划 → 多个独立的简单查询

上层可在 `agentloop.steelMarketQueryPlan/v1` 中列出多项有稳定 ID、日期范围和受控选择器的最小取数计划。下层逐项编译第 1 或第 2 类 SQL，保留独立回执。计划中的 `method` 和 `purpose` 仅供审计；它们不能变成 SQL 片段、字段、表名或聚合表达式。

## 反向：数据与空结果回溯目录

### 1. 已知 `INDEX_CODE` → 反查完整指标身份

若上层持有一个 ID 或需要核验回执身份，下层先在目录中反查映射维度，再决定是否读取数据：

```sql
SELECT i.`INDEX_CODE` AS indicator_id,
       i.`INDEX_NAME` AS indicator_name,
       i.`PROVINCE_NAME` AS province_name,
       i.`CITY_NAME` AS city_name,
       i.`BREED_NAME` AS breed_name,
       i.`CALIBER_NAME` AS caliber_name,
       i.`METRIC_NAME` AS metric_name,
       i.`FREQUENCY_NAME` AS frequency_name,
       i.`UNIT_NAME` AS unit_name,
       i.`CP_NAME` AS producer_name,
       i.`SOURCE_NAME` AS source_name
FROM `MB_INDEX_MAIN_INFO` i
WHERE i.`INDEX_CODE` = %s
LIMIT 2;
```

参数：`("ID00001915",)`。该步骤用于确认单位、频率、市场与生产者等目录口径；它不是通过名称猜测 ID，也不能把相似 ID 的观测混入结果。

### 2. 观测行的 `INDEX_CODE` → 反查目录口径

收到明细行后，以回执中的 `indicator_id` 反查同一目录记录。只有反查 ID 与请求 ID 一致，且单位、频率和目标维度可比时，上层才可对多个批次做后续比较。连接仍只允许：

```text
MB_INDEX_MAIN_INFO.INDEX_CODE = MB_INDEX_MAIN_DATA.INDEX_CODE
```

不能以城市、品种、指标名称或相近的展示文本连接两张表。

### 3. 空结果：区分“指标不存在”与“该窗口无观测”

空的明细结果不能直接说“没有这种钢材数据”。先使用第 1 个目录反查：

- 无目录签发的选择证明：拒绝该 `INDEX_CODE`，不发起值表查询；不能用“像代码的字符串”代替目录事实。
- 目录中没有该 `INDEX_CODE`：该配置映射下没有该指标身份，返回 `indicator_not_found` 型选择证据；不发起值表查询。
- 目录中有该 `INDEX_CODE`，但第 2 个明细查询的日期窗返回零行：返回 `dataAvailability: "no_observations"`，并保留精确 ID、起止日期和行数。
- 由语义字段定位为空或多候选：保留第 1 个正向案例的候选证据；它既不是已选指标，也不是值表无观测的证明。

这样，反向检查只补足数据身份和缺口事实，不会为了得到“有数据”而放宽字段、改写日期范围或制造替代序列。

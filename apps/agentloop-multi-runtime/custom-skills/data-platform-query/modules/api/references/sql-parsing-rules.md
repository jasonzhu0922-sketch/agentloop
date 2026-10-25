# API_SQL 解析规则（MyBatis 动态 SQL）

接口的 `API_SQL`（或兜底 `EXECUTE_SQL`）不是纯 SQL，混有 MyBatis 动态标签。解析目标是提取「入参 / 出参」，再把出参字段汉化。关联表优先读 `EXPAND_COL`（见 SKILL.md / schema.md）。

## 1. 动态标签

| 元素 | 含义 | 处理 |
|---|---|---|
| `#param#` | 入参占位符（预处理） | 提取为入参 |
| `$param$` | 直接字符串替换 | 提取为入参 |
| `<isNotEmpty property="xxx">…</isNotEmpty>` | 可选入参（条件拼接） | 提取 property 为入参；标签体保留 |
| `<isEqual>/<isNotEqual>/<choose>…` | 其他条件标签 | 同 isNotEmpty，剥标签留内容 |
| `<![CDATA[…]]>` | 转义块（如 `>=`、`<=`） | 去 `<!CDATA[` 与 `]]>`，保留内容 |

## 2. 出参提取

`SELECT` 与 `FROM` 之间的列表，按**顶层逗号**切分（括号/引号内的逗号不切）：

- `col` → 表字段，无别名
- `col AS alias` / `col alias` → 表字段 + 别名（显示别名，溯源用源字段）
- `a.col` → 带表别名前缀
- `a.*` / `*` → 星号，需展开
- `count(...)` / `sum(...)` / `case when ...` / `row_number() over()` 等 → **计算列**，无物理字段，显示别名原文
- 子查询别名 `(SELECT …) A` → 出参 `A.*` 时递归展开子查询的 SELECT 列表

## 3. 入参提取

- 所有 `#xxx#`、`$xxx$`、`property="xxx"` 去重合并。

## 4. 关联表

- **优先**：`T_ODS_TBEDM11.EXPAND_COL`（JSON 数组的 `tableEname`，schema.table 逗号分隔）。
- **兜底**（EXPAND_COL 为空时）：解析 SQL 的 `FROM` / `JOIN`：
  - `schema.table [alias]` → 直接定位
  - `table [alias]`（裸表名）→ `SYSCAT.TABLES` 反查 schema；同名多 schema 列歧义
  - `(SELECT …) alias` → 子查询，不当作物理表，但递归处理其内部 FROM

别名后紧跟 SQL 关键字（`WHERE/ON/GROUP/ORDER/LEFT/RIGHT/…`）时不当作别名。

## 5. 汉化（字段中文名）

1. 解析 `表.字段` → 定位 `schema.table`。
2. 查 `SYSCAT.COLUMNS.REMARKS`（大小写不敏感匹配）。
3. 命中 → 输出中文注释；未命中/计算列 → 显示别名或原字段名，标注「计算列」或「无法定位」。

## 6. 示例

### 例1：单表 select *（展开 + 汉化）

```sql
SELECT * FROM BSTAMAHR01.T_ADS_FACT_FAWHZHSS020102_V1 WHERE YEAR_MONTH = #year_month#
```

- 入参：`year_month`
- 出参：展开该表全部列，逐列查中文（如 `CURRENT_END_MANS` → 本期末人数）

### 例2：聚合 + 计算列

```sql
select ROW_NUMBER() OVER() sort_no, MAJORAWARD_GUID,
       majoraward_name as proj_name,
       count(distinct case when ta1.knowledge_type='发明专利' then knowledge_SQH else null end) patent_invent_count
from BSTAMAKJFX.T_ADS_SRV_KJCG_ZDJ01 ta1
where MAJORAWARD_APPLY_YEAR=#applyyear#
```

- 入参：`applyyear`
- 出参：`sort_no`/`patent_invent_count` → 计算列（别名原文）；`MAJORAWARD_GUID` → 重大奖记录ID；`proj_name` → 重大奖名称

### 例3：多表 JOIN + 子查询（`A.*` 递归）

```sql
SELECT DISTINCT A.*, C.BUSI_TYPE, C.BUSI_TYPE_DESC
from (SELECT COMPANY_CODE, CURRENCY_CODE FROM BSTAMSCW00.T_DWD_FACT_CWPJ_ZQ_BASE WHERE ...) A
LEFT JOIN T_DWD_FACT_CWZW_BANK_PAY_RECORD_BASE_INFO B ON A.COMPANY_CODE=B.COMPANY_CODE
LEFT JOIN BSTAMSCW00.T_DWD_FACT_CWZW_INCOMING_INVOICE_BASE_INFO C ON C.COMPANY_CODE=B.COMPANY_CODE
WHERE 1=1 <isNotEmpty prepend=" and " property="currencyCode">A.CURRENCY_CODE=#currencyCode#</isNotEmpty>
```

- 入参：`currencyCode`
- 出参：`A.*` 递归展开子查询（COMPANY_CODE→公司代码(账套)、CURRENCY_CODE→币种代码…）+ `C.BUSI_TYPE`→主办单位、`C.BUSI_TYPE_DESC`→主办单位描述
- 关联表：`T_DWD_FACT_CWPJ_ZQ_BASE`、`T_DWD_FACT_CWZW_BANK_PAY_RECORD_BASE_INFO`（裸表名反查）、`T_DWD_FACT_CWZW_INCOMING_INVOICE_BASE_INFO`

## 7. 已知局限

- 启发式解析，极端复杂 SQL（深层嵌套、CTE/WITH、跨层 UNION 混用）可能解析不全 → 降级人工解读。
- 计算列不臆造中文，只显示别名。
- `select *` 在子查询/视图上的展开依赖物理表定位，视图字段注释可能为空。

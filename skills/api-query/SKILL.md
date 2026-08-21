---
name: api-query
description: >
  查询集团（宝武数据中台）API 目录信息。Use when 用户要了解某个 API/接口/服务是干什么的、
  有哪些入参、哪些出参、涉及哪些数据表，或要检索现有 API。触发词：查API、查接口、API入参出参、
  这个接口是干啥的、接口涉及哪些表、API目录检索。数据源为数智域通用 SQL API。
---

# API 目录检索技能

帮助业务人员检索宝武数据中台的 API：了解某 API 的用途、入参、出参（字段中文名），以及关联的数据表。

## 数据源

统一走**数智域通用 SQL API**（一个接口查所有，底层 DB2）：

```
POST https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT
Body: {"sql": "...", "clientId": "bwssa", "clientSecret": "4B13539D106BD64079BD1FF180D7BA37", "offset": "0", "limit": "1000"}
```

- 成功返回 `__sys__.status == 1`，结果在 `__blocks__.result.meta.columns` + `rows`。
- **API 会自动追加 `fetch first 1000 rows only`，SQL 里不要再写 fetch/limit。**
- 分页用 body 里的 `offset`（从 0 开始）/`limit`。
- 字段中文名来自 `SYSCAT.COLUMNS.REMARKS`（建表注释），与数据同库，一条 SQL 可查。

> 凭证可通过环境变量 `EPLAT_CLIENT_ID` / `EPLAT_CLIENT_SECRET` 覆盖，脚本里已有默认值。

## 核心表（schema = BSTAMOBWSD）

主表对齐前端「数据API」页：

| 表 | 作用 | 关键字段 |
|---|---|---|
| `T_ODS_TBEDM11` | **API主表（主数据源，约6600条）** | `API_ID`、`API_NAME`(英文名)、`API_CNAME`(中文名)、`API_DESC`、`API_TYPE`、`API_STATUS`(normal/unpublished)、`RELEASE_STATUS`、`API_URL`、`API_SQL`(逻辑SQL)、**`EXPAND_COL`(关联表JSON)** |
| `T_ODS_TBEXY31` | 数据API目录（“31表”，SQL 兜底） | `API_ID`、`ASSETS_CNAME`、`EXECUTE_SQL`(逻辑SQL，API_SQL 为空时兜底)、`INPUT_PARAM`/`OUTPUT_PARAM` |
| `T_ODS_TBEDM12` | API 参数表（入参出参兜底） | `PARAM_NAME`、`PARAM_TYPE`、`FIELD_NAME`、`FIELD_CNAME`、`FROM_TABLE`、`REQUIRED`、`OPERATOR`、`PARAM_DESC` |
| `T_ODS_TBEDG2221/2222` | 服务单元API / 其参数 | `API_UUID`、`API_SQL_TEMP`、`MANAGEMENT_UNIT` |
| `T_ODS_TBEDG2301` | 算法API | `API_ENTRY_FUNCTION`、`API_IN_PARAMS`、`API_OUT_PARAMS` |
| `T_ODS_TBEDM1502` | 上线API参数 | `PARAM_NAME`、`PARAM_VALUE`、`FILTER_METHOD` |
| `T_ODS_APICALLINFO` | API调用记录 | `API_ENAME`、`API_CALLDATE` |

`API_ID` 形如 `M_模型ID.S_服务单元ID.API名`（如 `M_DWD_FACT_CWZW_BANK_PAY_RECORD_BASE_INFO.D_A_BSTACWZW_YY1135`）。

`EXPAND_COL` 是 JSON 数组，`tableEname` 字段即关联的物理表清单（`schema.table` 逗号分隔），如：
`[{"tableEname":"BSTAMSCW00.T_DWD_FACT_CWZW_BANK_PAY_RECORD_BASE_INFO,BFMSXAAA.T_ODS_TAAAA_VOUCHER_FILES_GF","partitionName":"...","dbEngineUuid":"..."}]`

## 工作流

### Step 1：检索 API

优先使用一条命令完成检索、详情解析、参数表核验和交付候选生成：

```bash
python3 scripts/api_query.py answer "采购" --format json
```

`answer --format json` 会输出 `api_catalog_result/v1`：

- `deliveryCandidate.output`：可直接作为候选答复提交给 Runtime 评估。
- `assessmentProjection`：给评估模型使用的短证据摘要。
- `apis[]`：完整结构化 API 详情，包括入参、出参、关联表、SQL hash/preview。

除非用户要求逐个排查或脚本结果不完整，不要把 `search` + 多个 `detail` 当作默认路径。

按关键词模糊匹配 `API_CNAME`(中文名) / `API_NAME`(英文名) / `API_DESC` / `API_ID`：

```bash
python3 scripts/api_query.py search "采购"
# 或直接 SQL：
# select API_ID, API_CNAME, API_NAME, API_TYPE, API_STATUS from BSTAMOBWSD.T_ODS_TBEDM11
# where API_CNAME like '%采购%' and TRIM(API_ID) <> ''
```

### Step 2：取详情 + 解析

```bash
python3 scripts/api_query.py detail "<API_ID>"
```

脚本会：取 `API_SQL`（为空回退 31表 `EXECUTE_SQL`）→ 解析入参（`#x#`/`$x$`/`property="x"`）→ 解析出参（SELECT 列表，含 `*` 展开、子查询别名递归、聚合列）→ 逐个字段查 `SYSCAT.COLUMNS.REMARKS` 汉化；关联表优先读 `EXPAND_COL` JSON，为空时回退解析 SQL。

### Step 3：输出

结构化输出「用途 + 入参 + 出参(中文) + 关联表」。若脚本解析不全（如超复杂 SQL），按 `references/sql-parsing-rules.md` 的规则手动补全，或直接贴出 SQL 人工解读。

## 汉化规则（与用户确认）

1. **表字段**（能定位 `schema.table.column`）→ `SYSCAT.COLUMNS.REMARKS` 中文注释。
2. **计算列**（`count/sum/case when/row_number` 等聚合/窗口/表达式）→ 无物理字段，显示别名原文（别名一般是业务英文）。
3. **`*` 展开** → 物理表全字段逐个汉化；子查询别名（`A.*`）→ 递归展开子查询 SELECT 列表。
4. **裸表名**（无 schema）→ `SYSCAT.TABLES WHERE TABNAME=…` 反查 schema；同名多 schema 时列歧义。
5. **关联表**：优先 `T_ODS_TBEDM11.EXPAND_COL`（平台登记的映射表 JSON），为空时回退解析 SQL 的 FROM/JOIN。
6. **逻辑 SQL**：`T_ODS_TBEDM11.API_SQL` 为主，为空回退 `T_ODS_TBEXY31.EXECUTE_SQL`。
7. **域过滤**：暂不做（业务用户靠关键词检索命中，如搜“应付账款/资金/票据”）。
8. **解析不清**（子查询/UNION 过于复杂）→ 降级显示「原字段名 + 无法定位」，不臆造。

## Tool Contract

- `bash`：运行 `scripts/*.py`（`query_api.py` 封装 API 调用、`parse_sql.py` 解析、`api_query.py` 编排）。
- 也可直接用 MCP `call_rdb_sql_api_query`（data_domain=`SZ_IBM-DB2`）在开发期兜底验证，但生产以通用 SQL API 为准。

## 脚本说明

- `scripts/query_api.py`：通用 SQL API 客户端。`python3 query_api.py "SELECT ..."`；`python3 query_api.py --columns <schema> <table>` 查字段中文。
- `scripts/parse_sql.py`：MyBatis 动态 SQL 解析（入参/表/出参）。
- `scripts/api_query.py`：编排 CLI。`answer <关键词> --format json` / `search <关键词>` / `detail <API_ID>`。

## Error Handling

- API `status != 1` 且非“结果集为空”→ 报错并附 `apiSql`，检查 SQL 是否带了多余的 `fetch/limit`。
- 结果为空 → 返回空，不视为错误。
- 未找到 API → 提示「未找到 API：<ID>」，建议用 `search` 先检索。

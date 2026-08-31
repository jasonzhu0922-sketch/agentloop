# API 目录核心表结构参考

数据域：数智域，底层 DB2。schema `BSTAMOBWSD`（宝武大数据平台 ODS 层）。

## 1. T_ODS_TBEDM11 —— API 主表（主数据源，对齐前端「数据API」页）

约 6600 条。字段：

| 字段 | 含义 |
|---|---|
| `API_ID` | API 标识，形如 `M_模型ID.S_服务单元ID.API名` |
| `API_NAME` | API 英文名 |
| `API_CNAME` | API 中文名 |
| `API_DESC` | API 描述（用途） |
| `API_TYPE` | API 类型（single/multi/rest） |
| `API_STATUS` | 状态（normal/unpublished/applying/rejected） |
| `RELEASE_STATUS` | 发布状态（0/1） |
| `API_URL` | API 访问地址 |
| `API_SQL` | **执行 SQL（MyBatis 动态 SQL，CLOB，入参出参解析源头）** |
| `EXPAND_COL` | **关联表 JSON（CLOB）**，`tableEname` 为 schema.table 清单 |
| `API_MANAGER` | API 管理员 |
| `API_CACHE` | 缓存开关 |
| `PROJECT_NAME`/`PROJECT_ALIAS`/`PROJECT_UUID` | 工作空间名/别名/UUID |
| `OWNER_GROUP` | 所有者群组 |
| `AREA_UUID`/`OBJECT_UUID`/`PROCESS_UUID`/`DOMAIN_UUID` | 数据分类/对象/过程/域的 UUID（中文名需 JOIN 维度表） |
| `UUID` / `OLD_UUID` | 全局唯一标识 / 旧 UUID |

`EXPAND_COL` 示例：

```json
[{"tableEname":"BSTAMSCW00.T_DWD_FACT_CWZW_BANK_PAY_RECORD_BASE_INFO,BFMSXAAA.T_ODS_TAAAA_VOUCHER_FILES_GF",
  "tableUuid":"...", "partitionName":"BSTAMSCW00,BFMSXAAA", "dbEngineUuid":"..."}]
```

## 2. T_ODS_TBEXY31 —— 数据API目录（“31表”，SQL 兜底）

约 31 万行，每行一个数据 API 资产。`API_SQL` 为空时用它兜底取 `EXECUTE_SQL`。

| 字段 | 含义 |
|---|---|
| `API_ID` | API 标识 |
| `ASSETS_CNAME` | 资产中文名 |
| `ASSETS_DESC` | 资产描述 |
| `MODEL_NAME` | 服务单元名称 |
| `EXECUTE_SQL` | **逻辑 SQL（CLOB，API_SQL 兜底来源）** |
| `INPUT_PARAM` / `OUTPUT_PARAM` | 输入/输出参数（多为 NULL） |
| `DATA_SOURCE_NAME` | 数据源名称 |
| `REQUEST_METHOD` / `URL_ADDRESS` | 请求方式 / URL |
| `AREA_NAME` / `OBJECT_CNAME` | 数据分类 / 业务对象中文名 |
| `DOMAIN_ENAME` / `DOMAIN_CNAME` | 数据域代码 / 名称（如 BSTACW00=集团财务域） |

## 3. T_ODS_TBEDM12 —— API 参数表（入参/出参兜底来源）

| 字段 | 含义 |
|---|---|
| `PARAM_ID` | 参数标识 |
| `PARAM_NAME` | 参数名称 |
| `API_ID` | 所属 API 标识 |
| `FROM_TABLE` | **映射实体表**（参数来自哪张表） |
| `PARAM_TYPE` | 参数类型 |
| `FIELD_NAME` | 字段名称 |
| `FIELD_TYPE` | 字段类型 |
| `FIELD_CNAME` | **字段中文名** |
| `OPERATOR` | 操作符 |
| `REQUIRED` | 是否必填项 |
| `PARAM_DESC` | 参数描述 |
| `DATA_TYPE` / `DATA_LENGTH` | 参数数据类型 / 长度 |

## 4. 其他配套表

| 表 | 作用 |
|---|---|
| `T_ODS_TBEDG2221` | 服务单元 API 主表（`API_UUID`、`API_SQL_TEMP`、`MANAGEMENT_UNIT`） |
| `T_ODS_TBEDG2222` | 服务单元 API 参数（`PARAM_ID`、`PARAM_NAME`、`OPERATOR`） |
| `T_ODS_TBEDG2301` | 算法 API（`API_VERSION`、`API_ENTRY_FUNCTION`、`API_IN_PARAMS`、`API_OUT_PARAMS`） |
| `T_ODS_TBEDM1502` | 上线 API 参数（`PARAM_NAME`、`PARAM_VALUE`、`FILTER_METHOD`） |
| `T_ODS_APICALLINFO` | API 调用记录（`API_ENAME`、`API_CALLDATE`、`CALLAPP_CNAME`） |

## 5. 字段中文名来源

`SYSCAT.COLUMNS.REMARKS`（DB2 系统数据字典，建表注释）。查法：

```sql
select COLNAME, REMARKS from SYSCAT.COLUMNS
where TABNAME = '<表名>' and TABSCHEMA = '<schema>'
```

同名表跨 schema 定位：`select distinct TABSCHEMA from SYSCAT.TABLES where TABNAME = '<表名>'`。

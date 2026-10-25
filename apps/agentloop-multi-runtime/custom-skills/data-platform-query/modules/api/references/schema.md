# API 目录核心表结构参考

数据域：数智域，底层 DB2。schema `BSTAMOBWSD`（宝武大数据平台 ODS 层）。

## 1. T_ODS_TBEDG2221 —— API 主表（主数据源，数据模型 API 表）

约 6600 条（`API_ID` 去重 6636）。字段：

| 字段 | 含义 |
|---|---|
| `API_ID` | API 标识，形如 `M_模型ID.D_服务单元ID.API名` |
| `API_NAME` | API 英文名 |
| `API_DESC` | API 中文描述（**作为中文名使用**，非空率约 99.9%） |
| `API_TYPE` | API 类型（single/multi/rest/INSERT_DATA_API/MULTI_SQL_API/SD_SQL_API/SQL_API） |
| `API_STATUS` | 状态（normal/unpublished/...） |
| `API_UPDOWN_STATUS` | 上下架状态（pass/default/processing/fail） |
| `RELEASE_STATUS` | 发布状态（0/1/2/3） |
| `API_URL` | API 访问地址 |
| `API_SQL` | **逻辑 SQL（MyBatis 动态 SQL，CLOB，入参出参解析源头）** |
| `API_SQL_TEMP` | 执行 SQL（API_SQL 为空时的兜底） |
| `API_UUID` | API UUID（后来加，不作为唯一键） |
| `API_CONFIG` | API 配置信息 |
| `MODEL_TYPE` / `MANAGEMENT_UNIT` | 模型分类 / 管理单位 |
| `SAFETY` | 安全等级（L1/L2/L3） |
| `API_IS_AUTH` | 是否鉴权（0/1） |
| `PROJECT_UUID` | 工作空间 UUID → `T_ODS_TBEDD10.UUID` |
| `DOMAIN_UUID` | 数据域 UUID → `T_ODS_TBEDG43.UUID` |
| `CATEGORY_UUID` | 资产类目 UUID → `T_ODS_TBEDG41.UUID` |
| `AREA_UUID` | 数据分类 UUID → `T_ODS_TBEDF32.UUID` |
| `OBJECT_UUID` | 业务对象 UUID → `T_ODS_TBEDF15.UUID` |
| `PROCESS_UUID` | 业务过程 UUID → `T_ODS_TBEDF33.UUID` |

维度 UUID 关联（见 `数据加工/API跟踪0413.sql`）命中率：工作空间 6633/6636、数据域 2487、资产类目 2145、数据分类 2326、业务对象 2069、业务过程 181。

## 2. T_ODS_TBEDG2222 —— API 参数表（入参/出参主来源）

约 2.7 万行，按 `API_ID` 关联主表（全部能匹配上）。`PARAM_TYPE` 区分 `in`（入参，15199 行，覆盖 4104 个 API）与 `out`（出参，11861 行，覆盖 244 个 API）。

| 字段 | 含义 |
|---|---|
| `API_ID` | 所属 API 标识 |
| `PARAM_ID` | 参数标识 |
| `PARAM_NAME` | 参数名称（对外暴露名） |
| `PARAM_TYPE` | 参数类型（in/out） |
| `FIELD_NAME` | 字段名称（物理字段） |
| `FIELD_TYPE` | 字段类型 |
| `FROM_TABLE` | **映射实体表**（参数/关联表来源，非空率约 96%） |
| `REQUIRED` | 是否必填（Y/N） |
| `OPERATOR` | 操作符 |
| `PARAM_DESC` | 参数描述（部分含中文） |
| `SAMPLE_DATA` | 样例数据 |

## 3. 维度表（UUID → 中文名）

| 表 | 维度 | 关联字段 | 中文名字段 |
|---|---|---|---|
| `T_ODS_TBEDD10` | 工作空间 | `UUID` = `PROJECT_UUID` | `PROJECT_ALIAS` |
| `T_ODS_TBEDG43` | 数据域 | `UUID` = `DOMAIN_UUID` | `DOMAIN_CNAME` |
| `T_ODS_TBEDG41` | 资产类目 | `UUID` = `CATEGORY_UUID` | `CATEGORY_CNAME_ID` |
| `T_ODS_TBEDF32` | 数据分类 | `UUID` = `AREA_UUID` | `AREA_NAME` |
| `T_ODS_TBEDF15` | 业务对象 | `UUID` = `OBJECT_UUID` | `OBJECT_CNAME` |
| `T_ODS_TBEDF33` | 业务过程 | `UUID` = `PROCESS_UUID` | `PROCESS_NAME` |

## 4. T_ODS_TBEXY31 —— 数据API目录（“31表”，SQL 兜底）

约 31 万行，每行一个数据 API 资产。`API_SQL`/`API_SQL_TEMP` 都为空时用它兜底取 `EXECUTE_SQL`。

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

## 5. T_ODS_TBEDM12 —— API 参数表（入参/出参兜底来源，含中文名）

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

## 6. 其他配套表

| 表 | 作用 |
|---|---|
| `T_ODS_TBEDG2301` | 算法 API（`API_VERSION`、`API_ENTRY_FUNCTION`、`API_IN_PARAMS`、`API_OUT_PARAMS`） |
| `T_ODS_TBEDM1502` | 上线 API 参数（`PARAM_NAME`、`PARAM_VALUE`、`FILTER_METHOD`） |
| `T_ODS_APICALLINFO` | API 调用记录（`API_ENAME`、`API_CALLDATE`、`CALLAPP_CNAME`） |

## 7. 字段中文名来源

`SYSCAT.COLUMNS.REMARKS`（DB2 系统数据字典，建表注释）。查法：

```sql
select COLNAME, REMARKS from SYSCAT.COLUMNS
where TABNAME = '<表名>' and TABSCHEMA = '<schema>'
```

同名表跨 schema 定位：`select distinct TABSCHEMA from SYSCAT.TABLES where TABNAME = '<表名>'`。

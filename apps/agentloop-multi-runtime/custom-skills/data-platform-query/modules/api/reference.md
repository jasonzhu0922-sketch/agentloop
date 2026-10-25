---
name: api-query
description: >
  检索宝武数据中台 API 目录，回答 API 用途、入参、出参（字段中文名）与关联数据表。
---

# API 目录检索技能（项目直连版）

## Scope

帮助业务人员检索宝武数据中台的 API 目录，了解某 API 的用途、入参、出参（字段中文名），以及关联的数据表与血缘。

- 使用条件：用户需要了解某 API 是什么、入参出参是什么、涉及哪些表，或检索已有 API。
- 不使用条件：创建/修改 API 定义、调用 API 执行业务查询、编写与 API 目录无关的文档。
- 只读：是。仅执行 SELECT 查询。
- 用户确认：不需要。
- 接口调用：直接 POST `https://eplat.baocloud.cn/service/D_A_BSTABD00_TMP_TEST_DATA`，不使用 Connector。

## Routing

- 检索 API 目录、查询 API 用途/入参/出参/关联表，使用本 Skill。
- 要求创建或修改 API 定义时，不使用本 Skill。
- 结果需要整理为 Excel 等交付物时，本 Skill 仍是 primary，可组合 materializer 类 support Skill（本仓库暂未提供）。

## Inputs

```text
required:
  - keyword  # search 模式：检索关键词；detail/similar 模式：API_ID
```

## Workflow

按子命令执行：

```bash
python3 scripts/api_query.py search "<关键词>"     # 按中文描述/英文名/API_ID 模糊检索（返回全部匹配）
python3 scripts/api_query.py detail "<API_ID>"     # 输出用途 + 入参 + 出参(汉化) + 关联表 + 血缘 + 维度中文名
python3 scripts/api_query.py similar "<API_ID>"    # 仅血缘相似 API（引用相同表的 API，Jaccard 排序）
```

**search 行为约定**：`search` 返回接口单次最多 10000 条匹配，脚本输出「共 N 个匹配 API」+ 返回列表。

- 匹配数量合理时，不要自行筛选，必须把整个列表原样呈现给用户（或如实告知总数并完整列出）。
- 匹配数量过多（约 ≥100 个）时，说明关键词过于模糊，不要刷屏列出；先如实告知「匹配到约 N 个 API，结果过多」，并追问补充业务领域、数据域、更精确的中文名关键词、数据类型等，缩小范围后再 `search`。

## Tool Contract

- Allowed tools:
  - `run_skill_script`（`scripts/api_query.py`）
- Required cTools: 无。
- Forbidden:
  - 使用未声明的其他内部接口
  - 临时生成生产替代脚本

## Sandbox Path Contract

本 Skill 不读写文件，仅通过声明的测试 SQL API 调用远端服务，无沙箱读写路径。脚本不得访问 `_meta` 或推导沙箱根路径。

## Data And Compliance

- 数据来源：宝武数据中台测试 SQL API。
- 数据 Owner：数智域（待确认）。
- 权限边界：只读取本 Skill 根目录 `.env` 中的 `DAM_TEST_SQL_ENDPOINT`、`DAM_TEST_CLIENT_ID` 和 `DAM_TEST_CLIENT_SECRET`；缺项时报错，不读取全局环境变量或回显凭据。
- 个人信息/敏感数据：否。
- 日志与调试输出：默认不输出凭证、token；脚本仅打印查询结果。
- 输出限制：查询结果以接口返回为准，不替代正式数据审批或变更依据。

## Error Handling

- HTTP 接口不可达或调用失败 → 报错并停止，不伪造数据。
- API `status != 1` 且非“结果集为空”→ 报错并附 `apiSql`，检查 SQL 是否带了多余的 `fetch/limit`。
- 结果为空 → 返回空，不视为错误。
- 未找到 API → 提示「未找到 API：<ID>」，建议用 `search` 先检索。
- 不循环重试同一个确定性失败。

## Output Format

`detail` 输出必须完整、平级列出以下小节，缺一不可：

1. 基本信息：API_ID、中文名、英文名、类型、状态、数据域 / 数据分类 / 业务对象
2. 入参
3. 出参（字段 + 中文名）
4. 关联表
5. 血缘（必答）：上游引用表、公共表（已排除）、相似 API 列表——逐条列出「相似度 + 英文名（中文名）」，Top 10

红线规则：只要运行了 `detail`，就必须返回「血缘」区块。血缘与入参 / 出参 / 关联表同等重要，任何情况都不得省略、降级为一句注脚或等用户追问才展示。每次回复 `detail` 前自检「血缘」二字是否已出现在回复中。

## 关键口径

- 主表：`T_ODS_TBEDG2221`（数据模型 API 表）；中文名用 `API_DESC`（主表无 `API_CNAME`）。
- 逻辑 SQL：`API_SQL` 为主 → 回退 `API_SQL_TEMP` → 再回退 31 表 `EXECUTE_SQL`。
- 入参/出参：优先参数表 `T_ODS_TBEDG2222`（`PARAM_TYPE` in/out）；无记录时回退 SQL 解析。
- 关联表：优先参数表 `FROM_TABLE`；为空时回退解析 SQL 的 FROM/JOIN。
- 域过滤：暂不做（业务用户靠关键词检索命中）。
- 血缘相似：基于 `BSTAMSBD00.T_DWD_FACT_BDAQ_DATA_LINEAGE_RELATIONSHIP`，API 引用的上游类型仅「表」；相似度用 Jaccard，输出 Top 10；被 ≥50 个 API 引用的公共表过滤，不参与相似度计算（阈值 `MIN_API_CNT` 可调）。相似 API 展示为「英文名（中文名）」，中文名由 `get_cname` 按 `API_NAME` 精确匹配、查不到时按 `API_ID` 后缀兜底。

## 参考

- `references/schema.md` —— 核心表结构、字段、维度表关联关系。
- `references/sql-parsing-rules.md` —— MyBatis 动态 SQL 解析规则与示例，脚本解析不全时手动补全。
- `scripts/lineage_similar.py` —— 血缘相似分析实现。

## Tests And Acceptance

- 路由正例：查询 API 用途/入参/出参 → 本 Skill。
- 路由反例：创建/修改 API、写宣传文案 → 非本 Skill。
- 边界样例：结果需整理成 Excel → 本 Skill primary + materializer support。
- 冲突样例：修改 API 定义 → 非本 Skill。
- 脚本 smoke：`tests/test_script_smoke.py`（mock HTTP，不访问真实 API）。

## Change Log

- `0.2.1`：修复「结果集为空」误判——`_normalize` 将后端返回的 `status != 1` 且 msg 含「结果集为空」视为正常空结果，返回 `{columns:[], rows:[], count:0}` 而非抛 `ApiError`，使无参数 API 的 SQL 解析兜底逻辑（`detail` 入参/出参回退）得以触发。
- `1.0.0`：复制到项目 `skills/` 后改为直接 POST 测试 SQL API，统一使用 `clientId/clientSecret/sql/showCount/offset/limit` 请求体。
- `0.2.0`：修复连接器返回格式适配——`query_api.py` 增加 `_normalize`，兼容通用 SQL-API 原始体（`__blocks__.result.meta.columns` / `__blocks__.result.rows`）与 `__sys__.status` 错误判定，解决 `KeyError: 'columns'`。
- `0.1.0`：首次试运行版本，接入连接器调用层与治理元数据。

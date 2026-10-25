#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
api_query.py - API 查询编排 CLI（数据源对齐前端：主表 T_ODS_TBEDG2221）

用法：
    python3 api_query.py search <关键词>              # 按中文描述/英文名/API_ID 模糊检索
    python3 api_query.py detail <API_ID>             # 输出用途 + 入参 + 出参(汉化) + 关联表
    python3 api_query.py similar <API_ID>            # 血缘相似 API 分析（引用相同表的 API）

依赖同目录下的 query_api.py 与 parse_sql.py。

数据口径（与前端一致）：
    - 主表     : BSTAMOBWSD.T_ODS_TBEDG2221（数据模型 API 表）
    - 参数表   : BSTAMOBWSD.T_ODS_TBEDG2222（服务单元 API 参数，PARAM_TYPE in/out）
    - 逻辑 SQL : T_ODS_TBEDG2221.API_SQL（为空回退 T_ODS_TBEXY31.EXECUTE_SQL）
    - 关联表   : 参数表 FROM_TABLE 优先，SQL 解析 FROM/JOIN 兜底
    - 汉化     : SYSCAT.COLUMNS.REMARKS（建表注释）
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from query_api import query_dicts, query_columns_remarks, find_schema, ApiError, DEFAULT_LIMIT  # noqa: E402
from parse_sql import parse, extract_tables, extract_output_columns  # noqa: E402

# 主表（数据模型 API 表）与参数表、31表（数据 API 目录，SQL 兜底）
T_MAIN = "BSTAMOBWSD.T_ODS_TBEDG2221"
T_PARAM = "BSTAMOBWSD.T_ODS_TBEDG2222"
T_XY31 = "BSTAMOBWSD.T_ODS_TBEXY31"

_MAIN_COLS = (
    "API_ID, API_NAME, API_DESC, API_TYPE, API_STATUS, "
    "API_UPDOWN_STATUS, RELEASE_STATUS, API_URL, "
    "PROJECT_UUID, DOMAIN_UUID, CATEGORY_UUID, AREA_UUID, OBJECT_UUID, PROCESS_UUID"
)

# 维度表（UUID -> 中文名），见 数据加工/API跟踪0413.sql
_DIMS = (
    ("工作空间", "BSTAMOBWSD.T_ODS_TBEDD10", "UUID", "PROJECT_ALIAS", "PROJECT_UUID"),
    ("数据域", "BSTAMOBWSD.T_ODS_TBEDG43", "UUID", "DOMAIN_CNAME", "DOMAIN_UUID"),
    ("资产类目", "BSTAMOBWSD.T_ODS_TBEDG41", "UUID", "CATEGORY_CNAME_ID", "CATEGORY_UUID"),
    ("数据分类", "BSTAMOBWSD.T_ODS_TBEDF32", "UUID", "AREA_NAME", "AREA_UUID"),
    ("业务对象", "BSTAMOBWSD.T_ODS_TBEDF15", "UUID", "OBJECT_CNAME", "OBJECT_UUID"),
    ("业务过程", "BSTAMOBWSD.T_ODS_TBEDF33", "UUID", "PROCESS_NAME", "PROCESS_UUID"),
)


_SEARCH_PAGE = 1000


def search(keyword, limit=None):
    """按关键词模糊检索 API（API 主表，中文描述/英文名/API_ID）。

    通过接口单次最多返回 10000 条；传入的 limit 保持兼容但请求体固定为 10000。
    """
    kw = keyword.replace("'", "''")
    cond = (
        f"where (API_DESC like '%{kw}%' or API_NAME like '%{kw}%' "
        f"or API_ID like '%{kw}%') "
        f"and TRIM(API_ID) <> ''"
    )
    sql = f"select {_MAIN_COLS} from {T_MAIN} {cond}"
    return query_dicts(sql, limit=limit or DEFAULT_LIMIT)


def get_api(api_id):
    """取某 API 的元数据 + API_SQL（API_SQL 为空时回退 31 表）。

    匹配顺序：API_NAME(英文名) 精确 → API_ID 精确 → API_DESC(中文描述) 模糊兜底。
    """
    api_id_esc = api_id.replace("'", "''")
    rows = []
    for cond in (
        f"API_NAME = '{api_id_esc}'",
        f"API_ID = '{api_id_esc}'",
        f"API_DESC like '%{api_id_esc}%'",
    ):
        rows = query_dicts(
            f"select {_MAIN_COLS}, API_SQL, API_SQL_TEMP from {T_MAIN} "
            f"where {cond}"
        )
        if rows:
            break
    if not rows:
        return None
    api = rows[0]
    sql = api.get("API_SQL") or ""
    if not sql or not sql.strip():
        sql = api.get("API_SQL_TEMP") or ""
    if not sql or not sql.strip():
        fb = query_dicts(
            f"select EXECUTE_SQL from {T_XY31} where API_ID = '{api_id_esc}'"
        )
        if fb and (fb[0].get("EXECUTE_SQL") or "").strip():
            api["API_SQL"] = fb[0]["EXECUTE_SQL"]
            sql = api["API_SQL"]
    api["API_SQL"] = sql
    return api


def get_params(api_id):
    """取参数表 T_ODS_TBEDG2222 的入参/出参，返回 {in: [...], out: [...]}"""
    api_id_esc = api_id.replace("'", "''")
    rows = query_dicts(
        f"select PARAM_NAME, PARAM_TYPE, FIELD_NAME, FIELD_TYPE, FROM_TABLE, "
        f"REQUIRED, OPERATOR, PARAM_DESC from {T_PARAM} where API_ID = '{api_id_esc}'"
    )
    ins, outs = [], []
    for r in rows:
        if (r.get("PARAM_TYPE") or "").strip().lower() == "out":
            outs.append(r)
        else:
            ins.append(r)
    return {"in": ins, "out": outs}


# ---------------------------------------------------------------------------
# 维度中文名（UUID -> 名称）
# ---------------------------------------------------------------------------

_dim_cache = {}


def get_dims(api):
    """根据主表的 6 个维度 UUID 取中文名，返回 [(名称, 中文值), ...]"""
    dims = []
    for name, table, key_field, val_field, uuid_field in _DIMS:
        uuid = (api.get(uuid_field) or "").strip()
        if not uuid:
            dims.append((name, ""))
            continue
        cache_key = (table, uuid)
        if cache_key not in _dim_cache:
            u = uuid.replace("'", "''")
            rows = query_dicts(
                f"select {val_field} as V from {table} where {key_field} = '{u}'"
            )
            _dim_cache[cache_key] = (rows[0].get("V") or "").strip() if rows else ""
        dims.append((name, _dim_cache[cache_key]))
    return dims


# ---------------------------------------------------------------------------
# 表/列解析辅助（沿用 parse_sql）
# ---------------------------------------------------------------------------

_schema_cache = {}
_remarks_cache = {}


def _get_schemas(table):
    if table not in _schema_cache:
        try:
            _schema_cache[table] = find_schema(table)
        except ApiError:
            _schema_cache[table] = []
    return _schema_cache[table]


def _build_alias_map(tables):
    """构建 别名/表名 -> (schema, table) 映射"""
    alias_map = {}
    known_schemas = set()
    for t in tables:
        if t["schema"]:
            schema, table = t["schema"], t["table"]
            known_schemas.add(schema.upper())
            alias_map[table.upper()] = (schema, table)
            if t["alias"]:
                alias_map[t["alias"].upper()] = (schema, table)
    for t in tables:
        if not t["schema"]:
            table = t["table"]
            schemas = _get_schemas(table)
            schema = ""
            if len(schemas) == 1:
                schema = schemas[0]
            elif len(schemas) > 1:
                preferred = [s for s in schemas if s.upper() in known_schemas]
                if len(preferred) == 1:
                    schema = preferred[0]
            alias_map[table.upper()] = (schema, table)
            if t["alias"]:
                alias_map[t["alias"].upper()] = (schema, table)
    return alias_map


def _get_remarks(schema, table):
    key = (schema.upper(), table.upper())
    if key not in _remarks_cache:
        try:
            _remarks_cache[key] = {
                k.upper(): v for k, v in query_columns_remarks(schema, table).items()
            }
        except ApiError:
            _remarks_cache[key] = {}
    return _remarks_cache[key]


def _resolve_column(col, alias_map):
    column = col["column"]
    qualifier = col["qualifier"]
    if qualifier:
        key = qualifier.upper()
        if key in alias_map:
            schema, table = alias_map[key]
            return schema, table, column
        schemas = _get_schemas(qualifier)
        if len(schemas) == 1:
            return schemas[0], qualifier, column
        return None
    physical = _physical_tables(alias_map)
    if len(physical) == 1:
        s, t = physical[0]
        return s, t, column
    return None


def _physical_tables(alias_map):
    seen = set()
    out = []
    for s, t in alias_map.values():
        if t and s and (s.upper(), t.upper()) not in seen:
            seen.add((s.upper(), t.upper()))
            out.append((s, t))
    return out


def _find_subquery(sql_clean, alias):
    start = 0
    while True:
        idx = sql_clean.find("(", start)
        if idx == -1:
            return None
        after = sql_clean[idx + 1:].lstrip()
        if after[:6].lower() == "select":
            depth = 0
            j = idx
            while j < len(sql_clean):
                c = sql_clean[j]
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        rest = sql_clean[j + 1:].lstrip()
                        m = re.match(r"^" + re.escape(alias) + r"\b", rest, re.IGNORECASE)
                        if m:
                            return sql_clean[idx + 1:j]
                        break
                j += 1
            start = idx + 1
        else:
            start = idx + 1
    return None


def _expand_star(col, alias_map, sql_clean, cache):
    qualifier = col["qualifier"]
    schema, table = None, None
    if qualifier:
        key = qualifier.upper()
        if key in alias_map:
            schema, table = alias_map[key]
        else:
            schemas = _get_schemas(qualifier)
            if len(schemas) == 1:
                schema, table = schemas[0], qualifier
    else:
        physical = _physical_tables(alias_map)
        if len(physical) == 1:
            schema, table = physical[0]

    if schema and table:
        remarks = _get_remarks(schema, table)
        result = []
        for column, chinese in sorted(remarks.items()):
            result.append({
                "column": column, "field": column, "alias": "", "computed": False,
                "expr": f"{qualifier}.*" if qualifier else "*",
                "chinese": chinese, "source": f"{schema}.{table}.{column}",
            })
        return result

    sub = _find_subquery(sql_clean, qualifier) if qualifier else None
    if sub:
        sub_tables = extract_tables(sub)
        sub_map = _build_alias_map(sub_tables)
        sub_cols = extract_output_columns(sub)
        sub_out, _ = _localize(sub_cols, sub_map, sub, cache)
        return sub_out

    return [{
        "column": "*", "alias": "", "computed": False,
        "expr": f"{qualifier}.*" if qualifier else "*",
        "chinese": "", "source": f"无法展开（{qualifier or '未知'}）",
    }]


def _localize(columns, alias_map, sql_clean, cache):
    out = []
    related = {}
    for c in columns:
        if c["star"]:
            out.extend(_expand_star(c, alias_map, sql_clean, cache))
            continue
        entry = {
            "column": c["column"], "field": c["alias"] or c["column"],
            "alias": c["alias"], "computed": c["computed"],
            "expr": c["expr"], "chinese": "", "source": "",
        }
        if c["computed"]:
            entry["chinese"] = c["alias"] or c["expr"]
            entry["source"] = "计算列"
        else:
            res = _resolve_column(c, alias_map)
            if res:
                schema, table, column = res
                remarks = _get_remarks(schema, table)
                entry["chinese"] = remarks.get(column.upper(), "")
                entry["source"] = f"{schema}.{table}.{column}"
                related[(schema.upper(), table.upper())] = (schema, table)
            else:
                entry["chinese"] = c["alias"] or c["column"]
                entry["source"] = "无法定位"
        out.append(entry)
    return out, list(related.values())


# ---------------------------------------------------------------------------
# 参数表 -> 入参/出参/关联表
# ---------------------------------------------------------------------------

def _format_input_params(params):
    """把参数表 in 参数转成展示文本列表"""
    lines = []
    for p in params:
        name = (p.get("PARAM_NAME") or "").strip() or "-"
        desc = (p.get("PARAM_DESC") or "").strip()
        required = (p.get("REQUIRED") or "").strip().upper()
        req = "必填" if required == "Y" else ""
        parts = [name]
        if desc:
            parts.append(f"({desc})")
        if req:
            parts.append(f"[{req}]")
        lines.append(" ".join(parts))
    return lines


def _param_out_columns(params):
    """把参数表 out 参数转成出参条目（尽量汉化）"""
    cols = []
    for p in params:
        field = (p.get("PARAM_NAME") or "").strip() or (p.get("FIELD_NAME") or "").strip()
        field_name = (p.get("FIELD_NAME") or "").strip()
        from_table = (p.get("FROM_TABLE") or "").strip()
        desc = (p.get("PARAM_DESC") or "").strip()
        chinese = desc
        source = "参数表"
        if not chinese and field_name and from_table:
            schemas = _get_schemas(from_table)
            if len(schemas) == 1:
                remarks = _get_remarks(schemas[0], from_table)
                chinese = remarks.get(field_name.upper(), "")
                source = f"{schemas[0]}.{from_table}.{field_name}"
        cols.append({
            "field": field, "chinese": chinese or "-", "source": source,
        })
    return cols


def _param_related_tables(params):
    """从参数表 FROM_TABLE 汇总关联表（去重，裸表名反查 schema）"""
    tables = []
    for p in params:
        ft = (p.get("FROM_TABLE") or "").strip()
        if not ft:
            continue
        if "." in ft:
            if ft not in tables:
                tables.append(ft)
        else:
            schemas = _get_schemas(ft)
            if len(schemas) == 1:
                full = f"{schemas[0]}.{ft}"
                if full not in tables:
                    tables.append(full)
            else:
                if ft not in tables:
                    tables.append(ft)
    return tables


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def _fmt_detail(api, dims, input_params, out_columns, related_tables, similar_block=None):
    lines = []
    lines.append(f"API_ID   : {api.get('API_ID')}")
    lines.append(f"中文名   : {api.get('API_DESC')}")
    lines.append(f"英文名   : {api.get('API_NAME')}")
    lines.append(f"类型     : {api.get('API_TYPE')}")
    lines.append(f"状态     : {api.get('API_STATUS')}  上下架:{api.get('API_UPDOWN_STATUS')}  发布:{api.get('RELEASE_STATUS')}")
    lines.append(f"URL      : {api.get('API_URL')}")
    for name, val in dims:
        if val:
            lines.append(f"{name}   : {val}")
    lines.append("")
    lines.append("入参：")
    if input_params:
        for p in input_params:
            lines.append(f"  - {p}")
    else:
        lines.append("  （无）")
    lines.append("")
    lines.append("出参：")
    for c in out_columns:
        field = c.get("field") or c["column"]
        cn = c["chinese"] or "-"
        src = c.get("source") or "-"
        lines.append(f"  {field:<40} {cn:<24} [{src}]")
    lines.append("")
    if related_tables:
        lines.append("关联表：")
        for t in related_tables:
            lines.append(f"  - {t}")
    lines.append("")
    lines.append("血缘：")
    if similar_block:
        lines.append(similar_block)
    else:
        lines.append("  （无）")
    return "\n".join(lines)


def detail(api_id):
    api = get_api(api_id)
    if not api:
        print(f"未找到 API：{api_id}")
        return 1

    real_id = api.get("API_ID") or api_id
    params = get_params(real_id)

    # 入参：参数表 in 优先，SQL 解析兜底
    input_params = _format_input_params(params["in"])
    if not input_params:
        parsed = parse(api.get("API_SQL") or "")
        input_params = parsed["input_params"]

    # 出参：参数表 out 优先，SQL 解析兜底
    out_columns = _param_out_columns(params["out"])
    related_tables = []
    if out_columns:
        related_tables = _param_related_tables(params["in"] + params["out"])
    else:
        parsed = parse(api.get("API_SQL") or "")
        alias_map = _build_alias_map(parsed["tables"])
        cache = {}
        out_columns, _ = _localize(parsed["output_columns"], alias_map, parsed["sql_clean"], cache)
        related_tables = [f"{s}.{t}" for s, t in _physical_tables(alias_map) if s]

    dims = get_dims(api)

    similar_block = None
    try:
        from lineage_similar import find_similar, fmt_similar_brief
        _api, _tables, _common, sim_results = find_similar(real_id)
        similar_block = fmt_similar_brief(_tables, _common, sim_results)
    except Exception:
        similar_block = None

    print(_fmt_detail(api, dims, input_params, out_columns, related_tables, similar_block))
    print("")
    print("原始 SQL：")
    print(api.get("API_SQL") or "")
    return 0


def similar(api_id, top_n=10):
    """血缘相似 API 分析（委托 lineage_similar）"""
    from lineage_similar import find_similar, fmt_result
    api, tables, common, results = find_similar(api_id, top_n=top_n)
    if not api:
        print(f"未找到 API：{api_id}")
        return 1
    if not tables:
        print(f"API「{api.get('API_NAME')}」无血缘表数据。")
        return 1
    print(fmt_result(api, tables, common, results))
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    if cmd == "search" and len(sys.argv) >= 3:
        rows = search(sys.argv[2])
        print(f"共 {len(rows)} 个匹配 API：")
        for r in rows:
            print(f"{r['API_ID']}\t{r['API_DESC']}\t{r['API_NAME']}\t{r['API_TYPE']}\t{r['API_STATUS']}")
        return 0
    if cmd == "detail" and len(sys.argv) >= 3:
        return detail(sys.argv[2])
    if cmd == "similar" and len(sys.argv) >= 3:
        return similar(sys.argv[2])
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())

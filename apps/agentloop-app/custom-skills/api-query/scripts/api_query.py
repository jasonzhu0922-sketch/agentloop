#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
api_query.py - API 查询编排 CLI（数据源对齐前端：主表 T_ODS_TBEDM11）

用法：
    python3 api_query.py search <关键词>              # 按中文名/英文名/描述/API_ID 模糊检索
    python3 api_query.py detail <API_ID>             # 输出用途 + 入参 + 出参(汉化) + 关联表

依赖同目录下的 query_api.py 与 parse_sql.py。

数据口径（与前端一致）：
    - 主表     : BSTAMOBWSD.T_ODS_TBEDM11（API主表）
    - 关联表   : T_ODS_TBEDM11.EXPAND_COL 里的 JSON（tableEname 字段），为空时回退解析 SQL
    - 逻辑 SQL : T_ODS_TBEDM11.API_SQL，为空时回退 T_ODS_TBEXY31.EXECUTE_SQL
    - 汉化     : SYSCAT.COLUMNS.REMARKS（建表注释）
"""

import json
import os
import re
import sys
from hashlib import sha256

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from query_api import query_dicts, query_columns_remarks, find_schema, ApiError  # noqa: E402
from parse_sql import parse, extract_tables, extract_output_columns  # noqa: E402

# 主表（API主表）与 31表（数据API目录，SQL 兜底）
T_MAIN = "BSTAMOBWSD.T_ODS_TBEDM11"
T_XY31 = "BSTAMOBWSD.T_ODS_TBEXY31"

_MAIN_COLS = (
    "API_ID, API_NAME, API_CNAME, API_DESC, API_TYPE, "
    "API_STATUS, RELEASE_STATUS, API_URL"
)


def search(keyword, limit=50):
    """按关键词模糊检索 API（API主表）"""
    kw = keyword.replace("'", "''")
    cond = (
        f"where (API_CNAME like '%{kw}%' or API_NAME like '%{kw}%' "
        f"or API_DESC like '%{kw}%' or API_ID like '%{kw}%') "
        f"and TRIM(API_ID) <> ''"
    )
    return query_dicts(f"select {_MAIN_COLS} from {T_MAIN} {cond}", limit=limit)


def get_api(api_id):
    """取某 API 的元数据 + API_SQL + EXPAND_COL（API_SQL 为空时回退 31表）"""
    api_id_esc = api_id.replace("'", "''")
    rows = query_dicts(
        f"select {_MAIN_COLS}, API_SQL, EXPAND_COL from {T_MAIN} "
        f"where API_ID = '{api_id_esc}'"
    )
    if not rows:
        return None
    api = rows[0]
    sql = api.get("API_SQL") or ""
    if not sql or not sql.strip():
        fb = query_dicts(
            f"select EXECUTE_SQL from {T_XY31} where API_ID = '{api_id_esc}'"
        )
        if fb and (fb[0].get("EXECUTE_SQL") or "").strip():
            api["API_SQL"] = fb[0]["EXECUTE_SQL"]
    return api


def parse_expand_col(text):
    """解析 EXPAND_COL（JSON 数组），返回表清单 ["schema.table", ...]"""
    if not text or not text.strip():
        return []
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    tables = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                te = item.get("tableEname") or ""
                for part in te.split(","):
                    part = part.replace('"', "").replace("'", "").strip()
                    if part and part not in tables:
                        tables.append(part)
    return tables


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
# 输出
# ---------------------------------------------------------------------------

def _fmt_detail(api, out_columns, related_tables, input_params):
    lines = []
    lines.append(f"API_ID   : {api.get('API_ID')}")
    lines.append(f"中文名   : {api.get('API_CNAME')}")
    lines.append(f"英文名   : {api.get('API_NAME')}")
    lines.append(f"描述     : {api.get('API_DESC')}")
    lines.append(f"类型     : {api.get('API_TYPE')}")
    lines.append(f"状态     : {api.get('API_STATUS')}  发布:{api.get('RELEASE_STATUS')}")
    lines.append(f"URL      : {api.get('API_URL')}")
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
        src = c["source"] or "-"
        lines.append(f"  {field:<40} {cn:<20} [{src}]")
    lines.append("")
    if related_tables:
        lines.append("关联表：")
        for t in related_tables:
            lines.append(f"  - {t}")
    return "\n".join(lines)


def detail_payload(api_id):
    api = get_api(api_id)
    if not api:
        return None

    sql = api.get("API_SQL") or ""
    parsed = parse(sql)
    alias_map = _build_alias_map(parsed["tables"])
    cache = {}
    out_columns, sql_tables = _localize(parsed["output_columns"], alias_map, parsed["sql_clean"], cache)

    # 关联表：EXPAND_COL JSON 优先，SQL 解析兜底
    related_tables = parse_expand_col(api.get("EXPAND_COL"))
    if not related_tables:
        related_tables = [f"{s}.{t}" for s, t in _physical_tables(alias_map) if s]

    return {
        "api_id": api.get("API_ID"),
        "api_name": api.get("API_NAME"),
        "api_cname": api.get("API_CNAME"),
        "api_desc": api.get("API_DESC"),
        "api_type": api.get("API_TYPE"),
        "api_status": api.get("API_STATUS"),
        "release_status": api.get("RELEASE_STATUS"),
        "api_url": api.get("API_URL"),
        "input_params": parsed["input_params"],
        "output_columns": out_columns,
        "related_tables": related_tables,
        "sql_sha256": sha256(sql.encode("utf-8")).hexdigest() if sql else "",
        "sql_preview": sql[:1200],
    }


def detail(api_id):
    payload = detail_payload(api_id)
    if not payload:
        print(f"未找到 API：{api_id}")
        return 1

    api = {
        "API_ID": payload["api_id"],
        "API_NAME": payload["api_name"],
        "API_CNAME": payload["api_cname"],
        "API_DESC": payload["api_desc"],
        "API_TYPE": payload["api_type"],
        "API_STATUS": payload["api_status"],
        "RELEASE_STATUS": payload["release_status"],
        "API_URL": payload["api_url"],
    }
    print(_fmt_detail(api, payload["output_columns"], payload["related_tables"], payload["input_params"]))
    print("")
    print("原始 SQL：")
    full = get_api(api_id)
    print((full or {}).get("API_SQL") or "")
    return 0


def _match_score(row, keyword):
    text = " ".join(str(row.get(k) or "") for k in ("API_CNAME", "API_NAME", "API_DESC", "API_ID"))
    cname = str(row.get("API_CNAME") or "")
    score = 0
    if keyword and cname == keyword:
        score += 120
    if keyword and keyword in cname:
        score += 90
    if keyword and keyword in text:
        score += 30
    if re.search(r"(记录|明细|查询|详情)", cname):
        score += 25
    if str(row.get("RELEASE_STATUS")) == "1":
        score += 10
    if re.search(r"(统计|态势|分中心|审核量|总量|基本情况)", cname):
        score -= 20
    return score


def _search_ranked(keyword, limit):
    rows = search(keyword, limit=limit)
    return sorted(rows, key=lambda row: (-_match_score(row, keyword), str(row.get("API_ID") or "")))


def _param_rows(api_ids):
    if not api_ids:
        return []
    escaped = [api_id.replace("'", "''") for api_id in api_ids]
    quoted = ",".join(f"'{api_id}'" for api_id in escaped)
    sql = (
        "SELECT API_ID, PARAM_NAME, PARAM_TYPE, FIELD_NAME, FIELD_CNAME, "
        "FROM_TABLE, REQUIRED, OPERATOR, PARAM_DESC "
        f"FROM BSTAMOBWSD.T_ODS_TBEDM12 WHERE API_ID IN ({quoted}) "
        "ORDER BY API_ID, PARAM_TYPE, PARAM_NAME"
    )
    try:
        return query_dicts(sql, limit=1000)
    except ApiError:
        return []


def _params_by_api(rows):
    grouped = {}
    for row in rows:
        grouped.setdefault(row.get("API_ID"), []).append(row)
    return grouped


def _field_label(column):
    return column.get("chinese") or column.get("field") or column.get("column") or "-"


def _registered_inputs(param_rows):
    inputs = []
    for row in param_rows:
        if str(row.get("PARAM_TYPE") or "").lower() != "in":
            continue
        inputs.append({
            "name": row.get("PARAM_NAME") or row.get("FIELD_NAME") or "",
            "field": row.get("FIELD_NAME") or "",
            "required": str(row.get("REQUIRED") or "").upper() == "Y",
            "description": row.get("PARAM_DESC") or row.get("FIELD_CNAME") or "",
            "operator": row.get("OPERATOR") or "",
        })
    return inputs


def _markdown_for_api(item, index, primary=False):
    title = item["api_cname"] or item["api_name"] or item["api_id"]
    lines = []
    suffix = "（最直接匹配）" if primary else ""
    lines.append(f"## {index}. {title}{suffix}")
    lines.append("")
    lines.append(f"- **API ID**：`{item['api_id']}`")
    lines.append(f"- **英文标识**：`{item['api_name']}`")
    lines.append(f"- **发布状态**：`{item['release_status']}` / `{item['api_status']}`")
    if item.get("api_desc"):
        lines.append(f"- **用途**：{item['api_desc']}")
    if item.get("related_tables"):
        lines.append("- **关联表**：")
        for table in item["related_tables"][:8]:
            lines.append(f"  - `{table}`")
    inputs = item.get("registered_inputs") or []
    if not inputs and item.get("input_params"):
        inputs = [{"name": name, "required": None, "description": ""} for name in item["input_params"]]
    lines.append("")
    lines.append("### 入参")
    lines.append("")
    if inputs:
        lines.append("| 参数名 | 必填 | 说明 |")
        lines.append("|---|---:|---|")
        for param in inputs:
            required = "是" if param.get("required") is True else ("否" if param.get("required") is False else "-")
            desc = param.get("description") or param.get("field") or "-"
            lines.append(f"| `{param.get('name')}` | {required} | {desc} |")
    else:
        lines.append("无显式入参。")
    lines.append("")
    lines.append("### 出参")
    lines.append("")
    output_columns = item.get("output_columns") or []
    if output_columns:
        lines.append("| 字段名 | 中文说明 |")
        lines.append("|---|---|")
        for column in output_columns[:40]:
            field = column.get("field") or column.get("column") or "-"
            lines.append(f"| `{field}` | {_field_label(column)} |")
        if len(output_columns) > 40:
            lines.append(f"| ... | 另有 {len(output_columns) - 40} 个字段，详见结构化证据 |")
    else:
        lines.append("目录未登记明确出参。")
    return "\n".join(lines)


def _delivery_markdown(keyword, details):
    lines = [
        f"已按 **api-query** 技能，通过宝武数据中台通用 SQL API 以关键词“{keyword}”检索，命中 **{len(details)} 个 normal 状态接口**。",
    ]
    if details:
        lines.append(f"最直接匹配的是“{details[0]['api_cname'] or details[0]['api_name']}”。")
    lines.append("")
    for index, item in enumerate(details, 1):
        lines.append(_markdown_for_api(item, index, primary=index == 1))
        if index != len(details):
            lines.append("")
            lines.append("---")
            lines.append("")
    return "\n".join(lines)


def _evidence_receipt(keyword, details, assessment_projection):
    source_refs = [
        {
            "kind": "api_endpoint",
            "url": "https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT",
            "data_domain": "SZ_IBM-DB2",
        },
        {
            "kind": "catalog_table",
            "table": T_MAIN,
            "role": "api_catalog",
        },
        {
            "kind": "catalog_table",
            "table": "BSTAMOBWSD.T_ODS_TBEDM12",
            "role": "parameter_catalog",
        },
    ]
    source_refs.extend(
        {
            "kind": "api_catalog_entry",
            "api_id": item["api_id"],
            "api_cname": item.get("api_cname"),
            "api_name": item.get("api_name"),
            "related_tables": item.get("related_tables") or [],
        }
        for item in details
    )
    facts = [
        {
            "kind": "source_summary",
            "query": keyword,
            "match_count": len(details),
            "primary_api_id": assessment_projection["primary_api_id"],
            "api_ids": assessment_projection["api_ids"],
            "registered_param_row_count": assessment_projection["registered_param_row_count"],
            "output_field_counts": assessment_projection["output_field_counts"],
            "related_tables": assessment_projection["related_tables"],
        }
    ]
    caveats = [
        "API catalog matches are ranked by registered metadata and parsed SQL; confirm with an exact API_ID when the requested Chinese name is not an exact catalog name.",
        "Computed SQL expressions may not map to physical column remarks and are labeled from aliases or parser output.",
    ]
    material = json.dumps(
        {"sourceRefs": source_refs, "facts": facts, "caveats": caveats},
        ensure_ascii=False,
        sort_keys=True,
    )
    return {
        "schema": "agentloop.toolEvidenceReceipt/v1",
        "sourceType": "api_catalog",
        "receiptId": sha256(material.encode("utf-8")).hexdigest(),
        "sourceRefs": source_refs,
        "facts": facts,
        "caveats": caveats,
        "evidenceKinds": {
            "satisfied": ["source_summary", "source_urls", "source_refs"],
            "caveated": ["explicit_caveats"],
            "failed": [],
        },
    }


def answer_payload(keyword, limit=10):
    matches = [row for row in _search_ranked(keyword, limit) if row.get("API_STATUS") == "normal"]
    api_ids = [row.get("API_ID") for row in matches if row.get("API_ID")]
    param_rows = _param_rows(api_ids)
    params_by_api = _params_by_api(param_rows)
    details = []
    for row in matches:
        api_id = row.get("API_ID")
        if not api_id:
            continue
        payload = detail_payload(api_id)
        if payload is None:
            continue
        payload["registered_params"] = params_by_api.get(api_id, [])
        payload["registered_inputs"] = _registered_inputs(payload["registered_params"])
        details.append(payload)
    markdown = _delivery_markdown(keyword, details)
    assessment_projection = {
        "query": keyword,
        "match_count": len(details),
        "primary_api_id": details[0]["api_id"] if details else None,
        "api_ids": [item["api_id"] for item in details],
        "registered_param_row_count": len(param_rows),
        "output_field_counts": {item["api_id"]: len(item.get("output_columns") or []) for item in details},
        "related_tables": {item["api_id"]: item.get("related_tables", []) for item in details},
    }
    evidence_receipt = _evidence_receipt(keyword, details, assessment_projection)
    return {
        "schema": "api_catalog_result/v1",
        "query": keyword,
        "status": "ok",
        "matches": [
            {
                "api_id": row.get("API_ID"),
                "api_cname": row.get("API_CNAME"),
                "api_name": row.get("API_NAME"),
                "api_type": row.get("API_TYPE"),
                "api_status": row.get("API_STATUS"),
                "release_status": row.get("RELEASE_STATUS"),
                "score": _match_score(row, keyword),
            }
            for row in matches
        ],
        "apis": details,
        "delivery_markdown": markdown,
        "assessment_summary": assessment_projection,
        "evidenceReceipt": evidence_receipt,
        "deliveryCandidate": {
            "output": markdown,
            "format": "markdown",
        },
        "assessmentProjection": assessment_projection,
    }


def answer(keyword, output_format="markdown", limit=10):
    payload = answer_payload(keyword, limit=limit)
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(payload["delivery_markdown"])
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    if cmd == "search" and len(sys.argv) >= 3:
        for r in search(sys.argv[2]):
            print(f"{r['API_ID']}\t{r['API_CNAME']}\t{r['API_NAME']}\t{r['API_TYPE']}\t{r['API_STATUS']}")
        return 0
    if cmd == "detail" and len(sys.argv) >= 3:
        return detail(sys.argv[2])
    if cmd == "answer" and len(sys.argv) >= 3:
        output_format = "markdown"
        limit = 10
        args = sys.argv[3:]
        if "--format" in args:
            idx = args.index("--format")
            if idx + 1 < len(args):
                output_format = args[idx + 1]
        if "--limit" in args:
            idx = args.index("--limit")
            if idx + 1 < len(args):
                limit = int(args[idx + 1])
        return answer(sys.argv[2], output_format=output_format, limit=limit)
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())

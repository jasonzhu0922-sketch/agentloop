#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only query CLI for dimension, fact and ER models.

Usage:
  python3 model_query.py search <keyword>
  python3 model_query.py detail <model UUID | English name | Chinese name>
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from data_platform_config import load_config

TABLE = "BSTAMOBWSD.T_ODS_TBEDG2101"
FIELD = "BSTAMOBWSD.T_ODS_TBEDG2102"
LINEAGE = "BSTAMOBWSD.T_ODS_TBEDG91"
MODEL_RELATION = "BSTAMOBWSD.T_ODS_TBEDF5202"
ER_RELATION = "BSTAMOBWSD.T_ODS_TBEDF5211"
MODEL_TABLES = {
    "dimension": "BSTAMOBWSD.T_ODS_TBEDF5203",
    "fact": "BSTAMOBWSD.T_ODS_TBEDF5204",
    "er": "BSTAMOBWSD.T_ODS_TBEDF5209",
}


class QueryError(RuntimeError):
    pass


def quote(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def query(sql: str, *, limit: int = 10000) -> list[dict]:
    if not re.match(r"^\s*(select|with)\b", sql, re.I):
        raise QueryError("只允许 SELECT/WITH 查询")
    try:
        configuration = load_config()
    except ValueError as exc:
        raise QueryError(str(exc)) from exc
    client_id = configuration["DAM_TEST_CLIENT_ID"]
    client_secret = configuration["DAM_TEST_CLIENT_SECRET"]
    payload = {"clientId": client_id, "clientSecret": client_secret, "sql": sql, "showCount": "true", "offset": "0", "limit": "10000"}
    request = urllib.request.Request(configuration["DAM_TEST_SQL_ENDPOINT"], data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        raise QueryError(f"SQL 接口访问失败：{exc}") from exc
    status, info = (body.get("__sys__") or {}).get("status"), body.get("__sys__") or {}
    result = ((body.get("__blocks__") or {}).get("result") or {})
    columns = [item.get("name", "") for item in ((result.get("meta") or {}).get("columns") or [])]
    if status != 1:
        if re.search(r"空|empty|no result|not found", str(info.get("msg") or ""), re.I):
            return []
        raise QueryError(str(info.get("msg") or "SQL 接口返回失败"))
    return [dict(zip(columns, row)) if not isinstance(row, dict) else row for row in result.get("rows") or []]


def all_models(keyword: str = "") -> list[dict]:
    rows = []
    predicate = ""
    if keyword:
        value = quote("%" + keyword + "%")
        predicate = f" WHERE UUID LIKE {value} OR MODEL_ENAME LIKE {value} OR MODEL_CNAME LIKE {value} OR MODEL_DESC LIKE {value}"
    for kind, table in MODEL_TABLES.items():
        for row in query(f"SELECT * FROM {table}{predicate}"):
            row["MODEL_TYPE"] = kind
            rows.append(row)
    return rows


def search(keyword: str) -> list[dict]:
    return all_models(keyword)


def get_model(value: str) -> dict | None:
    for row in all_models(value):
        if value in {str(row.get("UUID") or ""), str(row.get("MODEL_ENAME") or ""), str(row.get("MODEL_CNAME") or "")}:
            return row
    return None


def model_tables(model_uuid: str) -> list[dict]:
    return query(
        "SELECT UUID, GUID, TABLE_ENAME, TABLE_CNAME, TABLE_DESC, MODEL_UUID, "
        "TABLE_STATE, DESIGN_TYPE, SAFETY_CODE_RANK "
        f"FROM {TABLE} WHERE MODEL_UUID = {quote(model_uuid)}",
        limit=10000,
    )


def table_fields(table_uuid: str) -> list[dict]:
    return query(
        "SELECT UUID, FIELD_ENAME, MEMO AS FIELD_CNAME, FIELD_TYPE, FIELD_LEN, "
        "DECIMAL_LEN, IS_NULL, FIELD_DESC, IS_PK, REF_TABLE_UUID, REF_TABLE_FIELD_UUID "
        f"FROM {FIELD} WHERE TABLE_UUID = {quote(table_uuid)} ORDER BY FIELD_SORT",
        limit=10000,
    )


def table_lineage(table: dict) -> dict:
    ids = [v for v in (table.get("UUID"), table.get("GUID")) if v]
    values = ", ".join(quote(v) for v in ids)
    edges = query(f"SELECT SRC_TABLE_GUID, DEST_TABLE_GUID FROM {LINEAGE} WHERE SRC_TABLE_GUID IN ({values}) OR DEST_TABLE_GUID IN ({values})")
    endpoints = sorted({str(edge[key]).strip() for edge in edges for key in ("SRC_TABLE_GUID", "DEST_TABLE_GUID") if edge.get(key)})
    names: dict[str, dict] = {}
    if endpoints:
        endpoint_values = ", ".join(quote(v) for v in endpoints)
        for row in query(f"SELECT UUID, GUID, TABLE_ENAME, TABLE_CNAME FROM {TABLE} WHERE UUID IN ({endpoint_values}) OR GUID IN ({endpoint_values})"):
            for key in (row.get("UUID"), row.get("GUID")):
                if key:
                    names[str(key).strip()] = row
    own = {str(value).strip() for value in ids}
    upstream, downstream = [], []
    for edge in edges:
        source, target = str(edge.get("SRC_TABLE_GUID") or "").strip(), str(edge.get("DEST_TABLE_GUID") or "").strip()
        if target in own and source in names:
            upstream.append(names[source])
        if source in own and target in names:
            downstream.append(names[target])
    return {"upstream": dedupe(upstream), "downstream": dedupe(downstream)}


def model_relations(model: dict) -> dict:
    model_uuid = quote(model["UUID"])
    if model["MODEL_TYPE"] == "er":
        return {"er_categories": query(
            f"SELECT UUID, ER_UUID, CATEGORY_UUID FROM {ER_RELATION} WHERE ER_UUID = {model_uuid}",
        )}
    return {"dimension_fact_relations": query(
        f"SELECT UUID, NODE_UUID, DIMENSION_UUID, FACT_UUID, OBJECT_UUID FROM {MODEL_RELATION} "
        f"WHERE DIMENSION_UUID = {model_uuid} OR FACT_UUID = {model_uuid}",
    )}


def dedupe(rows: list[dict]) -> list[dict]:
    seen, result = set(), []
    for row in rows:
        key = row.get("UUID")
        if key not in seen:
            seen.add(key)
            result.append(row)
    return result


def detail(value: str) -> dict | None:
    model = get_model(value)
    if not model:
        return None
    tables = model_tables(model["UUID"])
    return {
        "model": model,
        "tables": [{"table": table, "fields": table_fields(table["UUID"]), "lineage": table_lineage(table)} for table in tables],
        "relations": model_relations(model),
        "association_note": "模型与表按 T_ODS_TBEDG2101.MODEL_UUID 关联；维度/事实关系来自 T_ODS_TBEDF5202，ER 类目关系来自 T_ODS_TBEDF5211。",
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in {"search", "detail"}:
        print(__doc__.strip())
        return 2
    result = search(argv[2]) if argv[1] == "search" else detail(argv[2])
    if result is None:
        print(json.dumps({"error": f"未找到模型：{argv[2]}"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except QueryError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)

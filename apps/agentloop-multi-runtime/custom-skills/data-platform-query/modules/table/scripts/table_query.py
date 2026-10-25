#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only table metadata, field and lineage query CLI.

Usage:
  python3 table_query.py search <keyword>
  python3 table_query.py detail <table UUID | English name | Chinese name>
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


class QueryError(RuntimeError):
    pass


def quote(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def query(sql: str, *, offset: int = 0, limit: int = 10000) -> list[dict]:
    if not re.match(r"^\s*(select|with)\b", sql, re.I):
        raise QueryError("只允许 SELECT/WITH 查询")
    try:
        configuration = load_config()
    except ValueError as exc:
        raise QueryError(str(exc)) from exc
    client_id = configuration["DAM_TEST_CLIENT_ID"]
    client_secret = configuration["DAM_TEST_CLIENT_SECRET"]
    payload = {
        "clientId": client_id,
        "clientSecret": client_secret,
        "sql": sql,
        "showCount": "true",
        "offset": "0",
        "limit": "10000",
    }
    request = urllib.request.Request(
        configuration["DAM_TEST_SQL_ENDPOINT"],
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        raise QueryError(f"SQL 接口访问失败：{exc}") from exc
    status = (body.get("__sys__") or {}).get("status")
    message = str((body.get("__sys__") or {}).get("msg") or "")
    result = ((body.get("__blocks__") or {}).get("result") or {})
    cols = [c.get("name", "") for c in ((result.get("meta") or {}).get("columns") or [])]
    if status != 1:
        if re.search(r"空|empty|no result|not found", message, re.I):
            return []
        raise QueryError(message or "SQL 接口返回失败")
    return [dict(zip(cols, row)) if not isinstance(row, dict) else row for row in result.get("rows") or []]


def search(keyword: str, *, limit: int = 10000) -> list[dict]:
    kw = quote("%" + keyword + "%")
    return query(
        "SELECT UUID, GUID, TABLE_ENAME, TABLE_CNAME, TABLE_DESC, MODEL_UUID, "
        "TABLE_STATE, DESIGN_TYPE, SAFETY_CODE_RANK, UPDATE_TIME "
        f"FROM {TABLE} WHERE TABLE_ENAME LIKE {kw} OR TABLE_CNAME LIKE {kw} "
        f"OR TABLE_DESC LIKE {kw} OR UUID LIKE {kw}",
        limit=limit,
    )


def get_table(value: str) -> dict | None:
    escaped = quote(value)
    for condition in (
        f"UUID = {escaped}",
        f"TABLE_ENAME = {escaped}",
        f"TABLE_CNAME = {escaped}",
    ):
        rows = query(f"SELECT * FROM {TABLE} WHERE {condition}")
        if rows:
            return rows[0]
    return None


def get_fields(table_uuid: str) -> list[dict]:
    return query(
        "SELECT UUID, FIELD_ENAME, MEMO AS FIELD_CNAME, FIELD_TYPE, FIELD_LEN, "
        "DECIMAL_LEN, IS_NULL, DEF_VALUE, FIELD_DESC, IS_PK, IS_PARTITION, "
        "SAFETY_CODE_RANK, ENCRYPT, DATA_ELEMENT, REF_TABLE_UUID, REF_TABLE_FIELD_UUID "
        f"FROM {FIELD} WHERE TABLE_UUID = {quote(table_uuid)} ORDER BY FIELD_SORT",
        limit=10000,
    )


def get_lineage(table: dict) -> dict:
    identifiers = [v for v in (table.get("UUID"), table.get("GUID")) if v]
    values = ", ".join(quote(v) for v in identifiers)
    edges = query(
        "SELECT UUID_ODS, SRC_TABLE_GUID, DEST_TABLE_GUID, RELATION_SRC_TYPE, TASK_TYPE "
        f"FROM {LINEAGE} WHERE SRC_TABLE_GUID IN ({values}) OR DEST_TABLE_GUID IN ({values})",
        limit=10000,
    )
    endpoint_ids = sorted({str(e[k]).strip() for e in edges for k in ("SRC_TABLE_GUID", "DEST_TABLE_GUID") if e.get(k)})
    nodes: dict[str, dict] = {}
    if endpoint_ids:
        endpoints = ", ".join(quote(v) for v in endpoint_ids)
        for row in query(
            "SELECT UUID, GUID, TABLE_ENAME, TABLE_CNAME, TABLE_DESC, MODEL_UUID "
            f"FROM {TABLE} WHERE UUID IN ({endpoints}) OR GUID IN ({endpoints})",
            limit=10000,
        ):
            for key in (row.get("UUID"), row.get("GUID")):
                if key:
                    nodes[str(key).strip()] = row
    current = {str(v).strip() for v in identifiers}
    upstream, downstream, unresolved = [], [], []
    for edge in edges:
        source, target = str(edge.get("SRC_TABLE_GUID") or "").strip(), str(edge.get("DEST_TABLE_GUID") or "").strip()
        if target in current:
            (upstream if source in nodes else unresolved).append(nodes.get(source) or {"node_id": source, "direction": "upstream"})
        if source in current:
            (downstream if target in nodes else unresolved).append(nodes.get(target) or {"node_id": target, "direction": "downstream"})
    return {"upstream": unique(upstream), "downstream": unique(downstream), "unresolved": unique(unresolved)}


def unique(rows: list[dict]) -> list[dict]:
    result, seen = [], set()
    for row in rows:
        key = row.get("UUID") or row.get("GUID") or row.get("node_id")
        if key not in seen:
            seen.add(key)
            result.append(row)
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in {"search", "detail"}:
        print(__doc__.strip())
        return 2
    if argv[1] == "search":
        print(json.dumps(search(argv[2]), ensure_ascii=False, indent=2))
        return 0
    table = get_table(argv[2])
    if not table:
        print(json.dumps({"error": f"未找到数据表：{argv[2]}"}, ensure_ascii=False))
        return 1
    print(json.dumps({"table": table, "fields": get_fields(table["UUID"]), "lineage": get_lineage(table)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except QueryError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)

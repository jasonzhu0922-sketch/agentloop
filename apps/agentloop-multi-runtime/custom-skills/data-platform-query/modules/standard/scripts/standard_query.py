#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only query CLI for data classifications, business objects and data elements.

Usage:
  python3 standard_query.py search <classification|business-object|data-element> <keyword>
  python3 standard_query.py detail <classification|business-object|data-element> <UUID>
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

CLASSIFICATION = "BSTAMOBWSD.T_ODS_TBEDF32"
BUSINESS_OBJECT = "BSTAMOBWSD.T_ODS_TBEDF15"
DATA_ELEMENT = "BSTAMOBWSD.T_ODS_TBEDF12"
TABLE_FIELD = "BSTAMOBWSD.T_ODS_TBEDG2102"
TABLE = "BSTAMOBWSD.T_ODS_TBEDG2101"
KINDS = {"classification", "business-object", "data-element"}


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
    info, result = body.get("__sys__") or {}, ((body.get("__blocks__") or {}).get("result") or {})
    columns = [item.get("name", "") for item in ((result.get("meta") or {}).get("columns") or [])]
    if info.get("status") != 1:
        if re.search(r"空|empty|no result|not found", str(info.get("msg") or ""), re.I):
            return []
        raise QueryError(str(info.get("msg") or "SQL 接口返回失败"))
    return [dict(zip(columns, row)) if not isinstance(row, dict) else row for row in result.get("rows") or []]


def search(kind: str, keyword: str) -> list[dict]:
    kw = quote("%" + keyword + "%")
    if kind == "classification":
        return query("SELECT UUID, AREA_ID, AREA_NAME, PARENT_AREA_ID, DATA_LEVEL, AREA_CODE, AREA_TYPE, AREA_DESC, RELEASE_STATE " f"FROM {CLASSIFICATION} WHERE AREA_NAME LIKE {kw} OR AREA_ID LIKE {kw} OR AREA_CODE LIKE {kw} OR AREA_DESC LIKE {kw}")
    if kind == "business-object":
        return query("SELECT UUID, OBJECT_ENAME, OBJECT_CNAME, OBJECT_DESC, OBJECT_ALIAS, AREA_UUID, AREA_NAME, AREA_CODE, RELEASE_STATE " f"FROM {BUSINESS_OBJECT} WHERE OBJECT_ENAME LIKE {kw} OR OBJECT_CNAME LIKE {kw} OR OBJECT_DESC LIKE {kw} OR UUID LIKE {kw}")
    if kind == "data-element":
        return query("SELECT UUID, FIELD_ENAME, FIELD_CNAME, FIELD_DESC, FIELD_TYPE, FIELD_LENGTH, FIELD_RANGE, FIELD_FORMAT, OBJECT_UUID, OBJECT_CNAME, AREA_UUID, AREA_NAME, RELEASE_STATE " f"FROM {DATA_ELEMENT} WHERE FIELD_ENAME LIKE {kw} OR FIELD_CNAME LIKE {kw} OR FIELD_DESC LIKE {kw} OR UUID LIKE {kw}")
    raise QueryError(f"不支持的标准类型：{kind}")


def detail(kind: str, uuid: str) -> dict | None:
    if kind == "classification":
        rows = query(f"SELECT * FROM {CLASSIFICATION} WHERE UUID = {quote(uuid)}")
        if not rows:
            return None
        item = rows[0]
        return {
            "classification": item,
            "children": query(f"SELECT UUID, AREA_ID, AREA_NAME, DATA_LEVEL, AREA_CODE, AREA_DESC FROM {CLASSIFICATION} WHERE PARENT_AREA_ID = {quote(item.get('AREA_ID') or '')}"),
            "business_objects": query(f"SELECT UUID, OBJECT_ENAME, OBJECT_CNAME, OBJECT_DESC, RELEASE_STATE FROM {BUSINESS_OBJECT} WHERE AREA_UUID = {quote(uuid)}"),
            "data_elements": query(f"SELECT UUID, FIELD_ENAME, FIELD_CNAME, FIELD_DESC, OBJECT_UUID, OBJECT_CNAME, RELEASE_STATE FROM {DATA_ELEMENT} WHERE AREA_UUID = {quote(uuid)}"),
        }
    if kind == "business-object":
        rows = query(f"SELECT * FROM {BUSINESS_OBJECT} WHERE UUID = {quote(uuid)}")
        if not rows:
            return None
        item = rows[0]
        area = query(f"SELECT UUID, AREA_ID, AREA_NAME, AREA_CODE, AREA_DESC FROM {CLASSIFICATION} WHERE UUID = {quote(item.get('AREA_UUID') or '')}")
        return {
            "business_object": item,
            "classification": area[0] if area else None,
            "data_elements": query(f"SELECT UUID, FIELD_ENAME, FIELD_CNAME, FIELD_DESC, FIELD_TYPE, FIELD_RANGE, FIELD_FORMAT, RELEASE_STATE FROM {DATA_ELEMENT} WHERE OBJECT_UUID = {quote(uuid)}"),
        }
    if kind == "data-element":
        rows = query(f"SELECT * FROM {DATA_ELEMENT} WHERE UUID = {quote(uuid)}")
        if not rows:
            return None
        item = rows[0]
        obj = query(f"SELECT UUID, OBJECT_ENAME, OBJECT_CNAME, OBJECT_DESC, AREA_UUID, AREA_NAME FROM {BUSINESS_OBJECT} WHERE UUID = {quote(item.get('OBJECT_UUID') or '')}")
        area = query(f"SELECT UUID, AREA_ID, AREA_NAME, AREA_CODE, AREA_DESC FROM {CLASSIFICATION} WHERE UUID = {quote(item.get('AREA_UUID') or '')}")
        fields = query(
            "SELECT f.UUID AS FIELD_UUID, f.FIELD_ENAME, f.MEMO AS FIELD_CNAME, f.FIELD_DESC, "
            "t.UUID AS TABLE_UUID, t.TABLE_ENAME, t.TABLE_CNAME "
            f"FROM {TABLE_FIELD} f JOIN {TABLE} t ON f.TABLE_UUID = t.UUID "
            f"WHERE f.DATA_ELEMENT = {quote(uuid)}",
        )
        return {
            "data_element": item,
            "business_object": obj[0] if obj else None,
            "classification": area[0] if area else None,
            "field_mappings": fields,
            "mapping_note": "字段映射仅返回 T_ODS_TBEDG2102.DATA_ELEMENT 精确等于数据元 UUID 的已登记关系；空结果不等同于数据元不存在。",
        }
    raise QueryError(f"不支持的标准类型：{kind}")


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] not in {"search", "detail"} or argv[2] not in KINDS:
        print(__doc__.strip())
        return 2
    result = search(argv[2], argv[3]) if argv[1] == "search" else detail(argv[2], argv[3])
    if result is None:
        print(json.dumps({"error": f"未找到{argv[2]}：{argv[3]}"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except QueryError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)

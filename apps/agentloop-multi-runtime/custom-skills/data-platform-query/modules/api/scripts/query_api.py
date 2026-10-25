#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Direct read-only client for the common SQL API."""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from data_platform_config import load_config

DEFAULT_LIMIT = 10000
TIMEOUT = 60


class ApiError(Exception):
    def __init__(self, msg, api_sql=None):
        self.msg = msg
        self.api_sql = api_sql
        super().__init__(msg)


_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$#]*$")


def _assert_ident(name, label):
    if not name or not _IDENT_RE.match(name):
        raise ApiError(f"非法标识符：{label}={name!r}")


def _quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def _normalize(body):
    """Normalize the endpoint's ``__sys__``/``__blocks__`` response."""
    body = body or {}
    if isinstance(body, dict) and "columns" in body and "rows" in body:
        return body
    info = body.get("__sys__") or {}
    result = ((body.get("__blocks__") or {}).get("result") or {})
    columns_meta = ((result.get("meta") or {}).get("columns") or [])
    columns = [c.get("name", "") if isinstance(c, dict) else str(c) for c in columns_meta]
    rows = result.get("rows") or []
    if info.get("status") != 1:
        message = f"{info.get('msg', '')} {info.get('detailMsg', '')}".strip()
        if not re.search(r"结果集为空|为空|empty|no result|not found", message, re.I):
            raise ApiError(f"查询失败：{message}", body.get("apiSql"))
        return {"columns": [], "rows": [], "count": 0, "api_sql": body.get("apiSql", "")}
    return {"columns": columns, "rows": rows, "count": int(body.get("resultCount") or len(rows)), "api_sql": body.get("apiSql", "")}


def query(sql, offset=0, limit=DEFAULT_LIMIT, timeout=TIMEOUT):
    """Execute a SELECT/WITH query using the shared direct HTTP envelope."""
    if not re.match(r"^\s*(select|with)\b", sql, re.I):
        raise ApiError("只允许 SELECT/WITH 查询")
    try:
        configuration = load_config()
    except ValueError as exc:
        raise ApiError(str(exc)) from exc
    payload = {
        "clientId": configuration["DAM_TEST_CLIENT_ID"],
        "clientSecret": configuration["DAM_TEST_CLIENT_SECRET"],
        "sql": sql,
        "showCount": "true",
        "offset": "0",
        "limit": "10000",
    }
    request = urllib.request.Request(configuration["DAM_TEST_SQL_ENDPOINT"], data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        raise ApiError(f"SQL 接口访问失败：{exc}") from exc
    return _normalize(body)


def query_dicts(sql, offset=0, limit=DEFAULT_LIMIT, timeout=TIMEOUT):
    result = query(sql, offset=offset, limit=limit, timeout=timeout)
    return [row if isinstance(row, dict) else dict(zip(result["columns"], row)) for row in result["rows"]]


def query_columns_remarks(schema, table):
    _assert_ident(schema, "schema")
    _assert_ident(table, "table")
    rows = query_dicts("SELECT COLNAME, REMARKS FROM SYSCAT.COLUMNS " f"WHERE TABNAME = {_quote(table)} AND TABSCHEMA = {_quote(schema)}")
    return {r["COLNAME"]: (r.get("REMARKS") or "").strip() for r in rows}


def find_schema(table):
    _assert_ident(table, "table")
    rows = query_dicts(f"SELECT DISTINCT TABSCHEMA FROM SYSCAT.TABLES WHERE TABNAME = {_quote(table)}")
    return [r["TABSCHEMA"].strip() for r in rows]


def _main():
    if len(sys.argv) >= 4 and sys.argv[1] == "--columns":
        for col, remark in sorted(query_columns_remarks(sys.argv[2], sys.argv[3]).items()):
            print(f"{col}\t{remark}")
        return
    sql = " ".join(sys.argv[1:])
    if not sql.strip():
        print(__doc__)
        return
    try:
        print(json.dumps(query(sql), ensure_ascii=False, indent=2))
    except ApiError as exc:
        print(f"ERROR: {exc.msg}", file=sys.stderr)
        if exc.api_sql:
            print(f"apiSql: {exc.api_sql}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    _main()

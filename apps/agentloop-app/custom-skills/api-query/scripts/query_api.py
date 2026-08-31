#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
query_api.py - 数智域通用 SQL API 客户端

调用宝武数据中台通用 SQL API：
    POST https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT
    Body: {"sql": "...", "clientId": "...", "clientSecret": "...", "offset": "0", "limit": "1000"}

返回结构：
    __sys__.status               1=成功, -1=失败
    __sys__.msg                  提示信息
    __blocks__.result.meta.columns   [{name, descName, type}]   (descName 恒为空)
    __blocks__.result.rows           [[...], ...]  (二维数组)
    resultCount                  行数(字符串)

注意：
    - API 会自动追加 "fetch first 1000 rows only"，SQL 里不要再写 fetch/limit
    - 分页用 body 的 offset(从0开始)/limit 参数
    - 底层是 DB2，查字段中文注释用 SYSCAT.COLUMNS.REMARKS

用法：
    python3 query_api.py "select ... from ..."
    python3 query_api.py --columns BSTAMSCW00 TAFTBC2
"""

import json
import os
import sys
import urllib.request

API_URL = "https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT"
CLIENT_ID = os.environ.get("EPLAT_CLIENT_ID", "bwssa")
CLIENT_SECRET = os.environ.get("EPLAT_CLIENT_SECRET", "4B13539D106BD64079BD1FF180D7BA37")
TIMEOUT = 120
DEFAULT_LIMIT = 1000


class ApiError(Exception):
    """API 调用失败"""

    def __init__(self, msg, api_sql=None):
        self.msg = msg
        self.api_sql = api_sql
        super().__init__(msg)


def query(sql, offset=0, limit=DEFAULT_LIMIT, timeout=TIMEOUT):
    """执行 SQL，返回 {"columns": [...], "rows": [[...]], "count": int, "api_sql": str}"""
    body = {
        "sql": sql,
        "clientId": CLIENT_ID,
        "clientSecret": CLIENT_SECRET,
        "offset": str(offset),
        "limit": str(limit),
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ApiError(f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:500]}")
    except Exception as e:
        raise ApiError(f"请求失败: {e}")

    status = data.get("__sys__", {}).get("status")
    msg = data.get("__sys__", {}).get("msg", "")
    if status != 1:
        # 结果集为空不算错误，返回空
        if "结果集为空" in msg:
            result = data.get("__blocks__", {}).get("result", {})
            columns = [c["name"] for c in result.get("meta", {}).get("columns", [])]
            return {"columns": columns, "rows": [], "count": 0, "api_sql": data.get("apiSql")}
        raise ApiError(msg, data.get("apiSql"))

    result = data.get("__blocks__", {}).get("result", {})
    columns = [c["name"] for c in result.get("meta", {}).get("columns", [])]
    rows = result.get("rows", [])
    try:
        count = int(data.get("resultCount", len(rows)))
    except (TypeError, ValueError):
        count = len(rows)
    return {"columns": columns, "rows": rows, "count": count, "api_sql": data.get("apiSql")}


def query_dicts(sql, offset=0, limit=DEFAULT_LIMIT, timeout=TIMEOUT):
    """执行 SQL，返回 [{col: val, ...}, ...] 列表"""
    res = query(sql, offset=offset, limit=limit, timeout=timeout)
    cols = res["columns"]
    return [dict(zip(cols, row)) for row in res["rows"]]


def query_columns_remarks(schema, table):
    """查询某表所有字段的中文注释，返回 {COLNAME: 中文注释}（注释为空则 value 为 ''）"""
    sql = (
        f"select COLNAME, REMARKS from SYSCAT.COLUMNS "
        f"where TABNAME = '{table}' and TABSCHEMA = '{schema}'"
    )
    rows = query_dicts(sql)
    return {r["COLNAME"]: (r["REMARKS"] or "").strip() for r in rows}


def find_schema(table):
    """裸表名反查 schema：同名多 schema 时返回列表，供调用方判断歧义"""
    sql = f"select distinct TABSCHEMA from SYSCAT.TABLES where TABNAME = '{table}'"
    rows = query_dicts(sql)
    return [r["TABSCHEMA"].strip() for r in rows]


def _main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--columns":
        schema, table = sys.argv[2], sys.argv[3]
        remarks = query_columns_remarks(schema, table)
        for col, remark in sorted(remarks.items()):
            print(f"{col}\t{remark}")
        return

    sql = " ".join(sys.argv[1:])
    if not sql.strip():
        print(__doc__)
        return
    try:
        res = query(sql)
    except ApiError as e:
        print(f"ERROR: {e.msg}", file=sys.stderr)
        if e.api_sql:
            print(f"apiSql: {e.api_sql}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _main()

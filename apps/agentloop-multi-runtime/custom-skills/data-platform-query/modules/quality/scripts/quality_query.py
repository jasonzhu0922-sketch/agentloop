#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only quality rule and quality task query CLI.

Usage:
  python3 quality_query.py rules <keyword>
  python3 quality_query.py rule-detail <UUID>
  python3 quality_query.py tasks <keyword>
  python3 quality_query.py task-detail <UUID>

Quality tasks are resolved through the verified chain:
T_ODS_TBEDD0506 (rule) -> T_ODS_TBEDD01 (quality step) ->
T_ODS_TBEDD0104 (task-step relation) -> T_ODS_TBEDD0101 (task).
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

RULE = "BSTAMOBWSD.T_ODS_TBEDD0506"
STEP = "BSTAMOBWSD.T_ODS_TBEDD01"
TASK_STEP = "BSTAMOBWSD.T_ODS_TBEDD0104"
TASK = "BSTAMOBWSD.T_ODS_TBEDD0101"


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


def rules(keyword: str) -> list[dict]:
    kw = quote("%" + keyword + "%")
    return query(
        "SELECT UUID, FIELD_ENAME, FIELD_CNAME, TABLE_NAME, TABLE_UUID, RULE_DESC, RULE_NAME, "
        "IS_ENABLE, PROJECT_NAME, RULE_TEMPLATE_NAME, TASK_EXECUTION_TYPE, QUALITY_CODE_CLASSIFY, "
        "RULE_TYPE, APPROVAL_STATUS, RULE_CATEGORY, STEP_UUID "
        f"FROM {RULE} WHERE RULE_NAME LIKE {kw} OR RULE_DESC LIKE {kw} OR TABLE_NAME LIKE {kw} "
        f"OR FIELD_ENAME LIKE {kw} OR FIELD_CNAME LIKE {kw} OR PROJECT_NAME LIKE {kw} OR UUID LIKE {kw}",
    )


def rule_detail(uuid: str) -> dict | None:
    rows = query(f"SELECT * FROM {RULE} WHERE UUID = {quote(uuid)}")
    if not rows:
        return None
    rule = rows[0]
    task_rows = query(
        "SELECT DISTINCT t.UUID AS TASK_UUID, t.TASK_NAME, t.PROJECT_NAME, s.UUID AS STEP_UUID, s.STEP_NAME "
        f"FROM {RULE} r JOIN {STEP} s ON r.STEP_UUID=s.UUID "
        f"JOIN {TASK_STEP} x ON s.UUID=x.STEP_UUID JOIN {TASK} t ON x.TASK_UUID=t.UUID "
        f"WHERE r.UUID={quote(uuid)}",
    )
    return {"rule": rule, "quality_tasks": task_rows}


def tasks(keyword: str) -> list[dict]:
    kw = quote("%" + keyword + "%")
    return query(
        "SELECT DISTINCT t.UUID AS TASK_UUID, t.TASK_NAME, t.PROJECT_NAME, t.STORAGE_POSITION, "
        "t.REC_CREATE_TIME, s.UUID AS STEP_UUID, s.STEP_NAME, r.UUID AS RULE_UUID, r.RULE_NAME, "
        "r.TABLE_NAME, r.IS_ENABLE, r.QUALITY_CODE_CLASSIFY "
        f"FROM {TASK} t JOIN {TASK_STEP} x ON t.UUID=x.TASK_UUID JOIN {STEP} s ON x.STEP_UUID=s.UUID "
        f"JOIN {RULE} r ON r.STEP_UUID=s.UUID WHERE t.TASK_NAME LIKE {kw} OR t.PROJECT_NAME LIKE {kw} "
        f"OR s.STEP_NAME LIKE {kw} OR r.RULE_NAME LIKE {kw} OR r.TABLE_NAME LIKE {kw} OR t.UUID LIKE {kw}",
    )


def task_detail(uuid: str) -> dict | None:
    rows = query(f"SELECT UUID AS TASK_UUID, TASK_NAME, UI_CONFIG, TASK_CONFIG, PROJECT_NAME, STORAGE_POSITION, REC_CREATE_TIME FROM {TASK} WHERE UUID = {quote(uuid)}")
    if not rows:
        return None
    task = rows[0]
    links = query(
        "SELECT s.UUID AS STEP_UUID, s.STEP_NAME, r.UUID AS RULE_UUID, r.RULE_NAME, r.TABLE_NAME, "
        "r.FIELD_ENAME, r.IS_ENABLE, r.QUALITY_CODE_CLASSIFY, r.APPROVAL_STATUS "
        f"FROM {TASK_STEP} x JOIN {STEP} s ON x.STEP_UUID=s.UUID JOIN {RULE} r ON r.STEP_UUID=s.UUID "
        f"WHERE x.TASK_UUID={quote(uuid)}",
    )
    return {"task": task, "quality_rules": links}


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in {"rules", "rule-detail", "tasks", "task-detail"}:
        print(__doc__.strip())
        return 2
    command, value = argv[1], argv[2]
    if command == "rules":
        result = rules(value)
    elif command == "rule-detail":
        result = rule_detail(value)
    elif command == "tasks":
        result = tasks(value)
    else:
        result = task_detail(value)
    if result is None:
        print(json.dumps({"error": f"未找到质量对象：{value}"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except QueryError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)

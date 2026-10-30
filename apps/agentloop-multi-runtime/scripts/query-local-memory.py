#!/usr/bin/env python3
"""Read-only inspection of the Local Agent Memory SQLite database.

Examples:
  python3 query-local-memory.py
  python3 query-local-memory.py --limit 20 --owner USER_ID
  python3 query-local-memory.py --db /path/to/memory.db --json
  python3 query-local-memory.py --all-revisions

The script never opens the database for writing and never runs the Local Agent
migrations.  It is intentionally independent of the running Agent process.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_DB = Path.home() / "Library/Application Support/AgentLoop Local Runtime/memory.db"
INSTALLED_APP = Path("/Applications/AgentLoop Local Runtime.app")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query persisted Local Agent experiences (read-only).")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"installed Local Runtime memory.db (default: {DEFAULT_DB})")
    parser.add_argument("--owner", help="only show one owner_user_id")
    parser.add_argument("--tenant", help="only show one tenant_id")
    parser.add_argument("--limit", type=int, default=20, help="maximum active experience records (default: 20)")
    parser.add_argument("--all-revisions", action="store_true", help="include superseded revisions, not just current active records")
    parser.add_argument("--json", action="store_true", dest="as_json", help="emit machine-readable JSON")
    return parser.parse_args()


def connect_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise SystemExit(f"Memory database not found: {path}\nStart/use the installed Local Agent once, or pass --db PATH.")
    # mode=ro prevents accidental migration or mutation.  The normal SQLite
    # WAL sidecar remains readable while the Local Agent is running.
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def installed_version() -> str | None:
    info = INSTALLED_APP / "Contents/Info.plist"
    if not info.is_file():
        return None
    try:
        with info.open("rb") as stream:
            plist = plistlib.load(stream)
        value = plist.get("CFBundleShortVersionString")
        return str(value) if value is not None else None
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None


def json_value(raw: str | None, fallback: Any = None) -> Any:
    if raw is None:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return fallback


def iso_ms(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc).astimezone().isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError):
        return str(value)


def first_nonempty(*values: Any) -> Any:
    for value in values:
        if value not in (None, "", [], {}):
            return value
    return None


def experience_view(row: sqlite3.Row) -> dict[str, Any]:
    value = json_value(row["value_json"], {}) or {}
    pattern = value.get("settlementPattern") if isinstance(value, dict) else None
    episode = value.get("v2Episode") if isinstance(value, dict) else None
    learning = pattern if isinstance(pattern, dict) else (episode.get("learning", {}) if isinstance(episode, dict) else {})
    if not isinstance(learning, dict):
        learning = {}
    return {
        "id": row["item_id"],
        "tenantId": row["tenant_id"],
        "ownerUserId": row["owner_user_id"],
        "subtype": row["subtype"],
        "maturity": row["experience_maturity"],
        "revision": row["revision"],
        "updatedAt": iso_ms(row["item_updated_at"]),
        "createdAt": iso_ms(row["revision_created_at"]),
        "canonicalKey": row["canonical_key"],
        "title": first_nonempty(learning.get("title"), value.get("title") if isinstance(value, dict) else None),
        "goalSummary": first_nonempty(learning.get("goalSummary"), value.get("goalSummary") if isinstance(value, dict) else None),
        "outcome": learning.get("outcome"),
        "learningValue": learning.get("learningValue"),
        "reuseRule": learning.get("reuseRule"),
        "classicPath": learning.get("classicPath", []),
        "reusableKnowledge": learning.get("reusableKnowledge", []),
        "failureLessons": learning.get("failureLessons", []),
        "cautions": learning.get("cautions", []),
        "sourceCount": len(json_value(row["source_refs_json"], []) or []),
        "contentMarkdown": row["content_markdown"],
        "value": value,
    }


def query_experiences(connection: sqlite3.Connection, args: argparse.Namespace) -> list[dict[str, Any]]:
    filters = ["i.kind = 'experience'"]
    params: list[Any] = []
    if not args.all_revisions:
        filters += ["i.status = 'active'", "i.current_revision_id = r.id"]
    else:
        filters.append("i.id = r.memory_id")
    if args.owner:
        filters.append("i.owner_user_id = ?")
        params.append(args.owner)
    if args.tenant:
        filters.append("i.tenant_id = ?")
        params.append(args.tenant)
    limit = max(1, min(args.limit, 1000))
    query = f"""
        SELECT i.id AS item_id, i.tenant_id, i.owner_user_id, i.subtype,
               i.canonical_key, i.updated_at AS item_updated_at,
               r.revision, r.experience_maturity, r.value_json,
               r.content_markdown, r.source_refs_json, r.created_at AS revision_created_at
          FROM local_memory_items i
          JOIN local_memory_revisions r ON r.memory_id = i.id
         WHERE {' AND '.join(filters)}
         ORDER BY i.updated_at DESC, r.created_at DESC
         LIMIT ?
    """
    params.append(limit)
    return [experience_view(row) for row in connection.execute(query, params)]


def query_jobs(connection: sqlite3.Connection, args: argparse.Namespace) -> list[dict[str, Any]]:
    filters: list[str] = []
    params: list[Any] = []
    if args.owner:
        filters.append("owner_user_id = ?")
        params.append(args.owner)
    if args.tenant:
        filters.append("tenant_id = ?")
        params.append(args.tenant)
    where = f" WHERE {' AND '.join(filters)}" if filters else ""
    query = f"""
        SELECT tenant_id, owner_user_id, run_id, terminal_commit_ref,
               settlement_job_id, status, attempts, last_error,
               enqueued_at, next_attempt_at
          FROM local_memory_settlement_jobs{where}
         ORDER BY enqueued_at DESC
         LIMIT 100
    """
    result = []
    for row in connection.execute(query, params):
        item = dict(row)
        item["enqueuedAt"] = iso_ms(item.pop("enqueued_at"))
        item["nextAttemptAt"] = iso_ms(item.pop("next_attempt_at"))
        result.append(item)
    return result


def query_active_non_experiences(connection: sqlite3.Connection, args: argparse.Namespace) -> list[dict[str, Any]]:
    filters = ["i.status = 'active'", "i.kind <> 'experience'", "i.current_revision_id = r.id"]
    params: list[Any] = []
    if args.owner:
        filters.append("i.owner_user_id = ?")
        params.append(args.owner)
    if args.tenant:
        filters.append("i.tenant_id = ?")
        params.append(args.tenant)
    rows = connection.execute(f"""
        SELECT i.id, i.tenant_id, i.owner_user_id, i.kind, i.subtype,
               i.updated_at, r.revision, r.content_markdown, r.value_json
          FROM local_memory_items i
          JOIN local_memory_revisions r ON r.id = i.current_revision_id
         WHERE {' AND '.join(filters)}
         ORDER BY i.updated_at DESC
         LIMIT ?
    """, [*params, max(1, min(args.limit, 1000))])
    return [{
        "id": row["id"], "tenantId": row["tenant_id"], "ownerUserId": row["owner_user_id"],
        "kind": row["kind"], "subtype": row["subtype"], "revision": row["revision"],
        "updatedAt": iso_ms(row["updated_at"]), "contentMarkdown": row["content_markdown"],
        "value": json_value(row["value_json"], {}),
    } for row in rows]


def print_human(experiences: list[dict[str, Any]], other_memory: list[dict[str, Any]], jobs: list[dict[str, Any]], db: Path, app_version: str | None) -> None:
    print(f"Installed Local Runtime: {INSTALLED_APP} (version={app_version or 'unknown'})")
    print(f"Memory DB (read-only): {db}")
    print(f"Active experience records: {len(experiences)}")
    if not experiences:
        print("没有找到已沉淀的 experience 记录。")
    for index, item in enumerate(experiences, 1):
        learning = item.get("learningValue") or {}
        status = learning.get("status") if isinstance(learning, dict) else None
        print(f"\n[{index}] {item['subtype']} / maturity={item.get('maturity')} / revision={item['revision']}")
        print(f"    owner={item['ownerUserId']}  updated={item['updatedAt']}  sources={item['sourceCount']}")
        if item.get("title"):
            print(f"    title: {item['title']}")
        if item.get("goalSummary"):
            print(f"    goal: {item['goalSummary']}")
        if item.get("outcome"):
            print(f"    outcome: {item['outcome']}")
        if status:
            print(f"    learning: {status}")
        if item.get("reuseRule"):
            print(f"    reuseRule: {item['reuseRule']}")
        for key, label in (("reusableKnowledge", "reusableKnowledge"), ("failureLessons", "failureLessons"), ("cautions", "cautions")):
            values = item.get(key) or []
            if values:
                print(f"    {label}:")
                for value in values[:8]:
                    if isinstance(value, dict):
                        text = first_nonempty(value.get("rule"), value.get("lesson"), value.get("doDifferently"), value)
                    else:
                        text = value
                    print(f"      - {text}")
        path = item.get("classicPath") or []
        if path:
            print("    classicPath:")
            for step in path[:8]:
                if isinstance(step, dict):
                    print(f"      {step.get('order', '?')}. {step.get('objective', step)}")
                else:
                    print(f"      - {step}")
    print(f"\nOther active Memory records: {len(other_memory)}")
    for item in other_memory:
        print(f"  {item['kind']}/{item['subtype']} revision={item['revision']} updated={item['updatedAt']}")
        print(f"    {item['contentMarkdown']}")
        value = item.get("value") or {}
        if value:
            print(f"    value: {json.dumps(value, ensure_ascii=False, sort_keys=True)}")
    print(f"\nSettlement jobs: {len(jobs)}")
    for job in jobs[:20]:
        error = f" error={job['last_error']}" if job.get("last_error") else ""
        print(f"  {job['status']} attempts={job['attempts']} run={job['run_id']} enqueued={job['enqueuedAt']}{error}")


def main() -> None:
    args = parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be >= 1")
    connection = connect_readonly(args.db)
    try:
        try:
            experiences = query_experiences(connection, args)
            other_memory = query_active_non_experiences(connection, args)
            jobs = query_jobs(connection, args)
        except sqlite3.OperationalError as error:
            raise SystemExit(f"Cannot query Memory schema in {args.db}: {error}") from error
    finally:
        connection.close()
    if args.as_json:
        print(json.dumps({"installedApp": str(INSTALLED_APP), "installedVersion": installed_version(), "db": str(args.db), "experiences": experiences, "otherActiveMemory": other_memory, "settlementJobs": jobs}, ensure_ascii=False, indent=2))
    else:
        print_human(experiences, other_memory, jobs, args.db, installed_version())


if __name__ == "__main__":
    main()

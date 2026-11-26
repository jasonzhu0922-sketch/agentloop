#!/usr/bin/env python3
"""Copy the data-agent Runtime state to the local TiDB.

Run history events are intentionally excluded.  The destination database is
created only when it does not exist; this script never drops an existing
database.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pymysql


REMOTE = {
    "host": "10.251.40.47",
    "port": 6000,
    "user": "root",
    "password": "",
    "database": "agentloop_data_agent",
}
LOCAL = {
    "host": "127.0.0.1",
    "port": 4000,
    "user": "root",
    "password": "",
    "database": "agentloop_data_agent",
}

# Event rows are deliberately left behind on the old Runtime.  The lease is
# recreated by the local process and must never be copied from another host.
EXCLUDED_TABLES = {"run_events", "run_event_sequences", "data_agent_host_lease"}
REPORT = Path("outputs/agentloop-data-agent-runtime-migration-20261120.json")


def connect(settings: dict[str, object], *, database: str | None = None):
    options = dict(settings)
    if database is not None:
        options["database"] = database
    options.update(connect_timeout=20, read_timeout=60, write_timeout=30,
                   autocommit=False, charset="utf8mb4")
    return pymysql.connect(**options)


def table_names(connection) -> list[str]:
    with connection.cursor() as cursor:
        cursor.execute("SHOW TABLES")
        return [row[0] for row in cursor.fetchall()]


def table_ddl(connection, table: str) -> str:
    with connection.cursor() as cursor:
        cursor.execute(f"SHOW CREATE TABLE `{table}`")
        return cursor.fetchone()[1]


def main() -> None:
    report: dict[str, object] = {
        "schema": "agentloop.runtime-migration/v1",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "source": {"host": REMOTE["host"], "port": REMOTE["port"], "database": REMOTE["database"]},
        "target": {"host": LOCAL["host"], "port": LOCAL["port"], "database": LOCAL["database"]},
        "excluded_tables": sorted(EXCLUDED_TABLES),
        "tables": [],
    }
    remote = connect(REMOTE)
    local_admin = connect(LOCAL, database="mysql")
    local = None
    try:
        source_tables = table_names(remote)
        migrate_tables = [name for name in source_tables if name not in EXCLUDED_TABLES]
        report["source_table_count"] = len(source_tables)
        report["migrated_table_count"] = len(migrate_tables)

        with local_admin.cursor() as cursor:
            cursor.execute("CREATE DATABASE IF NOT EXISTS `agentloop_data_agent` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
        local_admin.commit()
        local = connect(LOCAL)

        # DDL first, with foreign-key checks disabled while tables are loaded.
        with local.cursor() as cursor:
            cursor.execute("SET FOREIGN_KEY_CHECKS=0")
            for table in migrate_tables:
                ddl = table_ddl(remote, table)
                cursor.execute(f"CREATE TABLE IF NOT EXISTS `{table}` " + ddl.split(f"CREATE TABLE `{table}` ", 1)[1])
            local.commit()

            for table in migrate_tables:
                # Stream from the source cursor and write with the destination
                # cursor.  This avoids loading long model/output JSON columns
                # into one giant Python list.
                with remote.cursor() as source_cursor:
                    source_cursor.execute(f"SELECT * FROM `{table}`")
                    columns = [column[0] for column in source_cursor.description]
                    placeholders = ",".join(["%s"] * len(columns))
                    quoted_columns = ",".join(f"`{column}`" for column in columns)
                    insert_sql = f"INSERT INTO `{table}` ({quoted_columns}) VALUES ({placeholders})"
                    count = 0
                    while True:
                        source_rows = source_cursor.fetchmany(500)
                        if not source_rows:
                            break
                        cursor.executemany(insert_sql, source_rows)
                        count += len(source_rows)
                report["tables"].append({"name": table, "rows": count})
            cursor.execute("SET FOREIGN_KEY_CHECKS=1")
            local.commit()

        report["completed_at"] = datetime.now(timezone.utc).isoformat()
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        if local is not None:
            local.close()
        local_admin.close()
        remote.close()


if __name__ == "__main__":
    main()

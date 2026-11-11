#!/usr/bin/env python3
"""Explicit one-time migration of the Skill catalog, audit and isolated accounts.

Dry-run by default. Existing target schemas/accounts are never overwritten.
Business tables are inspected but never changed. PostgreSQL is a migration-only
dependency; the installed Skill uses PyMySQL exclusively.
"""
import argparse
from datetime import timezone
import json
import os
from pathlib import Path
import secrets
from urllib.parse import quote

import psycopg
from psycopg.rows import dict_row
import pymysql
import sqlglot


def identifier(value):
    if not value.isascii() or not value.isidentifier():
        raise ValueError("Invalid migration identifier")
    return "`" + value + "`"


def utc(value):
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connections", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4000)
    parser.add_argument("--user", default="root")
    parser.add_argument("--database", default="nl2sql_skill")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    target_database = identifier(args.database)
    original = args.connections.read_bytes()
    source = json.loads(original)
    if not source["catalog_database_url"].startswith(("postgresql://", "postgres://")):
        raise ValueError("Source must be the existing PostgreSQL Skill configuration")
    selected = sorted(source["query_databases"])
    with psycopg.connect(source["catalog_database_url"], row_factory=dict_row, connect_timeout=5) as pg:
        pg.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        scenarios = pg.execute("SELECT id,name,description,config,created_at,updated_at FROM nl2sql_app.scenarios WHERE id=ANY(%s) ORDER BY id", (selected,)).fetchall()
        audits = pg.execute("SELECT id,scenario_id,run_id,query_hash,params_hash,decision,reason,duration_ms,result_hash,row_count,created_at FROM nl2sql_app.query_audit WHERE scenario_id=ANY(%s) ORDER BY id", (selected,)).fetchall()
    if [row["id"] for row in scenarios] != selected:
        raise ValueError("Configured scenario is missing from the PostgreSQL catalog")
    keys = ("tables", "metrics", "terms", "relationships", "skills", "dimensions", "time_policies",
            "sample_questions", "timezone", "schema_version")
    for row in scenarios:
        row["config"] = {key: row["config"][key] for key in keys if key in row["config"]}
        for metric in row["config"].get("metrics", []):
            if metric.get("expression"):
                metric["expression"] = sqlglot.transpile(metric["expression"], read="postgres", write="mysql", unsupported_level=sqlglot.ErrorLevel.RAISE)[0]
    accounts = {row["id"]: "da_" + row["id"] for row in scenarios}
    all_accounts = ["da_catalog", *accounts.values()]
    if len(set(all_accounts)) != len(all_accounts) or any(len(user) > 32 for user in all_accounts):
        raise ValueError("Invalid or duplicate target account")
    target = pymysql.connect(host=args.host, port=args.port, user=args.user,
        password=os.environ.get("TIDB_ADMIN_PASSWORD", ""), charset="utf8mb4",
        connect_timeout=5, read_timeout=30, autocommit=False, cursorclass=pymysql.cursors.DictCursor)
    with target, target.cursor() as cursor:
        cursor.execute("SELECT VERSION() AS version")
        version = cursor.fetchone()["version"]
        if "TiDB" not in version:
            raise ValueError("Target is not TiDB")
        cursor.execute("SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=%s", (args.database,))
        if cursor.fetchone():
            raise ValueError("Target Skill catalog database already exists; refusing to overwrite")
        for account in all_accounts:
            identifier(account)
            cursor.execute("SELECT User FROM mysql.user WHERE User=%s", (account,))
            if cursor.fetchone():
                raise ValueError("Target Skill account already exists; refusing to overwrite")
        relations = sorted({relation for binding in source["query_databases"].values() for relation in binding["allowed_relations"]})
        for relation in relations:
            namespace, table = relation.split(".")
            identifier(namespace), identifier(table)
            cursor.execute("SELECT table_type FROM information_schema.tables WHERE table_schema=%s AND table_name=%s", (namespace, table))
            row = cursor.fetchone()
            if row is None or row["table_type"] != "BASE TABLE":
                raise ValueError("Target business table is missing or is not a base table")
        receipt = {"target": {"host": args.host, "port": args.port, "database": args.database, "version": version},
                   "applied": args.apply, "scenarios": [{"id": row["id"], "name": row["name"],
                   "tables": len(row["config"].get("tables", [])), "metrics": len(row["config"].get("metrics", [])),
                   "terms": len(row["config"].get("terms", [])), "relationships": len(row["config"].get("relationships", []))} for row in scenarios],
                   "historical_audit_rows": len(audits), "business_tables_modified": False}
        if args.apply:
            private = args.connections.parent / ".local"
            private.mkdir(mode=0o700, exist_ok=True)
            backup = private / "connections.postgresql.json"
            with backup.open("xb") as saved:
                os.chmod(backup, 0o600)
                saved.write(original)
            passwords = {account: secrets.token_urlsafe(32) for account in all_accounts}
            cursor.execute(f"CREATE DATABASE {target_database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
            cursor.execute(f"""CREATE TABLE {target_database}.scenarios (
                id VARCHAR(191) PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
                config JSON NOT NULL, created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL)""")
            cursor.execute(f"""CREATE TABLE {target_database}.query_audit (
                id BIGINT PRIMARY KEY AUTO_INCREMENT, scenario_id VARCHAR(191) NOT NULL,
                run_id VARCHAR(191) NULL, query_hash CHAR(64) NOT NULL, params_hash CHAR(64) NOT NULL,
                decision VARCHAR(32) NOT NULL, reason VARCHAR(191) NOT NULL, duration_ms BIGINT NULL,
                result_hash CHAR(64) NULL, row_count BIGINT NULL,
                created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX (scenario_id))""")
            cursor.executemany(f"INSERT INTO {target_database}.scenarios (id,name,description,config,created_at,updated_at) VALUES (%s,%s,%s,%s,%s,%s)",
                [(r["id"], r["name"], r["description"], json.dumps(r["config"], ensure_ascii=False), utc(r["created_at"]), utc(r["updated_at"])) for r in scenarios])
            if audits:
                cursor.executemany(f"INSERT INTO {target_database}.query_audit (id,scenario_id,run_id,query_hash,params_hash,decision,reason,duration_ms,result_hash,row_count,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    [(r["id"], r["scenario_id"], r["run_id"], r["query_hash"], r["params_hash"], r["decision"], r["reason"], r["duration_ms"], r["result_hash"], r["row_count"], utc(r["created_at"])) for r in audits])
            target.commit()
            for account, password in passwords.items():
                cursor.execute("CREATE USER %s@'%%' IDENTIFIED BY %s", (account, password))
            cursor.execute(f"GRANT SELECT ON {target_database}.scenarios TO %s@'%%'", ("da_catalog",))
            cursor.execute(f"GRANT INSERT ON {target_database}.query_audit TO %s@'%%'", ("da_catalog",))
            for scenario, account in accounts.items():
                for relation in source["query_databases"][scenario]["allowed_relations"]:
                    database, table = relation.split(".")
                    cursor.execute(f"GRANT SELECT ON {identifier(database)}.{identifier(table)} TO %s@'%%'", (account,))
            def url(account, database):
                return f"tidb://{quote(account, safe='')}:{quote(passwords[account], safe='')}@{args.host}:{args.port}/{database}"
            configured = {"catalog_database_url": url("da_catalog", args.database), "query_databases": {}}
            for scenario, account in accounts.items():
                binding = source["query_databases"][scenario]
                databases = {relation.split('.')[0] for relation in binding["allowed_relations"]}
                configured["query_databases"][scenario] = {"query_url": url(account, sorted(databases)[0]),
                                                           "allowed_relations": binding["allowed_relations"]}
            # Verify every catalog document and audit count before switching the
            # live local configuration. Credentials never enter the receipt.
            cursor.execute(f"SELECT id,config FROM {target_database}.scenarios ORDER BY id")
            assert {r["id"]: json.loads(r["config"]) for r in cursor.fetchall()} == {r["id"]: r["config"] for r in scenarios}
            cursor.execute(f"SELECT COUNT(*) AS n FROM {target_database}.query_audit")
            assert cursor.fetchone()["n"] == len(audits)
            temporary = private / "connections.tidb.pending.json"
            with temporary.open("x", encoding="utf-8") as output:
                os.chmod(temporary, 0o600)
                json.dump(configured, output, ensure_ascii=False, indent=2)
            os.replace(temporary, args.connections)
            receipt["verified"] = True
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(receipt, ensure_ascii=False))


if __name__ == "__main__":
    main()

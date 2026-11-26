from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pymysql


REMOTE = {
    "host": "10.251.40.47",
    "port": 6000,
    "user": "root",
    "password": "",
    "database": "nl2sql_skill",
}
LOCAL = {
    "host": "127.0.0.1",
    "port": 4000,
    "user": "root",
    "password": "",
    "database": "nl2sql_skill",
}
OUT = Path("outputs/nl2sql-skill-semantic-migration-20261120")


def connect(settings):
    return pymysql.connect(**settings, autocommit=False, charset="utf8mb4")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def read_scenarios(connection):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, name, description, config, created_at, updated_at, binding "
            "FROM scenarios ORDER BY id"
        )
        rows = cursor.fetchall()
    output = {}
    for row in rows:
        output[row[0]] = {
            "id": row[0],
            "name": row[1],
            "description": row[2],
            "config": row[3] if isinstance(row[3], dict) else json.loads(row[3]),
            "created_at": row[4].isoformat() if row[4] else None,
            "updated_at": row[5].isoformat() if row[5] else None,
            "binding": row[6] if isinstance(row[6], dict) or row[6] is None else json.loads(row[6]),
        }
    return output


def semantic_projection(row):
    config = copy.deepcopy(row["config"])
    config.pop("connection", None)
    config.pop("catalog_status", None)
    binding = copy.deepcopy(row.get("binding") or {})
    binding.pop("connection", None)
    binding.pop("query_url_file", None)
    return {"name": row["name"], "description": row["description"], "config": config, "binding": binding}


def localize(remote_row, local_row):
    config = copy.deepcopy(remote_row["config"])
    local_config = local_row["config"]
    # Semantic definitions come from the remote catalog. Runtime/model and
    # local source connection settings stay local.
    if "connection" in local_config:
        config["connection"] = copy.deepcopy(local_config["connection"])
    if "catalog_status" in local_config:
        config["catalog_status"] = local_config["catalog_status"]

    remote_binding = copy.deepcopy(remote_row.get("binding") or {})
    local_binding = copy.deepcopy(local_row.get("binding") or {})
    binding = remote_binding
    if "connection" in local_binding:
        binding["connection"] = copy.deepcopy(local_binding["connection"])
    if "query_url_file" in local_binding:
        binding["query_url_file"] = local_binding["query_url_file"]

    return {
        "name": remote_row["name"],
        "description": remote_row["description"],
        "config": config,
        "binding": binding,
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    remote = connect(REMOTE)
    local = connect(LOCAL)
    try:
        remote_rows = read_scenarios(remote)
        local_rows = read_scenarios(local)
        OUT.joinpath("local-scenarios-before.json").write_text(
            json.dumps(local_rows, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )

        missing = sorted(set(remote_rows) - set(local_rows))
        if missing:
            raise RuntimeError(f"local scenarios missing; refusing implicit schema/data creation: {missing}")

        changes = []
        with local.cursor() as cursor:
            for scenario_id, remote_row in remote_rows.items():
                before = local_rows[scenario_id]
                merged = localize(remote_row, before)
                cursor.execute(
                    "UPDATE scenarios SET name=%s, description=%s, config=%s, binding=%s, "
                    "updated_at=CURRENT_TIMESTAMP(6) WHERE id=%s",
                    (
                        merged["name"],
                        merged["description"],
                        json.dumps(merged["config"], ensure_ascii=False, separators=(",", ":")),
                        json.dumps(merged["binding"], ensure_ascii=False, separators=(",", ":")),
                        scenario_id,
                    ),
                )
                changes.append(
                    {
                        "scenario_id": scenario_id,
                        "before_semantic_sha256": digest(semantic_projection(before)),
                        "remote_semantic_sha256": digest(semantic_projection(remote_row)),
                        "after_semantic_sha256": digest(semantic_projection({**remote_row, **merged})),
                        "local_connection_preserved": True,
                    }
                )
        local.commit()

        after_rows = read_scenarios(local)
        checks = []
        for scenario_id, remote_row in remote_rows.items():
            after = after_rows[scenario_id]
            expected = localize(remote_row, local_rows[scenario_id])
            checks.append(
                {
                    "scenario_id": scenario_id,
                    "semantic_equal": semantic_projection(after)
                    == semantic_projection({**remote_row, **expected}),
                    "local_connection": after["config"].get("connection"),
                    "local_binding_connection": (after.get("binding") or {}).get("connection"),
                }
            )
        report = {
            "schema": "nl2sql.semantic-migration/v1",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "source": {"host": REMOTE["host"], "port": REMOTE["port"], "database": REMOTE["database"]},
            "target": {"host": LOCAL["host"], "port": LOCAL["port"], "database": LOCAL["database"]},
            "scope": "scenarios semantic definitions only",
            "excluded_tables": ["runs", "conversations", "mcp_calls", "query_audit", "run_results", "imports", "config", "schema_migrations"],
            "changes": changes,
            "checks": checks,
        }
        OUT.joinpath("migration-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    finally:
        remote.close()
        local.close()


if __name__ == "__main__":
    main()

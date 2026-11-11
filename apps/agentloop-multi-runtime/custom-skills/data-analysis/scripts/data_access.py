"""Skill-owned catalog and query workflow using its bundled deterministic gateway."""
from __future__ import annotations

import hashlib
import json
from time import monotonic
from uuid import uuid4


def catalog_projection(config, scenario_id):
    value = {"schema": "nl2sql.data-catalog/v1", "scenario_id": scenario_id,
             **{key: config.get(key, []) for key in
                ("tables", "metrics", "terms", "relationships", "skills", "dimensions", "time_policies")}}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    value["catalog_revision"] = hashlib.sha256(encoded).hexdigest()
    return value


class Gateway:
    def __init__(self, store, scope, physical_catalog, execute, policy_error, driver_error):
        self.store, self.scope, self.physical_catalog = store, scope, physical_catalog
        self.execute, self.policy_error, self.driver_error = execute, policy_error, driver_error

    def scenarios(self):
        # Only identity and business descriptions reach the model.
        return [{key: row[key] for key in ("id", "name", "description")}
                for row in self.store.list_scenarios()]

    def catalog(self, scenario_id, source_ids=None):
        with self.scope(self.store.get_scenario(scenario_id)):
            value = catalog_projection(self.physical_catalog(self.store.load_config()), scenario_id)
        requested = set(source_ids or [])
        tables = value["tables"]
        if requested - {table["name"] for table in tables}:
            raise ValueError("Source is absent from the selected scenario")
        if requested:
            value["projection"] = "source_details"
            value["tables"] = [table for table in tables if table["name"] in requested]
            value["metrics"] = [m for m in value["metrics"] if m.get("table") in requested]
            value["relationships"] = [r for r in value["relationships"]
                                      if any(r.get(side, {}).get("source_id") in requested
                                             for side in ("left", "right"))]
        else:
            value["projection"] = "source_index"
            value["tables"] = [{key: table[key] for key in
                                ("name", "schema", "label", "description", "relation_type") if key in table}
                               for table in tables]
            value["skills"] = [{k: v for k, v in skill.items()
                                if k in ("id", "name", "description", "tags")}
                               for skill in value["skills"]]
        return value

    def execute_sql(self, scenario_id, sql, params):
        started = monotonic()
        result = {"schema": "nl2sql.query-result/v1", "scenario_id": scenario_id,
                  "query_id": "query_" + uuid4().hex, "sql": sql, "params": params}
        with self.scope(self.store.get_scenario(scenario_id)):
            config = self.physical_catalog(self.store.load_config())
            result["catalog_revision"] = catalog_projection(config, scenario_id)["catalog_revision"]
            config["_run_id"] = result["query_id"]
            config["_query_audit"] = self.store.record_query_audit
            try:
                dataset = self.execute(sql, params, config)
            except self.policy_error as exc:
                result.update(status="rejected", error={"code": "query_policy_rejected", "message": str(exc)})
            except Exception as exc:
                result.update(status="failed", error={"code": "query_execution_failed",
                                                      "message": "Read-only query failed; check SQL, field types or gateway availability"})
                if isinstance(exc, self.driver_error):
                    result["error"]["sqlstate"] = exc.sqlstate
                    result["error"]["position"] = exc.diag.statement_position
            else:
                result.update(status="completed", dataset=dataset, error=None)
        result["duration_ms"] = round((monotonic() - started) * 1000)
        return result


def load_gateway():
    """Load only code and connection settings contained in this Skill package."""
    import psycopg
    from runtime_config import connections
    from gateway.store import CatalogStore
    from gateway.scenarios import scenario_scope
    from gateway.table_catalog import physical_catalog
    from gateway.database import execute_readonly
    from gateway.query_policy import QueryPolicyError
    return Gateway(CatalogStore(connections()), scenario_scope, physical_catalog,
                   execute_readonly, QueryPolicyError, psycopg.Error)

"""Read the configured catalog database and record query audit, without a Run."""
from copy import deepcopy
from contextlib import contextmanager

import json

from .tidb_connection import connect

from .scenarios import scenario_id


class CatalogStore:
    def __init__(self, connections):
        self.connections = connections

    @contextmanager
    def connect(self, *, readonly=True):
        with connect(self.connections["catalog_database_url"]) as connection:
            try:
                with connection.cursor() as cursor:
                    yield cursor
                if not readonly:
                    connection.commit()
            except Exception:
                connection.rollback()
                raise

    def list_scenarios(self):
        with self.connect() as connection:
            connection.execute("SELECT id, name, description FROM scenarios ORDER BY created_at, id")
            rows = connection.fetchall()
        return [row for row in rows if row["id"] in self.connections["query_databases"]]

    def get_scenario(self, identifier):
        binding = self.connections["query_databases"].get(identifier)
        if not binding:
            raise ValueError("Scenario has no configured data source")
        with self.connect() as connection:
            connection.execute("SELECT id, name, description FROM scenarios WHERE id=%s", (identifier,))
            row = connection.fetchone()
        if not row:
            raise ValueError("Unknown scenario")
        return {**row, "binding": deepcopy(binding)}

    def load_config(self):
        with self.connect() as connection:
            connection.execute("SELECT config FROM scenarios WHERE id=%s", (scenario_id(),))
            row = connection.fetchone()
        if not row:
            raise ValueError("Unknown scenario")
        config = json.loads(row["config"]) if isinstance(row["config"], (str, bytes)) else row["config"]
        # Project business metadata before returning it to the query workflow.
        return {key: deepcopy(config.get(key, [])) for key in
                ("tables", "metrics", "terms", "relationships", "skills", "dimensions", "time_policies")}

    def record_query_audit(self, event):
        # The only database write in this Skill: the existing audit sink.
        with self.connect(readonly=False) as connection:
            connection.execute("""INSERT INTO query_audit
                (scenario_id, run_id, query_hash, params_hash, decision, reason, duration_ms, result_hash, row_count)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (scenario_id(), event["run_id"], event["query_hash"], event["params_hash"],
                 event["decision"], event["reason"], event.get("duration_ms"), event.get("result_hash"), event.get("row_count")))

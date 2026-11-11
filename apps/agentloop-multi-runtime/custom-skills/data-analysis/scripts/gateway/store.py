"""Read the configured catalog database and record query audit, without a Run."""
from copy import deepcopy
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

from .scenarios import scenario_id


class CatalogStore:
    def __init__(self, connections):
        self.connections = connections

    @contextmanager
    def connect(self, *, readonly=True):
        with psycopg.connect(self.connections["catalog_database_url"],
                             row_factory=dict_row, connect_timeout=5) as connection:
            if readonly:
                connection.execute("SET TRANSACTION READ ONLY")
            yield connection

    def list_scenarios(self):
        with self.connect() as connection:
            rows = connection.execute("SELECT id, name, description FROM nl2sql_app.scenarios ORDER BY created_at, id").fetchall()
        return [row for row in rows if row["id"] in self.connections["query_databases"]]

    def get_scenario(self, identifier):
        binding = self.connections["query_databases"].get(identifier)
        if not binding:
            raise ValueError("Scenario has no configured data source")
        with self.connect() as connection:
            row = connection.execute("SELECT id, name, description FROM nl2sql_app.scenarios WHERE id=%s", (identifier,)).fetchone()
        if not row:
            raise ValueError("Unknown scenario")
        return {**row, "binding": deepcopy(binding)}

    def load_config(self):
        with self.connect() as connection:
            row = connection.execute("SELECT config FROM nl2sql_app.scenarios WHERE id=%s", (scenario_id(),)).fetchone()
        if not row:
            raise ValueError("Unknown scenario")
        # Project business metadata before returning it to the query workflow.
        return {key: deepcopy(row["config"].get(key, [])) for key in
                ("tables", "metrics", "terms", "relationships", "skills", "dimensions", "time_policies")}

    def record_query_audit(self, event):
        # The only database write in this Skill: the existing audit sink.
        with self.connect(readonly=False) as connection:
            connection.execute("""INSERT INTO nl2sql_app.query_audit
                (scenario_id, run_id, query_hash, params_hash, decision, reason, duration_ms, result_hash, row_count)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (scenario_id(), event["run_id"], event["query_hash"], event["params_hash"],
                 event["decision"], event["reason"], event.get("duration_ms"), event.get("result_hash"), event.get("row_count")))

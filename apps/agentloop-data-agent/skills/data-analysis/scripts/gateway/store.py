"""Read the configured catalog database and record query audit, without a Run."""
from copy import deepcopy
from contextlib import contextmanager

import hashlib
import json
import os
from pathlib import Path
import tempfile

from .tidb_connection import connect

from .scenarios import scenario_id
from catalog_knowledge import catalog_config


class CatalogStore:
    def __init__(self, connections, *, snapshot_root=None, run_id=None):
        self.connections = connections
        # A snapshot is deliberately scoped to one Runtime Run.  The CLI is
        # invoked once per tool call, so an in-process cache cannot serve the
        # actual workflow; the Run workspace is the durable hand-off boundary.
        self.snapshot_root = Path(snapshot_root).resolve() if snapshot_root and run_id else None
        self.run_id = run_id if self.snapshot_root is not None else None

    def _snapshot_path(self, identifier):
        if self.snapshot_root is None:
            return None
        key = hashlib.sha256(identifier.encode('utf-8')).hexdigest()[:24]
        return self.snapshot_root / 'semantic' / f'catalog-snapshot-{key}.json'

    @staticmethod
    def _config_digest(config):
        encoded = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        return hashlib.sha256(encoded).hexdigest()

    def _read_cached_snapshot(self, identifier):
        path = self._snapshot_path(identifier)
        if path is None or not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
            if (value.get('schema') != 'nl2sql.catalog-snapshot/v1'
                    or value.get('run_id') != self.run_id
                    or value.get('scenario_id') != identifier
                    or not isinstance(value.get('scenario'), dict)
                    or not isinstance(value.get('config'), dict)
                    or not isinstance(value.get('config_digest'), str)):
                return None
            return value
        except (OSError, ValueError, UnicodeError):
            # A partial or foreign snapshot is never evidence. The caller
            # falls back to the authoritative TiDB read and replaces it.
            return None

    def _write_snapshot(self, identifier, scenario, config):
        path = self._snapshot_path(identifier)
        if path is None:
            return
        payload = {
            'schema': 'nl2sql.catalog-snapshot/v1', 'run_id': self.run_id,
            'scenario_id': identifier, 'scenario': scenario,
            'config_digest': self._config_digest(config), 'config': config,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.catalog-snapshot-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                stream.write('\n')
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @contextmanager
    def connect(self, *, readonly=True):
        with connect(self.connections["catalog_database_url"]) as connection:
            try:
                with connection.cursor() as cursor:
                    yield cursor
                if not readonly:
                    connection.commit()
            except Exception:
                if not readonly:
                    try:
                        connection.rollback()
                    except Exception:
                        pass  # A broken connection must not replace the original failure.
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

    def read_snapshot(self, identifier, *, reuse=True, verify_current=True):
        """Read one Run-scoped catalog snapshot, validating its TiDB revision."""
        binding = self.connections['query_databases'].get(identifier)
        if not binding:
            raise ValueError('Scenario has no configured data source')

        cached = self._read_cached_snapshot(identifier) if reuse and not verify_current else None
        if cached is not None:
            scenario = deepcopy(cached['scenario'])
            return {**scenario, 'binding': deepcopy(binding)}, deepcopy(cached['config'])

        with self.connect() as connection:
            connection.execute('SELECT id, name, description, config FROM scenarios WHERE id=%s', (identifier,))
            row = connection.fetchone()
        if not row:
            raise ValueError('Unknown scenario')
        config = json.loads(row['config']) if isinstance(row['config'], (str, bytes)) else row['config']
        scenario = {key: row[key] for key in ('id', 'name', 'description')}
        public = catalog_config(config)
        self._write_snapshot(identifier, scenario, public)
        return {**scenario, 'binding': deepcopy(binding)}, public

    def load_config(self):
        with self.connect() as connection:
            connection.execute("SELECT config FROM scenarios WHERE id=%s", (scenario_id(),))
            row = connection.fetchone()
        if not row:
            raise ValueError("Unknown scenario")
        config = json.loads(row["config"]) if isinstance(row["config"], (str, bytes)) else row["config"]
        # Project business metadata before returning it to the query workflow.
        return catalog_config(config)

    def record_query_audit(self, event):
        # The only database write in this Skill: the existing audit sink.
        with self.connect(readonly=False) as connection:
            connection.execute("""INSERT INTO query_audit
                (scenario_id, run_id, query_hash, params_hash, decision, reason, duration_ms, result_hash, row_count)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (scenario_id(), event["run_id"], event["query_hash"], event["params_hash"],
                 event["decision"], event["reason"], event.get("duration_ms"), event.get("result_hash"), event.get("row_count")))

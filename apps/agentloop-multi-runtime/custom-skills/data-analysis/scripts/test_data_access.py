"""Skill-local regressions: python -B scripts/test_data_access.py."""
import asyncio
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

from data_access import Gateway
import data_client
import runtime_config
from data_api import create_app
from scenario_selection import selection_requirement
import httpx


class PolicyError(ValueError):
    pass


class Store:
    def __init__(self):
        self.current = None
        self.audits = []

    def list_scenarios(self):
        return [{"id": "group", "name": "业务", "description": "已配置", "binding": "PRIVATE"}]

    def get_scenario(self, identifier):
        if identifier != "group":
            raise ValueError("Unknown scenario")
        return {"id": identifier}

    def load_config(self):
        return {"tables": [{"name": "staff", "schema": "group", "columns": [
            {"name": "amount", "value_domain": "月末快照", "allow_output": True}]}],
            "metrics": [], "terms": [], "skills": [{"id": "method", "prompt": "PRIVATE_METHOD_BODY"}],
            "model": {"api_key": "SECRET"}, "connection": {"url": "SECRET"}}

    def record_query_audit(self, event):
        self.audits.append(event)

    @contextmanager
    def scope(self, scenario):
        previous = self.current
        self.current = scenario["id"]
        try:
            yield
        finally:
            self.current = previous


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.calls = []
        def execute(sql, params, config):
            self.calls.append((sql, params, self.store.current))
            config["_query_audit"]({"run_id": config["_run_id"], "decision": "completed"})
            return {"columns": ["amount"], "rows": [{"amount": 2300}], "row_count": 1}
        self.gateway = Gateway(self.store, self.store.scope, deepcopy, execute, PolicyError, OSError)

    def test_catalog_progression_preserves_business_domains_without_secrets(self):
        index = self.gateway.catalog("group")
        details = self.gateway.catalog("group", ["staff"])
        self.assertNotIn("columns", index["tables"][0])
        self.assertEqual(details["tables"][0]["columns"][0]["value_domain"], "月末快照")
        self.assertEqual(index["catalog_revision"], details["catalog_revision"])
        self.assertNotIn("SECRET", json.dumps(details))
        self.assertNotIn("PRIVATE_METHOD_BODY", json.dumps(index))
        self.assertNotIn("binding", self.gateway.scenarios()[0])
        self.assertIsNone(self.store.current)
        with self.assertRaises(ValueError):
            self.gateway.catalog("group", ["not_authorized"])

    def test_exact_sql_params_scope_and_audit_link_are_preserved(self):
        result = self.gateway.execute_sql("group", "SELECT amount FROM group.staff WHERE period=%s", ["202503"])
        self.assertEqual(self.calls, [("SELECT amount FROM group.staff WHERE period=%s", ["202503"], "group")])
        self.assertEqual(result["query_id"], self.store.audits[0]["run_id"])
        self.assertEqual(result["dataset"]["rows"], [{"amount": 2300}])
        self.assertIsNone(self.store.current)

    def test_rejection_and_driver_failure_are_distinct_from_empty_success(self):
        for error, status in [(PolicyError("Only SELECT"), "rejected"), (RuntimeError("password=SECRET"), "failed")]:
            def fail(*args):
                raise error
            self.gateway.execute = fail
            result = self.gateway.execute_sql("group", "SELECT amount FROM group.staff", [])
            self.assertEqual(result["status"], status)
            self.assertNotIn("dataset", result)
            self.assertNotIn("SECRET", json.dumps(result))
            self.assertIsNone(self.store.current)

    def test_skill_http_routes_require_scenario_and_refuse_connection_or_model_overrides(self):
        async def check():
            app = create_app(gateway=self.gateway)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://skill") as client:
                self.assertEqual((await client.get("/api/data/catalog")).status_code, 422)
                self.assertEqual((await client.get("/api/data/catalog?scenario_id=missing")).status_code, 400)
                self.assertEqual((await client.get("/api/data/catalog?scenario_id=group&source_id=staff")).json()["projection"], "source_details")
                for extra in ({"connection": "override"}, {"model": "override"}, {"params": [["bad"]]}, {"params": [float('nan')]}):
                    # Serialize explicitly so the server, rather than httpx,
                    # exercises validation of malformed/nonfinite parameters.
                    response = await client.post("/api/data/execute", content=json.dumps({"scenario_id": "group", "sql": "SELECT amount FROM group.staff", **extra}), headers={"Content-Type": "application/json"})
                    self.assertEqual(response.status_code, 422)
                response = await client.post("/api/data/execute", json={"scenario_id": "group", "sql": "SELECT amount FROM group.staff"})
                self.assertEqual(response.json()["dataset"]["rows"], [{"amount": 2300}])
        asyncio.run(check())

    def invoke(self, result=None, error=None, body=None):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)/"result.json"
            with patch.object(data_client, "load_gateway", return_value=self.gateway) as load, redirect_stdout(io.StringIO()) as stream:
                if error:
                    load.side_effect = error
                if result is not None:
                    self.gateway.execute_sql = lambda *args: result
                code = data_client.main(["execute", "--scenario-id", "group",
                                         "--request-json", json.dumps(body or {"sql": "SELECT amount FROM group.staff", "params": []}),
                                         "--output", str(output)])
                return code, json.loads(output.read_text()), json.loads(stream.getvalue())

    def test_cli_inlines_small_complete_facts_and_preserves_full_large_results(self):
        code, saved, receipt = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(receipt["content"], saved)
        self.assertTrue(receipt["content_complete"])
        large = {**saved, "dataset": {"columns": ["amount"], "rows": [{"amount": i} for i in range(700)], "row_count": 700}}
        code, saved, receipt = self.invoke(large)
        self.assertEqual(code, 0)
        self.assertEqual(len(saved["dataset"]["rows"]), 700)
        self.assertFalse(receipt["content_complete"])
        self.assertNotIn("content", receipt)

    def test_cli_fails_closed_on_partial_or_mismatched_evidence(self):
        valid = self.gateway.execute_sql("group", "SELECT amount FROM group.staff", [])
        for invalid in [{**valid, "scenario_id": "other"}, {**valid, "dataset": {"columns": [], "rows": [], "row_count": 2}}]:
            code, _, receipt = self.invoke(invalid)
            self.assertEqual(code, 1)
            self.assertNotIn("evidenceReceipt", receipt)

    def test_cli_preserves_zero_and_null_and_never_retries_failed_gateway(self):
        valid = self.gateway.execute_sql("group", "SELECT amount FROM group.staff", [])
        for dataset in [{"columns": ["amount"], "rows": [], "row_count": 0}, {"columns": ["amount"], "rows": [{"amount": None}], "row_count": 1}]:
            code, saved, _ = self.invoke({**valid, "dataset": dataset})
            self.assertEqual(code, 0)
            self.assertEqual(saved["dataset"], dataset)
        code, saved, receipt = self.invoke(error=RuntimeError("password=SECRET"))
        self.assertEqual(code, 1)
        self.assertEqual(saved["status"], "gateway_error")
        self.assertNotIn("SECRET", str(receipt))

    def test_no_project_environment_or_external_application_is_needed(self):
        with patch.dict("os.environ", {}, clear=True):
            with tempfile.TemporaryDirectory() as temporary:
                with patch.object(data_client, "load_gateway", return_value=self.gateway) as load, redirect_stdout(io.StringIO()):
                    code = data_client.main(["scenarios", "--output", str(Path(temporary)/"scenarios.json")])
                self.assertEqual(code, 0)
                load.assert_called_once_with()
        from data_access import load_gateway
        configured = {"catalog_database_url": "postgresql://catalog:secret@localhost/catalog",
                      "query_databases": {"group": {"query_url": "postgresql://readonly:secret@localhost/business", "allowed_relations": ["group.staff"]}}}
        with patch.object(runtime_config, "connections", return_value=configured):
            loaded = load_gateway()
        self.assertEqual(loaded.store.__class__.__module__, "gateway.store")
        self.assertTrue(loaded.execute.__module__.startswith("gateway."))
        self.assertFalse(any(n == "app" or n.startswith("app.") for n in sys.modules))

    def test_runtime_readonly_connection_copy_is_read_without_chmod(self):
        configured = {"catalog_database_url": "postgresql://catalog:secret@localhost/catalog",
                      "query_databases": {"group": {"query_url": "postgresql://readonly:secret@localhost/business", "allowed_relations": ["group.staff"]}}}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/"connections.json"
            path.write_text(json.dumps(configured))
            path.chmod(0o444)
            try:
                with patch.object(runtime_config, "CONNECTIONS_FILE", path):
                    self.assertEqual(runtime_config.connections(), configured)
                self.assertEqual(path.stat().st_mode & 0o777, 0o444)
            finally:
                path.chmod(0o600)

    def test_configuration_failure_is_specific_and_does_not_imply_database_failure(self):
        error = runtime_config.ConnectionConfigurationError("connections_missing", "Skill root connections.json is missing")
        code, saved, _ = self.invoke(error=error)
        self.assertEqual(code, 1)
        self.assertEqual(saved["diagnostic"]["phase"], "configuration.read")
        self.assertEqual(saved["diagnostic"]["code"], "connections_missing")
        with tempfile.TemporaryDirectory() as temporary, patch.object(data_client, "load_gateway", side_effect=error), redirect_stdout(io.StringIO()):
            output = Path(temporary)/"scenarios.json"
            self.assertEqual(data_client.main(["scenarios", "--output", str(output)]), 1)
            self.assertEqual(json.loads(output.read_text())["execution_state"], "not_applicable")


class BundledPolicyTest(unittest.TestCase):
    def setUp(self):
        from gateway.scenarios import scenario_scope
        self.scope = scenario_scope
        from gateway.query_policy import validate_query, QueryPolicyError, validate_output_fields
        self.validate, self.policy_error, self.outputs = validate_query, QueryPolicyError, validate_output_fields

    def test_missing_binding_and_unsafe_or_cross_scenario_sql_fail_closed(self):
        with self.assertRaises(self.policy_error):
            self.validate('SELECT * FROM group.staff')
        with self.scope({'id': 'group', 'binding': {'allowed_relations': ['group.staff']}}):
            for sql in [
                'SELECT * FROM group.staff; DELETE FROM group.staff',
                'WITH x AS (DELETE FROM group.staff RETURNING *) SELECT * FROM x',
                'SELECT * FROM demo.staff',
                'SELECT (SELECT password FROM public.accounts) FROM group.staff',
                'SELECT pg_catalog.pg_sleep(1) FROM group.staff',
                'SELECT amount FROM group.staff FOR UPDATE',
                'SELECT * FROM generate_series(1,5), group.staff',
                'SELECT amount::public.unsafe FROM group.staff',
                'WITH RECURSIVE x AS (SELECT * FROM group.staff) SELECT * FROM x',
                'SELECT 1',
            ]:
                with self.subTest(sql=sql), self.assertRaises(self.policy_error):
                    self.validate(sql)

    def test_cte_aggregate_and_parameters_are_admitted_with_explicit_binding(self):
        with self.scope({'id': 'group', 'binding': {'allowed_relations': ['group.staff']}}):
            for sql in [
                'SELECT period, SUM(amount) FROM group.staff WHERE period=%s GROUP BY period',
                'WITH x AS (SELECT amount FROM group.staff) SELECT SUM(amount) FROM x',
                'SELECT CASE WHEN amount > 0 THEN 1 ELSE 0 END FROM group.staff',
            ]:
                self.validate(sql)

    def test_output_policy_survives_aliases_ctes_and_stars(self):
        config = {'tables': [{'name': 'staff', 'columns': [
            {'name': 'code', 'allow_output': False}, {'name': 'amount', 'allow_output': True}]}]}
        with self.scope({'id': 'group', 'binding': {'allowed_relations': ['group.staff']}}):
            for sql in ['SELECT code AS x FROM group.staff', 'SELECT * FROM group.staff',
                        'WITH x AS (SELECT code AS c FROM group.staff) SELECT c FROM x']:
                with self.subTest(sql=sql), self.assertRaises(self.policy_error):
                    self.outputs(sql, config)
            self.outputs('SELECT count(DISTINCT code) AS n FROM group.staff', config)

    def test_sql_percent_escaping_preserves_literals_modulo_and_real_parameters(self):
        from gateway.database import _driver_query
        sql = "SELECT '%s%', 7 % 2 FROM group.staff WHERE name ILIKE %s -- 100%"
        converted, params = _driver_query(sql, ['%公司%'])
        self.assertEqual(converted, "SELECT '%%s%%', 7 %% 2 FROM group.staff WHERE name ILIKE %s -- 100%%")
        self.assertEqual(params, ['%公司%'])
        self.assertEqual(_driver_query(sql, []), (sql, None))


class ScenarioSelectionTest(unittest.TestCase):
    def test_single_available_scenario_still_requires_user_selection(self):
        result = selection_requirement([{"id": "warehouse", "name": "经营数据", "description": "已配置范围"}], "selection.json")
        requirement = result["humanLoopRequirement"]
        self.assertEqual(requirement["kind"], "selection")
        self.assertEqual(requirement["responseSchema"], {
            "type": "select", "minSelections": 1, "maxSelections": 1,
            "options": [{"id": "warehouse", "label": "经营数据", "description": "已配置范围",
                         "identityRefs": ["data-analysis:scenario:warehouse"]}]})
        self.assertEqual(requirement["resume"], {"mode": "continue_step"})
        self.assertNotIn("scenario_id", result)

    def test_options_use_live_identities_without_recommendation_or_invented_defaults(self):
        scenarios = [{"id": "a", "name": "同名目录", "description": "业务 A"},
                     {"id": "b", "name": "同名目录", "description": "业务 B"}]
        options = selection_requirement(scenarios, "selection.json")["humanLoopRequirement"]["responseSchema"]["options"]
        self.assertEqual([o["id"] for o in options], ["a", "b"])
        self.assertEqual([o["description"] for o in options], ["业务 A", "业务 B"])
        for invalid in [[], scenarios + [scenarios[0]]]:
            with self.assertRaises(ValueError):
                selection_requirement(invalid, "selection.json")

    def test_cli_emits_native_hil_without_querying_metadata_even_for_large_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)/"hil"/"selection.json"
            gateway = unittest.mock.Mock()
            gateway.scenarios.return_value = [{"id": "one", "name": "场景一", "description": "范围" * 4000},
                                             {"id": "two", "name": "场景二", "description": "其他范围"}]
            with patch.object(data_client, "load_gateway", return_value=gateway), redirect_stdout(io.StringIO()) as stream:
                code = data_client.main(["select-scenario", "--output", str(output)])
            self.assertEqual(code, 0)
            saved = json.loads(output.read_text())
            receipt = json.loads(stream.getvalue())
            self.assertEqual(saved["schema"], "agentloop.humanLoopRequirement/v1")
            self.assertEqual(receipt["humanLoopRequirement"], saved["humanLoopRequirement"])
            self.assertFalse(receipt["content_complete"])
            self.assertEqual(saved["humanLoopRequirement"]["evidenceRefs"], [str(output.resolve())])
            gateway.scenarios.assert_called_once_with()
            gateway.catalog.assert_not_called()
            gateway.execute_sql.assert_not_called()


if __name__ == "__main__":
    unittest.main()

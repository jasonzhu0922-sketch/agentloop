"""Skill-local regressions: python -B scripts/test_data_access.py."""
import asyncio
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

from data_access import Gateway
import data_client
import runtime_config
from data_api import create_app
import httpx


class InstalledEntrypointTest(unittest.TestCase):
    @contextmanager
    def installed_skill(self, stale_deployment=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/"installed-skill"
            shutil.copytree(Path(__file__).resolve().parent.parent, root,
                            ignore=shutil.ignore_patterns("connections.json", "__pycache__", "*.pyc"))
            if stale_deployment:
                config = root/"config"/"deployment.json"
                config.parent.mkdir(exist_ok=True)
                config.write_text(json.dumps({"python_executable": "/unavailable/developer/.pyenv/bin/python3"}))
            paths = list(root.rglob("*"))
            for path in paths:
                path.chmod(0o555 if path.is_dir() else 0o444)
            root.chmod(0o555)
            try:
                yield root
            finally:
                root.chmod(0o755)
                for path in paths:
                    path.chmod(0o755 if path.is_dir() else 0o644)

    def test_readonly_installed_entrypoints_keep_the_host_interpreter(self):
        for stale_deployment in (False, True):
            with self.installed_skill(stale_deployment) as root:
                for script in ("data_client.py", "data_api.py"):
                    with self.subTest(script=script, stale_deployment=stale_deployment):
                        result = subprocess.run([sys.executable, "-B", str(root/"scripts"/script), "--help"],
                                                cwd=root, text=True, capture_output=True, timeout=15)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn("usage:", result.stdout)
                        self.assertFalse((root/"connections.json").exists())
                        self.assertEqual((root/"scripts"/script).stat().st_mode & 0o777, 0o444)

    def test_missing_host_dependencies_report_failure_without_switching_python(self):
        with self.installed_skill(stale_deployment=True) as root:
            # -S removes site-packages from this real process, simulating a
            # host Python without gateway dependencies. No database is used.
            result = subprocess.run([sys.executable, "-B", "-S", str(root/"scripts/data_client.py"), "scenarios"],
                                    cwd=root, text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 1, result.stderr)
            saved = json.loads(result.stdout)
            self.assertEqual(saved["status"], "gateway_error")
            self.assertEqual(saved["diagnostic"]["code"], "dependency_unavailable")
            self.assertEqual(saved["diagnostic"]["module"], "pymysql")
            self.assertEqual(saved["execution_state"], "not_applicable")
            self.assertEqual(result.stderr, "")


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
        self.gateway = Gateway(self.store, self.store.scope, deepcopy, execute, PolicyError)

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

    def test_quick_table_counts_use_one_union_query_and_verified_sources(self):
        result = self.gateway.quick_query('group', {'kind': 'scenario_table_counts'})
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(result['deterministic_answer'])
        self.assertIn('COUNT(*)', self.calls[-1][0])
        self.assertEqual(result['query_plan']['source_signatures'].keys(), {'staff'})

    def test_quick_dimension_counts_combine_dimensions_into_one_query(self):
        original = self.store.load_config
        def config():
            value = original()
            value['tables'][0].update(label='员工信息')
            value['tables'][0]['columns'] = [
                {'name': 'employee_code', 'label': '员工编码', 'allow_output': True},
                {'name': 'unit_name', 'label': '单位名称', 'allow_output': True},
                {'name': 'frequency_name', 'label': '频度名称', 'allow_output': True},
            ]
            return value
        self.store.load_config = config
        result = self.gateway.quick_query('group', {
            'kind': 'source_dimension_counts', 'source_label': '员工信息',
            'dimension_labels': ['单位名称', '频度名称'], 'count_label': '员工编码',
        })
        sql = self.calls[-1][0]
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(sql.count('UNION ALL'), 1)
        self.assertIn('COUNT(DISTINCT `employee_code`)', sql)

    def test_catalog_receipt_navigates_exact_fields_without_reading_all_columns(self):
        original = self.store.load_config
        def config():
            value = original()
            value['tables'][0]['columns'].extend([
                {'name': 'period/~code', 'description': '期间存储编码', 'format': 'YYYYMM'},
                *({'name': f'unrelated_{i}', 'description': '不相关字段说明' * 100} for i in range(48))])
            return value
        self.store.load_config = config
        catalog = self.gateway.catalog('group', ['staff'])
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(io.StringIO()) as stream:
            output = Path(temporary)/'catalog.json'
            data_client.save_result(catalog, output)
            receipt = json.loads(stream.getvalue())
            saved = json.loads(output.read_text())
        self.assertEqual(saved, catalog)
        self.assertEqual(receipt['evidenceReceipt']['evidenceKinds']['satisfied'], ['source_summary'])
        self.assertNotIn('record_counts', receipt['evidenceReceipt']['evidenceKinds']['satisfied'])
        self.assertEqual(receipt['catalog_revision'], saved['catalog_revision'])
        fields = receipt['read_contract']['source_fields']['staff']
        for name in ('amount', 'period/~code'):
            node = saved
            for token in fields[name].split('/')[1:]:
                token = token.replace('~1', '/').replace('~0', '~')
                node = node[int(token)] if isinstance(node, list) else node[token]
            self.assertEqual(node, next(c for c in saved['tables'][0]['columns'] if c['name'] == name))
            self.assertLess(len(json.dumps(node)), len(json.dumps(saved['tables'][0]['columns'])) // 10)
        self.assertNotIn('SECRET', json.dumps(receipt))

    def test_exact_sql_params_scope_and_audit_link_are_preserved(self):
        result = self.gateway.execute_sql("group", "SELECT amount FROM group.staff WHERE period=%s", ["202503"])
        self.assertEqual(self.calls, [("SELECT amount FROM group.staff WHERE period=%s", ["202503"], "group")])
        self.assertEqual(result["query_id"], self.store.audits[0]["run_id"])
        self.assertEqual(result["dataset"]["rows"], [{"amount": 2300}])
        self.assertIsNone(self.store.current)

    def test_probe_values_returns_source_bound_observation(self):
        result = self.gateway.probe_values('group', 'staff', 'amount', 3)
        self.assertEqual(result['schema'], 'nl2sql.value-probe/v1')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['source_id'], 'staff')
        self.assertEqual(result['field'], 'amount')
        self.assertEqual(result['semantic_binding']['scope']['source_id'], 'staff')
        self.assertNotIn('global_coverage', result)
        self.assertIn('GROUP BY', self.calls[-1][0])

    def test_scoped_probe_observes_period_shapes_without_mixing_entities_or_metrics(self):
        original = self.store.load_config
        def config():
            value = original()
            value['tables'][0]['columns'] = [{'name': name} for name in
                ('account', 'item', 'period', 'time_type', 'unit')]
            return value
        self.store.load_config = config
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.execute("ATTACH DATABASE ':memory:' AS `group`")
            db.execute('CREATE TABLE `group`.staff (account TEXT, item TEXT, period TEXT, time_type TEXT, unit TEXT)')
            db.executemany('INSERT INTO `group`.staff VALUES (?,?,?,?,?)', [
                ('A', '利润', '202601', 'M', '元/吨'),
                ('A', '利润', '202601', 'M', '元/吨'),
                ('A', '利润', '20260101', 'D', '元/吨'),
                ('B', '利润', '20260102', 'D', '万元'),
                ('A', '成本', '202501', 'M', '元/吨'),
            ])
            def execute(sql, params, config):
                rows = [dict(row) for row in db.execute(sql.replace('%s', '?'), params)]
                return {'rows': rows, 'row_count': len(rows)}
            self.gateway.execute = execute
            filters = [{'field': 'account', 'operator': 'eq', 'values': ['A']},
                       {'field': 'item', 'operator': 'in', 'values': ['利润']}]
            options = {'filters': filters, 'group_by': ['time_type', 'unit']}
            with tempfile.TemporaryDirectory() as temporary, patch.object(data_client, 'load_gateway', return_value=self.gateway), redirect_stdout(io.StringIO()):
                output = Path(temporary) / 'probe.json'
                code = data_client.main(['probe-values', '--scenario-id', 'group', '--source-id', 'staff',
                                        '--field', 'period', '--limit', '10',
                                        '--request-json', json.dumps(options), '--output', str(output)])
                result = json.loads(output.read_text())
            self.assertEqual(code, 0)
            self.assertEqual(result['values'], [
                {'value': '202601', 'time_type': 'M', 'unit': '元/吨', 'frequency': 2},
                {'value': '20260101', 'time_type': 'D', 'unit': '元/吨', 'frequency': 1},
            ])
            self.assertEqual(result['filters'], filters)
            self.assertEqual(result['evidence']['params'], ['A', '利润'])
            self.assertEqual(result['semantic_binding']['status'], 'observed_only')
            self.assertFalse(result['truncated'])

    def test_probe_refuses_unknown_fields_sql_fragments_and_unbounded_options(self):
        for options in (
            {'sql': 'SELECT amount FROM staff'},
            {'group_by': ['unknown']},
            {'group_by': ['a', 'b', 'c', 'd']},
            {'filters': [{'field': 'amount; DROP TABLE staff', 'operator': 'eq', 'values': [1]}]},
            {'filters': [{'field': 'amount', 'operator': 'raw', 'values': [1]}]},
            {'filters': [{'field': 'amount', 'operator': 'eq', 'values': [1, 2]}]},
        ):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.gateway.probe_values('group', 'staff', 'amount', 3, options)
        self.assertEqual(self.calls, [])

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

    def test_cli_persists_actionable_binding_failure_without_success_evidence(self):
        from query_errors import QueryParameterError
        def fail(*args):
            raise QueryParameterError("unsupported_parameter_style", "Use %s placeholders and params")
        self.gateway.execute = fail
        code, saved, receipt = self.invoke(body={
            "sql": "SELECT amount FROM group.staff WHERE period=$1", "params": ["202606"]})
        self.assertEqual(code, 1)
        self.assertEqual(saved["status"], "rejected")
        self.assertEqual(saved["error"]["diagnostic"]["code"], "unsupported_parameter_style")
        self.assertEqual(saved["error"]["diagnostic"]["phase"], "query.bind")
        self.assertEqual(receipt["content"]["error"], saved["error"])
        self.assertNotIn("evidenceReceipt", receipt)

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
        self.assertEqual(receipt['read_contract']['inline_root'], '/content')
        self.assertEqual(receipt['read_contract']['file_pointers']['rows'], '/dataset/rows')
        self.assertNotIn('/content', receipt['read_contract']['file_pointers'].values())
        large = {**saved, "dataset": {"columns": ["amount"], "rows": [{"amount": i} for i in range(700)], "row_count": 700}}
        code, saved, receipt = self.invoke(large)
        self.assertEqual(code, 0)
        self.assertEqual(len(saved["dataset"]["rows"]), 700)
        self.assertFalse(receipt["content_complete"])
        self.assertNotIn("content", receipt)
        self.assertNotIn('dataset_complete', receipt)
        # Large plan evidence must not force another read for a small answer.
        code, saved, receipt = self.invoke({**saved, 'query_plan': {'evidence': 'x' * 7000},
                                           'dataset': {'columns': ['amount'], 'rows': [{'amount': 23}], 'row_count': 1}})
        self.assertEqual(code, 0)
        self.assertFalse(receipt['content_complete'])
        self.assertTrue(receipt['dataset_complete'])
        self.assertEqual(receipt['dataset'], saved['dataset'])
        self.assertEqual(receipt['read_contract']['inline_dataset_root'], '/dataset')

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
        configured = {"catalog_database_url": "tidb://catalog:secret@localhost/catalog",
                      "query_databases": {"group": {"query_url": "tidb://readonly:secret@localhost/business", "allowed_relations": ["group.staff"]}}}
        with patch.object(runtime_config, "connections", return_value=configured):
            loaded = load_gateway()
        self.assertEqual(loaded.store.__class__.__module__, "gateway.store")
        self.assertTrue(loaded.execute.__module__.startswith("gateway."))
        self.assertFalse(any(n == "app" or n.startswith("app.") for n in sys.modules))

    def test_runtime_readonly_connection_copy_is_read_without_chmod(self):
        configured = {"catalog_database_url": "tidb://catalog:secret@localhost/catalog",
                      "query_databases": {"group": {"query_url": "tidb://readonly:secret@localhost/business", "allowed_relations": ["group.staff"]}}}
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
        literal = "SELECT '%s%', 7 % 2 FROM group.staff"
        self.assertEqual(_driver_query(literal, []), (literal, None))


class ConfiguredScenarioScopeTest(unittest.TestCase):
    def setUp(self):
        from gateway.store import CatalogStore
        from gateway.scenarios import scenario_scope
        from gateway.query_policy import QueryPolicyError
        configured = {"catalog_database_url": "tidb://root@localhost/catalog",
                      "query_databases": {"group": {"query_url": "tidb://root@localhost/business",
                                                    "allowed_relations": ["group.staff"]}}}
        self.store = CatalogStore(configured)
        self.physical = unittest.mock.Mock()
        self.execute = unittest.mock.Mock()
        self.gateway = Gateway(self.store, scenario_scope, self.physical, self.execute, QueryPolicyError)

    def test_catalog_directory_only_exposes_configured_group_even_if_demo_exists_in_database(self):
        with patch.object(self.store, "connect") as connect:
            cursor = connect.return_value.__enter__.return_value
            cursor.fetchall.return_value = [
                {"id": "demo", "name": "演示", "description": "unconfigured"},
                {"id": "group", "name": "集团经营分析", "description": "configured"}]
            scenarios = self.gateway.scenarios()
        self.assertEqual(scenarios, [{"id": "group", "name": "集团经营分析", "description": "configured"}])

    def test_demo_metadata_entity_resolution_and_queries_are_rejected_before_database_access(self):
        with patch.object(self.store, "connect") as connect:
            for action in (
                lambda: self.gateway.catalog("demo"),
                lambda: self.gateway.resolve_entity("demo", {"source_id": "staff", "mention": "test"}),
                lambda: self.gateway.execute_sql("demo", "SELECT amount FROM group.staff", []),
            ):
                with self.subTest(action=action), self.assertRaises(ValueError):
                    action()
            connect.assert_not_called()
            self.physical.assert_not_called()
            self.execute.assert_not_called()

    def test_declared_catalog_action_binds_group_without_requesting_a_scenario_choice(self):
        root = Path(__file__).resolve().parent.parent
        manifest = json.loads((root/"agentloop.executors.json").read_text())
        action = next(a for e in manifest["executors"] for a in e["actions"] if a["id"] == "retrieve-knowledge")
        question = "宝山 2022 年 1 月份的两金周转天数"
        gateway = unittest.mock.Mock()
        gateway.knowledge.return_value = {"schema": "nl2sql.semantic-metadata/v1", "scenario_id": "group", "sources": {"items": []}}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)/"catalog.json"
            values = {"request-json": json.dumps({'question': question}), "output": str(output)}
            args = [values.get(arg[2:-2], arg) if arg.startswith("{{") else arg for arg in action["args"]]
            with patch.object(data_client, "load_gateway", return_value=gateway), redirect_stdout(io.StringIO()) as stream:
                code = data_client.main(args)
            self.assertEqual(code, 0)
            gateway.knowledge.assert_called_once_with('retrieve-knowledge', "group", {'question': question})
            gateway.scenarios.assert_not_called()
            self.assertNotIn("humanLoopRequirement", json.loads(stream.getvalue()))
            self.assertEqual(json.loads(output.read_text())["scenario_id"], "group")


if __name__ == "__main__":
    unittest.main()

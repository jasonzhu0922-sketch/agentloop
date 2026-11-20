"""Opt-in checks of configured TiDB catalogs and query policy with any account.

DATA_ANALYSIS_TIDB_LIVE=1 python3 -B scripts/test_tidb_live.py
Business data is read-only; ordinary query audit rows are written by the Skill.
"""
import json
import os
import sys
import unittest
sys.dont_write_bytecode = True

from data_access import load_gateway
from runtime_config import connections


@unittest.skipUnless(os.environ.get("DATA_ANALYSIS_TIDB_LIVE") == "1", "explicit live TiDB opt-in required")
class TiDBLiveTest(unittest.TestCase):
    def setUp(self):
        self.config = connections()
        self.gateway = load_gateway()

    def test_readonly_queries_work_for_configured_accounts(self):
        for scenario, binding in self.config['query_databases'].items():
            table = binding['allowed_relations'][0]
            with self.subTest(scenario=scenario):
                result = self.gateway.execute_sql(scenario, f'SELECT 1 AS sample FROM {table} LIMIT 1', [])
                self.assertEqual(result['status'], 'completed', result.get('error'))
                self.assertLessEqual(result['dataset']['row_count'], 1)

    def test_group_is_the_only_scenario_and_has_complete_catalog_and_dialect(self):
        scenarios = self.gateway.scenarios()
        self.assertEqual(set(self.config["query_databases"]), {"group"})
        self.assertEqual([row["id"] for row in scenarios], ["group"])
        for row in scenarios:
            with self.subTest(scenario=row["id"]):
                catalog = self.gateway.catalog(row["id"])
                names = {table["schema"] + "." + table["name"] for table in catalog["tables"]}
                self.assertEqual(names, set(self.config["query_databases"][row["id"]]["allowed_relations"]))
                self.assertEqual(catalog["sql_dialect"], "mysql")
                self.assertTrue(catalog["metric_index"])
                self.assertTrue(catalog["term_index"])
                self.assertTrue(catalog["relationships"])
                detail = self.gateway.catalog(row["id"], [catalog["tables"][0]["name"]])
                self.assertTrue(detail["tables"][0]["columns"])
                self.assertEqual(catalog["catalog_revision"], detail["catalog_revision"])

    def test_persisted_knowledge_reaches_the_real_catalog_and_selected_source(self):
        with self.gateway.store.connect() as cursor:
            cursor.execute("SELECT id, config FROM scenarios ORDER BY id")
            rows = cursor.fetchall()
        for row in rows:
            if row['id'] not in self.config['query_databases']:
                continue
            with self.subTest(scenario=row['id']):
                raw = json.loads(row['config']) if isinstance(row['config'], (str, bytes)) else row['config']
                catalog = self.gateway.catalog(row['id'], question='业务指标与期间')
                sources = {t['name'] for t in catalog['tables']}
                self.assertEqual(catalog['metric_index'], [
                    {k: m[k] for k in ('name', 'label', 'table') if k in m}
                    for m in raw.get('metrics', []) if m.get('table') in sources])
                self.assertEqual(catalog['term_index'], [
                    {k: t[k] for k in ('term', 'aliases') if k in t}
                    for t in raw.get('terms', [])])
                self.assertEqual(len(catalog['retrieval']), len(sources))
                for key in ('entities', 'period_formats'):
                    self.assertEqual(len(catalog[key]), sum(d['source_id'] in sources for d in raw.get(key, [])))
                if 'timezone' in raw:
                    self.assertEqual(catalog['timezone'], raw['timezone'])
                for source in sorted(sources):
                    detail = self.gateway.catalog(row['id'], [source])
                    self.assertEqual(catalog['catalog_revision'], detail['catalog_revision'])
                    self.assertEqual(detail['metrics'], [m for m in raw.get('metrics', []) if m.get('table') == source])
                    for key in ('entities', 'period_formats'):
                        self.assertEqual(
                            [{k: v for k, v in d.items() if k != 'definition_status'} for d in detail[key]],
                            [d for d in raw.get(key, []) if d['source_id'] == source])
                    expected = [s for s in raw.get('table_summaries', []) if s['source_id'] == source
                                and next(t for t in catalog['tables'] if t['name'] == source)['understanding_status'] == 'current']
                    self.assertEqual(detail['table_summaries'], expected)
                for term in raw.get('terms', []):
                    expanded = self.gateway.catalog(row['id'], question=term['term'])
                    self.assertIn(term, expanded['terms'])
                    self.assertEqual(catalog['catalog_revision'], expanded['catalog_revision'])

    def test_unconfigured_scenarios_cannot_be_read_or_queried(self):
        for action in (
            lambda: self.gateway.catalog('demo'),
            lambda: self.gateway.execute_sql('demo', 'SELECT 1', []),
        ):
            with self.subTest(action=action), self.assertRaises(ValueError):
                action()

    def test_group_streaming_preserves_more_than_preview_size(self):
        sql = "SELECT COUNT(*) AS n FROM nl2sql_group.v_fawhzhss0401"
        count = self.gateway.execute_sql("group", sql, [])
        self.assertEqual(count["status"], "completed", count.get("error"))
        detail = self.gateway.catalog("group", ["v_fawhzhss0401"])
        column = next(c["name"] for c in detail["tables"][0]["columns"] if c["allow_output"])
        self.assertTrue(column.isidentifier() and column.isascii())
        result = self.gateway.execute_sql("group", f"SELECT `{column}` FROM nl2sql_group.v_fawhzhss0401 LIMIT 700", [])
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(result["dataset"]["row_count"], min(700, count["dataset"]["rows"][0]["n"]))
        self.assertEqual(len(result["dataset"]["rows"]), result["dataset"]["row_count"])

    def test_gateway_denies_writes_and_other_scenarios_for_configured_accounts(self):
        for scenario, binding in self.config["query_databases"].items():
            table = binding["allowed_relations"][0]
            unauthorized = next((relation
                for other in self.config["query_databases"].values()
                for relation in other['allowed_relations']
                if relation not in binding['allowed_relations']), 'information_schema.tables')
            for sql in (f"DELETE FROM {table} WHERE 1=0", f"SELECT 1 FROM {unauthorized} LIMIT 1"):
                with self.subTest(scenario=scenario, sql=sql):
                    result = self.gateway.execute_sql(scenario, sql, [])
                    self.assertEqual(result['status'], 'rejected')
                    self.assertEqual(result['error']['code'], 'query_policy_rejected')
                    self.assertEqual(result['error']['diagnostic']['phase'], 'query.validate')

    def test_policy_and_parameter_errors_remain_explicit(self):
        for sql, params, code in [
            ("SELECT 1", [], "query_policy_rejected"),
            ("SELECT COUNT(*) FROM information_schema.tables", [], "query_policy_rejected"),
            ("SELECT COUNT(*) AS n FROM nl2sql_group.v_fawhzhss0401 WHERE %s=%s", ["202201"], "query_parameter_invalid"),
        ]:
            with self.subTest(code=code):
                result = self.gateway.execute_sql("group", sql, params)
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(result["error"]["code"], code)
                self.assertNotIn("dataset", result)


if __name__ == "__main__":
    unittest.main()

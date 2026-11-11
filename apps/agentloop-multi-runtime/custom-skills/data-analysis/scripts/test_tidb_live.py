"""Opt-in checks of the configured TiDB Skill, including actual account grants.

DATA_ANALYSIS_TIDB_LIVE=1 python3 -B scripts/test_tidb_live.py
Business data is read-only; ordinary query audit rows are written by the Skill.
"""
import os
import sys
import unittest
sys.dont_write_bytecode = True

import pymysql
from data_access import load_gateway
from gateway.tidb_connection import connect
from runtime_config import connections


@unittest.skipUnless(os.environ.get("DATA_ANALYSIS_TIDB_LIVE") == "1", "explicit live TiDB opt-in required")
class TiDBLiveTest(unittest.TestCase):
    def setUp(self):
        self.config = connections()
        self.gateway = load_gateway()

    def test_both_migrated_scenarios_have_complete_catalogs_and_dialect(self):
        scenarios = self.gateway.scenarios()
        self.assertEqual({row["id"] for row in scenarios}, set(self.config["query_databases"]))
        for row in scenarios:
            with self.subTest(scenario=row["id"]):
                catalog = self.gateway.catalog(row["id"])
                names = {table["schema"] + "." + table["name"] for table in catalog["tables"]}
                self.assertEqual(names, set(self.config["query_databases"][row["id"]]["allowed_relations"]))
                self.assertEqual(catalog["sql_dialect"], "mysql")
                self.assertTrue(catalog["metrics"])
                self.assertTrue(catalog["terms"])
                self.assertTrue(catalog["relationships"])
                detail = self.gateway.catalog(row["id"], [catalog["tables"][0]["name"]])
                self.assertTrue(detail["tables"][0]["columns"])
                self.assertEqual(catalog["catalog_revision"], detail["catalog_revision"])

    def test_parameterized_dates_and_join_match_migrated_demo(self):
        sql = """SELECT o.region, COUNT(DISTINCT o.sales_order_id) AS orders,
                 SUM(i.quantity*i.unit_price) AS revenue
                 FROM nl2sql_demo.sales_orders o JOIN nl2sql_demo.sales_order_items i
                 ON o.sales_order_id=i.sales_order_id
                 WHERE o.status=%s AND o.sale_date>=CAST(%s AS DATE) AND o.sale_date<CAST(%s AS DATE)
                 GROUP BY o.region ORDER BY revenue DESC"""
        result = self.gateway.execute_sql("demo", sql, ["completed", "2026-06-01", "2026-07-01"])
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(result["dataset"]["row_count"], 5)
        self.assertEqual(sum(row["orders"] for row in result["dataset"]["rows"]), 360)
        self.assertAlmostEqual(sum(row["revenue"] for row in result["dataset"]["rows"]), 3397394.20, places=2)

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

    def test_actual_query_accounts_deny_writes_and_other_scenarios(self):
        for scenario, binding in self.config["query_databases"].items():
            with self.subTest(scenario=scenario), connect(binding["query_url"]) as connection, connection.cursor() as cursor:
                table = binding["allowed_relations"][0]
                # A zero-row statement proves database-level denial even when
                # the SQL policy is bypassed, without modifying business data.
                with self.assertRaises(pymysql.err.OperationalError) as denied:
                    cursor.execute(f"DELETE FROM {table} WHERE 1=0")
                self.assertEqual(denied.exception.args[0], 1142)
                other = next(v for k, v in self.config["query_databases"].items() if k != scenario)
                with self.assertRaises(pymysql.err.OperationalError) as denied:
                    cursor.execute(f"SELECT 1 FROM {other['allowed_relations'][0]} LIMIT 1")
                self.assertEqual(denied.exception.args[0], 1142)

    def test_policy_and_parameter_errors_remain_explicit(self):
        for sql, params, code in [
            ("SELECT 1", [], "query_policy_rejected"),
            ("SELECT COUNT(*) FROM nl2sql_group.v_fawhzhss0401", [], "query_policy_rejected"),
            ("SELECT sales_order_id FROM nl2sql_demo.sales_orders WHERE status=$1", ["completed"], "query_parameter_invalid"),
        ]:
            with self.subTest(code=code):
                result = self.gateway.execute_sql("demo", sql, params)
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(result["error"]["code"], code)
                self.assertNotIn("dataset", result)


if __name__ == "__main__":
    unittest.main()

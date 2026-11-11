"""Parameter and diagnostic regressions using the real PyMySQL binder, without a DB."""
from contextlib import nullcontext
from decimal import Decimal
import json
import sys
import unittest
from unittest.mock import MagicMock, patch
sys.dont_write_bytecode = True

import pymysql
from data_access import Gateway
from gateway import database
from gateway.query_policy import QueryPolicyError
from gateway.scenarios import scenario_scope


TABLE = "analytics.orders"


class QueryExecutionTest(unittest.TestCase):
    def setUp(self):
        self.store = MagicMock()
        self.store.get_scenario.return_value = {
            "id": "selected", "binding": {"allowed_relations": [TABLE]}}
        self.store.load_config.return_value = {"tables": []}
        self.gateway = Gateway(self.store, scenario_scope, lambda config: config,
                               database.execute_readonly, QueryPolicyError)

    def test_invalid_parameters_are_rejected_before_the_business_connection_opens(self):
        cases = [
            (f"SELECT region FROM {TABLE} WHERE status=$1 AND sale_date>=CAST($2 AS date)",
             ["completed", "2026-06-01"], "unsupported_parameter_style"),
            (f"SELECT region FROM {TABLE} WHERE status=%s", [], "parameter_count_mismatch"),
            (f"SELECT region FROM {TABLE} WHERE status=%s", ["one", "two"], "parameter_count_mismatch"),
            (f"SELECT region FROM {TABLE}", ["unused"], "parameter_count_mismatch"),
        ]
        for sql, params, code in cases:
            with self.subTest(code=code, sql=sql), patch.object(database, "query_connection") as connect:
                result = self.gateway.execute_sql("selected", sql, params)
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(result["error"]["code"], "query_parameter_invalid")
                self.assertEqual(result["error"]["diagnostic"]["phase"], "query.bind")
                self.assertEqual(result["error"]["diagnostic"]["code"], code)
                self.assertNotIn("dataset", result)
                connect.assert_not_called()
                audit = self.store.record_query_audit.call_args.args[0]
                self.assertEqual((audit["decision"], audit["reason"]), ("rejected", "parameter_binding"))

    def test_binder_preserves_casts_unicode_wildcards_modulo_and_quoted_placeholder_text(self):
        sql = (f"SELECT '$1 %s %成品%' AS label, 7 % 2 AS remainder FROM {TABLE} "
               "WHERE status=%s AND sale_date>=CAST(%s AS date) AND sale_date<CAST(%s AS date) AND region ILIKE %s")
        values = ["completed", "2026-06-01", "2026-07-01", "%华东%"]
        driver_sql, driver_params = database._driver_query(sql, values)
        connection = pymysql.Connection(defer_connect=True)
        connection.server_status = 0
        with connection.cursor() as cursor:
            bound_sql = cursor.mogrify(driver_sql, driver_params)
        self.assertIn("'$1 %s %成品%'", bound_sql)
        self.assertIn("7 % 2", bound_sql)
        self.assertIn("sale_date>=CAST('2026-06-01' AS date)", bound_sql)
        self.assertIn("sale_date<CAST('2026-07-01' AS date)", bound_sql)
        self.assertIn("region ILIKE '%华东%'", bound_sql)
        self.assertEqual(database._driver_query(f"SELECT '$1 %s' FROM {TABLE}", []),
                         (f"SELECT '$1 %s' FROM {TABLE}", None))

    def connection(self):
        connection, explain, results = MagicMock(), MagicMock(), MagicMock()
        connection.cursor.side_effect = [nullcontext(explain), nullcontext(results)]
        explain.fetchall.return_value = [{"id": "TableReader", "estRows": "2.00"}]
        results.description = [("revenue",)]
        results.fetchmany.side_effect = [[{"revenue": Decimal("12.30")}], []]
        return connection, explain, results

    def test_explain_and_result_execution_use_the_same_bound_request(self):
        connection, explain, results = self.connection()
        sql = f"SELECT SUM(amount) AS revenue FROM {TABLE} WHERE sale_date>=CAST(%s AS date)"
        params = ["2026-06-01"]
        # Real PyMySQL conversion is exercised at both database send boundaries.
        def bind(statement, values=None):
            if values is not None:
                raw = pymysql.Connection(defer_connect=True)
                raw.server_status = 0
                with raw.cursor() as cursor:
                    cursor.mogrify(statement, values)
        explain.execute.side_effect = bind
        results.execute.side_effect = bind
        with patch.object(database, "query_connection", return_value=nullcontext(connection)), \
             patch.object(database, "_validate_role"):
            result = self.gateway.execute_sql("selected", sql, params)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["dataset"]["rows"], [{"revenue": 12.3}])
        explain.execute.assert_any_call("EXPLAIN FORMAT='brief' " + sql, params)
        results.execute.assert_called_once_with(sql, params)
        self.assertEqual(self.store.record_query_audit.call_args.args[0]["decision"], "completed")

    def test_explain_execute_and_fetch_failures_keep_their_phase_without_raw_messages(self):
        for phase in ("query.explain", "query.execute", "result.fetch"):
            with self.subTest(phase=phase):
                connection, explain, results = self.connection()
                target = {"query.explain": explain.execute, "query.execute": results.execute,
                          "result.fetch": results.fetchmany}[phase]
                error = pymysql.err.ProgrammingError(1054, "password=SECRET; private row")
                if phase == "query.explain":
                    def fail_explain(statement, values=None):
                        if statement.startswith("EXPLAIN"):
                            raise error
                    target.side_effect = fail_explain
                else:
                    target.side_effect = error
                with patch.object(database, "query_connection", return_value=nullcontext(connection)), \
                     patch.object(database, "_validate_role"):
                    result = self.gateway.execute_sql("selected", f"SELECT amount FROM {TABLE}", [])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["diagnostic"]["phase"], phase)
                self.assertEqual(result["error"]["diagnostic"]["vendor_code"], 1054)
                self.assertNotIn("SECRET", json.dumps(result["error"]))
                self.assertNotIn("private row", json.dumps(result["error"]))
                self.assertNotIn("dataset", result)

    def test_connection_failure_preserves_wrapped_driver_code(self):
        driver = pymysql.err.OperationalError(1045, "tidb://user:SECRET@private-host/db")
        wrapper = RuntimeError("Unable to connect")
        wrapper.__cause__ = driver
        with patch.object(database, "query_connection", side_effect=wrapper):
            result = self.gateway.execute_sql("selected", f"SELECT amount FROM {TABLE}", [])
        self.assertEqual(result["error"]["diagnostic"]["phase"], "connection.open")
        self.assertEqual(result["error"]["diagnostic"]["vendor_code"], 1045)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("private-host", json.dumps(result))

    def test_sql_policy_rejection_is_distinct_from_binding_and_execution_failure(self):
        for sql in ("SELECT 1", f"SELECT sale_date FROM {TABLE} WHERE sale_date>=DATE $1",
                    "SELECT amount FROM other.orders"):
            with self.subTest(sql=sql), patch.object(database, "query_connection") as connect:
                result = self.gateway.execute_sql("selected", sql, [])
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(result["error"]["code"], "query_policy_rejected")
                self.assertEqual(result["error"]["diagnostic"]["phase"], "query.validate")
                connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()

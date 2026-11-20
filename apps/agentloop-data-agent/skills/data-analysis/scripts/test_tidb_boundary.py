"""Offline TiDB authorization, dialect and dependency boundary regressions."""
import builtins
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
sys.dont_write_bytecode = True

from data_access import Gateway, load_gateway
from gateway import database, table_catalog
from gateway.query_policy import QueryPolicyError, validate_query
from gateway.scenarios import scenario_scope
import runtime_config


class TiDBBoundaryTest(unittest.TestCase):
    def test_catalog_does_not_gate_account_grants_and_preserves_table_scope(self):
        allowed = {'id': 'selected', 'binding': {'allowed_relations': ['analytics.orders']}}
        for grants in [
            ["GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION"],
            ["GRANT SELECT ON `analytics`.* TO 'reader'@'%'"],
            ["GRANT 'analyst'@'%' TO 'reader'@'%'"],
        ]:
            connection = MagicMock()
            cursor = connection.cursor.return_value.__enter__.return_value
            def execute(sql, params=None):
                if sql == 'SHOW GRANTS':
                    cursor.fetchall.return_value = [{'grant': g} for g in grants]
                elif 'information_schema.columns' in sql:
                    cursor.fetchall.return_value = [
                        {'schema_name': 'analytics', 'name': name, 'column_name': 'amount',
                         'type': 'decimal(12,2)', 'description': '', 'column_description': ''}
                        for name in ('orders', 'private_orders')]
                else:
                    cursor.fetchall.return_value = []
            cursor.execute.side_effect = execute
            with self.subTest(grants=grants), scenario_scope(allowed):
                with patch.object(table_catalog, 'query_connection', return_value=nullcontext(connection)):
                    catalog = table_catalog.physical_catalog({})
                self.assertEqual([t['name'] for t in catalog['tables']], ['orders'])
                self.assertEqual(catalog['allowed_relations'], ['analytics.orders'])
                self.assertFalse(any(c.args[0] == 'SHOW GRANTS' for c in cursor.execute.call_args_list))

    def test_writes_and_out_of_scope_reads_are_rejected_before_opening_connection(self):
        store = MagicMock()
        store.get_scenario.return_value = {
            'id': 'selected', 'binding': {'allowed_relations': ['analytics.orders']}}
        store.load_config.return_value = {'tables': []}
        gateway = Gateway(store, scenario_scope, lambda config: config,
                          database.execute_readonly, QueryPolicyError)
        for sql in [
            'DELETE FROM analytics.orders WHERE 1=0',
            'UPDATE analytics.orders SET amount=0 WHERE 1=0',
            'INSERT INTO analytics.orders (amount) VALUES (0)',
            'DROP TABLE analytics.orders',
            'SELECT amount FROM other.orders',
            'SELECT amount FROM analytics.private_orders',
            'SELECT amount FROM analytics.orders; DELETE FROM analytics.orders',
        ]:
            with self.subTest(sql=sql), patch.object(database, 'query_connection') as connect:
                result = gateway.execute_sql('selected', sql, [])
                self.assertEqual(result['status'], 'rejected')
                self.assertEqual(result['error']['code'], 'query_policy_rejected')
                connect.assert_not_called()

    def test_mysql_date_functions_and_parameter_parser_preserve_safe_queries(self):
        with scenario_scope({'id': 'selected', 'binding': {'allowed_relations': ['analytics.orders']}}):
            for sql in [
                "SELECT DATE_FORMAT(sale_date,'%Y-%m') AS month FROM analytics.orders WHERE status=%s",
                "SELECT DATE_ADD(sale_date,INTERVAL 1 MONTH) AS next_month FROM analytics.orders",
                "SELECT YEAR(sale_date), DATEDIFF(CURRENT_DATE,sale_date) FROM analytics.orders",
                "SELECT region FROM analytics.orders WHERE region LIKE %s AND sale_date>=CAST(%s AS DATE)",
            ]:
                with self.subTest(sql=sql):
                    validate_query(sql)
            for sql in [
                "SELECT /*!50000 SLEEP(2) */ region FROM analytics.orders",
                "SELECT /*+ SET_VAR(max_execution_time=0) */ region FROM analytics.orders",
                "SELECT @x:=region FROM analytics.orders",
                "SELECT SLEEP(1) FROM analytics.orders",
                "SELECT region FROM analytics.orders FOR UPDATE",
                "SELECT region INTO OUTFILE '/tmp/leak' FROM analytics.orders",
                "SELECT region FROM analytics.orders; DELETE FROM analytics.orders",
            ]:
                with self.subTest(sql=sql), self.assertRaises(QueryPolicyError):
                    validate_query(sql)

    def test_skill_loads_with_postgresql_imports_forbidden(self):
        configured = {'catalog_database_url': 'tidb://catalog:secret@localhost:4000/catalog',
                      'query_databases': {'selected': {'query_url': 'tidb://reader:secret@localhost:4000/analytics',
                                                     'allowed_relations': ['analytics.orders']}}}
        original_import = builtins.__import__
        def import_without_postgres(name, *args, **kwargs):
            if name.split('.')[0] in ('psycopg', 'psycopg_pool'):
                raise AssertionError('PostgreSQL must not be a runtime dependency')
            return original_import(name, *args, **kwargs)
        with patch.object(builtins, '__import__', side_effect=import_without_postgres), \
             patch.object(runtime_config, 'connections', return_value=configured):
            self.assertEqual(type(load_gateway().store).__name__, 'CatalogStore')

    def test_configuration_refuses_postgres_instead_of_silently_using_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary)/'connections.json'
            config.write_text(json.dumps({'catalog_database_url': 'postgresql://private:secret@localhost/catalog',
                                         'query_databases': {}}))
            with patch.object(runtime_config, 'CONNECTIONS_FILE', config):
                with self.assertRaises(runtime_config.ConnectionConfigurationError) as error:
                    runtime_config.connections()
                self.assertNotIn('secret', str(error.exception))


if __name__ == '__main__':
    unittest.main()

"""Offline TiDB authorization, dialect and dependency boundary regressions."""
import builtins
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
sys.dont_write_bytecode = True

from data_access import load_gateway
from gateway.database import _validate_role
from gateway.query_policy import QueryPolicyError, validate_query
from gateway.scenarios import scenario_scope
import runtime_config


class TiDBBoundaryTest(unittest.TestCase):
    def test_account_requires_exact_table_select_without_roles_or_writes(self):
        allowed = {'id': 'selected', 'binding': {'allowed_relations': ['analytics.orders']}}
        for grants, accepted in [
            (["GRANT USAGE ON *.* TO 'r'@'%'", "GRANT SELECT ON `analytics`.`orders` TO 'r'@'%'"], True),
            (["GRANT ALL PRIVILEGES ON *.* TO 'r'@'%'"], False),
            (["GRANT SELECT ON `analytics`.* TO 'r'@'%'"], False),
            (["GRANT SELECT, UPDATE ON `analytics`.`orders` TO 'r'@'%'"], False),
            (["GRANT SELECT ON `other`.`orders` TO 'r'@'%'"], False),
            (["GRANT SELECT ON `analytics`.`orders` TO 'r'@'%' WITH GRANT OPTION"], False),
            (["GRANT 'writer'@'%' TO 'r'@'%'"], False),
            ([], False),
        ]:
            connection = MagicMock()
            connection.cursor.return_value.__enter__.return_value.fetchall.return_value = [{'grant': g} for g in grants]
            with self.subTest(grants=grants), scenario_scope(allowed):
                if accepted:
                    _validate_role(connection)
                else:
                    with self.assertRaises(QueryPolicyError):
                        _validate_role(connection)

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

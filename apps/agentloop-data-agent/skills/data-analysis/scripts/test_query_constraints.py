"""A catalog definition must survive planning and constrain the actual SQL scan."""
import asyncio
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import httpx
import data_client
from data_access import Gateway
from data_api import create_app
from entity_binding import validate_plan, EntityBindingError
from test_catalog_knowledge import fixture


class QueryConstraintsTest(unittest.TestCase):
    def setUp(self):
        self.config = fixture()
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("ATTACH DATABASE ':memory:' AS business")
        self.db.execute('CREATE TABLE business.staff_report(org_code TEXT, org_name TEXT, period TEXT, item TEXT, amount REAL)')
        self.db.executemany('INSERT INTO business.staff_report VALUES (?,?,?,?,?)', [
            ('A', '华北', '202601', '在岗员工人数', 2), ('A', '华北', '202602', '在岗员工人数', 3),
            ('A', '华北', '202603', '在岗员工人数', 7), ('A', '华北', '202601', '离岗人数', 100),
            ('B', '华南', '202601', '在岗员工人数', 200)])
        self.executions, self.audits = [], []
        self.gateway = Gateway(self, self.scope, deepcopy, self.execute, ValueError)
        self.sql = ('SELECT SUM(amount) AS value FROM business.staff_report '
                    'WHERE org_code=%s AND item=%s AND period>=%s AND period<%s')
        self.params = ['A', '在岗员工人数', '202601', '202603']

    def tearDown(self):
        self.db.close()

    def get_scenario(self, scenario):
        return {'id': scenario}

    @contextmanager
    def scope(self, scenario):
        yield

    def load_config(self):
        return deepcopy(self.config)

    def record_query_audit(self, event):
        self.audits.append(event)

    def execute(self, sql, params, config):
        from gateway.query_parameters import parser_sql
        self.executions.append((sql, params))
        cursor = self.db.execute(parser_sql(sql), params)
        rows = [dict(row) for row in cursor.fetchall()]
        return {'columns': [c[0] for c in cursor.description], 'rows': rows, 'row_count': len(rows)}

    def plan(self, entity=False):
        catalog = self.gateway.catalog('group')
        plan = {'schema': 'nl2sql.query-plan/v1', 'scenario_id': 'group',
                'catalog_revision': catalog['catalog_revision'],
                'metric_bindings': [{'source_id': 'staff_report', 'metric_id': 'headcount'}],
                'time_bindings': [{'source_id': 'staff_report', 'field': 'period',
                                   'start': '2026-01-01', 'end': '2026-03-01'}]}
        if entity:
            resolved = self.gateway.resolve_entity('group', {'mention': '华北', 'canonical_name': '华北',
                                                          'source_id': 'staff_report', 'entity_id': 'organization'})
            plan['entity_bindings'] = resolved['query_plan']['entity_bindings']
        return plan

    def rejected(self, sql, params, code, plan=None):
        plan = self.plan() if plan is None else plan
        before = len(self.executions)
        result = self.gateway.execute_sql('group', sql, params, plan)
        self.assertEqual(result['status'], 'rejected', result)
        self.assertEqual(result['error']['diagnostic']['code'], code)
        self.assertEqual(result['error']['diagnostic']['phase'], 'query.plan')
        self.assertNotIn('dataset', result)
        self.assertEqual(len(self.executions), before)
        self.assertEqual(self.audits[-1]['reason'], code)

    def test_combined_plan_filters_real_rows_and_retains_definitions_and_evidence(self):
        plan = self.plan(entity=True)
        result = self.gateway.execute_sql('group', self.sql, self.params, plan)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['dataset']['rows'], [{'value': 5.0}])
        self.assertEqual(result['query_plan'], plan)
        verification = result['plan_verification']
        self.assertEqual(len(verification['entity_checks']), 1)
        self.assertEqual(verification['metric_checks'][0]['definition'], self.config['metrics'][0])
        self.assertEqual(verification['time_checks'][0]['storage_end'], '202603')
        self.assertIn('metric_expression', verification['agent_review_required'])

    def test_wrong_project_and_bypasses_are_rejected_before_execution(self):
        for sql, params in [
            (self.sql, ['A', '员工人数', '202601', '202603']),
            (self.sql.replace('item=%s', 'item LIKE %s'), self.params),
            (self.sql + ' OR amount>0', self.params),
            (self.sql + ' UNION ALL SELECT SUM(amount) FROM business.staff_report', self.params),
            ('WITH c AS (SELECT * FROM business.staff_report) SELECT SUM(amount) FROM c '
             'WHERE org_code=%s AND item=%s AND period>=%s AND period<%s', self.params),
        ]:
            with self.subTest(sql=sql):
                self.rejected(sql, params, 'metric_sql_mismatch')

    def test_wrong_time_encoding_ranges_and_bypasses_are_rejected(self):
        for sql, params in [
            (self.sql, ['A', '在岗员工人数', '2026-01-01', '2026-03-01']),
            (self.sql, ['A', '在岗员工人数', '202601', '202604']),
            (self.sql.replace(' AND period<%s', ''), self.params[:-1]),
            (self.sql.replace('period>=%s AND period<%s', '(period>=%s AND period<%s OR amount>0)'), self.params),
            (self.sql.replace('period>=%s', 'period>CAST(%s AS DATE)'), self.params),
            (self.sql.replace('period>=%s', 'period>=CAST(%s AS DATE)'), self.params),
        ]:
            with self.subTest(sql=sql):
                self.rejected(sql, params, 'time_sql_mismatch')
        # Every UNION branch and every physical alias needs its own range.
        plan = self.plan(); plan.pop('metric_bindings')
        self.rejected(self.sql + ' UNION ALL SELECT SUM(amount) FROM business.staff_report',
                      self.params, 'time_sql_mismatch', plan)
        self.rejected('SELECT a.amount FROM business.staff_report a JOIN business.staff_report b ON a.org_code=b.org_code '
                      'WHERE b.period>=%s AND b.period<%s', ['202601', '202603'], 'time_sql_mismatch', plan)

    def test_cte_with_physical_filters_and_reversed_bounds_is_accepted(self):
        sql = ('WITH c AS (SELECT amount FROM business.staff_report s WHERE s.item=%s '
               'AND %s<=s.period AND %s>s.period AND s.org_code=%s) SELECT SUM(amount) AS value FROM c')
        result = self.gateway.execute_sql('group', sql, ['在岗员工人数', '202601', '202603', 'A'], self.plan())
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['dataset']['rows'], [{'value': 5.0}])

    def test_disjoint_periods_are_verified_in_one_query_without_extra_tool_rounds(self):
        plan = self.plan()
        plan['time_bindings'] = [
            {'source_id': 'staff_report', 'field': 'period', 'start': '2026-01-01', 'end': '2026-02-01'},
            {'source_id': 'staff_report', 'field': 'period', 'start': '2026-03-01', 'end': '2026-04-01'}]
        sql = ('SELECT SUM(amount) AS value FROM business.staff_report WHERE org_code=%s AND item=%s '
               'AND ((period>=%s AND period<%s) OR (period>=%s AND period<%s))')
        params = ['A', '在岗员工人数', '202601', '202602', '202603', '202604']
        result = self.gateway.execute_sql('group', sql, params, plan)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['dataset']['rows'], [{'value': 9.0}])
        self.assertEqual(len(self.executions), 1)
        self.rejected(sql, params[:-1] + ['202605'], 'time_sql_mismatch', plan)

    def test_missing_format_is_explicit_and_does_not_guess_from_description(self):
        self.config['period_formats'] = []
        column = self.config['tables'][0]['columns'][2]
        column['description'] = '年月编码 YYYYMM，如202601'
        self.rejected(self.sql, self.params, 'time_definition_missing')
        self.config['period_formats'] = fixture()['period_formats']
        plan = self.plan(); plan['time_bindings'][0]['start'] = '2026-01-02'
        self.rejected(self.sql, self.params, 'time_binding_invalid', plan)

    def test_native_date_boundary_casts_are_checked_without_claiming_formula_verification(self):
        self.config['period_formats'] = []
        self.config['tables'][0]['columns'][2]['type'] = 'date'
        plan = self.plan()
        catalog = self.gateway.catalog('group', ['staff_report'])
        sql = self.sql.replace('period>=%s AND period<%s', 'period>=CAST(%s AS DATE) AND period<CAST(%s AS DATE)')
        verification = validate_plan(catalog, sql, ['A', '在岗员工人数', '2026-01-01', '2026-03-01'], plan)
        self.assertEqual(verification['time_checks'][0]['storage_start'], '2026-01-01')
        self.assertIn('aggregation_grain', verification['agent_review_required'])

    def test_numeric_months_and_text_days_use_their_own_declared_storage_types(self):
        for native, fmt, grain, bounds in [('int', '%Y%m', 'month', [202601, 202603]),
                                          ('varchar(8)', '%Y%m%d', 'day', ['20260101', '20260301'])]:
            with self.subTest(native=native):
                self.config['tables'][0]['columns'][2]['type'] = native
                self.config['period_formats'][0].update(format=fmt, granularity=grain)
                plan = self.plan()
                catalog = self.gateway.catalog('group', ['staff_report'])
                verified = validate_plan(catalog, self.sql, self.params[:2] + bounds, plan)
                self.assertEqual(verified['time_checks'][0]['storage_start'], bounds[0])
                with self.assertRaises(EntityBindingError) as error:
                    validate_plan(catalog, self.sql, self.params, plan)
                self.assertEqual(error.exception.code, 'time_sql_mismatch')

    def test_metric_without_project_has_only_definition_verification(self):
        self.config['metrics'][0].pop('project')
        plan = self.plan(); plan.pop('time_bindings')
        sql = 'SELECT SUM(amount) AS value FROM business.staff_report'
        result = self.gateway.execute_sql('group', sql, [], plan)
        self.assertEqual(result['status'], 'completed', result)
        check = result['plan_verification']['metric_checks'][0]
        self.assertEqual(check['verification_scope'], 'catalog_definition')
        self.assertNotIn('metric_projects', result['plan_verification']['verification_scope'])

    def test_multiple_same_source_projects_keep_exact_values_in_one_query(self):
        other = deepcopy(self.config['metrics'][0])
        other.update(name='off_duty', label='离岗人数', project={'field': 'item', 'value': '离岗人数'})
        self.config['metrics'].append(other)
        plan = self.plan()
        plan['metric_bindings'].append({'source_id': 'staff_report', 'metric_id': 'off_duty'})
        sql = ('SELECT item, SUM(amount) AS value FROM business.staff_report WHERE org_code=%s '
               'AND item IN (%s,%s) AND period>=%s AND period<%s GROUP BY item ORDER BY value')
        params = ['A', '在岗员工人数', '离岗人数', '202601', '202603']
        result = self.gateway.execute_sql('group', sql, params, plan)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual([r['value'] for r in result['dataset']['rows']], [5.0, 100.0])
        self.rejected(sql, ['A', '在岗员工人数', '错误项目', '202601', '202603'], 'metric_sql_mismatch', plan)

    def test_malformed_unknown_and_empty_plans_are_rejected(self):
        for key, value, code in [('metric_bindings', [{'source_id': 'staff_report', 'metric_id': 'absent'}], 'metric_definition_invalid'),
                                  ('time_bindings', [None], 'time_binding_invalid'),
                                  ('time_bindings', {}, 'query_plan_invalid')]:
            plan = self.plan(); plan[key] = value
            self.rejected(self.sql, self.params, code, plan)
        plan = self.plan(); plan.pop('time_bindings'); plan.pop('metric_bindings')
        self.rejected(self.sql, self.params, 'query_plan_invalid', plan)

    def test_same_inline_plan_runs_through_cli_and_http_with_unambiguous_file_pointers(self):
        body = {'sql': self.sql, 'params': self.params, 'query_plan': self.plan()}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'result.json'
            with patch.object(data_client, 'load_gateway', return_value=self.gateway), redirect_stdout(io.StringIO()) as out:
                code = data_client.main(['execute', '--scenario-id', 'group', '--request-json', json.dumps(body), '--output', str(path)])
            self.assertEqual(code, 0)
            saved, receipt = json.loads(path.read_text()), json.loads(out.getvalue())
            self.assertEqual(saved['dataset']['rows'], [{'value': 5.0}])
            pointer = receipt['read_contract']['file_pointers']['rows']
            value = saved
            for part in pointer.strip('/').split('/'):
                value = value[part]
            self.assertEqual(value, saved['dataset']['rows'])
            self.assertEqual(receipt['plan_verification'], saved['plan_verification'])
        async def check():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(gateway=self.gateway)), base_url='http://skill') as client:
                response = await client.post('/api/data/execute', json={'scenario_id': 'group', **body})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['plan_verification'], saved['plan_verification'])
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()

"""Reproduce the Run's missed synonym using real SQL over a local fixture."""
from contextlib import contextmanager, redirect_stdout
import asyncio
from copy import deepcopy
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

from data_access import Gateway
import data_client
from data_api import create_app
from gateway.query_policy import QueryPolicyError
import httpx


class EntityBindingTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("ATTACH DATABASE ':memory:' AS business")
        self.db.execute('CREATE TABLE business.finance(company_code TEXT, company_name TEXT, period TEXT, amount REAL)')
        self.db.executemany('INSERT INTO business.finance VALUES (?,?,?,?)', [
            ('1001', '宝山钢铁股份有限公司', '202601', 2077317253.46),
            ('1001', '宝山钢铁股份有限公司', '202602', -510778771.45),
            ('9000', '其他公司', '202601', 123)])
        self.config = {
            'tables': [{'name': name, 'schema': 'business', 'columns': [{'name': f} for f in
                       ('company_code', 'company_name', 'period', 'amount')]} for name in ('finance', 'other')],
            'terms': [{'term': '宝钢股份', 'aliases': ['股份', '宝钢', '宝山钢铁'],
                       'meaning': '是宝山钢铁股份有限公司的简称'}],
            'entities': [{'id': 'entity:finance:company_code', 'source_id': 'finance',
                          'key_field': 'company_code', 'name_fields': ['company_name'], 'aliases': {}}]}
        self.audits, self.executions = [], []
        self.gateway = Gateway(self, self.scope, deepcopy, self.execute, QueryPolicyError)
        self.request = {'mention': '宝钢股份', 'matched_term': '宝钢股份',
                        'canonical_name': '宝山钢铁股份有限公司', 'source_id': 'finance',
                        'entity_id': 'entity:finance:company_code'}

    def tearDown(self):
        self.db.close()

    def get_scenario(self, scenario):
        if scenario != 'group':
            raise ValueError('unknown scenario')
        return {'id': scenario}

    @contextmanager
    def scope(self, scenario):
        yield

    def load_config(self):
        return deepcopy(self.config)

    def record_query_audit(self, event):
        self.audits.append(event)

    def execute(self, sql, params, config):
        self.executions.append((sql, params))
        from gateway.query_parameters import parser_sql
        cursor = self.db.execute(parser_sql(sql), params)
        rows = [dict(r) for r in cursor.fetchall()]
        return {'columns': [c[0] for c in cursor.description], 'rows': rows, 'row_count': len(rows)}

    def plan(self):
        return self.gateway.resolve_entity('group', self.request)['query_plan']

    def run_query(self, sql, params, plan=None):
        return self.gateway.execute_sql('group', sql, params, plan if plan is not None else self.plan())

    def assert_rejected(self, sql, params, code='entity_sql_mismatch', plan=None):
        plan = self.plan() if plan is None else plan
        before = len(self.executions)
        result = self.run_query(sql, params, plan)
        self.assertEqual(result['status'], 'rejected', result)
        self.assertEqual(result['error']['diagnostic']['code'], code)
        self.assertNotIn('dataset', result)
        self.assertEqual(len(self.executions), before)
        self.assertEqual(self.audits[-1]['decision'], 'rejected')
        return result

    def test_synonym_is_exposed_resolved_and_retained_through_actual_sql(self):
        catalog = self.gateway.catalog('group', question='宝钢股份上半年现金流')
        match = catalog['matched_terms'][0]
        self.assertEqual(match['term'], self.config['terms'][0]['term'])
        self.assertEqual(catalog['terms'][int(match['definition_pointer'].rsplit('/', 1)[1])], self.config['terms'][0])
        resolution = self.gateway.resolve_entity('group', self.request)
        self.assertEqual(resolution['status'], 'resolved')
        plan = resolution['query_plan']
        binding = plan['entity_bindings'][0]
        self.assertEqual(binding['selected_codes'], ['1001'])
        self.assertEqual(binding['matched_term']['meaning'], self.request['canonical_name'].join(['是', '的简称']))
        self.assertEqual(binding['lookup']['params'], [self.request['canonical_name']])
        self.assertNotIn('LIKE', binding['lookup']['sql'])
        sql = 'SELECT f.period, f.amount FROM business.finance f WHERE f.company_code=%s AND f.period>=%s ORDER BY f.period'
        result = self.run_query(sql, ['1001', '202601'], plan)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['dataset']['row_count'], 2)
        self.assertEqual(result['query_plan'], plan)
        check = result['plan_verification']['entity_checks'][0]
        self.assertEqual(check['lookup_query_id'], binding['lookup']['query_id'])
        self.assertEqual(check['canonical_name'], self.request['canonical_name'])
        self.assertEqual(self.executions[-1], (sql, ['1001', '202601']))

    def test_physical_entity_filter_is_allowed_without_entity_bindings(self):
        plan = self.plan()
        plan['entity_bindings'] = []
        sql = 'SELECT amount FROM business.finance WHERE company_code=%s'
        result = self.run_query(sql, ['1001'], plan)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['dataset']['row_count'], 2)
        self.assertEqual(result['plan_verification']['entity_checks'], [])

    def test_explicit_code_evidence_does_not_require_name_lookup(self):
        plan = self.plan()
        binding = plan['entity_bindings'][0]
        binding.pop('lookup')
        binding.pop('canonical_name')
        binding.pop('matched_term')
        binding.pop('mention')
        binding['selected_codes'] = ['1001']
        binding['selection_evidence'] = 'user-supplied physical org code'
        sql = 'SELECT amount FROM business.finance WHERE company_code=%s'
        result = self.run_query(sql, ['1001'], plan)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['plan_verification']['entity_checks'][0]['lookup_query_id'], None)

    def test_candidate_lookup_is_fuzzy_evidence_without_selected_codes(self):
        result = self.gateway.candidate_lookup('group', {
            'mention': '宝山', 'source_id': 'finance', 'entity_id': 'entity:finance:company_code'})
        self.assertEqual(result['schema'], 'nl2sql.entity-candidates/v1')
        self.assertEqual(result['candidate_lookup']['mode'], 'candidate_lookup')
        self.assertEqual(result['selected_codes'], [])
        self.assertIsNone(result['selection_evidence'])
        self.assertEqual(result['candidates'][0]['company_code'], '1001')

    def test_original_short_name_like_is_rejected_before_execution(self):
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM business.finance WHERE company_name LIKE '%宝钢%'").fetchone()[0], 0)
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_name LIKE %s', ['%宝钢%'])
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code LIKE %s', ['1001'])
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code=%s', ['9000'])
        self.assert_rejected('SELECT amount FROM business.finance', [])

    def test_derived_entity_scope_is_bound_to_indicator_filter(self):
        self.db.execute('ALTER TABLE business.finance ADD COLUMN index_name TEXT')
        self.db.execute("UPDATE business.finance SET index_name='吨钢EBITDA-制造基地' WHERE company_code='1001'")
        self.db.execute("UPDATE business.finance SET index_name='吨钢EBITDA' WHERE company_code='9000'")
        self.config['tables'][0]['columns'].append({'name': 'index_name'})
        self.config['entities'][0].update({
            'id': 'entity:finance:company_code:scope:index_name', 'label': '制造基地',
            'scope_filter': {'field': 'index_name', 'operator': 'like_any',
                             'patterns': ['%制造基地%', '基地%']},
        })
        request = {**self.request, 'entity_id': 'entity:finance:company_code:scope:index_name'}
        resolution = self.gateway.resolve_entity('group', request)
        self.assertEqual(resolution['status'], 'resolved')
        binding = resolution['query_plan']['entity_bindings'][0]
        self.assertEqual(binding['lookup']['params'], [request['canonical_name'], '%制造基地%', '基地%'])
        self.assertIn('`index_name` LIKE %s', binding['lookup']['sql'])
        sql = ('SELECT amount FROM business.finance WHERE company_code=%s '
               'AND (index_name LIKE %s OR index_name LIKE %s)')
        result = self.run_query(sql, ['1001', '%制造基地%', '基地%'], resolution['query_plan'])
        self.assertEqual(result['status'], 'completed', result)
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code=%s', ['1001'],
                             'entity_scope_sql_mismatch', resolution['query_plan'])

    def test_unrelated_entity_query_is_not_blocked_by_period_gap(self):
        self.config.update({
            'semantic_model_version': 'nl2sql.semantic-model/v1',
            'semantic_gaps': [{
                'gap_id': 'definition_gap:time:finance:period',
                'code': 'time_format_unresolved', 'status': 'unresolved',
                'blocking': True, 'affected_refs': ['time:finance:period'],
                'source_ids': ['finance'], 'evidence': [],
            }],
        })
        plan = self.plan()
        result = self.run_query(
            'SELECT amount FROM business.finance WHERE company_code=%s', ['1001'], plan)
        self.assertEqual(result['status'], 'completed', result)

        rejected = self.run_query(
            'SELECT amount FROM business.finance WHERE company_code=%s AND period>=%s',
            ['1001', '202601'], plan)
        self.assertEqual(rejected['status'], 'rejected', rejected)
        self.assertEqual(rejected['error']['diagnostic']['code'], 'semantic_gap_blocking')

    def test_hil_resolved_gap_is_carried_into_plan_verification(self):
        self.config.update({
            'semantic_model_version': 'nl2sql.semantic-model/v1',
            'semantic_gaps': [{
                'gap_id': 'company_price_scope_unresolved',
                'code': 'binding_missing', 'status': 'unresolved',
                'blocking': True, 'affected_refs': ['source:finance:finance'],
                'source_ids': ['finance'], 'evidence': [],
            }],
        })
        plan = self.plan()
        plan['resolved_gap_refs'] = ['company_price_scope_unresolved']
        plan['decision_refs'] = [{'request_id': 'hil-1', 'selected_option_id': 'market_price'}]
        result = self.run_query(
            'SELECT amount FROM business.finance WHERE company_code=%s AND period>=%s',
            ['1001', '202601'], plan)
        self.assertEqual(result['status'], 'completed', result)

    def test_term_scoped_source_gap_does_not_block_query_without_entity_predicate(self):
        self.config.update({
            'semantic_model_version': 'nl2sql.semantic-model/v1',
            'semantic_gaps': [{
                'gap_id': 'company_price_scope_unresolved',
                'code': 'binding_missing', 'status': 'unresolved',
                'blocking': True,
                # This mirrors the persisted catalog shape from 70508a5f:
                # source refs plus a term/trigger, with no explicit term ref.
                'affected_refs': ['source:finance:finance'],
                'source_ids': ['finance'], 'term': '日照钢铁',
                'trigger_terms': ['日照钢铁'], 'evidence': [],
            }],
        })
        plan = self.plan()
        gap = self.config['semantic_gaps'][0]
        plan['semantic_gap_refs'] = [gap['gap_id']]
        for binding in plan['semantic_bindings']:
            binding['gaps'] = [deepcopy(gap)]
        # The context can retain the question-triggered gap.  Once the user
        # selected market price, the executable SQL has no company predicate;
        # the source gap must therefore be scoped out without a synthetic HIL
        # resolution field.
        plan['entity_bindings'] = []
        result = self.run_query(
            'SELECT amount FROM business.finance WHERE period=%s', ['202601'], plan)
        self.assertEqual(result['status'], 'completed', result)
        blocked = self.run_query(
            'SELECT amount FROM business.finance WHERE company_code=%s', ['1001'], plan)
        self.assertEqual(blocked['status'], 'rejected', blocked)
        self.assertEqual(blocked['error']['diagnostic']['code'], 'semantic_gap_blocking')

    def test_full_entity_name_containing_object_alias_can_be_checked_exactly(self):
        self.db.execute('ALTER TABLE business.finance ADD COLUMN index_name TEXT')
        self.db.execute("UPDATE business.finance SET company_name='安宁基地', index_name='基地吨钢综合能耗' WHERE company_code='1001'")
        self.db.execute("UPDATE business.finance SET index_name='吨钢EBITDA' WHERE company_code='9000'")
        self.config['tables'][0]['columns'].append({'name': 'index_name'})
        self.config['terms'].append({'term': '制造基地', 'aliases': ['基地'],
                                     'meaning': '制造基地对象；account/account_name 分别是基地代码和基地名称'})
        self.config['entities'][0].update({
            'id': 'entity:finance:company_code:scope:index_name', 'label': '制造基地',
            'scope_filter': {'field': 'index_name', 'operator': 'like_any',
                             'patterns': ['%制造基地%', '基地%']},
        })
        request = {'mention': '安宁基地', 'canonical_name': '安宁基地',
                   'source_id': 'finance', 'entity_id': 'entity:finance:company_code:scope:index_name'}
        resolution = self.gateway.resolve_entity('group', request)
        self.assertEqual(resolution['status'], 'resolved')
        binding = resolution['query_plan']['entity_bindings'][0]
        self.assertEqual(binding['selected_codes'], ['1001'])
        self.assertEqual(binding['lookup']['params'], ['安宁基地', '%制造基地%', '基地%'])

    def test_only_actual_source_predicates_count_not_text_projection_or_bypassed_or(self):
        for sql, params in [
            ('SELECT %s AS company_code FROM business.finance', ['1001']),
            ('SELECT company_code=%s AS matches FROM business.finance', ['1001']),
            ('SELECT amount FROM business.finance WHERE company_code=%s OR amount>0', ['1001']),
            ('SELECT amount FROM business.finance WHERE NOT company_code=%s', ['1001']),
            ('SELECT amount FROM business.finance WHERE company_code=%s UNION ALL SELECT amount FROM business.finance', ['1001']),
            ('WITH c AS (SELECT * FROM business.finance) SELECT amount FROM c WHERE company_code=%s', ['1001']),
            ('SELECT f.amount FROM business.finance f JOIN business.other o ON f.company_code=o.company_code WHERE o.company_code=%s', ['1001']),
            ('SELECT f.amount FROM business.finance f JOIN business.other o ON f.company_code=o.company_code WHERE company_code=%s', ['1001']),
        ]:
            with self.subTest(sql=sql):
                self.assert_rejected(sql, params)

    def test_parameters_follow_lexical_order_across_select_cte_and_predicates(self):
        sql = ('WITH c AS (SELECT %s AS label, amount FROM business.finance f '
               'WHERE f.period>=%s AND %s=f.company_code) SELECT amount FROM c')
        result = self.run_query(sql, ['not-a-code', '202601', '1001'])
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['dataset']['row_count'], 2)
        self.assert_rejected(sql, ['1001', '202601', '9000'])

    def test_same_placeholder_like_text_in_literal_does_not_shift_parameters(self):
        sql = "SELECT '%s' AS label, amount FROM business.finance WHERE company_code IN (%s)"
        result = self.run_query(sql, ['1001'])
        self.assertEqual(result['plan_verification']['status'], 'verified')

    def test_stale_terms_catalog_wrong_scenario_and_forged_codes_are_rejected(self):
        plan = self.plan()
        for field, value, code in [('catalog_revision', 'old', 'query_plan_stale'),
                                   ('scenario_id', 'other', 'query_plan_stale')]:
            bad = deepcopy(plan); bad[field] = value
            self.assert_rejected('SELECT amount FROM business.finance WHERE company_code=%s', ['1001'], code, bad)
        bad = deepcopy(plan); bad['entity_bindings'][0]['selected_codes'] = ['9000']
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code=%s', ['9000'], 'entity_selection_invalid', bad)
        bad = deepcopy(plan); bad['entity_bindings'][0]['matched_term']['meaning'] = 'different'
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code=%s', ['1001'], 'entity_binding_stale', bad)

    def test_ambiguity_retains_all_candidates_and_requires_selection_evidence(self):
        self.db.execute('INSERT INTO business.finance VALUES (?,?,?,?)',
                        ('1002', self.request['canonical_name'], '202601', 1))
        resolution = self.gateway.resolve_entity('group', self.request)
        self.assertEqual(resolution['status'], 'ambiguous')
        self.assertEqual(set(resolution['candidate_codes']), {'1001', '1002'})
        plan = resolution['query_plan']
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code=%s', ['1001'], 'entity_selection_required', plan)
        plan['entity_bindings'][0]['selected_codes'] = ['1001', '1002']
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code IN (%s,%s)', ['1001','1002'], 'entity_selection_required', plan)
        plan['entity_bindings'][0]['selection_evidence'] = 'user-selected-both:hil-example'
        sql = 'SELECT amount FROM business.finance WHERE company_code=%s OR company_code=%s'
        result = self.run_query(sql, ['1001', '1002'], plan)
        self.assertEqual(result['status'], 'completed', result)
        self.assert_rejected('SELECT amount FROM business.finance WHERE company_code IN (%s)', ['1001'], plan=plan)

    def test_cli_resolution_file_is_consumed_as_plan_and_receipt_exposes_verification(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(data_client, 'load_gateway', return_value=self.gateway):
            resolution = Path(temp)/'resolution.json'; output = Path(temp)/'result.json'
            with redirect_stdout(io.StringIO()):
                code = data_client.main(['resolve-entity', '--scenario-id', 'group', '--request-json',
                                         json.dumps(self.request), '--output', str(resolution)])
            self.assertEqual(code, 0)
            body = {'sql': 'SELECT amount FROM business.finance WHERE company_code=%s', 'params': ['1001']}
            with redirect_stdout(io.StringIO()) as stream:
                code = data_client.main(['execute', '--scenario-id', 'group', '--request-json', json.dumps(body),
                                         '--query-plan', str(resolution), '--output', str(output)])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.read_text())['plan_verification']['status'], 'verified')
            self.assertEqual(json.loads(stream.getvalue())['plan_verification']['status'], 'verified')

    def test_http_uses_the_same_resolution_and_sql_verification(self):
        async def check():
            app = create_app(gateway=self.gateway)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://skill') as client:
                response = await client.post('/api/data/resolve-entity', json={'scenario_id': 'group', **self.request})
                self.assertEqual(response.status_code, 200)
                plan = response.json()['query_plan']
                body = {'scenario_id': 'group', 'sql': 'SELECT amount FROM business.finance WHERE company_code=%s',
                        'params': ['1001'], 'query_plan': plan}
                result = (await client.post('/api/data/execute', json=body)).json()
                self.assertEqual(result['status'], 'completed', result)
                self.assertEqual(result['plan_verification']['entity_checks'][0]['sql_codes'], ['1001'])
                bad = {**body, 'sql': 'SELECT amount FROM business.finance WHERE company_name LIKE %s', 'params': ['%宝钢%']}
                result = (await client.post('/api/data/execute', json=bad)).json()
                self.assertEqual(result['error']['code'], 'entity_binding_rejected')
        asyncio.run(check())

    def test_wrong_canonical_name_missing_term_and_invalid_entity_fail_without_query(self):
        from entity_binding import EntityBindingError
        for change, code in [({'canonical_name': '其他公司'}, 'canonical_name_unsupported'),
                             ({'matched_term': None}, 'matched_term_required'),
                             ({'entity_id': 'not-defined'}, 'entity_definition_invalid')]:
            with self.subTest(change=change), self.assertRaises(EntityBindingError) as error:
                self.gateway.resolve_entity('group', {**self.request, **change})
            self.assertEqual(error.exception.code, code)
            self.assertEqual(self.executions, [])

    def test_exact_unaliased_name_and_unmatched_result_do_not_invent_codes(self):
        request = {**self.request, 'mention': '其他公司', 'matched_term': None, 'canonical_name': '其他公司'}
        resolved = self.gateway.resolve_entity('group', request)
        self.assertEqual(resolved['candidate_codes'], ['9000'])
        request.update(mention='不存在公司', canonical_name='不存在公司')
        resolved = self.gateway.resolve_entity('group', request)
        self.assertEqual(resolved['status'], 'unmatched')
        self.assertEqual(resolved['query_plan']['entity_bindings'][0]['selected_codes'], [])


if __name__ == '__main__':
    unittest.main()

"""Regressions for persisted knowledge reaching the real Skill catalog boundary."""
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
import asyncio
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

import httpx
from catalog_knowledge import table_signature
from data_access import Gateway
from data_api import create_app
import data_client
from gateway.store import CatalogStore
from gateway.scenarios import scenario_scope


def fixture():
    def table(name, label, columns):
        return {'schema': 'business', 'name': name, 'label': label, 'description': label,
                'relation_type': 'table', 'columns': [
                    {'name': name, 'type': kind, 'label': '', 'description': description,
                     'value_domain': '', 'allow_output': True}
                    for name, kind, description in columns]}
    staff = table('staff_report', '月度人力报表', [
        ('org_code', 'varchar(30)', '组织编码'), ('org_name', 'varchar(100)', '组织名称'),
        ('period', 'varchar(6)', '年月'), ('item', 'varchar(100)', '报表项目'),
        ('amount', 'decimal(20,4)', '项目数值')])
    other = table('transactions', '交易记录', [('id', 'bigint', '交易号'), ('value', 'decimal(20,4)', '金额')])
    return {'tables': [staff, other],
            'metrics': [{'name': 'headcount', 'label': '员工人数', 'table': 'staff_report',
                         'expression': 'SUM(amount)', 'project': {'field': 'item', 'value': '在岗员工人数'},
                         'grain': ['period', 'org_code', 'item'], 'grain_evidence_id': 'grain_1',
                         'description': '月末人数，不跨月累加', 'evidence_ids': ['probe_1'],
                         'provenance': {'kind': 'ai_data_discovery', 'discovery_id': 'knowledge_1'}}],
            'terms': [{'term': '员工人数', 'aliases': ['职工总数'],
                       'meaning': 'staff_report.amount，限定 item=在岗员工人数',
                       'evidence_ids': ['probe_1'], 'provenance': {'discovery_id': 'knowledge_1'}}],
            'relationships': [{'id': 'staff_transaction',
                               'left': {'source_id': 'staff_report', 'fields': ['org_code']},
                               'right': {'source_id': 'transactions', 'fields': ['id']}}],
            'table_summaries': [{'source_id': 'staff_report', 'table_signature': table_signature(staff),
                                 'purpose': '人力结构月末快照', 'business_domain': '人力资源',
                                 'record_semantics': '组织、年月、项目的一条报表值',
                                 'row_grain': ['org_code', 'period', 'item'], 'grain_status': 'multiple_rows',
                                 'metric_fields': ['amount'], 'dimension_fields': ['item'],
                                 'time_fields': ['period'], 'entity_fields': ['org_code'],
                                 'business_terms': ['学历结构'], 'retrieval_hints': ['不同学历员工人数'],
                                 'metric_clues': [{'concept': '学历结构', 'measure_fields': ['amount'],
                                                   'selector_fields': ['item'], 'unit_fields': [],
                                                   'observed_values': [{'field': 'item', 'value': '博士', 'evidence_id': 'probe_1'}]}],
                                 'query_scenarios': ['各月学历结构趋势'], 'limitations': ['粒度尚非唯一'],
                                 'evidence_ids': ['probe_1'],
                                 'provenance': {'created_at': '2026-11-13T00:00:00Z', 'discovery_id': 'knowledge_1'}}],
            'entities': [{'id': 'organization', 'source_id': 'staff_report', 'key_field': 'org_code',
                          'name_fields': ['org_name'], 'aliases': {'组织简称': ['001', '002']}}],
            'period_formats': [{'source_id': 'staff_report', 'field': 'period', 'format': '%Y%m', 'granularity': 'month'}],
            'timezone': 'Asia/Shanghai', 'skills': [], 'dimensions': [], 'time_policies': [],
            'model': {'api_key': 'PRIVATE_MODEL'}, 'connection': {'url': 'PRIVATE_CONNECTION'},
            'knowledge_discoveries': [{'large_internal_report': 'PRIVATE_DISCOVERY_HISTORY'}]}


class KnowledgeTest(unittest.TestCase):
    def setUp(self):
        self.raw = fixture()
        self.store = CatalogStore({})
        @contextmanager
        def connect():
            raw = self.raw
            class Cursor:
                def execute(self, sql, params):
                    pass
                def fetchone(self):
                    return {'config': json.dumps(raw)}
            yield Cursor()
        self.store.connect = connect
        def scenario(identifier):
            if identifier != 'group':
                raise ValueError('Unknown scenario')
            return {'id': identifier}
        self.store.get_scenario = scenario
        self.gateway = Gateway(self.store, scenario_scope, deepcopy,
                               lambda *args: {'columns': ['value'], 'rows': [], 'row_count': 0}, ValueError)

    def test_storage_to_index_and_details_preserves_full_metric_and_term_contract(self):
        index = self.gateway.catalog('group', question='职工总数')
        details = self.gateway.catalog('group', ['staff_report'])
        for output in (index, details):
            self.assertEqual(output['metrics'], self.raw['metrics'])
            self.assertEqual(output['terms'], self.raw['terms'])
            self.assertEqual(output['timezone'], 'Asia/Shanghai')
            self.assertNotIn('PRIVATE_', json.dumps(output))
        self.assertNotIn('aliases', index['entities'][0])
        self.assertEqual(details['entities'][0]['aliases'], {'组织简称': ['001', '002']})
        self.assertEqual(details['period_formats'][0]['format'], '%Y%m')
        self.assertEqual(index['catalog_revision'], details['catalog_revision'])
        self.assertNotIn('columns', index['tables'][0])
        self.assertNotIn('metric_clues', index['table_summaries'][0])
        self.assertEqual(details['table_summaries'][0], self.raw['table_summaries'][0])
        self.assertEqual(details['table_summaries'][0]['grain_status'], 'multiple_rows')

    def test_summary_and_term_retrieval_ranks_without_hiding_unprepared_tables(self):
        for question in ('职工总数', '不同学历员工人数'):
            result = self.gateway.catalog('group', question=question)
            self.assertEqual(result['retrieval'][0]['source_id'], 'staff_report')
            self.assertTrue(result['retrieval'][0]['matched_clues'])
            self.assertEqual({t['name'] for t in result['tables']}, {'staff_report', 'transactions'})
            self.assertEqual(result['tables'][1]['understanding_status'], 'not_prepared')
        for i in range(12):
            self.raw['tables'].append({**deepcopy(self.raw['tables'][1]), 'name': f'other_{i}'})
        result = self.gateway.catalog('group', question='未知目标')
        self.assertEqual(len(result['retrieval']), 14)
        self.assertEqual(len(result['tables']), 14)

    def test_schema_drift_disables_old_profile_in_output_and_retrieval(self):
        self.raw['table_summaries'][0]['purpose'] = 'obsolete_secret_concept'
        self.raw['tables'][0]['columns'][0]['type'] = 'bigint'
        result = self.gateway.catalog('group', question='obsolete_secret_concept')
        self.assertEqual(result['tables'][0]['understanding_status'], 'stale')
        self.assertEqual(result['table_summaries'], [])
        self.assertNotIn('obsolete_secret_concept', json.dumps(result))
        self.assertTrue(all(r['score'] == 0 for r in result['retrieval']))
        self.assertEqual(result['metrics'], [])
        self.assertEqual(result['metric_index'][0]['name'], 'headcount')
        self.assertEqual(self.gateway.catalog('group', ['staff_report'])['metrics'], self.raw['metrics'])

    def test_question_and_source_projection_preserve_discovery_without_repeating_unrelated_definitions(self):
        self.raw['terms'].extend([
            {'term': '付款金额', 'aliases': ['支付'], 'meaning': 'transactions.value 的业务金额'},
            {'term': '某企业', 'aliases': ['简称'], 'meaning': '企业完整名称，需按本表实体查证'}])
        self.raw['metrics'].append({'name': 'payment', 'label': '付款金额', 'table': 'transactions', 'expression': 'SUM(value)'})
        index = self.gateway.catalog('group', question='职工总数')
        self.assertEqual(index['metrics'], self.raw['metrics'][:1])
        self.assertEqual(index['terms'], self.raw['terms'][:1])
        self.assertEqual(len(index['metric_index']), 2)
        self.assertEqual(len(index['term_index']), 3)
        self.assertEqual(len(index['tables']), 2)
        details = self.gateway.catalog('group', ['staff_report'], question='简称')
        self.assertEqual([t['term'] for t in details['terms']], ['员工人数', '某企业'])
        expanded = self.gateway.catalog('group', question='付款金额')
        self.assertEqual(expanded['terms'], self.raw['terms'][1:2])
        self.assertEqual(expanded['catalog_revision'], index['catalog_revision'])

    def test_canonical_term_wins_over_another_terms_alias_without_claiming_semantic_equivalence(self):
        self.raw['terms'].append({'term': '人力报表', 'aliases': ['员工人数'], 'meaning': '范围更广的报表'})
        exact = self.gateway.catalog('group', question='员工人数')['matched_terms']
        self.assertEqual([m['term'] for m in exact], ['员工人数'])
        self.assertEqual(exact[0]['definition_pointer'], '/terms/0')
        self.assertEqual(exact[0]['match_scope'], 'exact')
        context = self.gateway.catalog('group', question='查询员工人数趋势')['matched_terms']
        self.assertEqual(context[0]['match_scope'], 'context')

    def test_invalid_summary_fields_and_entity_period_bindings_are_diagnosed(self):
        self.raw['table_summaries'][0]['metric_clues'][0]['selector_fields'] = ['missing_item']
        self.raw['entities'][0]['key_field'] = 'missing_org'
        self.raw['period_formats'][0]['field'] = 'missing_period'
        result = self.gateway.catalog('group', ['staff_report'])
        self.assertEqual(result['tables'][0]['understanding_status'], 'invalid')
        self.assertEqual(result['table_summaries'], [])
        self.assertEqual(result['entities'][0]['definition_status'], 'invalid')
        self.assertEqual(result['period_formats'][0]['definition_status'], 'invalid')
        self.assertEqual({f for d in result['knowledge_diagnostics'] for f in d['missing_fields']},
                         {'missing_item', 'missing_org', 'missing_period'})

    def test_source_details_scope_knowledge_and_expose_only_related_table_identities(self):
        self.raw['entities'].append({'id': 'transaction', 'source_id': 'transactions',
                                     'key_field': 'id', 'name_fields': ['id']})
        self.raw['table_summaries'].append({'source_id': 'outside_scenario', 'purpose': 'PRIVATE_OUTSIDE'})
        self.raw['entities'].append({'source_id': 'outside_scenario', 'key_field': 'id'})
        output = self.gateway.catalog('group', ['staff_report'])
        self.assertEqual([t['name'] for t in output['tables']], ['staff_report'])
        self.assertEqual(len(output['entities']), 1)
        self.assertEqual(output['related_sources'], [{'name': 'transactions', 'schema': 'business', 'label': '交易记录'}])
        self.assertNotIn('PRIVATE_OUTSIDE', json.dumps(output))
        with self.assertRaises(ValueError):
            self.gateway.catalog('group', ['outside_scenario'])
        with self.assertRaises(ValueError):
            self.gateway.catalog('missing', question='员工人数')

    def test_revision_includes_all_business_knowledge_but_not_question_or_secret_settings(self):
        baseline = self.gateway.catalog('group')['catalog_revision']
        self.assertEqual(self.gateway.catalog('group', question='学历')['catalog_revision'], baseline)
        for key in ('table_summaries', 'entities', 'period_formats', 'metrics', 'terms'):
            original = deepcopy(self.raw[key])
            self.raw[key][0]['description'] = '定义已更新'
            self.assertNotEqual(self.gateway.catalog('group')['catalog_revision'], baseline, key)
            self.raw[key] = original
        self.raw['model']['api_key'] = 'NEW_PRIVATE_MODEL'
        self.assertEqual(self.gateway.catalog('group')['catalog_revision'], baseline)
        result = self.gateway.execute_sql('group', 'SELECT value FROM business.transactions', [])
        self.assertEqual(result['catalog_revision'], baseline)

    def test_duplicate_profiles_are_not_arbitrarily_selected(self):
        self.raw['table_summaries'].append(deepcopy(self.raw['table_summaries'][0]))
        result = self.gateway.catalog('group')
        self.assertEqual(result['tables'][0]['understanding_status'], 'invalid')
        self.assertEqual(result['table_summaries'], [])

    def test_cli_and_http_expose_the_same_ranked_catalog_and_full_details(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'catalog.json'
            with patch.object(data_client, 'load_gateway', return_value=self.gateway), redirect_stdout(io.StringIO()):
                self.assertEqual(data_client.main(['catalog', '--scenario-id', 'group', '--question', '学历结构',
                                                   '--output', str(path)]), 0)
            cli = json.loads(path.read_text())
        async def check():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(gateway=self.gateway)), base_url='http://skill') as client:
                response = await client.get('/api/data/catalog', params={'scenario_id': 'group', 'question': '学历结构'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), cli)
                details = (await client.get('/api/data/catalog', params={'scenario_id': 'group', 'source_id': 'staff_report'})).json()
                self.assertEqual(details['table_summaries'][0]['metric_clues'][0]['observed_values'][0]['value'], '博士')
                self.assertEqual(details['catalog_revision'], cli['catalog_revision'])
                self.assertEqual((await client.get('/api/data/catalog', params={'scenario_id': 'group', 'question': 'x' * 4001})).status_code, 422)
        asyncio.run(check())

    def test_invalid_search_does_not_read_the_catalog(self):
        with patch.object(self.store, 'get_scenario', side_effect=AssertionError('must not read')):
            for question in ('', '  ', 'x' * 4001):
                with self.assertRaises(ValueError):
                    self.gateway.catalog('group', question=question)


if __name__ == '__main__':
    unittest.main()

"""Semantic retrieval, selective I/O and SQL binding contracts at the Skill boundary."""
import asyncio
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import httpx
from test_catalog_knowledge import fixture
from catalog_knowledge import catalog_config
from data_access import Gateway
from data_api import create_app
import data_client
from entity_binding import EntityBindingError, validate_plan
from gateway.scenarios import scenario_scope
from gateway import table_catalog
from gateway import store as store_module
from semantic_retrieval import KnowledgeRequestError


class SemanticRetrievalTest(unittest.TestCase):
    def setUp(self):
        self.raw = fixture()
        self.store = MagicMock()
        self.store.get_scenario.return_value = {'id': 'group', 'binding': {
            'allowed_relations': ['business.staff_report', 'business.transactions']}}
        self.store.load_config.side_effect = lambda: catalog_config(self.raw)
        self.store.read_snapshot.side_effect = lambda identifier: (self.store.get_scenario(identifier), catalog_config(self.raw))
        self.physical_calls = []
        self.live = deepcopy(self.raw['tables'])
        def physical(config, source_ids=None):
            self.physical_calls.append(set(source_ids) if source_ids is not None else None)
            config = deepcopy(config)
            config['tables'] = [deepcopy(t) for t in self.live if source_ids is None or t['name'] in source_ids]
            return config
        self.gateway = Gateway(self.store, scenario_scope, physical, lambda *args: {}, ValueError)

    def read(self, action, **request):
        return self.gateway.knowledge(action, 'group', request)

    def context(self, **extra):
        return self.read('get-query-context', question='职工总数', source_ids=['staff_report'],
                         metric_refs=[{'source_id': 'staff_report', 'metric_id': 'headcount'}], **extra)

    def test_alias_retrieves_source_and_metric_before_any_physical_scan(self):
        result = self.read('retrieve-knowledge', question='职工总数')
        self.assertEqual(result['sources']['items'][0]['source_id'], 'staff_report')
        self.assertEqual(result['metrics']['items'][0]['metric_id'], 'headcount')
        self.assertEqual(result['terms'][0]['definition'], self.raw['terms'][0])
        self.assertEqual(result['schema_verification'], 'stored_snapshot_only')
        self.assertEqual(self.physical_calls, [])
        self.assertNotIn('PRIVATE_', json.dumps(result))
        metric = self.read('get-metrics', metric_refs=[{'source_id': 'staff_report', 'metric_id': 'headcount'}])['metrics'][0]
        self.assertEqual(metric['definition'], self.raw['metrics'][0])
        self.assertEqual(set(metric['required_fields']), {'amount', 'period', 'org_code', 'item'})
        self.assertEqual(self.physical_calls, [])

    def test_entity_recall_identifies_manufacturing_base_before_identity_probe(self):
        source = 'staff_report'
        for table in (self.raw['tables'][0], self.live[0]):
            table['columns'].append({'name': 'index_name', 'type': 'text', 'description': ''})
        self.raw['terms'].append({'term': '制造基地', 'aliases': ['基地'],
                                  'meaning': 'account/account_name 是基地代码和名称；index_name 命中基地类指标时成立。',
                                  'source_id': source})
        self.raw['entities'].append({'id': 'entity:staff_report:account:scope:index_name', 'source_id': source,
                                     'label': '制造基地', 'key_field': 'account',
                                     'name_fields': ['account_name'], 'recall_terms': ['制造基地', '基地'],
                                     'scope_filter': {'field': 'index_name', 'operator': 'like_any',
                                                      'patterns': ['%制造基地%', '基地%']},
                                     'definition_status': 'current'})
        result = self.read('retrieve-knowledge', question='查询八钢制造基地指标')
        self.assertEqual(result['entities']['items'][0]['entity_id'], 'entity:staff_report:account:scope:index_name')
        self.assertEqual(result['entities']['items'][0]['match_stage'], 'object_first')
        self.assertEqual(result['entity_recall']['order'][0], 'semantic_object')
        self.assertEqual(result['retrieval']['stages'][0], 'semantic_object_first')
        self.assertEqual(self.physical_calls, [])

    def test_generic_semantic_object_is_recalled_without_domain_type_registry(self):
        self.raw['semantic_objects'] = [{
            'object_id': 'entity:staff_report:account_code',
            'kind': 'entity',
            'identity': 'account_code',
            'source_id': 'staff_report',
            'semantic_role': 'dimension_key',
            'labels': ['任意对象'],
            'aliases': ['对象简称'],
            'status': 'confirmed',
            'completeness': 'complete',
            'evidence': ['manual:fixture'],
        }]
        self.raw['entities'].append({
            'id': 'account_code', 'source_id': 'staff_report', 'label': '任意对象',
            'key_field': 'org_code', 'name_fields': ['org_name'],
            'semantic_ref': 'entity:staff_report:account_code', 'definition_status': 'current',
        })
        result = self.read('retrieve-knowledge', question='查询任意对象')
        self.assertEqual(result['semantic_objects']['items'][0]['kind'], 'entity')
        self.assertEqual(result['semantic_objects']['items'][0]['semantic_role'], 'dimension_key')
        self.assertEqual(result['entities']['items'][0]['semantic_object_refs'], ['entity:staff_report:account_code'])

    def test_retrieval_can_expand_and_does_not_hide_zero_rank_sources(self):
        first = self.read('search-tables', question='未知问题', limit=1)
        second = self.read('search-tables', question='未知问题', limit=1, offset=first['sources']['next_offset'])
        self.assertEqual(first['sources']['total'], 2)
        self.assertFalse(first['sources']['complete'])
        self.assertEqual({first['sources']['items'][0]['source_id'], second['sources']['items'][0]['source_id']}, {'staff_report', 'transactions'})
        empty = self.read('retrieve-knowledge', question='不存在的业务定义')
        self.assertEqual(empty['gaps'][0]['code'], 'no_metric_definition_matched')

    def test_ambiguity_preserves_each_source_bound_metric_and_provenance(self):
        self.raw['metrics'].append({'name': 'headcount', 'label': '员工人数', 'table': 'transactions', 'expression': 'COUNT(id)'})
        output = self.read('search-metrics', question='员工人数')['metrics']
        self.assertEqual(output['total'], 2)
        self.assertEqual({m['source_id'] for m in output['items']}, {'staff_report', 'transactions'})
        result = self.read('retrieve-knowledge', question='员工人数')
        self.assertEqual(result['ambiguities'][0]['code'], 'multiple_metric_candidates')
        details = self.read('get-metrics', metric_refs=[{'source_id': 'staff_report', 'metric_id': 'headcount'}])
        self.assertEqual(details['metrics'][0]['definition']['provenance'], self.raw['metrics'][0]['provenance'])

    def test_context_fetches_selected_schema_and_retains_metric_selector_grain_and_relations(self):
        index = self.read('retrieve-knowledge', question='职工总数')
        context = self.context(catalog_revision=index['catalog_revision'])
        self.assertEqual(self.physical_calls, [{'staff_report'}])
        self.assertEqual(context['catalog_revision'], index['catalog_revision'])
        self.assertEqual(context['metrics'][0]['definition']['project'], {'field': 'item', 'value': '在岗员工人数'})
        self.assertEqual(context['metrics'][0]['definition']['grain'], ['period', 'org_code', 'item'])

    def test_source_gap_with_specific_term_does_not_block_unrelated_source_query(self):
        self.raw['semantic_gaps'] = [{
            'gap_id': 'price_binding_missing', 'code': 'binding_missing', 'status': 'unresolved',
            'blocking': True, 'source_ids': ['staff_report'],
            'affected_refs': ['source:staff_report:staff_report', 'term:staff_report:日照钢铁'],
            'trigger_terms': ['日照钢铁'], 'meaning': '需要确认价格口径',
        }]
        context = self.context()
        self.assertEqual(context['semantic_gaps'], [])
        plan = context['plan_seed']
        result = self.gateway.execute_sql('group', 'SELECT SUM(amount) AS n FROM business.staff_report WHERE item=%s',
                                          ['在岗员工人数'], plan)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(context['relationships'][0]['right']['source_id'], 'transactions')
        self.assertEqual(context['plan_seed']['metric_bindings'], [{'source_id': 'staff_report', 'metric_id': 'headcount'}])
        self.assertIn('staff_report', context['plan_seed']['source_signatures'])
        fields = {c['name']: c for c in context['tables'][0]['columns']}
        self.assertIn('metric_selector', fields['item']['semantic_roles'])
        self.assertIn('period', fields['period']['semantic_roles'])
        self.assertIn('entity_key', fields['org_code']['semantic_roles'])
        catalog = self.gateway.catalog('group', ['staff_report'])
        plan = context['plan_seed']
        sql = 'SELECT SUM(amount) AS n FROM business.staff_report WHERE item=%s'
        self.assertEqual(validate_plan(catalog, sql, ['在岗员工人数'], plan)['status'], 'verified')
        with self.assertRaises(EntityBindingError):
            validate_plan(catalog, 'SELECT SUM(amount) AS n FROM business.staff_report', [], plan)
        complete = self.gateway.catalog('group', ['staff_report', 'transactions'])
        with self.assertRaises(EntityBindingError) as error:
            validate_plan(complete, 'SELECT SUM(s.amount) FROM business.staff_report s JOIN business.transactions t ON s.org_code=t.id WHERE s.item=%s', ['在岗员工人数'], plan)
        self.assertEqual(error.exception.code, 'query_source_unbound')

    def test_legacy_runtime_gap_is_not_projected_into_query_context(self):
        self.raw['semantic_gaps'] = [{
            'gap_id': 'no_company_price_binding',
            'code': 'entity_metric_binding_missing',
            'meaning': 'query-time company/price observation',
            'status': 'unresolved', 'blocking': True,
            'source_ids': ['staff_report'],
            'affected_refs': ['source:staff_report:staff_report'],
            'evidence': ['catalog_diagnostic:no_company_price_binding'],
        }]
        projected = catalog_config(self.raw)
        self.assertEqual(projected['semantic_gaps'], [])
        context = self.context()
        self.assertEqual(context['semantic_gaps'], [])
        self.assertNotIn('no_company_price_binding', json.dumps(context, ensure_ascii=False))

    def test_context_compresses_duplicate_source_semantics_without_changing_plan_seed(self):
        self.raw['semantic_objects'] = [
            {'object_id': 'source:staff_report', 'kind': 'source', 'source_id': 'staff_report',
             'identity': 'staff_report', 'status': 'confirmed', 'evidence': ['source_probe']},
            {'object_id': 'metric:staff_report:headcount', 'kind': 'metric', 'source_id': 'staff_report',
             'identity': 'headcount', 'status': 'confirmed', 'evidence': ['metric_probe']},
            {'object_id': 'metric:staff_report:unrelated', 'kind': 'metric', 'source_id': 'staff_report',
             'identity': 'unrelated', 'status': 'confirmed', 'evidence': ['unrelated_probe']},
        ]
        self.raw['source_bindings'] = [
            {'source_id': 'staff_report', 'semantic_ref': 'source:staff_report'},
            {'source_id': 'staff_report', 'semantic_ref': 'metric:staff_report:headcount'},
            {'source_id': 'staff_report', 'semantic_ref': 'metric:staff_report:unrelated'},
        ]
        context = self.context()
        self.assertEqual(context['context_compression']['plan_seed_unchanged'], True)
        self.assertEqual({row['object_id'] for row in context['semantic_objects']},
                         {'source:staff_report', 'metric:staff_report:headcount'})
        self.assertEqual({row['semantic_ref'] for row in context['source_bindings']},
                         {'source:staff_report', 'metric:staff_report:headcount'})
        self.assertNotIn('metric_clues', context['table_summaries'][0])
        self.assertEqual(context['plan_seed']['semantic_bindings'],
                         context['semantic_bindings'])

    def test_column_search_and_batch_projection_exclude_unrelated_columns(self):
        for table in (self.raw['tables'][0], self.live[0]):
            table['columns'] += [{'name': 'irrelevant_' + str(i), 'type': 'text', 'description': '无关字段'} for i in range(100)]
        result = self.read('search-columns', question='组织名称', source_ids=['staff_report'])
        self.assertEqual(result['columns']['items'][0]['name'], 'org_name')
        exact = self.read('get-columns', columns=[{'source_id': 'staff_report', 'names': ['amount', 'period']}])
        self.assertEqual([c['name'] for c in exact['tables'][0]['columns']], ['period', 'amount'])
        self.assertFalse(exact['tables'][0]['columns_complete'])
        self.assertEqual(exact['tables'][0]['available_column_count'], 105)
        self.assertNotIn('irrelevant_', json.dumps(exact))
        context = self.context()
        self.assertLess(len(context['tables'][0]['columns']), 10)

    def test_unknown_requests_and_revision_mismatch_fail_before_live_io(self):
        revision = self.read('retrieve-knowledge', question='员工人数')['catalog_revision']
        self.raw['metrics'][0]['description'] = '定义已更新'
        for action, request in [
            ('get-query-context', {'question': '员工人数', 'source_ids': ['staff_report'], 'catalog_revision': revision}),
            ('get-columns', {'columns': [{'source_id': 'unauthorized', 'names': ['secret']}]}),
            ('get-query-context', {'question': 'x', 'source_ids': ['staff_report'], 'unexpected': True}),
            ('retrieve-knowledge', {'question': ''}),
        ]:
            with self.subTest(action=action), self.assertRaises(KnowledgeRequestError):
                self.gateway.knowledge(action, 'group', request)
        self.assertEqual(self.physical_calls, [])

    def test_schema_drift_rejects_prior_plan_even_when_business_revision_is_unchanged(self):
        context = self.context()
        self.live[0]['columns'][0]['type'] = 'bigint'
        catalog = self.gateway.catalog('group', ['staff_report'])
        self.assertEqual(context['catalog_revision'], catalog['catalog_revision'])
        with self.assertRaises(EntityBindingError) as error:
            validate_plan(catalog, 'SELECT SUM(amount) FROM business.staff_report WHERE item=%s', ['在岗员工人数'], context['plan_seed'])
        self.assertEqual(error.exception.code, 'query_schema_changed')
        self.live[0]['columns'] = [c for c in self.live[0]['columns'] if c['name'] != 'amount']
        with self.assertRaises(KnowledgeRequestError) as error:
            self.context()
        self.assertEqual(error.exception.code, 'column_not_found')

    def test_snapshot_never_exposes_unconfigured_tables_or_secrets(self):
        self.raw['tables'].append({'schema': 'private', 'name': 'secrets', 'columns': []})
        self.raw['metrics'].append({'table': 'secrets', 'name': 'PRIVATE_METRIC', 'expression': 'COUNT(*)'})
        output = self.read('retrieve-knowledge', question='PRIVATE_METRIC')
        self.assertNotIn('PRIVATE_', json.dumps(output))
        self.assertEqual(output['sources']['total'], 2)

    def test_cli_http_and_receipt_share_the_metadata_contract(self):
        request = {'question': '职工总数'}
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(io.StringIO()) as stream:
            path = Path(temporary) / 'retrieval.json'
            with patch.object(data_client, 'load_gateway', return_value=self.gateway):
                self.assertEqual(data_client.main(['retrieve-knowledge', '--scenario-id', 'group', '--request-json', json.dumps(request), '--output', str(path)]), 0)
            value = json.loads(path.read_text())
            receipt = json.loads(stream.getvalue())
        self.assertEqual(receipt['evidenceReceipt']['evidenceKinds']['satisfied'], ['source_summary'])
        async def check():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(gateway=self.gateway)), base_url='http://skill') as client:
                response = await client.post('/api/data/metadata/retrieve-knowledge?scenario_id=group', json=request)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), value)
                response = await client.post('/api/data/metadata/get-columns?scenario_id=group', json={'columns': [{'source_id': 'staff_report', 'names': ['missing']}]})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()['detail']['code'], 'column_not_found')
        asyncio.run(check())

    def test_physical_metadata_sql_limits_columns_to_exact_authorized_relations(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchall.side_effect = [[{'schema_name': 'business', 'name': 'staff_report', 'column_name': 'amount', 'type': 'decimal', 'description': '', 'column_description': ''}], []]
        with scenario_scope(self.store.get_scenario('group')), patch.object(table_catalog, 'query_connection') as opened:
            opened.return_value.__enter__.return_value = connection
            table_catalog.physical_catalog(self.raw, source_ids={'staff_report'})
        statement, params = cursor.execute.call_args_list[0].args
        self.assertIn('(c.table_schema,c.table_name) IN ((%s,%s))', statement)
        self.assertEqual(params, ['business', 'staff_report'])

    def test_compact_complete_metadata_is_inlined_despite_pretty_disk_indentation(self):
        value = {'schema': 'nl2sql.semantic-metadata/v1', 'scenario_id': 'group',
                 'items': [{'name': 'field_' + str(i), 'value': i} for i in range(120)]}
        self.assertGreater(len(json.dumps(value, indent=2)), 6000)
        self.assertLess(len(json.dumps(value)), 6000)
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(io.StringIO()) as stream:
            path = Path(temporary) / 'metadata.json'
            data_client.save_result(value, path)
            receipt = json.loads(stream.getvalue())
            self.assertEqual(json.loads(path.read_text()), value)
        self.assertTrue(receipt['content_complete'])
        self.assertEqual(receipt['content'], value)

    def test_single_snapshot_read_projects_only_business_knowledge(self):
        from gateway.store import CatalogStore
        store = CatalogStore({'query_databases': {'group': {'allowed_relations': ['business.staff_report']}}})
        with patch.object(store, 'connect') as opened:
            cursor = opened.return_value.__enter__.return_value
            cursor.fetchone.return_value = {'id': 'group', 'name': '集团', 'description': '业务', 'config': json.dumps(self.raw)}
            scenario, config = store.read_snapshot('group')
            self.assertEqual(cursor.execute.call_count, 1)
            self.assertEqual(scenario['id'], 'group')
            self.assertNotIn('PRIVATE_', json.dumps(config))
            with self.assertRaises(ValueError):
                store.read_snapshot('demo')
            self.assertEqual(cursor.execute.call_count, 1)

    def test_run_snapshot_is_reused_only_inside_one_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            configured = {'query_databases': {'group': {'allowed_relations': ['business.staff_report']}}}
            store = store_module.CatalogStore(configured, snapshot_root=temporary, run_id='run_a')
            with patch.object(store, 'connect') as opened:
                cursor = opened.return_value.__enter__.return_value
                cursor.fetchone.return_value = {
                    'id': 'group', 'name': '集团', 'description': '业务', 'config': json.dumps(self.raw)}
                first = store.read_snapshot('group')
                second = store.read_snapshot('group', verify_current=False)
                self.assertEqual(first, second)
                self.assertEqual(cursor.execute.call_count, 1)
            other = store_module.CatalogStore(configured, snapshot_root=temporary, run_id='run_b')
            with patch.object(other, 'connect') as opened:
                cursor = opened.return_value.__enter__.return_value
                cursor.fetchone.return_value = {
                    'id': 'group', 'name': '集团', 'description': '业务', 'config': json.dumps(self.raw)}
                other.read_snapshot('group', verify_current=False)
                self.assertEqual(cursor.execute.call_count, 1)

    def test_broken_catalog_connection_preserves_original_error(self):
        from gateway.store import CatalogStore
        store = CatalogStore({'catalog_database_url': 'tidb://fixture/catalog'})
        for readonly in (True, False):
            with self.subTest(readonly=readonly), patch.object(store_module, 'connect') as opened:
                connection = opened.return_value.__enter__.return_value
                connection.rollback.side_effect = RuntimeError('broken rollback')
                with self.assertRaisesRegex(ValueError, 'original catalog failure'):
                    with store.connect(readonly=readonly):
                        raise ValueError('original catalog failure')


if __name__ == '__main__':
    unittest.main()

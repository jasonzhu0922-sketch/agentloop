"""Opt-in actual TiDB verification of the Skill's retrieval -> context -> SQL path."""
from copy import deepcopy
import os
import sys
import unittest
sys.dont_write_bytecode = True

from data_access import load_gateway


@unittest.skipUnless(os.environ.get('DATA_ANALYSIS_TIDB_LIVE') == '1', 'explicit live TiDB opt-in required')
class SemanticLiveTest(unittest.TestCase):
    def setUp(self):
        self.gateway = load_gateway()

    def test_retrieval_context_and_signed_sql_use_the_same_knowledge(self):
        source = 'v_fawhzhss0401'
        question = '查询人力月报数据中最新的月份'
        physical = self.gateway.physical_catalog
        scans = []
        def counted(config, **options):
            scans.append(options.get('source_ids'))
            return physical(config, **options)
        self.gateway.physical_catalog = counted
        retrieved = self.gateway.knowledge('retrieve-knowledge', 'group', {'question': question})
        self.assertIn(source, [m['source_id'] for m in retrieved['sources']['items']])
        self.assertEqual(scans, [], 'retrieval must not scan physical metadata')
        context = self.gateway.knowledge('get-query-context', 'group', {
            'question': question, 'source_ids': [source], 'catalog_revision': retrieved['catalog_revision']})
        self.assertEqual(scans, [{source}])
        self.assertEqual(context['schema_verification'], 'selected_sources_live')
        period = next(p for p in context['period_formats'] if p['source_id'] == source)
        table = context['tables'][0]
        self.assertTrue(period['field'].isidentifier())
        sql = f"SELECT MAX(`{period['field']}`) AS latest_month FROM `{table['schema']}`.`{source}`"
        result = self.gateway.execute_sql('group', sql, [], context['plan_seed'])
        self.assertEqual(result['status'], 'completed', result.get('error'))
        self.assertEqual(result['plan_verification']['status'], 'verified')
        self.assertTrue(result['dataset']['rows'][0]['latest_month'])
        self.assertEqual(result['catalog_revision'], retrieved['catalog_revision'])
        broken = deepcopy(context['plan_seed'])
        broken['source_signatures'][source] = '0' * 64
        rejected = self.gateway.execute_sql('group', sql, [], broken)
        self.assertEqual(rejected['status'], 'rejected')
        self.assertEqual(rejected['error']['diagnostic']['code'], 'query_schema_changed')
        self.assertNotIn('dataset', rejected)

    def test_metric_and_column_actions_preserve_current_definitions(self):
        source = 'v_fawhzhss0401'
        metrics = self.gateway.knowledge('search-metrics', 'group', {'question': '人力月度项目值', 'source_ids': [source]})
        self.assertTrue(metrics['metrics']['items'])
        item = metrics['metrics']['items'][0]
        refs = [{k: item[k] for k in ('source_id', 'metric_id')}]
        exact = self.gateway.knowledge('get-metrics', 'group', {'metric_refs': refs})
        context = self.gateway.knowledge('get-query-context', 'group', {
            'question': '人力月度项目值', 'source_ids': [source], 'metric_refs': refs,
            'catalog_revision': metrics['catalog_revision']})
        self.assertEqual(exact['metrics'][0]['definition'], context['metrics'][0]['definition'])
        fields = exact['metrics'][0]['required_fields']
        self.assertTrue(fields)
        columns = self.gateway.knowledge('get-columns', 'group', {'columns': [{'source_id': source, 'names': fields}],
            'catalog_revision': metrics['catalog_revision']})
        self.assertEqual({c['name'] for c in columns['tables'][0]['columns']}, set(fields))
        self.assertTrue(columns['tables'][0]['available_column_count'] >= len(fields))


if __name__ == '__main__':
    unittest.main()

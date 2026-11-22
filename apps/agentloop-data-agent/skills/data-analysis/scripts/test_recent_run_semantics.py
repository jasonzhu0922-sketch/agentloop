"""Live regressions for generic source-local semantic evidence.

These checks intentionally avoid business-table names and terms. They verify
that a bounded observation stays tied to its source and that a stale plan is
rejected before SQL execution.
"""
import os
import unittest

from data_access import load_gateway


@unittest.skipUnless(os.environ.get('DATA_ANALYSIS_TIDB_LIVE') == '1',
                     'explicit live TiDB opt-in required')
class RecentRunSemanticTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gateway = load_gateway()
        cls.catalog = cls.gateway.catalog('group')

    def test_bounded_probe_is_source_local_and_not_global_coverage(self):
        table = self.catalog['tables'][0]
        column = next(column for column in table['columns'] if column.get('allow_output', True))
        result = self.gateway.probe_values('group', table['name'], column['name'], 3)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['source_id'], table['name'])
        self.assertEqual(result['field'], column['name'])
        self.assertIn('semantic_binding', result)
        self.assertEqual(result['semantic_binding']['scope'].get('source_id'), table['name'])
        self.assertEqual(result['semantic_binding']['status'], 'observed_only')
        self.assertEqual(result['semantic_binding']['scope'].get('completeness'), 'observed_only')
        self.assertIn(f"probe:{result['evidence']['query_id']}", result['semantic_binding']['evidence'])
        self.assertNotIn('global_coverage', result)

    def test_stale_source_signature_is_rejected(self):
        source = self.catalog['tables'][0]['name']
        context = self.gateway.knowledge('get-query-context', 'group', {
            'question': '探查当前源', 'source_ids': [source]})
        broken = dict(context['plan_seed'])
        broken['source_signatures'] = dict(broken['source_signatures'])
        broken['source_signatures'][source] = '0' * 64
        table = next(item for item in self.catalog['tables'] if item['name'] == source)
        sql = f"SELECT COUNT(*) AS row_count FROM `{table['schema']}`.`{table['name']}`"
        result = self.gateway.execute_sql('group', sql, [], broken)
        self.assertEqual(result['status'], 'rejected')
        self.assertEqual(result['error']['diagnostic']['code'], 'query_schema_changed')


if __name__ == '__main__':
    unittest.main()

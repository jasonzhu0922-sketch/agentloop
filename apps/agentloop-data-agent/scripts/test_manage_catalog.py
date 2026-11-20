import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'skills/data-analysis/scripts'))
spec = importlib.util.spec_from_file_location('manage_catalog', ROOT / 'scripts/manage_catalog.py')
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)


class CatalogAdministrationTests(unittest.TestCase):
    def setUp(self):
        self.table = {'name': 'report', 'schema': 'business', 'columns': [{'name': 'amount', 'type': 'decimal(20,2)'}]}
        self.raw = {'tables': [self.table], 'terms': [], 'metrics': [
            {'name': 'sales', 'label': '销售额', 'table': 'report', 'expression': 'SUM(amount)',
             'project': {'field': 'item', 'value': 'sales'}, 'aggregation': {'grain': ['org', 'month']}}
        ], 'connection': {'password': 'catalog-private-password'}, 'model': {'api_key': 'private-key'}, 'timezone': 'Asia/Shanghai'}

    def save(self, changes):
        return admin.merge_config(self.raw, {'revision': admin.revision(self.raw), 'changes': changes}, {'tables': [self.table]})

    def test_edit_preserves_advanced_contracts_and_noneditable_configuration(self):
        metric = {**self.raw['metrics'][0], 'label': '业务销售额'}
        candidate = self.save({'metrics': [metric]})
        self.assertEqual(candidate['metrics'][0]['project'], self.raw['metrics'][0]['project'])
        self.assertEqual(candidate['metrics'][0]['aggregation'], self.raw['metrics'][0]['aggregation'])
        self.assertEqual(candidate['connection'], self.raw['connection'])
        public = admin.project(candidate)
        self.assertNotIn('connection', public)
        self.assertNotIn('model', public)
        self.assertNotIn('private-key', str(public))

    def test_stale_version_and_physical_schema_edits_are_rejected(self):
        with self.assertRaises(admin.Conflict):
            admin.merge_config(self.raw, {'revision': 'stale', 'changes': {'terms': []}}, {'tables': [self.table]})
        for changes in ({'tables': []}, {'tables': [{**self.table, 'schema': 'other'}]},
                        {'tables': [{**self.table, 'columns': [{'name': 'amount', 'type': 'text'}]}]},
                        {'model': []}, {'metrics': [{**self.raw['metrics'][0], 'table': 'other'}]}):
            with self.assertRaises(admin.Invalid):
                self.save(changes)

    def test_connection_password_is_not_returned_and_blank_preserves_it(self):
        previous = 'tidb://user:p%40ss@localhost:4000/catalog'
        public = admin.safe_connection(previous)
        self.assertTrue(public['password_configured'])
        self.assertNotIn('password', public)
        candidate = admin.connection_candidate(previous, {**public, 'password': ''})
        self.assertEqual(candidate, previous)
        with self.assertRaisesRegex(admin.Invalid, '重新填写密码'):
            admin.connection_candidate(previous, {**public, 'host': 'another.example', 'password': ''})

    def test_grain_edit_invalidates_prior_unique_proof(self):
        self.raw['table_summaries'] = [{'source_id': 'report', 'row_grain': ['amount'], 'grain_status': 'verified', 'grain_evidence': {'unique': True}}]
        summary = {**self.raw['table_summaries'][0], 'row_grain': []}
        candidate = self.save({'table_summaries': [summary]})
        self.assertEqual(candidate['table_summaries'][0]['grain_status'], 'unverified')
        self.assertNotIn('grain_evidence', candidate['table_summaries'][0])


if __name__ == '__main__':
    unittest.main()

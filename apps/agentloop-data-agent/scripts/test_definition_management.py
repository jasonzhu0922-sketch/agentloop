"""Classification and semantic edits must survive persistence and query use."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/data-analysis/scripts'))
import manage_catalog as admin
from catalog_knowledge import catalog_config, semantic_graph_diagnostics
from data_access import catalog_projection
from test_catalog_knowledge import fixture
from knowledge_definitions import resolve_term_binding
from semantic_retrieval import metric_matches


class DefinitionManagementTest(unittest.TestCase):
    def setUp(self):
        self.raw = catalog_config(fixture())
        self.categories = [dict(id='a', name='经营', parent_id=None),
                           dict(id='b', name='人力', parent_id='a'),
                           dict(id='c', name='在岗', parent_id='b')]

    def save(self, changes):
        self.raw = admin.merge_config(self.raw, {'revision': admin.revision(self.raw),
                                                'changes': changes}, deepcopy(self.raw))
        return self.raw

    def term(self):
        return dict(id='term_actual', term='在岗人数原值', meaning='报表提供的实际人数',
                    aliases=['在岗原值'], data_bindings=[dict(id='actual', kind='direct',
                    source_id='staff_report', value_field='amount', time_field='period',
                    filters=[dict(field='item', operator='eq', values=['在岗员工人数'])])])

    def test_deep_categories_and_atomic_migration_preserve_definitions(self):
        self.save({'categories': self.categories, 'terms': [self.term()]})
        metric = {**self.raw['metrics'][0], 'category_id': 'b'}
        term = {**self.raw['terms'][0], 'category_id': 'b'}
        self.save({'metrics': [metric], 'terms': [term]})
        before = deepcopy(self.raw)
        self.save({'categories': [self.categories[0], {**self.categories[2], 'parent_id': 'a'}],
                   'metrics': [{**self.raw['metrics'][0], 'category_id': 'a'}],
                   'terms': [{**self.raw['terms'][0], 'category_id': 'a'}]})
        for key in ('metrics', 'terms'):
            self.assertEqual(self.raw[key][0], {**before[key][0], 'category_id': 'a'})

    def test_category_cycles_dangling_refs_and_duplicate_siblings_rejected(self):
        self.save({'categories': self.categories})
        for categories in ([{**self.categories[0], 'parent_id': 'c'}, *self.categories[1:]],
                           self.categories[1:],
                           [*self.categories, dict(id='d', name='在岗', parent_id='b')]):
            with self.subTest(categories=categories), self.assertRaises(admin.Invalid):
                self.save({'categories': categories})
        with self.assertRaises(admin.Invalid):
            self.save({'terms': [{**self.term(), 'category_id': 'missing'}]})

    def test_new_metrics_require_computation_and_real_columns(self):
        for expression in ('amount', 'SUM(missing)', 'SELECT SUM(amount) FROM staff_report',
                           'SUM(amount); DELETE FROM staff_report'):
            with self.subTest(expression=expression), self.assertRaises(admin.Invalid):
                self.save({'metrics': [dict(name='new', table='staff_report', expression=expression)]})
        self.save({'metrics': [dict(name='new', label='计算人数', table='staff_report',
                   expression='SUM(amount)', time_field='', unit_field='', aliases=['总人头'])]})
        self.assertEqual(metric_matches(catalog_projection(self.raw, 'group'), '总人头')[0]['metric_id'], 'new')

    def test_confirmation_retirement_and_binding_validation(self):
        with self.assertRaises(admin.Invalid):
            self.save({'terms': [{**self.term(), 'confirm_definition': True}]})
        self.save({'terms': [{**self.term(), 'confirm_definition': True, 'evidence_ids': ['manual:report']}]})
        term = self.raw['terms'][0]
        self.assertEqual(term['status'], 'confirmed')
        self.save({'terms': [{**term, 'aliases': []}]})
        self.assertEqual(self.raw['terms'][0]['status'], 'confirmed')
        projected = next(o for o in self.raw['semantic_objects'] if o['kind'] == 'term')
        self.assertEqual(projected['aliases'], [])
        self.save({'terms': [{**self.raw['terms'][0], 'lifecycle_action': 'retire'}]})
        with self.assertRaises(ValueError):
            resolve_term_binding(self.raw, {'term_id': term['id'], 'binding_id': 'actual'})
        self.save({'terms': [{**self.raw['terms'][0], 'lifecycle_action': 'restore'}]})
        self.assertEqual(self.raw['terms'][0]['status'], 'provisional')
        invalid = self.term()
        invalid['data_bindings'][0]['value_field'] = 'missing'
        with self.assertRaises(admin.Invalid):
            self.save({'terms': [invalid]})

    def test_generated_metric_and_term_graphs_have_real_source_parents(self):
        self.save({'metrics': [{**self.raw['metrics'][0], 'label': '修改名称'}],
                   'terms': [{**self.term(), 'source_id': 'staff_report'}]})
        self.assertEqual(semantic_graph_diagnostics(self.raw['semantic_objects']), [])
        for row in self.raw['semantic_objects']:
            if row['kind'] in {'metric', 'term'}:
                self.assertTrue(any(parent['object_id'] == row['parent_ref']
                                    for parent in self.raw['semantic_objects']))

    def test_legacy_advanced_metric_survives_classification(self):
        old = self.raw['metrics'][0]
        old.update(aggregation={'grain': ['org_code', 'period'], 'time': 'last'}, status='confirmed')
        self.save({'categories': self.categories, 'metrics': [{**old, 'category_id': 'c', 'label': '新显示名'}]})
        self.assertEqual(self.raw['metrics'][0]['aggregation'], old['aggregation'])
        self.assertEqual(self.raw['metrics'][0]['project'], old['project'])
        self.assertEqual(self.raw['metrics'][0]['status'], 'confirmed')


if __name__ == '__main__':
    unittest.main()

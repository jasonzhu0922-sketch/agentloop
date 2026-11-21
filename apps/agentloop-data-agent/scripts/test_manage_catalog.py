import importlib.util
import json
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

    def test_semantic_object_is_generic_source_bound_catalog_data(self):
        object_row = {
            'object_id': 'entity:report:account_code',
            'kind': 'entity',
            'layer': 'object',
            'semantic_role': 'dimension_key',
            'source_id': 'report',
            'labels': ['任意业务对象'],
            'aliases': ['对象简称'],
            'scope': {'kind': 'source', 'source_id': 'report'},
            'status': 'provisional',
            'evidence': ['manual:catalog-entry'],
        }
        candidate = self.save({'semantic_objects': [object_row]})
        self.assertEqual(candidate['semantic_objects'][0]['source_id'], 'report')
        self.assertEqual(candidate['semantic_objects'][0]['labels'], ['任意业务对象'])
        self.assertNotIn('finance', json.dumps(candidate, ensure_ascii=False))

    def test_semantic_object_parent_and_layer_are_validated_generically(self):
        source = {'object_id': 'source:report:report', 'kind': 'source', 'layer': 'source',
                  'source_id': 'report', 'identity': 'report'}
        child = {'object_id': 'entity:report:code', 'kind': 'entity', 'layer': 'object',
                 'source_id': 'report', 'identity': 'code', 'parent_ref': source['object_id']}
        self.assertEqual(len(self.save({'semantic_objects': [source, child]})['semantic_objects']), 2)
        with self.assertRaisesRegex(admin.Invalid, '层级无效'):
            self.save({'semantic_objects': [{**child, 'parent_ref': 'source:missing:missing'}]})
        with self.assertRaisesRegex(admin.Invalid, '通用类型'):
            self.save({'semantic_objects': [{**child, 'kind': 'finance.account_set'}]})

    def test_human_entity_definition_generates_runtime_semantic_projection(self):
        self.table['columns'] += [{'name': 'code', 'type': 'varchar(32)'},
                                  {'name': 'name', 'type': 'varchar(128)'},
                                  {'name': 'scope', 'type': 'varchar(128)'}]
        entity = {'source_id': 'report', 'key_field': 'code', 'name_fields': ['name'],
                  'label': '可筛选对象', 'description': '当前来源中的可筛选对象',
                  'semantic_role': 'dimension', 'status': 'provisional',
                  'scope_filter': {'field': 'scope', 'operator': 'like_any', 'patterns': ['%有效%']}}
        candidate = self.save({'entities': [entity]})
        self.assertEqual(candidate['entities'][0]['id'], 'entity:report:code:scope:scope')
        projected = next(row for row in candidate['semantic_objects'] if row['kind'] == 'entity')
        self.assertEqual(projected['object_id'], candidate['entities'][0]['id'])
        self.assertEqual(projected['layer'], 'object')
        self.assertEqual(projected['parent_ref'], 'source:report:report')
        self.assertEqual(candidate['source_bindings'][0]['semantic_ref'], projected['object_id'])

    def test_human_term_definition_generates_term_projection_and_source_binding(self):
        term = {'term': '当前对象', 'meaning': '人员维护的自然语言定义',
                'source_id': 'report', 'aliases': ['对象简称'],
                'evidence_ids': ['manual:term-definition']}
        candidate = self.save({'terms': [term]})
        projected = next(row for row in candidate['semantic_objects'] if row['kind'] == 'term')
        self.assertEqual(projected['object_id'], 'term:report:当前对象')
        self.assertEqual(projected['projection_of'], {'collection': 'terms', 'key': 'term', 'value': '当前对象'})
        self.assertEqual(projected['parent_ref'], 'source:report:report')
        self.assertIn('manual:term-definition', projected['evidence'])
        self.assertEqual(candidate['source_bindings'][0]['relation'], 'term_source')
        self.assertEqual(candidate['source_bindings'][0]['semantic_ref'], projected['object_id'])

    def test_domain_term_projection_has_no_source_binding(self):
        candidate = self.save({'terms': [{'term': '跨来源术语', 'meaning': '多个来源共用的定义'}]})
        projected = next(row for row in candidate['semantic_objects'] if row['kind'] == 'term')
        self.assertEqual(projected['projection_of']['collection'], 'terms')
        self.assertNotIn('parent_ref', projected)
        self.assertFalse(any(binding['relation'] == 'term_source' for binding in candidate.get('source_bindings', [])))
        with self.assertRaisesRegex(admin.Invalid, '术语来源'):
            self.save({'terms': [{'term': '错误来源术语', 'meaning': '不应保存', 'source_id': 'outside'}]})
        with self.assertRaisesRegex(admin.Invalid, 'terms'):
            self.save({'semantic_objects': [{'object_id': 'term:手工节点', 'kind': 'term', 'layer': 'term', 'identity': '手工节点'}]})

    def test_transient_semantic_gap_is_rejected_at_catalog_boundary(self):
        gap = {
            'gap_id': 'no_company_price_binding',
            'code': 'entity_metric_binding_missing',
            'term': '日照钢铁',
            'trigger_terms': ['日照钢铁', '日钢'],
            'meaning': '当前来源未确认企业价格绑定，必须先澄清企业出厂价或地区市场价口径。',
            'status': 'unresolved',
            'blocking': True,
            'source_ids': ['report'],
            'affected_refs': ['source:report:report'],
            'evidence': ['manual:catalog-entry'],
        }
        with self.assertRaisesRegex(admin.Invalid, '查询时诊断'):
            self.save({'semantic_gaps': [gap]})

    def test_legacy_transient_gap_is_removed_when_another_catalog_edit_is_saved(self):
        self.raw['semantic_gaps'] = [{
            'gap_id': 'legacy-runtime-gap', 'code': 'entity_metric_binding_missing',
            'meaning': 'query-time observation', 'blocking': True,
            'source_ids': ['report'], 'evidence': ['catalog_diagnostic:legacy-runtime-gap'],
        }]
        candidate = self.save({'terms': [{'term': '稳定术语', 'meaning': '持久定义'}]})
        self.assertEqual(candidate['semantic_gaps'], [])


if __name__ == '__main__':
    unittest.main()

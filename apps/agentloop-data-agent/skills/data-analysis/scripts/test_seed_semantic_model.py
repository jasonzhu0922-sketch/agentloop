import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('seed_local_semantic_model', ROOT / 'scripts' / 'seed_local_semantic_model.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GenericSemanticSeedTest(unittest.TestCase):
    def test_explicit_period_definition_is_moved_to_field_definition(self):
        config = {'tables': [{'name': 'arbitrary_table', 'columns': [{'name': 'period', 'type': 'varchar(8)'}]}],
                  'period_formats': [{'source_id': 'arbitrary_table', 'field': 'period',
                                      'format': '%Y%m%d', 'granularity': 'day'}]}
        updated, migrated = MODULE.materialize_field_formats(config)
        self.assertEqual(migrated, 1)
        self.assertEqual(updated['tables'][0]['columns'][0]['format'], 'YYYYMMDD')
        self.assertEqual(updated['tables'][0]['columns'][0]['granularity'], 'day')

    def test_seed_uses_explicit_sources_and_never_manufactures_coverage(self):
        config = {
            'tables': [{'name': 'arbitrary_table', 'schema': 'db', 'columns': []}],
            'terms': [{'term': '本地术语'}],
            'period_formats': [{'source_id': 'arbitrary_table', 'field': 'period'}],
        }
        result = MODULE.build_semantics(config, 'scenario')
        self.assertEqual(result['coverage'], [])
        self.assertFalse(any('人力' in str(row) or '经营' in str(row) for row in result['semantic_objects']))
        self.assertTrue(any(g['code'] == 'definition_unresolved' for g in result['semantic_gaps']))
        self.assertTrue(any(g['code'] == 'time_format_unresolved' for g in result['semantic_gaps']))

    def test_term_source_is_never_inferred_from_text(self):
        config = {'tables': [{'name': 'table_a', 'schema': 'db', 'columns': []}],
                  'terms': [{'term': '合同', 'meaning': '任意定义'}]}
        result = MODULE.build_semantics(config)
        term = next(item for item in result['semantic_objects'] if item['kind'] == 'term')
        self.assertIsNone(term['source_id'])
        self.assertFalse(any(binding['relation'] == 'term_source' for binding in result['source_bindings']))

    def test_semantic_objects_form_a_generic_parented_hierarchy(self):
        config = {'tables': [{'name': 'source_a', 'schema': 'db',
                              'columns': [{'name': 'period', 'description': 'period'}]}],
                  'metrics': [{'name': 'value', 'table': 'source_a', 'expression': 'SUM(amount)'}],
                  'entities': [{'id': 'legacy.object', 'source_id': 'source_a', 'key_field': 'code', 'name_fields': ['name']}],
                  'terms': [{'term': '业务词', 'meaning': 'source_a'}], 'period_formats': []}
        result = MODULE.build_semantics(config)
        by_kind = {item['kind']: item for item in result['semantic_objects'] if item['kind'] in {'source', 'metric', 'entity', 'attribute', 'term'}}
        self.assertEqual(by_kind['source']['layer'], 'source')
        self.assertEqual(by_kind['metric']['layer'], 'measure')
        self.assertEqual(by_kind['metric']['parent_ref'], by_kind['source']['object_id'])
        self.assertEqual(by_kind['entity']['layer'], 'object')
        self.assertEqual(by_kind['entity']['object_id'], 'entity:source_a:code')
        self.assertEqual(by_kind['entity']['identity'], 'code')
        self.assertEqual(by_kind['attribute']['layer'], 'attribute')
        self.assertEqual(by_kind['term']['layer'], 'term')
        self.assertEqual(by_kind['term']['projection_of'],
                         {'collection': 'terms', 'key': 'term', 'value': '业务词'})

    def test_legacy_entity_ids_are_migrated_from_source_fields(self):
        config = {
            'tables': [{'name': 'source_a', 'schema': 'db',
                        'columns': [{'name': name} for name in ('code', 'name', 'selector')]}],
            'entities': [{'id': 'finance.organization', 'source_id': 'source_a',
                          'key_field': 'code', 'name_fields': ['name']},
                         {'id': 'legacy.scoped', 'source_id': 'source_a',
                          'key_field': 'code', 'name_fields': ['name'],
                          'scope_filter': {'field': 'selector', 'operator': 'like_any', 'patterns': ['%x%']}}],
            'relationships': [{'id': 'legacy.parent_child', 'parent': {'entity_id': 'finance.organization', 'source_id': 'source_a', 'fields': ['code']},
                               'child': {'entity_id': 'legacy.scoped', 'source_id': 'source_a', 'fields': ['code']}}],
        }
        updated, mapping = MODULE.normalize_generic_entities(config)
        self.assertEqual(mapping['finance.organization'], 'entity:source_a:code')
        self.assertEqual(mapping['legacy.scoped'], 'entity:source_a:code:scope:selector')
        self.assertNotIn('finance.organization', json.dumps(updated, ensure_ascii=False))
        self.assertTrue(updated['relationships'][0]['id'].startswith('relationship:source_a:code:'))


if __name__ == '__main__':
    unittest.main()

"""Table editing -> persisted catalog -> query-context contract regressions."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/data-analysis/scripts'))
import manage_catalog as admin
from catalog_knowledge import catalog_config, prepare_knowledge, table_signature
from table_semantics import schema_signature
from test_catalog_knowledge import fixture
from data_access import Gateway
from gateway.scenarios import scenario_scope


class TableCatalogContractTest(unittest.TestCase):
    def setUp(self):
        self.raw = fixture()
        self.table = self.raw['tables'][0]
        self.summary = self.raw['table_summaries'][0]
        self.summary.update(grain_status='verified', grain_evidence={'query_id': 'grain-1'},
                            unique_key_status='verified', unique_key_evidence={'query_id': 'unique-1'})

    def save(self, changes, raw=None, physical=None):
        raw = raw or self.raw
        return admin.merge_config(raw, {'revision': admin.revision(raw), 'changes': changes},
                                  physical or {'tables': deepcopy(raw['tables'])})

    def context(self, config):
        store = MagicMock()
        store.get_scenario.return_value = {'id': 'group', 'binding': {'allowed_relations': ['business.staff_report', 'business.transactions']}}
        store.read_snapshot.side_effect = lambda identifier: (store.get_scenario(identifier), catalog_config(config))
        store.load_config.side_effect = lambda: catalog_config(config)
        gateway = Gateway(store, scenario_scope, lambda value, source_ids=None: deepcopy(value), lambda *args: {}, ValueError)
        return gateway.knowledge('get-query-context', 'group', {'question': '职工总数', 'source_ids': ['staff_report'],
             'metric_refs': [{'source_id': 'staff_report', 'metric_id': 'headcount'}]})

    def test_edit_explanation_upgrades_current_legacy_summary_without_losing_context(self):
        tables = deepcopy(self.raw['tables'])
        tables[0]['columns'][0]['description'] = '组织统一编码（补充说明）'
        result = self.save({'tables': tables})
        prepared = prepare_knowledge(result)
        self.assertEqual(prepared['tables'][0]['understanding_status'], 'current')
        self.assertEqual(prepared['table_summaries'][0]['record_semantics'], self.summary['record_semantics'])
        self.assertEqual(result['table_summaries'][0]['grain_evidence'], {'query_id': 'grain-1'})
        self.assertIn('schema_signature', result['table_summaries'][0])
        self.assertEqual(self.context(result)['table_summaries'][0]['record_semantics'], self.summary['record_semantics'])

    def test_schema_change_is_not_blessed_by_a_label_edit(self):
        physical = deepcopy(self.raw)
        physical['tables'][0]['columns'][0]['type'] = 'bigint'
        physical['tables'][0]['label'] = '新显示名'
        saved = self.save({'tables': physical['tables']}, physical=physical)
        self.assertEqual(prepare_knowledge(saved)['tables'][0]['understanding_status'], 'stale')
        self.assertNotIn('schema_signature', saved['table_summaries'][0])

    def test_new_physical_signature_detects_drift_but_ignores_labels(self):
        self.summary['schema_signature'] = schema_signature(self.table)
        self.table['columns'][0]['label'] = '名称调整'
        self.assertEqual(prepare_knowledge(self.raw)['tables'][0]['understanding_status'], 'current')
        self.table['columns'][0]['type'] = 'bigint'
        self.assertEqual(prepare_knowledge(self.raw)['tables'][0]['understanding_status'], 'stale')

    def test_format_confirmation_is_explicit_and_observation_is_read_only(self):
        column = self.table['columns'][2]
        column.update(format='YYYYMM', granularity='month', format_status='ambiguous',
                      format_observed_shapes=['6-digit', '8-digit'])
        self.summary['table_signature'] = table_signature(self.table)
        tables = deepcopy(self.raw['tables'])
        edited = tables[0]['columns'][2]
        edited.update(label='统计月份', format_status='confirmed', format_observed_shapes=[])
        saved = self.save({'tables': tables})
        actual = saved['tables'][0]['columns'][2]
        self.assertEqual(actual['format_status'], 'ambiguous')
        self.assertEqual(actual['format_observed_shapes'], ['6-digit', '8-digit'])
        edited.update(confirm_definition=True)
        with self.assertRaisesRegex(admin.Invalid, '依据'):
            self.save({'tables': tables})
        edited['evidence_ids'] = ['manual:dictionary-v2']
        actual = self.save({'tables': tables})['tables'][0]['columns'][2]
        self.assertEqual(actual['format_status'], 'confirmed')
        self.assertEqual(actual['format_observed_shapes'], ['6-digit', '8-digit'])
        self.assertNotIn('confirm_definition', actual)

    def test_unit_change_invalidates_proof_even_when_summary_is_saved_together(self):
        tables = deepcopy(self.raw['tables'])
        tables[0]['columns'][-1]['unit'] = '人'
        saved = self.save({'tables': tables, 'table_summaries': deepcopy(self.raw['table_summaries'])})
        self.assertEqual(saved['table_summaries'][0]['grain_status'], 'unverified')
        self.assertNotIn('grain_evidence', saved['table_summaries'][0])
        self.assertNotIn('unique_key_evidence', saved['table_summaries'][0])

    def test_semantic_contract_reaches_query_context_and_graph(self):
        tables = deepcopy(self.raw['tables'])
        tables[0]['columns'][-1].update(logical_type='number', unit='人',
            declared_domain={'kind': 'range', 'min': 0}, evidence_ids=['dictionary:v1'])
        summary = deepcopy(self.summary)
        summary.update(table_kind='snapshot', time_fields=['period'], time_semantics='月末快照',
                       entity_semantics='上报组织范围', candidate_unique_key=['org_code', 'period', 'item'],
                       not_suitable_for=['不可跨月累加'], update_mode='按月修订', update_frequency='每月')
        saved = self.save({'tables': tables, 'table_summaries': [summary]})
        context = self.context(saved)
        actual = context['table_summaries'][0]
        for key in ('time_semantics', 'entity_semantics', 'candidate_unique_key', 'not_suitable_for', 'update_mode', 'update_frequency'):
            self.assertEqual(actual[key], summary[key])
        column = next(c for c in context['tables'][0]['columns'] if c['name'] == 'amount')
        self.assertEqual(column['declared_domain'], {'kind': 'range', 'min': 0})
        self.assertEqual(column['unit'], '人')
        graph = next(o for o in saved['semantic_objects'] if o['object_id'] == 'attribute:staff_report:amount')
        self.assertEqual(graph['parent_ref'], 'source:staff_report:staff_report')
        self.assertEqual(graph['projection_of']['field'], 'amount')
        self.assertEqual(len([o for o in self.save({'tables': saved['tables']}, raw=saved)['semantic_objects']
                              if o['object_id'] == graph['object_id']]), 1)

    def test_inspection_exposes_actual_status_and_preserves_observation_evidence(self):
        self.raw['observed_probes'] = [{'source_id': 'staff_report', 'field': 'period',
                                      'observed_at': '2026-11-22', 'scope': {'kind': 'sample'},
                                      'evidence': {'query_id': 'probe-1'}}]
        physical = deepcopy(self.raw)
        physical['tables'][0]['columns'][0]['type'] = 'bigint'
        inspected = admin.inspect_catalog(self.raw, physical)
        self.assertEqual(inspected['tables'][0]['understanding_status'], 'stale')
        self.assertEqual(inspected['observed_probes'], self.raw['observed_probes'])
        self.assertTrue(inspected['knowledge_diagnostics'])
        with self.assertRaises(admin.Invalid):
            self.save({'observed_probes': []})

    def test_invalid_domain_scope_and_unit_field_are_rejected(self):
        for change in ({'declared_domain': {'kind': 'range', 'min': 20, 'max': 10}},
                       {'unit_field': 'missing'}, {'unit': '人', 'unit_field': 'item'},
                       {'scope_filter': {'field': 'missing', 'operator': 'eq', 'values': ['x']}}):
            with self.subTest(change=change):
                tables = deepcopy(self.raw['tables'])
                tables[0]['columns'][-1].update(change)
                with self.assertRaises(admin.Invalid):
                    self.save({'tables': tables})

    def test_manual_save_cannot_forge_unique_key_proof_or_physical_facts(self):
        summary = {**self.summary, 'candidate_unique_key': ['org_code'], 'grain_status': 'verified', 'grain_evidence': {'fake': True}}
        saved = self.save({'table_summaries': [summary]})
        self.assertNotIn('grain_evidence', saved['table_summaries'][0])
        tables = deepcopy(self.raw['tables'])
        tables[0]['columns'][0]['numeric_precision'] = 999
        saved = self.save({'tables': tables})
        self.assertNotIn('numeric_precision', saved['tables'][0]['columns'][0])

    def test_time_variant_edits_update_field_without_promoting_scoped_formats(self):
        variants = [{'source_id': 'staff_report', 'field': 'period', 'variant_id': 'monthly',
                     'format': 'YYYYMM', 'granularity': 'month', 'status': 'confirmed', 'evidence': ['dictionary:v1']}]
        saved = self.save({'period_formats': variants})
        column = saved['tables'][0]['columns'][2]
        self.assertEqual((column['format'], column['format_status']), ('YYYYMM', 'confirmed'))
        self.assertEqual(prepare_knowledge(saved)['tables'][0]['understanding_status'], 'current')
        variants.append({'source_id': 'staff_report', 'field': 'period', 'variant_id': 'daily',
                         'format': 'YYYYMMDD', 'granularity': 'day', 'status': 'confirmed',
                         'selector': {'field': 'item', 'operator': 'eq', 'values': ['日统计']}, 'evidence': ['dictionary:v2']})
        scoped = self.save({'period_formats': variants}, raw=saved)
        column = scoped['tables'][0]['columns'][2]
        self.assertEqual((column['format'], column['format_status']), ('', 'scoped'))
        self.assertEqual(len(self.context(scoped)['period_formats']), 2)

    def test_unit_and_scope_dependencies_are_included_in_query_context(self):
        tables = deepcopy(self.raw['tables'])
        tables[0]['columns'].extend([{'name': 'unit_code', 'type': 'varchar(8)'}, {'name': 'kind_code', 'type': 'varchar(8)'}])
        tables[0]['columns'][4].update(unit_field='unit_code',
            scope_filter={'field': 'kind_code', 'operator': 'eq', 'values': ['COUNT']})
        physical = {'tables': deepcopy(tables)}
        saved = self.save({'tables': tables}, physical=physical)
        context = self.context(saved)
        columns = {c['name']: c for c in context['tables'][0]['columns']}
        self.assertTrue({'unit_code', 'kind_code'} <= set(columns))
        self.assertEqual(columns['amount']['status'], 'provisional')


if __name__ == '__main__':
    unittest.main()

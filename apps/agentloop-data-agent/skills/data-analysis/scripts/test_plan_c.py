"""QP-001..007 fixed positive and negative Plan C regressions."""
from copy import deepcopy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import data_client
from data_access import catalog_projection
from entity_binding import EntityBindingError, lookup_spec, validate_plan
from playbook_decision import decide, normalize_input, strip_input_only
from plan_composition import compose_plan
from semantic_retrieval import validate_request, KnowledgeRequestError
from query_errors import classify_failure
from test_catalog_knowledge import fixture


class PlanCQueryPilotTest(unittest.TestCase):
    def setUp(self):
        self.catalog = catalog_projection(fixture(), 'group')
        self.source = 'staff_report'
        self.plan = {'schema': 'nl2sql.query-plan/v1', 'scenario_id': 'group',
                     'catalog_revision': self.catalog['catalog_revision'],
                     'source_signatures': {self.source: self.catalog['tables'][0]['table_signature']}}

    def rejects(self, sql, params, plan, code):
        with self.assertRaises(EntityBindingError) as caught:
            validate_plan(self.catalog, sql, params, plan)
        self.assertEqual(caught.exception.code, code)

    def entity_for_scope(self, catalog, source, scope_id, codes, name):
        spec = lookup_spec(catalog, {'mention': name, 'canonical_name': name,
                                     'source_id': source, 'entity_id': 'organization'})
        rows = [{'org_code': code, 'org_name': name} for code in codes]
        return {'mention': name, 'matched_term': None, 'canonical_name': name,
                'entity': spec['entity'], 'scope_id': scope_id, 'selected_codes': codes,
                'selection_evidence': 'user-confirmed scope' if len(codes) > 1 else '',
                'lookup': {'schema': 'nl2sql.query-result/v1', 'status': 'completed',
                           'query_id': 'lookup_' + scope_id, 'scenario_id': 'group',
                           'catalog_revision': catalog['catalog_revision'],
                           'sql': spec['sql'], 'params': spec['params'],
                           'dataset': {'rows': rows, 'row_count': len(rows)}}}

    def test_compose_plan_preserves_complete_resolution_and_typed_time(self):
        intent = {'question': '公司 2026 年一月人数', 'pattern': 'period_comparison',
                  'source_ids': [self.source],
                  'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}],
                  'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}}
        context = {'schema': 'nl2sql.semantic-metadata/v1', 'operation': 'get-query-context',
                   'tables': [{'name': self.source, 'columns': [{'name': 'period'}]}],
                   'plan_seed': {**self.plan, 'metric_bindings': intent['metric_refs'],
                                 'entity_bindings': [], 'time_bindings': []}}
        decision = {'schema': 'nl2sql.evidence-decision/v1', 'decision': 'proceed',
                    'scenario_id': 'group', 'catalog_revision': self.plan['catalog_revision'],
                    'source_signatures': self.plan['source_signatures'], 'typed_intent': intent}
        binding = self.entity_for_scope(self.catalog, self.source, 'company', ['A'], 'Company')
        binding.pop('scope_id')
        resolution = {'schema': 'nl2sql.entity-resolution/v1', 'status': 'resolved',
                      'scenario_id': 'group', 'catalog_revision': self.plan['catalog_revision'],
                      'query_plan': {'entity_bindings': [binding]}}
        result = compose_plan(context, decision, [resolution], 'period')
        self.assertEqual(result['entity_bindings'][0], binding)
        self.assertEqual(result['time_bindings'], [{'source_id': self.source, 'field': 'period',
                                                    'start': '2026-01-01', 'end': '2026-02-01'}])
        self.assertEqual(result['business_intent'], intent)
        self.assertEqual(validate_plan(self.catalog,
            'SELECT SUM(amount) FROM business.staff_report WHERE org_code=%s AND item=%s AND period >= %s AND period < %s',
            ['A', '在岗员工人数', '202601', '202602'], result)['status'], 'verified')
        with self.assertRaises(ValueError):
            compose_plan(context, {**decision, 'decision': 'clarify'}, [resolution], 'period')
        with self.assertRaises(ValueError):
            compose_plan(context, decision, [{**resolution, 'catalog_revision': 'stale'}], 'period')

    def test_qp001_watermark_and_scope_are_distinct_from_schema(self):
        intent = {'question': '比较两个来源的员工数', 'pattern': 'scope_comparison',
                  'source_ids': ['staff_report', 'transactions'], 'metric_refs': [],
                  'scopes': [{'id': 'company', 'source_id': 'staff_report'},
                             {'id': 'headquarters', 'source_id': 'transactions'}]}
        decision = decide(self.catalog, intent)
        self.assertEqual(decision['decision'], 'reject')
        self.assertIn('snapshot_comparability_unproven', decision['reasons'])
        current = deepcopy(self.catalog)
        current['source_freshness'] = [
            {'source_id': 'staff_report', 'snapshot_id': '2026-01', 'watermark': '2026-01-31', 'provenance': 'catalog'},
            {'source_id': 'transactions', 'snapshot_id': '2026-01', 'watermark': '2026-01-31', 'provenance': 'catalog'}]
        self.assertNotIn('snapshot_comparability_unproven', decide(current, intent)['reasons'])
        current['source_freshness'][1]['watermark'] = '2026-02-01'
        self.assertIn('snapshot_comparability_unproven', decide(current, intent)['reasons'])

    def test_qp001_inclusion_request_cannot_hide_as_single_metric(self):
        base = {'question': '公司 2025 年 3 月在岗员工人数', 'pattern': 'single_metric',
                'source_ids': [self.source],
                'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}]}
        self.assertEqual(decide(self.catalog, base)['decision'], 'proceed')
        inclusive = {**base, 'question': '公司（含总部）2025 年 3 月在岗员工总数'}
        self.assertEqual(decide(self.catalog, inclusive)['decision'], 'clarify')
        self.assertIn('scope_business_unconfirmed', decide(self.catalog, inclusive)['reasons'])

    def test_catalog_blockers_are_rejects_not_hil(self):
        intent = {'question': '员工人数', 'pattern': 'single_metric',
                  'source_ids': [self.source],
                  'metric_refs': [{'source_id': self.source, 'metric_id': 'missing'}]}
        decision = decide(self.catalog, intent)
        self.assertEqual(decision['decision'], 'reject')
        self.assertIn('metric_definition_missing', decision['reasons'])
        cross = {'question': '两来源合计', 'pattern': 'single_metric',
                 'source_ids': [self.source, 'transactions'],
                 'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}],
                 'comparison': {'mode': 'joint_calculation'}}
        decision = decide(self.catalog, cross)
        self.assertEqual(decision['decision'], 'reject')
        self.assertIn('snapshot_comparability_unproven', decision['reasons'])

    def test_qp002_ratio_physical_branches(self):
        plan = deepcopy(self.plan)
        plan['ratio_binding'] = {'source_id': self.source, 'project_field': 'item',
            'measure_field': 'amount', 'numerator_values': ['在岗员工人数'],
            'denominator_values': ['在岗员工人数', '离岗人数'],
            'group_by': ['period'], 'zero_denominator': 'null'}
        sql = ("SELECT period, SUM(CASE WHEN item=%s THEN amount ELSE 0 END) / "
               "NULLIF(SUM(CASE WHEN item IN (%s,%s) THEN amount ELSE 0 END),0) AS ratio "
               "FROM business.staff_report WHERE item IN (%s,%s) GROUP BY period")
        params = ['在岗员工人数', '在岗员工人数', '离岗人数', '在岗员工人数', '离岗人数']
        self.assertIn('ratio_branches', validate_plan(self.catalog, sql, params, plan)['verification_scope'])
        formal = deepcopy(plan)
        formal['metric_bindings'] = [{'source_id': self.source, 'metric_id': 'headcount'}]
        formal['business_intent'] = {'question': '员工项目占比', 'pattern': 'ratio', 'source_ids': [self.source],
            'metric_refs': formal['metric_bindings'],
            'ratio': {**formal['ratio_binding'], 'definition_evidence': '本题已确认的项目定义'}}
        self.assertIn('ratio_branches', validate_plan(self.catalog, sql, params, formal)['verification_scope'])
        wrong = params.copy(); wrong[0] = '离岗人数'
        self.rejects(sql, wrong, plan, 'ratio_sql_mismatch')
        self.rejects(sql.replace('GROUP BY period', 'GROUP BY org_code'), params, plan, 'ratio_sql_mismatch')
        self.rejects(sql.replace('SELECT period,', 'SELECT org_code,'), params, plan, 'ratio_sql_mismatch')
        self.rejects(sql.replace('NULLIF(', '('), params, plan, 'ratio_sql_mismatch')

    def test_qp002_unsupported_ratio_is_rejected_before_sql(self):
        intent = {'question': '35岁以下占在岗比例', 'pattern': 'ratio', 'source_ids': [self.source],
                  'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}],
                  'ratio': {'source_id': self.source, 'project_field': 'item', 'measure_field': 'amount',
                            'numerator_values': ['35岁以下职工人数'], 'denominator_values': ['在岗员工人数'],
                            'group_by': ['period'], 'zero_denominator': 'null',
                            'definition_evidence': '两个不同项目'}}
        decision = decide(self.catalog, intent)
        self.assertEqual(decision['decision'], 'reject')
        self.assertIn('ratio_physical_shape_unsupported', decision['reasons'])

    def test_ratio_a_over_b_uses_distinct_branches_without_subset_rule(self):
        intent = {'question': '管理岗位人数与操作岗位人数之比', 'pattern': 'ratio',
                  'source_ids': [self.source],
                  'metric_refs': [],
                  'ratio': {'kind': 'a_over_b', 'source_id': self.source,
                            'project_field': 'item', 'measure_field': 'amount',
                            'numerator_values': ['管理岗位人数'],
                            'denominator_values': ['操作岗位人数'], 'group_by': ['period'],
                            'zero_denominator': 'null', 'definition_evidence': 'distinct report items'}}
        # A/B branch values need not be a catalog metric; physical fields are
        # still verified against the current source.
        self.assertEqual(decide(self.catalog, intent)['decision'], 'proceed')
        plan = {**self.plan, 'business_intent': intent,
                'metric_bindings': intent['metric_refs'],
                'ratio_binding': {k: v for k, v in intent['ratio'].items() if k != 'definition_evidence'}}
        sql = ('SELECT period, SUM(CASE WHEN item=%s THEN amount ELSE 0 END) / '
               'NULLIF(SUM(CASE WHEN item=%s THEN amount ELSE 0 END),0) AS ratio '
               'FROM business.staff_report WHERE item IN (%s,%s) GROUP BY period')
        params = ['管理岗位人数', '操作岗位人数', '管理岗位人数', '操作岗位人数']
        self.assertEqual(validate_plan(self.catalog, sql, params, plan)['status'], 'verified')
        bad = params.copy(); bad[1] = '在岗员工人数'
        self.rejects(sql, bad, plan, 'ratio_sql_mismatch')

    def test_ratio_equivalent_conditional_aggregates_keep_physical_proof(self):
        plan = {**self.plan, 'ratio_binding': {'kind': 'a_over_b', 'source_id': self.source,
            'project_field': 'item', 'measure_field': 'amount',
            'numerator_values': ['管理岗位人数'], 'denominator_values': ['操作岗位人数'],
            'group_by': ['period'], 'zero_denominator': 'null'}}
        sql = ('SELECT period, SUM(CASE WHEN item=%s THEN amount ELSE 0 END) / '
               'NULLIF(SUM(CASE WHEN item=%s THEN amount ELSE NULL END),0) AS ratio '
               'FROM business.staff_report WHERE item IN (%s,%s) GROUP BY period')
        params = ['管理岗位人数', '操作岗位人数', '管理岗位人数', '操作岗位人数']
        self.assertEqual(validate_plan(self.catalog, sql, params, plan)['status'], 'verified')
        unsafe = sql.replace('ELSE NULL END', 'ELSE amount END')
        self.rejects(unsafe, params, plan, 'ratio_sql_mismatch')
        self.rejects(sql.replace('THEN amount ELSE 0 END', 'THEN amount END'),
                     params, plan, 'ratio_sql_mismatch')

    def test_separate_listing_does_not_require_shared_snapshot(self):
        intent = {'question': '分别列示两个来源的信息', 'pattern': 'single_metric',
                  'source_ids': ['staff_report', 'transactions'],
                  'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}],
                  'comparison': {'mode': 'separate_listing'}}
        self.assertEqual(decide(self.catalog, intent)['decision'], 'proceed')
        joint = deepcopy(intent); joint['comparison'] = {'mode': 'joint_calculation'}
        self.assertIn('snapshot_comparability_unproven', decide(self.catalog, joint)['reasons'])
        plan = {**self.plan, 'source_signatures': decide(self.catalog, intent)['source_signatures'],
                'metric_bindings': intent['metric_refs'], 'business_intent': intent}
        sql = 'SELECT SUM(amount) FROM business.staff_report WHERE item=%s'
        self.assertEqual(validate_plan(self.catalog, sql, ['在岗员工人数'], plan)['status'], 'verified')
        joined = ('SELECT SUM(s.amount) FROM business.staff_report s '
                  'JOIN business.transactions t ON s.org_code=t.id WHERE s.item=%s')
        self.rejects(joined, ['在岗员工人数'], plan, 'separate_listing_sql_mismatch')

    def test_joint_intent_cannot_drop_a_declared_source(self):
        current = deepcopy(self.catalog)
        current['source_freshness'] = [
            {'source_id': source, 'snapshot_id': 'same', 'watermark': '2026-01-31', 'provenance': 'catalog'}
            for source in ('staff_report', 'transactions')]
        intent = {'question': '共同计算', 'pattern': 'single_metric',
                  'source_ids': ['staff_report', 'transactions'],
                  'metric_refs': [{'source_id': 'staff_report', 'metric_id': 'headcount'}],
                  'comparison': {'mode': 'joint_calculation'}}
        self.assertEqual(decide(current, intent)['decision'], 'proceed')
        plan = {**self.plan, 'source_signatures': decide(current, intent)['source_signatures'],
                'business_intent': intent, 'metric_bindings': intent['metric_refs']}
        with self.assertRaises(EntityBindingError) as caught:
            validate_plan(current, 'SELECT SUM(amount) FROM business.staff_report WHERE item=%s',
                          ['在岗员工人数'], plan)
        self.assertEqual(caught.exception.code, 'business_source_mismatch')

    def test_qp003_typed_time_is_encoded_once(self):
        plan = deepcopy(self.plan)
        plan['time_bindings'] = [{'source_id': self.source, 'field': 'period',
                                  'start': '2026-01-01', 'end': '2026-02-01'}]
        sql = 'SELECT SUM(amount) FROM business.staff_report WHERE period >= %s AND period < %s'
        self.assertEqual(validate_plan(self.catalog, sql, ['202601', '202602'], plan)['time_checks'][0]['storage_end'], '202602')
        self.rejects(sql, ['2026-01-01', '2026-02-01'], plan, 'time_sql_mismatch')

    def test_typed_business_filter_is_copied_and_cannot_be_dropped(self):
        intent = {'question': '按已确认类别统计', 'pattern': 'single_metric',
                  'source_ids': [self.source],
                  'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}],
                  'filters': [{'source_id': self.source, 'field': 'item', 'value': '在岗员工人数'}]}
        decision = decide(self.catalog, intent)
        self.assertEqual(decision['decision'], 'proceed')
        context = {'schema': 'nl2sql.semantic-metadata/v1', 'operation': 'get-query-context',
                   'tables': self.catalog['tables'], 'plan_seed': {**self.plan,
                       'metric_bindings': intent['metric_refs']}}
        plan = compose_plan(context, decision, [], None)
        self.assertEqual(plan['filter_bindings'], intent['filters'])
        sql = 'SELECT SUM(amount) FROM business.staff_report WHERE item=%s'
        self.assertEqual(validate_plan(self.catalog, sql, ['在岗员工人数'], plan)['status'], 'verified')
        bad = deepcopy(plan); bad.pop('filter_bindings')
        self.rejects(sql, ['在岗员工人数'], bad, 'business_plan_mismatch')

    def test_business_mismatch_points_to_one_generic_contract_slot(self):
        intent = {'question': '员工人数', 'pattern': 'single_metric',
                  'source_ids': [self.source],
                  'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}]}
        plan = {**self.plan, 'business_intent': intent}
        sql = 'SELECT SUM(amount) FROM business.staff_report WHERE item=%s'
        with self.assertRaises(EntityBindingError) as caught:
            validate_plan(self.catalog, sql, ['在岗员工人数'], plan)
        diagnostic = caught.exception.diagnostic()
        self.assertEqual(diagnostic['error_domain'], 'conflict')
        self.assertEqual(diagnostic['field'], 'metric_bindings')
        self.assertIn('headcount', diagnostic['expected'])
        self.assertEqual(diagnostic['actual'], '[]')

    def test_time_mismatch_points_to_the_typed_period(self):
        intent = {'question': '按月查员工人数', 'pattern': 'period_comparison',
                  'source_ids': [self.source],
                  'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}],
                  'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}}
        plan = {**self.plan, 'business_intent': intent, 'metric_bindings': intent['metric_refs'],
                'time_bindings': [{'source_id': self.source, 'field': 'period',
                                   'start': '2026-02-01', 'end': '2026-03-01'}]}
        with self.assertRaises(EntityBindingError) as caught:
            validate_plan(self.catalog, 'SELECT COUNT(*) FROM business.staff_report', [], plan)
        self.assertEqual(caught.exception.diagnostic()['field'], 'time_bindings')

    def test_new_table_needs_no_table_specific_gate_rule(self):
        raw = fixture()
        raw['tables'].append({'schema': 'business', 'name': 'future_source',
                              'label': 'New source', 'description': '', 'relation_type': 'table',
                              'columns': [{'name': 'category', 'type': 'varchar(40)', 'label': '',
                                           'description': '', 'value_domain': '', 'allow_output': True},
                                          {'name': 'value', 'type': 'decimal(20,4)', 'label': '',
                                           'description': '', 'value_domain': '', 'allow_output': True}]})
        catalog = catalog_projection(raw, 'group')
        intent = {'question': 'Group the new source by category', 'pattern': 'category_distribution',
                  'source_ids': ['future_source'], 'dimension_fields': ['category']}
        decision = decide(catalog, intent)
        self.assertEqual(decision['decision'], 'proceed')
        self.assertIn('business_meaning', decision['unverified'])
        plan = {'schema': 'nl2sql.query-plan/v1', 'scenario_id': 'group',
                'catalog_revision': catalog['catalog_revision'],
                'source_signatures': decision['source_signatures'], 'business_intent': intent}
        sql = 'SELECT category, COUNT(*) FROM business.future_source GROUP BY category'
        self.assertEqual(validate_plan(catalog, sql, [], plan)['status'], 'verified')
        with self.assertRaises(EntityBindingError) as caught:
            validate_plan(catalog, sql.replace('GROUP BY category', 'GROUP BY value'), [], plan)
        self.assertEqual(caught.exception.code, 'category_sql_mismatch')

    def test_compose_plan_requires_current_selector_definition(self):
        raw = fixture()
        raw['tables'][0]['columns'].append({'name': 'period_kind', 'type': 'varchar(1)'})
        raw['period_formats'][0]['selector'] = {'field': 'period_kind', 'value': 'M'}
        catalog = catalog_projection(raw, 'group')
        seed = {'schema': 'nl2sql.query-plan/v1', 'scenario_id': 'group',
                'catalog_revision': catalog['catalog_revision'],
                'source_signatures': {'staff_report': catalog['tables'][0]['table_signature']}}
        intent = {'question': '一月人数', 'pattern': 'period_comparison',
                  'source_ids': ['staff_report'], 'metric_refs': [],
                  'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}}
        context = {'schema': 'nl2sql.semantic-metadata/v1', 'operation': 'get-query-context',
                   'tables': catalog['tables'], 'period_formats': catalog['period_formats'],
                   'plan_seed': seed}
        decision = {'schema': 'nl2sql.evidence-decision/v1', 'decision': 'proceed',
                    'catalog_revision': seed['catalog_revision'], 'scenario_id': 'group',
                    'source_signatures': seed['source_signatures'], 'typed_intent': intent}
        result = compose_plan(context, decision, [], 'period', {'field': 'period_kind', 'value': 'M'})
        self.assertEqual(result['time_bindings'][0]['selector']['value'], 'M')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            compose_plan(context, decision, [], 'period', {'field': 'period_kind', 'value': 'D'})

    def test_qp004_classification_is_not_entity(self):
        intent = {'question': '按职称统计人数', 'pattern': 'category_distribution',
                  'source_ids': [self.source], 'dimension_fields': ['item']}
        self.assertEqual(decide(self.catalog, intent)['decision'], 'proceed')
        self.assertEqual(decide(self.catalog, {**intent, 'entity_roles': ['职称']})['decision'], 'reject')
        plan = {**self.plan, 'business_intent': intent}
        sql = 'SELECT item, COUNT(*) AS n FROM business.staff_report GROUP BY item'
        self.assertEqual(validate_plan(self.catalog, sql, [], plan)['status'], 'verified')
        self.rejects(sql.replace('GROUP BY item', 'GROUP BY org_code'), [], plan, 'category_sql_mismatch')

    def test_playbook_conflict_and_bounded_probe_decision(self):
        base = {'question': '按期看员工人数', 'source_ids': [self.source],
                'metric_refs': [{'source_id': self.source, 'metric_id': 'headcount'}]}
        conflict = decide(self.catalog, {**base, 'patterns': ['single_metric', 'period_comparison'],
                                         'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}})
        self.assertEqual(conflict['decision'], 'clarify')
        self.assertEqual(set(conflict['conflicts']), {'single_metric', 'period_comparison'})
        self.assertIn(self.source, conflict['source_signatures'])
        probe = decide(self.catalog, {**base, 'pattern': 'period_comparison',
                                      'probe': {'purpose': 'latest-period', 'source_id': self.source, 'field': 'period'}})
        self.assertEqual(probe['decision'], 'probe')

    def test_qp005_scope_scans_remain_independent(self):
        plan = deepcopy(self.plan)
        plan['scope_bindings'] = [
            {'id': 'company', 'source_id': self.source, 'field': 'org_code', 'codes': ['A'], 'output': 'company_value',
             'time_field': 'period', 'start': '2026-01-01', 'end': '2026-02-01'},
            {'id': 'headquarters', 'source_id': self.source, 'field': 'org_code', 'codes': ['A', 'B'], 'output': 'hq_value',
             'time_field': 'period', 'start': '2026-02-01', 'end': '2026-03-01'}]
        plan['entity_bindings'] = [
            self.entity_for_scope(self.catalog, self.source, 'company', ['A'], '华北'),
            self.entity_for_scope(self.catalog, self.source, 'headquarters', ['A', 'B'], '集团')]
        sql = ('WITH company AS (SELECT SUM(amount) AS value FROM business.staff_report '
               'WHERE org_code=%s AND period>=%s AND period<%s), '
               'headquarters AS (SELECT SUM(amount) AS value FROM business.staff_report '
               'WHERE org_code IN (%s,%s) AND period>=%s AND period<%s) '
               'SELECT company.value AS company_value, headquarters.value AS hq_value FROM company CROSS JOIN headquarters')
        params = ['A', '202601', '202602', 'A', 'B', '202602', '202603']
        self.assertIn('scope_scans', validate_plan(self.catalog, sql, params, plan)['verification_scope'])
        missing = deepcopy(plan); missing['entity_bindings'].pop()
        self.rejects(sql, params, missing, 'scope_entity_required')
        wrong = params.copy(); wrong[0] = 'B'
        self.rejects(sql, wrong, plan, 'entity_sql_mismatch')
        wrong = params.copy(); wrong[-1] = '202604'
        self.rejects(sql, wrong, plan, 'scope_sql_mismatch')

    def test_two_scopes_on_one_source_need_no_cross_source_watermark(self):
        intent = {'question': '同表两个组织分别列示', 'pattern': 'scope_comparison',
                  'source_ids': [self.source], 'confirmed_business_choice': '两个范围已确认',
                  'scopes': [{'id': 'company', 'source_id': self.source, 'codes': ['A'],
                              'output': 'company_value', 'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}},
                             {'id': 'headquarters', 'source_id': self.source, 'codes': ['B'],
                              'output': 'hq_value', 'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}}]}
        decision = decide(self.catalog, intent)
        self.assertEqual(decision['decision'], 'proceed')
        self.assertNotIn('snapshot_comparability_unproven', decision['reasons'])

    def test_qp005_cross_source_ctes(self):
        raw = fixture()
        raw['tables'][1]['columns'].extend(deepcopy(raw['tables'][0]['columns'][:3]))
        raw['period_formats'].append({'source_id': 'transactions', 'field': 'period',
                                      'format': '%Y%m', 'granularity': 'month'})
        raw['entities'].append({'id': 'organization', 'source_id': 'transactions',
                                'key_field': 'org_code', 'name_fields': ['org_name']})
        raw['source_freshness'] = [
            {'source_id': source, 'snapshot_id': '2026-01', 'watermark': '2026-01-31',
             'provenance': 'catalog-fixture'} for source in ('staff_report', 'transactions')]
        catalog = catalog_projection(raw, 'group')
        plan = {'schema': 'nl2sql.query-plan/v1', 'scenario_id': 'group',
                'catalog_revision': catalog['catalog_revision'],
                'source_signatures': {t['name']: t['table_signature'] for t in catalog['tables']},
                'scope_bindings': [
                    {'id': 'company', 'source_id': 'staff_report', 'field': 'org_code', 'codes': ['A'],
                     'output': 'company_value', 'time_field': 'period', 'start': '2026-01-01', 'end': '2026-02-01'},
                    {'id': 'headquarters', 'source_id': 'transactions', 'field': 'org_code', 'codes': ['H'],
                     'output': 'hq_value', 'time_field': 'period', 'start': '2026-01-01', 'end': '2026-02-01'}]}
        plan['entity_bindings'] = [
            self.entity_for_scope(catalog, 'staff_report', 'company', ['A'], '华北'),
            self.entity_for_scope(catalog, 'transactions', 'headquarters', ['H'], '总部')]
        plan['business_intent'] = {'question': '比较公司与总部同月值', 'pattern': 'scope_comparison',
            'source_ids': ['staff_report', 'transactions'], 'confirmed_business_choice': '用户已选两个范围',
            'scopes': [{k: v for k, v in scope.items() if k not in ('start', 'end')} | {
                'time_range': {'start': scope['start'], 'end': scope['end']}}
                for scope in plan['scope_bindings']]}
        sql = ('WITH company AS (SELECT SUM(amount) AS value FROM business.staff_report '
               'WHERE org_code=%s AND period>=%s AND period<%s), '
               'headquarters AS (SELECT SUM(value) AS value FROM business.transactions '
               'WHERE org_code=%s AND period>=%s AND period<%s) '
               'SELECT company.value AS company_value, headquarters.value AS hq_value '
               'FROM company CROSS JOIN headquarters')
        self.assertIn('scope_scans', validate_plan(catalog, sql,
            ['A', '202601', '202602', 'H', '202601', '202602'], plan)['verification_scope'])
        with self.assertRaises(EntityBindingError):
            validate_plan(catalog, sql, ['A', '202601', '202602', 'A', '202601', '202602'], plan)

    def test_qp005_separate_scopes_use_one_verified_source_per_query(self):
        catalog = self.catalog
        scopes = [
            {'id': 'company', 'source_id': self.source, 'field': 'org_code', 'codes': ['A'],
             'output': 'company_value', 'time_field': 'period',
             'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}},
            {'id': 'headquarters', 'source_id': self.source, 'field': 'org_code', 'codes': ['B'],
             'output': 'hq_value', 'time_field': 'period',
             'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}}]
        intent = {'question': '分别列示两家组织', 'pattern': 'scope_comparison',
                  'source_ids': [self.source], 'comparison': {'mode': 'separate_listing'},
                  'confirmed_business_choice': '分别列示', 'scopes': scopes}
        self.assertEqual(decide(catalog, intent)['decision'], 'proceed')
        for scope in scopes:
            binding = {k: v for k, v in scope.items() if k != 'time_range'} | scope['time_range']
            plan = {**self.plan, 'business_intent': intent, 'scope_bindings': [binding],
                    'entity_bindings': [self.entity_for_scope(catalog, self.source, scope['id'],
                                                             scope['codes'], scope['id'])]}
            sql = ('SELECT SUM(amount) AS ' + scope['output']
                   + ' FROM business.staff_report WHERE org_code=%s AND period>=%s AND period<%s')
            params = [scope['codes'][0], '202601', '202602']
            self.assertIn('scope_scans', validate_plan(catalog, sql, params, plan)['verified_claims'])
            with self.assertRaises(EntityBindingError):
                validate_plan(catalog, sql, ['Z', '202601', '202602'], plan)

    def test_qp006_error_provenance(self):
        self.assertEqual(classify_failure(429, 'app.admission', 'req-1', False)['origin'], 'app_admission')
        self.assertEqual(classify_failure(429, 'model.request', 'req-2', False)['origin'], 'model_upstream')
        self.assertEqual(classify_failure(500, 'query.execute', 'req-3', True)['origin'], 'query_gateway')

    def test_qp007_input_only_fields_are_recorded(self):
        clean, removed = normalize_input({'question': '人数', 'transport_request_id': 'abc', 'echo': '人数'})
        self.assertEqual(clean, {'question': '人数'})
        self.assertEqual(removed, ['echo', 'transport_request_id'])
        with self.assertRaises(ValueError):
            normalize_input({'question': '人数', 'company_scope': 'guessed'})
        metadata, removed = strip_input_only({'question': '人数', 'transport_request_id': 'abc'})
        self.assertEqual(removed, ['transport_request_id'])
        self.assertEqual(validate_request('retrieve-knowledge', metadata), {'question': '人数'})
        with self.assertRaises(KnowledgeRequestError):
            validate_request('retrieve-knowledge', {'question': '人数', 'company_scope': 'guessed'})
        gateway = Mock()
        gateway.knowledge.return_value = {'schema': 'nl2sql.semantic-metadata/v1', 'scenario_id': 'group'}
        with tempfile.TemporaryDirectory() as directory, patch.object(data_client, 'load_gateway', return_value=gateway):
            output = Path(directory) / 'result.json'
            with redirect_stdout(io.StringIO()):
                code = data_client.main(['retrieve-knowledge', '--scenario-id', 'group', '--request-json',
                    json.dumps({'question': '人数', 'echo': '回显'}), '--output', str(output)])
            self.assertEqual(code, 0)
            gateway.knowledge.assert_called_once_with('retrieve-knowledge', 'group', {'question': '人数'})
            self.assertEqual(json.loads(output.read_text())['input_normalization']['stripped_input_fields'], ['echo'])

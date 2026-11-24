"""原题覆盖与证据裁决的正反配对回归测试。"""
from copy import deepcopy
import unittest

from data_access import catalog_projection
from entity_binding import EntityBindingError, validate_plan
from playbook_decision import decide
from test_catalog_knowledge import fixture


class FusionTest(unittest.TestCase):
    def setUp(self):
        self.catalog = catalog_projection(fixture(), 'group')
        self.source = 'staff_report'
        self.metric = {'source_id': self.source, 'metric_id': 'headcount'}
        self.intent = {'question': '2026 年 1 月员工人数', 'pattern': 'period_comparison',
                       'source_ids': [self.source], 'metric_refs': [self.metric],
                       'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}}
        self.plan = {'schema': 'nl2sql.query-plan/v1', 'scenario_id': 'group',
                     'catalog_revision': self.catalog['catalog_revision'],
                     'source_signatures': {self.source: self.catalog['tables'][0]['table_signature']},
                     'metric_bindings': [self.metric],
                     'time_bindings': [{'source_id': self.source, 'field': 'period',
                                        'start': '2026-01-01', 'end': '2026-02-01'}],
                     'business_intent': self.intent}
        self.sql = 'SELECT SUM(amount) FROM business.staff_report WHERE item=%s AND period >= %s AND period < %s'
        self.params = ['在岗员工人数', '202601', '202602']

    def test_wrong_initial_metric_candidate_is_not_selected(self):
        intent = deepcopy(self.intent)
        intent['metric_refs'] = []
        decision = decide(self.catalog, intent)
        self.assertNotEqual(decision['decision'], 'proceed')
        self.assertTrue(all(c['evidence_status'] != 'selected' for c in decision['candidates']))

    def test_question_period_omission_is_visible_without_new_rejection(self):
        plan = deepcopy(self.plan)
        plan['business_intent']['question'] = '2026 年 1 月员工人数'
        plan['business_intent']['pattern'] = 'single_metric'
        plan['business_intent'].pop('time_range')
        plan.pop('time_bindings')
        sql = 'SELECT SUM(amount) FROM business.staff_report WHERE item=%s'
        result = validate_plan(self.catalog, sql, ['在岗员工人数'], plan)
        self.assertEqual(result['question_coverage']['status'], 'unproven')
        self.assertNotIn('original_question', result['verified_claims'])

    def test_model_question_conflict_is_exposed_without_new_rejection(self):
        plan = deepcopy(self.plan)
        plan['business_intent']['question'] = '2026 年 2 月员工人数'
        result = validate_plan(self.catalog, self.sql, self.params, plan)
        self.assertEqual(result['question_coverage']['conditions'][0]['status'], 'conflict')
        self.assertNotIn('original_question', result['verified_claims'])

    def test_unverified_question_cannot_become_original_question_claim(self):
        result = validate_plan(self.catalog, self.sql, self.params, self.plan)
        self.assertEqual(result['question_coverage']['question_authority'], 'model_supplied')
        self.assertNotIn('original_question', result['verified_claims'])

    def test_equivalent_group_by_alias_is_accepted(self):
        intent = {'question': '按项目分类', 'pattern': 'category_distribution',
                  'source_ids': [self.source], 'dimension_fields': ['item']}
        plan = {k: deepcopy(v) for k, v in self.plan.items() if k not in ('metric_bindings', 'time_bindings')}
        plan['business_intent'] = intent
        sql = 'SELECT item AS category, COUNT(*) AS n FROM business.staff_report GROUP BY category'
        self.assertEqual(validate_plan(self.catalog, sql, [], plan)['status'], 'verified')

    def test_wrong_category_grouping_is_rejected(self):
        intent = {'question': '按项目分类', 'pattern': 'category_distribution',
                  'source_ids': [self.source], 'dimension_fields': ['item']}
        plan = {k: deepcopy(v) for k, v in self.plan.items() if k not in ('metric_bindings', 'time_bindings')}
        plan['business_intent'] = intent
        with self.assertRaises(EntityBindingError) as caught:
            validate_plan(self.catalog, 'SELECT org_code, COUNT(*) FROM business.staff_report GROUP BY org_code', [], plan)
        self.assertEqual(caught.exception.code, 'category_sql_mismatch')
        # GROUP BY 名称若与物理列同名，MySQL 的解析对象可能是物理列；
        # 因此该别名不能视为与原维度等价，必须继续拒绝。
        with self.assertRaises(EntityBindingError) as collision:
            validate_plan(self.catalog,
                'SELECT item AS org_code, COUNT(*) FROM business.staff_report GROUP BY org_code', [], plan)
        self.assertEqual(collision.exception.code, 'category_sql_mismatch')

    def test_directory_missing_is_not_a_business_hil(self):
        intent = deepcopy(self.intent)
        intent['metric_refs'] = [{'source_id': self.source, 'metric_id': 'unknown'}]
        decision = decide(self.catalog, intent)
        self.assertEqual(decision['decision'], 'reject')
        self.assertEqual(decision['reason_domains']['metric_definition_missing'], 'catalog')

    def test_missing_typed_slot_is_input_error_not_hil(self):
        intent = deepcopy(self.intent)
        intent.pop('metric_refs')
        decision = decide(self.catalog, intent)
        self.assertEqual(decision['decision'], 'reject')
        self.assertEqual(decision['reason_domains']['metric_refs_missing'], 'input')

    def test_separate_listing_needs_no_unproved_scope_confirmation(self):
        intent = {'question': '分别列示两个组织的金额', 'pattern': 'scope_comparison',
                  'source_ids': [self.source], 'comparison': {'mode': 'separate_listing'},
                  'scopes': [{'id': 'first', 'source_id': self.source, 'codes': ['A'],
                              'output': 'first_value', 'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}},
                             {'id': 'second', 'source_id': self.source, 'codes': ['B'],
                              'output': 'second_value', 'time_range': {'start': '2026-01-01', 'end': '2026-02-01'}}]}
        self.assertNotIn('scope_business_unconfirmed', decide(self.catalog, intent)['reasons'])


if __name__ == '__main__':
    unittest.main()

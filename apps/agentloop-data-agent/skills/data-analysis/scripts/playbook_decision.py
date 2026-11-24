"""Small deterministic Playbook applicability and evidence decision.

This receipt supports the current model's business decision. It does not attest
to the user's original words or turn a model-supplied HIL answer into authority.
"""
from copy import deepcopy
from datetime import date
import re

INPUT_ONLY = {'echo', 'transport_request_id', 'client_trace_id'}
INTENT_FIELDS = {'question', 'pattern', 'patterns', 'source_ids', 'metric_refs',
                 'dimension_fields', 'entity_roles', 'scopes', 'time_range',
                 'comparison', 'confirmed_business_choice', 'ratio', 'probe',
                 'filters'}
PLAYBOOKS = {
    'single_metric': {'version': 1, 'requires': ('source_ids', 'metric_refs')},
    'period_comparison': {'version': 1, 'requires': ('source_ids', 'metric_refs', 'time_range')},
    'ratio': {'version': 1, 'requires': ('source_ids', 'metric_refs', 'ratio')},
    'scope_comparison': {'version': 1, 'requires': ('source_ids', 'scopes')},
    'category_distribution': {'version': 1, 'requires': ('source_ids', 'dimension_fields')},
}

# An inclusion or additive organization request needs an explicit scope choice
# when the current catalog does not define an inclusion relationship. This
# applies even if the model labels the question as a single_metric request.
ORGANIZATION_SCOPE_HINT = re.compile(r'(?:含|包括|包含|加上|合并|连同|及)\s*(?:公司|总部|分公司|子公司|集团)')


def normalize_input(value):
    if not isinstance(value, dict) or set(value) - INPUT_ONLY - INTENT_FIELDS:
        raise ValueError('Unknown business input field')
    clean = {key: deepcopy(item) for key, item in value.items() if key not in INPUT_ONLY}
    if not isinstance(clean.get('question'), str) or not clean['question'].strip() or len(clean['question']) > 4000:
        raise ValueError('question must contain 1..4000 characters')
    for key in ('source_ids', 'metric_refs', 'dimension_fields', 'entity_roles', 'scopes', 'patterns'):
        if key in clean and not isinstance(clean[key], list):
            raise ValueError(key + ' must be an array')
    if 'time_range' in clean:
        period = clean['time_range']
        if not isinstance(period, dict) or set(period) != {'start', 'end'}:
            raise ValueError('time_range needs ISO start and end')
        try:
            start, end = date.fromisoformat(period['start']), date.fromisoformat(period['end'])
        except (TypeError, ValueError):
            raise ValueError('time_range needs ISO start and end') from None
        if start >= end or start.isoformat() != period['start'] or end.isoformat() != period['end']:
            raise ValueError('time_range must be canonical increasing [start,end)')
    if 'filters' in clean:
        filters = clean['filters']
        if (not isinstance(filters, list) or not filters or len(filters) > 12
                or any(not isinstance(f, dict) or set(f) != {'source_id', 'field', 'value'}
                       or not isinstance(f['source_id'], str) or not isinstance(f['field'], str)
                       or type(f['value']) not in (str, int) for f in filters)):
            raise ValueError('filters must be source_id/field/value scalar bindings')
    if 'comparison' in clean and (not isinstance(clean['comparison'], dict)
            or set(clean['comparison']) != {'mode'}
            or clean['comparison']['mode'] not in ('separate_listing', 'joint_calculation')):
        raise ValueError('comparison.mode must be separate_listing or joint_calculation')
    if 'ratio' in clean and isinstance(clean['ratio'], dict) and 'kind' in clean['ratio']:
        if clean['ratio']['kind'] not in ('part_to_whole', 'a_over_b'):
            raise ValueError('ratio.kind must be part_to_whole or a_over_b')
    return clean, sorted(set(value) & INPUT_ONLY)


def strip_input_only(value):
    if not isinstance(value, dict):
        raise ValueError('Expected a request object')
    return {key: deepcopy(item) for key, item in value.items() if key not in INPUT_ONLY}, sorted(set(value) & INPUT_ONLY)


def decide(catalog, raw):
    intent, stripped = normalize_input(raw)
    tables = {table['name']: table for table in catalog['tables']}
    source_ids = intent.get('source_ids', [])
    if (not isinstance(source_ids, list) or not source_ids or len(source_ids) > 10
            or any(not isinstance(s, str) or s not in tables for s in source_ids)):
        return _receipt(catalog, intent, stripped, [], 'reject', ['source_not_authorized'])
    filters = intent.get('filters', [])
    if any(f['source_id'] not in source_ids or f['field'] not in
           {c['name'] for c in tables[f['source_id']]['columns']}
           for f in filters):
        return _receipt(catalog, intent, stripped, [], 'reject', ['filter_definition_invalid'])
    requested = intent.get('patterns', [intent.get('pattern')])
    if not isinstance(requested, list) or not requested or any(p not in PLAYBOOKS for p in requested):
        return _receipt(catalog, intent, stripped, [], 'reject', ['playbook_unknown'])
    candidates = []
    for pattern in PLAYBOOKS:
        rules = PLAYBOOKS[pattern]
        blockers = []
        if pattern in requested:
            blockers += [key + '_missing' for key in rules['requires']
                         if not intent.get(key) and not (pattern == 'ratio' and key == 'metric_refs'
                                                         and intent.get('ratio'))]
        else:
            blockers.append('not_requested')
        refs = intent.get('metric_refs', [])
        if pattern in requested and refs and (not isinstance(refs, list) or any(
                not isinstance(ref, dict) or set(ref) != {'source_id', 'metric_id'} or
                not any(m.get('table') == ref['source_id'] and m.get('name') == ref['metric_id']
                        for m in catalog['metrics']) for ref in refs)):
            blockers.append('metric_definition_missing')
        dims = intent.get('dimension_fields', [])
        if pattern in requested and dims and (not isinstance(dims, list) or any(
                not any(d == column['name'] for source in source_ids for column in tables[source].get('columns', []))
                for d in dims)):
            blockers.append('dimension_definition_missing')
        if pattern in requested and intent.get('entity_roles'):
            roles = {e['id'] for e in catalog['entities'] if e.get('source_id') in source_ids}
            if any(role not in roles for role in intent['entity_roles']):
                blockers.append('entity_role_undefined')
        candidates.append({'id': pattern, 'version': rules['version'], 'status': 'eligible' if not blockers else 'blocked',
                           'matched_features': [k for k in rules['requires'] if intent.get(k)],
                           'blocking': blockers})
    eligible = [c for c in candidates if c['status'] == 'eligible']
    reasons = []
    if len(eligible) > 1:
        reasons.append('playbook_conflict')
    if not eligible:
        reasons.extend(b for c in candidates if c['id'] in requested for b in c['blocking'])
    if any('entity_role_undefined' in c['blocking'] for c in candidates if c['id'] in requested):
        reasons.append('entity_role_undefined')
    if (len(source_ids) > 1
            and intent.get('comparison', {}).get('mode') != 'separate_listing'):
        freshness = {f.get('source_id'): f for f in catalog.get('source_freshness', [])}
        comparable = [freshness.get(s) for s in source_ids]
        if (not comparable or any(not f or not f.get('snapshot_id') or not f.get('watermark')
                                  or not f.get('provenance') for f in comparable)
                or len({(f['snapshot_id'], f['watermark']) for f in comparable if f}) > 1):
            reasons.append('snapshot_comparability_unproven')
    scopes = intent.get('scopes', [])
    if scopes and (not isinstance(scopes, list) or len({s.get('id') for s in scopes if isinstance(s, dict)}) != len(scopes)
                   or any(not isinstance(s, dict) or s.get('source_id') not in source_ids for s in scopes)):
        reasons.append('scope_definition_invalid')
    if scopes and any(not {'id', 'source_id', 'codes', 'output', 'time_range'} <= set(s)
                      for s in scopes if isinstance(s, dict)):
        reasons.append('scope_definition_missing')
    # 分别列示只要求每个 scope 自身有完整绑定；只有联合计算或相加才需要
    # 证明范围可比且不重叠。不能把这两种问题一律转成业务 HIL。
    if (scopes and intent.get('comparison', {}).get('mode') != 'separate_listing'
            and not intent.get('confirmed_business_choice')):
        reasons.append('scope_business_unconfirmed')
    if (ORGANIZATION_SCOPE_HINT.search(intent['question']) and not intent.get('confirmed_business_choice')
            and intent.get('comparison', {}).get('mode') != 'separate_listing'
            and any(entity.get('source_id') in source_ids for entity in catalog.get('entities', []))):
        reasons.append('scope_business_unconfirmed')
    if 'ratio' in requested:
        ratio = intent.get('ratio')
        if not isinstance(ratio, dict) or not {'numerator_values', 'denominator_values', 'group_by',
                'measure_field', 'zero_denominator', 'definition_evidence'} <= set(ratio):
            reasons.append('ratio_business_definition_unconfirmed')
        elif (ratio.get('kind', 'part_to_whole') == 'part_to_whole'
              and isinstance(ratio.get('numerator_values'), list)
              and isinstance(ratio.get('denominator_values'), list)
              and all(isinstance(v, str) for v in ratio['numerator_values'] + ratio['denominator_values'])
              and not set(ratio['numerator_values']) <= set(ratio['denominator_values'])):
            reasons.append('ratio_physical_shape_unsupported')
    probe = intent.get('probe')
    probe_valid = (isinstance(probe, dict) and set(probe) == {'purpose', 'source_id', 'field'}
                   and probe.get('purpose') in ('latest-period', 'distinct-values')
                   and probe.get('source_id') in source_ids
                   and any(probe.get('field') == c['name']
                           for c in tables[probe['source_id']].get('columns', []))) if probe else False
    physical_blockers = {'scope_definition_invalid', 'scope_definition_missing',
                         'entity_role_undefined', 'ratio_physical_shape_unsupported',
                         'metric_definition_missing', 'dimension_definition_missing',
                         'snapshot_comparability_unproven', 'filter_definition_invalid'}
    if physical_blockers.intersection(reasons):
        decision = 'reject'
    elif probe_valid and not eligible and set(reasons) <= {'time_range_missing'}:
        decision = 'probe'
    # 计划草稿缺字段属于输入问题，不能让用户在 HIL 中替模型补齐内部结构。
    elif any(reason.endswith('_missing') for reason in reasons):
        decision = 'reject'
    elif reasons or not eligible:
        decision = 'clarify'
    else:
        decision = 'proceed'
    return _receipt(catalog, intent, stripped, candidates, decision, sorted(set(reasons)), eligible)


def _receipt(catalog, intent, stripped, candidates, decision, reasons, eligible=()):
    selected = eligible[0] if decision == 'proceed' and len(eligible) == 1 else None
    # 唯一合格的 Playbook 仍只是模型提议的执行候选。这里记录其状态及其余
    # 候选的淘汰原因，不把模型排名或自报的确认标记当成用户授权证据。
    candidates = [{**candidate,
                   'evidence_status': ('proposed' if selected and candidate['id'] == selected['id'] else
                                       'runner_up' if candidate['status'] == 'eligible' else
                                       'rejected' if candidate['blocking'] == ['not_requested'] else 'unresolved'),
                   'rejection_evidence': candidate['blocking']} for candidate in candidates]
    catalog_reasons = {'metric_definition_missing', 'dimension_definition_missing',
                       'entity_role_undefined', 'filter_definition_invalid', 'source_not_authorized'}
    input_reasons = {'playbook_unknown', 'source_ids_missing', 'metric_refs_missing',
                     'time_range_missing', 'scope_definition_invalid', 'scope_definition_missing'}
    physical_reasons = {'ratio_physical_shape_unsupported', 'snapshot_comparability_unproven'}
    # 把目录缺项、输入错误、物理暂不可证和真正业务选择分开，供 Agent
    # 决定重查目录、重编计划、采用受控等价 SQL，还是发起最小澄清。
    reason_domains = {reason: ('catalog' if reason in catalog_reasons else
                               'input' if reason in input_reasons else
                               'unproven' if reason in physical_reasons else 'business_choice')
                      for reason in reasons}
    from question_coverage import coverage
    return {'schema': 'nl2sql.evidence-decision/v1', 'scenario_id': catalog['scenario_id'],
            'decision': decision,
            'catalog_revision': catalog['catalog_revision'], 'input_summary': {
                'question': intent['question'], 'source_ids': intent.get('source_ids', []),
                'stripped_input_fields': stripped},
            'source_signatures': {t['name']: t['table_signature'] for t in catalog['tables']
                                  if t['name'] in intent.get('source_ids', [])},
            'candidates': candidates, 'conflicts': [c['id'] for c in eligible] if len(eligible) > 1 else [],
            'selected_playbook': {k: selected[k] for k in ('id', 'version')} if selected else None,
            'typed_intent': deepcopy(intent),
            'reasons': reasons, 'reason_domains': reason_domains,
            'question_coverage': coverage(intent),
            'unverified': ['business_meaning', 'answer_accuracy', 'original_question_coverage'],
            'contract': {k: deepcopy(intent[k]) for k in ('source_ids', 'metric_refs', 'dimension_fields',
                         'scopes', 'time_range', 'ratio', 'filters') if k in intent} if selected else None}

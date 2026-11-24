"""Copy verified Skill receipts into one ordinary query plan; never execute SQL."""
from copy import deepcopy


def compose_plan(context, decision, resolutions, time_field=None, time_selector=None):
    if context.get('schema') != 'nl2sql.semantic-metadata/v1' or context.get('operation') != 'get-query-context':
        raise ValueError('context must be a get-query-context result')
    seed = context.get('plan_seed')
    if not isinstance(seed, dict) or seed.get('schema') != 'nl2sql.query-plan/v1':
        raise ValueError('context has no query plan seed')
    if decision.get('schema') != 'nl2sql.evidence-decision/v1' or decision.get('decision') != 'proceed':
        raise ValueError('business decision must proceed')
    if (decision.get('catalog_revision') != seed.get('catalog_revision')
            or decision.get('scenario_id') != seed.get('scenario_id')
            or decision.get('source_signatures') != seed.get('source_signatures')):
        raise ValueError('decision and context use different catalog or sources')
    intent = decision.get('typed_intent')
    if not isinstance(intent, dict):
        raise ValueError('decision has no typed intent')
    from playbook_decision import normalize_input
    normalized, stripped = normalize_input(intent)
    if stripped or normalized != intent:
        raise ValueError('decision typed intent is not normalized')
    if intent.get('source_ids') != list(seed['source_signatures']):
        raise ValueError('decision sources differ from plan seed')
    plan = deepcopy(seed)
    plan['business_intent'] = deepcopy(intent)
    if intent.get('filters'):
        plan['filter_bindings'] = deepcopy(intent['filters'])
    bindings = []
    for resolution in resolutions:
        if (resolution.get('schema') != 'nl2sql.entity-resolution/v1'
                or resolution.get('status') != 'resolved'
                or resolution.get('scenario_id') != seed['scenario_id']
                or resolution.get('catalog_revision') != seed['catalog_revision']):
            raise ValueError('entity resolution is not current and resolved')
        entity_plan = resolution.get('query_plan')
        if not isinstance(entity_plan, dict) or not isinstance(entity_plan.get('entity_bindings'), list):
            raise ValueError('entity resolution has no bindings')
        bindings.extend(deepcopy(entity_plan['entity_bindings']))
    plan['entity_bindings'] = bindings
    period = intent.get('time_range')
    if period is not None:
        sources = intent['source_ids']
        if not time_field or len(sources) != 1:
            raise ValueError('single-source time range requires --time-field')
        columns = next((t['columns'] for t in context.get('tables', []) if t['name'] == sources[0]), [])
        if time_field not in {column['name'] for column in columns}:
            raise ValueError('time field is absent from selected source')
        binding = {'source_id': sources[0], 'field': time_field,
                   'start': period['start'], 'end': period['end']}
        if time_selector is not None:
            if (not isinstance(time_selector, dict) or not {'field', 'value'} <= set(time_selector)
                    or set(time_selector) - {'field', 'value', 'period_length'}):
                raise ValueError('time selector needs field, value and optional period_length')
            policies = [p for p in context.get('period_formats', [])
                        if p.get('source_id') == sources[0] and p.get('field') == time_field
                        and p.get('selector') == time_selector and p.get('definition_status') == 'current']
            if len(policies) != 1:
                raise ValueError('time selector does not match one current period definition')
            binding['selector'] = deepcopy(time_selector)
        plan['time_bindings'] = [binding]
    elif time_field:
        raise ValueError('--time-field needs a typed time_range')
    elif time_selector is not None:
        raise ValueError('--time-selector needs a typed time_range and --time-field')
    if intent.get('pattern') in ('ratio', 'scope_comparison') or intent.get('patterns'):
        raise ValueError('ratio and multi-scope plans need their explicit physical bindings')
    return plan

"""Skill-owned entity evidence and orchestration of query binding verification."""
from copy import deepcopy
import hashlib
import json


class EntityBindingError(ValueError):
    def __init__(self, code, message, *, field=None, expected=None, actual=None):
        super().__init__(message)
        self.code = code
        self.field, self.expected, self.actual = field, expected, actual

    def diagnostic(self):
        # 错误域用于决定修复路径：输入缺项回到计划构造，目录变化先重查定义，
        # 已证实冲突才要求重选候选或改 SQL；无法证明的合法形态不能伪装成业务歧义。
        domain = ('unproven' if self.code.endswith(('_unverified', '_unsupported')) else
                  'input' if self.code.endswith(('_invalid', '_required')) else
                  'catalog' if self.code.endswith(('_missing', '_stale', '_changed')) else
                  'conflict' if self.code.endswith(('_mismatch', '_conflict', '_rejected')) else
                  self.code.split('_', 1)[0])
        return {'error_domain': domain, 'field': self.field or 'query_plan',
                'expected': self.expected or str(self),
                'actual': self.actual or self.code}


def require(condition, code, message, **details):
    if not condition:
        raise EntityBindingError(code, message, **details)


def require_match(actual, expected, field, message):
    """Report the mismatched contract slot without any table-specific repair rule."""
    require(actual == expected, 'business_plan_mismatch', message,
            field=field, expected=repr(expected), actual=repr(actual))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def term_matches(catalog, text):
    """Expose complete matching definitions; do not parse prose into identities."""
    matches = []
    canonical = {term['term'] for term in catalog['terms']}
    for term in catalog['terms']:
        names = [term['term'], *(a for a in term.get('aliases', []) if a not in canonical)]
        hits = [name for name in names
                if isinstance(name, str) and name and name in text]
        if hits:
            matched = max(hits, key=len)
            matches.append({'matched_text': matched,
                            'match_scope': 'exact' if matched.strip() == text.strip() else 'context',
                            'definition': deepcopy(term)})
    return matches


def lookup_spec(catalog, request):
    require(isinstance(request, dict) and not set(request) - {
        'mention', 'matched_term', 'canonical_name', 'source_id', 'entity_id'},
        'entity_request_invalid', 'Supply mention, matched_term, canonical_name, source_id and entity_id')
    for key in ('mention', 'canonical_name', 'source_id', 'entity_id'):
        require(isinstance(request.get(key), str) and bool(request[key].strip()),
                'entity_request_invalid', 'Entity identity fields must be nonempty strings')
    entities = [e for e in catalog['entities'] if e['id'] == request['entity_id']
                and e['source_id'] == request['source_id'] and e.get('definition_status') == 'current']
    require(len(entities) == 1, 'entity_definition_invalid', 'Use one current source-bound entity definition')
    entity = entities[0]
    table = next(t for t in catalog['tables'] if t['name'] == entity['source_id'])
    matched = request.get('matched_term')
    definitions = [m['definition'] for m in term_matches(catalog, request['mention'])
                   if m['definition']['term'] == matched
                   and request['mention'] in [m['definition']['term'], *m['definition'].get('aliases', [])]]
    term = None
    if matched is not None:
        require(len(definitions) == 1, 'term_binding_invalid', 'The mention must match one catalog term or alias')
        term = definitions[0]
        require(request['canonical_name'] in term.get('meaning', '')
                or request['canonical_name'] in [term['term'], *term.get('aliases', [])],
                'canonical_name_unsupported', 'Canonical name must be grounded in the matched term definition')
    else:
        require(not term_matches(catalog, request['mention']), 'matched_term_required',
                'The mention matches catalog terms; bind the applicable term before querying')
        require(request['canonical_name'] == request['mention'], 'canonical_name_unsupported',
                'Without a matched term, verify the supplied name itself; do not invent an expansion')
    fields = list(dict.fromkeys([entity['key_field'], *entity.get('name_fields', [])]))
    require(bool(entity.get('name_fields')), 'entity_definition_invalid', 'Entity definition needs name fields')
    identifiers = [table.get('schema', ''), table['name'], *fields]
    require(all(isinstance(v, str) and v.isidentifier() and v.isascii() for v in identifiers),
            'entity_definition_invalid', 'Entity lookup requires valid physical identifiers')
    quote = lambda value: '`' + value + '`'
    sql = ('SELECT DISTINCT ' + ', '.join(map(quote, fields)) + ' FROM '
           + quote(table['schema']) + '.' + quote(table['name']) + ' WHERE '
           + ' OR '.join(quote(field) + ' = %s' for field in entity['name_fields']))
    return {'mention': request['mention'], 'matched_term': deepcopy(term),
            'canonical_name': request['canonical_name'], 'entity': deepcopy(entity),
            'sql': sql, 'params': [request['canonical_name']] * len(entity['name_fields'])}


def resolution_result(catalog, spec, lookup):
    result = {'schema': 'nl2sql.entity-resolution/v1', 'scenario_id': catalog['scenario_id'],
              'catalog_revision': catalog['catalog_revision'], 'lookup': lookup}
    if lookup['status'] != 'completed':
        return {**result, 'status': 'failed', 'error': lookup['error']}
    require(lookup['catalog_revision'] == catalog['catalog_revision'], 'query_plan_stale',
            'Catalog changed during entity lookup; resolve the entity again')
    rows = lookup['dataset']['rows']
    key = spec['entity']['key_field']
    codes = list(dict.fromkeys(row[key] for row in rows if row.get(key) is not None))
    binding = {k: deepcopy(spec[k]) for k in ('mention', 'matched_term', 'canonical_name', 'entity')}
    binding['lookup'] = deepcopy(lookup)
    binding['selected_codes'] = codes if len(codes) == 1 else []
    status = 'resolved' if len(codes) == 1 else 'ambiguous' if codes else 'unmatched'
    result.update(status=status, candidates=rows, candidate_codes=codes,
                  query_plan={'schema': 'nl2sql.query-plan/v1', 'scenario_id': catalog['scenario_id'],
                              'catalog_revision': catalog['catalog_revision'], 'entity_bindings': [binding]})
    return result


def validate_plan(catalog, sql, params, plan):
    """Verify source-bound evidence and exact SQL selectors; never rewrite SQL."""
    require(isinstance(plan, dict) and {'schema', 'scenario_id', 'catalog_revision'} <= set(plan)
        and set(plan) <= {'schema', 'scenario_id', 'catalog_revision', 'entity_bindings',
                         'metric_bindings', 'time_bindings', 'source_signatures',
                         'ratio_binding', 'scope_bindings', 'filter_bindings', 'business_intent'}
        and plan['schema'] == 'nl2sql.query-plan/v1', 'query_plan_invalid', 'Use a query-plan object')
    require(plan['scenario_id'] == catalog['scenario_id'] and plan['catalog_revision'] == catalog['catalog_revision'],
            'query_plan_stale', 'Scenario or catalog revision changed; rebind affected definitions')
    keys = ('entity_bindings', 'metric_bindings', 'time_bindings')
    if 'source_signatures' in plan:
        from catalog_knowledge import table_signature
        signatures = plan['source_signatures']
        tables = {t['name']: t for t in catalog['tables']}
        require(isinstance(signatures, dict) and bool(signatures)
                and all(source in tables and signature == table_signature(tables[source])
                        for source, signature in signatures.items()),
                'query_schema_changed', 'A selected source structure changed; reload query context and rebind')
    require(all(isinstance(plan.get(key, []), list) for key in keys)
            and isinstance(plan.get('filter_bindings', []), list)
            and (any(plan.get(key) for key in keys) or bool(plan.get('source_signatures'))
                 or bool(plan.get('filter_bindings'))),
            'query_plan_invalid', 'Query plan must contain source signatures, entity, metric or time bindings')
    # 覆盖表随正式回执保留，但其题面来自模型，不能单凭该表升级为原题已验证。
    # 本阶段硬拒绝仍须依赖下方目录、实体、时间及 SQL 的独立物理证据。
    question_coverage = None
    if 'business_intent' in plan:
        from playbook_decision import decide
        try:
            decision = decide(catalog, plan['business_intent'])
        except (TypeError, ValueError):
            raise EntityBindingError('business_intent_invalid', 'Business intent is not a valid typed input') from None
        require(decision['decision'] == 'proceed', 'business_decision_unresolved',
                'Business intent needs a current unambiguous Playbook decision',
                field='business_intent', expected='proceed',
                actual=repr({'decision': decision['decision'], 'reasons': decision['reasons']}))
        from question_coverage import check_coverage
        question_coverage = check_coverage(plan['business_intent'])
        require_match(plan.get('source_signatures'), decision['source_signatures'],
                      'source_signatures', 'Plan sources differ from the current business decision')
        intent = plan['business_intent']
        separate = intent.get('comparison', {}).get('mode') == 'separate_listing'
        scopes = intent.get('scopes', []) if separate and decision['selected_playbook']['id'] == 'scope_comparison' else []
        selected_scope = plan.get('scope_bindings', [None])[0] if scopes and len(plan.get('scope_bindings', [])) == 1 else None
        selected_source = selected_scope.get('source_id') if isinstance(selected_scope, dict) else None
        selected_id = selected_scope.get('id') if isinstance(selected_scope, dict) else None
        expected_metrics = ([m for m in intent.get('metric_refs', []) if m.get('source_id') == selected_source]
                            if selected_scope else intent.get('metric_refs', []))
        expected_filters = ([f for f in intent.get('filters', []) if f.get('source_id') == selected_source]
                            if selected_scope else intent.get('filters', []))
        require_match(plan.get('metric_bindings', []), expected_metrics,
                      'metric_bindings', 'Metric bindings differ from the business decision')
        require_match(plan.get('filter_bindings', []), expected_filters,
                      'filter_bindings', 'Filter bindings differ from the business decision')
        if 'time_range' in intent:
            valid_time = bool(plan.get('time_bindings')) and all(
                b.get('start') == intent['time_range']['start'] and b.get('end') == intent['time_range']['end']
                for b in plan['time_bindings'])
            require(valid_time, 'business_plan_mismatch', 'Typed period differs from the execution plan',
                    field='time_bindings', expected=repr(intent['time_range']),
                    actual=repr(plan.get('time_bindings', [])))
        else:
            require(not plan.get('time_bindings'), 'business_plan_mismatch',
                    'Execution plan contains a period absent from the business decision',
                    field='time_bindings', expected='[]', actual=repr(plan.get('time_bindings')))
        if decision['selected_playbook']['id'] == 'ratio':
            ratio = intent['ratio']
            for key in ('source_id', 'project_field', 'measure_field', 'numerator_values',
                        'denominator_values', 'group_by', 'zero_denominator', 'kind'):
                if key == 'kind' and key not in ratio:
                    continue
                actual = plan.get('ratio_binding', {}).get(key) if isinstance(plan.get('ratio_binding'), dict) else None
                require_match(actual, ratio.get(key), 'ratio_binding.' + key,
                              'Ratio branches differ from the business decision')
        if decision['selected_playbook']['id'] == 'scope_comparison':
            scopes = intent['scopes']
            bound = plan.get('scope_bindings', [])
            selected = ([s for s in scopes if s.get('id') == selected_id]
                        if separate and selected_scope else scopes)
            require(isinstance(bound, list) and len(bound) == len(selected),
                    'business_plan_mismatch', 'Scope binding count differs from the business decision',
                    field='scope_bindings', expected=f'{len(selected)} scopes',
                    actual=f'{len(bound) if isinstance(bound, list) else type(bound).__name__} scopes')
            for scope in selected:
                matches = [b for b in bound if isinstance(b, dict) and b.get('id') == scope.get('id')]
                require(len(matches) == 1, 'business_plan_mismatch', 'Scope id differs from the business decision',
                        field='scope_bindings.id', expected=repr(scope.get('id')),
                        actual=repr([b.get('id') for b in bound if isinstance(b, dict)]))
                for field, value in (('source_id', scope.get('source_id')), ('field', scope.get('field')),
                                     ('codes', scope.get('codes')), ('output', scope.get('output')),
                                     ('time_field', scope.get('time_field')),
                                     ('start', scope.get('time_range', {}).get('start')),
                                     ('end', scope.get('time_range', {}).get('end')),
                                     ('time_selector', scope.get('time_selector'))):
                    require_match(matches[0].get(field), value,
                                  f"scope_bindings[{scope['id']}].{field}",
                                  'Scope bindings differ from the business decision')
        else:
            require(not plan.get('scope_bindings'), 'business_plan_mismatch',
                    'Unexpected scope binding for the selected Playbook',
                    field='scope_bindings', expected='[]', actual=repr(plan.get('scope_bindings')))
        if decision['selected_playbook']['id'] != 'ratio':
            require(not plan.get('ratio_binding'), 'business_plan_mismatch',
                    'Unexpected ratio binding for the selected Playbook',
                    field='ratio_binding', expected='None', actual=repr(plan.get('ratio_binding')))
    bindings = []
    for binding in plan.get('entity_bindings', []):
        require(isinstance(binding, dict) and set(binding) <= {
            'mention', 'matched_term', 'canonical_name', 'entity', 'lookup', 'selected_codes', 'selection_evidence',
            'scope_id'},
            'entity_binding_invalid', 'Invalid entity binding fields')
        entity = binding.get('entity', {})
        term = binding.get('matched_term')
        require(isinstance(entity, dict) and (term is None or isinstance(term, dict)),
                'entity_binding_invalid', 'Entity and matched term must retain catalog definitions')
        spec = lookup_spec(catalog, {'mention': binding.get('mention'),
            'matched_term': term.get('term') if isinstance(term, dict) else None,
            'canonical_name': binding.get('canonical_name'), 'source_id': entity.get('source_id'),
            'entity_id': entity.get('id')})
        require(entity == spec['entity'] and term == spec['matched_term'], 'entity_binding_stale',
                'Entity and term definitions must match the current catalog')
        lookup = binding.get('lookup', {})
        require(isinstance(lookup, dict) and lookup.get('schema') == 'nl2sql.query-result/v1'
                and lookup.get('status') == 'completed' and bool(lookup.get('query_id'))
                and lookup.get('scenario_id') == catalog['scenario_id']
                and lookup.get('catalog_revision') == catalog['catalog_revision']
                and lookup.get('sql') == spec['sql'] and lookup.get('params') == spec['params'],
                'entity_lookup_invalid', 'Keep the successful canonical-name lookup result as binding evidence')
        dataset = lookup.get('dataset', {})
        require(isinstance(dataset, dict), 'entity_lookup_invalid', 'Missing lookup dataset')
        rows = dataset.get('rows', [])
        require(isinstance(rows, list) and dataset.get('row_count') == len(rows),
                'entity_lookup_invalid', 'Entity evidence must contain complete candidate rows')
        key = entity['key_field']
        require(all(isinstance(row, dict) and row.get(key) is not None
                    and any(row.get(f) == binding['canonical_name'] for f in entity['name_fields']) for row in rows),
                'entity_lookup_invalid', 'Candidate rows must retain the canonical name and entity key')
        candidates = {scalar(row[key]) for row in rows}
        codes = binding.get('selected_codes')
        require(isinstance(codes, list) and bool(codes), 'entity_selection_required', 'Select entity codes before data retrieval')
        selected = {scalar(code) for code in codes}
        require(len(selected) == len(codes) and selected <= candidates, 'entity_selection_invalid',
                'Selected codes must be distinct codes from the canonical-name lookup')
        if len(candidates) > 1:
            require(isinstance(binding.get('selection_evidence'), str) and bool(binding['selection_evidence'].strip()),
                    'entity_selection_required', 'Ambiguous candidates require a user decision or other explicit selection evidence')
        bindings.append(binding)
    if plan.get('scope_bindings') is not None:
        require(isinstance(plan['scope_bindings'], list)
                and all(isinstance(s, dict) for s in plan['scope_bindings']),
                'scope_binding_invalid', 'Scope bindings must be an array of objects')
        for scope_binding in plan['scope_bindings']:
            matches = [b for b in bindings if b.get('scope_id') == scope_binding.get('id')
                       and b['entity']['source_id'] == scope_binding.get('source_id')
                       and b['entity']['key_field'] == scope_binding.get('field')]
            require(len(matches) == 1 and {scalar(v) for v in matches[0]['selected_codes']}
                    == {scalar(v) for v in scope_binding.get('codes', [])},
                    'scope_entity_required', 'Each scope must retain its own source-bound entity lookup and codes')
    from sql_evidence import SqlEvidence
    from query_constraints import constraint_checks
    evidence = SqlEvidence(sql, params)
    if ('business_intent' in plan and plan['business_intent'].get('comparison', {}).get('mode')
            == 'separate_listing'):
        from sqlglot import exp
        require(len(list(evidence.physical_sources())) == 1
                and not any(isinstance(scope.expression, exp.Select) and scope.expression.args.get('joins')
                            for scope in evidence.scopes),
                'separate_listing_sql_mismatch',
                'Separate listing cannot combine sources in one SQL query',
                field='business_intent.comparison.mode', expected='one physical source per query',
                actual='joined or combined source scan')
    if 'business_intent' in plan and decision['selected_playbook']['id'] == 'category_distribution':
        from sqlglot import exp
        group = evidence.tree.args.get('group') if isinstance(evidence.tree, exp.Select) else None
        # GROUP BY 可引用投影别名；仅当别名不与源表物理列同名时，才可把它
        # 还原为投影列。发生同名碰撞时 SQL 的解析语义可能不同，不能放宽验证。
        physical_columns = {column['name'] for table in catalog['tables']
                            for column in table['columns'] if table['name'] in
                            plan['business_intent']['source_ids']}
        aliases = {projection.alias: projection.this.name for projection in evidence.tree.expressions
                   if isinstance(projection, exp.Alias) and isinstance(projection.this, exp.Column)
                   and projection.alias not in physical_columns}
        actual = [aliases.get(g.name, g.name) for g in group.expressions] if group else []
        require(actual == plan['business_intent']['dimension_fields']
                and all(isinstance(g, exp.Column) for g in (group.expressions if group else [])),
                'category_sql_mismatch', 'Category GROUP BY must match the selected dimensions',
                field='business_intent.dimension_fields',
                expected=repr(plan['business_intent']['dimension_fields']), actual=repr(actual))
    if 'source_signatures' in plan:
        require(all(table['name'] in plan['source_signatures'] for table in catalog['tables']
                    if list(evidence.scans(table))),
                'query_source_unbound', 'Every SQL source must be included in the verified query context')
    if 'business_intent' in plan:
        declared = set(plan['business_intent']['source_ids'])
        scanned = {table['name'] for table in catalog['tables'] if list(evidence.scans(table))}
        if plan['business_intent'].get('comparison', {}).get('mode') != 'separate_listing':
            require(declared == scanned, 'business_source_mismatch',
                    'The SQL must cover each declared business source',
                    field='business_intent.source_ids', expected=repr(sorted(declared)),
                    actual=repr(sorted(scanned)))
        else:
            require(bool(scanned) and scanned <= declared, 'business_source_mismatch',
                    'Each separate-listing SQL may use one declared business source',
                    field='business_intent.source_ids', expected=repr(sorted(declared)),
                    actual=repr(sorted(scanned)))
    separate_listing = bool('business_intent' in plan and
        plan['business_intent'].get('comparison', {}).get('mode') == 'separate_listing')
    checks = sql_checks(catalog, sql, params, bindings, evidence, separate_listing=separate_listing,
                        scope_bindings=plan.get('scope_bindings', []))
    constraints = constraint_checks(catalog, plan, evidence,
        separate_listing=separate_listing)
    scope = (['source_signatures'] if plan.get('source_signatures') else []) + (['entity_codes'] if bindings else [])
    if constraints['metric_checks']:
        scope.append('metric_definitions')
    if any(c['verification_scope'] == 'project_selector' for c in constraints['metric_checks']):
        scope.append('metric_projects')
    if constraints['time_checks']:
        scope.append('time_ranges')
    if constraints['filter_checks']:
        scope.append('physical_filters')
    if constraints['ratio_check']:
        scope.append('ratio_branches')
    if constraints['scope_checks']:
        scope.append('scope_scans')
    return {'status': 'verified', 'plan_sha256': digest(plan), 'entity_checks': checks,
            'question_coverage': question_coverage,
            **constraints, 'verification_scope': scope,
            'verified_claims': scope,
            'agent_review_required': ['metric_expression', 'aggregation_grain', 'units', 'business_meaning',
                                      'scope_identity', 'snapshot_comparability', 'answer_accuracy']}


def scalar(value):
    require(type(value) in (str, int), 'entity_code_invalid', 'Entity codes must be strings or integers')
    return (type(value).__name__, value)


def sql_checks(catalog, sql, params, bindings, evidence, *, separate_listing=False, scope_bindings=()):
    checks = []
    for binding in bindings:
        entity = binding['entity']
        table = next(t for t in catalog['tables'] if t['name'] == entity['source_id'])
        selected = {scalar(code) for code in binding['selected_codes']}
        occurrences = []
        scoped = list(evidence.scoped_scans(table))
        if binding.get('scope_id'):
            with_clause = evidence.tree.args.get('with_')
            ctes = {c.alias_or_name: c.this for c in with_clause.expressions} if with_clause else {}
            if (separate_listing and len(scope_bindings) == 1
                    and scope_bindings[0].get('id') == binding['scope_id']
                    and not ctes and plan_separate_scope(evidence, scope_bindings[0])):
                scoped = [s for s in scoped if s[0] is evidence.tree]
            else:
                scoped = [s for s in scoped if s[0] is ctes.get(binding['scope_id'])]
        for _, alias, where, single in scoped:
            actual = evidence.selector(where, alias, entity['key_field'], single)
            require(actual == selected, 'entity_sql_mismatch',
                    'SQL must filter ' + table['name'] + '.' + entity['key_field']
                    + ' by exactly the selected codes using parameterized = or IN in each physical source WHERE; '
                    'name LIKE, OR bypasses and filters on other sources do not implement the binding')
            occurrences.append(alias)
        require(bool(occurrences), 'entity_sql_mismatch', 'Bound entity source is absent from SQL')
        checks.append({'mention': binding['mention'], 'term': (binding['matched_term'] or {}).get('term'),
                       'canonical_name': binding['canonical_name'], 'source_id': entity['source_id'],
                       'key_field': entity['key_field'], 'selected_codes': binding['selected_codes'],
                       'sql_codes': binding['selected_codes'],
                       'lookup_query_id': binding['lookup']['query_id'], 'table_aliases': occurrences,
                       'status': 'verified'})
    return checks


def plan_separate_scope(evidence, binding):
    # This helper is only called for a single direct Select; scope_constraints
    # still verifies its output, source, selector and period independently.
    from sqlglot import exp
    root = evidence.tree
    return (isinstance(root, exp.Select) and not root.args.get('with_')
            and len(root.expressions) == 1 and root.expressions[0].alias_or_name == binding.get('output'))

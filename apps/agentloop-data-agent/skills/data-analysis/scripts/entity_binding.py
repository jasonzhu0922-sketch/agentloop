"""Skill-owned entity evidence and orchestration of query binding verification."""
from copy import deepcopy
import hashlib
import json


class EntityBindingError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise EntityBindingError(code, message)


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
                         'metric_bindings', 'time_bindings', 'source_signatures'}
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
            and (any(plan.get(key) for key in keys) or bool(plan.get('source_signatures'))),
            'query_plan_invalid', 'Query plan must contain source signatures, entity, metric or time bindings')
    bindings = []
    for binding in plan.get('entity_bindings', []):
        require(isinstance(binding, dict) and set(binding) <= {
            'mention', 'matched_term', 'canonical_name', 'entity', 'lookup', 'selected_codes', 'selection_evidence'},
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
    from sql_evidence import SqlEvidence
    from query_constraints import constraint_checks
    evidence = SqlEvidence(sql, params)
    if 'source_signatures' in plan:
        require(all(table['name'] in plan['source_signatures'] for table in catalog['tables']
                    if list(evidence.scans(table))),
                'query_source_unbound', 'Every SQL source must be included in the verified query context')
    checks = sql_checks(catalog, sql, params, bindings, evidence)
    constraints = constraint_checks(catalog, plan, evidence)
    scope = (['source_signatures'] if plan.get('source_signatures') else []) + (['entity_codes'] if bindings else [])
    if constraints['metric_checks']:
        scope.append('metric_definitions')
    if any(c['verification_scope'] == 'project_selector' for c in constraints['metric_checks']):
        scope.append('metric_projects')
    if constraints['time_checks']:
        scope.append('time_ranges')
    return {'status': 'verified', 'plan_sha256': digest(plan), 'entity_checks': checks,
            **constraints, 'verification_scope': scope,
            'agent_review_required': ['metric_expression', 'aggregation_grain', 'units', 'business_meaning']}


def scalar(value):
    require(type(value) in (str, int), 'entity_code_invalid', 'Entity codes must be strings or integers')
    return (type(value).__name__, value)


def sql_checks(catalog, sql, params, bindings, evidence):
    checks = []
    for binding in bindings:
        entity = binding['entity']
        table = next(t for t in catalog['tables'] if t['name'] == entity['source_id'])
        selected = {scalar(code) for code in binding['selected_codes']}
        occurrences = []
        for alias, where, single in evidence.scans(table):
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

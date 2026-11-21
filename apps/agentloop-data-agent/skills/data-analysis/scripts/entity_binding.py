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


_PLAN_METADATA_FIELDS = {
    'entity_bindings', 'metric_bindings', 'time_bindings', 'source_signatures',
    'semantic_model_version', 'semantic_bindings', 'semantic_gap_refs',
    'resolved_gap_refs', 'decision_refs',
}


def query_plan_from_artifact(value):
    """Unwrap deterministic Runtime artifacts before strict plan validation.

    ``get-query-context`` and entity resolution deliberately return evidence
    envelopes.  The executable plan is their ``plan_seed``/``query_plan``;
    wrapper-only fields must never become a user-facing business ambiguity.
    """
    if not isinstance(value, dict):
        return None
    if value.get('schema') == 'nl2sql.entity-resolution/v1':
        return query_plan_from_artifact(value.get('query_plan'))
    if isinstance(value.get('plan_seed'), dict):
        merged = deepcopy(value['plan_seed'])
        for key in _PLAN_METADATA_FIELDS:
            if key in value:
                merged[key] = deepcopy(value[key])
        return query_plan_from_artifact(merged)
    if isinstance(value.get('query_plan'), dict):
        merged = deepcopy(value['query_plan'])
        if isinstance(value.get('decision_refs'), list):
            merged['decision_refs'] = deepcopy(value['decision_refs'])
        return query_plan_from_artifact(merged)
    return value


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
        # A full source value may contain an object alias (for example the
        # value ``安宁基地`` contains the alias ``基地``).  Once retrieval has
        # already bound ``entity_id``, the complete value can be checked as an
        # exact source name without inventing a canonical expansion.  Keep the
        # explicit term requirement when the whole mention itself is a term or
        # alias, where omitting its meaning would lose the semantic contract.
        matches = term_matches(catalog, request['mention'])
        exact_term = any(match['matched_text'].strip() == request['mention'].strip()
                         for match in matches)
        require(not exact_term, 'matched_term_required',
                'The mention matches a catalog term; bind the applicable term before querying')
        require(request['canonical_name'] == request['mention'], 'canonical_name_unsupported',
                'Without a matched term, verify the supplied name itself; do not invent an expansion')
    fields = list(dict.fromkeys([entity['key_field'], *entity.get('name_fields', []),
                                 (entity.get('scope_filter') or {}).get('field')]))
    fields = [field for field in fields if field]
    require(bool(entity.get('name_fields')), 'entity_definition_invalid', 'Entity definition needs name fields')
    identifiers = [table.get('schema', ''), table['name'], *fields]
    require(all(isinstance(v, str) and v.isidentifier() and v.isascii() for v in identifiers),
            'entity_definition_invalid', 'Entity lookup requires valid physical identifiers')
    quote = lambda value: '`' + value + '`'
    predicates = ['(' + ' OR '.join(quote(field) + ' = %s' for field in entity['name_fields']) + ')']
    params = [request['canonical_name']] * len(entity['name_fields'])
    scope_filter = entity.get('scope_filter')
    if scope_filter is not None:
        require(isinstance(scope_filter, dict)
                and scope_filter.get('field') in fields
                and scope_filter.get('operator') == 'like_any'
                and isinstance(scope_filter.get('patterns'), list)
                and scope_filter['patterns']
                and all(isinstance(value, str) and value for value in scope_filter['patterns']),
                'entity_definition_invalid', 'Entity scope_filter must be a source-backed LIKE pattern list')
        predicates.append('(' + ' OR '.join(quote(scope_filter['field']) + ' LIKE %s'
                                             for _ in scope_filter['patterns']) + ')')
        params.extend(scope_filter['patterns'])
    sql = ('SELECT DISTINCT ' + ', '.join(map(quote, fields)) + ' FROM '
           + quote(table['schema']) + '.' + quote(table['name']) + ' WHERE '
           + ' AND '.join(predicates))
    return {'mention': request['mention'], 'matched_term': deepcopy(term),
            'canonical_name': request['canonical_name'], 'entity': deepcopy(entity),
            'sql': sql, 'params': params}


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
    binding['semantic_binding'] = semantic_plan_binding(
        catalog, 'entity', spec['entity']['source_id'], spec['entity']['id'],
        definition=spec['entity'])
    binding['lookup'] = deepcopy(lookup)
    binding['selected_codes'] = codes if len(codes) == 1 else []
    status = 'resolved' if len(codes) == 1 else 'ambiguous' if codes else 'unmatched'
    result.update(status=status, candidates=rows, candidate_codes=codes,
                  query_plan={'schema': 'nl2sql.query-plan/v1', 'scenario_id': catalog['scenario_id'],
                              'catalog_revision': catalog['catalog_revision'],
                              'semantic_model_version': catalog.get('semantic_model_version'),
                              'semantic_bindings': [binding['semantic_binding']],
                              'semantic_gap_refs': [g.get('gap_id') for g in binding['semantic_binding'].get('gaps', [])],
                              'entity_bindings': [binding]})
    return result


def semantic_plan_binding(catalog, kind, source_id, identity, definition=None, extra_gaps=None):
    """Build the plan-level semantic envelope from persisted catalog facts."""
    canonical_identity = identity or ''
    if (kind == 'entity' and source_id and isinstance(canonical_identity, str)
            and canonical_identity.startswith(f'entity:{source_id}:')):
        canonical_identity = canonical_identity[len(f'entity:{source_id}:'):]
    object_id = f"{kind}:{source_id + ':' if source_id else ''}{canonical_identity}"
    row = next((item for item in catalog.get('semantic_objects', [])
                if item.get('object_id') == object_id), {})
    # Entity execution IDs are already source-bound. Accept the canonical
    # graph ID without adding the source prefix a second time.
    if not row and kind == 'entity' and source_id and isinstance(identity, str):
        prefix = f'entity:{source_id}:'
        canonical_id = identity if identity.startswith(prefix) else prefix + identity
        row = next((item for item in catalog.get('semantic_objects', [])
                    if item.get('object_id') == canonical_id), {})
    if not row and source_id is None:
        row = next((item for item in catalog.get('semantic_objects', [])
                    if item.get('kind') == kind and item.get('identity') == identity), {})
    evidence = list(row.get('evidence', []) or [])
    definition = definition or {}
    evidence.extend(definition.get('evidence', []) or [])
    evidence.extend(definition.get('evidence_ids', []) or [])
    provenance = definition.get('provenance')
    if isinstance(provenance, dict):
        evidence.extend(provenance.get(k) for k in ('discovery_id', 'evidence_id') if provenance.get(k))
    evidence = list(dict.fromkeys(v for v in evidence if isinstance(v, str) and v))
    gap_refs = list(row.get('gap_refs', []) or [])
    if extra_gaps:
        gap_refs.extend(extra_gaps)
    gaps = []
    extra_gap_ids = {gap.get('gap_id') for gap in (extra_gaps or []) if isinstance(gap, dict)}
    for gap in catalog.get('semantic_gaps', []):
        refs = gap.get('affected_refs', []) or []
        specific_refs = [ref for ref in refs if isinstance(ref, str) and not ref.startswith('source:')]
        source_relevant = (not specific_refs or all(ref.startswith('time:') for ref in specific_refs)
                           or gap.get('gap_id') in extra_gap_ids)
        if (gap.get('gap_id') in gap_refs or object_id in refs
                or (source_id and source_id in (gap.get('source_ids', []) or []) and source_relevant)):
            gaps.append(deepcopy(gap))
    for gap in gap_refs:
        if isinstance(gap, dict):
            gaps.append(deepcopy(gap))
    unique = []
    seen = set()
    for gap in gaps:
        key = gap.get('gap_id') or json.dumps(gap, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique.append(gap)
    scope = deepcopy(row.get('scope')) or {
        'kind': 'source' if source_id else 'domain',
        'scenario_id': catalog.get('scenario_id'),
        **({'source_id': source_id} if source_id else {})}
    scope.setdefault('completeness', row.get('completeness', 'partial'))
    return {'kind': kind, 'source_id': source_id, 'id': identity,
            'definition_ref': {'kind': kind, 'source_id': source_id, 'id': identity,
                               'catalog_revision': catalog.get('catalog_revision')},
            'scope': scope, 'status': row.get('status') or definition.get('definition_status') or 'provisional',
            'evidence': evidence, 'gaps': unique}


def _blocking_gap_applies(gap, plan, evidence, catalog):
    """Scope field-specific blocking gaps to the SQL that can be affected.

    Catalog gaps are intentionally retained on source bindings so they remain
    visible and fail closed when relevant. A period-format gap, however, is
    not evidence that every query over the source needs a period definition.
    Only a query that references the affected period field (or carries a
    matching time binding) can be affected by that gap.
    """
    if not isinstance(gap, dict) or not gap.get('blocking'):
        return False
    if gap.get('gap_id') in set(plan.get('resolved_gap_refs', []) or []):
        return False
    refs = gap.get('affected_refs') or []
    time_refs = []
    specific_refs = []
    for ref in refs:
        if not isinstance(ref, str) or not ref.startswith('time:'):
            if isinstance(ref, str) and ref.startswith('source:'):
                continue
            if not isinstance(ref, str) or ref.count(':') < 2:
                return True
            specific_refs.append(ref)
            continue
        _, source, field = ref.split(':', 2) if ref.count(':') >= 2 else ('', '', '')
        if not source or not field:
            return True
        time_refs.append((source, field))
    # Older catalog rows encoded the affected company only in ``term`` and
    # ``source_ids`` while leaving ``affected_refs`` at source scope. Preserve
    # that specificity instead of treating the gap as a global source lock.
    if not specific_refs and (gap.get('term') or gap.get('trigger_terms')):
        terms = [gap.get('term')] if isinstance(gap.get('term'), str) and gap.get('term') else gap.get('trigger_terms', [])
        specific_refs = [f"term:{source}:{term}"
                         for source in (gap.get('source_ids') or [])
                         for term in terms if isinstance(term, str) and term]
    if time_refs:
        for source, field in time_refs:
            if any(isinstance(binding, dict) and binding.get('source_id') == source
                   and binding.get('field') == field
                   for binding in plan.get('time_bindings', [])):
                return True
            table = next((table for table in catalog.get('tables', [])
                          if table.get('name') == source), None)
            if table and evidence.references(table, field):
                return True
        # A time-only gap is scoped to its field.  An unrelated query over the
        # same source must remain executable.
        if not specific_refs:
            return False

    # Source references are context/provenance.  If a gap also names a term,
    # entity, metric, or field, the specific object is the blocking boundary.
    # This prevents a question-triggered company gap from blocking a market
    # price query after the company predicate has been removed.
    for ref in specific_refs:
        kind, source, identity = ref.split(':', 2)
        if kind == 'time':
            continue
        if kind == 'metric':
            if any(isinstance(binding, dict) and binding.get('source_id') == source
                   and binding.get('metric_id') == identity
                   for binding in plan.get('metric_bindings', [])):
                return True
            if any(isinstance(binding, dict) and binding.get('kind') == 'metric'
                   and binding.get('source_id') == source and binding.get('id') == identity
                   for binding in plan.get('semantic_bindings', [])):
                return True
        elif kind in {'attribute', 'column', 'field'}:
            table = next((table for table in catalog.get('tables', [])
                          if table.get('name') == source), None)
            if table and evidence.references(table, identity):
                return True
        elif kind == 'entity':
            if any(isinstance(binding, dict)
                   and (binding.get('entity') or {}).get('source_id') == source
                   and (binding.get('entity') or {}).get('id') == identity
                   for binding in plan.get('entity_bindings', [])):
                return True
            if any(isinstance(binding, dict) and binding.get('kind') == 'entity'
                   and binding.get('source_id') == source and binding.get('id') == identity
                   for binding in plan.get('semantic_bindings', [])):
                return True
        elif kind == 'term':
            # A term gap describing an entity/price binding applies when the
            # SQL still uses a source-bound entity key.  The actual company
            # name is never guessed or matched with LIKE here.
            table = next((table for table in catalog.get('tables', [])
                          if table.get('name') == source), None)
            if table:
                entity_fields = {entity.get('key_field') for entity in catalog.get('entities', [])
                                 if entity.get('source_id') == source}
                for column in table.get('columns', []):
                    roles = column.get('semantic_roles', []) or []
                    name = column.get('name')
                    if 'entity_key' in roles or name in entity_fields or (
                            isinstance(name, str) and name.lower() in {
                                'company_code', 'company_id', 'org_code', 'org_id',
                                'account', 'account_code', 'account_id'}):
                        if evidence.references(table, name):
                            return True
        elif any(isinstance(binding, dict) and binding.get('id') == identity
                 for binding in plan.get('semantic_bindings', [])):
            return True

    # A gap with only source references is genuinely source-wide.  A gap with
    # specific references is inactive until one of those references is used.
    return not specific_refs and bool(refs)


def validate_plan(catalog, sql, params, plan):
    """Verify source-bound evidence and exact SQL selectors; never rewrite SQL."""
    allowed_plan_fields = {'schema', 'scenario_id', 'catalog_revision', 'entity_bindings',
                           'metric_bindings', 'time_bindings', 'source_signatures',
                           'semantic_model_version', 'semantic_bindings', 'semantic_gap_refs',
                           'resolved_gap_refs', 'decision_refs'}
    require(isinstance(plan, dict), 'query_plan_invalid',
            'query_plan must be a JSON object, not a string or wrapper')
    missing = sorted({'schema', 'scenario_id', 'catalog_revision'} - set(plan))
    require(not missing, 'query_plan_invalid',
            'query_plan is missing required fields: ' + ', '.join(missing))
    unknown = sorted(set(plan) - allowed_plan_fields)
    require(not unknown, 'query_plan_invalid',
            'query_plan contains unsupported fields: ' + ', '.join(unknown)
            + '; keep decision evidence in decision_refs and copy plan_seed fields unchanged')
    require(plan['schema'] == 'nl2sql.query-plan/v1', 'query_plan_invalid',
            'query_plan.schema must be nl2sql.query-plan/v1')
    decision_refs = plan.get('decision_refs', [])
    require(isinstance(decision_refs, list), 'query_plan_invalid',
            'query_plan.decision_refs must be an array when present')
    for decision in decision_refs:
        require(isinstance(decision, dict)
                and set(decision) <= {'request_id', 'selected_option_id'}
                and isinstance(decision.get('request_id'), str)
                and isinstance(decision.get('selected_option_id'), str),
                'query_plan_invalid',
                'decision_refs entries must contain request_id and selected_option_id')
    resolved_gap_refs = plan.get('resolved_gap_refs', [])
    require(isinstance(resolved_gap_refs, list)
            and all(isinstance(gap_id, str) and gap_id.strip() for gap_id in resolved_gap_refs),
            'query_plan_invalid', 'query_plan.resolved_gap_refs must be an array of nonempty gap IDs')
    require(len(set(resolved_gap_refs)) == len(resolved_gap_refs),
            'query_plan_invalid', 'query_plan.resolved_gap_refs must contain distinct gap IDs')
    require(not resolved_gap_refs or decision_refs,
            'semantic_gap_resolution_required',
            'Resolved semantic gaps require at least one persisted HIL decision reference')
    require(plan['scenario_id'] == catalog['scenario_id'] and plan['catalog_revision'] == catalog['catalog_revision'],
            'query_plan_stale', 'Scenario or catalog revision changed; rebind affected definitions')
    # Parse once before semantic-gap checks so field-scoped gaps can be
    # evaluated against the actual SQL. This keeps a source-level period gap
    # blocking for period queries while allowing unrelated dimension probes.
    from sql_evidence import SqlEvidence
    evidence = SqlEvidence(sql, params)
    known_gap_ids = {gap.get('gap_id') for gap in catalog.get('semantic_gaps', [])
                     if isinstance(gap, dict) and isinstance(gap.get('gap_id'), str)}
    require(set(resolved_gap_refs) <= known_gap_ids,
            'semantic_gap_resolution_invalid',
            'Resolved semantic gap is absent from the current catalog revision')
    semantic_version = catalog.get('semantic_model_version')
    if semantic_version:
        require(plan.get('semantic_model_version') == semantic_version,
                'semantic_binding_required', 'Query plan must carry the current semantic model version')
        semantic_bindings = plan.get('semantic_bindings')
        require(isinstance(semantic_bindings, list) and semantic_bindings,
                'semantic_binding_required', 'Query plan must carry source and metric semantic bindings')
        for binding in semantic_bindings:
            require(isinstance(binding, dict), 'semantic_binding_invalid',
                    'Each semantic binding must be an object')
            missing_binding = sorted({'kind', 'source_id', 'id', 'definition_ref',
                                      'scope', 'status', 'evidence', 'gaps'} - set(binding))
            require(not missing_binding, 'semantic_binding_invalid',
                    'Semantic binding is missing fields: ' + ', '.join(missing_binding)
                    + '; copy the binding from plan_seed unchanged')
            ref = binding['definition_ref']
            require(isinstance(ref, dict)
                    and (ref.get('kind'), ref.get('source_id'), ref.get('id')) ==
                    (binding.get('kind'), binding.get('source_id'), binding.get('id'))
                    and ref.get('catalog_revision') == catalog['catalog_revision'],
                    'semantic_binding_stale', 'Semantic definition reference is from another catalog revision')
            require(isinstance(binding.get('scope'), dict)
                    and isinstance(binding.get('evidence'), list)
                    and isinstance(binding.get('gaps'), list),
                    'semantic_binding_invalid', 'Semantic binding scope, evidence and gaps must be structured')
            require(binding['status'] not in {'unresolved', 'invalid'},
                    'semantic_binding_unresolved', 'Unresolved or invalid semantic definitions cannot authorize SQL')
            gaps = binding.get('gaps') or []
            require(not any(_blocking_gap_applies(g, plan, evidence, catalog) for g in gaps),
                    'semantic_gap_blocking', 'Resolve blocking semantic gaps before SQL execution')
        required = {('source', source, source) for source in plan.get('source_signatures', {})}
        required.update(('metric', ref['source_id'], ref['metric_id'])
                        for ref in plan.get('metric_bindings', []))
        required.update(('time', ref['source_id'], ref['field'])
                        for ref in plan.get('time_bindings', [])
                        if isinstance(ref, dict) and ref.get('source_id') and ref.get('field'))
        available = {(b.get('kind'), b.get('source_id'), b.get('id')) for b in semantic_bindings}
        require(required <= available, 'semantic_binding_required',
                'Every selected source and metric must have a semantic binding')
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
            and (any(plan.get(key) for key in keys)
                 or bool(plan.get('source_signatures'))
                 or bool(plan.get('semantic_bindings'))),
            'query_plan_invalid', 'Query plan must contain source signatures, entity, metric or time bindings')
    bindings = []
    for binding in plan.get('entity_bindings', []):
        require(isinstance(binding, dict) and set(binding) <= {
            'mention', 'matched_term', 'canonical_name', 'entity', 'lookup', 'selected_codes', 'selection_evidence',
            'semantic_binding'},
            'entity_binding_invalid', 'Invalid entity binding fields')
        entity = binding.get('entity', {})
        term = binding.get('matched_term')
        require(isinstance(entity, dict) and (term is None or isinstance(term, dict)),
                'entity_binding_invalid', 'Entity and matched term must retain catalog definitions')

        # Entity evidence is optional. When a model includes an evidence row
        # for a physical code supplied by the user (or selected by a bounded
        # probe), it must not be forced through canonical-name lookup. The
        # source-bound entity definition and the actual SQL selector still get
        # verified below, so this is a lower-risk evidence path rather than a
        # bypass of entity filtering.
        current_entities = [candidate for candidate in catalog.get('entities', [])
                            if candidate.get('id') == entity.get('id')
                            and candidate.get('source_id') == entity.get('source_id')
                            and candidate.get('definition_status') == 'current']
        require(len(current_entities) == 1 and entity == current_entities[0],
                'entity_binding_stale', 'Entity definition must match one current source-bound catalog entity')
        selected_codes = binding.get('selected_codes')
        selection_evidence = binding.get('selection_evidence')
        direct_evidence = ('lookup' not in binding
                           and ((isinstance(selection_evidence, str) and bool(selection_evidence.strip()))
                                or (isinstance(selection_evidence, (dict, list)) and bool(selection_evidence))))
        if direct_evidence:
            require(isinstance(selected_codes, list) and bool(selected_codes),
                    'entity_selection_required', 'Direct entity-code evidence must include selected_codes')
            normalized_codes = [scalar(code) for code in selected_codes]
            require(len(set(normalized_codes)) == len(normalized_codes),
                    'entity_selection_invalid', 'Selected entity codes must be distinct')
            if term is not None:
                definitions = [candidate for candidate in catalog.get('terms', [])
                               if candidate == term]
                require(len(definitions) == 1, 'entity_binding_stale',
                        'Matched term definition must match the current catalog')
            semantic = binding.get('semantic_binding')
            if semantic is not None:
                require(isinstance(semantic, dict)
                        and (semantic.get('kind'), semantic.get('source_id'), semantic.get('id')) ==
                        ('entity', entity.get('source_id'), entity.get('id')),
                        'semantic_binding_invalid',
                        'Entity semantic binding does not match the entity definition')
                require(isinstance(semantic.get('definition_ref'), dict)
                        and semantic['definition_ref'].get('catalog_revision') == catalog['catalog_revision'],
                        'semantic_binding_stale', 'Entity semantic definition is from another catalog revision')
                require(semantic.get('status') not in {'unresolved', 'invalid'},
                        'semantic_binding_unresolved', 'Entity semantic definition is not executable')
                require(not any(_blocking_gap_applies(g, plan, evidence, catalog)
                                for g in semantic.get('gaps', [])),
                        'semantic_gap_blocking', 'Resolve blocking entity semantic gaps before SQL execution')
            bindings.append(binding)
            continue

        spec = lookup_spec(catalog, {'mention': binding.get('mention'),
            'matched_term': term.get('term') if isinstance(term, dict) else None,
            'canonical_name': binding.get('canonical_name'), 'source_id': entity.get('source_id'),
            'entity_id': entity.get('id')})
        require(entity == spec['entity'] and term == spec['matched_term'], 'entity_binding_stale',
                'Entity and term definitions must match the current catalog')
        if semantic_version:
            semantic = binding.get('semantic_binding')
            require(isinstance(semantic, dict), 'semantic_binding_required',
                    'Entity bindings must retain their semantic binding')
            require((semantic.get('kind'), semantic.get('source_id'), semantic.get('id')) ==
                    ('entity', entity.get('source_id'), entity.get('id')),
                    'semantic_binding_invalid', 'Entity semantic binding does not match the entity definition')
            require(isinstance(semantic.get('definition_ref'), dict)
                    and semantic['definition_ref'].get('catalog_revision') == catalog['catalog_revision'],
                    'semantic_binding_stale', 'Entity semantic definition is from another catalog revision')
            require(semantic.get('status') not in {'unresolved', 'invalid'},
                    'semantic_binding_unresolved', 'Entity semantic definition is not executable')
            require(not any(_blocking_gap_applies(g, plan, evidence, catalog)
                            for g in semantic.get('gaps', [])),
                    'semantic_gap_blocking', 'Resolve blocking entity semantic gaps before SQL execution')
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
        codes = selected_codes
        require(isinstance(codes, list) and bool(codes), 'entity_selection_required', 'Select entity codes before data retrieval')
        selected = {scalar(code) for code in codes}
        require(len(selected) == len(codes) and selected <= candidates, 'entity_selection_invalid',
                'Selected codes must be distinct codes from the canonical-name lookup')
        if len(candidates) > 1:
            require(isinstance(binding.get('selection_evidence'), str) and bool(binding['selection_evidence'].strip()),
                    'entity_selection_required', 'Ambiguous candidates require a user decision or other explicit selection evidence')
        bindings.append(binding)
    from query_constraints import constraint_checks
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
            scope_filter = entity.get('scope_filter')
            if scope_filter:
                expected_patterns = set(scope_filter.get('patterns', []))
                actual_patterns = evidence.pattern_selector(where, alias, scope_filter['field'], single)
                require(actual_patterns == expected_patterns, 'entity_scope_sql_mismatch',
                        'SQL must preserve the exact source-backed scope filter for ' + entity['id'])
            occurrences.append(alias)
        require(bool(occurrences), 'entity_sql_mismatch', 'Bound entity source is absent from SQL')
        checks.append({'mention': binding.get('mention'), 'term': (binding.get('matched_term') or {}).get('term'),
                       'canonical_name': binding.get('canonical_name'), 'source_id': entity['source_id'],
                       'key_field': entity['key_field'], 'selected_codes': binding['selected_codes'],
                       'sql_codes': binding['selected_codes'],
                       'lookup_query_id': binding.get('lookup', {}).get('query_id'), 'table_aliases': occurrences,
                       'status': 'verified'})
    return checks

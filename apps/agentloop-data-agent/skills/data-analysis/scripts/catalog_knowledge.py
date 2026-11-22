"""Project scenario knowledge and rank sources without changing query authority."""
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
import re
from table_semantics import schema_signature
from knowledge_definitions import term_sources


CATALOG_LIST_FIELDS = (
    'tables', 'metrics', 'terms', 'categories', 'relationships', 'skills', 'dimensions',
    'time_policies', 'table_summaries', 'entities', 'period_formats',
    'semantic_objects', 'source_bindings', 'coverage', 'semantic_gaps',
    'observed_probes',
)
SEMANTIC_MODEL_VERSION = 'nl2sql.semantic-model/v1'
SEMANTIC_STATUSES = {'confirmed', 'provisional', 'unresolved', 'stale', 'invalid'}
SEMANTIC_COMPLETENESS = {'complete', 'partial', 'observed_only', 'unknown'}
# Runtime-neutral semantic classes. Domain vocabulary stays in catalog data.
SEMANTIC_LAYERS = ('source', 'object', 'attribute', 'measure', 'time', 'term', 'relation')
SEMANTIC_KIND_LAYERS = {
    'source': 'source', 'entity': 'object', 'object': 'object',
    'attribute': 'attribute', 'column': 'attribute',
    'metric': 'measure', 'measure': 'measure',
    'time': 'time', 'period': 'time', 'term': 'term',
    'relationship': 'relation', 'relation': 'relation',
}
SEMANTIC_LAYER_ORDER = {layer: index for index, layer in enumerate(SEMANTIC_LAYERS)}
SUMMARY_INDEX_FIELDS = (
    'source_id', 'table_signature', 'purpose', 'business_domain', 'business_terms',
    'record_semantics', 'row_grain', 'grain_status', 'query_scenarios',
    'limitations', 'provenance', 'not_suitable_for', 'time_semantics', 'entity_semantics',
    'table_kind', 'candidate_unique_key', 'unique_key_status', 'update_mode',
    'update_frequency', 'status', 'evidence_ids', 'schema_signature',
)


def catalog_config(config):
    """Share one explicit business-only boundary between storage and responses."""
    public = {key: deepcopy(config.get(key, [])) for key in CATALOG_LIST_FIELDS}
    if 'timezone' in config:
        public['timezone'] = deepcopy(config['timezone'])
    if 'semantic_model_version' in config:
        public['semantic_model_version'] = config['semantic_model_version']
    return public


def _object_id(kind, source_id, identity):
    return f"{kind}:{source_id + ':' if source_id else ''}{identity}"


def semantic_identity(kind, source_id, identity):
    """Normalize an already source-bound entity ID for graph lookup."""
    if (kind == 'entity' and source_id and isinstance(identity, str)
            and identity.startswith(f'entity:{source_id}:')):
        return identity[len(f'entity:{source_id}:'):]
    return identity


def semantic_object_id(kind, source_id, identity):
    return _object_id(kind, source_id, semantic_identity(kind, source_id, identity or ''))


def semantic_graph_diagnostics(objects):
    """Validate the generic parented hierarchy without domain assumptions."""
    rows = [item for item in objects if isinstance(item, dict)]
    by_id = {item.get('object_id'): item for item in rows if item.get('object_id')}
    diagnostics = []
    for item in rows:
        object_id, layer = item.get('object_id'), item.get('layer')
        expected = SEMANTIC_KIND_LAYERS.get(item.get('kind'))
        if expected is None:
            diagnostics.append({'kind': 'semantic_object', 'object_id': object_id,
                                'status': 'invalid', 'missing_fields': ['kind:generic']})
        if layer not in SEMANTIC_LAYERS:
            diagnostics.append({'kind': 'semantic_object', 'object_id': object_id,
                                'status': 'invalid', 'missing_fields': ['layer']})
        elif expected and layer != expected:
            diagnostics.append({'kind': 'semantic_object', 'object_id': object_id,
                                'status': 'invalid', 'missing_fields': [f'layer:{expected}']})
        parent = item.get('parent_ref')
        if not parent:
            continue
        parent_row = by_id.get(parent)
        if not parent_row:
            diagnostics.append({'kind': 'semantic_object', 'object_id': object_id,
                                'status': 'invalid', 'missing_fields': [f'parent_ref:{parent}']})
            continue
        if (layer in SEMANTIC_LAYER_ORDER and parent_row.get('layer') in SEMANTIC_LAYER_ORDER
                and SEMANTIC_LAYER_ORDER[parent_row['layer']] >= SEMANTIC_LAYER_ORDER[layer]):
            diagnostics.append({'kind': 'semantic_object', 'object_id': object_id,
                                'status': 'invalid', 'missing_fields': ['parent_layer_order']})
        if item.get('source_id') and parent_row.get('source_id') not in {None, item.get('source_id')}:
            diagnostics.append({'kind': 'semantic_object', 'object_id': object_id,
                                'status': 'invalid', 'missing_fields': ['parent_source_scope']})
    for start in by_id:
        seen, current = set(), start
        while current:
            if current in seen:
                diagnostics.append({'kind': 'semantic_object', 'object_id': start,
                                    'status': 'invalid', 'missing_fields': ['parent_cycle']})
                break
            seen.add(current)
            current = by_id.get(current, {}).get('parent_ref')
    return diagnostics


def _definition_evidence(definition):
    evidence = list(definition.get('evidence', []) or [])
    evidence.extend(definition.get('evidence_ids', []) or [])
    provenance = definition.get('provenance')
    if isinstance(provenance, dict):
        for key in ('discovery_id', 'evidence_id'):
            if provenance.get(key):
                evidence.append(provenance[key])
    return list(dict.fromkeys(value for value in evidence if isinstance(value, str) and value))


def semantic_metadata(catalog, kind, source_id=None, identity=None, definition=None,
                      extra_gaps=None, status=None, scope=None):
    """Return one stable semantic envelope without inventing business meaning."""
    object_id = semantic_object_id(kind, source_id, identity or '')
    object_row = next((item for item in catalog.get('semantic_objects', [])
                       if item.get('object_id') == object_id), None)
    if object_row is None and kind == 'column':
        object_row = next((item for item in catalog.get('semantic_objects', [])
                           if item.get('kind') in {'attribute', 'column'}
                           and item.get('source_id') == source_id and item.get('identity') == identity), None)
    if object_row is None:
        canonical_id = semantic_object_id(kind, source_id, identity)
        object_row = next((item for item in catalog.get('semantic_objects', [])
                           if item.get('object_id') == canonical_id), None)
    # Terms are often domain-wide definitions without a persisted source_id;
    # use the unique kind/id row while retaining source bindings separately.
    if object_row is None and source_id is None:
        object_row = next((item for item in catalog.get('semantic_objects', [])
                           if item.get('kind') == kind and item.get('identity') == identity), None)
    definition = definition or {}
    evidence = list((object_row or {}).get('evidence', []) or [])
    evidence.extend(_definition_evidence(definition))
    evidence = list(dict.fromkeys(value for value in evidence if isinstance(value, str) and value))
    object_gaps = list((object_row or {}).get('gap_refs', []) or [])
    if extra_gaps:
        object_gaps.extend(extra_gaps)
    gaps = []
    extra_gap_ids = {gap.get('gap_id') for gap in (extra_gaps or []) if isinstance(gap, dict)}
    for gap in catalog.get('semantic_gaps', []):
        refs = set(gap.get('affected_refs', []) or [])
        triggers = set(gap.get('source_ids', []) or [])
        specific_refs = [ref for ref in refs if isinstance(ref, str) and not ref.startswith('source:')]
        source_scoped = source_id and source_id in triggers
        source_gap_is_relevant = (not specific_refs or all(ref.startswith('time:') for ref in specific_refs)
                                  or gap.get('gap_id') in extra_gap_ids)
        object_ref_relevant = object_id in refs and source_gap_is_relevant
        if (gap.get('gap_id') in object_gaps or object_ref_relevant or
                (source_scoped and source_gap_is_relevant)):
            gaps.append(deepcopy(gap))
    for gap in object_gaps:
        if isinstance(gap, dict):
            gaps.append(deepcopy(gap))
    unique_gaps = []
    seen = set()
    for gap in gaps:
        key = gap.get('gap_id') or json.dumps(gap, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique_gaps.append(gap)
    if status is None:
        status = (object_row or {}).get('status')
    if status is None:
        status = definition.get('status')
    if status is None:
        status = definition.get('definition_status')
    if status is None:
        status = 'confirmed' if evidence else 'provisional'
    if scope is None:
        scope = deepcopy((object_row or {}).get('scope'))
    if scope is None:
        scope = {'kind': 'source' if source_id else 'domain',
                 'scenario_id': catalog.get('scenario_id'),
                 **({'source_id': source_id} if source_id else {})}
    if isinstance(scope, dict) and 'completeness' not in scope:
        scope['completeness'] = (object_row or {}).get('completeness', 'partial')
    return {'kind': kind, 'source_id': source_id, 'id': identity,
            'layer': (object_row or {}).get('layer') or definition.get('layer') or kind,
            'semantic_role': (object_row or {}).get('semantic_role') or definition.get('semantic_role'),
            'parent_ref': (object_row or {}).get('parent_ref') or definition.get('parent_ref'),
            'definition_ref': {'kind': kind, 'source_id': source_id, 'id': identity,
                               'catalog_revision': catalog.get('catalog_revision')},
            'scope': scope, 'status': status, 'evidence': evidence, 'gaps': unique_gaps}


def table_signature(table):
    # Execution signature, also read for legacy table_summaries. New summaries
    # track structure separately; execution still detects semantic changes.
    shape = {'schema': table.get('schema'), 'name': table['name'],
             'description': table.get('description'),
             'columns': [{**{key: column.get(key) for key in
                          ('name', 'type', 'data_type', 'character_maximum_length',
                           'numeric_precision', 'numeric_scale', 'datetime_precision',
                           'is_nullable', 'ordinal_position', 'label', 'description',
                           'value_domain', 'format', 'granularity', 'format_status',
                           'format_observed_shapes')},
                          **{key: column[key] for key in ('logical_type', 'unit', 'unit_field',
                             'declared_domain', 'scope_filter', 'status', 'evidence_ids') if key in column}}
                         for column in table.get('columns', [])]}
    return hashlib.sha256(json.dumps(shape, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _summary_fields(summary):
    fields = set()
    for key in ('row_grain', 'candidate_unique_key', 'metric_fields', 'dimension_fields', 'time_fields', 'entity_fields'):
        fields.update(summary.get(key, []))
    for clue in summary.get('metric_clues', []):
        for key in ('measure_fields', 'selector_fields', 'unit_fields'):
            fields.update(clue.get(key, []))
        fields.update(value['field'] for value in clue.get('observed_values', []))
    return fields


def prepare_knowledge(config, *, schema_verified=True):
    """Use current physical tables to qualify stored knowledge, never invent it."""
    public = catalog_config(config)
    tables = {table['name']: table for table in public['tables']}
    diagnostics = []
    summaries = {}
    duplicates = set()
    for summary in public['table_summaries']:
        source = summary['source_id']
        if source in summaries:
            duplicates.add(source)
        summaries[source] = summary
    current = []
    for source, table in tables.items():
        signature = table_signature(table)
        table['table_signature'] = signature
        table['schema_signature'] = schema_signature(table)
        summary = summaries.get(source)
        status = 'not_prepared'
        if summary:
            columns = {column['name'] for column in table['columns']}
            missing = sorted(_summary_fields(summary) - columns)
            matches = (summary['schema_signature'] == table['schema_signature'] if summary.get('schema_signature')
                       else summary.get('table_signature') == signature)
            status = ('invalid' if source in duplicates or missing else
                      'unverified' if not schema_verified else
                      'current' if matches else 'stale')
            if status in {'current', 'unverified'}:
                current.append(summary)
            else:
                diagnostics.append({'kind': 'table_summary', 'source_id': source,
                                    'status': status, 'missing_fields': missing})
        table['understanding_status'] = status
    public['table_summaries'] = current
    # Keep these definitions and their provenance intact. Invalid field bindings
    # remain visible with a diagnostic, so they cannot silently appear usable.
    for key in ('entities', 'period_formats'):
        scoped = []
        for definition in public[key]:
            source = definition['source_id']
            if source not in tables:
                continue
            fields = ([definition['key_field'], *definition.get('name_fields', [])]
                      if key == 'entities' else [definition['field']])
            missing = sorted(set(fields) - {c['name'] for c in tables[source]['columns']})
            selector = definition.get('scope_filter') if key == 'entities' else None
            selector_invalid = (selector is not None and (
                not isinstance(selector, dict)
                or selector.get('field') not in {c['name'] for c in tables[source]['columns']}
                or selector.get('operator') != 'like_any'
                or not isinstance(selector.get('patterns'), list)
                or not selector['patterns']
                or any(not isinstance(value, str) or not value for value in selector['patterns'])))
            if missing or selector_invalid:
                definition['definition_status'] = 'invalid'
            elif definition.get('status') == 'observed_only':
                # Probe observations are source/field evidence, never an
                # executable global format definition.
                definition['definition_status'] = 'observed_only'
            elif key == 'period_formats' and (not definition.get('format') or not definition.get('granularity')):
                definition['definition_status'] = 'unresolved'
            else:
                definition['definition_status'] = 'current'
            if key == 'period_formats' and definition.get('selector') is not None:
                selector = definition['selector']
                selector_invalid = (not isinstance(selector, dict)
                                    or selector.get('field') not in {c['name'] for c in tables[source]['columns']}
                                    or selector.get('operator') not in {'eq', 'in', 'like_any'}
                                    or not selector.get('values', selector.get('patterns')))
                if selector_invalid:
                    definition['definition_status'] = 'invalid'
                    diagnostics.append({'kind': key, 'source_id': source,
                                        'status': 'invalid', 'missing_fields': ['selector']})
            if missing:
                diagnostics.append({'kind': key, 'source_id': source,
                                    'status': 'invalid', 'missing_fields': missing})
            if selector_invalid:
                diagnostics.append({'kind': key, 'source_id': source,
                                    'status': 'invalid', 'missing_fields': ['scope_filter']})
            scoped.append(definition)
        public[key] = scoped
    # Semantic objects and source bindings are persisted facts, not inferred
    # from a field name. Keep invalid rows visible with diagnostics so the
    # planner can fail closed instead of silently dropping their meaning.
    source_ids = set(tables)
    object_id_aliases = {}
    for item in public.get('semantic_objects', []):
        item.setdefault('layer', SEMANTIC_KIND_LAYERS.get(item.get('kind'), item.get('kind')))
        kind, source, identity = item.get('kind', 'unknown'), item.get('source_id'), item.get('identity', '')
        canonical_id = semantic_object_id(kind, source, identity)
        old_id = item.get('object_id')
        # Entity IDs are execution bindings and must be canonical. Other
        # generic objects retain their persisted IDs for compatibility.
        if kind == 'entity':
            if old_id and old_id != canonical_id:
                object_id_aliases[old_id] = canonical_id
            item['object_id'] = canonical_id
            if source and isinstance(identity, str) and identity.startswith(f'entity:{source}:'):
                item['identity'] = semantic_identity(kind, source, identity)
        else:
            item.setdefault('object_id', canonical_id)
        status = item.get('status', 'provisional')
        completeness = item.get('completeness', 'unknown')
        item['definition_status'] = 'current' if status in SEMANTIC_STATUSES and completeness in SEMANTIC_COMPLETENESS else 'invalid'
        item.setdefault('evidence', [])
        item.setdefault('gap_refs', [])
        item.setdefault('scope', {'kind': 'source' if item.get('source_id') else 'domain',
                                  **({'source_id': item['source_id']} if item.get('source_id') else {})})
        if item.get('source_id') and item['source_id'] not in source_ids:
            item['definition_status'] = 'invalid'
            diagnostics.append({'kind': 'semantic_object', 'object_id': item['object_id'],
                                'status': 'invalid', 'missing_fields': ['source_id']})
    if object_id_aliases:
        for binding in public.get('source_bindings', []):
            if binding.get('semantic_ref') in object_id_aliases:
                binding['semantic_ref'] = object_id_aliases[binding['semantic_ref']]
                if binding.get('binding_id'):
                    binding['binding_id'] = binding['binding_id'].replace(
                        next((old for old, new in object_id_aliases.items()
                              if old in binding['binding_id']), ''), binding['semantic_ref'])
    graph_diagnostics = semantic_graph_diagnostics(public.get('semantic_objects', []))
    if graph_diagnostics:
        diagnostics.extend(graph_diagnostics)
        invalid_ids = {item.get('object_id') for item in graph_diagnostics}
        for item in public.get('semantic_objects', []):
            if item.get('object_id') in invalid_ids:
                item['definition_status'] = 'invalid'
    for binding in public.get('source_bindings', []):
        source = binding.get('source_id')
        binding['definition_status'] = 'current' if source in source_ids else 'invalid'
        if source not in source_ids:
            diagnostics.append({'kind': 'source_binding', 'binding_id': binding.get('binding_id'),
                                'status': 'invalid', 'missing_fields': ['source_id']})
    for coverage in public.get('coverage', []):
        coverage['definition_status'] = 'current' if coverage.get('source_id') in source_ids else 'invalid'
        if coverage.get('source_id') not in source_ids:
            diagnostics.append({'kind': 'coverage', 'source_id': coverage.get('source_id'),
                                'status': 'invalid', 'missing_fields': ['source_id']})
    if diagnostics:
        public['knowledge_diagnostics'] = diagnostics
    return public


def _tokens(text):
    tokens = []
    for part in re.findall(r'[a-zA-Z_0-9]+|[\u4e00-\u9fff]+', text.lower()):
        if re.fullmatch(r'[\u4e00-\u9fff]+', part):
            tokens.extend(part[i:i + 2] for i in range(len(part) - 1))
            tokens.append(part)
        else:
            tokens.append(part)
            tokens.extend(word for word in part.split('_') if word != part)
    return tokens


def rank_sources(catalog, question):
    """Return every authorized source, with clues; a score is not a selection."""
    summaries = {summary['source_id']: summary for summary in catalog['table_summaries']}
    documents = []
    for table in catalog['tables']:
        source = table['name']
        metrics = [m for m in catalog['metrics'] if m.get('table') == source]
        summary = summaries.get(source, {})
        clues = [table.get('label', ''), *summary.get('business_terms', []),
                 *summary.get('retrieval_hints', []),
                 *(clue['concept'] for clue in summary.get('metric_clues', [])),
                 *(m.get('label', m.get('name', '')) for m in metrics)]
        # Associate terms only through an explicit source/metric reference;
        # global vocabulary must not give every table the same relevance score.
        anchors = {source, *(m.get('name', '') for m in metrics),
                   *(m.get('label', '') for m in metrics)} - {''}
        terms = [term for term in catalog['terms']
                 if source in term_sources(term) or any(anchor in term.get('meaning', '') or anchor == term.get('term')
                        for anchor in anchors)]
        clues.extend(alias for term in terms for alias in [term['term'], *term.get('aliases', [])])
        content = {'source': {k: table.get(k) for k in ('name', 'label', 'description', 'columns')},
                   'metrics': metrics, 'terms': terms,
                   'understanding': {k: summary.get(k) for k in
                                     ('purpose', 'business_domain', 'business_objects', 'business_terms',
                                      'record_semantics', 'metric_clues', 'query_scenarios', 'retrieval_hints')},
                   'clues': clues}
        documents.append((table, Counter(_tokens(json.dumps(content, ensure_ascii=False))), clues))
    tokens = set(_tokens(question))
    frequencies = {token: sum(token in counts for _, counts, _ in documents) for token in tokens}
    results = []
    for table, counts, clues in documents:
        score = sum((1 + math.log(counts[token])) * math.log(1 + len(documents) / (1 + frequencies[token]))
                    for token in tokens if counts[token])
        matched = list(dict.fromkeys(clue for clue in clues if tokens.intersection(_tokens(clue))))
        results.append({'source_id': table['name'], 'score': round(score, 3), 'matched_clues': matched,
                        'understanding_status': table['understanding_status']})
    return sorted(results, key=lambda result: -result['score'])


def project_sources(catalog, requested, question=None):
    """Index first, then full selected definitions; all share a scenario revision."""
    from entity_binding import term_matches
    matches = term_matches(catalog, question) if question is not None else []
    # Small global identities remain discoverable; full definitions are fetched
    # by question or selected source, never duplicated across every projection.
    if not requested:
        catalog['metric_index'] = [{k: m[k] for k in ('name', 'label', 'table') if k in m}
                                   for m in catalog['metrics']]
        catalog['term_index'] = [{k: t[k] for k in ('term', 'aliases') if k in t}
                                 for t in catalog['terms']]
    catalog['definition_scope'] = {'metrics': 'selected_sources' if requested else 'question_matches',
                                   'terms': 'question_matches_and_source_references' if requested else 'question_matches',
                                   'expand': 'catalog --source-id <name> --question <term or question>'}
    if question is not None:
        catalog['retrieval'] = rank_sources(catalog, question)
    matching_terms = {m['definition']['term'] for m in matches}
    if requested:
        metrics = [m for m in catalog['metrics'] if m.get('table') in requested]
        anchors = {*requested, *(m.get('name', '') for m in metrics),
                   *(m.get('label', '') for m in metrics),
                   *((m.get('project') or {}).get('value', '') for m in metrics)} - {''}
        catalog['terms'] = [t for t in catalog['terms'] if t['term'] in matching_terms
                            or term_sources(t) & requested
                            or any(isinstance(a, str) and (a in t.get('meaning', '') or a == t['term'])
                                   for a in anchors)]
    else:
        catalog['terms'] = [t for t in catalog['terms'] if t['term'] in matching_terms]
        meanings = [t.get('meaning', '') for t in catalog['terms']]
        catalog['metrics'] = [m for m in catalog['metrics'] if question and (
            any(v and v in question for v in (m.get('name'), m.get('label'), *m.get('aliases', [])))
            or any(isinstance(v, str) and v and v in text for text in meanings
                   for v in (m.get('name'), m.get('label'), (m.get('project') or {}).get('value'))))]
    if question is not None:
        # One canonical definition, with explicit references from lexical hits.
        catalog['matched_terms'] = [{k: m[k] for k in ('matched_text', 'match_scope')} | {
            'term': m['definition']['term'],
            'definition_pointer': '/terms/' + str(catalog['terms'].index(m['definition']))}
            for m in matches]
    if not requested:
        catalog['projection'] = 'source_index'
        catalog['tables'] = [{key: table[key] for key in
                              ('name', 'schema', 'label', 'description', 'relation_type',
                               'table_signature', 'understanding_status') if key in table}
                             for table in catalog['tables']]
        catalog['table_summaries'] = [{key: summary[key] for key in SUMMARY_INDEX_FIELDS if key in summary}
                                     for summary in catalog['table_summaries']]
        catalog['skills'] = [{k: v for k, v in skill.items() if k in ('id', 'name', 'description', 'tags')}
                            for skill in catalog['skills']]
        # These field-level contracts are only needed after source selection.
        catalog['entities'] = [{k: e[k] for k in ('id', 'source_id', 'definition_status') if k in e}
                               for e in catalog['entities']]
        catalog['period_formats'] = [{k: p[k] for k in ('source_id', 'field', 'definition_status') if k in p}
                                     for p in catalog['period_formats']]
        return catalog
    catalog['projection'] = 'source_details'
    related = set()
    for relation in catalog['relationships']:
        ends = {relation.get(side, {}).get('source_id') for side in ('left', 'right')}
        if ends & requested:
            related.update(ends - requested)
    catalog['related_sources'] = [{key: table[key] for key in ('name', 'schema', 'label') if key in table}
                                  for table in catalog['tables'] if table['name'] in related]
    catalog['tables'] = [table for table in catalog['tables'] if table['name'] in requested]
    catalog['metrics'] = [m for m in catalog['metrics'] if m.get('table') in requested]
    for key in ('table_summaries', 'entities', 'period_formats', 'coverage', 'observed_probes'):
        catalog[key] = [definition for definition in catalog[key] if definition['source_id'] in requested]
    catalog['source_bindings'] = [binding for binding in catalog.get('source_bindings', [])
                                  if binding.get('source_id') in requested]
    catalog['semantic_objects'] = [item for item in catalog.get('semantic_objects', [])
                                   if not item.get('source_id') or item.get('source_id') in requested]
    catalog['semantic_gaps'] = [gap for gap in catalog.get('semantic_gaps', [])
                                if not gap.get('source_ids') or set(gap.get('source_ids', [])) & requested]
    catalog['relationships'] = [r for r in catalog['relationships']
                                 if any(r.get(side, {}).get('source_id') in requested for side in ('left', 'right'))]
    if 'knowledge_diagnostics' in catalog:
        catalog['knowledge_diagnostics'] = [d for d in catalog['knowledge_diagnostics'] if not d.get('source_id') or d['source_id'] in requested]
    return catalog

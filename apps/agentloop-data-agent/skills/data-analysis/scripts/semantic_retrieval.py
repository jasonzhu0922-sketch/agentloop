"""Versioned, source-backed semantic lookup. No model, memory or data SQL."""
from copy import deepcopy
import json
import math
import re

from catalog_knowledge import _tokens, rank_sources, table_signature, semantic_metadata
from entity_binding import term_matches


SEARCH_ACTIONS = {'retrieve-knowledge', 'search-tables', 'search-metrics', 'search-columns'}
DETAIL_ACTIONS = {'get-metrics', 'get-columns', 'get-query-context'}
METADATA_ACTIONS = SEARCH_ACTIONS | DETAIL_ACTIONS


class KnowledgeRequestError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def check(condition, code, message):
    if not condition:
        raise KnowledgeRequestError(code, message)


def validate_request(action, request):
    check(action in METADATA_ACTIONS and isinstance(request, dict), 'knowledge_request_invalid', 'Use a metadata request object')
    common = {'catalog_revision'}
    fields = {
        'retrieve-knowledge': {'question', 'limit', 'offset'},
        'search-tables': {'question', 'limit', 'offset'},
        'search-metrics': {'question', 'source_ids', 'limit', 'offset'},
        'get-metrics': {'metric_refs'},
        'search-columns': {'question', 'source_ids', 'limit', 'offset'},
        'get-columns': {'columns'},
        'get-query-context': {'question', 'source_ids', 'metric_refs', 'columns'},
    }
    check(set(request) <= common | fields[action], 'knowledge_request_invalid', 'Unexpected metadata request field')
    question = request.get('question')
    if action in SEARCH_ACTIONS or action == 'get-query-context':
        check(isinstance(question, str) and bool(question.strip()) and len(question) <= 4000,
              'knowledge_request_invalid', 'question must contain 1..4000 characters')
    for name, maximum, default in (('limit', 50, 5), ('offset', 100000, 0)):
        value = request.get(name, default)
        check(type(value) is int and (1 if name == 'limit' else 0) <= value <= maximum,
              'knowledge_request_invalid', name + ' is outside its bounds')
    if 'catalog_revision' in request:
        check(isinstance(request['catalog_revision'], str) and len(request['catalog_revision']) == 64,
              'knowledge_request_invalid', 'Use the returned catalog_revision')
    for name in ('source_ids', 'metric_refs', 'columns'):
        if name in request:
            check(isinstance(request[name], list) and 0 < len(request[name]) <= 50,
                  'knowledge_request_invalid', name + ' must be a nonempty batch of at most 50 items')
    for source in request.get('source_ids', []):
        check(isinstance(source, str) and bool(source.strip()), 'knowledge_request_invalid', 'Use source IDs from retrieval')
    for ref in request.get('metric_refs', []):
        check(isinstance(ref, dict) and set(ref) == {'source_id', 'metric_id'}
              and all(isinstance(v, str) and bool(v.strip()) for v in ref.values()),
              'knowledge_request_invalid', 'metric_refs need source_id and metric_id')
    for group in request.get('columns', []):
        check(isinstance(group, dict) and set(group) == {'source_id', 'names'}
              and isinstance(group['source_id'], str) and isinstance(group['names'], list)
              and 0 < len(group['names']) <= 100
              and all(isinstance(v, str) and bool(v.strip()) for v in group['names']),
              'knowledge_request_invalid', 'columns need source_id and a nonempty names array')
    required = {'get-metrics': 'metric_refs', 'get-columns': 'columns',
                'get-query-context': 'source_ids', 'search-columns': 'source_ids'}.get(action)
    check(required is None or required in request, 'knowledge_request_invalid', 'Required metadata selection is missing')
    return request


def selected_sources(request):
    return set(request.get('source_ids', [])) | {r['source_id'] for r in request.get('metric_refs', [])} | {
        r['source_id'] for r in request.get('columns', [])}


def configured_scope(config, allowed):
    """Apply the same connection-owned relation boundary before any retrieval."""
    value = deepcopy(config)
    value['tables'] = [t for t in value['tables'] if (t['schema'] + '.' + t['name']).lower() in allowed]
    sources = {t['name'] for t in value['tables']}
    check(len(sources) == len(value['tables']), 'source_identity_ambiguous', 'Source names must be unique within the scenario')
    value['metrics'] = [m for m in value['metrics'] if m.get('table') in sources]
    for key in ('table_summaries', 'entities', 'period_formats', 'coverage', 'observed_probes'):
        value[key] = [d for d in value[key] if d.get('source_id') in sources]
    value['relationships'] = [r for r in value['relationships'] if all(r.get(k, {}).get('source_id') in sources for k in ('left', 'right'))]
    value['terms'] = [t for t in value['terms'] if t.get('source_id', t.get('table')) in sources | {None}]
    value['source_bindings'] = [b for b in value.get('source_bindings', []) if b.get('source_id') in sources]
    value['semantic_objects'] = [o for o in value.get('semantic_objects', [])
                                 if not o.get('source_id') or o.get('source_id') in sources]
    value['semantic_gaps'] = [g for g in value.get('semantic_gaps', [])
                              if not g.get('source_ids') or set(g.get('source_ids', [])) & sources]
    return value


def relevance(question, *values):
    tokens = set(_tokens(question))
    text = ' '.join(str(v) for v in values if v)
    words = _tokens(text)
    exact = sum(8 for value in values if isinstance(value, str) and value and value in question)
    return round(exact + sum(1 + math.log(1 + words.count(t)) for t in tokens if t in words), 3)


def page(items, request):
    offset, limit = request.get('offset', 0), request.get('limit', 5)
    end = offset + limit
    return {'items': items[offset:end], 'total': len(items), 'offset': offset,
            'next_offset': end if end < len(items) else None, 'complete': end >= len(items)}


def definition_ref(catalog, kind, source, identity):
    return {'kind': kind, 'source_id': source, 'id': identity, 'catalog_revision': catalog['catalog_revision']}


def semantic_gap_matches(catalog, question, source_ids=None):
    """Return explicit unresolved gaps whose trigger terms match this question."""
    tokens = set(_tokens(question or ''))
    selected = set(source_ids or [])
    output = []
    for gap in catalog.get('semantic_gaps', []):
        if selected and gap.get('source_ids') and not selected.intersection(gap.get('source_ids', [])):
            continue
        triggers = [gap.get('term'), *(gap.get('trigger_terms', []) or [])]
        matched = []
        for value in triggers:
            if not isinstance(value, str) or not value:
                continue
            # Chinese business terms need exact phrase evidence. Loose n-gram
            # overlap would turn “经营活动现金流量净额” into the unresolved
            # “经营应得现金流” gap merely because both contain “经营/现金流”.
            if value in (question or ''):
                matched.append(value)
            elif not re.search(r'[\u4e00-\u9fff]', value) and tokens.intersection(_tokens(value)):
                matched.append(value)
        if matched:
            output.append({**deepcopy(gap), 'matched_terms': list(dict.fromkeys(matched))})
    return output


def source_gap_matches(catalog, source_ids, question=''):
    """Return persisted source gaps and question-triggered gaps, stably."""
    selected = set(source_ids)
    output = []
    for gap in catalog.get('semantic_gaps', []):
        if not gap.get('source_ids') or not selected.intersection(gap.get('source_ids', [])):
            continue
        refs = [ref for ref in (gap.get('affected_refs') or [])
                if isinstance(ref, str) and not ref.startswith('source:')]
        # Field-scoped time gaps must remain visible for a source so SQL
        # validation can inspect the actual field. Object/term gaps are only
        # relevant when the question explicitly invokes their trigger.
        if refs and not all(ref.startswith('time:') for ref in refs):
            if not semantic_gap_matches(catalog, question, selected):
                continue
        output.append(deepcopy(gap))
    output.extend(semantic_gap_matches(catalog, question, selected))
    unique, seen = [], set()
    for gap in output:
        key = gap.get('gap_id') or repr(gap)
        if key not in seen:
            seen.add(key)
            unique.append(gap)
    return unique


def semantic_binding(catalog, kind, source_id, identity, definition=None, extra_gaps=None):
    return semantic_metadata(catalog, kind, source_id, identity, definition=definition,
                             extra_gaps=extra_gaps)


def bound_sources(catalog, kind, identity):
    """Expand an exact semantic object through the persisted source graph."""
    refs = {item.get('object_id') for item in catalog.get('semantic_objects', [])
            if item.get('kind') == kind and item.get('identity') == identity}
    return {binding.get('source_id') for binding in catalog.get('source_bindings', [])
            if binding.get('semantic_ref') in refs and binding.get('source_id')}


def metric_dependencies(metric):
    import sqlglot
    from sqlglot import exp
    fields, problems = set(), []
    expression = metric.get('expression')
    if isinstance(expression, str) and expression.strip():
        try:
            tree = sqlglot.parse_one(expression, read='mysql')
            fields.update(c.name for c in tree.find_all(exp.Column))
        except sqlglot.errors.ParseError:
            problems.append('metric_expression_unparsed')
    else:
        problems.append('metric_expression_unparsed')
    project = metric.get('project') or {}
    if isinstance(project, dict) and project.get('field'):
        fields.add(project['field'])
    fields.update(v for v in metric.get('grain', []) if isinstance(v, str))
    for key in ('unit_field', 'time_field'):
        if isinstance(metric.get(key), str):
            fields.add(metric[key])
    return sorted(fields), problems


def metric_matches(catalog, question, sources=None):
    terms = term_matches(catalog, question)
    output = []
    for metric in catalog['metrics']:
        if sources and metric.get('table') not in sources:
            continue
        semantic_properties = [metric.get(key) for key in
                               ('measure_kind', 'observation_type', 'frequency', 'aggregation', 'unit',
                                'time_field', 'time_format')]
        anchors = [metric.get('name'), metric.get('label'), (metric.get('project') or {}).get('value'),
                   *semantic_properties]
        linked = [t for t in terms if any(isinstance(a, str) and a and a in t['definition'].get('meaning', '') for a in anchors)]
        score = relevance(question, *anchors, metric.get('description')) + 10 * len(linked)
        if score > 0:
            output.append({'source_id': metric['table'], 'metric_id': metric['name'],
                           'label': metric.get('label', metric['name']), 'score': score,
                           'semantic_properties': {key: metric.get(key) for key in
                                                   ('measure_kind', 'observation_type', 'frequency',
                                                    'aggregation', 'unit', 'time_field', 'time_format')
                                                   if metric.get(key) is not None},
                           'matched_terms': [t['definition']['term'] for t in linked],
                           'definition_ref': definition_ref(catalog, 'metric', metric['table'], metric['name'])})
    return sorted(output, key=lambda m: (-m['score'], m['source_id'], m['metric_id']))


def semantic_object_matches(catalog, question, sources=None):
    """Recall generic, source-bound semantic declarations.

    The catalog may attach any domain vocabulary to an object.  Retrieval only
    reads its persisted kind/role/labels and never maps a label to a built-in
    business type.
    """
    output = []
    for item in catalog.get('semantic_objects', []):
        source_id = item.get('source_id')
        if sources and source_id and source_id not in sources:
            continue
        labels = item.get('labels', [])
        aliases = item.get('aliases', [])
        recall_terms = item.get('recall_terms', [])
        if isinstance(labels, str):
            labels = [labels]
        if isinstance(aliases, str):
            aliases = [aliases]
        if isinstance(recall_terms, str):
            recall_terms = [recall_terms]
        clues = [item.get('object_id'), item.get('identity'), item.get('kind'),
                 item.get('semantic_role'), item.get('label'), item.get('description'),
                 *labels, *aliases, *recall_terms]
        score = relevance(question, *clues)
        if score <= 0:
            continue
        identity = item.get('identity') or item.get('object_id')
        binding = semantic_binding(catalog, item.get('kind'), source_id, identity,
                                   definition=item)
        output.append({
            'object_id': item.get('object_id'), 'kind': item.get('kind'),
            'layer': item.get('layer', item.get('kind')), 'semantic_role': item.get('semantic_role'),
            'parent_ref': item.get('parent_ref'), 'source_id': source_id,
            'identity': identity, 'label': item.get('label') or item.get('identity') or item.get('object_id'),
            'score': score, 'match_stage': 'semantic_object',
            'definition': deepcopy(item),
            **binding,
        })
    return sorted(output, key=lambda item: (-item['score'], item.get('source_id') or '', item['object_id'] or ''))


def semantic_hierarchy(catalog, matches):
    """Return matched objects plus persisted ancestors as a compact graph."""
    rows = {item.get('object_id'): deepcopy(item) for item in matches if item.get('object_id')}
    persisted = {item.get('object_id'): item for item in catalog.get('semantic_objects', [])
                 if item.get('object_id')}
    pending = list(rows)
    while pending:
        current = persisted.get(pending.pop())
        parent = current.get('parent_ref') if current else None
        if parent and parent not in rows and parent in persisted:
            parent_row = persisted[parent]
            rows[parent] = {**deepcopy(parent_row), 'score': 0, 'match_stage': 'semantic_ancestor',
                            **semantic_binding(catalog, parent_row.get('kind'), parent_row.get('source_id'),
                                               parent_row.get('identity'), definition=parent_row)}
            pending.append(parent)
    return sorted(rows.values(), key=lambda item: (item.get('parent_ref') is not None,
                                                    item.get('layer', ''),
                                                    -item.get('score', 0), item.get('object_id', '')))


def entity_matches(catalog, question, sources=None, semantic_objects=None):
    """Recall source-backed entity objects before any identity/value probe."""
    output = []
    semantic_objects = semantic_objects or []
    for entity in catalog.get('entities', []):
        if sources and entity.get('source_id') not in sources:
            continue
        aliases = entity.get('aliases', {})
        alias_values = []
        if isinstance(aliases, dict):
            alias_values = [value for key, values in aliases.items()
                            for value in [key, *(values if isinstance(values, list) else [])]
                            if isinstance(value, str)]
        clues = [entity.get('id'), entity.get('label'), entity.get('description'),
                 *(entity.get('recall_terms', []) or []), *alias_values]
        linked = [item for item in semantic_objects
                  if item.get('source_id') == entity.get('source_id') and
                  (entity.get('semantic_ref') == item.get('object_id') or
                   entity.get('id') == item.get('identity'))]
        score = relevance(question, *clues) + 10 * sum(item.get('score', 0) > 0 for item in linked)
        if score <= 0:
            continue
        binding = semantic_binding(catalog, 'entity', entity['source_id'], entity['id'],
                                   definition=entity)
        output.append({
            'source_id': entity['source_id'], 'entity_id': entity['id'],
            'label': entity.get('label', entity['id']), 'score': score,
            # Keep recall generic.  A domain label such as "账套" or
            # "制造基地" belongs to the catalog row, not to a hard-coded
            # runtime object type.
            'object_type': entity.get('object_type', 'entity'),
            'layer': entity.get('layer', 'object'),
            'semantic_role': entity.get('semantic_role', 'dimension'),
            'match_stage': 'object_first',
            'semantic_object_refs': [item.get('object_id') for item in linked if item.get('object_id')],
            'definition': deepcopy(entity),
            'definition_ref': binding['definition_ref'],
            'scope': binding['scope'], 'status': binding['status'],
            'evidence': binding['evidence'], 'gaps': binding['gaps'],
        })
    return sorted(output, key=lambda item: (-item['score'], item['source_id'], item['entity_id']))


def get_metrics(catalog, refs):
    output = []
    for ref in refs:
        matches = [m for m in catalog['metrics'] if m.get('table') == ref['source_id'] and m.get('name') == ref['metric_id']]
        check(len(matches) == 1, 'metric_definition_not_unique', 'Metric must identify exactly one definition on its source')
        metric = matches[0]
        dependencies, problems = metric_dependencies(metric)
        columns = {c['name'] for t in catalog['tables'] if t['name'] == ref['source_id'] for c in t.get('columns', [])}
        missing = sorted(set(dependencies) - columns)
        output.append({**ref, 'definition': deepcopy(metric), 'required_fields': dependencies,
                       'definition_status': 'invalid' if missing or problems else 'current',
                       'missing_fields': missing, 'diagnostics': problems,
                       'definition_ref': definition_ref(catalog, 'metric', ref['source_id'], ref['metric_id'])})
    return output


def column_matches(catalog, question, sources):
    output = []
    for table in catalog['tables']:
        if table['name'] not in sources:
            continue
        for column in table.get('columns', []):
            score = relevance(question, *(column.get(k) for k in ('name', 'label', 'description', 'value_domain')))
            if score > 0:
                output.append({'source_id': table['name'], 'name': column['name'], 'score': score, 'definition': deepcopy(column)})
    return sorted(output, key=lambda c: (-c['score'], c['source_id'], c['name']))


def column_definition(catalog, source, column, dependency_cache, visible_metric_refs=None):
    """Roles come from maintained definitions, never from a guessed field label."""
    name = column['name']
    roles, refs = set(), []
    if column.get('format') or column.get('granularity'):
        roles.add('period')
    for period in catalog['period_formats']:
        if period['source_id'] == source and period.get('field') == name and period.get('definition_status') != 'invalid':
            roles.add('period')
    for entity in catalog['entities']:
        if entity['source_id'] != source or entity.get('definition_status') == 'invalid':
            continue
        if entity['key_field'] == name:
            roles.add('entity_key')
        if name in entity.get('name_fields', []):
            roles.add('entity_name')
    for summary in catalog['table_summaries']:
        if summary['source_id'] == source:
            for key, role in (('metric_fields', 'measure'), ('dimension_fields', 'dimension'),
                              ('time_fields', 'period'), ('entity_fields', 'entity_key'), ('row_grain', 'grain')):
                if name in summary.get(key, []):
                    roles.add(role)
    for metric in catalog['metrics']:
        if metric.get('table') != source:
            continue
        if visible_metric_refs is not None and (source, metric['name']) not in visible_metric_refs:
            continue
        dependencies = dependency_cache[(source, metric['name'])]
        if name in dependencies:
            roles.add('metric_dependency')
            refs.append({'source_id': source, 'metric_id': metric['name']})
        if name == (metric.get('project') or {}).get('field'):
            roles.add('metric_selector')
    for relation in catalog['relationships']:
        if relation.get('joinable', True) is False:
            continue
        if any(relation[k]['source_id'] == source and name in relation[k]['fields'] for k in ('left', 'right')):
            roles.add('join_key')
    return {**deepcopy(column), 'semantic_roles': sorted(roles), 'metric_refs': refs,
            **semantic_binding(catalog, 'column', source, name, definition=column)}


def compact_context_summary(summary, metric_names=()):
    """Keep one compact source record for the model; plan evidence stays full."""
    if not isinstance(summary, dict):
        return {}
    fields = ('source_id', 'purpose', 'business_domain', 'record_semantics',
              'row_grain', 'grain_status', 'limitations', 'provenance')
    value = {key: deepcopy(summary[key]) for key in fields if key in summary}
    wanted = set(metric_names)
    clues = []
    for clue in summary.get('metric_clues', []) or []:
        if not wanted:
            continue
        text = json.dumps(clue, ensure_ascii=False)
        if any(name and name in text for name in wanted):
            clues.append(deepcopy(clue))
    if clues:
        value['metric_clues'] = clues
    return value


def compact_semantic_graph(catalog, sources, bindings, terms):
    """Project only graph rows referenced by this question's plan."""
    refs = set()
    for binding in bindings:
        ref = binding.get('definition_ref', {})
        refs.add((ref.get('kind'), ref.get('source_id'), ref.get('id')))
    for term in terms:
        ref = term.get('definition_ref', {})
        refs.add((ref.get('kind'), ref.get('source_id'), ref.get('id')))
    persisted = {item.get('object_id'): item for item in catalog.get('semantic_objects', [])
                 if item.get('object_id')}
    pending = list(refs)
    while pending:
        current = persisted.get(pending.pop())
        parent = current.get('parent_ref') if current else None
        if parent and parent not in refs and parent in persisted:
            refs.add(parent)
            pending.append(parent)
    objects = []
    object_ids = set()
    for item in catalog.get('semantic_objects', []):
        key = (item.get('kind'), item.get('source_id'), item.get('identity'))
        if key in refs:
            objects.append(item)
            object_ids.add(item.get('object_id'))
    source_bindings = [binding for binding in catalog.get('source_bindings', [])
                       if binding.get('source_id') in sources
                       and (not binding.get('semantic_ref') or binding.get('semantic_ref') in object_ids)]
    return objects, source_bindings


def field_period_definitions(catalog, sources):
    """Expose the field-owned format as the primary temporal definition.

    ``period_formats`` remains a compatibility projection for older catalogs,
    but a saved field format is always returned with its source and evidence.
    """
    explicit = {(p.get('source_id'), p.get('field')): deepcopy(p)
                for p in catalog.get('period_formats', [])
                if p.get('source_id') in sources}
    for table in catalog.get('tables', []):
        if table.get('name') not in sources:
            continue
        for column in table.get('columns', []):
            key = (table['name'], column.get('name'))
            if key in explicit or not (column.get('format') or column.get('granularity')):
                continue
            explicit[key] = {'source_id': table['name'], 'field': column['name'],
                             'format': column.get('format'),
                             'granularity': column.get('granularity'),
                             'definition_source': 'column',
                             'evidence': [f"table_catalog:{table['name']}:{column['name']}"]}
    return list(explicit.values())


def relationship_definition(catalog, relation):
    """Wrap an explicit relation in the same evidence envelope as other hits."""
    source_ids = [relation.get(side, {}).get('source_id') for side in ('left', 'right')]
    source_id = source_ids[0] if source_ids and source_ids[0] else None
    return {**deepcopy(relation), **semantic_binding(catalog, 'relationship', source_id,
                                                     relation.get('id'), definition=relation)}


def response(catalog, action, request):
    sources = selected_sources(request)
    available = {t['name'] for t in catalog['tables']}
    check(not (sources - available), 'source_not_authorized', 'Source is outside the selected scenario catalog')
    check(not request.get('catalog_revision') or request['catalog_revision'] == catalog['catalog_revision'],
          'knowledge_revision_changed', 'Catalog definitions changed; retrieve and rebind the affected knowledge')
    live = action in {'search-columns', 'get-columns', 'get-query-context'}
    dependency_cache = {(m['table'], m['name']): metric_dependencies(m)[0] for m in catalog['metrics']} if live else {}
    result = {'schema': 'nl2sql.semantic-metadata/v1', 'operation': action,
              'scenario_id': catalog['scenario_id'], 'catalog_revision': catalog['catalog_revision'],
              'schema_verification': 'selected_sources_live' if live else 'stored_snapshot_only'}
    question = request.get('question', '')
    if action in {'retrieve-knowledge', 'search-tables'}:
        rankings = rank_sources(catalog, question)
        metrics = metric_matches(catalog, question)
        semantic_objects = semantic_object_matches(catalog, question)
        entities = entity_matches(catalog, question, semantic_objects=semantic_objects)
        matched_gaps = semantic_gap_matches(catalog, question)
        term_source_boosts = {}
        for match in term_matches(catalog, question):
            for source in bound_sources(catalog, 'term', match['definition'].get('term')):
                term_source_boosts[source] = term_source_boosts.get(source, 0) + 12
        for ranking in rankings:
            table = next(t for t in catalog['tables'] if t['name'] == ranking['source_id'])
            ranking.update(label=table.get('label', table['name']), schema=table['schema'],
                           metric_refs=[{'source_id': m['source_id'], 'metric_id': m['metric_id']} for m in metrics if m['source_id'] == table['name']])
            ranking['score'] += sum(m['score'] for m in metrics if m['source_id'] == table['name'])
            summary = next((s for s in catalog['table_summaries'] if s['source_id'] == table['name']), {})
            ranking['business_context'] = {k: summary[k] for k in ('purpose', 'record_semantics', 'row_grain', 'grain_status', 'limitations', 'provenance') if k in summary}
            ranking['matched_fields'] = [{k: c[k] for k in ('name', 'score')} for c in column_matches(catalog, question, {table['name']})[:5]]
            if ranking['source_id'] in term_source_boosts:
                ranking['score'] += term_source_boosts[ranking['source_id']]
                ranking['matched_clues'].append('semantic_source_binding')
            ranking.update(semantic_binding(catalog, 'source', table['name'], table['name'],
                                            definition=summary,
                                            extra_gaps=matched_gaps))
        rankings.sort(key=lambda r: (-r['score'], r['source_id']))
        result['sources'] = page(rankings, request)
        if action == 'retrieve-knowledge':
            terms = term_matches(catalog, question)
            result['terms'] = [{'matched_text': t['matched_text'], 'match_scope': t['match_scope'],
                                'definition': t['definition'],
                                **semantic_binding(catalog, 'term', t['definition'].get('source_id'),
                                                   t['definition']['term'], definition=t['definition'],
                                                   extra_gaps=matched_gaps)} for t in terms]
            for metric in metrics:
                metric.update(semantic_binding(catalog, 'metric', metric['source_id'], metric['metric_id'],
                                               definition=next((m for m in catalog['metrics']
                                                                if m.get('table') == metric['source_id'] and
                                                                m.get('name') == metric['metric_id']), None),
                                               extra_gaps=matched_gaps))
            result['metrics'] = page(metrics, request)
            result['semantic_objects'] = page(semantic_objects, request)
            result['semantic_object_hierarchy'] = semantic_hierarchy(catalog, semantic_objects[:request.get('limit', 5)])
            result['entities'] = page(entities, request)
            result['entity_recall'] = {
                'order': ['semantic_object', 'entity_definition', 'canonical_name', 'code_or_value_probe'],
                'contract': '先确认来源绑定的通用 semantic_object 和可执行 entity_definition，再执行 resolve-entity；只有对象定义确定后才允许对其绑定字段做代码或值探查。',
                'matched_entity_ids': [item['entity_id'] for item in entities],
                'matched_semantic_object_ids': [item['object_id'] for item in semantic_objects if item.get('object_id')],
            }
            result['relationships'] = [relationship_definition(catalog, r) for r in catalog['relationships'] if any(
                r[k]['source_id'] in {s['source_id'] for s in result['sources']['items']} for k in ('left', 'right'))]
            result['gaps'] = list(matched_gaps)
            if not metrics:
                result['gaps'].append({'gap_id': 'no_metric_definition_matched',
                    'code': 'no_metric_definition_matched',
                    'meaning': 'No lexical metric hit; this does not prove that a business metric is unavailable.',
                    'status': 'unresolved', 'blocking': False, 'scope': {'kind': 'question'}})
            result['ambiguities'] = [{'code': 'multiple_metric_candidates', 'metric_refs': [
                {k: m[k] for k in ('source_id', 'metric_id')} for m in metrics]}] if len(metrics) > 1 else []
            if any(gap.get('blocking') for gap in matched_gaps):
                result['ambiguities'].append({'code': 'blocking_semantic_gap',
                                              'gap_ids': [gap.get('gap_id') for gap in matched_gaps if gap.get('blocking')]})
            result['retrieval'] = {'method': 'hybrid_structured_v1',
                                   'stages': ['semantic_object_first', 'exact_term_alias', 'typed_metric_variant', 'char_ngram_lexical',
                                              'source_binding_expansion', 'scope_status_rerank'],
                                   'matched_gap_ids': [gap.get('gap_id') for gap in matched_gaps]}
        result['selection_contract'] = 'Candidates guide attention, never authorize a source or confirm a business meaning. Expand with offset/search when coverage is insufficient.'
    elif action == 'search-metrics':
        items = metric_matches(catalog, question, sources)
        for metric in items:
            metric.update(semantic_binding(catalog, 'metric', metric['source_id'], metric['metric_id'],
                                           definition=next((m for m in catalog['metrics']
                                                            if m.get('table') == metric['source_id'] and
                                                            m.get('name') == metric['metric_id']), None),
                                           extra_gaps=semantic_gap_matches(catalog, question, sources)))
        result['metrics'] = page(items, request)
    elif action == 'get-metrics':
        result['metrics'] = get_metrics(catalog, request['metric_refs'])
        for metric in result['metrics']:
            metric.update(semantic_binding(catalog, 'metric', metric['source_id'], metric['metric_id'],
                                           definition=next((m for m in catalog['metrics']
                                                            if m.get('table') == metric['source_id'] and
                                                            m.get('name') == metric['metric_id']), None)))
    elif action == 'search-columns':
        result['columns'] = page(column_matches(catalog, question, sources), request)
        for match in result['columns']['items']:
            match['definition'] = column_definition(catalog, match['source_id'], match['definition'], dependency_cache)
    else:
        visible_metric_refs = {(r['source_id'], r['metric_id']) for r in request.get('metric_refs', [])} if action == 'get-query-context' else None
        wanted = {s: set() for s in sources}
        for group in request.get('columns', []):
            wanted[group['source_id']].update(group['names'])
        metrics = get_metrics(catalog, request.get('metric_refs', []))
        for metric in metrics:
            wanted[metric['source_id']].update(metric['required_fields'])
        if action == 'get-query-context':
            for match in column_matches(catalog, question, sources)[:8]:
                wanted[match['source_id']].add(match['name'])
            for entity in catalog['entities']:
                if entity['source_id'] in sources and entity.get('definition_status') != 'invalid':
                    wanted[entity['source_id']].update([entity['key_field'], *entity.get('name_fields', [])])
            for period in field_period_definitions(catalog, sources):
                if period.get('definition_status') != 'invalid':
                    wanted[period['source_id']].add(period['field'])
            for table in catalog['tables']:
                if table['name'] in sources:
                    wanted[table['name']].update(c['name'] for c in table.get('columns', [])
                                                 if c.get('format') or c.get('granularity'))
            for relation in catalog['relationships']:
                if all(relation[k]['source_id'] in sources for k in ('left', 'right')):
                    for side in ('left', 'right'):
                        wanted[relation[side]['source_id']].update(relation[side]['fields'])
        projected = []
        signatures = {}
        for table in catalog['tables']:
            if table['name'] not in sources:
                continue
            known = {c['name'] for c in table['columns']}
            check(not (wanted[table['name']] - known), 'column_not_found', 'Requested or metric-dependent column is absent from the live source')
            signatures[table['name']] = table_signature(table)
            projected.append({**{k: v for k, v in table.items() if k != 'columns'},
                              'columns': [column_definition(catalog, table['name'], c, dependency_cache, visible_metric_refs) for c in table['columns'] if c['name'] in wanted[table['name']]],
                              'available_column_count': len(known), 'columns_complete': wanted[table['name']] == known})
        result.update(tables=projected, source_signatures=signatures)
        if action == 'get-query-context':
            check(all(m['definition_status'] == 'current' for m in metrics), 'metric_definition_invalid', 'Resolve invalid metric dependencies before SQL planning')
            candidate_metrics = metric_matches(catalog, question, sources)
            candidate_semantic_objects = semantic_object_matches(catalog, question, sources)
            candidate_entities = entity_matches(catalog, question, sources, candidate_semantic_objects)
            for candidate in candidate_metrics:
                candidate.update(semantic_binding(catalog, 'metric', candidate['source_id'], candidate['metric_id'],
                                                  definition=next((m for m in catalog['metrics']
                                                                   if m.get('table') == candidate['source_id'] and
                                                                   m.get('name') == candidate['metric_id']), None)))
            context_gaps = source_gap_matches(catalog, sources, question)
            for metric in metrics:
                metric.update(semantic_binding(catalog, 'metric', metric['source_id'], metric['metric_id'],
                                               definition=metric.get('definition'), extra_gaps=context_gaps))
            context_terms = []
            for match in term_matches(catalog, question):
                definition = match['definition']
                context_terms.append({
                    'matched_text': match['matched_text'], 'match_scope': match['match_scope'],
                    'definition': definition,
                    **semantic_binding(catalog, 'term', definition.get('source_id'), definition.get('term'),
                                       definition=definition, extra_gaps=context_gaps)})
            context_sources = [semantic_binding(catalog, 'source', source, source,
                                                 definition=next((s for s in catalog.get('table_summaries', [])
                                                                  if s.get('source_id') == source), None),
                                                 extra_gaps=context_gaps)
                               for source in sorted(sources)]
            context_metrics = [semantic_binding(catalog, 'metric', metric['source_id'], metric['metric_id'],
                                                definition=metric.get('definition'), extra_gaps=context_gaps)
                               for metric in metrics]
            context_times = [semantic_binding(catalog, 'time', period.get('source_id'), period.get('field'),
                                               definition=period, extra_gaps=context_gaps)
                             for period in field_period_definitions(catalog, sources)
                             if period.get('definition_status', 'current') != 'invalid']
            plan_bindings = context_sources + context_metrics + context_times
            compact_objects, compact_source_bindings = compact_semantic_graph(
                catalog, sources, plan_bindings, context_terms)
            selected_metric_names = [metric['metric_id'] for metric in metrics]
            compact_summaries = [compact_context_summary(s, selected_metric_names)
                                 for s in catalog['table_summaries'] if s['source_id'] in sources]
            result.update(metrics=metrics, candidate_metrics=candidate_metrics,
                          semantic_object_candidates=candidate_semantic_objects,
                          entities=[e for e in catalog['entities'] if e['source_id'] in sources],
                          entity_candidates=candidate_entities,
                          period_formats=[{**period, **semantic_binding(catalog, 'time', period.get('source_id'), period.get('field'),
                                                                         definition=period)}
                                           for period in field_period_definitions(catalog, sources)],
                          relationships=[relationship_definition(catalog, r) for r in catalog['relationships'] if any(r[k]['source_id'] in sources for k in ('left', 'right'))],
                          terms=context_terms,
                          table_summaries=compact_summaries,
                          knowledge_diagnostics=[d for d in catalog.get('knowledge_diagnostics', []) if d['source_id'] in sources],
                          semantic_model_version=catalog.get('semantic_model_version'),
                          semantic_bindings=plan_bindings,
                          semantic_objects=compact_objects,
                          source_bindings=compact_source_bindings,
                          coverage=[c for c in catalog.get('coverage', []) if c.get('source_id') in sources],
                          observed_probes=[p for p in catalog.get('observed_probes', []) if p.get('source_id') in sources],
                          semantic_gaps=context_gaps,
                          context_compression={'schema': 'nl2sql.semantic-context/v1',
                                               'deduplicated': ['table_summaries', 'semantic_objects', 'source_bindings'],
                                               'plan_seed_unchanged': True},
                          plan_seed={'schema': 'nl2sql.query-plan/v1', 'scenario_id': catalog['scenario_id'],
                                     'catalog_revision': catalog['catalog_revision'], 'source_signatures': signatures,
                                     'semantic_model_version': catalog.get('semantic_model_version'),
                                     'metric_bindings': deepcopy(request.get('metric_refs', [])),
                                     'entity_bindings': [], 'time_bindings': [],
                                     'semantic_bindings': plan_bindings,
                                     'semantic_gap_refs': [gap.get('gap_id') for gap in context_gaps]})
    return result

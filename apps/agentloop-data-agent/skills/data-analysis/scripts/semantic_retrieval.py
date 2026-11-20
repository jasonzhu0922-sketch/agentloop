"""Versioned, source-backed semantic lookup. No model, memory or data SQL."""
from copy import deepcopy
import math

from catalog_knowledge import _tokens, rank_sources, table_signature
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
    for key in ('table_summaries', 'entities', 'period_formats'):
        value[key] = [d for d in value[key] if d.get('source_id') in sources]
    value['relationships'] = [r for r in value['relationships'] if all(r.get(k, {}).get('source_id') in sources for k in ('left', 'right'))]
    value['terms'] = [t for t in value['terms'] if t.get('source_id', t.get('table')) in sources | {None}]
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
        anchors = [metric.get('name'), metric.get('label'), (metric.get('project') or {}).get('value')]
        linked = [t for t in terms if any(isinstance(a, str) and a and a in t['definition'].get('meaning', '') for a in anchors)]
        score = relevance(question, *anchors, metric.get('description')) + 10 * len(linked)
        if score > 0:
            output.append({'source_id': metric['table'], 'metric_id': metric['name'],
                           'label': metric.get('label', metric['name']), 'score': score,
                           'matched_terms': [t['definition']['term'] for t in linked],
                           'definition_ref': definition_ref(catalog, 'metric', metric['table'], metric['name'])})
    return sorted(output, key=lambda m: (-m['score'], m['source_id'], m['metric_id']))


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
        if any(relation[k]['source_id'] == source and name in relation[k]['fields'] for k in ('left', 'right')):
            roles.add('join_key')
    return {**deepcopy(column), 'semantic_roles': sorted(roles), 'metric_refs': refs}


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
        for ranking in rankings:
            table = next(t for t in catalog['tables'] if t['name'] == ranking['source_id'])
            ranking.update(label=table.get('label', table['name']), schema=table['schema'],
                           metric_refs=[{'source_id': m['source_id'], 'metric_id': m['metric_id']} for m in metrics if m['source_id'] == table['name']])
            ranking['score'] += sum(m['score'] for m in metrics if m['source_id'] == table['name'])
            summary = next((s for s in catalog['table_summaries'] if s['source_id'] == table['name']), {})
            ranking['business_context'] = {k: summary[k] for k in ('purpose', 'record_semantics', 'row_grain', 'grain_status', 'limitations', 'provenance') if k in summary}
            ranking['matched_fields'] = [{k: c[k] for k in ('name', 'score')} for c in column_matches(catalog, question, {table['name']})[:5]]
        rankings.sort(key=lambda r: (-r['score'], r['source_id']))
        result['sources'] = page(rankings, request)
        if action == 'retrieve-knowledge':
            terms = term_matches(catalog, question)
            result['terms'] = [{'matched_text': t['matched_text'], 'match_scope': t['match_scope'],
                                'definition': t['definition'],
                                'definition_ref': definition_ref(catalog, 'term', t['definition'].get('source_id'), t['definition']['term'])} for t in terms]
            result['metrics'] = page(metrics, request)
            result['relationships'] = [r for r in catalog['relationships'] if any(
                r[k]['source_id'] in {s['source_id'] for s in result['sources']['items']} for k in ('left', 'right'))]
            result['gaps'] = ([] if metrics else [{'code': 'no_metric_definition_matched',
                'meaning': 'No lexical metric hit; this does not prove that a business metric is unavailable.'}])
            result['ambiguities'] = [{'code': 'multiple_metric_candidates', 'metric_refs': [
                {k: m[k] for k in ('source_id', 'metric_id')} for m in metrics]}] if len(metrics) > 1 else []
        result['selection_contract'] = 'Candidates guide attention, never authorize a source or confirm a business meaning. Expand with offset/search when coverage is insufficient.'
    elif action == 'search-metrics':
        result['metrics'] = page(metric_matches(catalog, question, sources), request)
    elif action == 'get-metrics':
        result['metrics'] = get_metrics(catalog, request['metric_refs'])
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
            for period in catalog['period_formats']:
                if period['source_id'] in sources and period.get('definition_status') != 'invalid':
                    wanted[period['source_id']].add(period['field'])
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
            result.update(metrics=metrics, candidate_metrics=metric_matches(catalog, question, sources),
                          entities=[e for e in catalog['entities'] if e['source_id'] in sources],
                          period_formats=[p for p in catalog['period_formats'] if p['source_id'] in sources],
                          relationships=[r for r in catalog['relationships'] if any(r[k]['source_id'] in sources for k in ('left', 'right'))],
                          terms=[m['definition'] for m in term_matches(catalog, question)],
                          table_summaries=[s for s in catalog['table_summaries'] if s['source_id'] in sources],
                          knowledge_diagnostics=[d for d in catalog.get('knowledge_diagnostics', []) if d['source_id'] in sources],
                          plan_seed={'schema': 'nl2sql.query-plan/v1', 'scenario_id': catalog['scenario_id'],
                                     'catalog_revision': catalog['catalog_revision'], 'source_signatures': signatures,
                                     'metric_bindings': deepcopy(request.get('metric_refs', [])),
                                     'entity_bindings': [], 'time_bindings': []})
    return result

"""Project scenario knowledge and rank sources without changing query authority."""
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
import re


CATALOG_LIST_FIELDS = (
    'tables', 'metrics', 'terms', 'relationships', 'skills', 'dimensions',
    'time_policies', 'table_summaries', 'entities', 'period_formats', 'source_freshness',
)
SUMMARY_INDEX_FIELDS = (
    'source_id', 'table_signature', 'purpose', 'business_domain', 'business_terms',
    'record_semantics', 'row_grain', 'grain_status', 'query_scenarios',
    'limitations', 'provenance',
)


def catalog_config(config):
    """Share one explicit business-only boundary between storage and responses."""
    public = {key: deepcopy(config.get(key, [])) for key in CATALOG_LIST_FIELDS}
    if 'timezone' in config:
        public['timezone'] = deepcopy(config['timezone'])
    return public


def table_signature(table):
    # This is the persisted table_summaries signature format. Output visibility
    # does not change business grain; real names, types and definitions do.
    shape = {'schema': table.get('schema'), 'name': table['name'],
             'description': table.get('description'),
             'columns': [{key: column.get(key) for key in
                          ('name', 'type', 'label', 'description', 'value_domain')}
                         for column in table.get('columns', [])]}
    return hashlib.sha256(json.dumps(shape, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _summary_fields(summary):
    fields = set()
    for key in ('row_grain', 'metric_fields', 'dimension_fields', 'time_fields', 'entity_fields'):
        fields.update(summary.get(key, []))
    for clue in summary.get('metric_clues', []):
        for key in ('measure_fields', 'selector_fields', 'unit_fields'):
            fields.update(clue.get(key, []))
        fields.update(value['field'] for value in clue.get('observed_values', []))
    return fields


def prepare_knowledge(config):
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
        summary = summaries.get(source)
        status = 'not_prepared'
        if summary:
            columns = {column['name'] for column in table['columns']}
            missing = sorted(_summary_fields(summary) - columns)
            status = ('invalid' if source in duplicates or missing else
                      'current' if summary.get('table_signature') == signature else 'stale')
            if status == 'current':
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
                      if key == 'entities' else [definition['field'],
                          *([definition['selector'].get('field')]
                            if isinstance(definition.get('selector'), dict) else [])])
            missing = sorted(set(fields) - {c['name'] for c in tables[source]['columns']})
            invalid_selector = (key == 'period_formats' and 'selector' in definition and
                (not isinstance(definition['selector'], dict)
                 or not {'field', 'value'} <= set(definition['selector'])
                 or set(definition['selector']) - {'field', 'value', 'period_length'}
                 or type(definition['selector'].get('value')) not in (str, int)
                 or ('period_length' in definition['selector'] and
                     (type(definition['selector']['period_length']) is not int or
                      not 1 <= definition['selector']['period_length'] <= 32))))
            definition['definition_status'] = 'invalid' if missing or invalid_selector else 'current'
            if missing or invalid_selector:
                diagnostics.append({'kind': key, 'source_id': source,
                                    'status': 'invalid', 'missing_fields': missing,
                                    **({'invalid_selector': True} if invalid_selector else {})})
            scoped.append(definition)
        public[key] = scoped
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
                 if any(anchor in term.get('meaning', '') or anchor == term.get('term')
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
                            or t.get('source_id', t.get('table')) in requested
                            or any(isinstance(a, str) and (a in t.get('meaning', '') or a == t['term'])
                                   for a in anchors)]
    else:
        catalog['terms'] = [t for t in catalog['terms'] if t['term'] in matching_terms]
        meanings = [t.get('meaning', '') for t in catalog['terms']]
        catalog['metrics'] = [m for m in catalog['metrics'] if question and (
            any(v and v in question for v in (m.get('name'), m.get('label')))
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
    for key in ('table_summaries', 'entities', 'period_formats', 'source_freshness'):
        catalog[key] = [definition for definition in catalog[key] if definition['source_id'] in requested]
    catalog['relationships'] = [r for r in catalog['relationships']
                                 if any(r.get(side, {}).get('source_id') in requested for side in ('left', 'right'))]
    if 'knowledge_diagnostics' in catalog:
        catalog['knowledge_diagnostics'] = [d for d in catalog['knowledge_diagnostics'] if d['source_id'] in requested]
    return catalog

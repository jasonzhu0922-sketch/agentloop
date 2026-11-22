"""Derive metric projects and calendar encodings from current catalog definitions."""
from collections import defaultdict
from datetime import date, datetime
from copy import deepcopy

from entity_binding import require, scalar
from sql_evidence import merge_ranges
from knowledge_definitions import resolve_term_binding, validate_filters


FORMAT_ALIASES = {
    'YYYY': '%Y', 'YYYYMM': '%Y%m', 'YYYY-MM': '%Y-%m',
    'YYYYMMDD': '%Y%m%d', 'YYYY-MM-DD': '%Y-%m-%d',
}


def canonical_format(value):
    """Accept the human field-definition spelling and one internal spelling."""
    return FORMAT_ALIASES.get(value, value)


def binding_object(binding, fields, kind):
    require(isinstance(binding, dict) and set(binding) == set(fields)
            and all(isinstance(binding.get(k), str) and binding[k].strip() for k in fields),
            kind + '_binding_invalid', 'Supply exactly: ' + ', '.join(fields))


def constraint_checks(catalog, plan, evidence):
    tables = {t['name']: t for t in catalog['tables']}
    metric_checks, time_checks = [], []
    term_checks, declared_filters = [], {}

    def register_filters(source, filters):
        try:
            validate_filters(filters, {c['name'] for c in tables[source]['columns']})
        except (ValueError, KeyError) as exc:
            require(False, 'definition_filter_invalid', str(exc))
        for item in filters:
            key, values = (source, item['field']), {scalar(v) for v in item['values']}
            require(key not in declared_filters or declared_filters[key] == values,
                    'definition_filter_conflict', 'Selected definitions need incompatible source filters; query them separately')
            declared_filters[key] = values

    refs = plan.get('term_bindings', [])
    require(isinstance(refs, list), 'term_data_binding_invalid', 'term_bindings must be a list')
    for ref in refs:
        try:
            term, binding = resolve_term_binding(catalog, ref)
        except ValueError as exc:
            require(False, 'term_data_binding_invalid', str(exc))
        source = binding['source_id']
        require(bool(list(evidence.scans(tables[source]))), 'term_sql_mismatch', 'Bound term source is absent from SQL')
        register_filters(source, binding.get('filters', []))
        if binding.get('value_field'):
            require(evidence.references(tables[source], binding['value_field']), 'term_sql_mismatch', 'Bound value field is absent from SQL')
        term_checks.append({**ref, 'source_id': source, 'definition': deepcopy(binding),
                            'status': 'verified', 'verification_scope': 'source_fields_and_filters'})
    projects = defaultdict(set)
    for binding in plan.get('metric_bindings', []):
        binding_object(binding, ('source_id', 'metric_id'), 'metric')
        matches = [m for m in catalog['metrics'] if m.get('name') == binding['metric_id']
                   and m.get('table') == binding['source_id']]
        require(len(matches) == 1 and binding['source_id'] in tables,
                'metric_definition_invalid', 'Bind one current metric name on its declared source')
        metric = matches[0]
        require(metric.get('status') not in {'stale', 'invalid', 'unresolved'},
                'metric_definition_invalid', 'Metric is not active')
        register_filters(binding['source_id'], metric.get('filters', []))
        project = metric.get('project')
        if project is not None:
            require(isinstance(project, dict) and isinstance(project.get('field'), str)
                    and project['field'] in {c['name'] for c in tables[binding['source_id']]['columns']}
                    and type(project.get('value')) in (str, int),
                    'metric_definition_invalid', 'Metric project needs a real source field and exact scalar value')
            projects[(binding['source_id'], project['field'])].add(scalar(project['value']))
        metric_checks.append({**binding, 'definition': deepcopy(metric),
                              'verification_scope': 'project_selector' if project else 'catalog_definition',
                              'status': 'verified'})
    for (source, field), selected in projects.items():
        scans = list(evidence.scans(tables[source]))
        require(bool(scans), 'metric_sql_mismatch', 'Bound metric source is absent from SQL')
        for alias, where, single in scans:
            require(evidence.selector(where, alias, field, single) == selected,
                    'metric_sql_mismatch', 'Each physical source WHERE must filter ' + source + '.' + field
                    + ' by exactly the bound metric project values using parameterized = or IN')
    for check in metric_checks:
        scans = list(evidence.scans(tables[check['source_id']]))
        require(bool(scans), 'metric_sql_mismatch', 'Bound metric source is absent from SQL')
        check['table_aliases'] = [scan[0] for scan in scans]
    for (source, field), selected in declared_filters.items():
        scans = list(evidence.scans(tables[source]))
        require(bool(scans), 'definition_filter_mismatch', 'Bound filter source is absent')
        for alias, where, single in scans:
            require(evidence.selector(where, alias, field, single) == selected,
                    'definition_filter_mismatch', 'SQL must preserve the declared filter on ' + source + '.' + field)

    ranges = {}
    for binding in plan.get('time_bindings', []):
        require(isinstance(binding, dict), 'time_binding_invalid', 'Time binding must be an object')
        # Models sometimes carry the already-read storage contract alongside
        # the executable range. Keep those declared facts as consistency
        # evidence instead of turning an internal packaging detail into a
        # user HIL; the catalog remains authoritative below.
        require(set(binding) <= {'source_id', 'field', 'start', 'end', 'variant_id',
                                 'format', 'period_format', 'storage_format', 'granularity'},
                'time_binding_invalid', 'Unknown time binding field')
        require({'source_id', 'field', 'start', 'end'} <= set(binding),
                'time_binding_invalid', 'Supply source_id, field, start and end')
        require(all(isinstance(binding.get(k), str) and binding[k].strip()
                    for k in ('source_id', 'field', 'start', 'end')),
                'time_binding_invalid', 'Time binding fields must be nonempty strings')
        if 'variant_id' in binding:
            require(isinstance(binding['variant_id'], str) and binding['variant_id'].strip(),
                    'time_variant_invalid', 'variant_id must be a nonempty string')
        source, field = binding['source_id'], binding['field']
        table = tables.get(source, {})
        columns = [c for c in table.get('columns', []) if c['name'] == field]
        require(len(columns) == 1, 'time_definition_invalid', 'Time field must exist on its bound source')
        policies = [p for p in catalog['period_formats'] if p['source_id'] == source and p['field'] == field]
        if binding.get('variant_id'):
            policies = [p for p in policies if p.get('variant_id') == binding['variant_id']]
            require(len(policies) == 1, 'time_variant_not_found', 'Selected time format variant is not defined on this source field')
        else:
            require(len(policies) <= 1, 'time_variant_required',
                    'Multiple time format variants exist; select one by variant_id before binding a range')
        native = str(columns[0].get('type', '')).lower()
        policy = policies[0] if policies else None
        column_format = columns[0].get('format')
        column_granularity = columns[0].get('granularity')
        if column_format:
            require(columns[0].get('format_status') in {None, 'confirmed'}, 'time_definition_missing',
                    'Field format is not confirmed; resolve its definition before binding a time range')
            # A field-level format is the canonical location. A legacy
            # period_formats row may coexist only when it agrees exactly.
            if policy and canonical_format(policy.get('format')) != canonical_format(column_format):
                require(False, 'time_definition_conflict',
                        'Field format conflicts with the period definition; correct the field definition before binding')
            if policy is None:
                policy = {'source_id': source, 'field': field, 'format': column_format,
                          'granularity': column_granularity, 'definition_source': 'column'}
        if policy:
            require(policy.get('definition_status', 'current') == 'current', 'time_definition_missing',
                    'Period storage format is unresolved; inspect the field definition or run a bounded value probe')
            scoped = (f'time:{source}:{field}' in catalog.get('_scoped_periods', [])
                      and policy.get('definition_source') == 'scoped_observation')
            require(policy.get('status') in {None, 'confirmed'} or scoped, 'time_definition_missing',
                    'Period format is not confirmed; resolve its definition before binding a time range')
            fmt, grain = canonical_format(policy.get('format')), policy.get('granularity')
        else:
            require(native == 'date' or native.startswith(('datetime', 'timestamp')),
                    'time_definition_missing', 'Text/numeric time fields require an explicit period_formats definition')
            fmt, grain = '%Y-%m-%d', 'day'
        supported = {'%Y': 'year', '%Y%m': 'month', '%Y-%m': 'month',
                     '%Y%m%d': 'day', '%Y-%m-%d': 'day'}
        require(fmt in supported and grain == supported[fmt], 'time_definition_invalid',
                'Use an ordered year, month or day storage format with matching granularity')
        declared_formats = [binding.get(key) for key in ('format', 'period_format', 'storage_format')
                            if binding.get(key) is not None]
        require(all(isinstance(value, str) and canonical_format(value) == fmt for value in declared_formats),
                'time_definition_conflict',
                'Time binding storage format conflicts with the current field definition')
        if binding.get('granularity') is not None:
            require(binding['granularity'] == grain, 'time_definition_conflict',
                    'Time binding granularity conflicts with the current field definition')
        native_date = native == 'date' or native.startswith(('datetime', 'timestamp'))
        require(not native_date or fmt == '%Y-%m-%d', 'time_definition_invalid',
                'Native date fields require ISO date boundaries')
        try:
            start, end = (date.fromisoformat(binding[k]) for k in ('start', 'end'))
        except ValueError:
            require(False, 'time_binding_invalid', 'Use ISO YYYY-MM-DD calendar boundaries')
        require(all(v.isoformat() == binding[k] for v, k in ((start, 'start'), (end, 'end')))
                and start < end, 'time_binding_invalid', 'Use increasing canonical ISO date boundaries')
        require(grain != 'month' or start.day == end.day == 1,
                'time_binding_invalid', 'Monthly periods need month-aligned boundaries')
        require(grain != 'year' or (start.month, start.day, end.month, end.day) == (1, 1, 1, 1),
                'time_binding_invalid', 'Yearly periods need year-aligned boundaries')
        integer = native.startswith(('int', 'bigint', 'smallint', 'mediumint', 'tinyint'))
        require(not integer or fmt in ('%Y', '%Y%m', '%Y%m%d'), 'time_definition_invalid',
                'Integer period fields require numeric storage formats')
        encode = lambda value: int(value.strftime(fmt)) if integer else value.strftime(fmt)
        bounds = encode(start), encode(end)

        def canonical(value, integer=integer, fmt=fmt):
            encode_value = lambda v: int(v.strftime(fmt)) if integer else v.strftime(fmt)
            require(type(value) is (int if integer else str), 'time_sql_mismatch',
                    'Time parameters must use the declared storage encoding and type')
            try:
                parsed = datetime.strptime(str(value), fmt)
            except ValueError:
                require(False, 'time_sql_mismatch', 'Time parameter does not match the declared storage format')
            require(encode_value(parsed) == value, 'time_sql_mismatch', 'Time parameters must use canonical storage encoding')
            return value

        check = {**binding, 'storage_start': bounds[0], 'storage_end': bounds[1],
                 'format': fmt, 'granularity': grain, 'interval': '[start,end)',
                 'definition': deepcopy(policy), 'status': 'verified'}
        time_checks.append(check)
        group = ranges.setdefault((source, field), {'table': table, 'native_date': native_date,
                                                  'canonical': canonical, 'checks': []})
        group['checks'].append(check)
    for (source, field), group in ranges.items():
        expected = merge_ranges([(c['storage_start'], c['storage_end']) for c in group['checks']])
        scans = list(evidence.scans(group['table']))
        require(bool(scans), 'time_sql_mismatch', 'Bound time source is absent from SQL')
        for alias, where, single in scans:
            require(evidence.time_range(where, alias, field, single, group['canonical'], group['native_date']) == expected,
                    'time_sql_mismatch', 'Each physical source WHERE must implement exactly the union of bound [start,end) ranges')
        for check in group['checks']:
            check['table_aliases'] = [s[0] for s in scans]
    return {'metric_checks': metric_checks, 'time_checks': time_checks, 'term_checks': term_checks}

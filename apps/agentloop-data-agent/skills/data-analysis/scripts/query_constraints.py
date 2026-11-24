"""Derive metric projects and calendar encodings from current catalog definitions."""
from collections import defaultdict
from datetime import date, datetime
from copy import deepcopy

from entity_binding import require, scalar
from sql_evidence import merge_ranges
from sqlglot import exp


def binding_object(binding, fields, kind):
    require(isinstance(binding, dict) and set(binding) == set(fields)
            and all(isinstance(binding.get(k), str) and binding[k].strip() for k in fields),
            kind + '_binding_invalid', 'Supply exactly: ' + ', '.join(fields))


def period_policy(catalog, table, field, selector=None, *, error_code='time_definition_invalid'):
    """Select a declared storage encoding; never infer semantics from table names."""
    columns = {column['name']: column for column in table['columns']}
    require(field in columns, error_code, 'Time field must exist on its bound source',
            field='time_bindings.field', expected='a current source column', actual='column absent')
    policies = [p for p in catalog['period_formats']
                if p['source_id'] == table['name'] and p['field'] == field]
    require(selector is not None or not any(p.get('selector') is not None for p in policies),
            error_code, 'A scoped period definition needs an explicit selector',
            field='time_bindings.selector', expected='one declared selector', actual='selector absent')
    if selector is not None:
        require(isinstance(selector, dict) and {'field', 'value'} <= set(selector)
                and set(selector) <= {'field', 'value', 'period_length'}
                and isinstance(selector['field'], str) and selector['field'] in columns
                and type(selector['value']) in (str, int)
                and ('period_length' not in selector or type(selector['period_length']) is int
                     and 1 <= selector['period_length'] <= 32),
                error_code, 'Period selector needs a real field and scalar value',
                field='time_bindings.selector', expected='source field and scalar value',
                actual='invalid selector')
    matches = [p for p in policies if p.get('selector') == selector]
    require(len(matches) <= 1, error_code, 'Time field has conflicting period definitions',
            field='period_formats', expected='one definition for the selected source/field/selector',
            actual=f'{len(matches)} matching definitions')
    require(bool(matches) or not policies or selector is not None,
            error_code, 'A selector is required to choose among scoped period definitions',
            field='time_bindings.selector', expected='one declared selector', actual='selector absent')
    require(bool(matches) or not policies, 'time_definition_missing',
            'No period format matches the requested selector',
            field='period_formats', expected='a current definition matching the selected selector',
            actual='no matching definition')
    policy = matches[0] if matches else None
    native = str(columns[field].get('type', '')).lower()
    if policy:
        require(policy.get('definition_status') == 'current', error_code,
                'Use a current period definition')
        fmt, grain = policy.get('format'), policy.get('granularity')
    else:
        require(native == 'date' or native.startswith(('datetime', 'timestamp')),
                'time_definition_missing', 'Text/numeric time fields require an explicit period_formats definition',
                field='period_formats', expected='declared storage format', actual='definition absent')
        fmt, grain = '%Y-%m-%d', 'day'
    supported = {'%Y': 'year', '%Y%m': 'month', '%Y-%m': 'month',
                 '%Y%m%d': 'day', '%Y-%m-%d': 'day'}
    require(fmt in supported and grain == supported.get(fmt), error_code,
            'Use an ordered year, month or day storage format with matching granularity')
    native_date = native == 'date' or native.startswith(('datetime', 'timestamp'))
    require(not native_date or fmt == '%Y-%m-%d', error_code,
            'Native date fields require ISO date boundaries')
    integer = native.startswith(('int', 'bigint', 'smallint', 'mediumint', 'tinyint'))
    require(not integer or fmt in ('%Y', '%Y%m', '%Y%m%d'), error_code,
            'Integer period fields require numeric storage formats')
    return policy, fmt, grain, integer, native_date


def chosen_time_selector(catalog, source, field, selector):
    """Allow an unscoped legacy format only when it is the sole definition."""
    policies = [p for p in catalog['period_formats']
                if p.get('source_id') == source and p.get('field') == field]
    if selector is None and any(p.get('selector') is not None for p in policies):
        require(False, 'time_definition_invalid',
                'A scoped period definition needs an explicit selector',
                field='time_bindings.selector', expected='one declared selector', actual='selector absent')
    return selector


def constraint_checks(catalog, plan, evidence, *, separate_listing=False):
    tables = {t['name']: t for t in catalog['tables']}
    metric_checks, time_checks = [], []
    filter_checks = []
    for binding in plan.get('filter_bindings', []):
        require(isinstance(binding, dict) and set(binding) == {'source_id', 'field', 'value'}
                and type(binding['value']) in (str, int),
                'filter_binding_invalid', 'Filter needs one source, field and scalar value')
        table = tables.get(binding['source_id'])
        require(table is not None and binding['field'] in {c['name'] for c in table['columns']},
                'filter_binding_invalid', 'Filter field must exist on its selected source')
        scans = list(evidence.scans(table))
        require(bool(scans), 'filter_sql_mismatch', 'Filter source is absent from SQL')
        for alias, where, single in scans:
            actual = evidence.selector(where, alias, binding['field'], single)
            expected = {scalar(binding['value'])}
            require(actual == expected,
                    'filter_sql_mismatch', 'Each physical source WHERE must implement the bound filter',
                    field=f"filter_bindings[{binding['source_id']}.{binding['field']}]",
                    expected=repr(expected), actual=repr(actual))
        filter_checks.append({**deepcopy(binding), 'status': 'verified'})
    projects = defaultdict(set)
    for binding in plan.get('metric_bindings', []):
        binding_object(binding, ('source_id', 'metric_id'), 'metric')
        matches = [m for m in catalog['metrics'] if m.get('name') == binding['metric_id']
                   and m.get('table') == binding['source_id']]
        require(len(matches) == 1 and binding['source_id'] in tables,
                'metric_definition_invalid', 'Bind one current metric name on its declared source')
        metric = matches[0]
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
        ratio = plan.get('ratio_binding')
        expected = ({scalar(v) for v in ratio['denominator_values'] + ratio['numerator_values']}
                    if isinstance(ratio, dict) and ratio.get('source_id') == source
                    and ratio.get('project_field') == field
                    and isinstance(ratio.get('denominator_values'), list) else selected)
        require(selected <= expected, 'metric_sql_mismatch',
                'Bound metric project is absent from the ratio project universe',
                field=f'metric_bindings[{source}.{field}]', expected=repr(selected), actual=repr(expected))
        scans = list(evidence.scans(tables[source]))
        require(bool(scans), 'metric_sql_mismatch', 'Bound metric source is absent from SQL')
        for alias, where, single in scans:
            actual = evidence.selector(where, alias, field, single)
            require(actual == expected,
                    'metric_sql_mismatch', 'Each physical source WHERE must filter ' + source + '.' + field
                    + ' by exactly the bound metric project values using parameterized = or IN',
                    field=f'metric_bindings[{source}.{field}]', expected=repr(expected), actual=repr(actual))
    for check in metric_checks:
        scans = list(evidence.scans(tables[check['source_id']]))
        require(bool(scans), 'metric_sql_mismatch', 'Bound metric source is absent from SQL')
        check['table_aliases'] = [scan[0] for scan in scans]

    ranges = {}
    for binding in plan.get('time_bindings', []):
        require(isinstance(binding, dict) and set(binding) in
                ({'source_id', 'field', 'start', 'end'},
                 {'source_id', 'field', 'start', 'end', 'selector'}),
                'time_binding_invalid', 'Supply source, field, start, end and optional selector')
        binding_object({k: binding[k] for k in ('source_id', 'field', 'start', 'end')},
                       ('source_id', 'field', 'start', 'end'), 'time')
        source, field = binding['source_id'], binding['field']
        table = tables.get(source, {})
        selector = chosen_time_selector(catalog, source, field, binding.get('selector'))
        policy, fmt, grain, integer, native_date = period_policy(catalog, table, field, selector)
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
                                                  'canonical': canonical, 'checks': [], 'selector': selector})
        require(group['selector'] == selector, 'time_definition_invalid',
                'One physical time scan cannot mix different period selectors',
                field=f'time_bindings[{source}.{field}]',
                expected='one selector per source/field', actual='mixed selectors')
        group['checks'].append(check)
    for (source, field), group in ranges.items():
        expected = merge_ranges([(c['storage_start'], c['storage_end']) for c in group['checks']])
        scans = list(evidence.scans(group['table']))
        require(bool(scans), 'time_sql_mismatch', 'Bound time source is absent from SQL')
        for alias, where, single in scans:
            if group['selector']:
                selector = group['selector']
                actual = evidence.selector(where, alias, selector['field'], single)
                expected_selector = {scalar(selector['value'])}
                require(actual == expected_selector,
                        'time_sql_mismatch', 'Physical source WHERE must select exactly the declared period encoding',
                        field=f'time_bindings[{source}.{field}].selector',
                        expected=repr(expected_selector), actual=repr(actual))
                if 'period_length' in selector:
                    actual_length = evidence.period_length(where, alias, field, single)
                    require(actual_length == {selector['period_length']},
                            'time_sql_mismatch', 'Physical source WHERE must select the declared period length',
                            field=f'time_bindings[{source}.{field}].selector.period_length',
                            expected=repr({selector['period_length']}), actual=repr(actual_length))
            actual_range = evidence.time_range(where, alias, field, single, group['canonical'], group['native_date'],
                                               allow_length=bool(group['selector'] and 'period_length' in group['selector']))
            require(actual_range == expected,
                    'time_sql_mismatch', 'Each physical source WHERE must implement exactly the union of bound [start,end) ranges',
                    field=f'time_bindings[{source}.{field}]', expected=repr(expected), actual=repr(actual_range))
        for check in group['checks']:
            check['table_aliases'] = [s[0] for s in scans]
    ratio_check = ratio_constraints(catalog, plan.get('ratio_binding'), evidence)
    scope_checks = scope_constraints(catalog, plan.get('scope_bindings'), evidence,
                                      separate_listing=separate_listing)
    return {'metric_checks': metric_checks, 'time_checks': time_checks,
            'filter_checks': filter_checks,
            'ratio_check': ratio_check, 'scope_checks': scope_checks}


def ratio_constraints(catalog, binding, evidence):
    if binding is None:
        return None
    fields = {'source_id', 'project_field', 'measure_field', 'numerator_values',
              'denominator_values', 'group_by', 'zero_denominator'}
    require(isinstance(binding, dict) and set(binding) in (fields, fields | {'kind'})
            and binding.get('kind', 'part_to_whole') in ('part_to_whole', 'a_over_b')
            and binding['zero_denominator'] == 'null',
            'ratio_binding_invalid', 'Ratio needs exact branch, measure, grain and null-zero policy')
    tables = {t['name']: t for t in catalog['tables']}
    table = tables.get(binding['source_id'])
    require(table is not None, 'ratio_binding_invalid', 'Ratio source is absent')
    columns = {c['name'] for c in table['columns']}
    require(all(binding[k] in columns for k in ('project_field', 'measure_field'))
            and isinstance(binding['group_by'], list) and all(g in columns for g in binding['group_by'])
            and len(set(binding['group_by'])) == len(binding['group_by'])
            and all(isinstance(binding[k], list) and binding[k] and len(binding[k]) == len(set(binding[k]))
                    and all(type(v) in (str, int) for v in binding[k])
                    for k in ('numerator_values', 'denominator_values')),
            'ratio_binding_invalid', 'Ratio fields, branches and grain must be defined on one source')
    numerator = {scalar(v) for v in binding['numerator_values']}
    denominator = {scalar(v) for v in binding['denominator_values']}
    kind = binding.get('kind', 'part_to_whole')
    require(kind != 'part_to_whole' or numerator <= denominator, 'ratio_binding_invalid',
            'Part-to-whole numerator projects must be included in denominator projects',
            field='ratio_binding.kind', expected='numerator subset of denominator',
            actual=repr((numerator, denominator)))
    scans = list(evidence.scoped_scans(table))
    root = evidence.tree
    require(len(scans) == 1 and len(list(evidence.physical_sources())) == 1
            and isinstance(root, exp.Select) and scans[0][0] is root and not root.args.get('joins'),
            'ratio_sql_mismatch', 'Only one directly grouped physical ratio scan is supported')
    _, alias, where, single = scans[0]
    universe = numerator | denominator
    actual_universe = evidence.selector(where, alias, binding['project_field'], single)
    require(actual_universe == universe, 'ratio_sql_mismatch',
            'Physical ratio scan must select exactly the declared project universe',
            field='ratio_binding.project_universe', expected=repr(universe), actual=repr(actual_universe))
    group = root.args.get('group')
    actual_grain = [g.name for g in group.expressions] if group else []
    require(actual_grain == binding['group_by'] and all(isinstance(g, exp.Column) for g in (group.expressions if group else [])),
            'ratio_sql_mismatch', 'Ratio GROUP BY must equal the declared grain',
            field='ratio_binding.group_by', expected=repr(binding['group_by']), actual=repr(actual_grain))
    divs = list(root.find_all(exp.Div))
    require(len(divs) == 1, 'ratio_sql_mismatch', 'One conditional aggregate division is supported')
    div = divs[0]
    left, right = evidence.unwrap(div.this), evidence.unwrap(div.expression)
    require(isinstance(right, exp.Nullif) and evidence.literal_zero(right.expression),
            'ratio_sql_mismatch', 'Ratio denominator must use NULLIF(aggregate,0)',
            field='ratio_binding.zero_denominator', expected='NULLIF(aggregate,0)', actual=right.sql())
    actual_num = evidence.conditional_sum(left, alias, binding['project_field'], binding['measure_field'], single)
    actual_den = evidence.conditional_sum(right.this, alias, binding['project_field'], binding['measure_field'], single,
                                          allow_null_else=True)
    require(actual_num == numerator, 'ratio_sql_mismatch', 'Ratio numerator branch differs',
            field='ratio_binding.numerator_values', expected=repr(numerator), actual=repr(actual_num))
    require(actual_den == denominator, 'ratio_sql_mismatch', 'Ratio denominator branch differs',
            field='ratio_binding.denominator_values', expected=repr(denominator), actual=repr(actual_den))
    projections = root.expressions
    require(len(list(root.find_all(exp.Sum))) == 2 and len(projections) == len(binding['group_by']) + 1
            and all(isinstance(p, exp.Column) and p.name == field
                    for p, field in zip(projections[:-1], binding['group_by']))
            and (projections[-1].this is div if isinstance(projections[-1], exp.Alias) else projections[-1] is div),
            'ratio_sql_mismatch', 'Unexpected additional ratio aggregation or output')
    return {'status': 'verified', 'source_id': binding['source_id'],
            'verification_scope': 'physical_project_branches_group_and_nullif'}


def scope_constraints(catalog, bindings, evidence, *, separate_listing=False):
    if bindings is None:
        return []
    require(isinstance(bindings, list) and len(bindings) == (1 if separate_listing else 2),
            'scope_binding_invalid', 'Separate listing needs one scope per query; joint calculation needs two')
    tables = {t['name']: t for t in catalog['tables']}
    ids, outputs = set(), set()
    for binding in bindings:
        require(isinstance(binding, dict) and set(binding) in (
                    {'id', 'source_id', 'field', 'codes', 'output', 'time_field', 'start', 'end'},
                    {'id', 'source_id', 'field', 'codes', 'output', 'time_field', 'start', 'end', 'time_selector'})
                and binding['id'] in ('company', 'headquarters') and binding['id'] not in ids
                and isinstance(binding['output'], str) and binding['output'].isidentifier()
                and binding['output'] not in outputs and binding['source_id'] in tables
                and binding['field'] in {c['name'] for c in tables[binding['source_id']]['columns']}
                and binding['time_field'] in {c['name'] for c in tables[binding['source_id']]['columns']}
                and isinstance(binding['codes'], list) and binding['codes']
                and len(binding['codes']) == len({scalar(v) for v in binding['codes']}),
                'scope_binding_invalid', 'Each scope needs a distinct source, selector and output mapping')
        ids.add(binding['id']); outputs.add(binding['output'])
    root = evidence.tree
    if separate_listing:
        binding = bindings[0]
        require(isinstance(root, exp.Select) and not root.args.get('with_')
                and not root.args.get('joins') and not root.args.get('group')
                and not root.args.get('having') and len(root.expressions) == 1
                and isinstance(root.expressions[0], exp.Alias)
                and root.expressions[0].alias == binding['output']
                and isinstance(root.expressions[0].this, exp.Sum)
                and len(list(evidence.physical_sources())) == 1,
                'scope_sql_mismatch', 'Separate scope SQL must return one declared scalar aggregate')
        table = tables[binding['source_id']]
        scans = list(evidence.scoped_scans(table))
        require(len(scans) == 1 and scans[0][0] is root, 'scope_sql_mismatch',
                'Separate scope SQL must scan its declared source directly')
        _, alias, where, single = scans[0]
        require(evidence.selector(where, alias, binding['field'], single) ==
                {scalar(v) for v in binding['codes']}, 'scope_sql_mismatch',
                'Separate scope codes must match the physical scan',
                field=f"scope_bindings[{binding['id']}].codes",
                expected=repr(binding['codes']),
                actual=repr(evidence.selector(where, alias, binding['field'], single)))
        bounds, canonical, native_date = scope_time_bounds(catalog, binding)
        if binding.get('time_selector'):
            selector = binding['time_selector']
            require(evidence.selector(where, alias, selector['field'], single) == {scalar(selector['value'])},
                    'scope_sql_mismatch', 'Separate scope period selector differs')
            if 'period_length' in selector:
                require(evidence.period_length(where, alias, binding['time_field'], single) ==
                        {selector['period_length']}, 'scope_sql_mismatch',
                        'Separate scope period length differs')
        require(evidence.time_range(where, alias, binding['time_field'], single, canonical, native_date,
                    allow_length=bool(binding.get('time_selector') and 'period_length' in binding['time_selector']))
                == [bounds], 'scope_sql_mismatch', 'Separate scope period differs',
                field=f"scope_bindings[{binding['id']}].time_range",
                expected=repr(bounds), actual='different or absent')
        return [{'id': binding['id'], 'source_id': binding['source_id'], 'storage_bounds': bounds,
                 'output': binding['output'], 'verification_scope': 'separate_physical_selector_time_and_output'}]
    with_clause = root.args.get('with_') if isinstance(root, exp.Select) else None
    ctes = {c.alias_or_name: c.this for c in with_clause.expressions} if with_clause else {}
    require(set(ctes) == ids and len(ctes) == 2, 'scope_sql_mismatch',
            'Two scope CTEs must match the declared scope IDs')
    require(len(list(evidence.physical_sources())) == 2
            and root.args.get('from_') and root.args['from_'].this.name in ids
            and len(root.args.get('joins', [])) == 1
            and root.args['joins'][0].this.name in ids
            and root.args['joins'][0].this.name != root.args['from_'].this.name
            and root.args['joins'][0].args.get('kind') == 'CROSS'
            and not root.args.get('where') and not root.args.get('group') and not root.args.get('having'),
            'scope_sql_mismatch', 'Only a scalar CROSS JOIN of the two scope CTEs is supported')
    checks = []
    for binding in bindings:
        cte = ctes[binding['id']]
        table = tables[binding['source_id']]
        scans = [s for s in evidence.scoped_scans(table) if s[0] is cte]
        require(len(scans) == 1 and len(list(cte.find_all(exp.Table))) == 1,
                'scope_sql_mismatch', 'Each scope CTE needs exactly one physical scan')
        require(not cte.args.get('group') and not cte.args.get('having') and len(cte.expressions) == 1
                and isinstance(cte.expressions[0], exp.Alias)
                and isinstance(cte.expressions[0].this, exp.Sum),
                'scope_sql_mismatch', 'Each scope CTE must produce one scalar aggregate')
        _, alias, where, single = scans[0]
        require(evidence.selector(where, alias, binding['field'], single) == {scalar(v) for v in binding['codes']},
                'scope_sql_mismatch', 'Scope selector must match its own bound codes')
        bounds, canonical, native_date = scope_time_bounds(catalog, binding)
        if binding.get('time_selector'):
            selector = binding['time_selector']
            require(evidence.selector(where, alias, selector['field'], single) == {scalar(selector['value'])},
                    'scope_sql_mismatch', 'Scope SQL must select the declared period encoding',
                    field=f"scope_bindings[{binding['id']}].time_selector",
                    expected='declared selector on physical scan', actual='selector absent or different')
            if 'period_length' in selector:
                require(evidence.period_length(where, alias, binding['time_field'], single) == {selector['period_length']},
                        'scope_sql_mismatch', 'Scope SQL must select the declared period length',
                        field=f"scope_bindings[{binding['id']}].time_selector.period_length",
                        expected='declared period length on physical scan', actual='length absent or different')
        require(evidence.time_range(where, alias, binding['time_field'], single, canonical, native_date,
                                    allow_length=bool(binding.get('time_selector') and 'period_length' in binding['time_selector'])) == [bounds],
                'scope_sql_mismatch', 'Scope period must match its own typed [start,end) interval')
        projections = [p for p in root.expressions if p.alias_or_name == binding['output']]
        require(len(projections) == 1 and isinstance(projections[0], exp.Alias)
                and isinstance(projections[0].this, exp.Column)
                and projections[0].this.table == binding['id']
                and projections[0].this.name in {p.alias_or_name for p in cte.expressions},
                'scope_sql_mismatch', 'Outer output must reference the corresponding scope CTE')
        checks.append({'id': binding['id'], 'source_id': binding['source_id'], 'storage_bounds': bounds,
                       'output': binding['output'], 'verification_scope': 'physical_cte_selector_time_and_output'})
    require(len(root.expressions) == 2, 'scope_sql_mismatch', 'Only the two declared scope outputs are supported')
    return checks


def scope_time_bounds(catalog, binding):
    """Encode one independent scope interval using its current source policy."""
    source, field = binding['source_id'], binding['time_field']
    table = next(t for t in catalog['tables'] if t['name'] == source)
    selector = binding.get('time_selector')
    _, fmt, grain, integer, native_date = period_policy(catalog, table, field, selector,
                                                        error_code='scope_binding_invalid')
    try:
        start, end = (date.fromisoformat(binding[k]) for k in ('start', 'end'))
    except (TypeError, ValueError):
        require(False, 'scope_binding_invalid', 'Scope time needs ISO calendar boundaries')
    require(start < end and all(v.isoformat() == binding[k] for v, k in ((start, 'start'), (end, 'end')))
            and (grain != 'month' or start.day == end.day == 1)
            and (grain != 'year' or (start.month, start.day, end.month, end.day) == (1, 1, 1, 1)),
            'scope_binding_invalid', 'Scope time boundaries must align to the current period grain')
    encode = lambda v: int(v.strftime(fmt)) if integer else v.strftime(fmt)
    def canonical(value):
        require(type(value) is (int if integer else str), 'scope_sql_mismatch',
                'Scope period parameter type does not match the source')
        try:
            parsed = datetime.strptime(str(value), fmt)
        except ValueError:
            require(False, 'scope_sql_mismatch', 'Scope period parameter does not match the policy')
        require(encode(parsed) == value, 'scope_sql_mismatch', 'Scope period must be canonically encoded')
        return value
    return (encode(start), encode(end)), canonical, native_date

"""Shared table-definition contract; observations never become declarations."""
from copy import deepcopy
import hashlib
import json
import math


PHYSICAL_FIELDS = ('name', 'type', 'data_type', 'character_maximum_length',
                   'numeric_precision', 'numeric_scale', 'datetime_precision',
                   'is_nullable', 'ordinal_position', 'column_key')
FIELD_DEFINITIONS = ('label', 'description', 'value_domain', 'format', 'granularity',
                     'format_status', 'format_observed_shapes', 'allow_output',
                     'logical_type', 'unit', 'unit_field', 'declared_domain',
                     'scope_filter', 'status', 'evidence_ids')
FIELD_MEANING = ('description', 'logical_type', 'unit', 'unit_field', 'declared_domain',
                 'value_domain', 'format', 'granularity', 'scope_filter')
SUMMARY_CONTEXT = ('source_id', 'purpose', 'business_domain', 'record_semantics',
                   'table_kind', 'row_grain', 'candidate_unique_key', 'grain_status',
                   'unique_key_status', 'time_fields', 'time_semantics', 'entity_semantics',
                   'update_mode', 'update_frequency', 'query_scenarios', 'not_suitable_for',
                   'limitations', 'status', 'evidence_ids', 'provenance')
TIME_FORMATS = {'YYYY', 'YYYYMM', 'YYYY-MM', 'YYYYMMDD', 'YYYY-MM-DD',
                '%Y', '%Y%m', '%Y-%m', '%Y%m%d', '%Y-%m-%d'}


def schema_signature(table):
    """Only physical facts invalidate the table's structural dependency."""
    shape = {'schema': table.get('schema'), 'name': table['name'],
             'columns': [{k: c.get(k) for k in PHYSICAL_FIELDS}
                         for c in sorted(table.get('columns', []), key=lambda c: c['name'])]}
    return hashlib.sha256(json.dumps(shape, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def is_temporal_column(column):
    return (column.get('logical_type') in {'date', 'datetime', 'period'}
            or column.get('format') in TIME_FORMATS)


def text_list(value, label):
    if not isinstance(value, list) or any(not isinstance(v, str) or not v.strip() for v in value):
        raise ValueError(label + '必须为非空文本列表')


def validate_scope(scope, names):
    if (not isinstance(scope, dict) or scope.get('field') not in names
            or scope.get('operator') not in {'eq', 'in', 'like_any'}):
        raise ValueError('适用范围必须引用真实字段和支持的条件')
    values = scope.get('patterns') if scope['operator'] == 'like_any' else scope.get('values')
    if (not isinstance(values, list) or not values
            or any(not isinstance(v, (str, int, float)) or isinstance(v, bool) for v in values)
            or (scope['operator'] == 'eq' and len(values) != 1)
            or (scope['operator'] == 'like_any' and any(not isinstance(v, str) or not v for v in values))):
        raise ValueError('适用范围需要有效的条件值')


def validate_domain(domain):
    if not isinstance(domain, dict) or domain.get('kind') not in {'range', 'enum', 'pattern'}:
        raise ValueError('允许值域必须为范围、枚举或格式规则')
    if domain['kind'] == 'range':
        values = [domain[k] for k in ('min', 'max') if k in domain]
        if not values or any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
            raise ValueError('数值范围至少填写一个数值边界')
        if 'min' in domain and 'max' in domain and domain['min'] > domain['max']:
            raise ValueError('允许值域的最小值不能大于最大值')
    if domain['kind'] == 'enum':
        values = domain.get('values')
        if (not isinstance(values, list) or not values or any(not isinstance(v, dict)
                or type(v.get('value')) not in (str, int, float, bool)
                or not isinstance(v.get('meaning', ''), str) for v in values)):
            raise ValueError('枚举值域需要编码与含义')
        keys = [json.dumps(v['value'], ensure_ascii=False) for v in values]
        if len(set(keys)) != len(keys):
            raise ValueError('枚举编码不能重复')
    if domain['kind'] == 'pattern' and (not isinstance(domain.get('pattern'), str) or not domain['pattern'].strip()):
        raise ValueError('请填写允许值的格式规则')


def normalize_field(column, previous, physical, names):
    result = deepcopy(column)
    for computed in ('semantic_roles', 'metric_refs', 'definition_status'):
        result.pop(computed, None)
    confirm = result.pop('confirm_definition', False)
    if not isinstance(confirm, bool):
        raise ValueError('确认定义必须为布尔值')
    for key in PHYSICAL_FIELDS:
        if key in physical:
            result[key] = deepcopy(physical[key])
        else:
            result.pop(key, None)
    for key in ('label', 'description', 'value_domain', 'format', 'granularity', 'unit', 'unit_field'):
        if key in result and not isinstance(result[key], str):
            raise ValueError('字段说明、单位和格式必须为文本')
    if result.get('logical_type', '') not in {'', 'identifier', 'text', 'number', 'boolean', 'category', 'date', 'datetime', 'period'}:
        raise ValueError('未知的字段逻辑类型')
    if result.get('unit_field') and result['unit_field'] not in names:
        raise ValueError('单位字段必须引用本表真实字段')
    if result.get('unit') and result.get('unit_field'):
        raise ValueError('固定单位与单位字段请选择一种')
    if result.get('declared_domain') is not None:
        validate_domain(result['declared_domain'])
    if result.get('scope_filter') is not None:
        validate_scope(result['scope_filter'], names)
    text_list(result.get('evidence_ids', []), '定义依据')
    physical_changed = any(key in previous and previous[key] != physical.get(key)
                           for key in ('type', 'is_nullable', 'column_key'))
    changed = physical_changed or any((result.get(k) or None) != (previous.get(k) or None) for k in FIELD_MEANING)
    format_changed = any((result.get(k) or None) != (previous.get(k) or None) for k in ('format', 'granularity'))
    # A normal form save never confirms a definition or erases observations.
    result['status'] = 'provisional' if changed else previous.get('status', 'provisional')
    result['format_status'] = ('provisional' if result.get('format') else 'unresolved') if format_changed else previous.get('format_status')
    if physical_changed and result.get('format'):
        result['format_status'] = 'provisional'
    if 'format_observed_shapes' in previous:
        result['format_observed_shapes'] = deepcopy(previous['format_observed_shapes'])
    else:
        result.pop('format_observed_shapes', None)
    if confirm:
        if not result.get('evidence_ids'):
            raise ValueError('确认字段定义需要填写依据')
        result['status'] = 'confirmed'
        if result.get('format'):
            result['format_status'] = 'confirmed'
    return result


def sync_table_graph(config):
    """Project the table/field source of truth, preserving other graph kinds."""
    rows = config.setdefault('semantic_objects', [])
    bindings = config.setdefault('source_bindings', [])
    for table in config.get('tables', []):
        source = table['name']
        summary = next((s for s in config.get('table_summaries', []) if s['source_id'] == source), {})
        parent = next((r for r in rows if r.get('kind') == 'source' and r.get('source_id') == source), None)
        source_ref = parent.get('object_id') if parent else f'source:{source}:{source}'
        definitions = [('source', source, table, source_ref)] + [
            ('attribute', c['name'], c, None) for c in table.get('columns', [])]
        for kind, identity, definition, ref in definitions:
            row = next((r for r in rows if r.get('kind') in ({'attribute', 'column'} if kind == 'attribute' else {'source'})
                        and r.get('source_id') == source and (kind == 'source' or r.get('identity') == identity)), None)
            if row is None:
                row = {'object_id': ref or f'{kind}:{source}:{identity}', 'kind': kind,
                       'source_id': source, 'identity': identity}
                rows.append(row)
            row.update(layer=kind, label=definition.get('label') or identity,
                       semantic_role='physical_source' if kind == 'source' else 'field',
                       description=definition.get('description', ''), completeness='partial',
                       status=(summary.get('status', 'provisional') if kind == 'source' else definition.get('status', 'provisional')),
                       evidence=deepcopy((summary if kind == 'source' else definition).get('evidence_ids', [])),
                       scope={'kind': 'source', 'source_id': source},
                       projection_of={'collection': 'tables', 'source_id': source, 'field': identity if kind == 'attribute' else None})
            if kind == 'attribute':
                row['parent_ref'] = source_ref
            relation = 'physical_source' if kind == 'source' else 'attribute_definition'
            binding = next((b for b in bindings if b.get('semantic_ref') == row['object_id'] and b.get('relation') == relation), None)
            if binding is None:
                binding = {'binding_id': f'{kind}-binding:{source}:{identity}', 'semantic_ref': row['object_id']}
                bindings.append(binding)
            binding.update(source_id=source, relation=relation, status=row['status'], evidence=deepcopy(row['evidence']))
        present = {c['name'] for c in table.get('columns', [])}
        for row in rows:
            if row.get('source_id') == source and row.get('kind') in {'attribute', 'column'} and row.get('identity') not in present:
                row['status'] = 'stale'

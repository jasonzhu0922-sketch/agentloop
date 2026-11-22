"""Shared management and retrieval contracts for categories and definitions."""
import uuid


def term_sources(term):
    return {s for s in [term.get('source_id', term.get('table')),
                       *(b.get('source_id') for b in term.get('data_bindings', []))] if s}


def binding_fields(binding):
    return set(binding.get('fields', []) + binding.get('grain', [])) | {
        binding.get('value_field'), binding.get('time_field'), binding.get('unit_field'),
        *(f.get('field') for f in binding.get('filters', []))} - {None, ''}


def validate_categories(candidate):
    categories = candidate.get('categories', [])
    by_id, siblings = {}, set()
    for row in categories:
        if not isinstance(row, dict) or not all(isinstance(row.get(k), str) and row[k].strip() for k in ('id', 'name')):
            raise ValueError('分类需要稳定 ID 和名称')
        if row['id'] in by_id or (row.get('parent_id'), row['name'].strip()) in siblings:
            raise ValueError('分类 ID 或同级分类名称重复')
        if row.get('parent_id') is not None and not isinstance(row['parent_id'], str):
            raise ValueError('父分类必须是分类 ID')
        if type(row.get('order', 0)) is not int:
            raise ValueError('分类排序必须是整数')
        by_id[row['id']] = row
        siblings.add((row.get('parent_id'), row['name'].strip()))
    for row in categories:
        seen, current = set(), row['id']
        while current is not None:
            if current in seen:
                raise ValueError('分类不能移动到自己或自己的子分类下')
            if current not in by_id:
                raise ValueError('分类引用了不存在的父分类；请先迁移子分类')
            seen.add(current)
            current = by_id[current].get('parent_id')
    for key in ('metrics', 'terms'):
        for row in candidate.get(key, []):
            if row.get('category_id') is not None and row['category_id'] not in by_id:
                raise ValueError('条目引用了不存在的分类；请先迁移条目或设为未分类')


def category_path(categories, identifier):
    by_id = {c['id']: c for c in categories}
    result, seen = [], set()
    while identifier in by_id and identifier not in seen:
        seen.add(identifier)
        row = by_id[identifier]
        result.insert(0, row['name'])
        identifier = row.get('parent_id')
    return result


def validate_filters(filters, columns):
    if not isinstance(filters, list):
        raise ValueError('筛选条件必须为列表')
    seen = set()
    for item in filters:
        if (not isinstance(item, dict) or set(item) != {'field', 'operator', 'values'}
                or item.get('field') not in columns or item.get('operator') not in {'eq', 'in'}):
            raise ValueError('筛选条件必须选择真实字段，使用等于或属于集合')
        if item['field'] in seen:
            raise ValueError('同一字段请合并为一个筛选条件')
        seen.add(item['field'])
        values = item.get('values')
        if (not isinstance(values, list) or not values or any(type(v) not in (str, int) for v in values)
                or (item['operator'] == 'eq' and len(values) != 1)):
            raise ValueError('筛选值需要文本或整数；等于条件只能有一个值')


def validate_binding(binding, tables):
    if not isinstance(binding, dict) or not isinstance(binding.get('id'), str) or not binding['id']:
        raise ValueError('数据绑定需要稳定 ID')
    if binding.get('kind') not in {'table', 'field', 'direct'}:
        raise ValueError('绑定类型必须是表、字段或直接取值')
    table = tables.get(binding.get('source_id'))
    if not table:
        raise ValueError('数据绑定必须引用授权表')
    columns = {c['name'] for c in table['columns']}
    for key in ('fields', 'grain'):
        values = binding.get(key, [])
        if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
            raise ValueError('绑定字段和粒度必须是字段列表')
    for key in ('value_field', 'time_field', 'unit_field', 'unit', 'value_role', 'label'):
        if key in binding and not isinstance(binding[key], str):
            raise ValueError('取值字段、单位和角色必须是文本')
    validate_filters(binding.get('filters', []), columns)
    if binding_fields(binding) - columns:
        raise ValueError('数据绑定引用了不存在的字段')
    if binding['kind'] == 'field' and not binding.get('fields'):
        raise ValueError('字段关联至少选择一个字段')
    if binding['kind'] == 'direct' and not binding.get('value_field'):
        raise ValueError('直接取值需要选择数值字段')


def normalize_definitions(candidate, previous, changes, tables):
    """Only substantive edits invalidate confirmation; classification does not."""
    for key, identity in (('metrics', 'name'), ('terms', 'term')):
        if key not in changes:
            continue
        old_rows = previous.get(key, [])
        for row in candidate[key]:
            old = next((r for r in old_rows if (row.get('id') and r.get('id') == row['id'])
                        or r.get(identity) == row.get(identity)), {})
            row.setdefault('id', old.get('id') or f'{key[:-1]}_{uuid.uuid4().hex}')
            for field in ('aliases', 'tags', 'evidence_ids'):
                if field in row and (not isinstance(row[field], list) or any(not isinstance(v, str) or not v.strip() for v in row[field])):
                    raise ValueError('别名、标签和依据必须是非空文本列表')
            confirm = row.pop('confirm_definition', False)
            lifecycle = row.pop('lifecycle_action', None)
            if lifecycle not in {None, 'retire', 'restore'}:
                raise ValueError('无效的条目状态操作')
            if not isinstance(confirm, bool):
                raise ValueError('确认定义必须是布尔值')
            important = ('meaning', 'source_id', 'data_bindings') if key == 'terms' else (
                'table', 'expression', 'filters', 'project', 'grain', 'unit', 'unit_field',
                'time_field', 'aggregation', 'time_aggregation', 'object_aggregation', 'description')
            changed = not old or any(row.get(k) != old.get(k) for k in important)
            if key == 'terms' and (changed or confirm):
                if not isinstance(row.get('data_bindings', []), list):
                    raise ValueError('术语数据绑定必须是列表')
                ids = set()
                for binding in row.get('data_bindings', []):
                    validate_binding(binding, tables)
                    if binding['id'] in ids:
                        raise ValueError('术语中的绑定 ID 不能重复')
                    ids.add(binding['id'])
            elif key == 'metrics' and (changed or confirm):
                from semantic_retrieval import metric_dependencies
                import sqlglot
                from sqlglot import exp
                table = tables.get(row.get('table'))
                if not table:
                    raise ValueError('指标必须引用授权表')
                columns = {c['name'] for c in table['columns']}
                fields, errors = metric_dependencies(row)
                if errors or set(fields) - columns:
                    raise ValueError('指标表达式或依赖字段无效：' + '、'.join(errors + sorted(set(fields) - columns)))
                try:
                    parsed = sqlglot.parse(row['expression'], read='mysql')
                except sqlglot.errors.ParseError as exc:
                    raise ValueError('指标表达式无法解析') from exc
                if len(parsed) != 1 or parsed[0] is None or any(isinstance(n, (exp.Query, exp.DDL, exp.DML, exp.Command)) for n in parsed[0].walk()):
                    raise ValueError('指标只接受计算表达式，不能填写完整 SQL 或写入语句')
                if not old or row.get('definition_kind') == 'calculated':
                    if not any(isinstance(n, (exp.Func, exp.Add, exp.Sub, exp.Mul, exp.Div, exp.Mod, exp.Case)) for n in parsed[0].walk()):
                        # Existing imported source-project mappings remain readable.
                        if row.get('definition_scope') != 'source_project_and_value_field':
                            raise ValueError('直接读取字段请维护为术语绑定；指标需要加工计算')
                validate_filters(row.get('filters', []), columns)
            if changed:
                row['status'] = 'provisional'
                # Preserve legacy explicitly scoped imports, never infer their formula.
                if not old and row.get('definition_scope') == 'source_project_and_value_field' and row.get('evidence_ids'):
                    row['status'] = 'confirmed'
                for field in ('verification', 'verification_status', 'verified_at'):
                    row.pop(field, None)
            else:
                row['status'] = old.get('status', 'provisional')
            if confirm:
                if not row.get('evidence_ids'):
                    raise ValueError('确认定义需要填写依据')
                row['status'] = 'confirmed'
            if lifecycle:
                row['status'] = 'stale' if lifecycle == 'retire' else 'provisional'
    for key in ('metrics', 'terms'):
        ids = [r['id'] for r in candidate.get(key, []) if r.get('id')]
        if len(ids) != len(set(ids)):
            raise ValueError('条目 ID 不能重复')
    validate_categories(candidate)


def resolve_term_binding(catalog, reference):
    if not isinstance(reference, dict) or set(reference) != {'term_id', 'binding_id'}:
        raise ValueError('术语引用需要 term_id 和 binding_id')
    terms = [t for t in catalog['terms'] if t.get('id') == reference['term_id']]
    if len(terms) != 1 or terms[0].get('status') in {'stale', 'invalid', 'unresolved'}:
        raise ValueError('术语不存在或已停用')
    bindings = [b for b in terms[0].get('data_bindings', []) if b['id'] == reference['binding_id']]
    if len(bindings) != 1:
        raise ValueError('术语数据绑定不存在或不唯一')
    validate_binding(bindings[0], {t['name']: t for t in catalog['tables']})
    return terms[0], bindings[0]

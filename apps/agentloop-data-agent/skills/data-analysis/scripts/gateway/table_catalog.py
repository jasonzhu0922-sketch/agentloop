"""Build the analytics catalog from authorized TiDB base tables."""
from copy import deepcopy

from .database import query_connection
from .query_policy import allowed_relations



def physical_catalog(config, source_ids=None):
    """Refresh table structure and foreign keys without changing stored configuration."""
    config = deepcopy(config)
    allowed = allowed_relations()
    all_allowed = allowed.copy()
    if source_ids is not None:
        selected = set(source_ids)
        if not selected or selected - {r.split('.')[1] for r in allowed}:
            raise ValueError('Source is outside the selected scenario')
        allowed = {r for r in allowed if r.split('.')[1] in selected}
    if len({relation.split('.')[1] for relation in allowed}) != len(allowed):
        raise ValueError('同一场景不能绑定不同 schema 下的同名表')
    with query_connection() as conn:
        relations = sorted(tuple(r.split('.')) for r in allowed)
        relation_markers = ','.join(['(%s,%s)'] * len(relations))
        relation_params = [part for relation in relations for part in relation]
        with conn.cursor() as cursor:
            cursor.execute(f"""
                SELECT c.table_schema AS schema_name, c.table_name AS name,
                       c.column_name, c.column_type AS type,
                       t.table_comment AS description, c.column_comment AS column_description
                FROM information_schema.columns c
                JOIN information_schema.tables t
                  ON t.table_schema=c.table_schema AND t.table_name=c.table_name
                WHERE (c.table_schema,c.table_name) IN ({relation_markers}) AND t.table_type='BASE TABLE'
                ORDER BY c.table_schema,c.table_name,c.ordinal_position
            """, relation_params)
            rows = cursor.fetchall()
            for row in rows:
                row['schema'] = row.pop('schema_name')
                row['relation_kind'] = 'r'
            cursor.execute(f"""
                SELECT constraint_name AS id, table_schema AS left_schema,
                       referenced_table_schema AS right_schema,
                       table_name AS left_table, referenced_table_name AS right_table,
                       column_name AS left_column, referenced_column_name AS right_column
                FROM information_schema.key_column_usage
                WHERE ((table_schema,table_name) IN ({relation_markers})
                    OR (referenced_table_schema,referenced_table_name) IN ({relation_markers}))
                  AND referenced_table_name IS NOT NULL
                ORDER BY table_schema,table_name,constraint_name,ordinal_position
            """, relation_params + relation_params)
            keys = {}
            for row in cursor.fetchall():
                key = (row['left_schema'], row['left_table'], row['id'])
                relationship = keys.setdefault(key, {**row, 'left_columns': [], 'right_columns': []})
                relationship['left_columns'].append(row['left_column'])
                relationship['right_columns'].append(row['right_column'])
            foreign_keys = list(keys.values())
    found = {row['schema'] + '.' + row['name'] for row in rows}
    if allowed - found:
        raise ValueError('场景授权表缺失或不是可读取的 TiDB 实体表')
    old = {t.get('name'): t for t in config.get('tables', [])}
    tables = {}
    for row in rows:
        name = row['name']
        if row['schema'] + '.' + name not in allowed:
            continue
        previous = old.get(name, {})
        saved_columns = {c['name']: c for c in previous.get('columns', [])}
        table = tables.setdefault(name, {'name': name, 'schema': row['schema'],
                                          'relation_type': {'r': 'table', 'p': 'partitioned_table'}[row['relation_kind']],
                                          'label': previous.get('label') or name,
                                          'description': previous.get('description') or row['description'] or '', 'columns': []})
        saved = saved_columns.get(row['column_name'], {})
        table['columns'].append({'name': row['column_name'], 'type': row['type'],
                                 'label': saved.get('label', ''),
                                 'description': saved.get('description') or row['column_description'] or '',
                                 'value_domain': saved.get('value_domain', ''),
                                 'allow_output': saved.get('allow_output', True)})
    config['tables'] = list(tables.values())
    configured_relationships = config.get('relationships', [])
    physical_relationships = [{'id': f"{r['left_table']}.{r['id']}",
        'left': {'source_id': r['left_table'], 'fields': r['left_columns']},
        'right': {'source_id': r['right_table'], 'fields': r['right_columns']}}
        for r in foreign_keys if f"{r['left_schema']}.{r['left_table']}" in all_allowed and f"{r['right_schema']}.{r['right_table']}" in all_allowed]
    relationships = {r['id']: r for r in physical_relationships + configured_relationships
                     if all(r.get(side, {}).get('source_id') in {a.split('.')[1] for a in all_allowed} for side in ('left', 'right'))
                     and any(r.get(side, {}).get('source_id') in tables for side in ('left', 'right'))}
    config['relationships'] = list(relationships.values())
    config['metrics'] = [m for m in config.get('metrics', []) if m.get('table') in tables]
    config['allowed_relations'] = sorted(allowed)
    return config

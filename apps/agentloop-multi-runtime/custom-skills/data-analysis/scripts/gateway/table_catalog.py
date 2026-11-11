"""Build the analytics catalog from authorized TiDB base tables."""
from copy import deepcopy

from .database import query_connection, _validate_role
from .query_policy import allowed_relations



def physical_catalog(config):
    """Refresh table structure and foreign keys without changing stored configuration."""
    config = deepcopy(config)
    allowed = allowed_relations()
    namespaces = sorted({relation.split('.')[0] for relation in allowed})
    if len({relation.split('.')[1] for relation in allowed}) != len(allowed):
        raise ValueError('同一场景不能绑定不同 schema 下的同名表')
    with query_connection() as conn:
        _validate_role(conn)
        markers = ','.join(['%s'] * len(namespaces))
        with conn.cursor() as cursor:
            cursor.execute(f"""
                SELECT c.table_schema AS schema_name, c.table_name AS name,
                       c.column_name, c.column_type AS type,
                       t.table_comment AS description, c.column_comment AS column_description
                FROM information_schema.columns c
                JOIN information_schema.tables t
                  ON t.table_schema=c.table_schema AND t.table_name=c.table_name
                WHERE c.table_schema IN ({markers}) AND t.table_type='BASE TABLE'
                ORDER BY c.table_schema,c.table_name,c.ordinal_position
            """, namespaces)
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
                WHERE table_schema IN ({markers}) AND referenced_table_schema IN ({markers})
                  AND referenced_table_name IS NOT NULL
                ORDER BY table_schema,table_name,constraint_name,ordinal_position
            """, namespaces + namespaces)
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
        for r in foreign_keys if f"{r['left_schema']}.{r['left_table']}" in allowed and f"{r['right_schema']}.{r['right_table']}" in allowed]
    relationships = {r['id']: r for r in physical_relationships + configured_relationships
                     if r.get('left', {}).get('source_id') in tables and r.get('right', {}).get('source_id') in tables}
    config['relationships'] = list(relationships.values())
    config['metrics'] = [m for m in config.get('metrics', []) if m.get('table') in tables]
    config['allowed_relations'] = sorted(allowed)
    return config

"""Build the analytics catalog from authorized PostgreSQL base tables."""
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
        conn.execute('SET TRANSACTION READ ONLY')
        _validate_role(conn)
        rows = conn.execute("""
            SELECT n.nspname AS schema, c.relname AS name, c.relkind AS relation_kind, a.attname AS column_name,
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                   pg_catalog.obj_description(c.oid, 'pg_class') AS description,
                   pg_catalog.col_description(c.oid, a.attnum) AS column_description
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
            WHERE n.nspname = ANY(%s) AND c.relkind IN ('r', 'p')
              AND a.attnum > 0 AND NOT a.attisdropped
              AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')
            ORDER BY c.relname, a.attnum
        """, (namespaces,)).fetchall()
        foreign_keys = conn.execute("""
            SELECT con.conname AS id, ln.nspname AS left_schema, rn.nspname AS right_schema, l.relname AS left_table, r.relname AS right_table,
                   array_agg(la.attname ORDER BY k.ordinality) AS left_columns,
                   array_agg(ra.attname ORDER BY k.ordinality) AS right_columns
            FROM pg_catalog.pg_constraint con
            JOIN pg_catalog.pg_class l ON l.oid=con.conrelid
            JOIN pg_catalog.pg_class r ON r.oid=con.confrelid
            JOIN pg_catalog.pg_namespace ln ON ln.oid=l.relnamespace
            JOIN pg_catalog.pg_namespace rn ON rn.oid=r.relnamespace
            JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY k(lkey,rkey,ordinality) ON true
            JOIN pg_catalog.pg_attribute la ON la.attrelid=l.oid AND la.attnum=k.lkey
            JOIN pg_catalog.pg_attribute ra ON ra.attrelid=r.oid AND ra.attnum=k.rkey
            WHERE con.contype='f' AND ln.nspname=ANY(%s) AND rn.nspname=ANY(%s)
            GROUP BY con.oid, ln.nspname, rn.nspname, l.relname, r.relname ORDER BY con.conname
        """, (namespaces, namespaces)).fetchall()
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

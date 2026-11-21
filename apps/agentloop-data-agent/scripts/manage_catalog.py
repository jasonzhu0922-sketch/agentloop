"""Host-only administration of the same catalog consumed by the fixed Skill.

This entrypoint is outside the Skill package and is never a model tool.
"""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import quote, unquote, urlsplit, urlunsplit


class Invalid(ValueError):
    status = 400


class Conflict(Invalid):
    status = 409


EDITABLE = ('tables', 'metrics', 'terms', 'skills', 'sample_questions', 'table_summaries',
            'entities', 'period_formats', 'relationships', 'dimensions', 'time_policies',
            'semantic_objects', 'semantic_gaps')

# A catalog gap is a durable definition only.  Query-time observations belong
# to the Run audit and must never become a source-wide blocking rule.
TRANSIENT_SEMANTIC_GAP_CODES = {
    'entity_metric_binding_missing',
    'data_coverage_missing',
    'value_not_found',
}


def validate_persistent_semantic_gap(gap):
    """Reject query/runtime diagnostics at the catalog write boundary."""
    if gap.get('code') in TRANSIENT_SEMANTIC_GAP_CODES:
        raise Invalid('语义缺口属于查询时诊断，不能写入持久目录；请保存 Run 诊断或稳定定义')
    gap_id = gap.get('gap_id')
    if isinstance(gap_id, str) and gap_id.startswith('catalog_diagnostic:'):
        raise Invalid('catalog_diagnostic 只能保留在 Run 诊断，不能写入持久目录')
    evidence = gap.get('evidence') or []
    if any(isinstance(item, str) and item.startswith('catalog_diagnostic:') for item in evidence):
        raise Invalid('catalog_diagnostic 只能保留在 Run 诊断，不能写入持久目录')


def persistent_semantic_gaps(gaps):
    """Drop legacy transient rows while constructing the next catalog."""
    return [gap for gap in gaps if not (
        isinstance(gap, dict)
        and (gap.get('code') in TRANSIENT_SEMANTIC_GAP_CODES
             or (isinstance(gap.get('gap_id'), str)
                 and gap['gap_id'].startswith('catalog_diagnostic:'))
             or any(isinstance(item, str) and item.startswith('catalog_diagnostic:')
                    for item in (gap.get('evidence') or []))))]


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def read_row(store, lock=False):
    with store.connect(readonly=not lock) as cursor:
        cursor.execute('SELECT config FROM scenarios WHERE id=%s', ('group',))
        row = cursor.fetchone()
    if not row:
        raise Invalid('目录中缺少集团经营分析配置')
    return json.loads(row['config']) if isinstance(row['config'], (str, bytes)) else row['config']


def project(raw):
    # Model settings and connection strings in an imported catalog never reach HTTP.
    return {key: deepcopy(raw.get(key, [])) for key in EDITABLE}


def canonical_entity_id(entity):
    """Build the executable entity identity from maintained source fields."""
    source = entity.get('source_id')
    key_field = entity.get('key_field')
    scope = entity.get('scope_filter') or {}
    suffix = f":scope:{scope['field']}" if isinstance(scope, dict) and scope.get('field') else ''
    if isinstance(source, str) and source and isinstance(key_field, str) and key_field:
        return f'entity:{source}:{key_field}{suffix}'
    return entity.get('id')


def sync_entity_semantics(candidate, previous):
    """Materialize human-maintained entities into the runtime semantic graph."""
    old_by_key = {}
    for row in previous.get('semantic_objects', []):
        if row.get('kind') != 'entity':
            continue
        old_by_key[(row.get('source_id'), row.get('identity'))] = row
        old_by_key[(row.get('source_id'), row.get('object_id'))] = row
    id_map = {}
    for entity in candidate.get('entities', []):
        old_id = entity.get('id')
        new_id = canonical_entity_id(entity)
        if new_id and old_id and new_id != old_id:
            id_map[old_id] = new_id
        if new_id:
            entity['id'] = new_id
    if id_map:
        def replace_refs(value):
            if isinstance(value, dict):
                for key, item in list(value.items()):
                    if key == 'entity_id' and item in id_map:
                        value[key] = id_map[item]
                    elif key in {'affected_refs', 'semantic_ref'} and isinstance(item, str):
                        value[key] = id_map.get(item, item)
                    else:
                        replace_refs(item)
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    if isinstance(item, str):
                        value[index] = id_map.get(item, item)
                    else:
                        replace_refs(item)
        replace_refs(candidate.get('relationships', []))
        replace_refs(candidate.get('semantic_gaps', []))
    projected = [row for row in candidate.get('semantic_objects', []) if row.get('kind') != 'entity']
    entity_bindings = []
    for entity in candidate.get('entities', []):
        source = entity.get('source_id')
        entity_id = entity.get('id')
        if not source or not entity_id:
            continue
        prefix = f'entity:{source}:'
        identity = entity_id[len(prefix):] if entity_id.startswith(prefix) else entity_id
        scope = entity.get('scope_filter') or {}
        existing = old_by_key.get((source, identity)) or old_by_key.get((source, entity_id)) or {}
        source_row = next((row for row in projected if row.get('kind') == 'source'
                           and row.get('source_id') == source), None)
        parent_ref = (source_row or {}).get('object_id') or f'source:{source}:{source}'
        row = {
            **deepcopy(existing),
            'object_id': entity_id,
            'kind': 'entity',
            'layer': 'object',
            'source_id': source,
            'identity': identity,
            'label': entity.get('label') or existing.get('label') or identity,
            'description': entity.get('description') or existing.get('description'),
            'semantic_role': entity.get('semantic_role') or existing.get('semantic_role') or 'dimension',
            'status': entity.get('status') or existing.get('status') or 'provisional',
            'parent_ref': parent_ref,
            'scope': existing.get('scope') or {'kind': 'source', 'source_id': source},
            'evidence': list(dict.fromkeys([*(existing.get('evidence', []) or []),
                                             *(entity.get('evidence', []) or [])])),
            'gap_refs': list(dict.fromkeys([*(existing.get('gap_refs', []) or []),
                                             *(entity.get('gap_refs', []) or [])])),
        }
        if entity.get('recall_terms'):
            row['recall_terms'] = deepcopy(entity['recall_terms'])
        if entity.get('aliases'):
            row['aliases'] = deepcopy(entity['aliases'])
        if entity.get('labels'):
            row['labels'] = deepcopy(entity['labels'])
        projected.append(row)
        entity_bindings.append({'binding_id': f'entity-binding:{source}:{entity_id}',
                                'semantic_ref': entity_id, 'source_id': source,
                                'relation': 'entity_lookup', 'status': row['status'],
                                'evidence': row['evidence']})
    candidate['semantic_objects'] = projected
    candidate['source_bindings'] = [row for row in candidate.get('source_bindings', [])
                                    if row.get('relation') != 'entity_lookup'] + entity_bindings


def sync_term_semantics(candidate, previous):
    """Project the human-maintained terms collection into term graph nodes."""
    old_rows = {(row.get('source_id'), row.get('identity')): row
                for row in previous.get('semantic_objects', []) if row.get('kind') == 'term'}
    projected = [row for row in candidate.get('semantic_objects', []) if row.get('kind') != 'term']
    term_bindings = []
    for term in candidate.get('terms', []):
        identity = term.get('term')
        if not isinstance(identity, str) or not identity.strip():
            continue
        source = term.get('source_id')
        object_id = f"term:{source + ':' if source else ''}{identity}"
        existing = old_rows.get((source, identity), {})
        evidence = list(dict.fromkeys([*(existing.get('evidence', []) or []),
                                       *(term.get('evidence', []) or []),
                                       *(term.get('evidence_ids', []) or [])]))
        row = {
            **deepcopy(existing),
            'object_id': object_id,
            'kind': 'term',
            'layer': 'term',
            'source_id': source,
            'identity': identity,
            'label': identity,
            'semantic_role': 'lexical_definition',
            'status': term.get('status') or existing.get('status') or ('confirmed' if term.get('meaning') else 'unresolved'),
            'completeness': existing.get('completeness', 'partial'),
            'evidence': evidence,
            'projection_of': {'collection': 'terms', 'key': 'term', 'value': identity},
        }
        if source:
            source_row = next((item for item in projected if item.get('kind') == 'source'
                               and item.get('source_id') == source), None)
            row['parent_ref'] = (source_row or {}).get('object_id') or f'source:{source}:{source}'
            term_bindings.append({'binding_id': f'term-binding:{source}:{identity}',
                                  'semantic_ref': object_id, 'source_id': source,
                                  'relation': 'term_source', 'status': row['status'],
                                  'evidence': evidence})
        if term.get('aliases'):
            row['aliases'] = deepcopy(term['aliases'])
        projected.append(row)
    candidate['semantic_objects'] = projected
    candidate['source_bindings'] = [row for row in candidate.get('source_bindings', [])
                                    if row.get('relation') != 'term_source'] + term_bindings


def merge_config(raw, payload, physical):
    if payload.get('revision') != revision(raw):
        raise Conflict('配置已被更新，请刷新后重试')
    changes = payload.get('changes')
    if not isinstance(changes, dict) or not changes or set(changes) - set(EDITABLE):
        raise Invalid('无效的配置类别')
    candidate = deepcopy(raw)
    # One-time migration for catalogs written by older versions.  A normal
    # edit must not carry an obsolete query-time diagnostic forward.
    candidate['semantic_gaps'] = persistent_semantic_gaps(candidate.get('semantic_gaps', []))
    for key, values in changes.items():
        if not isinstance(values, list) or any(not isinstance(v, dict) for v in values):
            raise Invalid('配置必须是对象列表')
        candidate[key] = values
    tables = {t['name']: t for t in physical['tables']}
    # Structural names/types and authorization belong to the source database.
    if 'tables' in changes:
        if len(changes['tables']) != len(tables) or {t.get('name') for t in changes['tables']} != set(tables):
            raise Invalid('数据表必须与授权数据库结构一致')
        for table in changes['tables']:
            source = tables[table['name']]
            if table.get('schema') != source['schema']:
                raise Invalid('不能修改数据表的 schema')
            columns = {c['name']: c for c in source['columns']}
            if (len(table.get('columns', [])) != len(columns)
                    or {c.get('name') for c in table.get('columns', [])} != set(columns)):
                raise Invalid('字段必须与数据库结构一致')
            for column in table['columns']:
                if column.get('type') != columns[column['name']]['type']:
                    raise Invalid('不能修改数据库字段类型')
                if 'allow_output' in column and not isinstance(column['allow_output'], bool):
                    raise Invalid('字段输出设置必须为布尔值')
    identities = {'metrics': 'name', 'terms': 'term', 'skills': 'id', 'sample_questions': 'question',
                  'table_summaries': 'source_id', 'entities': 'id', 'relationships': 'id',
                  'semantic_objects': 'object_id', 'semantic_gaps': 'gap_id'}
    for key in changes:
        field = identities.get(key)
        seen = set()
        for item in changes[key]:
            if key == 'semantic_objects' and not item.get('object_id'):
                kind = item.get('kind')
                identity = item.get('identity')
                source_id = item.get('source_id')
                if isinstance(kind, str) and kind.strip() and isinstance(identity, str) and identity.strip():
                    item['object_id'] = f"{kind}:{source_id + ':' if source_id else ''}{identity}"
            if key == 'entities' and not item.get('id'):
                item['id'] = canonical_entity_id(item)
            if field:
                value = item.get(field)
                if not isinstance(value, str) or not value.strip() or value in seen:
                    raise Invalid('配置名称不能为空或重复')
                seen.add(value)
            if key == 'metrics' and (item.get('table') not in tables or not isinstance(item.get('expression'), str) or not item['expression'].strip()):
                raise Invalid('指标必须包含有效数据表和 SQL 表达式')
            if key in ('terms', 'skills'):
                list_field = 'aliases' if key == 'terms' else 'tags'
                if not isinstance(item.get(list_field, []), list) or any(not isinstance(v, str) for v in item.get(list_field, [])):
                    raise Invalid('别名和标签必须是文本列表')
            if key == 'terms' and not isinstance(item.get('meaning'), str):
                raise Invalid('请填写术语业务含义')
            if key == 'terms':
                source = item.get('source_id')
                if source is not None and source != '' and source not in tables:
                    raise Invalid('术语来源必须选择授权数据表')
                if 'status' in item and (not isinstance(item['status'], str) or not item['status'].strip()):
                    raise Invalid('术语状态必须是非空文本')
                if 'evidence_ids' in item and (not isinstance(item['evidence_ids'], list)
                                               or any(not isinstance(v, str) or not v.strip() for v in item['evidence_ids'])):
                    raise Invalid('术语证据必须是非空文本列表')
            if key == 'skills' and not all(isinstance(item.get(k), str) and item[k].strip() for k in ('name', 'prompt')):
                raise Invalid('请填写分析提示名称与内容')
            if key == 'entities':
                source = item.get('source_id')
                table = tables.get(source)
                if not table:
                    raise Invalid('对象定义必须选择授权数据表')
                columns = {column['name'] for column in table.get('columns', [])}
                if item.get('key_field') not in columns:
                    raise Invalid('对象编码字段必须来自所选数据表')
                names = item.get('name_fields', [])
                if (not isinstance(names, list) or not names
                        or any(name not in columns for name in names)):
                    raise Invalid('对象名称字段必须来自所选数据表')
                scope = item.get('scope_filter')
                if scope is not None:
                    if (not isinstance(scope, dict) or scope.get('field') not in columns
                            or scope.get('operator') != 'like_any'
                            or not isinstance(scope.get('patterns'), list)
                            or not scope['patterns']):
                        raise Invalid('对象适用范围必须绑定真实字段和值')
                if 'status' in item and (not isinstance(item['status'], str) or not item['status'].strip()):
                    raise Invalid('对象状态必须是非空文本')
            if key == 'semantic_objects':
                # The catalog stores generic semantic declarations.  Domain
                # labels (for example a local business term) are data, never
                # a code-level object type or a finance-specific branch.
                if item.get('kind') == 'term':
                    raise Invalid('term 语义对象由业务术语定义自动投影，请编辑 terms')
                if not isinstance(item.get('object_id'), str) or not item['object_id'].strip():
                    raise Invalid('语义对象必须包含 object_id')
                if not isinstance(item.get('kind'), str) or not item['kind'].strip():
                    raise Invalid('语义对象必须包含通用 kind')
                from catalog_knowledge import SEMANTIC_KIND_LAYERS
                if item['kind'] not in SEMANTIC_KIND_LAYERS:
                    raise Invalid('语义对象 kind 必须使用通用类型')
                if 'layer' in item and (not isinstance(item['layer'], str) or not item['layer'].strip()):
                    raise Invalid('语义对象 layer 必须是非空通用分类')
                if 'parent_ref' in item and item['parent_ref'] is not None and not isinstance(item['parent_ref'], str):
                    raise Invalid('语义对象 parent_ref 必须引用另一个语义对象')
                if 'semantic_role' in item and item['semantic_role'] is not None and not isinstance(item['semantic_role'], str):
                    raise Invalid('语义对象 semantic_role 必须是文本')
                if item.get('source_id') is not None and item.get('source_id') not in tables:
                    raise Invalid('语义对象引用了未授权数据表')
                for list_field in ('labels', 'aliases', 'recall_terms', 'evidence', 'gap_refs'):
                    if list_field in item and (not isinstance(item[list_field], list)
                                               or any(not isinstance(v, str) for v in item[list_field])):
                        raise Invalid(f'语义对象 {list_field} 必须是文本列表')
                if 'scope' in item and not isinstance(item['scope'], dict):
                    raise Invalid('语义对象 scope 必须是对象')
            if key == 'semantic_gaps':
                validate_persistent_semantic_gap(item)
                for required in ('gap_id', 'code', 'meaning'):
                    if not isinstance(item.get(required), str) or not item[required].strip():
                        raise Invalid('语义缺口必须包含非空 gap_id、code 和 meaning')
                if 'status' in item and (not isinstance(item['status'], str) or not item['status'].strip()):
                    raise Invalid('语义缺口 status 必须是非空文本')
                if 'blocking' in item and not isinstance(item['blocking'], bool):
                    raise Invalid('语义缺口 blocking 必须是布尔值')
                for list_field in ('source_ids', 'affected_refs', 'evidence', 'trigger_terms'):
                    if list_field in item and (not isinstance(item[list_field], list)
                                               or any(not isinstance(v, str) or not v.strip() for v in item[list_field])):
                        raise Invalid(f'语义缺口 {list_field} 必须是非空文本列表')
                if 'term' in item and (not isinstance(item['term'], str) or not item['term'].strip()):
                    raise Invalid('语义缺口 term 必须是非空文本')
                if any(source not in tables for source in item.get('source_ids', [])):
                    raise Invalid('语义缺口引用了未授权数据表')
            if key == 'table_summaries':
                source = tables.get(item['source_id'])
                if not source:
                    raise Invalid('表知识引用了未授权数据表')
                from catalog_knowledge import table_signature, _summary_fields
                if _summary_fields(item) - {c['name'] for c in source['columns']}:
                    raise Invalid('表知识引用了不存在的字段')
                # Editing prose does not prove grain or uniqueness; preserve proof fields.
                old = next((s for s in raw.get(key, []) if s.get('source_id') == item['source_id']), {})
                if item.get('row_grain') != old.get('row_grain'):
                    item['grain_status'] = 'unverified'
                    for name in ('grain_evidence', 'grain_verification', 'unique_key_evidence'):
                        item.pop(name, None)
                item['table_signature'] = table_signature(source)
    if 'terms' in changes:
        sync_term_semantics(candidate, raw)
    if 'entities' in changes:
        sync_entity_semantics(candidate, raw)
    if 'semantic_objects' in changes:
        from catalog_knowledge import semantic_graph_diagnostics, semantic_object_id
        for item in candidate.get('semantic_objects', []):
            if item.get('kind') == 'entity' and item.get('source_id') and item.get('identity'):
                expected = semantic_object_id('entity', item['source_id'], item['identity'])
                if item.get('object_id') != expected:
                    raise Invalid(f"实体语义对象 ID 必须绑定来源字段：{expected}")
        graph_errors = semantic_graph_diagnostics(candidate.get('semantic_objects', []))
        if graph_errors:
            first = graph_errors[0]
            fields = '、'.join(first.get('missing_fields', []))
            raise Invalid(f"语义对象层级无效：{first.get('object_id') or 'unknown'}（{fields}）")
    return candidate


def safe_connection(url):
    parsed = urlsplit(url)
    return {'host': parsed.hostname, 'port': parsed.port or 4000, 'user': unquote(parsed.username or ''),
            'database': unquote(parsed.path.lstrip('/')), 'password_configured': bool(parsed.password)}


def connection_candidate(previous, settings):
    if not isinstance(settings, dict):
        raise Invalid('连接设置无效')
    fields = []
    for key in ('host', 'user', 'database'):
        value = settings.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > 255:
            raise Invalid('请填写主机、用户和数据库')
        fields.append(value.strip())
    host, user, database = fields
    if not re.fullmatch(r'[a-zA-Z0-9.:-]+', host) or not re.fullmatch(r'[a-zA-Z0-9_$-]+', database):
        raise Invalid('主机或数据库名称无效')
    port = settings.get('port')
    if type(port) is not int or not 1 <= port <= 65535:
        raise Invalid('数据库端口无效')
    password = settings.get('password', '')
    if not isinstance(password, str) or len(password) > 8192:
        raise Invalid('数据库密码无效')
    old = urlsplit(previous)
    if not password and (host != old.hostname or port != (old.port or 4000) or user != unquote(old.username or '')):
        raise Invalid('更换数据库主机、端口或用户时，请重新填写密码')
    password = password or unquote(old.password or '')
    address = '[' + host + ']' if ':' in host else host
    return urlunsplit(('tidb', quote(user, safe='') + ':' + quote(password, safe='') + '@' + address + ':' + str(port), '/' + database, '', ''))


def write_connections(path, value):
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.connections-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def run(skill_root, action, payload):
    sys.path.insert(0, str(skill_root / 'scripts'))
    from runtime_config import connections
    from gateway.store import CatalogStore
    from gateway.scenarios import scenario_scope
    from gateway.table_catalog import physical_catalog
    configured = connections()
    store = CatalogStore(configured)
    if action.startswith('connection'):
        if action == 'connection-get':
            return {'revision': revision(configured), 'catalog': safe_connection(configured['catalog_database_url']),
                    'query': safe_connection(configured['query_databases']['group']['query_url']),
                    'allowed_relations': configured['query_databases']['group']['allowed_relations']}
        if payload.get('revision') != revision(configured):
            raise Conflict('连接配置已更新，请刷新后重试')
        candidate = deepcopy(configured)
        candidate['catalog_database_url'] = connection_candidate(configured['catalog_database_url'], payload.get('catalog'))
        candidate['query_databases']['group']['query_url'] = connection_candidate(configured['query_databases']['group']['query_url'], payload.get('query'))
        relations = payload.get('allowed_relations')
        if (not isinstance(relations, list) or not relations or len(set(relations)) != len(relations)
                or any(not isinstance(v, str) or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*', v) for v in relations)):
            raise Invalid('授权表必须为不重复的 schema.table 列表')
        candidate['query_databases']['group']['allowed_relations'] = relations
        candidate_store = CatalogStore(candidate)
        with scenario_scope(candidate_store.get_scenario('group')):
            catalog = physical_catalog(candidate_store.load_config())
        if action == 'connection-save':
            write_connections(skill_root / 'connections.json', candidate)
        return {'connected': True, 'table_count': len(catalog['tables'])}
    raw = read_row(store)
    if action == 'load':
        return {'revision': revision(raw), **project(raw)}
    with scenario_scope(store.get_scenario('group')):
        physical = physical_catalog(store.load_config())
    if action == 'inspect':
        return {'revision': revision(raw), **project(raw), 'tables': physical['tables'], 'catalog_status': 'connected'}
    if action == 'search':
        from catalog_knowledge import prepare_knowledge, rank_sources
        question = payload.get('query')
        if not isinstance(question, str) or not 0 < len(question.strip()) <= 4000:
            raise Invalid('检索问题无效')
        catalog = prepare_knowledge(physical)
        return {'tables': rank_sources(catalog, question)}
    if action != 'save':
        raise Invalid('未知配置操作')
    candidate = merge_config(raw, payload, physical)
    # A single row lock plus revision protects against edits by another process.
    with store.connect(readonly=False) as cursor:
        cursor.execute('SELECT config FROM scenarios WHERE id=%s FOR UPDATE', ('group',))
        row = cursor.fetchone()
        latest = json.loads(row['config']) if isinstance(row['config'], (str, bytes)) else row['config']
        if revision(latest) != payload['revision']:
            raise Conflict('配置已被更新，请刷新后重试')
        cursor.execute('UPDATE scenarios SET config=%s WHERE id=%s', (json.dumps(candidate, ensure_ascii=False), 'group'))
    return {'revision': revision(candidate), **project(candidate)}


if __name__ == '__main__':
    try:
        result = run(Path(sys.argv[1]).resolve(), sys.argv[2], json.load(sys.stdin))
    except Invalid as exc:
        result = {'error': str(exc), 'status': exc.status}
    except Exception:
        # DB exceptions can contain credentials, addresses or private SQL.
        result = {'error': '目录或数据连接不可用，请检查数据库、授权表与服务端配置', 'status': 503}
    print(json.dumps(result, ensure_ascii=False))

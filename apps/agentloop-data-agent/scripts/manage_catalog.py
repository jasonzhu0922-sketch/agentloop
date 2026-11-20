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
            'entities', 'period_formats', 'relationships', 'dimensions', 'time_policies')


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


def merge_config(raw, payload, physical):
    if payload.get('revision') != revision(raw):
        raise Conflict('配置已被更新，请刷新后重试')
    changes = payload.get('changes')
    if not isinstance(changes, dict) or not changes or set(changes) - set(EDITABLE):
        raise Invalid('无效的配置类别')
    candidate = deepcopy(raw)
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
                  'table_summaries': 'source_id', 'entities': 'id', 'relationships': 'id'}
    for key in changes:
        field = identities.get(key)
        seen = set()
        for item in changes[key]:
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
            if key == 'skills' and not all(isinstance(item.get(k), str) and item[k].strip() for k in ('name', 'prompt')):
                raise Invalid('请填写分析提示名称与内容')
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

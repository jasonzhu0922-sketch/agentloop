"""Fail-closed SQL admission for the configured analytics views."""
from __future__ import annotations


import sqlglot
from sqlglot import exp
from sqlglot.optimizer.scope import Scope, traverse_scope
from sqlglot.optimizer.qualify import qualify
from sqlglot.lineage import lineage
from .scenarios import current_scenario

# Names are SQLGlot's normalized function names, not arbitrary database functions.
SAFE_FUNCTIONS = frozenset('CASE IF COUNT SUM AVG MIN MAX COALESCE NULLIF ROUND ABS CEIL CEILING FLOOR MOD POWER SQRT LOWER UPPER TRIM LTRIM RTRIM LENGTH SUBSTRING REPLACE CONCAT CONCAT_WS SPLIT_PART POSITION EXTRACT DATE_TRUNC TIMESTAMP_TRUNC TIME_TO_STR TIME_TO_DATE STR_TO_DATE TO_CHAR CURRENT_DATE CURRENT_TIMESTAMP NOW CAST TRY_CAST ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE NTILE PERCENT_RANK CUME_DIST STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP BOOL_AND BOOL_OR STRING_AGG ARRAY_AGG GREATEST LEAST'.split())


class QueryPolicyError(ValueError):
    pass


def validate_output_fields(sql: str, config: dict) -> None:
    """Disallow direct output of unchecked physical fields, including CTEs and stars.

    Computed outputs such as aggregates remain available; this is an output
    simplification setting, not a data access or confidentiality policy.
    """
    tables = config.get('tables', [])
    excluded = {(t['name'], c['name']) for t in tables for c in t.get('columns', []) if c.get('allow_output') is False}
    if not excluded:
        return
    schema = {}
    authorized = allowed_relations()
    for table in tables:
        namespaces = [r.split('.')[0] for r in authorized if r.split('.')[1] == table['name']]
        for namespace in namespaces:
            schema.setdefault(namespace, {})[table['name']] = {c['name']: 'UNKNOWN' for c in table.get('columns', [])}
    try:
        tree = qualify(sqlglot.parse_one(sql, read='postgres'), dialect='postgres', schema=schema, validate_qualify_columns=True)
        if len(tree.named_selects) != len(set(tree.named_selects)):
            raise QueryPolicyError('查询结果字段名重复，无法验证结果字段')
        for output in tree.named_selects:
            root = lineage(output, tree, schema=schema, dialect='postgres')
            def check(node, direct=True):
                expression = node.expression
                if isinstance(expression, exp.Table):
                    column = sqlglot.parse_one(node.name, read='postgres')
                    if direct and isinstance(column, exp.Column) and (expression.name, column.name) in excluded:
                        raise QueryPolicyError(f'字段 {expression.name}.{column.name} 未勾选为结果字段，不能直接输出')
                    return
                value = expression.this if isinstance(expression, exp.Alias) else expression
                direct = direct and isinstance(value, exp.Column)
                for child in node.downstream:
                    check(child, direct)
            check(root)
    except QueryPolicyError:
        raise
    except Exception as exc:
        raise QueryPolicyError('无法验证结果字段，请使用明确的表名和字段名') from exc


def _identifier_name(identifier: exp.Identifier) -> str:
    return identifier.name if identifier.args.get('quoted') else identifier.name.lower()


def allowed_relations() -> set[str]:
    binding = (current_scenario() or {}).get('binding', {})
    if not isinstance(binding.get('allowed_relations'), list):
        raise QueryPolicyError('当前场景没有配置授权数据表')
    raw = ','.join(binding['allowed_relations'])
    result = {x.strip().lower() for x in raw.split(',') if x.strip()}
    if not result or any(len(x.split('.')) != 2 or not all(p.isidentifier() and p.isascii() for p in x.split('.')) for x in result):
        raise QueryPolicyError('服务端允许的数据表配置无效')
    return result


def validate_query(sql: str) -> None:
    if not isinstance(sql, str) or not sql.strip() or len(sql.encode('utf-8')) > 65536:
        raise QueryPolicyError('SQL 为空或超过长度上限')
    try:
        parsed = [node for node in sqlglot.parse(sql, read='postgres') if node is not None]
    except Exception as exc:
        raise QueryPolicyError('SQL 语法无法解析') from exc
    if len(parsed) != 1 or not isinstance(parsed[0], (exp.Select, exp.SetOperation)):
        raise QueryPolicyError('只允许单条 SELECT 查询')
    tree = parsed[0]
    if any(isinstance(n, (exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Command, exp.Into, exp.Lock, exp.Operator)) for n in tree.walk()):
        raise QueryPolicyError('查询包含不允许的操作')
    if any(isinstance(n, exp.With) and n.args.get('recursive') for n in tree.walk()):
        raise QueryPolicyError('不允许递归查询')
    for node in tree.walk():
        if isinstance(node, exp.DataType) and node.this == exp.DataType.Type.USERDEFINED:
            raise QueryPolicyError('不允许自定义类型')
        if isinstance(node, exp.Dot) and isinstance(node.expression, exp.Func):
            if not isinstance(node.this, exp.Identifier) or _identifier_name(node.this) != 'pg_catalog':
                raise QueryPolicyError('不允许调用非系统 schema 的函数')
        # SQLGlot models boolean connectors as Func subclasses even though
        # they are SQL operators, not database function calls. Their operands
        # are still visited and checked independently.
        if isinstance(node, exp.Func) and not isinstance(node, exp.Connector):
            name = node.name.upper() if isinstance(node, exp.Anonymous) else node.sql_name().upper()
            if name not in SAFE_FUNCTIONS:
                raise QueryPolicyError(f'不允许的数据库函数: {name}')
    try:
        scopes = list(traverse_scope(tree))
        if not scopes:
            raise QueryPolicyError('无法识别查询范围')
        relations = []
        for scope in scopes:
            for source in scope.sources.values():
                if isinstance(source, Scope):
                    continue
                if not isinstance(source, exp.Table) or not isinstance(source.this, exp.Identifier):
                    raise QueryPolicyError('不允许表函数或非常规数据源')
                if source.catalog or not source.db:
                    raise QueryPolicyError('表必须使用明确的 schema 和表名')
                schema = source.args.get('db')
                if not isinstance(schema, exp.Identifier):
                    raise QueryPolicyError('表必须使用明确的 schema 和表名')
                identifier = f'{_identifier_name(schema)}.{_identifier_name(source.this)}'
                if identifier not in allowed_relations():
                    raise QueryPolicyError(f'未授权的数据源: {identifier}')
                relations.append(identifier)
        # Every Table must appear in an analyzed scope; fail closed on syntax
        # that the optimizer does not expose as a source.
        scoped_tables = {id(v) for scope in scopes for v in scope.sources.values() if isinstance(v, exp.Table)}
        scoped_ctes = {id(n) for scope in scopes for n in scope.tables if n.name in scope.sources and isinstance(scope.sources[n.name], Scope)}
        if any(id(t) not in scoped_tables and id(t) not in scoped_ctes for t in tree.find_all(exp.Table)):
            raise QueryPolicyError('无法验证全部数据源')
        if not relations:
            raise QueryPolicyError('查询必须引用授权数据表')
    except QueryPolicyError:
        raise
    except Exception as exc:
        raise QueryPolicyError('无法验证查询范围') from exc

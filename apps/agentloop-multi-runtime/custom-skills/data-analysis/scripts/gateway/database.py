from __future__ import annotations

import hashlib
import json
import atexit
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from threading import Lock
from time import monotonic
from typing import Any

import psycopg
import sqlglot
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout, TooManyRequests
from sqlglot.tokens import TokenType

from .scenarios import current_scenario
from .query_policy import QueryPolicyError, allowed_relations, validate_query, validate_output_fields

_pool_lock = Lock()
_pools: dict[str, ConnectionPool] = {}


def _pool(url: str) -> ConnectionPool:
    with _pool_lock:
        if url not in _pools:
            _pools[url] = ConnectionPool(conninfo=url, min_size=0, max_size=4, max_waiting=32, timeout=5, kwargs={"row_factory": dict_row}, open=True)
        return _pools[url]


def close_query_pool() -> None:
    with _pool_lock:
        for pool in _pools.values():
            pool.close()
        _pools.clear()


atexit.register(close_query_pool)


@contextmanager
def query_connection():
    binding = (current_scenario() or {}).get('binding', {})
    url = binding.get('query_url', '')
    if not url.startswith(("postgresql://", "postgres://")):
        raise RuntimeError("未配置只读场景的只读查询连接")
    try:
        with _pool(url).connection() as connection:
            yield connection
    except (psycopg.OperationalError, PoolTimeout, TooManyRequests) as exc:
        raise RuntimeError("无法连接只读查询数据库") from exc


def _validate_role(connection) -> None:
    role = connection.execute("""
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles r
          WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
            AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
                 OR r.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))
        ) AS elevated,
        pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
        pg_catalog.has_database_privilege(current_user, current_database(), 'TEMPORARY') AS db_temp,
        EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
          WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
          AND (pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE') OR n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))) AS schema_control
    """).fetchone()
    if any(role.values()):
        raise QueryPolicyError("查询账号权限过高：必须是无建库、临时表、schema 创建或管理权限的只读账号")
    objects = connection.execute("""
        SELECT n.nspname, c.relname, c.relkind,
          (pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT') OR
           pg_catalog.has_any_column_privilege(current_user, c.oid, 'SELECT')) AS can_select,
          (pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT') OR
           pg_catalog.has_table_privilege(current_user, c.oid, 'UPDATE') OR
           pg_catalog.has_table_privilege(current_user, c.oid, 'DELETE') OR
           pg_catalog.has_table_privilege(current_user, c.oid, 'TRUNCATE') OR
           pg_catalog.has_table_privilege(current_user, c.oid, 'TRIGGER') OR
           pg_catalog.has_table_privilege(current_user, c.oid, 'REFERENCES') OR
           pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT') OR
           pg_catalog.has_any_column_privilege(current_user, c.oid, 'UPDATE') OR
           pg_catalog.has_any_column_privilege(current_user, c.oid, 'REFERENCES') OR
           c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) AS can_write
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    """).fetchall()
    allow = allowed_relations()
    for row in objects:
        if row['can_write'] or (row['can_select'] and (row['relkind'] not in ('r', 'p') or f"{row['nspname']}.{row['relname']}" not in allow)):
            raise QueryPolicyError("查询账号拥有未授权的数据表权限")


def _audit(config: dict[str, Any], sql: str, params: list[Any], decision: str, reason: str, duration_ms: int | None = None, result_hash: str | None = None, row_count: int | None = None) -> None:
    callback = config.get('_query_audit')
    if not callback:
        raise RuntimeError('查询审计未配置，拒绝执行')
    callback({"run_id": config.get('_run_id'), "query_hash": hashlib.sha256(sql.encode('utf-8')).hexdigest(),
              "params_hash": hashlib.sha256(json.dumps(params, ensure_ascii=False, sort_keys=True, default=str).encode('utf-8')).hexdigest(),
              "decision": decision, "reason": reason, "duration_ms": duration_ms,
              "result_hash": result_hash, "row_count": row_count})


def audit_query_rejection(config: dict[str, Any], sql: str, params: list[Any]) -> None:
    _audit(config, sql, params, 'rejected', 'sql_policy')


def _driver_query(sql: str, params: list[Any]) -> tuple[str, list[Any] | None]:
    # Psycopg interprets every percent sign when parameters are supplied,
    # including those inside SQL strings and comments. Preserve actual %s
    # placeholders and escape all other percent signs for its parser.
    if not params:
        return sql, None
    tokens = sqlglot.Dialect.get_or_raise('postgres').tokenize(sql)
    placeholders = {
        token.start for token, following in zip(tokens, tokens[1:])
        if token.token_type == TokenType.MOD and following.token_type == TokenType.VAR
        and following.text == 's' and following.start == token.end + 1
    }
    return ''.join('%%' if char == '%' and i not in placeholders else char
                   for i, char in enumerate(sql)), params


def execute_readonly(sql: str, params: list[Any] | None = None, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config, params = config or {}, params or []
    started = monotonic()
    try:
        validate_query(sql)
        validate_output_fields(sql, config)
    except QueryPolicyError:
        _audit(config, sql, params, 'rejected', 'sql_policy')
        raise
    _audit(config, sql, params, 'started', 'approved_for_check')
    reason = 'query_error'
    try:
        driver_sql, driver_params = _driver_query(sql, params)
        with query_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
                cursor.execute("SET LOCAL search_path = pg_catalog")
                cursor.execute("SET LOCAL statement_timeout = '10s'")
                cursor.execute("SET LOCAL lock_timeout = '2s'")
                cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '15s'")
                cursor.execute("SET LOCAL row_security = on")
                _validate_role(connection)
                cursor.execute("EXPLAIN (FORMAT JSON) " + driver_sql, driver_params)
                plan = cursor.fetchone()['QUERY PLAN'][0]['Plan']
                if plan['Total Cost'] > 100000:
                    reason = 'cost_limit'
                    raise QueryPolicyError('查询预计成本超过上限，请缩小范围')
                def check_rows(node):
                    if node.get('Plan Rows', 0) > 1000000:
                        return True
                    return any(check_rows(child) for child in node.get('Plans', []))
                if check_rows(plan):
                    reason = 'estimated_rows_limit'
                    raise QueryPolicyError('查询预计扫描行数超过上限，请缩小范围')
                rows = []
                with connection.cursor(name='nl2sql_result') as results:
                    results.execute(driver_sql, driver_params)
                    columns = [column.name for column in results.description] if results.description else []
                    # Bound the serialized result, not the number of business
                    # entities. Presentation pages must not truncate execution.
                    size = len(json.dumps({'columns': columns, 'rows': []}, ensure_ascii=False,
                                          sort_keys=True, separators=(',', ':')).encode('utf-8'))
                    while True:
                        if monotonic() - started > 15:
                            reason = 'duration_limit'
                            raise QueryPolicyError('查询总时间超过上限')
                        batch = results.fetchmany(32)
                        if not batch:
                            break
                        for raw in batch:
                            row = {key: _json_value(value) for key, value in dict(raw).items()}
                            size += len(json.dumps(row, ensure_ascii=False, default=str,
                                                   separators=(',', ':')).encode('utf-8')) + bool(rows)
                            if size > 4 * 1024 * 1024:
                                reason = 'byte_limit'
                                raise QueryPolicyError('查询结果超过 4 MiB，请缩小查询范围')
                            rows.append(row)
        result_bytes = json.dumps({'columns': columns, 'rows': rows}, ensure_ascii=False, sort_keys=True, default=str, separators=(',', ':')).encode('utf-8')
        _audit(config, sql, params, 'completed', 'ok', round((monotonic() - started) * 1000), hashlib.sha256(result_bytes).hexdigest(), len(rows))
        return {"columns": columns, "rows": rows, "row_count": len(rows)}
    except Exception as exc:
        if isinstance(exc, QueryPolicyError) and reason == 'query_error':
            reason = 'role_or_policy'
        _audit(config, sql, params, 'rejected' if isinstance(exc, QueryPolicyError) else 'failed', reason, round((monotonic() - started) * 1000))
        raise


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value

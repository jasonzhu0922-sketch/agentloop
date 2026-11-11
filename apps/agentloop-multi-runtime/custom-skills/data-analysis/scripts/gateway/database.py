from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from time import monotonic
from typing import Any

import pymysql
import re
from query_errors import QueryExecutionError, QueryParameterError

from .scenarios import current_scenario
from .tidb_connection import connect
from .query_parameters import driver_query
from .query_policy import QueryPolicyError, allowed_relations, validate_query, validate_output_fields

@contextmanager
def query_connection():
    binding = (current_scenario() or {}).get('binding', {})
    with connect(binding.get('query_url', '')) as connection:
        yield connection


def _validate_role(connection) -> None:
    # TiDB does not implement START TRANSACTION READ ONLY. Effective table
    # privileges enforce the boundary; never enable no-op compatibility flags.
    with connection.cursor() as cursor:
        cursor.execute("SHOW GRANTS")
        grants = [next(iter(row.values())) for row in cursor.fetchall()]
    allowed = allowed_relations()
    selected = set()
    for grant in grants:
        match = re.fullmatch(r"GRANT (.+?) ON (.+?) TO .+", grant, flags=re.IGNORECASE)
        if not match or 'WITH GRANT OPTION' in grant.upper():
            raise QueryPolicyError('查询账号包含角色或可转授权权限')
        privileges, resource = match.groups()
        if privileges.upper() == 'USAGE' and resource == '*.*':
            continue
        relation = resource.replace('`', '')
        if privileges.upper() != 'SELECT' or relation not in allowed:
            raise QueryPolicyError('查询账号必须仅拥有场景授权表的 SELECT 权限')
        selected.add(relation)
    if selected != allowed:
        raise QueryPolicyError('查询账号缺少场景授权表的 SELECT 权限')


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
    return driver_query(sql, params)


def execute_readonly(sql: str, params: list[Any] | None = None, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config, params = config or {}, params or []
    started = monotonic()
    try:
        validate_query(sql)
        validate_output_fields(sql, config)
        driver_sql, driver_params = _driver_query(sql, params)
    except QueryPolicyError:
        _audit(config, sql, params, 'rejected', 'sql_policy')
        raise
    except QueryParameterError:
        _audit(config, sql, params, 'rejected', 'parameter_binding')
        raise
    _audit(config, sql, params, 'started', 'approved_for_check')
    reason = 'query_error'
    phase = 'connection.open'
    try:
        with query_connection() as connection:
            with connection.cursor() as cursor:
                phase = 'transaction.configure'
                cursor.execute("SET SESSION max_execution_time=10000")
                phase = 'role.check'
                _validate_role(connection)
                phase = 'query.explain'
                cursor.execute("EXPLAIN FORMAT='brief' " + driver_sql, driver_params)
                plan = cursor.fetchall()
                if not plan or any(float(row['estRows']) > 1000000 for row in plan):
                    reason = 'estimated_rows_limit'
                    raise QueryPolicyError('查询预计扫描行数超过上限或无法验证查询计划，请缩小范围')
                rows = []
                phase = 'query.execute'
                with connection.cursor(pymysql.cursors.SSDictCursor) as results:
                    results.execute(driver_sql, driver_params)
                    phase = 'result.fetch'
                    columns = [column[0] for column in results.description] if results.description else []
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
        phase = 'result.serialize'
        result_bytes = json.dumps({'columns': columns, 'rows': rows}, ensure_ascii=False, sort_keys=True, default=str, separators=(',', ':')).encode('utf-8')
        _audit(config, sql, params, 'completed', 'ok', round((monotonic() - started) * 1000), hashlib.sha256(result_bytes).hexdigest(), len(rows))
        return {"columns": columns, "rows": rows, "row_count": len(rows)}
    except Exception as exc:
        if isinstance(exc, QueryPolicyError) and reason == 'query_error':
            reason = 'role_or_policy'
        _audit(config, sql, params, 'rejected' if isinstance(exc, QueryPolicyError) else 'failed', reason, round((monotonic() - started) * 1000))
        if isinstance(exc, QueryPolicyError):
            raise QueryPolicyError(str(exc), phase=phase) from exc
        raise QueryExecutionError(exc, phase) from exc


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value

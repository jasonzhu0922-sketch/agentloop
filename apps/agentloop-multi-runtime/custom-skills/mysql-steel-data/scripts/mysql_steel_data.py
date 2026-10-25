#!/usr/bin/env python3
"""Read-only, mapped MySQL access for the mysql-steel-data Skill."""

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any


MAX_KEYWORD_LENGTH = 120
MAX_DAYS = 3_660
MAX_SERIES_ROWS = 200
MAX_CANDIDATES = 50
MAX_PROFILE_EXAMPLES = 20
MAX_QUERY_UNDERSTANDING_ROWS = 5_000
MAX_QUERY_UNDERSTANDING_MATCHES = 20
MAX_QUERY_PLAN_BYTES = 64_000
MAX_QUERY_PLAN_ITEMS = 8
# MySQL identifiers may legitimately use Chinese names. Keep the accepted set
# narrow enough that an identifier can never carry SQL syntax or a quote.
IDENTIFIER = re.compile(r"^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{0,63}$")
SKILL_ROOT = Path(__file__).resolve().parent.parent


# These are the business slots that may be used to discover an indicator.
# A slot is exposed only after schema-map.json maps it to a confirmed catalog
# column. The canonical names intentionally mirror the database semantics;
# legacy names remain readable only for older test/deployment maps.
SEMANTIC_FIELD_DEFINITIONS: dict[str, dict[str, Any]] = {
    "indicator_name": {"label": "指标名称", "meaning": "目录中实际存储的指标展示名称（INDEX_NAME）；不能由模型自行拼接新的指标名称。", "valueKind": "controlled_text", "identityRole": "indicator_identity", "matchMode": "contains"},
    "province_name": {"label": "省份", "meaning": "行政区划中的省份名称（PROVINCE_NAME）；不能用大区、城市或市场替代。", "valueKind": "controlled_text", "identityRole": "administrative_dimension", "matchMode": "contains"},
    "city_name": {"label": "城市", "meaning": "行政区划中的城市名称（CITY_NAME）；不能用 REGION_NAME 的大区值替代。", "valueKind": "controlled_text", "identityRole": "administrative_dimension", "matchMode": "contains"},
    "county_name": {"label": "区县", "meaning": "行政区划中的区县名称（COUNTY_NAME），仅在目录有值时使用。", "valueKind": "controlled_text", "identityRole": "administrative_dimension", "matchMode": "contains"},
    "region_name": {"label": "大区", "meaning": "区域分组名称（REGION_NAME），例如华北地区；不代表省份或城市。", "valueKind": "controlled_text", "identityRole": "administrative_dimension", "matchMode": "contains"},
    "breed_name": {"label": "品种", "meaning": "目录中的品种/品名（BREED_NAME），例如热轧盘螺。", "valueKind": "controlled_text", "identityRole": "product_dimension", "matchMode": "contains"},
    "caliber_name": {"label": "规格牌号", "meaning": "目录中的规格或牌号（CALIBER_NAME）；不得把报价条件说明当成规格。", "valueKind": "controlled_text", "identityRole": "product_dimension", "matchMode": "contains"},
    "metric_name": {"label": "指标口径", "meaning": "目录中的指标口径（METRIC_NAME），例如市场价格、工程采购价；它与 INDEX_NAME 和产品维度独立。", "valueKind": "controlled_text", "identityRole": "metric_dimension", "matchMode": "contains"},
    "frequency_name": {"label": "频率", "meaning": "目录中的统计频率（FREQUENCY_NAME），例如日度、周度；不同频率不可混算。", "valueKind": "controlled_text", "identityRole": "metric_dimension", "matchMode": "contains"},
    "unit_name": {"label": "单位", "meaning": "目录中的计量单位（UNIT_NAME），例如元/吨；不同单位不可直接比较。", "valueKind": "controlled_text", "identityRole": "metric_dimension", "matchMode": "contains"},
    "producer_name": {"label": "生产企业", "meaning": "目录中的生产企业全称（CP_NAME）；不能用 SOURCE_NAME 数据来源替代。", "valueKind": "controlled_text", "identityRole": "producer_dimension", "matchMode": "contains"},
    "producer_short_name": {"label": "生产企业简称", "meaning": "目录中的生产企业简称（CP_SHORT_NAME）；不能与来源或市场品牌混用。", "valueKind": "controlled_text", "identityRole": "producer_dimension", "matchMode": "contains"},
    "source_name": {"label": "数据来源", "meaning": "目录中的数据来源（SOURCE_NAME），例如我的钢铁网、中国海关总署；不是钢厂名称。", "valueKind": "controlled_text", "identityRole": "provenance_dimension", "matchMode": "contains"},
    "market_name": {"label": "市场", "meaning": "目录中的交易/报价市场（MARKET_NAME）；不能与城市或数据来源互换。", "valueKind": "controlled_text", "identityRole": "market_dimension", "matchMode": "contains"},
    "description": {"label": "报价条件说明", "meaning": "目录中的补充说明（DESCRIPTION），如含税、送到价、过磅；不是纯规格字段。", "valueKind": "free_text", "identityRole": "qualification", "matchMode": "contains"},
    "unit": {"label": "单位", "meaning": "Legacy alias for UNIT_NAME; use unit_name in new mappings.", "valueKind": "controlled_text", "identityRole": "legacy_dimension", "matchMode": "contains"},
    "frequency": {"label": "频率", "meaning": "Legacy alias for FREQUENCY_NAME; use frequency_name in new mappings.", "valueKind": "controlled_text", "identityRole": "legacy_dimension", "matchMode": "contains"},
    # Compatibility names for maps created before the canonical contract.
    "region": {"label": "区域", "meaning": "Legacy alias; only valid when explicitly mapped by an older deployment.", "valueKind": "controlled_text", "identityRole": "legacy_dimension", "matchMode": "contains"},
    "brand": {"label": "品牌或钢厂", "meaning": "Legacy alias; never infer it from SOURCE_NAME.", "valueKind": "controlled_text", "identityRole": "legacy_dimension", "matchMode": "contains"},
    "product": {"label": "品名", "meaning": "Legacy alias for a confirmed product column.", "valueKind": "controlled_text", "identityRole": "legacy_dimension", "matchMode": "contains"},
    "specification": {"label": "规格", "meaning": "Legacy alias for a confirmed specification column.", "valueKind": "free_text", "identityRole": "legacy_dimension", "matchMode": "contains"},
}

CANONICAL_QUERY_FIELDS = (
    "indicator_name", "province_name", "city_name", "county_name", "region_name",
    "breed_name", "caliber_name", "metric_name", "frequency_name", "unit_name",
    "producer_name", "producer_short_name", "source_name", "market_name", "description",
)
LEGACY_QUERY_FIELDS = ("indicator_name", "region", "brand", "product", "specification")
QUERY_FIELDS = CANONICAL_QUERY_FIELDS
METADATA_FIELDS = ("unit", "frequency")


class SafeError(Exception):
    """Message may be returned to the model without exposing connection details."""


def main() -> None:
    arguments = parse_arguments()
    config = read_database_config()
    if arguments.action == "inspect-schema":
        emit(inspect_schema(config))
        return
    mapping = read_mapping()
    if arguments.action == "preflight-catalog":
        emit(preflight_catalog(config, mapping, arguments.query))
        return
    if arguments.action == "list-indicators":
        emit(list_indicators(config, mapping, arguments.keyword))
        return
    if arguments.action == "discover-indicators":
        emit(discover_indicators(config, mapping, arguments.filters))
        return
    if arguments.action == "locate-series":
        emit(locate_indicator_series(config, mapping, arguments.filters, arguments.start_date, arguments.end_date))
        return
    if arguments.action == "locate-day":
        emit(locate_indicator_day(config, mapping, arguments.filters, arguments.date))
        return
    if arguments.action == "resolve-and-locate-series":
        emit(resolve_and_locate_indicator_series(config, mapping, arguments.query, arguments.start_date, arguments.end_date))
        return
    if arguments.action == "resolve-and-locate-day":
        emit(resolve_and_locate_indicator_day(config, mapping, arguments.query, arguments.date))
        return
    if arguments.action == "execute-query-plan":
        emit(execute_query_plan(config, mapping, arguments.query_plan))
        return
    if arguments.action == "query-series-by-selection":
        verify_selection_token(config, arguments.indicator_id, arguments.selection_token)
        emit(query_series(config, mapping, arguments.indicator_id, arguments.start_date, arguments.end_date))
        return
    verify_selection_token(config, arguments.indicator_id, arguments.selection_token)
    emit(query_series(config, mapping, arguments.indicator_id, arguments.date, arguments.date, action="query-day"))


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read mapped steel-market data.")
    subcommands = parser.add_subparsers(dest="action", required=True)
    subcommands.add_parser("inspect-schema")
    preflight = subcommands.add_parser("preflight-catalog")
    preflight.add_argument("--query", default="")
    candidates = subcommands.add_parser("list-indicators")
    candidates.add_argument("--keyword", required=True)
    discovery = subcommands.add_parser("discover-indicators")
    discovery.add_argument("--filters-json", required=True)
    locator = subcommands.add_parser("locate-series")
    locator.add_argument("--filters-json", required=True)
    locator.add_argument("--start-date", required=True)
    locator.add_argument("--end-date", required=True)
    day_locator = subcommands.add_parser("locate-day")
    day_locator.add_argument("--filters-json", required=True)
    day_locator.add_argument("--date", required=True)
    resolver = subcommands.add_parser("resolve-and-locate-series")
    resolver.add_argument("--query", required=True)
    resolver.add_argument("--start-date", required=True)
    resolver.add_argument("--end-date", required=True)
    day_resolver = subcommands.add_parser("resolve-and-locate-day")
    day_resolver.add_argument("--query", required=True)
    day_resolver.add_argument("--date", required=True)
    query_plan = subcommands.add_parser("execute-query-plan")
    query_plan.add_argument("--plan-file", required=True)
    series = subcommands.add_parser("query-series-by-selection")
    series.add_argument("--indicator-id", required=True)
    series.add_argument("--selection-token", required=True)
    series.add_argument("--start-date", required=True)
    series.add_argument("--end-date", required=True)
    day = subcommands.add_parser("query-day-by-selection")
    day.add_argument("--indicator-id", required=True)
    day.add_argument("--selection-token", required=True)
    day.add_argument("--date", required=True)
    args = parser.parse_args()
    if args.action == "list-indicators":
        args.keyword = bounded_text(args.keyword, "keyword")
    if args.action == "preflight-catalog":
        args.query = bounded_query_text(args.query, "preflight query")
    if args.action == "discover-indicators":
        args.filters = parse_discovery_filters(args.filters_json)
    if args.action == "locate-series":
        args.filters = parse_discovery_filters(args.filters_json)
        args.start_date = parse_date(args.start_date, "start date")
        args.end_date = parse_date(args.end_date, "end date")
        if args.start_date is None or args.end_date is None:
            raise SafeError("locate-series requires start date and end date")
        if args.start_date > args.end_date:
            raise SafeError("start date must not be after end date")
        if (args.end_date - args.start_date).days > MAX_DAYS:
            raise SafeError(f"date range must not exceed {MAX_DAYS} days")
        if args.start_date == args.end_date:
            raise SafeError("locate-series requires more than one calendar date; use locate-day")
    if args.action == "locate-day":
        args.filters = parse_discovery_filters(args.filters_json)
        args.date = parse_date(args.date, "date")
        if args.date is None:
            raise SafeError("locate-day requires one ISO date")
    if args.action == "resolve-and-locate-series":
        args.query = bounded_query_text(args.query, "request query")
        args.start_date = parse_date(args.start_date, "start date")
        args.end_date = parse_date(args.end_date, "end date")
        if args.start_date is None or args.end_date is None:
            raise SafeError("resolve-and-locate-series requires start date and end date")
        if args.start_date > args.end_date:
            raise SafeError("start date must not be after end date")
        if (args.end_date - args.start_date).days > MAX_DAYS:
            raise SafeError(f"date range must not exceed {MAX_DAYS} days")
        if args.start_date == args.end_date:
            raise SafeError("resolve-and-locate-series requires more than one calendar date; use resolve-and-locate-day")
    if args.action == "resolve-and-locate-day":
        args.query = bounded_query_text(args.query, "request query")
        args.date = parse_date(args.date, "date")
        if args.date is None:
            raise SafeError("resolve-and-locate-day requires one ISO date")
    if args.action == "execute-query-plan":
        args.query_plan = read_query_plan(Path(args.plan_file))
    if args.action == "query-series-by-selection":
        args.indicator_id = bounded_text(args.indicator_id, "indicator ID")
        args.selection_token = bounded_text(args.selection_token, "selection token")
        args.start_date = parse_date(args.start_date, "start date")
        args.end_date = parse_date(args.end_date, "end date")
        if args.start_date is None or args.end_date is None or args.start_date >= args.end_date:
            raise SafeError("query-series-by-selection requires an ordered multi-date range")
        if (args.end_date - args.start_date).days > MAX_DAYS:
            raise SafeError(f"date range must not exceed {MAX_DAYS} days")
    if args.action == "query-day-by-selection":
        args.indicator_id = bounded_text(args.indicator_id, "indicator ID")
        args.selection_token = bounded_text(args.selection_token, "selection token")
        args.date = parse_date(args.date, "date")
        if args.date is None:
            raise SafeError("query-day-by-selection requires one ISO date")
    return args


def read_query_plan(path: Path) -> dict[str, Any]:
    """Read the analysis-owned data-selection plan without interpreting it.

    The database Skill accepts only bounded, typed selectors.  It does not see
    the user's free-form task or decide which indicators a methodology needs.
    """
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        raise SafeError("steel market query plan file is unavailable") from None
    if len(content.encode("utf-8")) > MAX_QUERY_PLAN_BYTES:
        raise SafeError(f"steel market query plan exceeds {MAX_QUERY_PLAN_BYTES} bytes")
    try:
        value = json.loads(content)
    except json.JSONDecodeError:
        raise SafeError("steel market query plan is not valid JSON") from None
    if not isinstance(value, dict) or value.get("schema") != "agentloop.steelMarketQueryPlan/v1":
        raise SafeError("steel market query plan has an unsupported schema")
    method = value.get("method")
    if not isinstance(method, dict):
        raise SafeError("steel market query plan requires an analysis-owned method object")
    method_id = method.get("id")
    method_summary = method.get("summary")
    if not isinstance(method_id, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", method_id):
        raise SafeError("steel market query plan method.id is invalid")
    if not isinstance(method_summary, str) or not method_summary.strip() or len(method_summary) > 500:
        raise SafeError("steel market query plan method.summary is invalid")
    queries = value.get("queries")
    if not isinstance(queries, list) or not queries or len(queries) > MAX_QUERY_PLAN_ITEMS:
        raise SafeError(f"steel market query plan must contain 1 to {MAX_QUERY_PLAN_ITEMS} queries")
    normalized: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, item in enumerate(queries):
        if not isinstance(item, dict):
            raise SafeError(f"steel market query plan queries[{index}] must be an object")
        query_id = item.get("id")
        purpose = item.get("purpose")
        start_date = item.get("startDate")
        end_date = item.get("endDate")
        if not isinstance(query_id, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", query_id):
            raise SafeError(f"steel market query plan queries[{index}].id is invalid")
        if query_id in ids:
            raise SafeError("steel market query plan query ids must be unique")
        ids.add(query_id)
        if not isinstance(purpose, str) or not purpose.strip() or len(purpose) > 300:
            raise SafeError(f"steel market query plan queries[{index}].purpose is invalid")
        if not isinstance(start_date, str) or not isinstance(end_date, str):
            raise SafeError(f"steel market query plan queries[{index}] requires startDate and endDate")
        start = parse_date(start_date, "query plan startDate")
        end = parse_date(end_date, "query plan endDate")
        if start is None or end is None or start > end or (end - start).days > MAX_DAYS:
            raise SafeError(f"steel market query plan queries[{index}] has an invalid date range")
        selector = item.get("selector")
        if not isinstance(selector, dict):
            raise SafeError(f"steel market query plan queries[{index}].selector must be an object")
        indicator_id = selector.get("indicatorId")
        selection_token_value = selector.get("selectionToken")
        filters = selector.get("filters")
        if (indicator_id is None) == (filters is None):
            raise SafeError(f"steel market query plan queries[{index}].selector requires exactly one of indicatorId or filters")
        if indicator_id is not None:
            if not isinstance(indicator_id, str) or not isinstance(selection_token_value, str):
                raise SafeError(f"steel market query plan queries[{index}].selector requires catalog-issued indicatorId and selectionToken")
            normalized_selector: dict[str, Any] = {
                "indicatorId": bounded_text(indicator_id, "query plan indicatorId"),
                "selectionToken": bounded_text(selection_token_value, "query plan selectionToken"),
            }
        else:
            normalized_selector = {"filters": normalize_discovery_filters(filters)}
        normalized.append({
            "id": query_id,
            "purpose": purpose.strip(),
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "selector": normalized_selector,
        })
    return {
        "schema": "agentloop.steelMarketQueryPlan/v1",
        "method": {"id": method_id, "summary": method_summary.strip()},
        "queries": normalized,
    }


def bounded_text(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > MAX_KEYWORD_LENGTH:
        raise SafeError(f"{label} must contain 1 to {MAX_KEYWORD_LENGTH} characters")
    return normalized


def selection_token(config: dict[str, Any], indicator_id: str) -> str:
    """Issue an opaque proof that this Skill read this exact catalog ID.

    The model sees the token but cannot manufacture one for an arbitrary ID:
    its key is the configured database password, which is never emitted.  The
    token deliberately binds only the stable catalog identity; date selection
    is a separate, auditable acquisition concern.
    """
    secret = config.get("password")
    if not isinstance(secret, str) or not secret:
        raise SafeError("Steel market selection proof is unavailable")
    digest = hmac.new(secret.encode("utf-8"), indicator_id.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"v1.{digest}"


def verify_selection_token(config: dict[str, Any], indicator_id: str, token: str) -> None:
    if not hmac.compare_digest(token, selection_token(config, indicator_id)):
        raise SafeError("indicator ID was not selected by a catalog receipt; discover one exact candidate before querying observations")


def selection_handoff(config: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any] | None:
    indicator_id = candidate.get("indicator_id")
    if not isinstance(indicator_id, str) or not indicator_id:
        return None
    return {
        "schema": "agentloop.steelIndicatorSelection/v1",
        "indicatorId": indicator_id,
        "indicatorName": candidate.get("indicator_name"),
        "selectionToken": selection_token(config, indicator_id),
        "rule": "Use this exact indicatorId and selectionToken only with query-day-by-selection or query-series-by-selection. Do not invent, rename, or substitute an INDEX_CODE.",
    }


def bounded_query_text(value: str, label: str) -> str:
    normalized = value.strip()
    if len(normalized) > 500:
        raise SafeError(f"{label} must contain at most 500 characters")
    return normalized


def parse_date(value: str, label: str) -> dt.date | None:
    normalized = value.strip()
    if not normalized:
        return None
    try:
        return dt.date.fromisoformat(normalized)
    except ValueError:
        raise SafeError(f"{label} must use YYYY-MM-DD") from None


def read_database_config() -> dict[str, Any]:
    env_file = Path(os.environ.get("STEEL_MARKET_DB_ENV_FILE", SKILL_ROOT / ".env"))
    try:
        values = parse_dotenv(env_file)
    except OSError:
        raise SafeError("Steel market database configuration is unavailable") from None
    required = ("STEEL_MARKET_DB_HOST", "STEEL_MARKET_DB_PORT", "STEEL_MARKET_DB_NAME", "STEEL_MARKET_DB_USER", "STEEL_MARKET_DB_PASSWORD")
    if any(not values.get(key, "").strip() for key in required):
        raise SafeError("Steel market database configuration is incomplete")
    try:
        port = int(values["STEEL_MARKET_DB_PORT"])
    except ValueError:
        raise SafeError("Steel market database configuration is invalid") from None
    if port < 1 or port > 65535 or not IDENTIFIER.fullmatch(values["STEEL_MARKET_DB_NAME"]):
        raise SafeError("Steel market database configuration is invalid")
    return {
        "host": values["STEEL_MARKET_DB_HOST"].strip(),
        "port": port,
        "database": values["STEEL_MARKET_DB_NAME"].strip(),
        "user": values["STEEL_MARKET_DB_USER"].strip(),
        "password": values["STEEL_MARKET_DB_PASSWORD"],
    }


def parse_dotenv(path: Path) -> dict[str, str]:
    accepted = {"STEEL_MARKET_DB_HOST", "STEEL_MARKET_DB_PORT", "STEEL_MARKET_DB_NAME", "STEEL_MARKET_DB_USER", "STEEL_MARKET_DB_PASSWORD"}
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in accepted:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values


def read_mapping() -> dict[str, Any]:
    try:
        value = json.loads((SKILL_ROOT / "schema-map.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SafeError("Steel market field mapping is not configured; run inspect-schema and configure schema-map.json") from None
    except (OSError, json.JSONDecodeError):
        raise SafeError("Steel market field mapping is invalid") from None
    if not isinstance(value, dict) or value.get("schema") != "agentloop.mysqlSteelDataMap/v1":
        raise SafeError("Steel market field mapping is invalid")
    keys = ("indicatorTable", "valueTable", "indicatorIdColumn", "indicatorNameColumn", "valueIndicatorIdColumn", "observationDateColumn", "valueColumn")
    result: dict[str, Any] = {}
    for key in keys:
        item = value.get(key)
        if not isinstance(item, str) or not IDENTIFIER.fullmatch(item):
            raise SafeError("Steel market field mapping is invalid")
        result[key] = item
    optional = value.get("optionalColumns", {})
    if not isinstance(optional, dict):
        raise SafeError("Steel market field mapping is invalid")
    result["optionalColumns"] = {}
    for key in ("unit", "region", "category"):
        item = optional.get(key)
        if item is not None:
            # A plain string remains shorthand for a metadata-table column.
            if isinstance(item, str):
                item = {"table": "indicator", "column": item}
            if not isinstance(item, dict) or item.get("table") not in ("indicator", "value"):
                raise SafeError("Steel market field mapping is invalid")
            column = item.get("column")
            if not isinstance(column, str) or not IDENTIFIER.fullmatch(column):
                raise SafeError("Steel market field mapping is invalid")
            result["optionalColumns"][key] = {"table": item["table"], "column": column}
    semantic = value.get("semanticColumns", {})
    if not isinstance(semantic, dict):
        raise SafeError("Steel market field mapping is invalid")
    allowed_semantic_fields = {*METADATA_FIELDS, *SEMANTIC_FIELD_DEFINITIONS.keys()}
    result["semanticColumns"] = {}
    for key, item in semantic.items():
        if key not in allowed_semantic_fields or not isinstance(item, str) or not IDENTIFIER.fullmatch(item):
            raise SafeError("Steel market field mapping is invalid")
        result["semanticColumns"][key] = item
    # Existing deployments may have unit/region in optionalColumns. Reuse only
    # confirmed mappings that belong to the bounded query contract.
    for key in ("unit", "region"):
        item = result["optionalColumns"].get(key)
        if item is not None and item["table"] == "indicator" and key not in result["semanticColumns"]:
            result["semanticColumns"][key] = item["column"]
    return result


def connection(config: dict[str, Any]):
    try:
        import pymysql  # type: ignore[import-not-found]
    except ImportError:
        raise SafeError("Steel market database driver is unavailable; install the Skill requirements on the Runtime Host") from None
    try:
        return pymysql.connect(
            host=config["host"], port=config["port"], user=config["user"], password=config["password"],
            database=config["database"], charset="utf8mb4", autocommit=True,
            cursorclass=pymysql.cursors.DictCursor, connect_timeout=10, read_timeout=20, write_timeout=20,
        )
    except Exception:
        raise SafeError("Steel market database connection failed") from None


def inspect_schema(config: dict[str, Any]) -> dict[str, Any]:
    sql = """
        SELECT table_name, column_name, data_type, is_nullable, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = %s
        ORDER BY table_name, ordinal_position
    """
    with connection(config) as database, database.cursor() as cursor:
        cursor.execute(sql, (config["database"],))
        rows = cursor.fetchall()
    tables: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        tables.setdefault(row["table_name"], []).append({
            "name": row["column_name"], "type": row["data_type"], "nullable": row["is_nullable"] == "YES",
        })
    return receipt_result(
        action="inspect-schema", source_refs=[{"uri": f"mysql://{config['host']}/{config['database']}", "title": "MySQL schema metadata"}],
        payload={"database": config["database"], "tables": [{"name": name, "columns": columns} for name, columns in tables.items()]},
        caveats=["Schema inspection contains metadata only. A database owner must confirm the two-table mapping before value queries are enabled."],
    )


def list_indicators(config: dict[str, Any], mapping: dict[str, Any], keyword: str) -> dict[str, Any]:
    select_dimensions = catalog_dimension_select(mapping, "i")
    sql = f"""
        SELECT DISTINCT i.`{mapping['indicatorIdColumn']}` AS indicator_id,
               i.`{mapping['indicatorNameColumn']}` AS indicator_name{select_dimensions}
        FROM `{mapping['indicatorTable']}` i
        WHERE i.`{mapping['indicatorNameColumn']}` LIKE CONCAT('%%', %s, '%%')
        ORDER BY i.`{mapping['indicatorNameColumn']}` ASC
        LIMIT {MAX_CANDIDATES}
    """
    with connection(config) as database, database.cursor() as cursor:
        cursor.execute(sql, (keyword,))
        rows = normalize_rows(cursor.fetchall())
    payload: dict[str, Any] = {"keyword": keyword, "candidates": rows, "truncated": len(rows) == MAX_CANDIDATES}
    if len(rows) == 1 and len(rows) < MAX_CANDIDATES:
        handoff = selection_handoff(config, rows[0])
        if handoff is not None:
            payload["selection"] = handoff
    return receipt_result(
        action="list-indicators", source_refs=table_refs(config, mapping),
        payload=payload,
        caveats=["Candidates with different units, regions, or categories must be confirmed before comparing values."],
    )


def parse_discovery_filters(value: str) -> dict[str, Any]:
    if len(value) > 2_000:
        raise SafeError("discovery filters must contain at most 2000 characters")
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        raise SafeError("discovery filters must be a JSON object") from None
    return normalize_discovery_filters(decoded)


def normalize_discovery_filters(decoded: Any) -> dict[str, Any]:
    """Validate mapped catalog selectors shared by CLI and query-plan input."""
    if not isinstance(decoded, dict):
        raise SafeError("discovery filters must be a JSON object")
    # Accept legacy slots only when an older schema-map explicitly exposes
    # them; the deployed canonical map uses the *_name fields above.
    allowed = {*QUERY_FIELDS, *LEGACY_QUERY_FIELDS}
    if not decoded or any(key not in allowed for key in decoded):
        raise SafeError("discovery filters contain an unsupported field")
    filters: dict[str, Any] = {}
    for key, raw in decoded.items():
        if not isinstance(raw, str):
            raise SafeError(f"discovery filter {key} must be a string")
        filters[key] = bounded_text(raw, f"discovery filter {key}")
    return filters


def catalog_columns(mapping: dict[str, Any]) -> dict[str, str]:
    return {
        "indicator_name": mapping["indicatorNameColumn"],
        **{field: mapping["semanticColumns"][field] for field in mapping["semanticColumns"]},
    }


def semantic_definition(field: str, *, distinct_count: int | None = None, examples: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Attach a value-domain contract without treating sampled values as exhaustive."""
    definition = dict(SEMANTIC_FIELD_DEFINITIONS[field])
    controlled = definition["valueKind"] == "controlled_text"
    domain: dict[str, Any] = {
        "kind": "catalog_enumeration" if controlled else "unstructured_catalog_text",
        "source": "distinct non-empty values in the configured indicator directory",
        "canonicalization": "trim surrounding whitespace; preserve the stored value for display and confirmation",
        "isExhaustive": False,
    }
    if distinct_count is not None:
        domain["distinctCount"] = distinct_count
    if examples is not None:
        domain["sampleValues"] = examples
        domain["sampleLimit"] = MAX_PROFILE_EXAMPLES
    definition["valueDomain"] = domain
    return definition


def catalog_dimension_select(mapping: dict[str, Any], alias: str) -> str:
    return "".join(
        f", {alias}.`{column}` AS {field}"
        for field, column in catalog_columns(mapping).items()
        if field != "indicator_name"
    )


def preflight_catalog(config: dict[str, Any], mapping: dict[str, Any], query: str = "") -> dict[str, Any]:
    columns = catalog_columns(mapping)
    profiles: list[dict[str, Any]] = []
    with connection(config) as database, database.cursor() as cursor:
        cursor.execute(f"SELECT COUNT(*) AS indicator_count FROM `{mapping['indicatorTable']}`")
        count_row = cursor.fetchall()[0]
        indicator_count = int(count_row["indicator_count"])
        for field, column in columns.items():
            cursor.execute(f"""
                SELECT COUNT(*) AS total_count,
                       SUM(CASE WHEN NULLIF(TRIM(`{column}`), '') IS NOT NULL THEN 1 ELSE 0 END) AS populated_count,
                       COUNT(DISTINCT NULLIF(TRIM(`{column}`), '')) AS distinct_count
                FROM `{mapping['indicatorTable']}`
            """)
            stats = cursor.fetchall()[0]
            cursor.execute(f"""
                SELECT TRIM(`{column}`) AS value, COUNT(*) AS occurrences
                FROM `{mapping['indicatorTable']}`
                WHERE NULLIF(TRIM(`{column}`), '') IS NOT NULL
                GROUP BY TRIM(`{column}`)
                ORDER BY occurrences DESC, value ASC
                LIMIT {MAX_PROFILE_EXAMPLES}
            """)
            examples = normalize_rows(cursor.fetchall())
            populated_count = int(stats.get("populated_count") or 0)
            distinct_count = int(stats.get("distinct_count") or 0)
            profiles.append({
                "field": field,
                "column": column,
                "semanticDefinition": semantic_definition(field, distinct_count=distinct_count, examples=examples),
                "populatedCount": populated_count,
                "distinctCount": distinct_count,
                "examples": examples,
            })
    payload: dict[str, Any] = {
        "indicatorCount": indicator_count,
        "dataContract": catalog_data_contract(mapping),
        "fields": profiles,
        "exampleLimitPerField": MAX_PROFILE_EXAMPLES,
        "discoveryContract": {
            "action": "discover-indicators",
            "filterFields": list(QUERY_FIELDS),
            "timeRange": ["start-date", "end-date"],
            "rule": "Only mapped catalog fields may be used, with each condition applied to its own physical column and ANDed. Never substitute city for region, source for producer, or description for caliber.",
        },
    }
    if query:
        payload["queryUnderstanding"] = catalog_query_understanding(config, mapping, query, indicator_count)
    return receipt_result(
        action="preflight-catalog",
        source_refs=[table_refs(config, mapping)[0]],
        payload=payload,
        caveats=[
            "Preflight examples describe only the configured indicator directory, not all market data.",
            "Examples are discovery aids. Candidate INDEX_CODE and dimensions still require confirmation before querying observations.",
        ],
    )


def catalog_query_understanding(
    config: dict[str, Any], mapping: dict[str, Any], query: str, indicator_count: int,
) -> dict[str, Any]:
    """Match a request against confirmed catalog values without guessing columns.

    This is deliberately a bounded catalog lookup, not an LLM or a synonym
    table. A suggested filter is emitted only when its stored value occurs
    verbatim (after presentation punctuation/whitespace normalization) in the
    request. Indicator-name segments are kept separate because a grade often
    appears in INDEX_NAME while its dedicated catalog column is nullable or
    carries a more detailed value.
    """
    columns = catalog_columns(mapping)
    select_dimensions = catalog_dimension_select(mapping, "i")
    sql = f"""
        SELECT DISTINCT i.`{mapping['indicatorIdColumn']}` AS indicator_id,
               i.`{mapping['indicatorNameColumn']}` AS indicator_name{select_dimensions}
        FROM `{mapping['indicatorTable']}` i
        ORDER BY i.`{mapping['indicatorNameColumn']}` ASC
        LIMIT {MAX_QUERY_UNDERSTANDING_ROWS}
    """
    with connection(config) as database, database.cursor() as cursor:
        cursor.execute(sql)
        rows = normalize_rows(cursor.fetchall())
    return query_understanding_from_catalog_rows(query, rows, columns, indicator_count)


def query_understanding_from_catalog_rows(
    query: str, rows: list[dict[str, Any]], columns: dict[str, str], indicator_count: int,
) -> dict[str, Any]:
    """Build auditable field suggestions from bounded, already-mapped rows."""
    normalized_query = normalize_catalog_text(query)
    values_by_field: dict[str, set[str]] = {field: set() for field in columns}
    indicator_terms: set[str] = set()
    for row in rows:
        for field in columns:
            value = row.get(field)
            if not isinstance(value, str) or not value.strip():
                continue
            normalized_value = normalize_catalog_text(value)
            if len(normalized_value) >= 2 and normalized_value in normalized_query:
                values_by_field[field].add(value.strip())
        indicator_name = row.get("indicator_name")
        if isinstance(indicator_name, str):
            for term in indicator_name_terms(indicator_name):
                if len(normalize_catalog_text(term)) >= 2 and normalize_catalog_text(term) in normalized_query:
                    indicator_terms.add(term)

    field_matches = [
        {
            "field": field,
            "column": columns[field],
            "matchKind": "request_contains_catalog_value",
            "values": sorted(values)[:MAX_QUERY_UNDERSTANDING_MATCHES],
            "truncated": len(values) > MAX_QUERY_UNDERSTANDING_MATCHES,
        }
        for field, values in values_by_field.items()
        if values
    ]
    recommended_filters = {
        item["field"]: item["values"][0]
        for item in field_matches
        if item["field"] != "indicator_name"
        and len(item["values"]) == 1
        and item["truncated"] is False
    }
    return {
        "schema": "agentloop.steelMarketQueryUnderstanding/v1",
        "query": query,
        "method": "bounded_exact_catalog_match",
        "catalogRowsScanned": len(rows),
        "catalogScanTruncated": indicator_count > len(rows),
        "fieldMatches": field_matches,
        "recommendedFilters": recommended_filters,
        "indicatorNameTerms": sorted(indicator_terms)[:MAX_QUERY_UNDERSTANDING_MATCHES],
        "selectionPolicy": [
            "Recommended filters are only exact matches to mapped catalog values; they are not inferred synonyms.",
            "Keep indicatorNameTerms separate from product/grade columns, then confirm the complete returned indicator_name.",
            "If a later AND query returns zero candidates, remove only the zero-matching condition or retry with one returned indicatorNameTerm; do not conclude that the market indicator is absent.",
        ],
    }


def normalize_catalog_text(value: str) -> str:
    return re.sub(r"[\s:：,，、;；()（）\[\]【】{}<>《》/\\\\_-]+", "", value).casefold()


def indicator_name_terms(value: str) -> list[str]:
    return [term.strip() for term in re.split(r"[\s:：,，、;；()（）\[\]【】{}<>《》/\\\\_-]+", value) if term.strip()]


def catalog_data_contract(mapping: dict[str, Any]) -> dict[str, Any]:
    """Return the model-visible contract for this confirmed two-table map."""
    semantic_fields = [
        {"field": field, "column": column, **semantic_definition(field)}
        for field, column in catalog_columns(mapping).items()
    ]
    return {
        "schema": "agentloop.steelMarketCatalogContract/v1",
        "indicatorCatalog": {
            "table": mapping["indicatorTable"],
            "grain": "one row is one defined market indicator",
            "identity": {"field": "indicator_id", "column": mapping["indicatorIdColumn"], "meaning": "Stable business identifier for one indicator definition; select one exact value before reading observations."},
            "displayName": {"field": "indicator_name", "column": mapping["indicatorNameColumn"]},
            "semanticFields": semantic_fields,
        },
        "observations": {
            "table": mapping["valueTable"],
            "grain": "one raw observation for one indicator at one observation date",
            "indicatorReference": {"column": mapping["valueIndicatorIdColumn"], "references": mapping["indicatorIdColumn"]},
            "date": {"column": mapping["observationDateColumn"], "meaning": "Observation date; text values must be valid ISO dates before time-series calculation."},
            "value": {"column": mapping["valueColumn"], "meaning": "Raw observed value only; its business meaning and unit come from the selected indicator definition."},
        },
        "relationship": {
            "cardinality": "one_indicator_definition_to_many_observations",
            "join": f"{mapping['indicatorTable']}.{mapping['indicatorIdColumn']} = {mapping['valueTable']}.{mapping['valueIndicatorIdColumn']}",
            "rule": "Never join or compare observations by similarly named fields. Query observations only after selecting one exact indicator_id, then preserve the directory dimensions with every result.",
        },
        "selectionRule": "A candidate is not an indicator selection. Confirm the exact indicator_id together with every requested mapped semantic field before querying the series; never treat a similarly named field as a substitute.",
    }


def discover_indicators(config: dict[str, Any], mapping: dict[str, Any], filters: dict[str, Any]) -> dict[str, Any]:
    columns = catalog_columns(mapping)
    unsupported = set(filters).difference(columns.keys())
    if unsupported:
        raise SafeError("discovery filter is unavailable in the configured catalog mapping")
    select_dimensions = catalog_dimension_select(mapping, "i")
    where: list[str] = []
    parameters: list[Any] = []
    for field, value in filters.items():
        where.append(f"i.`{columns[field]}` LIKE CONCAT('%%', %s, '%%')")
        parameters.append(value)
    sql = f"""
        SELECT DISTINCT i.`{mapping['indicatorIdColumn']}` AS indicator_id,
               i.`{mapping['indicatorNameColumn']}` AS indicator_name{select_dimensions}
        FROM `{mapping['indicatorTable']}` i
        WHERE {' AND '.join(where)}
        ORDER BY i.`{mapping['indicatorNameColumn']}` ASC
        LIMIT {MAX_CANDIDATES}
    """
    with connection(config) as database, database.cursor() as cursor:
        cursor.execute(sql, tuple(parameters))
        rows = normalize_rows(cursor.fetchall())
    payload: dict[str, Any] = {"filters": filters, "candidates": rows, "truncated": len(rows) == MAX_CANDIDATES}
    if len(rows) == 1 and len(rows) < MAX_CANDIDATES:
        handoff = selection_handoff(config, rows[0])
        if handoff is not None:
            payload["selection"] = handoff
    return receipt_result(
        action="discover-indicators", source_refs=table_refs(config, mapping),
        payload=payload,
        caveats=[
            "Candidates are located using separately declared catalog fields; a match is not yet confirmation of the intended INDEX_CODE.",
            "Confirm indicator_name, administrative/product dimensions, metric, frequency, unit, producer, source and market before querying observations by ID. Do not invent a value absent from the catalog.",
        ],
    )


def locate_indicator_series(
    config: dict[str, Any], mapping: dict[str, Any], filters: dict[str, Any], start: dt.date, end: dt.date,
) -> dict[str, Any]:
    """Atomically locate one indicator and retrieve its requested raw series.

    This keeps the source-provider boundary authoritative for the transition
    from a uniquely identified catalog row to its INDEX_CODE-bound
    observations. It never chooses among multiple candidates.
    """
    discovery = discover_indicators(config, mapping, filters)
    candidates = discovery.get("candidates")
    if not isinstance(candidates, list) or len(candidates) != 1 or discovery.get("truncated") is True:
        return discovery
    candidate = candidates[0] if isinstance(candidates[0], dict) else None
    indicator_id = candidate.get("indicator_id") if candidate is not None else None
    if not isinstance(indicator_id, str) or not indicator_id:
        return discovery
    series = query_series(config, mapping, indicator_id, start, end)
    return attach_located_series_metadata(series, filters, candidates, candidate, "locate-series")


def locate_indicator_day(
    config: dict[str, Any], mapping: dict[str, Any], filters: dict[str, Any], date: dt.date,
) -> dict[str, Any]:
    """Locate one exact indicator and return that date's raw observation set.

    A day can contain multiple raw rows.  This source provider therefore
    returns the set unchanged and never promotes one row to a daily price.
    """
    discovery = discover_indicators(config, mapping, filters)
    candidates = discovery.get("candidates")
    if not isinstance(candidates, list) or len(candidates) != 1 or discovery.get("truncated") is True:
        return discovery
    candidate = candidates[0] if isinstance(candidates[0], dict) else None
    indicator_id = candidate.get("indicator_id") if candidate is not None else None
    if not isinstance(indicator_id, str) or not indicator_id:
        return discovery
    day = query_series(config, mapping, indicator_id, date, date, action="query-day")
    return attach_located_series_metadata(day, filters, candidates, candidate, "locate-day")


def attach_located_series_metadata(
    series: dict[str, Any], filters: dict[str, Any], candidates: list[Any], candidate: dict[str, Any], acquisition_action: str,
) -> dict[str, Any]:
    return {
        **series,
        # A locate is an acquisition shortcut, not a substitution of a model
        # supplied identifier.  Its result stays a raw fact handoff.
        "acquisitionAction": acquisition_action,
        "filters": filters,
        "candidates": candidates,
        "selectedIndicator": candidate,
        "analysisInputContract": {
            "schema": "agentloop.steelMarketData/v1",
            "action": series.get("action"),
            "seriesPath": "$.series",
            "consumer": "steel-market-analysis/analyze-series" if series.get("action") == "query-series" else "direct raw-day delivery",
            "instruction": "Pass this complete persisted JSON artifact, not a copied summary or its stdout text, to steel-market-analysis analyze-series --input-file." if series.get("action") == "query-series" else "This is one date's raw observation set. Preserve every row and report same-day multiple values as ambiguity; do not choose a representative price.",
        },
    }


def resolve_and_locate_indicator_series(
    config: dict[str, Any], mapping: dict[str, Any], query: str, start: dt.date, end: dt.date,
) -> dict[str, Any]:
    """Resolve one bounded request and acquire its series without a model round trip.

    This keeps catalog interpretation auditable: only the exact mapped values
    returned by preflight are used, and observations are read only after one
    exact candidate is found.  It is intentionally for a single requested
    series, not for comparative or open-ended research.
    """
    preflight = preflight_catalog(config, mapping, query)
    understanding = preflight.get("queryUnderstanding")
    if not isinstance(understanding, dict):
        return preflight
    recommended = understanding.get("recommendedFilters")
    filters = dict(recommended) if isinstance(recommended, dict) else {}
    if not filters:
        return {
            **preflight,
            "resolutionAction": "resolve-and-locate-series",
            "resolutionStatus": "no_catalog_backed_filters",
        }

    result = locate_indicator_series(config, mapping, filters, start, end)
    if result.get("action") != "query-series":
        result = {
            **result,
            "resolutionAction": "resolve-and-locate-series",
            "queryUnderstanding": understanding,
        }
    else:
        result = {**result, "acquisitionAction": "resolve-and-locate-series"}
    receipt = preflight.get("evidenceReceipt")
    receipt_id = receipt.get("receiptId") if isinstance(receipt, dict) else None
    result["catalogPreflight"] = {
        "receiptId": receipt_id if isinstance(receipt_id, str) else None,
        "queryUnderstanding": understanding,
        "dataContract": preflight.get("dataContract"),
        "evidenceReceipt": receipt,
    }
    # A composite acquisition must preserve the facts established by its
    # successful preflight, not merely an ID with no resolvable receipt body.
    acquired_receipt = result.get("evidenceReceipt")
    if isinstance(receipt, dict) and isinstance(acquired_receipt, dict):
        merged = dict(acquired_receipt)
        merged["facts"] = [*receipt.get("facts", []), *acquired_receipt.get("facts", [])]
        merged["sourceRefs"] = [*receipt.get("sourceRefs", []), *acquired_receipt.get("sourceRefs", [])]
        merged["caveats"] = list(dict.fromkeys([*receipt.get("caveats", []), *acquired_receipt.get("caveats", [])]))
        merged["evidenceKinds"] = {
            state: list(dict.fromkeys([
                *receipt.get("evidenceKinds", {}).get(state, []),
                *acquired_receipt.get("evidenceKinds", {}).get(state, []),
            ]))
            for state in ("satisfied", "caveated", "failed")
        }
        merged["componentReceiptIds"] = [receipt_id, acquired_receipt.get("receiptId")]
        merged["receiptId"] = hashlib.sha256(json.dumps(
            merged["componentReceiptIds"], ensure_ascii=False, sort_keys=True,
        ).encode("utf-8")).hexdigest()[:32]
        result["evidenceReceipt"] = merged
    return result


def resolve_and_locate_indicator_day(
    config: dict[str, Any], mapping: dict[str, Any], query: str, date: dt.date,
) -> dict[str, Any]:
    """Resolve catalog-backed fields and acquire exactly one day's raw rows."""
    preflight = preflight_catalog(config, mapping, query)
    understanding = preflight.get("queryUnderstanding")
    filters = understanding.get("recommendedFilters") if isinstance(understanding, dict) else None
    if not isinstance(filters, dict) or not filters:
        return {**preflight, "resolutionAction": "resolve-and-locate-day", "resolutionStatus": "no_catalog_backed_filters"}
    result = locate_indicator_day(config, mapping, filters, date)
    if result.get("action") != "query-day":
        result = {**result, "resolutionAction": "resolve-and-locate-day", "queryUnderstanding": understanding}
    else:
        result = {**result, "acquisitionAction": "resolve-and-locate-day"}
    result["catalogPreflight"] = {
        "receiptId": preflight.get("evidenceReceipt", {}).get("receiptId"),
        "queryUnderstanding": understanding,
        "dataContract": preflight.get("dataContract"),
        "evidenceReceipt": preflight.get("evidenceReceipt"),
    }
    preflight_receipt = preflight.get("evidenceReceipt")
    acquired_receipt = result.get("evidenceReceipt")
    if isinstance(preflight_receipt, dict) and isinstance(acquired_receipt, dict):
        merged = dict(acquired_receipt)
        merged["facts"] = [*preflight_receipt.get("facts", []), *acquired_receipt.get("facts", [])]
        merged["sourceRefs"] = [*preflight_receipt.get("sourceRefs", []), *acquired_receipt.get("sourceRefs", [])]
        merged["caveats"] = list(dict.fromkeys([*preflight_receipt.get("caveats", []), *acquired_receipt.get("caveats", [])]))
        merged["evidenceKinds"] = {
            state: list(dict.fromkeys([
                *preflight_receipt.get("evidenceKinds", {}).get(state, []),
                *acquired_receipt.get("evidenceKinds", {}).get(state, []),
            ]))
            for state in ("satisfied", "caveated", "failed")
        }
        component_ids = [preflight_receipt.get("receiptId"), acquired_receipt.get("receiptId")]
        merged["componentReceiptIds"] = component_ids
        merged["receiptId"] = hashlib.sha256(json.dumps(component_ids, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:32]
        result["evidenceReceipt"] = merged
    return result


def execute_query_plan(config: dict[str, Any], mapping: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    """Execute an analysis-owned, bounded selection plan as raw data batches.

    Each item either names an already confirmed INDEX_CODE or asks this Skill to
    prove one catalog candidate is unique before its observations are read. The
    plan's methodology and its purposes are preserved for the owning analysis
    Skill; this source provider never promotes them into a market conclusion.
    """
    batches: list[dict[str, Any]] = []
    for item in plan["queries"]:
        selector = item["selector"]
        start = dt.date.fromisoformat(item["startDate"])
        end = dt.date.fromisoformat(item["endDate"])
        is_day = start == end
        if "indicatorId" in selector:
            verify_selection_token(config, selector["indicatorId"], selector["selectionToken"])
            result = query_series(
                config, mapping, selector["indicatorId"],
                start, end, action="query-day" if is_day else "query-series",
            )
            acquisition = "exact_indicator_day" if is_day else "exact_indicator_series"
        else:
            result = (
                locate_indicator_day(config, mapping, selector["filters"], start)
                if is_day else locate_indicator_series(config, mapping, selector["filters"], start, end)
            )
            acquisition = "unique_catalog_day_location" if is_day else "unique_catalog_series_location"
        batches.append({
            "planQuery": {**item, "acquisition": acquisition},
            "result": result,
        })
    return query_plan_result(plan, batches)


def query_plan_result(plan: dict[str, Any], batches: list[dict[str, Any]]) -> dict[str, Any]:
    query_results = [batch["result"] for batch in batches]
    source_refs = [
        ref for result in query_results
        for ref in result.get("evidenceReceipt", {}).get("sourceRefs", [])
        if isinstance(ref, dict)
    ]
    component_receipt_ids = [
        result.get("evidenceReceipt", {}).get("receiptId") for result in query_results
        if isinstance(result.get("evidenceReceipt", {}).get("receiptId"), str)
    ]
    complete = [result for result in query_results if result.get("action") in ("query-series", "query-day")]
    complete_series = [result for result in complete if result.get("action") == "query-series"]
    complete_days = [result for result in complete if result.get("action") == "query-day"]
    raw_row_count = sum(len(result.get("series", [])) for result in complete if isinstance(result.get("series"), list))
    unresolved = [batch["planQuery"]["id"] for batch in batches if batch["result"].get("action") != "query-series"]
    caveats = [
        "Each batch is raw database evidence only. The owning steel-market-analysis Skill must check method prerequisites and run analyze-series before reporting numerical conclusions.",
        *([f"Query-plan items without an exact raw series: {', '.join(unresolved)}."] if unresolved else []),
    ]
    receipt_seed = json.dumps({"plan": plan, "componentReceiptIds": component_receipt_ids}, ensure_ascii=False, sort_keys=True)
    satisfied = ["source_summary", "record_counts", "structured_extraction_artifact"] if complete else ["source_summary", "record_counts"]
    return {
        "schema": "agentloop.steelMarketData/v1",
        "action": "execute-query-plan",
        "queryPlan": plan,
        "batches": batches,
        "assessmentProjection": {
            "action": "execute-query-plan",
            "plannedQueryCount": len(batches),
            "exactSeriesBatchCount": len(complete_series),
            "exactDayBatchCount": len(complete_days),
            "exactRawBatchCount": len(complete),
            "rawRowCount": raw_row_count,
            "unresolvedQueryIds": unresolved,
            "caveats": caveats,
        },
        "evidenceReceipt": {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "sourceType": "mysql_database",
            "receiptId": hashlib.sha256(receipt_seed.encode("utf-8")).hexdigest()[:32],
            "sourceRefs": source_refs,
            "componentReceiptIds": component_receipt_ids,
            "facts": [{
                "kind": "structured_extraction_artifact",
                "toolName": "mysql_steel_data.py",
                "textPreview": "The analysis-owned query plan produced independently retained raw-series batches.",
                "fields": [
                    {"name": "queryPlanSchema", "value": plan["schema"]},
                    {"name": "plannedQueryCount", "value": str(len(batches))},
                    {"name": "exactSeriesBatchCount", "value": str(len(complete))},
                    {"name": "rawRowCount", "value": str(raw_row_count)},
                ],
            }],
            "workflowProgress": {
                "schema": "agentloop.evidenceWorkflowProgress/v1",
                "completedRequirementIds": ["planned_raw_series_acquisition"] if not unresolved else [],
                "required": ([] if not unresolved else [{
                    "id": "unresolved_query_plan_items",
                    "instruction": "Inspect the returned catalog evidence for the unresolved plan items; refine only the plan's mapped selectors or request a decision when candidates remain ambiguous.",
                    "requiredEvidenceKinds": [],
                }]),
            },
            "caveats": caveats,
            "evidenceKinds": {"satisfied": satisfied, "caveated": ["explicit_caveats"], "failed": []},
        },
    }


def query_series(
    config: dict[str, Any], mapping: dict[str, Any], indicator_id: str,
    start: dt.date, end: dt.date, *, action: str = "query-series",
) -> dict[str, Any]:
    dimensions = catalog_dimension_select(mapping, "i")
    where = [f"i.`{mapping['indicatorIdColumn']}` = %s"]
    parameters: list[Any] = [indicator_id]
    where.append(f"v.`{mapping['observationDateColumn']}` >= %s")
    parameters.append(start.isoformat())
    where.append(f"v.`{mapping['observationDateColumn']}` <= %s")
    parameters.append(end.isoformat())
    sql = f"""
        SELECT i.`{mapping['indicatorIdColumn']}` AS indicator_id,
               i.`{mapping['indicatorNameColumn']}` AS indicator_name{dimensions},
               v.`{mapping['observationDateColumn']}` AS observation_date,
               v.`{mapping['valueColumn']}` AS value
        FROM `{mapping['indicatorTable']}` i
        INNER JOIN `{mapping['valueTable']}` v
          ON v.`{mapping['valueIndicatorIdColumn']}` = i.`{mapping['indicatorIdColumn']}`
        WHERE {' AND '.join(where)}
        ORDER BY indicator_name ASC, observation_date DESC
        LIMIT {MAX_SERIES_ROWS}
    """
    with connection(config) as database, database.cursor() as cursor:
        cursor.execute(sql, tuple(parameters))
        rows = enrich_series_rows(normalize_rows(cursor.fetchall()))
    distinct = {
        tuple(row.get(field) for field in ("indicator_id", "indicator_name", "province_name", "city_name", "breed_name", "caliber_name", "metric_name", "unit_name", "producer_name", "source_name", "market_name"))
        for row in rows
    }
    caveats = ["Result is limited to the configured tables and may not represent the entire steel market."]
    if len(rows) == 0:
        caveats.append(
            "No observations matched this indicator and date range in the configured tables. "
            "The upstream analysis Skill may perform its bounded dimension checks before final delivery; "
            "do not fill values from memory, infer a trend, or ask the user to choose a recovery option."
        )
    if len(rows) == MAX_SERIES_ROWS:
        caveats.append(f"Result reached the {MAX_SERIES_ROWS}-row safety limit; narrow the indicator or date range.")
    return receipt_result(
        action=action, source_refs=table_refs(config, mapping),
        payload={
            "indicatorId": indicator_id,
            "queryMode": "catalog_selection",
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "series": rows,
            "matchedScopes": len(distinct),
            "truncated": len(rows) == MAX_SERIES_ROWS,
            "dataAvailability": "no_observations" if len(rows) == 0 else "observations_available",
        },
        caveats=caveats,
    )


def dimension_select(mapping: dict[str, Any], alias: str, include_value_columns: bool = True) -> str:
    aliases = {"indicator": alias, "value": "v"}
    return "".join(
        f", {aliases[spec['table']]}.`{spec['column']}` AS {key}"
        for key, spec in mapping["optionalColumns"].items()
        if include_value_columns or spec["table"] == "indicator"
    )


def table_refs(config: dict[str, Any], mapping: dict[str, Any]) -> list[dict[str, str]]:
    base = f"mysql://{config['host']}/{config['database']}"
    return [
        {"uri": f"{base}/{mapping['indicatorTable']}", "title": "Steel market indicator directory"},
        {"uri": f"{base}/{mapping['valueTable']}", "title": "Steel market indicator values"},
    ]


def normalize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{key: normalize_value(value) for key, value in row.items()} for row in rows]


def enrich_series_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Expose explicit canonical dimensions plus stable analysis projections."""
    enriched: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        if "unit_name" in item:
            item.setdefault("unit", item["unit_name"])
        if "region_name" in item:
            item.setdefault("region", item["region_name"])
        if "breed_name" in item:
            item.setdefault("category", item["breed_name"])
        enriched.append(item)
    return enriched


def normalize_value(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def receipt_result(action: str, source_refs: list[dict[str, str]], payload: dict[str, Any], caveats: list[str]) -> dict[str, Any]:
    receipt_seed = json.dumps({"action": action, "sources": source_refs, "payload": payload}, ensure_ascii=False, sort_keys=True, default=str)
    fact = f"MySQL {action} returned {count_records(payload)} record(s)."
    availability = payload.get("dataAvailability")
    satisfied = ["source_summary", "record_counts"]
    facts = [{
        "kind": "source_summary",
        "toolName": "mysql_steel_data.py",
        "textPreview": fact,
        "fields": [
            {"name": "action", "value": action},
            {"name": "recordCount", "value": str(count_records(payload))},
            *([{"name": "dataAvailability", "value": availability}] if isinstance(availability, str) else []),
        ],
    }]
    series_evidence = series_evidence_from_payload(action, payload)
    workflow_progress = workflow_progress_from_payload(action, payload)
    if series_evidence is not None:
        # The Runtime projects this complete JSON stdout into a content-addressed
        # reference.  Declare the durable raw-series handoff explicitly so
        # Admission and Assessment agree on the provider's real interface.
        satisfied.append("structured_extraction_artifact")
        query = series_evidence["query"]
        observations = series_evidence["observations"]
        identity = series_evidence["identity"]
        facts.append({
            "kind": "time_series_identity",
            "toolName": "mysql_steel_data.py",
            "textPreview": "The returned raw series is bound to its query parameters and observation coverage.",
            "fields": [
                {"name": "queryMode", "value": str(query["mode"])},
                {"name": "requestedIndicatorId", "value": str(identity.get("requestedIndicatorId", ""))},
                {"name": "queryBoundToExactIndicatorId", "value": str(identity["queryBoundToExactIndicatorId"]).lower()},
                {"name": "requestedStartDate", "value": str(query.get("startDate", ""))},
                {"name": "requestedEndDate", "value": str(query.get("endDate", ""))},
                {"name": "returnedRowCount", "value": str(observations["rowCount"])},
                {"name": "uniqueObservationDateCount", "value": str(observations["uniqueObservationDateCount"])},
                {"name": "observedStartDate", "value": str(observations.get("observedStartDate", ""))},
                {"name": "observedEndDate", "value": str(observations.get("observedEndDate", ""))},
                {"name": "duplicateObservationRowCount", "value": str(observations["duplicateObservationRowCount"])},
                {"name": "dataAvailability", "value": str(observations["dataAvailability"])},
                {"name": "seriesPath", "value": series_evidence["seriesPath"]},
            ],
        })
        facts.append({
            "kind": "structured_extraction_artifact",
            "toolName": "mysql_steel_data.py",
            "textPreview": "The complete raw-series JSON is retained by the Runtime as a content-addressed artifact for downstream analysis.",
            "fields": [
                {"name": "schema", "value": series_evidence["schema"]},
                {"name": "seriesPath", "value": series_evidence["seriesPath"]},
                {"name": "consumer", "value": "steel-market-analysis/analyze-series" if action == "query-series" else "direct raw-day delivery"},
            ],
        })
    if action in ("inspect-schema", "preflight-catalog"):
        satisfied.append("schema_summary")
        if action == "preflight-catalog":
            contract = payload.get("dataContract")
            catalog = contract.get("indicatorCatalog", {}) if isinstance(contract, dict) else {}
            observations = contract.get("observations", {}) if isinstance(contract, dict) else {}
            relationship = contract.get("relationship", {}) if isinstance(contract, dict) else {}
            facts.append({
                "kind": "schema_summary",
                "toolName": "mysql_steel_data.py",
                "textPreview": "Mapped steel catalog fields and the INDEX_CODE directory-to-observation relationship were preflighted.",
                "fields": [
                    {"name": "indicatorTable", "value": str(catalog.get("table", ""))},
                    {"name": "indicatorGrain", "value": str(catalog.get("grain", ""))},
                    {"name": "observationTable", "value": str(observations.get("table", ""))},
                    {"name": "observationGrain", "value": str(observations.get("grain", ""))},
                    {"name": "join", "value": str(relationship.get("join", ""))},
                ],
            })
    return {
        "schema": "agentloop.steelMarketData/v1",
        "action": action,
        **payload,
        **({"seriesEvidence": series_evidence} if series_evidence is not None else {}),
        "assessmentProjection": {
            "action": action,
            "recordCount": count_records(payload),
            "caveats": caveats,
            **({"dataAvailability": availability} if isinstance(availability, str) else {}),
        },
        "evidenceReceipt": {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "sourceType": "mysql_database",
            "receiptId": hashlib.sha256(receipt_seed.encode("utf-8")).hexdigest()[:32],
            "sourceRefs": source_refs,
            "facts": facts,
            "workflowProgress": workflow_progress,
            "caveats": caveats,
            "evidenceKinds": {"satisfied": satisfied, "caveated": ["explicit_caveats"], "failed": []},
        },
    }


def workflow_progress_from_payload(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Publish neutral, machine-readable unfinished evidence work for Runtime.

    Runtime preserves and gates this protocol but does not infer steel-domain
    actions from it. Each requirement carries the owning Skill's instruction
    and is fulfilled either by a later completion id or by its declared
    evidence kinds.
    """
    completed: list[str] = []
    required: list[dict[str, Any]] = []
    if action == "preflight-catalog":
        completed.append("catalog_preflight")
        required.append({
            "id": "exact_indicator_discovery",
            "instruction": "Call discover-indicators with mapped stable catalog dimensions and confirm the returned candidate identity before attempting completion.",
            "requiredEvidenceKinds": [],
        })
    elif action in ("discover-indicators", "list-indicators"):
        candidates = payload.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            required.append({
                "id": "catalog_backed_discovery_refinement",
                "instruction": "This catalog query returned zero candidates. Do not mark indicator discovery complete or conclude the indicator is absent. Run preflight-catalog --query with the original request, use only its exact catalog-backed recommendedFilters and indicatorNameTerms for one bounded retry, then confirm the complete returned indicator_name.",
                "requiredEvidenceKinds": [],
            })
        elif len(candidates) == 1 and not payload.get("truncated", False):
            completed.append("exact_indicator_discovery")
            indicator_id = candidates[0].get("indicator_id") if isinstance(candidates[0], dict) else None
            if isinstance(indicator_id, str) and indicator_id:
                required.append({
                    "id": "exact_indicator_series",
                    "instruction": f"Use the catalog-issued selectionToken for exact indicator_id {indicator_id}: call query-day-by-selection for one date, or query-series-by-selection for a multi-date range; retain the complete raw JSON evidence.",
                    "requiredEvidenceKinds": [],
                })
        else:
            required.append({
                "id": "exact_indicator_selection",
                "instruction": "Multiple catalog candidates remain. Compare their complete mapped dimensions and indicator_name; select one exact indicator_id or request a user choice before querying a series.",
                "requiredEvidenceKinds": [],
            })
    elif action == "query-series":
        completed.append("exact_indicator_series")
        required.append({
            "id": "coverage_backed_aggregation",
            "instruction": "Run the owning analysis workflow on this raw series and produce coverage-backed derived_aggregation evidence before completing a trend or change request.",
            "requiredEvidenceKinds": ["derived_aggregation"],
            # The series source leaf cannot run the analysis Skill.  Persist
            # this as a dependency handoff; the dependent analysis leaf owns
            # the derived_aggregation completion contract.
            "scope": "downstream_step",
        })
    elif action == "query-day":
        completed.append("exact_indicator_day")
    return {
        "schema": "agentloop.evidenceWorkflowProgress/v1",
        "completedRequirementIds": completed,
        "required": required,
    }


def series_evidence_from_payload(action: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Describe a raw time-series result without deriving a market conclusion."""
    if action not in ("query-series", "query-day"):
        return None
    rows = payload.get("series")
    if not isinstance(rows, list):
        return None
    dates = sorted({row.get("observation_date") for row in rows if isinstance(row, dict) and isinstance(row.get("observation_date"), str)})
    indicator_ids = sorted({row.get("indicator_id") for row in rows if isinstance(row, dict) and isinstance(row.get("indicator_id"), str)})
    indicator_names = sorted({row.get("indicator_name") for row in rows if isinstance(row, dict) and isinstance(row.get("indicator_name"), str)})
    requested_indicator_id = payload.get("indicatorId")
    exact_id_query = payload.get("queryMode") == "catalog_selection" and isinstance(requested_indicator_id, str)
    return {
        "schema": "agentloop.steelMarketDayEvidence/v1" if action == "query-day" else "agentloop.steelMarketSeriesEvidence/v1",
        "seriesPath": "$.series",
        "query": {
            "action": action,
            "mode": payload.get("queryMode"),
            "startDate": payload.get("startDate"),
            "endDate": payload.get("endDate"),
        },
        **({"day": payload.get("startDate")} if action == "query-day" else {}),
        "identity": {
            "queryBoundToExactIndicatorId": exact_id_query,
            "requestedIndicatorId": requested_indicator_id,
            "returnedIndicatorIds": indicator_ids,
            "returnedIndicatorNames": indicator_names,
            "matchedScopes": payload.get("matchedScopes"),
        },
        "observations": {
            "dataAvailability": payload.get("dataAvailability"),
            "rowCount": len(rows),
            "uniqueObservationDateCount": len(dates),
            "observedStartDate": dates[0] if dates else None,
            "observedEndDate": dates[-1] if dates else None,
            "duplicateObservationRowCount": len(rows) - len(dates),
            "truncated": payload.get("truncated") is True,
        },
    }


def count_records(payload: dict[str, Any]) -> int:
    for key in ("series", "candidates", "tables", "fields"):
        value = payload.get(key)
        if isinstance(value, list):
            return len(value)
    return 0


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))


if __name__ == "__main__":
    try:
        main()
    except SafeError as error:
        print(json.dumps({"schema": "agentloop.steelMarketDataError/v1", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)

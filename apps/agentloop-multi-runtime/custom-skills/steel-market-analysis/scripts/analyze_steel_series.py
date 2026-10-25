#!/usr/bin/env python3
"""Reproducible descriptive analysis of a bounded mysql-steel-data response."""

import argparse
import datetime as dt
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


MAX_ROWS = 1_000
MAX_DELIVERY_DAILY_PROFILES = 64


class SafeError(Exception):
    pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze raw steel-market series rows.")
    parser.add_argument("--input-file", required=True)
    args = parser.parse_args()
    source = read_source(Path(args.input_file))
    source_batches = raw_series_batches(source)
    series = [row for batch in source_batches for row in batch["series"]]
    if len(series) > MAX_ROWS:
        raise SafeError(f"input series exceeds the {MAX_ROWS}-row analysis limit")
    groups, invalid_row_count = group_rows(series)
    scopes = [describe_scope(scope, rows) for scope, rows in sorted(groups.items())]
    source_receipt_id = source_receipt(source)
    calculation_caveats = analysis_caveats(scopes, invalid_row_count, source_receipt_id)
    result = {
        "schema": "agentloop.steelMarketAnalysis/v1",
        "derivedFrom": {
            "sourceSchema": source.get("schema"),
            "action": source.get("action"),
            "sourceReceiptId": source_receipt_id,
            **({"rawSeriesBatchCount": len(source_batches)} if source.get("action") == "execute-query-plan" else {}),
        },
        "inputQuality": {
            "rawRowCount": len(series),
            "validObservationCount": sum(scope["observationCount"] for scope in scopes),
            "invalidRowCount": invalid_row_count,
        },
        "scopes": scopes,
        # This is the Skill-owned, typed delivery contract.  calculationMarkdown
        # is useful for a person, but it is not durable enough to be the only
        # source of the facts that the final analyst must communicate.
        "analysisDeliveryFacts": analysis_delivery_facts(scopes, calculation_caveats, source_receipt_id, invalid_row_count),
        "calculationMarkdown": calculation_markdown(scopes, calculation_caveats),
        "calculationNotes": [
            "All values are derived from the supplied raw rows; this script does not query MySQL or infer missing observations.",
            "Each indicator, unit, region, and category is calculated separately. Cross-scope comparison requires a separately confirmed common basis.",
        ],
        "calculationCaveats": calculation_caveats,
    }
    result["evidenceReceipt"] = analysis_receipt(result, calculation_caveats)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


def read_source(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise SafeError("raw series input file is unavailable or invalid") from None
    if not isinstance(value, dict) or value.get("schema") != "agentloop.steelMarketData/v1" or value.get("action") not in ("query-series", "execute-query-plan"):
        raise SafeError("input file must be a mysql-steel-data query-series result or query-plan execution result")
    return value


def raw_series_batches(source: dict[str, Any]) -> list[dict[str, Any]]:
    """Expose raw batches while keeping plan selection distinct from analysis.

    A query plan may contain an unresolved selector. Those are preserved in the
    source receipt but never silently treated as an empty price series.
    """
    if source.get("action") == "query-series":
        series = source.get("series")
        if not isinstance(series, list):
            raise SafeError("input file does not contain a mysql-steel-data series")
        return [{"series": series}]
    batches = source.get("batches")
    if not isinstance(batches, list) or not batches:
        raise SafeError("query-plan execution result has no batches")
    raw_batches: list[dict[str, Any]] = []
    for index, batch in enumerate(batches):
        result = batch.get("result") if isinstance(batch, dict) else None
        if not isinstance(result, dict) or result.get("action") != "query-series":
            continue
        series = result.get("series")
        if not isinstance(series, list):
            raise SafeError(f"query-plan raw series batch {index} is invalid")
        raw_batches.append({"series": series})
    if not raw_batches:
        raise SafeError("query-plan execution result has no exact raw series batches")
    return raw_batches


def source_receipt(source: dict[str, Any]) -> str | None:
    receipt = source.get("evidenceReceipt")
    if not isinstance(receipt, dict):
        return None
    receipt_id = receipt.get("receiptId")
    return receipt_id if isinstance(receipt_id, str) and receipt_id.strip() else None


def group_rows(series: list[Any]) -> tuple[dict[tuple[str, str, str, str, str], list[tuple[dt.date, float]]], int]:
    groups: dict[tuple[str, str, str, str, str], list[tuple[dt.date, float]]] = defaultdict(list)
    invalid_row_count = 0
    for row in series:
        if not isinstance(row, dict):
            invalid_row_count += 1
            continue
        try:
            observed = dt.date.fromisoformat(str(row["observation_date"])[:10])
            value = float(row["value"])
        except (KeyError, TypeError, ValueError):
            invalid_row_count += 1
            continue
        if not math.isfinite(value):
            invalid_row_count += 1
            continue
        scope = tuple(str(row.get(key) or "") for key in ("indicator_id", "indicator_name", "unit", "region", "category"))
        groups[scope].append((observed, value))
    if not groups:
        raise SafeError("raw series contains no valid dated numeric observations")
    return groups, invalid_row_count


def describe_scope(scope: tuple[str, str, str, str, str], rows: list[tuple[dt.date, float]]) -> dict[str, Any]:
    ordered = sorted(rows)
    values_by_date: dict[dt.date, list[float]] = defaultdict(list)
    for observed, value in ordered:
        values_by_date[observed].append(value)
    dates = sorted(values_by_date)
    first = endpoint(dates[0], values_by_date[dates[0]])
    last = endpoint(dates[-1], values_by_date[dates[-1]])
    first_value = first["representativeValue"]
    last_value = last["representativeValue"]
    change_computable = first_value is not None and last_value is not None
    absolute_change = last_value - first_value if change_computable else None
    change_rate = None if not change_computable or first_value == 0 else absolute_change / abs(first_value)
    low_value = min(value for _, value in ordered)
    high_value = max(value for _, value in ordered)
    low_dates = sorted({observed.isoformat() for observed, value in ordered if value == low_value})
    high_dates = sorted({observed.isoformat() for observed, value in ordered if value == high_value})
    missing_ranges = missing_date_ranges(dates)
    daily_profiles = [
        date_profile(observed, values)
        for observed, values in sorted(values_by_date.items())
    ]
    multi_observation_dates = [
        profile
        for profile in daily_profiles
        if profile["observationCount"] > 1
    ]
    multi_value_dates = [
        profile
        for profile in daily_profiles
        if profile["distinctValueCount"] > 1
    ]
    same_date_same_value_dates = [
        profile
        for profile in daily_profiles
        if profile["sameDateSameValueAdditionalObservationCount"] > 0
    ]
    unique_date_count = len(dates)
    return {
        "scope": {"indicatorId": scope[0], "indicator": scope[1], "unit": scope[2] or None, "region": scope[3] or None, "category": scope[4] or None},
        "observationCount": len(ordered),
        "uniqueDateCount": unique_date_count,
        "dateRange": {"start": dates[0].isoformat(), "end": dates[-1].isoformat()},
        "first": first,
        "last": last,
        "changeComputable": change_computable,
        "absoluteChange": absolute_change,
        "changeRate": change_rate,
        "minimum": {"value": low_value, "dates": low_dates},
        "maximum": {"value": high_value, "dates": high_dates},
        "dailyProfiles": daily_profiles,
        "endpointRangeMovement": endpoint_range_movement(first, last),
        "missingCalendarDateCount": sum(entry["missingDateCount"] for entry in missing_ranges),
        "dateGapCount": len(missing_ranges),
        "missingDateRanges": missing_ranges,
        "multiObservationDateCount": len(multi_observation_dates),
        "additionalSameDateObservationCount": len(ordered) - unique_date_count,
        "multiValueDateCount": len(multi_value_dates),
        "multiValueDates": multi_value_dates,
        "sameDateSameValueDateCount": len(same_date_same_value_dates),
        "sameDateSameValueAdditionalObservationCount": sum(profile["sameDateSameValueAdditionalObservationCount"] for profile in daily_profiles),
    }


def endpoint(observed: dt.date, values: list[float]) -> dict[str, Any]:
    distinct_values = sorted(set(values))
    return {
        "date": observed.isoformat(),
        "observationCount": len(values),
        "distinctValueCount": len(distinct_values),
        "values": distinct_values,
        "valueRange": {"minimum": distinct_values[0], "maximum": distinct_values[-1]},
        "representativeValue": distinct_values[0] if len(distinct_values) == 1 else None,
    }


def date_profile(observed: dt.date, values: list[float]) -> dict[str, Any]:
    distinct_values = sorted(set(values))
    delivery_values = distinct_values[:8]
    return {
        "date": observed.isoformat(),
        "observationCount": len(values),
        "distinctValueCount": len(distinct_values),
        "values": delivery_values,
        "valuesTruncated": len(distinct_values) > len(delivery_values),
        "valueRange": {"minimum": distinct_values[0], "maximum": distinct_values[-1]},
        "rangeWidth": distinct_values[-1] - distinct_values[0],
        "sameDateSameValueAdditionalObservationCount": len(values) - len(distinct_values),
    }


def endpoint_range_movement(first: dict[str, Any], last: dict[str, Any]) -> dict[str, Any]:
    first_range = first["valueRange"]
    last_range = last["valueRange"]
    lower_change = last_range["minimum"] - first_range["minimum"]
    upper_change = last_range["maximum"] - first_range["maximum"]
    if lower_change == 0 and upper_change == 0:
        direction = "flat"
    elif lower_change >= 0 and upper_change >= 0:
        direction = "up"
    elif lower_change <= 0 and upper_change <= 0:
        direction = "down"
    else:
        direction = "mixed"
    return {
        "firstDate": first["date"],
        "lastDate": last["date"],
        "firstRange": first_range,
        "lastRange": last_range,
        "lowerBoundChange": lower_change,
        "upperBoundChange": upper_change,
        "direction": direction,
    }


def missing_date_ranges(dates: list[dt.date]) -> list[dict[str, Any]]:
    ranges: list[dict[str, Any]] = []
    for previous, current in zip(dates, dates[1:]):
        missing_count = (current - previous).days - 1
        if missing_count > 0:
            ranges.append({
                "start": (previous + dt.timedelta(days=1)).isoformat(),
                "end": (current - dt.timedelta(days=1)).isoformat(),
                "missingDateCount": missing_count,
            })
    return ranges


def analysis_caveats(scopes: list[dict[str, Any]], invalid_row_count: int, source_receipt_id: str | None) -> list[str]:
    caveats: list[str] = []
    if source_receipt_id is None:
        caveats.append("输入缺少来源回执 ID，无法将本次计算关联到具体的 MySQL 查询回执。")
    if invalid_row_count > 0:
        caveats.append(f"跳过了 {invalid_row_count} 条缺少有限数值或 ISO 日期的原始记录。")
    for item in scopes:
        label = scope_label(item)
        if not item["changeComputable"]:
            caveats.append(f"{label}：首日或末日有多个不同数值，因此未计算区间变化。")
        if item["missingCalendarDateCount"] > 0:
            caveats.append(f"{label}：首末观测日期之间有 {item['missingCalendarDateCount']} 个日历日期没有观测；未对原因作推断。")
        if item["multiValueDateCount"] > 0:
            caveats.append(
                f"{label}：有 {item['multiValueDateCount']} 个日期包含多个不同数值；"
                "未取得可区分报价层级、时点或版本的字段，因此不选择单一日值。"
            )
        if item["sameDateSameValueAdditionalObservationCount"] > 0:
            caveats.append(
                f"{label}：按当前返回字段识别出 {item['sameDateSameValueAdditionalObservationCount']} 条同日同值的附加观测；"
                "其次数作为数据质量事实保留，不当作新的价格水平，也不推断底表中未返回的行级差异。"
            )
    return caveats


def analysis_delivery_facts(
    scopes: list[dict[str, Any]],
    caveats: list[str],
    source_receipt_id: str | None,
    invalid_row_count: int,
) -> dict[str, Any]:
    """Return the bounded facts the final market-analysis answer must deliver.

    This is deliberately separate from the full calculation result: Runtime may
    compact raw command output, while a final answer still needs the exact
    numerical basis for every analysed scope.
    """
    delivered_scopes: list[dict[str, Any]] = []
    for item in scopes:
        first = item["first"]
        last = item["last"]
        absolute_change = item["absoluteChange"]
        trend = "not_computable"
        if item["changeComputable"]:
            trend = "up" if absolute_change > 0 else "down" if absolute_change < 0 else "flat"
        delivered_scopes.append({
            "identity": item["scope"],
            "dataBasis": {
                "observationCount": item["observationCount"],
                "uniqueDateCount": item["uniqueDateCount"],
                "dateRange": item["dateRange"],
                "invalidRowCount": invalid_row_count,
                "dateGapCount": item["dateGapCount"],
                "missingCalendarDateCount": item["missingCalendarDateCount"],
                "multiObservationDateCount": item["multiObservationDateCount"],
                "additionalSameDateObservationCount": item["additionalSameDateObservationCount"],
                "multiValueDateCount": item["multiValueDateCount"],
                "sameDateSameValueDateCount": item["sameDateSameValueDateCount"],
                "sameDateSameValueAdditionalObservationCount": item["sameDateSameValueAdditionalObservationCount"],
            },
            "first": delivery_endpoint(first),
            "last": delivery_endpoint(last),
            "change": {
                "computable": item["changeComputable"],
                "absolute": absolute_change,
                "rate": item["changeRate"],
                "trend": trend,
            },
            "extrema": {"minimum": item["minimum"], "maximum": item["maximum"]},
            "endpointRangeMovement": item["endpointRangeMovement"],
            "dailyProfiles": bounded_daily_profiles(item["dailyProfiles"]),
        })
    return {
        "schema": "agentloop.deliveryFacts/v1",
        "kind": "series_data_profile",
        "sourceReceiptId": source_receipt_id,
        "scopes": delivered_scopes,
        "caveats": caveats,
    }


def bounded_daily_profiles(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    if len(profiles) <= MAX_DELIVERY_DAILY_PROFILES:
        items = profiles
    else:
        side = MAX_DELIVERY_DAILY_PROFILES // 2
        items = [*profiles[:side], *profiles[-side:]]
    return {
        "items": items,
        "totalDateCount": len(profiles),
        "truncated": len(items) < len(profiles),
    }


def delivery_endpoint(endpoint_value: dict[str, Any]) -> dict[str, Any]:
    """Keep the observed endpoint values when no single value is defensible."""
    values = endpoint_value["values"]
    delivery_limit = 8
    return {
        "date": endpoint_value["date"],
        "value": endpoint_value["representativeValue"],
        "values": values[:delivery_limit],
        "valuesTruncated": len(values) > delivery_limit,
        "observationCount": endpoint_value["observationCount"],
        "distinctValueCount": endpoint_value["distinctValueCount"],
        "computable": endpoint_value["representativeValue"] is not None,
    }


def calculation_markdown(scopes: list[dict[str, Any]], caveats: list[str]) -> str:
    parts = ["## 数值计算摘要"]
    for item in scopes:
        unit = item["scope"]["unit"]
        unit_suffix = f" {unit}" if unit else ""
        parts.extend([
            f"### {scope_label(item)}",
            f"- 数据范围：{item['dateRange']['start']} 至 {item['dateRange']['end']}；{item['observationCount']} 条原始观测、{item['uniqueDateCount']} 个观测日期。",
            endpoint_line("首日", item["first"], unit_suffix),
            endpoint_line("末日", item["last"], unit_suffix),
        ])
        if item["changeComputable"]:
            change_rate = item["changeRate"]
            rate_text = "不可计算（首日值为 0）" if change_rate is None else f"{change_rate * 100:.2f}%"
            direction = "上升" if item["absoluteChange"] > 0 else "回落" if item["absoluteChange"] < 0 else "持平"
            parts.append(f"- 区间变化：{direction} {format_number(abs(item['absoluteChange']))}{unit_suffix}；绝对变化 {format_number(item['absoluteChange'])}{unit_suffix}，变化率 {rate_text}。")
        else:
            parts.append("- 区间变化：首日或末日存在多个不同观测值，未选择代表值，因此绝对变化和变化率不可计算。")
        movement = item["endpointRangeMovement"]
        parts.append(
            "- 首末观测日数值区间："
            f"{movement['firstDate']} 为 {format_number(movement['firstRange']['minimum'])}–{format_number(movement['firstRange']['maximum'])}{unit_suffix}，"
            f"{movement['lastDate']} 为 {format_number(movement['lastRange']['minimum'])}–{format_number(movement['lastRange']['maximum'])}{unit_suffix}；"
            f"下沿变化 {format_signed_number(movement['lowerBoundChange'])}{unit_suffix}，"
            f"上沿变化 {format_signed_number(movement['upperBoundChange'])}{unit_suffix}。"
        )
        parts.extend([
            f"- 区间最低值：{format_number(item['minimum']['value'])}{unit_suffix}（{', '.join(item['minimum']['dates'])}）。",
            f"- 区间最高值：{format_number(item['maximum']['value'])}{unit_suffix}（{', '.join(item['maximum']['dates'])}）。",
            coverage_line(item),
        ])
    if caveats:
        parts.append("### 数据限制")
        parts.extend(f"- {caveat}" for caveat in caveats)
    return "\n".join(parts)


def endpoint_line(label: str, item: dict[str, Any], unit_suffix: str) -> str:
    if item["representativeValue"] is not None:
        return f"- {label}：{item['date']} 为 {format_number(item['representativeValue'])}{unit_suffix}。"
    values = "、".join(format_number(value) for value in item["values"])
    return f"- {label}：{item['date']} 有 {item['observationCount']} 条观测、{item['distinctValueCount']} 个不同值（{values}{unit_suffix}），不选取代表值。"


def coverage_line(item: dict[str, Any]) -> str:
    if item["missingCalendarDateCount"] == 0 and item["multiObservationDateCount"] == 0:
        return "- 日期覆盖：首末观测日期之间未发现日历日期缺口或同日多条观测。"
    parts: list[str] = []
    if item["missingCalendarDateCount"] > 0:
        parts.append(f"{item['missingCalendarDateCount']} 个日历日期没有观测（{item['dateGapCount']} 段）")
    if item["multiObservationDateCount"] > 0:
        parts.append(f"{item['multiObservationDateCount']} 个日期存在同日多条观测")
    if item["multiValueDateCount"] > 0:
        parts.append(f"其中 {item['multiValueDateCount']} 个日期包含多个不同数值")
    if item["sameDateSameValueAdditionalObservationCount"] > 0:
        parts.append(f"按当前返回字段另有 {item['sameDateSameValueAdditionalObservationCount']} 条同日同值附加观测")
    return "- 日期覆盖：" + "；".join(parts) + "。"


def scope_label(item: dict[str, Any]) -> str:
    scope = item["scope"]
    name = scope["indicator"] or scope["indicatorId"] or "未命名指标"
    dimensions = [scope[key] for key in ("region", "category") if scope[key]]
    return " / ".join([name, *dimensions])


def format_number(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".")


def format_signed_number(value: float) -> str:
    prefix = "+" if value > 0 else ""
    return f"{prefix}{format_number(value)}"


def analysis_receipt(result: dict[str, Any], caveats: list[str]) -> dict[str, Any]:
    source_receipt_id = result["derivedFrom"]["sourceReceiptId"]
    receipt_seed = json.dumps({
        "sourceReceiptId": source_receipt_id,
        "inputQuality": result["inputQuality"],
        "scopes": result["scopes"],
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        "schema": "agentloop.toolEvidenceReceipt/v1",
        "sourceType": "steel_market_python_analysis",
        "receiptId": hashlib.sha256(receipt_seed.encode("utf-8")).hexdigest()[:32],
        "sourceRefs": [] if source_receipt_id is None else [{"receiptId": source_receipt_id}],
        "facts": [{
            "kind": "derived_aggregation",
            "toolName": "analyze_steel_series.py",
            "textPreview": f"Computed reproducible series shape, date-level value profiles, endpoint/range movements, extrema, and coverage facts for {len(result['scopes'])} scope(s) from {result['inputQuality']['validObservationCount']} valid raw observation(s). The analyst must select only the facts relevant to the chosen methodology.",
            "fields": [
                {"name": "scopeCount", "value": str(len(result["scopes"]))},
                {"name": "validObservationCount", "value": str(result["inputQuality"]["validObservationCount"])},
            ],
        }],
        # Receipt fields survive command-output projection and cross-step
        # compaction.  Runtime treats this as a generic bounded delivery-facts
        # protocol; the schema and meanings remain owned by this Skill.
        "deliveryFacts": result["analysisDeliveryFacts"],
        "caveats": caveats,
        "evidenceKinds": {
            "satisfied": ["derived_aggregation"],
            "caveated": ["explicit_caveats"] if caveats else [],
            "failed": [],
        },
    }


if __name__ == "__main__":
    try:
        main()
    except SafeError as error:
        print(json.dumps({"schema": "agentloop.steelMarketAnalysisError/v1", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)

#!/usr/bin/env python3
"""Reproducible analysis of bounded hr-report-data rows."""

import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


MAX_ROWS = 10_000
MAX_FACTS_PER_SECTION = 2_000
MAX_RANKING_ENTRIES = 100

DISTRIBUTIONS: dict[str, list[str]] = {
    "gender": ["男职工人数", "女职工人数"],
    "education": ["大专以下职工人数", "大专", "本科", "硕士", "博士"],
    "skill_level": ["无技能等级", "初级工", "中级工", "高级工", "技师", "高级技师"],
    "professional_title": ["未评职称", "初级职称", "中级职称", "高级职称"],
    "job_type": ["操作岗位", "技术岗位", "管理岗位"],
}
SUBSET_RATIOS = {
    "youth_share": "35岁以下职工人数",
    "party_member_share": "中共党员人数",
}


class SafeError(Exception):
    pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze HR report rows.")
    parser.add_argument("--input-file", required=True)
    args = parser.parse_args()
    source = read_source(Path(args.input_file))
    rows, invalid_count = normalize_rows(source.get("rows"))
    aggregated, duplicate_count = aggregate_rows(rows)
    metric_series = build_metric_series(aggregated)
    distributions = build_distributions(aggregated)
    subset_ratios = build_subset_ratios(aggregated)
    rankings = build_rankings(aggregated)
    caveats = analysis_caveats(source, invalid_count, duplicate_count, metric_series, distributions, subset_ratios, rankings)
    receipt_id = source_receipt_id(source)
    delivery_facts = {
        "schema": "agentloop.deliveryFacts/v1",
        "kind": "hr_report_analysis",
        "sourceReceiptId": receipt_id,
        "metricSeries": bounded(metric_series),
        "distributions": bounded(distributions),
        "subsetRatios": bounded(subset_ratios),
        "rankings": bounded(rankings),
        "caveats": caveats,
    }
    result = {
        "schema": "agentloop.hrReportAnalysis/v1",
        "derivedFrom": {
            "sourceSchema": source.get("schema"),
            "action": source.get("action"),
            "sourceReceiptId": receipt_id,
        },
        "inputQuality": {
            "rawRowCount": len(source.get("rows", [])),
            "validRowCount": len(rows),
            "invalidRowCount": invalid_count,
            "duplicateGrainRowCount": duplicate_count,
            "aggregatedGrainCount": len(aggregated),
        },
        "metricSeries": bounded(metric_series),
        "distributions": bounded(distributions),
        "subsetRatios": bounded(subset_ratios),
        "rankings": bounded(rankings),
        "analysisDeliveryFacts": delivery_facts,
        "calculationCaveats": caveats,
    }
    result["evidenceReceipt"] = analysis_receipt(result)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


def read_source(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise SafeError("HR report input file is unavailable or invalid") from None
    if not isinstance(value, dict) or value.get("schema") != "agentloop.hrReportData/v1" or value.get("action") != "query-report":
        raise SafeError("input file must be an hr-report-data query-report result")
    if not isinstance(value.get("rows"), list):
        raise SafeError("HR report input does not contain raw rows")
    if len(value["rows"]) > MAX_ROWS:
        raise SafeError(f"HR report input exceeds the {MAX_ROWS}-row analysis limit")
    return value


def normalize_rows(raw_rows: Any) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    invalid = 0
    for raw in raw_rows:
        if not isinstance(raw, dict):
            invalid += 1
            continue
        try:
            month = str(raw["month"])
            code = str(raw["organization_code"])
            name = str(raw["organization_name"])
            metric = str(raw["metric"])
            amount = float(raw["amount"])
        except (KeyError, TypeError, ValueError):
            invalid += 1
            continue
        if len(month) != 6 or not month.isdigit() or not code or not name or not metric or not math.isfinite(amount) or amount < 0:
            invalid += 1
            continue
        rows.append({"month": month, "organizationCode": code, "organizationName": name, "metric": metric, "amount": amount})
    if not rows:
        raise SafeError("HR report input contains no valid non-negative numeric rows")
    return rows, invalid


def aggregate_rows(rows: list[dict[str, Any]]) -> tuple[dict[tuple[str, str, str, str], float], int]:
    values: dict[tuple[str, str, str, str], float] = defaultdict(float)
    counts: dict[tuple[str, str, str, str], int] = defaultdict(int)
    for row in rows:
        key = (row["month"], row["organizationCode"], row["organizationName"], row["metric"])
        values[key] += row["amount"]
        counts[key] += 1
    return dict(values), sum(count - 1 for count in counts.values())


def build_metric_series(values: dict[tuple[str, str, str, str], float]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], list[tuple[str, float]]] = defaultdict(list)
    for (month, code, name, metric), amount in values.items():
        groups[(code, name, metric)].append((month, amount))
    result: list[dict[str, Any]] = []
    for (code, name, metric), observations in sorted(groups.items()):
        ordered = sorted(observations)
        first_month, first_amount = ordered[0]
        last_month, last_amount = ordered[-1]
        change_available = len(ordered) > 1
        absolute = last_amount - first_amount if change_available else None
        rate = None if not change_available or first_amount == 0 else absolute / first_amount
        result.append({
            "organization": organization_identity(code, name),
            "metric": metric,
            "observations": [{"month": month, "amount": amount} for month, amount in ordered],
            "coverage": {"monthCount": len(ordered), "start": first_month, "end": last_month},
            "change": {
                "computable": change_available,
                "absolute": absolute,
                "rate": rate,
                "direction": direction(absolute) if change_available else None,
            },
        })
    return result


def build_distributions(values: dict[tuple[str, str, str, str], float]) -> list[dict[str, Any]]:
    groups = rows_by_org_month(values)
    output: list[dict[str, Any]] = []
    for (month, code, name), metrics in sorted(groups.items()):
        for dimension, required in DISTRIBUTIONS.items():
            if not set(required).issubset(metrics):
                continue
            total = sum(metrics[metric] for metric in required)
            output.append({
                "month": month,
                "organization": organization_identity(code, name),
                "dimension": dimension,
                "total": total,
                "items": [
                    {"metric": metric, "amount": metrics[metric], "share": None if total == 0 else metrics[metric] / total}
                    for metric in required
                ],
            })
    return output


def build_subset_ratios(values: dict[tuple[str, str, str, str], float]) -> list[dict[str, Any]]:
    groups = rows_by_org_month(values)
    output: list[dict[str, Any]] = []
    for (month, code, name), metrics in sorted(groups.items()):
        workforce = metrics.get("在岗员工人数")
        if workforce is None:
            continue
        for ratio_id, subset_metric in SUBSET_RATIOS.items():
            if subset_metric not in metrics:
                continue
            subset = metrics[subset_metric]
            output.append({
                "month": month,
                "organization": organization_identity(code, name),
                "ratio": ratio_id,
                "numeratorMetric": subset_metric,
                "numerator": subset,
                "denominatorMetric": "在岗员工人数",
                "denominator": workforce,
                "value": None if workforce == 0 else subset / workforce,
                "computable": workforce > 0,
            })
    return output


def build_rankings(values: dict[tuple[str, str, str, str], float]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], list[tuple[str, str, float]]] = defaultdict(list)
    for (month, code, name, metric), amount in values.items():
        groups[(month, metric, scope_kind(code))].append((code, name, amount))
    output: list[dict[str, Any]] = []
    for (month, metric, scope), entries in sorted(groups.items()):
        if len(entries) < 2:
            continue
        ordered = sorted(entries, key=lambda item: (-item[2], item[0]))
        delivered = ordered[:MAX_RANKING_ENTRIES]
        output.append({
            "month": month,
            "metric": metric,
            "scope": scope,
            "organizationCount": len(ordered),
            "entries": [
                {"rank": index + 1, "organizationCode": code, "organizationName": name, "amount": amount}
                for index, (code, name, amount) in enumerate(delivered)
            ],
            "truncated": len(delivered) < len(ordered),
        })
    return output


def rows_by_org_month(values: dict[tuple[str, str, str, str], float]) -> dict[tuple[str, str, str], dict[str, float]]:
    groups: dict[tuple[str, str, str], dict[str, float]] = defaultdict(dict)
    for (month, code, name, metric), amount in values.items():
        groups[(month, code, name)][metric] = amount
    return groups


def organization_identity(code: str, name: str) -> dict[str, str]:
    return {"code": code, "name": name, "scope": scope_kind(code)}


def scope_kind(code: str) -> str:
    if len(code) == 4:
        return "full_company"
    if len(code) == 6 and code.endswith("00"):
        return "headquarters"
    return "other"


def direction(value: float | None) -> str | None:
    if value is None:
        return None
    if value > 0:
        return "up"
    if value < 0:
        return "down"
    return "flat"


def bounded(items: list[dict[str, Any]]) -> dict[str, Any]:
    delivered = items[:MAX_FACTS_PER_SECTION]
    return {"totalCount": len(items), "items": delivered, "truncated": len(delivered) < len(items)}


def source_receipt_id(source: dict[str, Any]) -> str | None:
    receipt = source.get("evidenceReceipt")
    if not isinstance(receipt, dict):
        return None
    value = receipt.get("receiptId")
    return value if isinstance(value, str) and value else None


def analysis_caveats(
    source: dict[str, Any], invalid: int, duplicates: int,
    metric_series: list[dict[str, Any]], distributions: list[dict[str, Any]],
    ratios: list[dict[str, Any]], rankings: list[dict[str, Any]],
) -> list[str]:
    caveats = [
        "Full-company and headquarters scopes overlap; analysis and rankings keep them separate.",
        "No cross-organization grand total is calculated because organization scopes may overlap.",
        "Monthly aggregate changes do not identify hires, departures, transfers, or causes.",
    ]
    if source.get("truncated") is True:
        caveats.append("The source query was truncated; results do not represent complete requested coverage.")
    if invalid:
        caveats.append(f"{invalid} invalid raw row(s) were excluded from calculations.")
    if duplicates:
        caveats.append(f"{duplicates} additional row(s) shared an existing month/organization/metric grain and were summed.")
    for label, items in (("metric series", metric_series), ("distributions", distributions), ("ratios", ratios), ("rankings", rankings)):
        if len(items) > MAX_FACTS_PER_SECTION:
            caveats.append(f"Delivered {label} were capped at {MAX_FACTS_PER_SECTION} entries.")
    return caveats


def analysis_receipt(result: dict[str, Any]) -> dict[str, Any]:
    facts = result["analysisDeliveryFacts"]
    seed = json.dumps(facts, ensure_ascii=False, sort_keys=True)
    return {
        "schema": "agentloop.toolEvidenceReceipt/v1",
        "sourceType": "derived_computation",
        "receiptId": hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32],
        "sourceRefs": [],
        "facts": [{
            "kind": "derived_aggregation",
            "toolName": "analyze_hr_report.py",
            "textPreview": "HR report distributions, subset ratios, rankings and month changes were computed from the retained raw rows.",
            "fields": [
                {"name": "validRowCount", "value": str(result["inputQuality"]["validRowCount"])},
                {"name": "metricSeriesCount", "value": str(result["metricSeries"]["totalCount"])},
                {"name": "distributionCount", "value": str(result["distributions"]["totalCount"])},
                {"name": "subsetRatioCount", "value": str(result["subsetRatios"]["totalCount"])},
                {"name": "rankingCount", "value": str(result["rankings"]["totalCount"])},
            ],
        }],
        "deliveryFacts": facts,
        "workflowProgress": {
            "schema": "agentloop.evidenceWorkflowProgress/v1",
            "completedRequirementIds": ["hr_report_analysis"],
            "required": [],
        },
        "caveats": result["calculationCaveats"],
        "evidenceKinds": {"satisfied": ["derived_aggregation"], "caveated": ["explicit_caveats"], "failed": []},
    }


if __name__ == "__main__":
    try:
        main()
    except SafeError as error:
        print(json.dumps({"schema": "agentloop.hrReportAnalysisError/v1", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)


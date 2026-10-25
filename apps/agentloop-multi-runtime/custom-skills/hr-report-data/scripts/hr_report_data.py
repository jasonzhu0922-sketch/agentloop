#!/usr/bin/env python3
"""Bounded, read-only access to the HR report Eplat service."""

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parent.parent
TABLE = "BSTAMSHR00.V_FAWHZHSS0401"
PAGE_SIZE = 1_000
MAX_ROWS = 10_000
MAX_MONTHS = 24
MAX_QUERY_LENGTH = 2_000
MONTH_PATTERN = re.compile(r"^\d{6}$")
ORG_CODE_PATTERN = re.compile(r"^[A-Z0-9]{2,16}$")

DIMENSIONS: dict[str, list[str]] = {
    "workforce": ["在岗员工人数"],
    "gender": ["男职工人数", "女职工人数"],
    "youth": ["35岁以下职工人数"],
    "education": ["大专以下职工人数", "大专", "本科", "硕士", "博士"],
    "skill_level": ["无技能等级", "初级工", "中级工", "高级工", "技师", "高级技师"],
    "professional_title": ["未评职称", "初级职称", "中级职称", "高级职称"],
    "job_type": ["操作岗位", "技术岗位", "管理岗位"],
    "party_membership": ["中共党员人数"],
}
ALLOWED_METRICS = frozenset(metric for metrics in DIMENSIONS.values() for metric in metrics)


class SafeError(Exception):
    """Error text is safe to expose without revealing credentials."""


def main() -> None:
    args = parse_arguments()
    if args.action == "describe-catalog":
        emit(describe_catalog())
        return
    config = read_config()
    if args.action == "latest-period":
        emit(latest_period(config))
        return
    if args.action == "resolve-organizations":
        emit(resolve_organizations(config, args.query))
        return
    emit(query_report(config, args.request))


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read bounded HR report data.")
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("describe-catalog")
    commands.add_parser("latest-period")
    resolver = commands.add_parser("resolve-organizations")
    resolver.add_argument("--query", required=True)
    query = commands.add_parser("query-report")
    query.add_argument("--request-json", required=True)
    args = parser.parse_args()
    if args.action == "resolve-organizations":
        args.query = args.query.strip()
        if not args.query or len(args.query) > MAX_QUERY_LENGTH:
            raise SafeError(f"organization query must contain 1 to {MAX_QUERY_LENGTH} characters")
    if args.action == "query-report":
        args.request = parse_request(args.request_json)
    return args


def read_config() -> dict[str, str]:
    path = Path(os.environ.get("HR_REPORT_ENV_FILE", SKILL_ROOT / ".env"))
    try:
        values = parse_dotenv(path)
    except OSError:
        raise SafeError("HR report Eplat configuration is unavailable") from None
    aliases = {
        "url": ("HR_REPORT_EPLAT_URL", "HR_DATA_QUERY_API_URL"),
        "client_id": ("HR_REPORT_EPLAT_CLIENT_ID", "HR_DATA_QUERY_CLIENT_ID"),
        "client_secret": ("HR_REPORT_EPLAT_CLIENT_SECRET", "HR_DATA_QUERY_CLIENT_SECRET"),
        "model_id": ("HR_REPORT_EPLAT_MODEL_ID", "HR_DATA_QUERY_MODEL_ID"),
    }
    result = {name: first_value(values, *keys) for name, keys in aliases.items()}
    result["model_id"] = result["model_id"] or "M_DWD_BSTAMSHR002"
    if not all(result.values()):
        raise SafeError("HR report Eplat configuration is incomplete")
    if not result["url"].startswith(("https://", "http://")):
        raise SafeError("HR report Eplat URL is invalid")
    return result


def parse_dotenv(path: Path) -> dict[str, str]:
    accepted = {
        "HR_REPORT_EPLAT_URL", "HR_REPORT_EPLAT_CLIENT_ID", "HR_REPORT_EPLAT_CLIENT_SECRET", "HR_REPORT_EPLAT_MODEL_ID",
        "HR_DATA_QUERY_API_URL", "HR_DATA_QUERY_CLIENT_ID", "HR_DATA_QUERY_CLIENT_SECRET", "HR_DATA_QUERY_MODEL_ID",
    }
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


def first_value(values: dict[str, str], *keys: str) -> str:
    for key in keys:
        value = values.get(key, "").strip()
        if value:
            return value
    return ""


def parse_request(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise SafeError("HR report request is not valid JSON") from None
    if not isinstance(value, dict) or set(value) - {"months", "metrics", "organizationSelection", "companyScope"}:
        raise SafeError("HR report request contains unsupported fields")
    months = value.get("months")
    if not isinstance(months, dict) or set(months) != {"start", "end"}:
        raise SafeError("months must contain exactly start and end")
    start = parse_month(months.get("start"), "start month")
    end = parse_month(months.get("end"), "end month")
    if month_index(start) > month_index(end):
        raise SafeError("start month must not be after end month")
    if month_index(end) - month_index(start) + 1 > MAX_MONTHS:
        raise SafeError(f"month range must not exceed {MAX_MONTHS} months")
    metrics = value.get("metrics")
    if not isinstance(metrics, list) or not metrics or len(metrics) > len(ALLOWED_METRICS):
        raise SafeError("metrics must be a non-empty bounded array")
    if any(not isinstance(metric, str) or metric not in ALLOWED_METRICS for metric in metrics):
        raise SafeError("metrics contains an unsupported HR report metric")
    metrics = list(dict.fromkeys(metrics))
    selection = value.get("organizationSelection")
    scope = value.get("companyScope", "full_company")
    if selection is not None and "companyScope" in value:
        raise SafeError("use organizationSelection or companyScope, not both")
    if selection is None:
        if scope not in ("full_company", "headquarters", "both"):
            raise SafeError("companyScope must be full_company, headquarters, or both")
    else:
        if not isinstance(selection, dict) or set(selection) != {"codes", "selectionToken"}:
            raise SafeError("organizationSelection must contain exactly codes and selectionToken")
        codes = selection.get("codes")
        token = selection.get("selectionToken")
        if not isinstance(codes, list) or not codes or len(codes) > 50 or any(not isinstance(code, str) or not ORG_CODE_PATTERN.fullmatch(code) for code in codes):
            raise SafeError("organizationSelection codes are invalid")
        if not isinstance(token, str) or not token:
            raise SafeError("organizationSelection token is invalid")
        selection = {"codes": sorted(set(codes)), "selectionToken": token}
    return {
        "months": {"start": start, "end": end},
        "metrics": metrics,
        **({"organizationSelection": selection} if selection is not None else {"companyScope": scope}),
    }


def parse_month(value: Any, label: str) -> str:
    if not isinstance(value, str) or not MONTH_PATTERN.fullmatch(value):
        raise SafeError(f"{label} must use YYYYMM")
    year, month = int(value[:4]), int(value[4:])
    if year < 2000 or month < 1 or month > 12:
        raise SafeError(f"{label} is invalid")
    return value


def month_index(value: str) -> int:
    return int(value[:4]) * 12 + int(value[4:]) - 1


def describe_catalog() -> dict[str, Any]:
    payload = {
        "table": TABLE,
        "grain": ["month", "organization_code", "metric"],
        "columns": [
            {"name": "month", "source": "NY", "type": "YYYYMM"},
            {"name": "organization_code", "source": "ORG_CODE", "type": "string"},
            {"name": "organization_name", "source": "ORG_NAME", "type": "string"},
            {"name": "metric", "source": "REPORT_ITEM_DES", "type": "enumeration"},
            {"name": "amount", "source": "MONTH_AMT", "type": "number"},
        ],
        "dimensions": [{"id": key, "metrics": metrics} for key, metrics in DIMENSIONS.items()],
        "organizationScopes": {
            "full_company": "four-character code; includes subsidiaries",
            "headquarters": "matching four-character code plus 00; headquarters only",
            "both": "returns both overlapping scopes; never add them together",
        },
    }
    return result_with_receipt("describe-catalog", payload, source_refs=[], source_type="configured_schema")


def latest_period(config: dict[str, str]) -> dict[str, Any]:
    rows, truncated = eplat_query(config, f"SELECT MAX(A.NY) AS LATEST_MONTH FROM {TABLE} A", max_rows=1)
    latest = rows[0].get("latest_month") if rows else None
    payload = {"latestMonth": latest, "dataAvailability": "available" if latest else "empty", "truncated": truncated}
    return result_with_receipt("latest-period", payload, table_refs(config))


def resolve_organizations(config: dict[str, str], query: str) -> dict[str, Any]:
    entities = organization_entities()
    name_index: dict[str, list[dict[str, Any]]] = {}
    for entity in entities:
        for name, name_kind in entity["names"]:
            name_index.setdefault(name, []).append({"entity": entity, "nameKind": name_kind})
    occurrences: list[dict[str, Any]] = []
    for name, candidates in name_index.items():
        start = query.find(name)
        while start >= 0:
            occurrences.append({"name": name, "start": start, "end": start + len(name), "candidates": candidates})
            start = query.find(name, start + 1)
    occurrences.sort(key=lambda item: (-len(item["name"]), item["start"], item["name"]))
    accepted: list[dict[str, Any]] = []
    for item in occurrences:
        if any(item["start"] >= kept["start"] and item["end"] <= kept["end"] for kept in accepted):
            continue
        accepted.append(item)
    ambiguous = [item for item in accepted if len({candidate["entity"]["id"] for candidate in item["candidates"]}) > 1]
    if ambiguous:
        return {
            "schema": "agentloop.hrOrganizationResolution/v1",
            "status": "ambiguous",
            "ambiguousNames": [{"name": item["name"], "organizations": sorted({candidate["entity"]["displayName"] for candidate in item["candidates"]})} for item in ambiguous],
            "rule": "Ask the user to choose one exact company; do not query or guess an organization code.",
        }
    matched: dict[str, dict[str, Any]] = {}
    for item in accepted:
        candidate = item["candidates"][0]
        matched[candidate["entity"]["id"]] = {**candidate["entity"], "matchedName": item["name"], "nameKind": candidate["nameKind"]}
    if not matched:
        generic = any(term in query for term in ("各公司", "所有公司", "全部公司"))
        return {
            "schema": "agentloop.hrOrganizationResolution/v1",
            "status": "all_companies" if generic else "no_match",
            "companyScope": "full_company" if generic else None,
            "rule": "Use companyScope=full_company for all-companies requests." if generic else "No configured company name or alias matched exactly; do not guess a code.",
        }
    requested_scope = scope_from_query(query)
    codes: list[str] = []
    output: list[dict[str, Any]] = []
    for entity in matched.values():
        entity_scope = "headquarters" if entity["nameKind"] == "hq" else requested_scope
        selected_codes = entity_codes(entity, entity_scope)
        codes.extend(selected_codes)
        output.append({
            "displayName": entity["displayName"],
            "matchedName": entity["matchedName"],
            "scope": entity_scope,
            "codes": selected_codes,
        })
    codes = sorted(set(codes))
    return {
        "schema": "agentloop.hrOrganizationResolution/v1",
        "status": "resolved",
        "organizations": sorted(output, key=lambda item: item["displayName"]),
        "selection": {
            "schema": "agentloop.hrOrganizationSelection/v1",
            "codes": codes,
            "selectionToken": organization_selection_token(config, codes),
        },
        "rule": "Pass selection.codes and selection.selectionToken unchanged to query-report organizationSelection.",
    }


def organization_entities() -> list[dict[str, Any]]:
    try:
        source = json.loads((SKILL_ROOT / "references" / "org-hierarchy.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise SafeError("HR organization hierarchy is unavailable or invalid") from None
    entities: list[dict[str, Any]] = []
    for pair in source.get("pairs", []):
        if not isinstance(pair, dict):
            continue
        base_code, base_name = pair.get("baseCode"), pair.get("baseName")
        hq_code, hq_name = pair.get("hqCode"), pair.get("hqName")
        if not all(isinstance(value, str) and value for value in (base_code, base_name, hq_code, hq_name)):
            continue
        names = [(base_name, "base"), (hq_name, "hq")]
        aliases = pair.get("alias", [])
        if isinstance(aliases, list):
            names.extend((alias, "alias") for alias in aliases if isinstance(alias, str) and alias)
        entities.append({"id": base_code, "displayName": base_name, "baseCode": base_code, "hqCode": hq_code, "names": names})
    for item in source.get("onlyBaseCompany", []):
        if isinstance(item, dict) and isinstance(item.get("code"), str) and isinstance(item.get("name"), str):
            entities.append({"id": item["code"], "displayName": item["name"], "baseCode": item["code"], "hqCode": None, "names": [(item["name"], "base")]})
    for item in source.get("onlyHqCompany", []):
        if isinstance(item, dict) and isinstance(item.get("code"), str) and isinstance(item.get("name"), str):
            entities.append({"id": item["code"], "displayName": item["name"], "baseCode": None, "hqCode": item["code"], "names": [(item["name"], "hq")]})
    return entities


def scope_from_query(query: str) -> str:
    if any(term in query for term in ("总部", "本部", "机关")):
        return "headquarters"
    if any(term in query for term in ("全公司", "整体", "含下属")):
        return "full_company"
    return "both"


def entity_codes(entity: dict[str, Any], scope: str) -> list[str]:
    if scope == "full_company":
        return [entity["baseCode"]] if entity.get("baseCode") else []
    if scope == "headquarters":
        return [entity["hqCode"]] if entity.get("hqCode") else []
    return [code for code in (entity.get("baseCode"), entity.get("hqCode")) if code]


def organization_selection_token(config: dict[str, str], codes: list[str]) -> str:
    payload = "agentloop.hrOrganizationSelection/v1\n" + "\n".join(sorted(set(codes)))
    digest = hmac.new(config["client_secret"].encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"v1.{digest}"


def verify_organization_selection(config: dict[str, str], selection: dict[str, Any]) -> None:
    expected = organization_selection_token(config, selection["codes"])
    if not hmac.compare_digest(expected, selection["selectionToken"]):
        raise SafeError("organization codes were not selected by a matching organization receipt")


def query_report(config: dict[str, str], request: dict[str, Any]) -> dict[str, Any]:
    months = request["months"]
    where = [
        f"A.NY BETWEEN {sql_string(months['start'])} AND {sql_string(months['end'])}",
        f"A.REPORT_ITEM_DES IN ({', '.join(sql_string(metric) for metric in request['metrics'])})",
    ]
    selection = request.get("organizationSelection")
    if selection is not None:
        verify_organization_selection(config, selection)
        where.append(f"A.ORG_CODE IN ({', '.join(sql_string(code) for code in selection['codes'])})")
    else:
        scope = request["companyScope"]
        if scope == "full_company":
            where.append("LENGTH(A.ORG_CODE) = 4")
        elif scope == "headquarters":
            where.append("LENGTH(A.ORG_CODE) = 6 AND SUBSTR(A.ORG_CODE, 5, 2) = '00'")
        else:
            where.append("(LENGTH(A.ORG_CODE) = 4 OR (LENGTH(A.ORG_CODE) = 6 AND SUBSTR(A.ORG_CODE, 5, 2) = '00'))")
    sql = f"""SELECT A.NY AS MONTH, A.ORG_CODE AS ORGANIZATION_CODE,
       A.ORG_NAME AS ORGANIZATION_NAME, A.REPORT_ITEM_DES AS METRIC,
       A.MONTH_AMT AS AMOUNT
FROM {TABLE} A
WHERE {' AND '.join(where)}
ORDER BY A.NY, A.ORG_CODE, A.REPORT_ITEM_DES"""
    rows, truncated = eplat_query(config, sql)
    normalized = [normalize_report_row(row) for row in rows]
    periods = sorted({row["month"] for row in normalized if row["month"]})
    organizations = sorted({row["organization_code"] for row in normalized if row["organization_code"]})
    caveats = [
        "The source is a monthly organization-level aggregate and contains no employee-level records.",
        "Full-company and headquarters rows overlap and must never be added together.",
        "Cross-organization totals may double count hierarchical scopes unless the selected organizations are proven mutually exclusive.",
    ]
    if truncated:
        caveats.append(f"Result reached the {MAX_ROWS}-row safety limit; narrow the month, metric, or organization scope.")
    payload = {
        "request": request,
        "rows": normalized,
        "coverage": {
            "rowCount": len(normalized),
            "periods": periods,
            "organizationCount": len(organizations),
            "metricCount": len({row["metric"] for row in normalized}),
        },
        "truncated": truncated,
        "dataAvailability": "observations_available" if normalized else "no_observations",
        "analysisInputContract": {
            "schema": "agentloop.hrReportData/v1",
            "rowsPath": "$.rows",
            "consumer": "hr-report-analysis/analyze-report",
        },
    }
    return result_with_receipt("query-report", payload, table_refs(config), caveats=caveats)


def normalize_report_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "month": row.get("month"),
        "organization_code": row.get("organization_code"),
        "organization_name": row.get("organization_name"),
        "metric": row.get("metric"),
        "amount": row.get("amount"),
    }


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def eplat_query(config: dict[str, str], sql: str, max_rows: int = MAX_ROWS) -> tuple[list[dict[str, Any]], bool]:
    rows: list[dict[str, Any]] = []
    offset = 0
    columns: list[str] = []
    while len(rows) < max_rows:
        limit = min(PAGE_SIZE, max_rows - len(rows))
        payload = {
            "clientId": config["client_id"],
            "clientSecret": config["client_secret"],
            "sql": sql,
            "modelId": config["model_id"],
            "showCount": "true",
            "offset": str(offset),
            "limit": limit,
        }
        request = urllib.request.Request(
            config["url"], data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            raise SafeError("HR report Eplat query failed") from None
        system = data.get("__sys__", {}) if isinstance(data, dict) else {}
        blocks = data.get("__blocks__") if isinstance(data, dict) else None
        if system.get("status") not in (0, 1) or not isinstance(blocks, dict) or not isinstance(blocks.get("result"), dict):
            message = system.get("msg", "invalid response") if isinstance(system, dict) else "invalid response"
            raise SafeError(f"HR report Eplat query failed: {message}")
        result = blocks["result"]
        if not columns:
            columns = [item["name"].lower() for item in result.get("meta", {}).get("columns", []) if isinstance(item, dict) and isinstance(item.get("name"), str)]
        page = result.get("rows", [])
        if not isinstance(page, list):
            raise SafeError("HR report Eplat query returned invalid rows")
        if page and isinstance(page[0], dict):
            rows.extend({str(key).lower(): value for key, value in row.items()} for row in page if isinstance(row, dict))
        else:
            rows.extend(dict(zip(columns, row)) for row in page if isinstance(row, list))
        if len(page) < limit:
            return rows, False
        offset += len(page)
    return rows, True


def table_refs(config: dict[str, str]) -> list[dict[str, str]]:
    return [{"uri": f"{config['url']}/{TABLE}", "title": "HR monthly organization report"}]


def result_with_receipt(
    action: str,
    payload: dict[str, Any],
    source_refs: list[dict[str, str]],
    source_type: str = "eplat_sql_service",
    caveats: list[str] | None = None,
) -> dict[str, Any]:
    caveats = caveats or []
    seed = json.dumps({"action": action, "payload": payload, "sourceRefs": source_refs}, ensure_ascii=False, sort_keys=True, default=str)
    row_count = len(payload.get("rows", [])) if isinstance(payload.get("rows"), list) else (1 if action == "latest-period" and payload.get("latestMonth") else 0)
    satisfied = ["source_summary", "record_counts"]
    facts: list[dict[str, Any]] = [{
        "kind": "source_summary",
        "toolName": "hr_report_data.py",
        "textPreview": f"HR report {action} returned {row_count} record(s).",
        "fields": [
            {"name": "action", "value": action},
            {"name": "recordCount", "value": str(row_count)},
        ],
    }]
    if action == "describe-catalog":
        satisfied.append("schema_summary")
        facts.append({
            "kind": "schema_summary",
            "toolName": "hr_report_data.py",
            "textPreview": "The fixed HR report table, grain, fields and 22 metric values were described.",
            "fields": [{"name": "table", "value": TABLE}, {"name": "metricCount", "value": str(len(ALLOWED_METRICS))}],
        })
    if action == "query-report":
        satisfied.append("structured_extraction_artifact")
        facts.append({
            "kind": "structured_extraction_artifact",
            "toolName": "hr_report_data.py",
            "textPreview": "The complete bounded HR report rows are retained for downstream analysis.",
            "fields": [
                {"name": "schema", "value": "agentloop.hrReportData/v1"},
                {"name": "rowsPath", "value": "$.rows"},
                {"name": "consumer", "value": "hr-report-analysis/analyze-report"},
            ],
        })
    return {
        "schema": "agentloop.hrReportData/v1",
        "action": action,
        **payload,
        "assessmentProjection": {"action": action, "recordCount": row_count, "caveats": caveats},
        "evidenceReceipt": {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "sourceType": source_type,
            "receiptId": hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32],
            "sourceRefs": source_refs,
            "facts": facts,
            "workflowProgress": {
                "schema": "agentloop.evidenceWorkflowProgress/v1",
                "completedRequirementIds": ["bounded_hr_report_rows"] if action == "query-report" else [],
                "required": ([{
                    "id": "hr_report_analysis",
                    "instruction": "Run hr-report-analysis/analyze-report before reporting distributions, ratios, rankings, changes, or other numerical HR conclusions.",
                    "requiredEvidenceKinds": ["derived_aggregation"],
                    "scope": "downstream_step",
                }] if action == "query-report" else []),
            },
            "caveats": caveats,
            "evidenceKinds": {"satisfied": satisfied, "caveated": ["explicit_caveats"] if caveats else [], "failed": []},
        },
    }


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))


if __name__ == "__main__":
    try:
        main()
    except SafeError as error:
        print(json.dumps({"schema": "agentloop.hrReportDataError/v1", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)


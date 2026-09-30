#!/usr/bin/env python3
"""Skill-owned result shaping over the Host's protected Integration broker."""

import argparse
import hashlib
import json
import os
import socket


MAX_NAMES = 8
MAX_NAME_LENGTH = 200
MAX_MATCH_TYPE_LENGTH = 64
MAX_REGION_LENGTH = 128
DELIVERY_SAMPLE_LIMIT = 3
DELIVERY_TEXT_LIMIT = 180


class SafeError(Exception):
    """An error whose message is safe to present to a model or end user."""


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query Enterprise Info directly from this Skill package.")
    parser.add_argument("--action", required=True, choices=("search", "detail"))
    parser.add_argument("--name", action="append", required=True, dest="names")
    parser.add_argument("--identity-ref", default="")
    parser.add_argument("--match-type", default="")
    parser.add_argument("--region", default="")
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    args.names = normalize_names(args.names)
    args.identity_ref = normalize_text(args.identity_ref, "identity ref", 256, allow_empty=True)
    if args.action == "detail" and len(args.names) != 1:
        raise SafeError("detail requires exactly one enterprise name")
    if args.action == "detail" and not args.identity_ref:
        raise SafeError("detail requires the selected enterprise identity ref")
    args.match_type = normalize_text(args.match_type, "match type", MAX_MATCH_TYPE_LENGTH, allow_empty=True)
    args.region = normalize_text(args.region, "region", MAX_REGION_LENGTH, allow_empty=True)
    if args.offset < 0 or args.offset > 10_000:
        raise SafeError("offset must be an integer between 0 and 10000")
    return args


def normalize_names(values: list[str]) -> list[str]:
    if len(values) > MAX_NAMES:
        raise SafeError(f"at most {MAX_NAMES} enterprise names may be queried at once")
    names = [normalize_text(value, "enterprise name", MAX_NAME_LENGTH) for value in values]
    if len(set(names)) != len(names):
        raise SafeError("enterprise names must be unique")
    return names


def normalize_text(value: str, label: str, maximum: int, allow_empty: bool = False) -> str:
    normalized = value.strip()
    if (not allow_empty and not normalized) or len(normalized) > maximum:
        raise SafeError(f"{label} has an invalid length")
    return normalized


def broker_result(args: argparse.Namespace) -> dict[str, object]:
    socket_path = os.environ.get("AGENTLOOP_INTEGRATION_BROKER_SOCKET", "").strip()
    permit = os.environ.get("AGENTLOOP_INTEGRATION_PERMIT", "").strip()
    if not socket_path or not permit:
        raise SafeError("integration_not_authorized")
    payload = {
        "permit": permit,
        "action": args.action,
        "args": {
            "names": args.names,
            "identityRef": args.identity_ref,
            "matchType": args.match_type,
            "region": args.region,
            "offset": args.offset,
        },
    }
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(30)
            client.connect(socket_path)
            client.sendall(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            client.shutdown(socket.SHUT_WR)
            chunks: list[bytes] = []
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        response = json.loads(b"".join(chunks).decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise SafeError("integration_upstream_failed") from None
    if not isinstance(response, dict) or response.get("ok") is not True:
        code = response.get("code") if isinstance(response, dict) else None
        raise SafeError(code if isinstance(code, str) else "integration_upstream_failed")
    result = response.get("result")
    if not isinstance(result, dict):
        raise SafeError("integration_response_invalid")
    return result


def query(args: argparse.Namespace, broker_response: dict[str, object]) -> dict[str, object]:
    raw_queries = broker_response.get("queries")
    if not isinstance(raw_queries, list) or len(raw_queries) != len(args.names):
        raise SafeError("integration_response_invalid")
    queries: list[dict[str, object]] = []
    for item, name in zip(raw_queries, args.names):
        if not isinstance(item, dict) or item.get("name") != name or item.get("action") != args.action or not isinstance(item.get("result"), dict):
            raise SafeError("integration_response_invalid")
        queries.append({"name": name, "action": args.action, "result": item["result"]})

    endpoint = "integration://enterprise_info"
    visible_result: dict[str, object] = queries[0] if len(queries) == 1 else {"queries": queries}
    receipt_seed = json.dumps({"endpoint": endpoint, "queries": visible_result}, ensure_ascii=False, sort_keys=True)
    result = {
        "schema": "agentloop.enterpriseInfoResult/v1",
        **visible_result,
        "evidenceReceipt": {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "sourceType": "enterprise_info_api",
            "receiptId": hashlib.sha256(receipt_seed.encode("utf-8")).hexdigest()[:32],
            "sourceRefs": [{"uri": endpoint, "title": f"{item['name']} enterprise {args.action}"} for item in queries],
            "facts": [{
                "kind": "source_summary",
                "toolName": "enterprise_info.py",
                "textPreview": f"Enterprise {args.action} returned {len(queries)} result set(s).",
                "fields": [
                    {"name": "action", "value": args.action},
                    {"name": "requestedNames", "value": ", ".join(args.names)},
                    {"name": "resultSets", "value": str(len(queries))},
                ],
            }],
            "caveats": ["Enterprise API results are point-in-time source data; important legal or commercial decisions require verification against the authoritative registry."],
            "evidenceKinds": {"satisfied": ["source_summary"], "caveated": ["explicit_caveats"], "failed": []},
        },
    }
    if args.action == "detail" and len(queries) == 1 and isinstance(queries[0].get("result"), dict):
        detail = queries[0]["result"]
        actual_identity_ref = text_value(first_value(detail, "credit_no", "creditCode"))
        if actual_identity_ref != args.identity_ref:
            result["decisionClaim"] = {
                "schema": "agentloop.runtimeDecisionClaim/v1",
                "status": "conflict",
                "identityRefs": [actual_identity_ref] if actual_identity_ref else [],
            }
            result["decisionBindingConflict"] = {
                "expectedIdentityRef": args.identity_ref,
                "observedIdentityRef": actual_identity_ref,
                "requestedName": args.names[0],
                "instruction": "Do not deliver this result. Reuse the exact selected candidate label and identityRef.",
            }
            result["evidenceReceipt"]["evidenceKinds"]["failed"].append("decision_binding")
            result["evidenceReceipt"]["caveats"].append("Detail result did not match the selected enterprise identity; it is not a deliverable result.")
        else:
            result["decisionClaim"] = {
                "schema": "agentloop.runtimeDecisionClaim/v1",
                "status": "satisfied",
                "identityRefs": [actual_identity_ref],
            }
            result["deliveryCandidate"] = {
                "output": format_detail_delivery(detail, args.names[0]),
                "format": "markdown",
            }
            result["assessmentProjection"] = detail_assessment_projection(detail)
    # This is a generic Runtime protocol object, not an enterprise-specific
    # kernel branch. The Skill owns the ambiguity rule and candidate display;
    # Runtime owns persistence, user interaction, and resumption.
    if args.action == "search" and len(queries) == 1:
        search = queries[0].get("result")
        items = search.get("items") if isinstance(search, dict) else None
        if isinstance(items, list) and len(items) > 1:
            options = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                option_id = item.get("id")
                name = item.get("name")
                if not isinstance(option_id, str) or not option_id or not isinstance(name, str) or not name:
                    continue
                details = []
                for key, label in (("credit_no", "统一社会信用代码"), ("oper_name", "法定代表人"), ("start_date", "成立日期"), ("matchType", "匹配")):
                    value = item.get(key)
                    if isinstance(value, str) and value and value != "-":
                        details.append(f"{label}：{value}")
                identity_refs = [item["credit_no"]] if isinstance(item.get("credit_no"), str) and item["credit_no"] else []
                options.append({"id": option_id, "label": name, "description": "；".join(details), "identityRefs": identity_refs})
            if len(options) > 1:
                result["humanLoopRequirement"] = {
                    "kind": "selection",
                    "title": "请选择要查询的企业主体",
                    "prompt": "检索到多个可区分的企业主体，请选择要继续查询详情的一家。",
                    "rationale": "候选主体之间的等同关系不能由 Runtime 推断。",
                    "evidenceRefs": [],
                    "responseSchema": {"type": "select", "minSelections": 1, "maxSelections": 1, "options": options},
                    "resume": {"mode": "continue_step"},
                }
    return result


def format_detail_delivery(detail: dict[str, object], requested_name: str) -> str:
    """Create the bounded, standard user-facing view of one API detail result."""
    if not detail:
        return "\n".join([
            "# 企业工商注册信息",
            "",
            f"已按你的确认查询 **{requested_name}**，但详情接口本次未返回可展示的工商登记记录。",
            "",
            "该结果不代表其他同名或关联主体；未替换为其他候选企业。",
        ])
    lines = ["# 企业工商注册信息", "", "## 基本注册信息", "", "| 项目 | 内容 |", "|---|---|"]
    add_markdown_field(lines, "企业名称", detail, "name", "ent_name")
    add_markdown_field(lines, "统一社会信用代码", detail, "credit_no", "creditCode")
    add_markdown_field(lines, "注册号", detail, "reg_no", "regNo")
    add_markdown_field(lines, "法定代表人", detail, "oper_name", "legal_person")
    add_markdown_field(lines, "企业类型", detail, "econ_kind", "enterprise_type")
    add_markdown_field(lines, "注册资本", detail, "regist_capi", "reg_capi", "registered_capital")
    add_markdown_field(lines, "实缴资本", detail, "actual_capi", "actual_capital")
    add_markdown_field(lines, "成立日期", detail, "start_date", "establish_date")
    add_markdown_field(lines, "经营状态", detail, "new_status", "status")
    add_markdown_field(lines, "登记机关", detail, "belong_org", "registration_authority")
    add_markdown_field(lines, "核准日期", detail, "check_date", "approval_date")
    add_markdown_field(lines, "营业期限", detail, "term_start", "term_end", joiner=" 至 ")
    industry = industry_text(detail.get("industry_code"))
    if industry:
        lines.append(f"| 所属行业 | {markdown_cell(industry)} |")

    scope = text_value(first_value(detail, "scope", "business_scope"))
    if scope:
        lines.extend(["", "## 经营范围", "", scope])

    contact = detail.get("contact")
    contact_record = contact if isinstance(contact, dict) else {}
    contact_rows: list[str] = []
    add_markdown_field(contact_rows, "地址", contact_record, "address", fallback=first_value(detail, "address"))
    add_markdown_field(contact_rows, "电话", contact_record, "telephone", "phone", "tel")
    add_markdown_field(contact_rows, "邮箱", contact_record, "email")
    if contact_rows:
        lines.extend(["", "## 联系方式", "", "| 项目 | 内容 |", "|---|---|", *contact_rows])

    summaries = [
        list_summary("股东信息", detail.get("partners", detail.get("shareholders")), ("name", "stock_percent", "total_should_capi")),
        list_summary("主要人员", detail.get("employees", detail.get("main_persons")), ("name", "job_title", "position")),
        list_summary("分支机构", detail.get("branches"), ("name",)),
        list_summary("变更记录", detail.get("changerecords", detail.get("change_records")), ("change_date", "change_item", "after_content")),
    ]
    summaries = [summary for summary in summaries if summary]
    if summaries:
        lines.extend(["", "## 关联信息（标准摘要）", "", *summaries])
    return "\n".join(lines)


def detail_assessment_projection(detail: dict[str, object]) -> dict[str, object]:
    return {
        "schema": "agentloop.enterpriseInfoDetailProjection/v1",
        "enterpriseName": text_value(first_value(detail, "name", "ent_name")),
        "creditCode": text_value(first_value(detail, "credit_no", "creditCode")),
        "listCounts": {
            key: len(value)
            for key, value in detail.items()
            if isinstance(value, list)
        },
        "delivery": "standardized_detail_summary",
    }


def add_markdown_field(
    rows: list[str],
    label: str,
    record: dict[str, object],
    *keys: str,
    fallback: object = None,
    joiner: str | None = None,
) -> None:
    values = [text_value(first_value(record, key)) for key in keys]
    values = [value for value in values if value]
    if not values and fallback is not None:
        fallback_value = text_value(fallback)
        if fallback_value:
            values = [fallback_value]
    if values:
        separator = joiner or " / "
        rows.append(f"| {label} | {markdown_cell(separator.join(values))} |")


def first_value(record: dict[str, object], *keys: str) -> object:
    for key in keys:
        value = record.get(key)
        if text_value(value):
            return value
    return None


def text_value(value: object) -> str:
    if value is None or isinstance(value, (dict, list)):
        return ""
    normalized = str(value).strip()
    return "" if normalized in {"", "-", "None", "null"} else normalized


def markdown_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def industry_text(value: object) -> str:
    if not isinstance(value, dict):
        return text_value(value)
    labels = [text_value(value.get(key)) for key in ("indu_l1", "indu_l2", "indu_l3", "indu_l4")]
    return " › ".join(label for label in labels if label)


def list_summary(label: str, value: object, fields: tuple[str, ...]) -> str:
    if not isinstance(value, list):
        return ""
    samples: list[str] = []
    for item in value[:DELIVERY_SAMPLE_LIMIT]:
        if not isinstance(item, dict):
            continue
        parts = [bounded_text(text_value(first_value(item, field))) for field in fields]
        parts = [part for part in parts if part]
        if parts:
            samples.append("；".join(parts))
    suffix = f"；示例：{' / '.join(samples)}" if samples else ""
    return f"- **{label}**：{len(value)} 条{suffix}"


def bounded_text(value: str) -> str:
    return value if len(value) <= DELIVERY_TEXT_LIMIT else f"{value[:DELIVERY_TEXT_LIMIT]}…"


def main() -> None:
    try:
        args = parse_arguments()
        print(json.dumps(query(args, broker_result(args)), ensure_ascii=False, separators=(",", ":")))
    except SafeError as exc:
        print(f"ERROR: {exc}", file=os.sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

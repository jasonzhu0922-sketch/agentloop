#!/usr/bin/env python3
"""Direct, Skill-owned client for the Enterprise Info API."""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from urllib import parse


MAX_NAMES = 8
MAX_NAME_LENGTH = 200
MAX_MATCH_TYPE_LENGTH = 64
MAX_REGION_LENGTH = 128
ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
CONFIG_KEYS = {
    "ENTERPRISE_INFO_API_BASE_URL",
    "ENTERPRISE_INFO_API_CLIENT_ID",
    "ENTERPRISE_INFO_API_CLIENT_SECRET",
}
DELIVERY_SAMPLE_LIMIT = 3
DELIVERY_TEXT_LIMIT = 180
MAX_PERSONNEL_DELIVERY_ITEMS = 100
CURL_STATUS_MARKER = b"\n__agentloop_enterprise_http_status__:"


class SafeError(Exception):
    """An error whose message is safe to present to a model or end user."""


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query Enterprise Info directly from this Skill package.")
    parser.add_argument("--action", required=True, choices=("search", "detail", "personnel"))
    parser.add_argument("--name", action="append", required=True, dest="names")
    parser.add_argument("--identity-ref", default="")
    parser.add_argument("--match-type", default="")
    parser.add_argument("--region", default="")
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    args.names = normalize_names(args.names)
    args.identity_ref = normalize_text(args.identity_ref, "identity ref", 256, allow_empty=True)
    if args.action in {"detail", "personnel"} and len(args.names) != 1:
        raise SafeError(f"{args.action} requires exactly one enterprise name")
    if args.action in {"detail", "personnel"} and not args.identity_ref:
        raise SafeError(f"{args.action} requires the selected enterprise identity ref")
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


def read_config() -> tuple[str, str, str]:
    try:
        values = parse_dotenv(ENV_FILE)
    except (OSError, UnicodeError):
        raise SafeError("Enterprise Info Skill root .env is unavailable") from None
    base_url = values.get("ENTERPRISE_INFO_API_BASE_URL", "").strip()
    client_id = values.get("ENTERPRISE_INFO_API_CLIENT_ID", "").strip()
    client_secret = values.get("ENTERPRISE_INFO_API_CLIENT_SECRET", "").strip()
    if not base_url or not client_id or not client_secret:
        raise SafeError("Enterprise Info Skill root .env is incomplete")
    return validate_base_url(base_url), client_id, client_secret


def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in CONFIG_KEYS:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values


def validate_base_url(value: str) -> str:
    parsed = parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SafeError("ENTERPRISE_INFO_API_BASE_URL must be an HTTPS URL without credentials, query, or fragment")
    return value.rstrip("/")


def post_json(url: str, payload: dict[str, object], operation: str) -> dict[str, object]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    # The configured upstream is reachable with the platform curl/SecureTransport
    # stack, but the deployed Python/OpenSSL stack can time out during TLS
    # handshake before an HTTP response exists. Keep credentials out of argv and
    # use curl's stdin for the JSON body. The trailing status marker lets us
    # distinguish transport failure from an HTTP/business response without
    # writing token-bearing responses to disk.
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--request",
        "POST",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--header",
        "content-type: application/json",
        "--header",
        "accept: application/json",
        "--data-binary",
        "@-",
        "--write-out",
        "\n__agentloop_enterprise_http_status__:%{http_code}",
        url,
    ]
    try:
        completed = subprocess.run(
            command,
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=35,
            check=False,
        )
    except FileNotFoundError:
        raise SafeError("Enterprise API HTTP transport is unavailable (curl is not installed)") from None
    except subprocess.TimeoutExpired:
        raise SafeError(f"Enterprise API {operation} request timed out") from None

    status_position = completed.stdout.rfind(CURL_STATUS_MARKER)
    if status_position < 0:
        if completed.returncode == 28:
            raise SafeError(f"Enterprise API {operation} request timed out") from None
        if completed.returncode == 35:
            raise SafeError(f"Enterprise API {operation} TLS handshake failed") from None
        if completed.returncode == 60:
            raise SafeError(f"Enterprise API {operation} TLS certificate verification failed") from None
        raise SafeError(f"Enterprise API {operation} request failed (transport code {completed.returncode})") from None

    raw = completed.stdout[:status_position]
    status_text = completed.stdout[status_position + len(CURL_STATUS_MARKER):].strip()
    try:
        status_code = int(status_text)
    except ValueError:
        raise SafeError(f"Enterprise API {operation} returned an invalid HTTP status") from None
    if status_code < 200 or status_code >= 300:
        raise SafeError(f"Enterprise API {operation} returned HTTP {status_code}") from None
    if completed.returncode != 0:
        raise SafeError(f"Enterprise API {operation} request failed (transport code {completed.returncode})") from None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SafeError(f"Enterprise API {operation} returned invalid JSON") from None
    if not isinstance(value, dict):
        raise SafeError(f"Enterprise API {operation} returned an invalid response")
    return value


def query(args: argparse.Namespace, base_url: str, client_id: str, client_secret: str) -> dict[str, object]:
    token_response = post_json(f"{base_url}/authorize/token", {
        "client_id": client_id,
        "client_secret": client_secret,
    }, "token")
    token = token_response.get("token")
    if token_response.get("success") is not True or not isinstance(token, str) or not token:
        raise SafeError("Enterprise API token response is invalid")

    queries: list[dict[str, object]] = []
    for name in args.names:
        if args.action == "search":
            payload: dict[str, object] = {
                "client_id": client_id,
                "token": token,
                "apiCode": "advSearchNew",
                "busiName": name,
                "matchType": args.match_type,
                "region": args.region,
            }
            result_field = "advSearchNew"
        else:
            payload = {
                "client_id": client_id,
                "token": token,
                "apiCode": "detailAndContactByName",
                "busiName": name,
                "offset": args.offset,
            }
            result_field = "detailAndContactByName"
        response = post_json(f"{base_url}/enterpriseAPI/getInfo", payload, args.action)
        status = response.get("responseStatus")
        if not isinstance(status, dict) or status.get("success") is not True:
            raise SafeError(f"Enterprise API {args.action} request was rejected")
        queries.append({"name": name, "action": args.action, "result": redact(response.get(result_field, {}), client_id, client_secret, token)})

    endpoint = f"{base_url}/enterpriseAPI/getInfo"
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
    if args.action in {"detail", "personnel"} and len(queries) == 1 and isinstance(queries[0].get("result"), dict):
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
            if args.action == "personnel":
                result["evidenceReceipt"]["facts"][0]["textPreview"] = format_personnel_delivery(detail, args.names[0])
                result["assessmentProjection"] = personnel_assessment_projection(detail)
                result["evidenceReceipt"]["evidenceKinds"]["satisfied"].append("record_counts")
            else:
                result["evidenceReceipt"]["facts"][0]["textPreview"] = format_detail_delivery(detail, args.names[0])
                result["assessmentProjection"] = detail_assessment_projection(detail)
    # This is a generic Runtime protocol object, not an enterprise-specific
    # kernel branch. The Skill owns the ambiguity rule and candidate display;
    # Runtime owns persistence, user interaction, and resumption.
    if args.action == "search" and len(queries) == 1:
        search = queries[0].get("result")
        items = search.get("items") if isinstance(search, dict) else None
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                result["evidenceReceipt"]["facts"].append({
                    "kind": "source_summary",
                    "textPreview": "Enterprise identity candidate; not verified detail or current appointment evidence.",
                    "fields": [{"name": key, "value": text_value(item.get(key))}
                               for key in ("name", "credit_no", "id") if item.get(key)],
                })
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
        "sourceView": "registration_detail_summary",
    }


def personnel_records(detail: dict[str, object]) -> list[dict[str, str]]:
    value = detail.get("employees", detail.get("main_persons"))
    if not isinstance(value, list):
        return []
    records: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name = text_value(first_value(item, "name"))
        title = text_value(first_value(item, "job_title", "position"))
        if name or title:
            records.append({"name": name, "title": title})
    return records


def format_personnel_delivery(detail: dict[str, object], requested_name: str) -> str:
    """Deliver the exact registered-personnel view without summary sampling."""
    enterprise_name = text_value(first_value(detail, "name", "ent_name")) or requested_name
    credit_code = text_value(first_value(detail, "credit_no", "creditCode"))
    records = personnel_records(detail)
    lines = ["# 工商登记主要人员", "", f"企业：**{enterprise_name}**"]
    check_date = text_value(detail.get("check_date"))
    if check_date:
        lines.append(f"来源 check_date：{check_date}（来源核准日期，不代表所有任职的生效时间或现任状态已核验）")
    if credit_code:
        lines.append(f"统一社会信用代码：`{credit_code}`")
    lines.extend(["", "## 已登记人员"])
    if not records:
        lines.extend(["", "本次企业详情接口未返回主要人员字段，不能据此推断公司领导名单。"])
    else:
        display_records = records[:MAX_PERSONNEL_DELIVERY_ITEMS]
        lines.extend(["", "| 姓名 | 登记职务 |", "|---|---|"])
        for record in display_records:
            name = markdown_cell(record["name"]) if record["name"] else "未返回"
            title = markdown_cell(record["title"]) if record["title"] else "未返回"
            lines.append(f"| {name} | {title} |")
        if len(records) > len(display_records):
            lines.extend(["", f"接口返回 {len(records)} 条主要人员记录；为避免截断被误认为完整名单，本次只展示前 {len(display_records)} 条。"])
        else:
            lines.extend(["", f"以上为接口本次返回的 {len(records)} 条主要人员记录，未按示例截取。"])
    lines.extend([
        "",
        "## 口径说明",
        "",
        "- “主要人员”是企业信息 API 返回的工商登记字段，不能自动等同于该公司内部全部领导班子、党委班子或任命口径。",
        "- 登记职务按原文保留；总经理不能直接改称总裁。现任任职信息仍需以公司官网或最新任免公告核验。",
        "- Enterprise API results are point-in-time source data; important legal or commercial decisions require verification against the authoritative registry.",
    ])
    return "\n".join(lines)


def personnel_assessment_projection(detail: dict[str, object]) -> dict[str, object]:
    records = personnel_records(detail)
    return {
        "schema": "agentloop.enterpriseInfoPersonnelProjection/v1",
        "enterpriseName": text_value(first_value(detail, "name", "ent_name")),
        "creditCode": text_value(first_value(detail, "credit_no", "creditCode")),
        "personnelCount": len(records),
        "personnel": records[:MAX_PERSONNEL_DELIVERY_ITEMS],
        "checkDate": text_value(detail.get("check_date")),
        "scope": "registered_personnel_titles_only; current appointments and title equivalence are unverified",
        "sourceView": "registered_personnel_records",
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


def redact(value: object, client_id: str, client_secret: str, token: str) -> object:
    secret_values = {client_id, client_secret, token}
    if isinstance(value, str):
        redacted = value
        for secret_value in secret_values:
            if secret_value:
                redacted = redacted.replace(secret_value, "[redacted]")
        return redacted
    if isinstance(value, list):
        return [redact(item, client_id, client_secret, token) for item in value]
    if isinstance(value, dict):
        return {
            str(key): "[redacted]" if str(key).lower().replace("_", "") in {"token", "clientid", "clientsecret", "secret"}
            else redact(item, client_id, client_secret, token)
            for key, item in value.items()
        }
    return value


def main() -> None:
    try:
        args = parse_arguments()
        base_url, client_id, client_secret = read_config()
        print(json.dumps(query(args, base_url, client_id, client_secret), ensure_ascii=False, separators=(",", ":")))
    except SafeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

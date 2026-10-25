#!/usr/bin/env python3
"""Bounded direct access to the configured OA document HTTP API."""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


SKILL_ROOT = Path(__file__).resolve().parent.parent
TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 20_000_000
MAX_PAGE_SIZE = 100
MAX_PAGE_NO = 100_000
MAX_TEXT_TERMS = 20
MAX_TERM_LENGTH = 256
MAX_REASON_LENGTH = 500
USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DATE_PATTERN = re.compile(r"^\d{8}$")
KEYWORD_FIELDS = frozenset({
    "oaType", "docType", "documentNumber", "fileNumber", "emergencyLevel",
    "fromLocation", "drafterName", "drafterCode", "nodeName", "ifHandled",
})
REQUEST_FIELDS = frozenset({
    "userId", "timeRange", "keyword", "text", "contentFlag",
    "attachmentContentFlag", "pageSize", "pageNo", "reason",
})
DOCUMENT_KEYS = ("documents", "records", "rows", "items", "list")
CONTAINER_KEYS = ("data", "result", "body")
COUNT_KEYS = ("count", "total", "totalCount", "recordCount")


class SafeError(Exception):
    """Error text is safe to expose without credentials or response bodies."""


def main() -> None:
    parser = argparse.ArgumentParser(description="Read bounded OA document data.")
    commands = parser.add_subparsers(dest="action", required=True)
    search = commands.add_parser("search-documents")
    search.add_argument("--request-json", required=True)
    args = parser.parse_args()
    request = parse_request(args.request_json)
    config = read_config()
    emit(search_documents(config, request))


def parse_request(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise SafeError("OA document request is not valid JSON") from None
    if not isinstance(value, dict):
        raise SafeError("OA document request must be an object")
    unsupported = set(value) - REQUEST_FIELDS
    if unsupported:
        raise SafeError("OA document request contains unsupported fields")

    user_id = value.get("userId")
    if not isinstance(user_id, str) or not USER_ID_PATTERN.fullmatch(user_id):
        raise SafeError("userId must be an explicit 1-64 character employee number string")

    time_range = value.get("timeRange")
    if not isinstance(time_range, dict) or set(time_range) != {"rangeType", "startTime", "endTime"}:
        raise SafeError("timeRange must contain exactly rangeType, startTime and endTime")
    range_type = time_range.get("rangeType")
    if range_type not in ("0", "1"):
        raise SafeError("timeRange.rangeType must be 0 or 1")
    start_time = parse_date(time_range.get("startTime"), "timeRange.startTime")
    end_time = parse_date(time_range.get("endTime"), "timeRange.endTime")
    if start_time > end_time:
        raise SafeError("timeRange.startTime must not be after timeRange.endTime")

    request: dict[str, Any] = {
        "userId": user_id,
        "timeRange": {
            "rangeType": range_type,
            "startTime": start_time.strftime("%Y%m%d"),
            "endTime": end_time.strftime("%Y%m%d"),
        },
        "contentFlag": flag(value.get("contentFlag", "1"), "contentFlag"),
        "attachmentContentFlag": flag(value.get("attachmentContentFlag", "1"), "attachmentContentFlag"),
        "pageSize": bounded_integer(value.get("pageSize", 10), "pageSize", 1, MAX_PAGE_SIZE),
        "pageNo": bounded_integer(value.get("pageNo", 0), "pageNo", 0, MAX_PAGE_NO),
    }

    keyword = value.get("keyword")
    if keyword is not None:
        if not isinstance(keyword, dict) or set(keyword) - KEYWORD_FIELDS:
            raise SafeError("keyword contains unsupported fields")
        normalized_keyword = {
            key: bounded_text(item, f"keyword.{key}")
            for key, item in keyword.items()
            if item is not None and str(item).strip()
        }
        if normalized_keyword:
            request["keyword"] = normalized_keyword

    text = value.get("text")
    if text is not None:
        if not isinstance(text, list) or not text or len(text) > MAX_TEXT_TERMS:
            raise SafeError(f"text must contain 1-{MAX_TEXT_TERMS} terms")
        terms = [bounded_text(item, f"text[{index}]") for index, item in enumerate(text)]
        request["text"] = list(dict.fromkeys(terms))

    reason = value.get("reason")
    if reason is not None:
        request["reason"] = bounded_text(reason, "reason", MAX_REASON_LENGTH)
    return request


def parse_date(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise SafeError(f"{label} must use YYYYMMDD")
    try:
        return datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise SafeError(f"{label} is not a valid calendar date") from None


def flag(value: Any, label: str) -> str:
    if value not in ("0", "1"):
        raise SafeError(f"{label} must be 0 or 1")
    return value


def bounded_integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise SafeError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


def bounded_text(value: Any, label: str, maximum: int = MAX_TERM_LENGTH) -> str:
    if not isinstance(value, str):
        raise SafeError(f"{label} must be a string")
    text = value.strip()
    if not text or len(text) > maximum:
        raise SafeError(f"{label} must contain 1-{maximum} characters")
    return text


def read_config() -> dict[str, str]:
    path = Path(os.environ.get("OA_DOC_ENV_FILE", SKILL_ROOT / ".env"))
    try:
        values = parse_dotenv(path)
    except OSError:
        raise SafeError("OA document API configuration is unavailable") from None
    result = {
        "url": first_value(values, "OA_DOC_API_URL", "DOC_GATEWAY_ES_URL"),
        "app_id": first_value(values, "OA_DOC_APP_ID", "DOC_GATEWAY_APP_ID"),
        "acc_code": first_value(values, "OA_DOC_ACC_CODE", "DOC_GATEWAY_ACC_CODE"),
    }
    if not all(result.values()):
        raise SafeError("OA document API configuration is incomplete")
    parts = urlsplit(result["url"])
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SafeError("OA document API URL is invalid")
    return result


def parse_dotenv(path: Path) -> dict[str, str]:
    accepted = {
        "OA_DOC_API_URL", "OA_DOC_APP_ID", "OA_DOC_ACC_CODE",
        "DOC_GATEWAY_ES_URL", "DOC_GATEWAY_APP_ID", "DOC_GATEWAY_ACC_CODE",
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


def search_documents(config: dict[str, str], request: dict[str, Any]) -> dict[str, Any]:
    params = {
        "userId": request["userId"],
        "timeRange": request["timeRange"],
        **({"keyword": request["keyword"]} if "keyword" in request else {}),
        **({"text": request["text"]} if "text" in request else {}),
    }
    body = {
        "appId": config["app_id"],
        "accCode": config["acc_code"],
        "params": params,
        "contentFlag": request["contentFlag"],
        "attachmentContentFlag": request["attachmentContentFlag"],
        "pageSize": request["pageSize"],
        "pageNo": request["pageNo"],
    }
    upstream = post_json(config["url"], body)
    documents, collection_found = extract_documents(upstream)
    count = extract_count(upstream)
    returned_count = len(documents) if collection_found else None
    has_more = None if count is None else (request["pageNo"] + 1) * request["pageSize"] < count
    caveats = [
        "The employee number was explicitly supplied by the user; this Skill does not verify its relationship to the AgentLoop login.",
        "Results are limited to what the configured OA application credential returns for that employee number.",
    ]
    if not collection_found:
        caveats.append("The upstream response shape did not expose a recognized document collection; inspect upstreamResponse directly.")
    if has_more:
        caveats.append("More pages are available; this result is not a complete result set.")
    data_availability = (
        "observations_available" if (returned_count or (count is not None and count > 0))
        else "no_observations" if collection_found and count in (None, 0)
        else "unknown_response_shape"
    )
    payload = {
        "schema": "agentloop.oaDocData/v1",
        "action": "search-documents",
        "request": request,
        "count": count,
        "returnedCount": returned_count,
        "hasMore": has_more,
        "dataAvailability": data_availability,
        "documents": documents if collection_found else [],
        "upstreamResponse": upstream,
        "accessScope": "configured_oa_application_credential_for_explicit_user_id",
        "assessmentProjection": {
            "action": "search-documents",
            "userId": request["userId"],
            "count": count,
            "returnedCount": returned_count,
            "pageNo": request["pageNo"],
            "pageSize": request["pageSize"],
            "hasMore": has_more,
            "dataAvailability": data_availability,
            "caveats": caveats,
        },
    }
    payload["evidenceReceipt"] = evidence_receipt(config, payload, caveats)
    return payload


def post_json(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise SafeError(f"OA document API returned HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SafeError("OA document API request failed") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise SafeError("OA document API response exceeds the safety limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SafeError("OA document API returned invalid JSON") from None
    if not isinstance(value, dict):
        raise SafeError("OA document API returned a non-object response")
    return value


def extract_documents(response: dict[str, Any]) -> tuple[list[Any], bool]:
    containers: list[dict[str, Any]] = [response]
    containers.extend(response[key] for key in CONTAINER_KEYS if isinstance(response.get(key), dict))
    for container in containers:
        for key in DOCUMENT_KEYS:
            value = container.get(key)
            if isinstance(value, list):
                return value, True
        for nested_key in CONTAINER_KEYS:
            nested = container.get(nested_key)
            if not isinstance(nested, dict):
                continue
            for key in DOCUMENT_KEYS:
                value = nested.get(key)
                if isinstance(value, list):
                    return value, True
    return [], False


def extract_count(response: dict[str, Any]) -> int | None:
    containers: list[dict[str, Any]] = [response]
    containers.extend(response[key] for key in CONTAINER_KEYS if isinstance(response.get(key), dict))
    for container in containers:
        for key in COUNT_KEYS:
            value = container.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, int) and value >= 0:
                return value
            if isinstance(value, str) and value.isdigit():
                return int(value)
    return None


def source_uri(url: str) -> str:
    parts = urlsplit(url)
    host = parts.hostname or "configured-endpoint"
    if parts.port is not None:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


def evidence_receipt(config: dict[str, str], payload: dict[str, Any], caveats: list[str]) -> dict[str, Any]:
    source_refs = [{"uri": source_uri(config["url"]), "title": "OA document search API"}]
    seed = json.dumps(
        {"request": payload["request"], "response": payload["upstreamResponse"], "sourceRefs": source_refs},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    returned = payload["returnedCount"]
    return {
        "schema": "agentloop.toolEvidenceReceipt/v1",
        "sourceType": "oa_document_api",
        "receiptId": hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32],
        "sourceRefs": source_refs,
        "facts": [
            {
                "kind": "source_summary",
                "toolName": "oa_doc_data.py",
                "textPreview": f"OA document search completed for explicit employee number {payload['request']['userId']}.",
                "fields": [
                    {"name": "userId", "value": payload["request"]["userId"]},
                    {"name": "pageNo", "value": str(payload["request"]["pageNo"])},
                ],
            },
            {
                "kind": "record_counts",
                "toolName": "oa_doc_data.py",
                "textPreview": "OA document page and total counts are retained when exposed by the service.",
                "fields": [
                    {"name": "count", "value": "unknown" if payload["count"] is None else str(payload["count"])},
                    {"name": "returnedCount", "value": "unknown" if returned is None else str(returned)},
                ],
            },
            {
                "kind": "structured_extraction_artifact",
                "toolName": "oa_doc_data.py",
                "textPreview": "The complete OA API JSON response is retained for downstream document analysis.",
                "fields": [
                    {"name": "schema", "value": "agentloop.oaDocData/v1"},
                    {"name": "responsePath", "value": "$.upstreamResponse"},
                    {"name": "consumer", "value": "oa-doc-analysis"},
                ],
            },
        ],
        "workflowProgress": {
            "schema": "agentloop.evidenceWorkflowProgress/v1",
            "completedRequirementIds": ["oa_document_api_response"],
            "required": [],
        },
        "caveats": caveats,
        "evidenceKinds": {
            "satisfied": ["source_summary", "source_urls", "record_counts", "structured_extraction_artifact"],
            "caveated": ["explicit_caveats"],
            "failed": [],
        },
    }


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))


if __name__ == "__main__":
    try:
        main()
    except SafeError as error:
        print(json.dumps({"schema": "agentloop.oaDocDataError/v1", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)

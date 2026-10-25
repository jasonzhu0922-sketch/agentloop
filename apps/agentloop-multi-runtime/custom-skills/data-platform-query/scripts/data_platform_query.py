#!/usr/bin/env python3
"""Route a read-only data-platform query to one package-owned module.

Usage:
  python3 data_platform_query.py --request <immutable-request.json>

All modules read configuration only from this Skill root .env file.
Runtime environment variables and external configuration paths are not used.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


MODULE_SCRIPTS = {
    "api": "modules/api/scripts/api_query.py",
    "model": "modules/model/scripts/model_query.py",
    "table": "modules/table/scripts/table_query.py",
    "standard": "modules/standard/scripts/standard_query.py",
    "quality": "modules/quality/scripts/quality_query.py",
}

def required_text(request: dict[str, object], name: str) -> str:
    value = request.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"request.{name} must be a non-empty string")
    return value.strip()


def module_arguments(request: dict[str, object]) -> tuple[str, list[str]]:
    if request.get("schema") != "agentloop.dataPlatformQuery/v1":
        raise ValueError("request.schema must be agentloop.dataPlatformQuery/v1")
    family = required_text(request, "family")
    operation = required_text(request, "operation")
    if family not in MODULE_SCRIPTS:
        raise ValueError(f"unsupported request.family: {family}")
    if family in {"api", "model", "table"}:
        if operation == "search":
            return family, [operation, required_text(request, "query")]
        if operation in {"detail", "similar"} and family == "api":
            return family, [operation, required_text(request, "identifier")]
        if operation == "detail" and family in {"model", "table"}:
            return family, [operation, required_text(request, "identifier")]
    if family == "standard" and operation in {"search", "detail"}:
        kind = required_text(request, "kind")
        if kind not in {"classification", "business-object", "data-element"}:
            raise ValueError(f"unsupported request.kind: {kind}")
        value = required_text(request, "query" if operation == "search" else "identifier")
        return family, [operation, kind, value]
    if family == "quality":
        if operation in {"rules", "tasks"}:
            return family, [operation, required_text(request, "query")]
        if operation in {"rule-detail", "task-detail"}:
            return family, [operation, required_text(request, "identifier")]
    raise ValueError(f"unsupported operation {operation} for {family}")


def read_request(path_text: str) -> dict[str, object]:
    try:
        value = json.loads(Path(path_text).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("query request must be a readable JSON file") from exc
    if not isinstance(value, dict):
        raise ValueError("query request must be a JSON object")
    return value


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] != "--request":
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        request = read_request(argv[2])
        family, arguments = module_arguments(request)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    package_root = Path(__file__).resolve().parents[1]
    script = package_root / MODULE_SCRIPTS[family]
    completed = subprocess.run(
        [sys.executable, str(script), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        if completed.stderr:
            print(completed.stderr, end="", file=sys.stderr)
        return completed.returncode
    try:
        result: object = json.loads(completed.stdout)
    except json.JSONDecodeError:
        result = {"raw": completed.stdout}
    print(json.dumps({
        "schema": "agentloop.sourceSummary/v1",
        "request": request,
        "result": result,
        # The receipt attests to the query operation and its catalog scope;
        # it does not promote a zero-match search into a claim of absence.
        "caveats": [
            "The result covers only registered metadata returned by this query and its search fields; it does not prove that an unregistered or differently described object is absent."
        ],
        "evidenceReceipt": {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "evidenceKinds": {"satisfied": ["source_summary"], "caveated": ["explicit_caveats"], "failed": []},
        },
    }, ensure_ascii=False))
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

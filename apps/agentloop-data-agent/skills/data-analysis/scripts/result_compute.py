#!/usr/bin/env python3
"""Bounded, deterministic computation over an existing Skill query result.

This is deliberately a small declarative surface. It never opens a database,
imports caller code, evaluates expressions, or mutates the input result.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import tempfile


MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_ROWS = 100_000
MAX_GROUPS = 2_000
MAX_AGGREGATIONS = 32


class ComputeError(ValueError):
    pass


def fail(message: str) -> None:
    raise ComputeError(message)


def workspace_path(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a workspace path")
    raw = value.strip()
    workspace = Path(os.environ.get("AGENTLOOP_WORKSPACE_ROOT", ".")).resolve()
    path = Path(raw)
    if raw == "@workspace":
        path = workspace
    elif raw.startswith("@workspace/"):
        path = workspace / raw[len("@workspace/"):]
    elif not path.is_absolute():
        path = workspace / path
    path = path.resolve()
    try:
        path.relative_to(workspace)
    except ValueError:
        fail(f"{label} must stay inside the Run workspace")
    return path


def load_rows(path: Path) -> tuple[list[dict], set[str], dict[str, object]]:
    if not path.is_file():
        fail("input result file does not exist")
    if path.stat().st_size > MAX_INPUT_BYTES:
        fail("input result file exceeds the bounded computation limit")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"input result is not valid UTF-8 JSON: {type(exc).__name__}")
    dataset = value.get("dataset", {}) if isinstance(value, dict) else {}
    rows = dataset.get("rows") if isinstance(dataset, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        fail("input result must contain dataset.rows as an object list")
    if len(rows) > MAX_ROWS:
        fail("input result has too many rows for bounded post-processing")
    declared = dataset.get("columns", [])
    if declared is not None and (not isinstance(declared, list)
                                 or any(not isinstance(field, str) or not field for field in declared)):
        fail("input result dataset.columns must be a field-name list")
    fields = set(declared or []) | {field for row in rows for field in row}
    return rows, fields, {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                          "row_count": len(rows)}


def numeric_values(items: list[dict], field: str) -> list[float]:
    values = []
    for row in items:
        value = row.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            fail(f"aggregation field {field!r} must contain numeric values")
        if not math.isfinite(float(value)):
            fail(f"aggregation field {field!r} contains a non-finite value")
        values.append(float(value))
    return values


def aggregate(items: list[dict], spec: object) -> object:
    if not isinstance(spec, dict) or isinstance(spec, list):
        fail("each aggregation must be an object")
    if set(spec) - {"op", "field"}:
        fail("unsupported aggregation field")
    op = spec.get("op")
    field = spec.get("field")
    if op not in {"count", "sum", "min", "max", "avg", "median", "distinct_count"}:
        fail("unsupported aggregation operation")
    if op == "count":
        return len(items)
    if not isinstance(field, str) or not field.strip():
        fail("field aggregations require a field")
    if op == "distinct_count":
        # Distinct counts are valid for identifiers and text dimensions too;
        # only arithmetic operations require numeric input. Keep JSON typing
        # so 1 and "1" remain distinct values.
        return len({json.dumps(row.get(field), ensure_ascii=False, sort_keys=True) for row in items})
    values = numeric_values(items, field)
    if op == "sum":
        return sum(values)
    if op == "min":
        return min(values) if values else None
    if op == "max":
        return max(values) if values else None
    if op == "avg":
        return statistics.fmean(values) if values else None
    if op == "median":
        return statistics.median(values) if values else None
    fail("unsupported aggregation operation")


def compute(request: dict) -> dict:
    if set(request) - {"input", "operation", "group_by", "aggregations", "sort", "limit"}:
        fail("unsupported compute request field")
    if request.get("operation") != "group_summary":
        fail("only group_summary is supported")
    group_by = request.get("group_by")
    if not isinstance(group_by, list) or not 1 <= len(group_by) <= 4 or any(not isinstance(v, str) or not v.strip() for v in group_by):
        fail("group_by must contain 1..4 field names")
    aggregations = request.get("aggregations")
    if not isinstance(aggregations, dict) or not 1 <= len(aggregations) <= MAX_AGGREGATIONS:
        fail("aggregations must contain 1..32 named operations")
    if any(not isinstance(k, str) or not k.strip() for k in aggregations):
        fail("aggregation names must be non-empty strings")
    if set(group_by) & set(aggregations):
        fail("aggregation names must not overwrite group fields")
    limit = request.get("limit", 500)
    if type(limit) is not int or not 1 <= limit <= MAX_GROUPS:
        fail("limit must be between 1 and 2000")
    rows, fields, input_ref = load_rows(workspace_path(request.get("input"), "input"))
    required_fields = set(group_by) | {spec.get("field") for spec in aggregations.values()
                                       if isinstance(spec, dict) and spec.get("op") != "count"}
    missing_fields = [field for field in required_fields if not isinstance(field, str) or field not in fields]
    if missing_fields:
        fail("requested fields are absent from the input result: " + ", ".join(sorted(map(str, missing_fields))))
    groups: dict[tuple[object, ...], list[dict]] = defaultdict(list)
    for row in rows:
        key = tuple(row.get(field) for field in group_by)
        groups[key].append(row)
        if len(groups) > MAX_GROUPS:
            fail("post-processing produced too many groups")
    output = []
    for key, items in groups.items():
        record = {field: value for field, value in zip(group_by, key)}
        record.update({name: aggregate(items, spec) for name, spec in aggregations.items()})
        output.append(record)
    sort = request.get("sort", [])
    if sort:
        if not isinstance(sort, list) or len(sort) > 4:
            fail("sort must contain at most four fields")
        for item in reversed(sort):
            if not isinstance(item, dict) or not isinstance(item.get("field"), str) or item.get("direction", "asc") not in {"asc", "desc"}:
                fail("sort entries require field and asc/desc direction")
            if item["field"] not in {*group_by, *aggregations}:
                fail("sort field must be a group field or aggregation result")
            output.sort(key=lambda row: sortable_value(row.get(item["field"])),
                        reverse=item.get("direction", "asc") == "desc")
    return {"schema": "agentloop.commandComputation/v1", "operation": "group_summary",
            "input": input_ref, "group_by": group_by, "aggregations": aggregations,
            "dataset": {"columns": list(output[0]) if output else [*group_by, *aggregations],
                         "rows": output[:limit], "row_count": len(output), "complete": len(output) <= limit}}


def sortable_value(value: object) -> tuple[int, object]:
    """Return a total order for JSON-compatible mixed result values."""
    if value is None:
        return 4, ""
    if isinstance(value, bool):
        return 1, value
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            fail("sort field contains a non-finite value")
        return 0, float(value)
    if isinstance(value, str):
        return 2, value
    return 3, json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_json(value: dict, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    content = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=".compute-result-", dir=output.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps({"schema": "nl2sql.data-file/v1", "path": str(output),
                      "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
                      "read_contract": {"file_root": "original_response", "file_pointers": {
                          "dataset": "/dataset", "rows": "/dataset/rows"}},
                      "content_complete": len(content) <= 6000,
                      "content": value if len(content) <= 6000 else None}, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("compute-result")
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        request = json.loads(args.request_json)
        if not isinstance(request, dict):
            fail("request JSON must be an object")
        result = compute(request)
        write_json(result, workspace_path(args.output, "output"))
        return 0
    except (ComputeError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "failed", "error": {"code": "result_compute_invalid",
                         "message": str(exc)}}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

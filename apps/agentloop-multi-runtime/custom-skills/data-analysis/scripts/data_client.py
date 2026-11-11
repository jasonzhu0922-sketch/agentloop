#!/usr/bin/env python3
"""Read metadata or execute caller SQL using this Skill's self-contained gateway."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
sys.dont_write_bytecode = True
from data_access import load_gateway
from runtime_config import use_configured_python, ConnectionConfigurationError
from scenario_selection import selection_requirement


def text_arg(value):
    value = value.strip()
    if not value:
        raise argparse.ArgumentTypeError("must not be empty")
    return value


def save_result(value, output):
    content = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    if not output:
        print(content.decode("utf-8"), end="")
        return
    path = Path(output).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".data-result-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    receipt = {"schema": "nl2sql.data-file/v1", "path": str(path), "bytes": len(content),
               "sha256": hashlib.sha256(content).hexdigest()}
    if isinstance(value, dict):
        receipt.update({k: value[k] for k in ("scenario_id", "query_id", "catalog_revision", "status") if k in value})
        if isinstance(value.get("dataset"), dict):
            receipt["row_count"] = value["dataset"]["row_count"]
            receipt["columns"] = value["dataset"]["columns"]
    # Small facts must reach the calling model in the same tool result as the
    # file receipt. Large datasets stay intact in the referenced file, with no
    # partial list that could be mistaken for complete source coverage.
    receipt["content_complete"] = len(content.decode("utf-8")) <= 6000
    if receipt["content_complete"]:
        receipt["content"] = value
    if isinstance(value, dict) and value.get("schema") == "agentloop.humanLoopRequirement/v1":
        # Runtime consumes this native control structure from registered,
        # immutable Skill command roots and persists a blocking HIL request.
        receipt["humanLoopRequirement"] = value["humanLoopRequirement"]
    if isinstance(value, dict) and value.get("status") == "completed" and value.get("schema") == "nl2sql.query-result/v1":
        receipt["evidenceReceipt"] = {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "evidenceKinds": {"satisfied": ["source_summary", "record_counts"], "caveated": [], "failed": []},
        }
    print(json.dumps(receipt, ensure_ascii=False))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    scenarios = actions.add_parser("scenarios")
    scenarios.add_argument("--output")
    selection = actions.add_parser("select-scenario")
    selection.add_argument("--output", required=True)
    for name in ("catalog", "execute"):
        command = actions.add_parser(name)
        command.add_argument("--scenario-id", required=True, type=text_arg)
        command.add_argument("--output", required=name == "execute")
        if name == "catalog":
            command.add_argument("--source-id", action="append", type=text_arg)
        else:
            command.add_argument("--request-json", required=True)
    args = parser.parse_args(argv)
    body = None
    if args.action == "execute":
        try:
            body = json.loads(args.request_json)
            if (not isinstance(body, dict) or set(body) - {"sql", "params"}
                    or not isinstance(body.get("sql"), str) or not body["sql"].strip()
                    or len(body["sql"].encode("utf-8")) > 65536
                    or not isinstance(body.get("params", []), list)
                    or len(body.get("params", [])) > 1000):
                raise ValueError("expected SQL and a parameter array only")
            if any(not (v is None or type(v) in (str, int, float, bool))
                   or (type(v) is float and not math.isfinite(v)) for v in body.get("params", [])):
                raise ValueError("parameters must be finite JSON scalars")
        except (OSError, ValueError) as exc:
            parser.error("invalid SQL request JSON: " + str(exc))
    exit_code = 0
    phase = "gateway.initialize"
    try:
        gateway = load_gateway()
        if args.action == "scenarios":
            phase = "catalog.scenarios"
            result = gateway.scenarios()
        elif args.action == "select-scenario":
            phase = "scenario.selection"
            result = selection_requirement(gateway.scenarios(), str(Path(args.output).resolve()))
        elif args.action == "catalog":
            phase = "catalog.read"
            result = gateway.catalog(args.scenario_id, args.source_id)
        else:
            phase = "query.dispatch"
            result = gateway.execute_sql(args.scenario_id, body["sql"], body.get("params", []))
    except Exception as exc:
        # Import, catalog, network and driver failures can embed local paths,
        # credentials or values. Retain a failure, never an empty success.
        diagnostic = {"phase": phase, "code": "gateway_operation_failed", "exception_type": type(exc).__name__}
        message = "Skill gateway operation failed; use diagnostic.phase and code to locate the failure"
        if isinstance(exc, ConnectionConfigurationError):
            diagnostic.update(phase="configuration.read", code=exc.code)
            message = str(exc)  # Only fixed, credential-free configuration messages.
        elif isinstance(exc, ImportError):
            diagnostic["code"] = "dependency_unavailable"
        elif type(exc).__module__.split(".")[0] == "psycopg":
            diagnostic["code"] = "database_operation_failed"
            sqlstate = getattr(exc, "sqlstate", None)
            if isinstance(sqlstate, str) and len(sqlstate) == 5 and sqlstate.isalnum():
                diagnostic["sqlstate"] = sqlstate
        result = {"status": "gateway_error", "operation": args.action, "error": message,
                  "diagnostic": diagnostic,
                  "execution_state": ("unknown" if phase == "query.dispatch" else "not_started")
                      if args.action == "execute" else "not_applicable"}
        exit_code = 1
    if exit_code == 0 and args.action in ("catalog", "execute"):
        expected_schema = "nl2sql.data-catalog/v1" if args.action == "catalog" else "nl2sql.query-result/v1"
        if (not isinstance(result, dict) or result.get("scenario_id") != args.scenario_id
                or result.get("schema") != expected_schema):
            result = {"status": "response_mismatch", "error": "Data interface schema or scenario does not match the request"}
            exit_code = 1
        elif args.action == "execute":
            if result.get("status") != "completed":
                exit_code = 1
            else:
                dataset = result.get("dataset")
                if (not isinstance(dataset, dict) or not isinstance(dataset.get("rows"), list)
                        or type(dataset.get("row_count")) is not int
                        or dataset["row_count"] != len(dataset["rows"])
                        or not isinstance(dataset.get("columns"), list)):
                    result = {"status": "incomplete_result", "error": "Dataset receipt does not match complete returned rows"}
                    exit_code = 1
    try:
        save_result(result, args.output)
    except (OSError, ValueError):
        print(json.dumps({"status": "output_error", "error": "Cannot persist complete data evidence"}))
        return 1
    return exit_code


if __name__ == "__main__":
    use_configured_python()
    sys.exit(main())

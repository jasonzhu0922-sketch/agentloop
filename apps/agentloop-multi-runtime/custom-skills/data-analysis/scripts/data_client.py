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
from runtime_config import ConnectionConfigurationError
from scenario_selection import selection_requirement
from entity_binding import EntityBindingError


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
        pointers = {key: '/' + key.replace('~', '~0').replace('/', '~1') for key in value}
        if isinstance(value.get('dataset'), dict):
            pointers.update({'rows': '/dataset/rows', 'columns': '/dataset/columns',
                             'row_count': '/dataset/row_count'})
        receipt['read_contract'] = {'file_root': 'original_response', 'file_pointers': pointers,
                                    'inline_root': '/content',
                                    'instruction': 'File pointers address the saved JSON root; /content exists only in this stdout receipt.'}
        if isinstance(value.get('tables'), list):
            receipt['read_contract']['source_columns'] = {
                table['name']: '/tables/' + str(index) + '/columns'
                for index, table in enumerate(value['tables']) if 'columns' in table}
            receipt['read_contract']['source_fields'] = {
                table['name']: {column['name']: f'/tables/{index}/columns/{column_index}'
                                for column_index, column in enumerate(table['columns'])}
                for index, table in enumerate(value['tables']) if 'columns' in table}
        receipt.update({k: value[k] for k in ("scenario_id", "query_id", "catalog_revision", "status") if k in value})
        if isinstance(value.get("dataset"), dict):
            receipt["row_count"] = value["dataset"]["row_count"]
            receipt["columns"] = value["dataset"]["columns"]
        if 'plan_verification' in value:
            receipt['plan_verification'] = value['plan_verification']
        if 'matched_terms' in value:
            receipt['matched_terms_pointer'] = '/matched_terms'
            if len(json.dumps(value['matched_terms'], ensure_ascii=False)) <= 4000:
                receipt['matched_terms'] = value['matched_terms']
    # Small facts must reach the calling model in the same tool result as the
    # file receipt. Large datasets stay intact in the referenced file, with no
    # partial list that could be mistaken for complete source coverage.
    receipt["content_complete"] = len(content.decode("utf-8")) <= 6000
    if receipt["content_complete"]:
        receipt["content"] = value
    elif isinstance(value, dict) and isinstance(value.get('dataset'), dict):
        # A small answer must not require another read just because its plan
        # evidence is large. Only inline whole datasets, never truncated rows.
        if len(json.dumps(value['dataset'], ensure_ascii=False)) <= 3000:
            receipt['dataset_complete'] = True
            receipt['dataset'] = value['dataset']
            receipt['read_contract']['inline_dataset_root'] = '/dataset'
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
    for name in ("catalog", "execute", "resolve-entity"):
        command = actions.add_parser(name)
        command.add_argument("--scenario-id", required=True, type=text_arg)
        command.add_argument("--output", required=name in ('execute', 'resolve-entity'))
        if name == "catalog":
            command.add_argument("--source-id", action="append", type=text_arg)
            command.add_argument("--question", type=text_arg, help="Rank authorized sources using business knowledge")
        else:
            command.add_argument("--request-json", required=True)
        if name == 'execute':
            command.add_argument('--query-plan', help='Workspace entity-resolution result or entity/metric/time query-plan JSON file')
    args = parser.parse_args(argv)
    body = None
    if args.action == 'resolve-entity':
        try:
            body = json.loads(args.request_json)
            if not isinstance(body, dict):
                raise ValueError('expected an entity lookup object')
        except ValueError as exc:
            parser.error('invalid entity request JSON: ' + str(exc))
    if args.action == "execute":
        try:
            body = json.loads(args.request_json)
            if not isinstance(body, dict):
                raise ValueError('expected a SQL request object')
            if args.query_plan:
                if 'query_plan' in body:
                    raise ValueError('supply query_plan inline or by file, not both')
                with open(args.query_plan, encoding='utf-8') as stream:
                    plan = json.load(stream)
                if not isinstance(plan, dict):
                    raise ValueError('query plan file must contain an object')
                body['query_plan'] = plan['query_plan'] if plan.get('schema') == 'nl2sql.entity-resolution/v1' else plan
            if (not isinstance(body, dict) or set(body) - {"sql", "params", "query_plan"}
                    or not isinstance(body.get("sql"), str) or not body["sql"].strip()
                    or len(body["sql"].encode("utf-8")) > 65536
                    or not isinstance(body.get("params", []), list)
                    or len(body.get("params", [])) > 1000):
                raise ValueError("expected SQL, a parameter array and an optional query_plan")
            if 'query_plan' in body and not isinstance(body['query_plan'], dict):
                raise ValueError('query_plan must be an object')
            if any(not (v is None or type(v) in (str, int, float, bool))
                   or (type(v) is float and not math.isfinite(v)) for v in body.get("params", [])):
                raise ValueError("parameters must be finite JSON scalars")
        except (OSError, ValueError, KeyError) as exc:
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
            result = gateway.catalog(args.scenario_id, args.source_id, args.question)
        elif args.action == 'resolve-entity':
            phase = 'entity.resolve'
            result = gateway.resolve_entity(args.scenario_id, body)
            if result.get('status') == 'failed':
                exit_code = 1
        else:
            phase = "query.dispatch"
            extra = [body['query_plan']] if 'query_plan' in body else []
            result = gateway.execute_sql(args.scenario_id, body["sql"], body.get("params", []), *extra)
    except Exception as exc:
        # Import, catalog, network and driver failures can embed local paths,
        # credentials or values. Retain a failure, never an empty success.
        diagnostic = {"phase": phase, "code": "gateway_operation_failed", "exception_type": type(exc).__name__}
        message = "Skill gateway operation failed; use diagnostic.phase and code to locate the failure"
        if isinstance(exc, ConnectionConfigurationError):
            diagnostic.update(phase="configuration.read", code=exc.code)
            message = str(exc)  # Only fixed, credential-free configuration messages.
        elif isinstance(exc, EntityBindingError):
            diagnostic.update(phase='query.entity_binding', code=exc.code)
            message = str(exc)
        elif isinstance(exc, ImportError):
            diagnostic["code"] = "dependency_unavailable"
            if exc.name in ("pymysql", "sqlglot"):
                diagnostic["module"] = exc.name
            message = "Required Python dependency is unavailable in the Runtime; provision the Skill requirements.txt in the host Python environment"
        elif type(exc).__module__.split(".")[0] == "pymysql":
            diagnostic["code"] = "database_operation_failed"
            if exc.args and type(exc.args[0]) is int:
                diagnostic["vendor_code"] = exc.args[0]
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
    sys.exit(main())

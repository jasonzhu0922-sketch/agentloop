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
from entity_binding import EntityBindingError, query_plan_from_artifact as _query_plan_from_artifact
from semantic_retrieval import METADATA_ACTIONS, KnowledgeRequestError, validate_request


def text_arg(value):
    value = value.strip()
    if not value:
        raise argparse.ArgumentTypeError("must not be empty")
    return value


def workspace_path(value):
    """Resolve the Runtime's workspace alias without allowing path escapes."""
    if not isinstance(value, str):
        return None
    if value.startswith("@workspace/"):
        root = os.environ.get("AGENTLOOP_WORKSPACE_ROOT")
        if root:
            candidate = (Path(root) / value[len("@workspace/"):]).resolve()
            root_path = Path(root).resolve()
            if candidate == root_path or root_path in candidate.parents:
                return candidate
    if value.startswith("@/workspace/"):
        root = os.environ.get("AGENTLOOP_WORKSPACE_ROOT")
        if root:
            candidate = (Path(root) / value[len("@/workspace/"):]).resolve()
            root_path = Path(root).resolve()
            if candidate == root_path or root_path in candidate.parents:
                return candidate
    candidate = Path(value)
    try:
        return candidate if candidate.is_file() else None
    except OSError:
        # Inline JSON can be larger than the platform's maximum pathname.
        # Treat it as JSON input; do not turn a packaging probe into a CLI
        # failure before json.loads gets a chance to parse it.
        return None


def json_argument(value, label):
    """Load inline JSON or a Runtime workspace JSON artifact."""
    path = workspace_path(value)
    if path is not None:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise ValueError(f"{label} file is not valid JSON: {exc}") from exc
    try:
        return json.loads(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be inline JSON or a workspace JSON file") from exc


def query_plan_from_artifact(plan):
    """Extract one executable plan from a plan or context artifact."""
    return _query_plan_from_artifact(plan)


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
    # Budget the serialized model value, not indentation in the disk artifact.
    receipt["content_complete"] = len(json.dumps(value, ensure_ascii=False)) <= 6000
    if receipt["content_complete"]:
        receipt["content"] = value
    elif isinstance(value, dict) and isinstance(value.get('dataset'), dict):
        # A small answer must not require another read just because its plan
        # evidence is large. Only inline whole datasets, never truncated rows.
        if len(json.dumps(value['dataset'], ensure_ascii=False)) <= 3000:
            receipt['dataset_complete'] = True
            receipt['dataset'] = value['dataset']
            receipt['read_contract']['inline_dataset_root'] = '/dataset'
    if isinstance(value, dict) and value.get("status") == "completed" and value.get("schema") == "nl2sql.query-result/v1":
        receipt["evidenceReceipt"] = {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "evidenceKinds": {"satisfied": ["source_summary", "record_counts"], "caveated": [], "failed": []},
        }
    elif isinstance(value, dict) and value.get("schema") in ("nl2sql.data-catalog/v1", "nl2sql.semantic-metadata/v1", "nl2sql.value-probe/v1"):
        # Catalog questions are grounded in actual metadata, not a needless SQL query.
        # This attests metadata acquisition only, never record counts or business correctness.
        receipt["evidenceReceipt"] = {
            "schema": "agentloop.toolEvidenceReceipt/v1",
            "evidenceKinds": {"satisfied": ["source_summary"], "caveated": [], "failed": []},
        }
    print(json.dumps(receipt, ensure_ascii=False))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    scenarios = actions.add_parser("scenarios")
    scenarios.add_argument("--output")
    for name in sorted(METADATA_ACTIONS):
        command = actions.add_parser(name)
        command.add_argument('--scenario-id', required=True, type=text_arg)
        command.add_argument('--request-json', required=True)
        command.add_argument('--output', required=True)
    for name in ("catalog", "execute", "resolve-entity", "candidate-lookup", "probe-values"):
        command = actions.add_parser(name)
        command.add_argument("--scenario-id", required=True, type=text_arg)
        command.add_argument("--output", required=name in ('execute', 'resolve-entity'))
        if name == "catalog":
            command.add_argument("--source-id", action="append", type=text_arg)
            command.add_argument("--question", type=text_arg, help="Rank authorized sources using business knowledge")
        elif name == "probe-values":
            command.add_argument("--source-id", required=True, type=text_arg)
            command.add_argument("--field", required=True, type=text_arg)
            command.add_argument("--limit", type=int, default=50)
        elif name == "candidate-lookup":
            command.add_argument("--request-json", required=True)
        else:
            command.add_argument("--request-json", required=True)
        if name == 'execute':
            command.add_argument('--query-plan', help='Workspace entity-resolution result or entity/metric/time query-plan JSON file')
    args = parser.parse_args(argv)
    body = None
    if args.action in METADATA_ACTIONS:
        try:
            body = json_argument(args.request_json, 'metadata request')
            validate_request(args.action, body)
        except ValueError as exc:
            parser.error('invalid metadata request: ' + str(exc))
    if args.action == 'resolve-entity':
        try:
            body = json_argument(args.request_json, 'entity request')
            if not isinstance(body, dict):
                raise ValueError('expected an entity lookup object')
        except ValueError as exc:
            parser.error('invalid entity request JSON: ' + str(exc))
    if args.action == 'candidate-lookup':
        try:
            body = json_argument(args.request_json, 'candidate lookup')
            if not isinstance(body, dict):
                raise ValueError('expected a candidate lookup object')
        except ValueError as exc:
            parser.error('invalid candidate lookup JSON: ' + str(exc))
    if args.action == "execute":
        try:
            body = json_argument(args.request_json, 'SQL request')
            if not isinstance(body, dict):
                raise ValueError('expected a SQL request object')
            if args.query_plan:
                if 'query_plan' in body:
                    raise ValueError('supply query_plan inline or by file, not both')
                plan_path = workspace_path(args.query_plan) or Path(args.query_plan)
                with open(plan_path, encoding='utf-8') as stream:
                    plan = json.load(stream)
                if not isinstance(plan, dict):
                    raise ValueError('query plan file must contain an object')
                # Models frequently persist a complete execute request as an
                # artifact (sql/params/query_plan) and then pass that artifact
                # to --query-plan.  Treat that deterministic wrapper like the
                # already-supported entity-resolution envelope instead of
                # sending the wrapper into plan validation and making the
                # model repair a packaging mistake.
                plan = query_plan_from_artifact(plan)
                if not isinstance(plan, dict):
                    raise ValueError('query plan file must contain a query-plan object')
                body['query_plan'] = plan
            elif isinstance(body.get('query_plan'), dict):
                # Inline execute requests use the same deterministic envelope
                # as --query-plan files (entity-resolution, query-context or
                # a saved execute wrapper). Normalize it before shape checks.
                body['query_plan'] = query_plan_from_artifact(body['query_plan'])
            elif isinstance(body.get('plan_seed'), dict):
                # Some model/tool adapters place the context envelope beside
                # sql and params. Consume only its declared plan fields.
                body['query_plan'] = query_plan_from_artifact(body)
                body.pop('plan_seed', None)
                for key in ('entity_bindings', 'metric_bindings', 'time_bindings',
                            'source_signatures', 'semantic_model_version',
                            'semantic_bindings', 'semantic_gap_refs', 'decision_refs'):
                    body.pop(key, None)
            if (not isinstance(body, dict) or set(body) - {"sql", "params", "query_plan"}
                    or not isinstance(body.get("sql"), str) or not body["sql"].strip()
                    or len(body["sql"].encode("utf-8")) > 65536
                    or not isinstance(body.get("params", []), list)
                    or len(body.get("params", [])) > 1000):
                raise ValueError("expected SQL, a parameter array and optional query_plan; fixed Agent execution requires query_plan")
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
        if args.action in METADATA_ACTIONS:
            phase = 'knowledge.' + args.action
            result = gateway.knowledge(args.action, args.scenario_id, body)
        elif args.action == "scenarios":
            phase = "catalog.scenarios"
            result = gateway.scenarios()
        elif args.action == "catalog":
            phase = "catalog.read"
            result = gateway.catalog(args.scenario_id, args.source_id, args.question)
        elif args.action == 'resolve-entity':
            phase = 'entity.resolve'
            result = gateway.resolve_entity(args.scenario_id, body)
            if result.get('status') == 'failed':
                exit_code = 1
        elif args.action == 'candidate-lookup':
            phase = 'entity.candidate_lookup'
            result = gateway.candidate_lookup(args.scenario_id, body)
            if result.get('status') != 'completed':
                exit_code = 1
        elif args.action == 'probe-values':
            phase = 'catalog.probe_values'
            result = gateway.probe_values(args.scenario_id, args.source_id, args.field, args.limit)
            if result.get('status') != 'completed':
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
        elif isinstance(exc, KnowledgeRequestError):
            diagnostic.update(phase='knowledge.validate', code=exc.code)
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
    if exit_code == 0 and args.action in {"catalog", "execute", "probe-values"} | METADATA_ACTIONS:
        expected_schema = ("nl2sql.semantic-metadata/v1" if args.action in METADATA_ACTIONS else
                           "nl2sql.data-catalog/v1" if args.action == "catalog" else
                           "nl2sql.value-probe/v1" if args.action == "probe-values" else
                           "nl2sql.query-result/v1")
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

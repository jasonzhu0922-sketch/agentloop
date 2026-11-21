#!/usr/bin/env python3
"""Audit named historical Runs against the current generic semantic contract.

Historical Runs are immutable evidence; this script never changes their state.
It replays retrieval against the current catalog and compares persisted terminal
events, plan-step convergence, and rejection evidence.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import pymysql

from data_access import load_gateway


def parse(value):
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return {}


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def audit(run_ids, output):
    gateway = load_gateway()
    current = gateway.catalog('group')
    current_details = gateway.catalog('group', [table['name'] for table in current['tables']])
    config_ids = [entity.get('id') for entity in current_details.get('entities', [])]
    entity_object_ids = {item.get('object_id') for item in current_details.get('semantic_objects', [])
                         if item.get('kind') == 'entity'}
    object_ids = {item.get('object_id') for item in current_details.get('semantic_objects', [])}
    hierarchy_missing = [item.get('object_id') for item in current_details.get('semantic_objects', [])
                         if item.get('parent_ref') and item.get('parent_ref') not in object_ids]
    forbidden = ('finance.account_set', 'finance.organization', 'operating_03.manufacturing_base')
    # Runtime DB is deliberately read separately from the catalog DB.
    runtime_url = __import__('os').environ.get('DATA_AGENT_TIDB_URL', 'mysql://user:password@127.0.0.1:4000/agentloop_data_agent')
    parsed = __import__('urllib.parse', fromlist=['urlsplit']).urlsplit(runtime_url)
    db = pymysql.connect(host=parsed.hostname, port=parsed.port or 4000,
                         user=parsed.username or 'root', password=parsed.password or '',
                         database=parsed.path.strip('/'), cursorclass=pymysql.cursors.DictCursor)
    reports = []
    with db:
        with db.cursor() as cursor:
            for short in run_ids:
                cursor.execute('SELECT * FROM runs WHERE id LIKE %s ORDER BY created_at DESC LIMIT 1', (short + '%',))
                run = cursor.fetchone()
                if not run:
                    reports.append({'run_id': short, 'status': 'missing'})
                    continue
                run_id = run['id']
                cursor.execute('SELECT type,payload_json,seq FROM run_events WHERE run_id=%s ORDER BY seq', (run_id,))
                events = cursor.fetchall()
                cursor.execute('SELECT status FROM plans WHERE run_id=%s ORDER BY created_at DESC LIMIT 1', (run_id,))
                plan = cursor.fetchone()
                cursor.execute('SELECT status FROM plan_steps WHERE plan_id IN (SELECT id FROM plans WHERE run_id=%s)', (run_id,))
                steps = cursor.fetchall()
                payloads = [parse(event['payload_json']) for event in events]
                diagnostics = []
                for payload in payloads:
                    error = payload.get('error') if isinstance(payload, dict) else None
                    diagnostic = error.get('diagnostic') if isinstance(error, dict) else None
                    if diagnostic:
                        diagnostics.append(diagnostic.get('code'))
                    if payload.get('code'):
                        diagnostics.append(payload['code'])
                binding_checks = {'entity_source_ids_preserved': True,
                                  'metric_source_ids_preserved': True,
                                  'fuzzy_lookup_not_used_as_exact': True,
                                  'entity_object_ids_match_execution_ids': entity_object_ids == set(config_ids),
                                  'semantic_parent_refs_resolve': not hierarchy_missing,
                                  'forbidden_ids_in_persisted_payload': []}
                for payload in payloads:
                    for node in walk(payload):
                        for binding in node.get('entity_bindings', []) if isinstance(node.get('entity_bindings'), list) else []:
                            entity = binding.get('entity', {}) if isinstance(binding, dict) else {}
                            if entity.get('source_id') and binding.get('source_id') and entity['source_id'] != binding['source_id']:
                                binding_checks['entity_source_ids_preserved'] = False
                            if any(value in str(binding) for value in forbidden):
                                binding_checks['forbidden_ids_in_persisted_payload'].extend(value for value in forbidden if value in str(binding))
                            lookup = binding.get('lookup', {}) if isinstance(binding, dict) else {}
                            if isinstance(lookup, dict) and 'LIKE' in str(lookup.get('sql', '')).upper():
                                binding_checks['fuzzy_lookup_not_used_as_exact'] = False
                        for metric in node.get('metric_bindings', []) if isinstance(node.get('metric_bindings'), list) else []:
                            if isinstance(metric, dict) and metric.get('source_id') and metric.get('table') and metric['source_id'] != metric['table']:
                                binding_checks['metric_source_ids_preserved'] = False
                terminal = next((event for event in reversed(events) if event['type'].startswith('run.')), None)
                question = run.get('input') or ''
                try:
                    retrieval = gateway.knowledge('retrieve-knowledge', 'group', {'question': question[:4000] or '历史 Run 回放'})
                    replay = {'status': 'completed', 'source_ids': [item['source_id'] for item in retrieval['sources']['items'][:5]],
                              'catalog_revision': retrieval['catalog_revision'], 'semantic_object_layers': sorted({item.get('layer') for item in retrieval.get('semantic_objects', {}).get('items', []) if item.get('layer')})}
                except Exception as exc:
                    replay = {'status': 'failed', 'error_type': type(exc).__name__}
                reports.append({
                    'run_id': run_id, 'input': question, 'persisted_status': run.get('status'),
                    'persisted_error_code': run.get('error_code'), 'terminal_event': terminal['type'] if terminal else None,
                    'terminal_payload': parse(terminal['payload_json']) if terminal else None,
                    'plan_status': plan['status'] if plan else None,
                    'step_statuses': [step['status'] for step in steps],
                    'event_count': len(events), 'diagnostic_codes': sorted(set(code for code in diagnostics if code)),
                    'binding_checks': binding_checks,
                    'current_replay': replay,
                })
    report = {'schema': 'nl2sql.recent-run-replay/v1', 'generated_at': datetime.now(timezone.utc).isoformat(),
              'run_ids': run_ids,
              'catalog_contract': {'forbidden_runtime_ids_present': [value for value in forbidden if value in config_ids],
                                   'entity_ids': config_ids,
                                   'semantic_layers': sorted({item.get('layer') for item in current_details.get('semantic_objects', [])}),
                                   'semantic_parent_refs_resolve': not hierarchy_missing,
                                   'blocking_gaps': [gap.get('gap_id') for gap in current_details.get('semantic_gaps', []) if gap.get('blocking')]},
              'runs': reports}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    audit(args.run_id, args.output)


if __name__ == '__main__':
    main()

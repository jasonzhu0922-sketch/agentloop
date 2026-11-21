#!/usr/bin/env python3
"""Run source-local semantic regressions against the local TiDB Skill.

The cases are derived from recent Run failure classes, but deliberately select
the current catalog at runtime. No business table, term, date range or fixed
coverage value is embedded here.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path

from data_access import load_gateway


def run(output: Path, run_ids=()):
    gateway = load_gateway()
    index = gateway.catalog('group')
    blocking_sources = {source_id for gap in index.get('semantic_gaps', []) if gap.get('blocking')
                        for source_id in gap.get('source_ids', [])}
    source_id = next((table['name'] for table in index['tables']
                      if table['name'] not in blocking_sources), index['tables'][0]['name'])
    catalog = gateway.catalog('group', [source_id])
    table = catalog['tables'][0]
    column = next(column for column in table['columns'] if column.get('allow_output', True))
    cases = []

    probe = gateway.probe_values('group', table['name'], column['name'], 10)
    cases.append({
        'case_id': 'bounded_probe_stays_source_local',
        'expected': {'status': 'completed', 'scope': {'source_id': table['name']},
                     'global_coverage_promoted': False},
        'observed': {'status': probe.get('status'),
                     'scope': probe.get('semantic_binding', {}).get('scope'),
                     'global_coverage_promoted': 'global_coverage' in probe},
        'status': 'passed' if probe.get('status') == 'completed'
        and probe.get('semantic_binding', {}).get('scope', {}).get('source_id') == table['name']
        and 'global_coverage' not in probe else 'failed',
    })

    context = gateway.knowledge('get-query-context', 'group', {
        'question': '探查当前源', 'source_ids': [table['name']]})
    broken = dict(context['plan_seed'])
    broken['source_signatures'] = dict(broken['source_signatures'])
    broken['source_signatures'][table['name']] = '0' * 64
    sql = f"SELECT COUNT(*) AS row_count FROM `{table['schema']}`.`{table['name']}`"
    stale = gateway.execute_sql('group', sql, [], broken)
    cases.append({
        'case_id': 'stale_source_signature_rejected',
        'expected': {'status': 'rejected', 'code': 'query_schema_changed'},
        'observed': {'status': stale.get('status'),
                     'code': stale.get('error', {}).get('diagnostic', {}).get('code')},
        'status': 'passed' if stale.get('status') == 'rejected'
        and stale.get('error', {}).get('diagnostic', {}).get('code') == 'query_schema_changed' else 'failed',
    })
    report = {
        'schema': 'nl2sql.step4-semantic-regression/v2',
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'target': {'catalog': '127.0.0.1:4000/nl2sql_skill', 'data': '127.0.0.1:4000/nl2sql_group'},
        'source_runs': list(run_ids),
        'cases': cases,
        'summary': {'total': len(cases), 'passed': sum(c['status'] == 'passed' for c in cases),
                    'failed': sum(c['status'] == 'failed' for c in cases)},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report['summary']['failed']:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--run-id', action='append', default=[],
                        help='Recent Run identifier retained as regression provenance')
    args = parser.parse_args()
    run(args.output, args.run_id)


if __name__ == '__main__':
    main()

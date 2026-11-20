#!/usr/bin/env python3
"""Compare broad catalog reads with source-backed retrieval on the configured TiDB.

No business data SQL or model calls; --cases is an array of question/source_ids.
The output is a disk artifact, never a new database or a Memory store.
"""
import argparse
import json
from pathlib import Path
import statistics
import sys
from time import perf_counter
sys.dont_write_bytecode = True

from data_access import load_gateway
from data_client import save_result


def measure(gateway, question, sources, mode):
    original = gateway.physical_catalog
    calls = []
    def counted(config, **options):
        value = original(config, **options)
        calls.append({'tables': len(value['tables']), 'columns': sum(len(t.get('columns', [])) for t in value['tables'])})
        return value
    gateway.physical_catalog = counted
    started = perf_counter()
    try:
        if mode == 'broad_catalog':
            first = gateway.catalog('group', question=question)
            second = gateway.catalog('group', sources, question)
            ranked = [m['source_id'] for m in first.get('retrieval', [])[:5]]
        else:
            first = gateway.knowledge('retrieve-knowledge', 'group', {'question': question})
            second = gateway.knowledge('get-query-context', 'group', {
                'question': question, 'source_ids': sources, 'catalog_revision': first['catalog_revision']})
            ranked = [m['source_id'] for m in first['sources']['items']]
        return {'elapsed_ms': round((perf_counter() - started) * 1000), 'metadata_calls': len(calls),
                'physical_tables_returned': sum(c['tables'] for c in calls),
                'physical_columns_returned': sum(c['columns'] for c in calls),
                'response_bytes': sum(len(json.dumps(v, ensure_ascii=False).encode()) for v in (first, second)),
                'target_tables_in_top5': sorted(set(sources) & set(ranked)),
                'all_targets_in_top5': set(sources) <= set(ranked)}
    finally:
        gateway.physical_catalog = original


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases', required=True)
    parser.add_argument('--rounds', type=int, default=1, choices=range(1, 11))
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    cases = json.loads(Path(args.cases).read_text())
    results = []
    gateway = load_gateway()
    for case in cases:
        samples = {mode: [] for mode in ('broad_catalog', 'retrieval_context')}
        for round_index in range(args.rounds):
            # Alternate first reader to avoid assigning a systematic warm-up advantage.
            modes = list(samples) if round_index % 2 == 0 else list(reversed(samples))
            for mode in modes:
                samples[mode].append(measure(gateway, case['question'], case['source_ids'], mode))
        results.append({'question': case['question'], 'expected_sources': case['source_ids'],
                        'samples': samples, 'median_ms': {k: statistics.median(s['elapsed_ms'] for s in v) for k, v in samples.items()}})
    save_result({'schema': 'nl2sql.retrieval-benchmark/v1', 'rounds': args.rounds,
                 'scope': 'metadata retrieval only; response bytes are not model token counts; small live samples are not P95 or SQL accuracy evidence',
                 'cases': results}, args.output)


if __name__ == '__main__':
    main()

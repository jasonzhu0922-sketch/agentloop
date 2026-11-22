"""Use complete source-local observations for technical encoding, never business meaning."""
from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
import re
import tempfile

from entity_binding import digest, require, scalar


def _path(reference):
    root = os.environ.get('AGENTLOOP_WORKSPACE_ROOT')
    if not root or not isinstance(reference, str) or not re.fullmatch(r'probe_[0-9a-f]{64}', reference):
        return None
    workspace = Path(root).resolve()
    path = (workspace / '.data-agent-contexts' / (reference + '.json')).resolve()
    return path if path.is_relative_to(workspace) else None


def save_probe(probe):
    """Only the gateway writes this protected evidence; user files are not authority."""
    reference = 'probe_' + digest(probe)
    path = _path(reference)
    if path is None:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.probe-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(probe, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return reference


def _load(reference):
    path = _path(reference)
    try:
        probe = json.loads(path.read_text(encoding='utf-8')) if path else None
    except (ValueError, OSError):
        probe = None
    require(isinstance(probe, dict) and 'probe_' + digest(probe) == reference,
            'probe_reference_invalid', 'Use a gateway probe_ref from the current workspace')
    return probe


def observed_encoding(probe):
    """Recognize ordered calendar storage only over a complete, nonempty scoped set."""
    require(probe.get('status') == 'completed' and probe.get('truncated') is False
            and bool(probe.get('values')), 'probe_incomplete',
            'Encoding needs a nonempty complete probe; narrow its scope or increase the bounded limit')
    candidates = {'%Y': 'year', '%Y%m': 'month', '%Y-%m': 'month',
                  '%Y%m%d': 'day', '%Y-%m-%d': 'day'}
    for row in probe['values']:
        value = row.get('value')
        require(type(value) in (str, int), 'probe_encoding_unresolved',
                'NULL or non-calendar values remain unresolved; inspect the source')
        text = str(value)
        for fmt in list(candidates):
            try:
                valid = datetime.strptime(text, fmt).strftime(fmt) == text
            except ValueError:
                valid = False
            if not valid:
                del candidates[fmt]
    require(len(candidates) == 1, 'probe_encoding_unresolved',
            'Mixed or unknown encodings need a narrower source scope, not a guessed format')
    return next(iter(candidates.items()))


def apply_probes(catalog, plan, evidence, refresh):
    references = plan.get('probe_refs', [])
    require(isinstance(references, list) and len(references) <= 8
            and all(isinstance(ref, str) for ref in references)
            and len(set(references)) == len(references),
            'probe_reference_invalid', 'probe_refs must contain at most 8 distinct gateway references')
    if not references:
        return catalog, []
    result, checks = deepcopy(catalog), []
    result['_scoped_periods'] = []
    for reference in references:
        probe = _load(reference)
        source, field = probe.get('source_id'), probe.get('field')
        table = next((t for t in catalog['tables'] if t['name'] == source), None)
        require(table is not None and probe.get('scenario_id') == catalog['scenario_id']
                and probe.get('catalog_revision') == catalog['catalog_revision']
                and probe.get('source_signature') == table.get('table_signature'),
                'probe_stale', 'Probe source or definitions changed; inspect the current source again')
        target = f'time:{source}:{field}'
        require(any(g.get('code') == 'time_format_unresolved' and target in g.get('affected_refs', [])
                    for g in catalog.get('semantic_gaps', [])),
                'probe_not_applicable', 'Observed encodings only address a declared time-format gap')
        column = next((c for c in table['columns'] if c['name'] == field), {})
        require(not column.get('format') and not any(p.get('source_id') == source and p.get('field') == field
                and p.get('definition_status', 'current') == 'current' for p in catalog['period_formats']),
                'probe_not_applicable', 'Observations cannot override an authoritative period definition')
        scans = list(evidence.scans(table))
        require(bool(scans), 'probe_scope_mismatch', 'Probe source must be present in the SQL')
        for item in probe.get('filters', []):
            require(item['operator'] in ('eq', 'in'), 'probe_scope_mismatch',
                    'Encoding evidence requires exact scoped filters, not fuzzy discovery filters')
            expected = {scalar(v) for v in item['values']}
            require(all(evidence.selector(where, alias, item['field'], single) == expected
                        for alias, where, single in scans), 'probe_scope_mismatch',
                    'Each physical source scan must preserve the exact probe filters')
        observed_encoding(probe)
        require(callable(refresh), 'probe_refresh_required', 'The gateway must refresh scoped observations before execution')
        current = refresh(probe)
        require(all(current.get(k) == probe.get(k) for k in
                    ('scenario_id', 'catalog_revision', 'source_id', 'field', 'source_signature', 'filters', 'group_by')),
                'probe_stale', 'Source scope changed during verification')
        fmt, grain = observed_encoding(current)
        require((fmt, grain) == observed_encoding(probe), 'probe_encoding_unresolved',
                'Encoding changed since exploration; inspect the current source again')
        policy = {'source_id': source, 'field': field, 'format': fmt, 'granularity': grain,
                  'definition_status': 'current', 'definition_source': 'scoped_observation',
                  'status': 'observed_only', 'probe_ref': reference,
                  'filters': deepcopy(probe.get('filters', [])),
                  'query_id': current['evidence']['query_id']}
        require(target not in result['_scoped_periods'], 'probe_reference_invalid',
                'Use one complete scoped probe per time field')
        result['_scoped_periods'].append(target)
        result['period_formats'] = [p for p in result['period_formats']
                                    if (p.get('source_id'), p.get('field')) != (source, field)] + [policy]
        checks.append(policy)
    return result, checks

"""Independent business assertions over private host replay evidence; exports counts/hashes only."""
import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

parser = argparse.ArgumentParser()
parser.add_argument('--snapshot', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
digest = lambda data: hashlib.sha256(data).hexdigest()
load = lambda p: json.loads(p.read_text())
results = []

for directory in sorted(args.snapshot.glob('data-latest-*')):
    if not (directory/'summary.json').exists():
        continue
    assertions = []
    query_count = 0
    # Check against the actual successful saved Skill response, not a second query.
    files = []
    for p in (directory/'workspace').rglob('*.json'):
        if '.agentloop' in p.parts:
            continue
        d = load(p)
        if isinstance(d, dict) and d.get('schema') == 'nl2sql.query-result/v1' and d.get('status') == 'completed':
            files.append((p, d))
    evidence = [load(p) for p in sorted(directory.glob('*-evidence.json'))]
    for _, d in files:
        rows = d['dataset']['rows']
        assert d['plan_verification']['status'] == 'verified'
        assert d['catalog_revision'] and d['query_plan']['source_signatures']
        query_count += 1
        if 'MAX(' in d['sql'].upper():
            latest = next(str(v) for v in rows[0].values() if len(str(v)) == 6)
            assert latest in evidence[0]['run']['output']
            assertions.append('latest_month_matches_formal_result')
        if d['sql'].upper().startswith('SELECT DISTINCT NY'):
            months = [str(next(iter(row.values()))) for row in rows]
            assert len(months) == 3 and months == sorted(months, reverse=True)
            assert all(month in evidence[1]['run']['output'] for month in months)
            assert len(d['dataset']['columns']) == 1
            assertions.append('followup_months_match_formal_result_without_personnel_details')
    results.append({'id': directory.name, 'queries': query_count, 'assertions': assertions})

for directory in sorted(args.snapshot.glob('report-finance-*')):
    if not (directory/'summary.json').exists():
        continue
    checked = []
    for p in (directory/'workspace').rglob('aggregated.json'):
        computation = load(p)
        source = load(p.parent.parent/'source/data.json')
        amount = sum(float(row['RMB_AMT']) for row in source)
        assert math.isclose(computation['total_rmb_amt'], amount)
        assert math.isclose(computation['total_rmb_amt_wan'], amount/10000)
        assert computation['total_record_count'] == len(source)
        assert computation['total_supplier_count'] == len({row['VENDOR_CODE'] for row in source})
        company = p.parent.parent.name
        delivered = next((directory/'delivered').glob(f'*{company}*.docx'))
        with ZipFile(delivered) as archive:
            assert archive.testzip() is None
            xml = archive.read('word/document.xml')
            root = ET.fromstring(xml)
            text = ''.join(''.join(ET.fromstring(archive.read(name)).itertext()) for name in archive.namelist()
                           if name.startswith('word/') and name.endswith('.xml'))
            assert '模拟数据' in text and computation['company_name'] in text
            assert f'{amount/10000:.2f}' in text
            assert f'{amount:,.2f}' in text
            for row in source:
                assert row['VENDOR_NAME'] in text
            assert root.findall('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tbl')
            # OOXML text must match the deterministic generator's current output.
            with ZipFile(p.parent/'预付账款超期提示.docx') as generated:
                assert generated.read('word/document.xml') == xml
        checked.append({'company':company,'sourceRows':len(source),'sourceSha256':digest((p.parent.parent/'source/data.json').read_bytes()),
                        'documentXmlSha256':digest(xml),'sourceAmountsAndSupplierNamesMatch':True})
    # The first report must remain byte-identical after the second task and restart.
    first = load(directory/'0-evidence.json')
    first_receipt = next(a for a in first['artifacts'] if a['role'] == 'final')
    live = next((directory/'workspace').rglob(first_receipt['name']))
    assert digest(live.read_bytes()) == first_receipt['sha256']
    results.append({'id':directory.name,'documents':checked,'firstReportPreservedAfterFollowup':True})

for directory in sorted(args.snapshot.glob('report-hr-*')):
    evidence_path = directory/'0-evidence.json'
    if not evidence_path.exists() or load(evidence_path)['run']['status'] != 'completed':
        continue
    inputs = []
    analysis = None
    for p in (directory/'workspace').rglob('*.json'):
        if '.agentloop' in p.parts:
            continue
        document = load(p)
        if not isinstance(document, dict):
            continue
        for source in document.get('sources', []):
            value = source.get('value', {})
            analysis = value.get('computationReceipt', {}).get('facts', {}).get('analysis') or analysis
            stdout = value.get('stdout')
            if stdout:
                try:
                    parsed = json.loads(stdout)
                except ValueError:
                    continue
                if parsed.get('schema') == 'agentloop.hrReportData/v1' and parsed.get('action') == 'query-report':
                    inputs.append(parsed)
    assert analysis and len(inputs) == 1
    source = inputs[0]
    assert source['dataMode'] == analysis['dataMode'] == 'live'
    aggregates = defaultdict(float)
    counts = defaultdict(int)
    for row in source['rows']:
        key = (str(row['month']), row['organization_code'], row['metric'])
        aggregates[key] += float(row['amount'])
        counts[key] += 1
    observations = 0
    for series in analysis['metricSeries']['items']:
        for observation in series['observations']:
            assert math.isclose(observation['amount'], aggregates[(observation['month'], series['organization']['code'], series['metric'])])
            observations += 1
    ratios = 0
    for ratio in analysis['subsetRatios']['items']:
        key = (ratio['month'], ratio['organization']['code'])
        numerator = aggregates[(*key, ratio['numeratorMetric'])]
        denominator = aggregates[(*key, ratio['denominatorMetric'])]
        assert numerator == ratio['numerator'] and denominator == ratio['denominator']
        if ratio['computable']:
            assert math.isclose(ratio['value'], numerator/denominator)
        ratios += 1
    assert analysis['metricSeries']['totalCount'] == len(aggregates)
    assert observations <= len(aggregates)
    assert analysis['metricSeries']['truncated'] == (observations < len(aggregates))
    assert analysis['inputQuality']['duplicateGrainRowCount'] == sum(n-1 for n in counts.values())
    html_file = next((directory/'delivered').glob('*.html'))
    html = html_file.read_text()
    assert 'data:image/svg+xml' in html or '<svg' in html or '<table' in html
    assert '青年' in html and '党员' in html and '2026' in html
    results.append({'id':directory.name,'sourceMode':'live','sourceRows':len(source['rows']),
                    'independentlyRecomputedObservations':observations,'independentlyRecomputedRatios':ratios,
                    'duplicateHandlingMatches':True,'totalMetricSeries':len(aggregates),
                    'metricSeriesTruncated':analysis['metricSeries']['truncated'],
                    'coverageLimitationVisibleInHtml':('截断' in html or 'truncat' in html.lower()),
                    'businessAcceptance':'incomplete' if analysis['metricSeries']['truncated'] else 'verified_values',
                    'artifactSha256':digest(html_file.read_bytes())})

args.output.write_text(json.dumps({'schema':'agentloop.hostReplayBusinessAssertions/v1','results':results},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'checkedSuites':len(results),'output':str(args.output)}))
if any(result.get('businessAcceptance') == 'incomplete' for result in results):
    print('Business coverage acceptance remains incomplete; see exported counts and limitations.')
    sys.exit(2)

#!/usr/bin/env python3
"""Host-only, reversible catalog update for observed period encodings."""
import argparse, json, sys
from pathlib import Path
from copy import deepcopy
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'skills/data-analysis/scripts'))
from gateway.store import CatalogStore
from runtime_config import connections
SOURCE = 't_ads_fact_bwg_ind_all_03_real'
FIELD = 'date_time'
NEW = [
 {'source_id': SOURCE, 'field': FIELD, 'format': '%Y%m', 'granularity': 'month',
  'selector': {'field': 'time_type', 'value': 'M', 'period_length': 6},
  'description': 'time_type=M 且六位期间的月度记录；来自只读分组探查。'},
 {'source_id': SOURCE, 'field': FIELD, 'format': '%Y%m%d', 'granularity': 'day',
  'selector': {'field': 'time_type', 'value': 'D', 'period_length': 8},
  'description': 'time_type=D 且八位期间的日度记录；来自只读分组探查。'}]

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 choice=parser.add_mutually_exclusive_group(required=True)
 choice.add_argument('--apply',action='store_true')
 choice.add_argument('--rollback-file',type=Path)
 args=parser.parse_args()
 store=CatalogStore(connections())
 with store.connect(readonly=False) as cur:
  cur.execute('SELECT config FROM scenarios WHERE id=%s FOR UPDATE',('group',))
  row=cur.fetchone()
  if not row: raise RuntimeError('group scenario absent')
  raw=json.loads(row['config']) if isinstance(row['config'],(str,bytes)) else row['config']
  old=[p for p in raw.get('period_formats',[]) if p.get('source_id')==SOURCE and p.get('field')==FIELD]
  if args.apply:
   if old==NEW: print('Already applied'); return
   if len(old)!=1 or old[0].get('format')!='%Y%m' or old[0].get('selector') is not None:
    raise RuntimeError('Unexpected catalog state; review before applying')
   backup=ROOT/'data/qa/plan-c-period-formats-before.json'
   backup.parent.mkdir(parents=True,exist_ok=True)
   if backup.exists(): raise RuntimeError('Rollback snapshot already exists')
   backup.write_text(json.dumps(old,ensure_ascii=False,indent=2)+'\n')
   replacement=NEW
   print('Rollback file:',backup)
  else:
   if old!=NEW: raise RuntimeError('Catalog changed after migration; refusing rollback')
   replacement=json.loads(args.rollback_file.read_text())
   if not isinstance(replacement,list): raise RuntimeError('Rollback file must contain a list')
  candidate=deepcopy(raw)
  candidate['period_formats']=[p for p in raw.get('period_formats',[]) if not (p.get('source_id')==SOURCE and p.get('field')==FIELD)]+replacement
  cur.execute('UPDATE scenarios SET config=%s WHERE id=%s',(json.dumps(candidate,ensure_ascii=False),'group'))
 print('Updated period definitions:',len(replacement))
if __name__=='__main__': main()

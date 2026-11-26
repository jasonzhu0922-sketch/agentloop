/** Local accepted conversations survive projection lag; authoritative pages are merged by identity. */
export function createHistoryState(storage = sessionStorage) {
  const key = 'data-agent-pending-history-v1';
  let local;
  try { local = new Map(JSON.parse(storage.getItem(key) || '[]')); } catch { local = new Map(); }
  const persist = () => { try { storage.setItem(key, JSON.stringify([...local])); } catch { /* Storage quota cannot stop execution or event rendering. */ } };
  const snapshot = run => Object.fromEntries(['id','conversationId','input','output','status','createdAt','finishedAt','modelKey','errorCode','artifacts'].filter(key=>run[key]!==undefined).map(key=>[key,run[key]]));
  return {
    accept(run) { local.set(run.conversationId, { id: run.conversationId, title: run.input.slice(0,80), createdAt:run.createdAt, updatedAt:Date.now(), lastRunId:run.id,lastRunStatus:run.status, run:snapshot(run) }); persist(); },
    update(run) { const prior=local.get(run.conversationId);if(prior){local.set(run.conversationId,{...prior,lastRunStatus:run.status,run:snapshot(run)});persist();} },
    remove(id) { local.delete(id);persist(); },
    get(id) { return local.get(id); },
    runs(id, runs) { const pending=local.get(id);return [...new Map([...runs,...(pending?[pending.run]:[])].map(run=>[run.id,run])).values()].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id)); },
    merge(items) {
      const merged=new Map(items.map(item=>[item.id,item]));
      for(const [id,pending] of local){
        const saved=merged.get(id);
        // Only retire the optimistic entry once SQL has caught up to this accepted Run and terminal state.
        if(saved?.lastRunId===pending.lastRunId && saved.lastRunStatus===pending.lastRunStatus && pending.lastRunStatus!=='running'){local.delete(id);continue;}
        merged.set(id,{...saved,...pending});
      }
      persist();return [...merged.values()].sort((a,b)=>b.updatedAt-a.updatedAt || b.id.localeCompare(a.id));
    }
  };
}

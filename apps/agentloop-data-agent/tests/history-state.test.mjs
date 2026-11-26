import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryState } from '../web/history-state.js';
function storage(){const entries=new Map();return {getItem:k=>entries.get(k),setItem:(k,v)=>entries.set(k,v)};}
test('accepted conversation survives lag, refresh, stale active pages and merges without duplicates',()=>{
 const store=storage(),state=createHistoryState(store),run={id:'r',conversationId:'c',input:'问题',createdAt:1,status:'running'};
 state.accept(run);assert.equal(state.merge([]).length,1);
 const restarted=createHistoryState(store);assert.equal(restarted.merge([])[0].id,'c');
 assert.equal(restarted.merge([{id:'c',lastRunId:'r',lastRunStatus:'completed',updatedAt:0}])[0].lastRunStatus,'running');
 assert.equal(restarted.runs('c',[])[0].id,'r');
 restarted.update({...run,status:'completed',output:'成果'});assert.equal(restarted.runs('c',[{...run,status:'running'}])[0].status,'completed');assert.equal(restarted.merge([{id:'c',lastRunId:'r',lastRunStatus:'running',updatedAt:0}])[0].lastRunStatus,'completed');
 const caughtUp=[{id:'c',lastRunId:'r',lastRunStatus:'completed',title:'数据库标题',updatedAt:3}];assert.equal(restarted.merge(caughtUp).length,1);assert.equal(restarted.get('c'),undefined);
 restarted.remove('c');assert.equal(createHistoryState(store).merge([]).length,0);
});

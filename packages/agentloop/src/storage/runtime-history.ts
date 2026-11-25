import type { SqlConnection } from './connection.ts';
import type { RuntimePersistence } from './runtime-records.ts';
import type { RuntimeArchiveStore } from './runtime-record-maintenance.ts';

/** Object versions belong to an entity, never to a Run event sequence. */
export interface RuntimeHistoryUpdate {
  objectId: string; kind: string; version: number; deleted: boolean;
  ownerId: string; conversationId: string; runId: string; planId: string;
  updatedAt: number; payload: Record<string, any>;
}
export interface RuntimeHistoryTask extends RuntimeHistoryUpdate { pendingAt: number; attempts: number; nextAttemptAt: number; error?: string }
export interface RuntimeHistoryOutbox {
  pending(limit: number, now?: number): Promise<RuntimeHistoryTask[]>;
  acknowledge(tasks: readonly RuntimeHistoryTask[], now?: number): Promise<void>;
  retry(tasks: readonly RuntimeHistoryTask[], error: string, delayMs: number, now?: number): Promise<void>;
  status(now?: number): Promise<Record<string, unknown>>;
  /** Used after immutable content has been verified; update and pending registration are atomic. */
  publish(update: Omit<RuntimeHistoryUpdate, 'version' | 'updatedAt'>): Promise<void>;
}
export interface RuntimeHistorySink { writeBatch(namespace: string, updates: readonly RuntimeHistoryUpdate[]): Promise<void>; close?(): Promise<void> }
export interface RuntimeHistoryConversation {
  id: string; title: string; ownerUserId?: string; createdAt: number; updatedAt: number;
  lastRunId?: string; lastRunStatus?: string | null; runCount?: number; summary?: string; historyVersion?: number;
}
export interface RuntimeHistoryRun {
  id: string; ownerUserId: string; depth?: number; modelKey?: string | null; conversationId?: string | null; parentRunId?: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; input: string; output?: string | null; errorCode?: string | null;
  createdAt: number; finishedAt?: number | null; historyVersion?: number; dataSource?: string;
  plans?: readonly Record<string, any>[]; steps?: readonly Record<string, any>[]; revisions?: readonly Record<string, any>[];
  outcome?: Record<string, any>; results?: readonly Record<string, any>[]; artifacts?: readonly Record<string, any>[];
  archives?: readonly { key: string; sha256: string; lastEventSeq: number }[]; usage?: Record<string, number>;
}
export interface RuntimeHistoryReader {
  listConversations(ownerId: string, page?: { limit?: number; cursor?: string }): Promise<{ conversations: RuntimeHistoryConversation[]; hasMore: boolean; nextCursor?: string }>;
  getConversation(ownerId: string, id: string): Promise<{ conversation: RuntimeHistoryConversation; runs: RuntimeHistoryRun[] } | undefined>;
  getRun(ownerId: string, id: string): Promise<RuntimeHistoryRun | undefined>;
}
export type RuntimeHistoryStore = RuntimeHistoryReader & RuntimeHistorySink;

/** This allowlist is the semantic commit trigger: streaming/events/Action observations never enqueue. */
export function historyUpdates(table: string, identity: string, before: any, row: any): Omit<RuntimeHistoryUpdate, 'version' | 'updatedAt'>[] {
  if (!['conversations', 'runs', 'plans', 'plan_steps', 'plan_revision_snapshots', 'run_outcomes', 'run_round_results', 'run_input_messages', 'sources', 'run_sources'].includes(table)) return [];
  const source = row ?? before;
  if (!source || JSON.stringify(before) === JSON.stringify(row)) return [];
  let payload = row;
  if (table === 'plan_steps' && row) {
    const evidence = row.evidence_json ? JSON.parse(row.evidence_json) : null;
    payload = { ...row, evidence_json: evidence ? JSON.stringify({ publishedResult: evidence.publishedResult, deliveryCandidate: evidence.deliveryCandidate }) : null };
  }
  const base = { objectId: identity, kind: table, deleted: !row,
    ownerId: source.owner_user_id ?? '', conversationId: source.conversation_id ?? '', runId: source.run_id ?? (table === 'runs' ? source.id : ''),
    planId: source.plan_id ?? (table === 'plans' ? source.id : ''), payload: payload ?? {} };
  const updates = [base];
  // Accepted artifacts retain stable paths and checksums, never signed URLs. The complete producer remains in the file archive.
  if (['plan_steps', 'run_outcomes', 'run_round_results'].includes(table)) {
    const visit = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.path === 'string' && typeof value.sha256 === 'string' && typeof value.bytes === 'number') {
        updates.push({ ...base, objectId: `${identity}:artifact:${Buffer.from(value.path).toString('base64url')}`, kind: 'artifacts',
          payload: { name: value.path.split('/').at(-1), type: value.path.split('.').at(-1), bytes: value.bytes, sha256: value.sha256, storageRef: value.path, ...value } });
      }
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && (key.endsWith('_json') || key === 'content')) { try { visit(JSON.parse(child)); } catch {} }
        else if (typeof child === 'object') visit(child);
      }
    };
    visit(payload ?? before);
    if (table === 'plan_steps') {
      const evidence = source.evidence_json ? JSON.parse(source.evidence_json) : {};
      if (evidence.publishedResult) updates.push({ ...base, kind: 'results', objectId: `${identity}:result`, payload: row ? { result: evidence.publishedResult } : {} });
    }
  }
  return updates;
}

/** Durable queue consumer. SQL commit precedes CAS acknowledgement; multiple consumers need no lease. */
export class RuntimeHistoryWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<void>;
  private closed = false;
  private readonly options: { outbox: RuntimeHistoryOutbox; sink: RuntimeHistorySink; namespace: string; state?: RuntimePersistence; batchSize?: number; intervalMs?: number; retryBaseMs?: number; retryMaxMs?: number; onError?: (error: Error) => void };
  constructor(options: RuntimeHistoryWorker['options']) {
    this.options = options;
    for (const value of [options.batchSize ?? 100, options.intervalMs ?? 1000, options.retryBaseMs ?? 1000, options.retryMaxMs ?? 60000]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid history worker limits');
    if ((options.batchSize ?? 100) > 1000) throw new TypeError('History batch exceeds 1000');
  }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => { this.timer = undefined; void this.drain().catch(error => this.options.onError?.(error)).finally(() => {
      if (!this.closed) { this.timer = setTimeout(tick, this.options.intervalMs ?? 1000); this.timer.unref(); }
    }); };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  drain(): Promise<void> { return this.current ??= this.process().finally(() => { this.current = undefined; }); }
  private async process() {
    const { outbox, sink, namespace } = this.options;
    const tasks = await outbox.pending(this.options.batchSize ?? 100);
    if (!tasks.length) return;
    try {
      const updates = [] as RuntimeHistoryUpdate[];
      for (const task of tasks) {
        let payload=task.payload;
        if(this.options.state && task.kind==='runs' && !task.deleted && payload.status!=='running') {
          const state=this.options.state;
          const planning=(await state.records.find('run_planning_budgets',{run_id:task.runId}))[0];
          const intent=(await state.records.find('run_intent_budgets',{run_id:task.runId}))[0];
          const usage: Record<string,number> = {planningTurns:planning?.used_turns ?? 0,intentTurns:intent?.used_turns ?? 0};
          if(state.eventPage) { let cursor=0;for(;;){const events=await state.eventPage(task.runId,cursor,500);for(const event of events)if(event.type==='model.request.completed'){
            const data=JSON.parse(event.payload_json),tokens=data.usage ?? {};for(const key of ['inputTokens','outputTokens','totalTokens'])if(typeof tokens[key]==='number')usage[key]=(usage[key]??0)+tokens[key];
          }if(events.length<500)break;cursor=events.at(-1)!.seq;} }
          payload={...payload,usage};
        }
        updates.push({...task,payload});
      }
      await sink.writeBatch(namespace, updates); await outbox.acknowledge(tasks);
    }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu, '<url>').slice(0, 1000);
      const attempts = Math.max(...tasks.map(task => task.attempts));
      await outbox.retry(tasks, message, Math.min(this.options.retryMaxMs ?? 60000, (this.options.retryBaseMs ?? 1000) * 2 ** Math.min(attempts, 12)));
      this.options.onError?.(new Error(message));
    }
  }
  async close() { this.closed = true; if (this.timer) clearTimeout(this.timer); await this.current; await this.options.sink.close?.(); }
}

/** SQL stores one versioned entity per row; events, model deltas and Action observations have no SQL table. */
export class SqlRuntimeHistoryStore implements RuntimeHistoryStore {
  private connection?: Promise<SqlConnection>;
  private readonly options: { connect: () => Promise<SqlConnection>; namespace: string; content?: RuntimeArchiveStore };
  constructor(options: SqlRuntimeHistoryStore['options']) { this.options = options; }
  private async db() {
    return await (this.connection ??= (async () => {
      const db = await this.options.connect();
      try {
        await db.exec(`CREATE TABLE IF NOT EXISTS runtime_history_objects (
          namespace VARCHAR(180) NOT NULL, kind VARCHAR(40) NOT NULL, object_id VARCHAR(191) NOT NULL,
          entity_id VARCHAR(191) NOT NULL, version BIGINT NOT NULL, deleted INT NOT NULL, owner_id VARCHAR(191) NOT NULL,
          conversation_id VARCHAR(191) NOT NULL, run_id VARCHAR(191) NOT NULL, plan_id VARCHAR(191) NOT NULL,
          updated_at BIGINT NOT NULL, payload_json ${db.dialect === 'tidb' ? 'LONGTEXT' : 'TEXT'} NOT NULL,
          PRIMARY KEY(namespace,kind,object_id))`);
        // Indexes are part of the initial schema, avoiding DDL in any execution transaction.
        const indexes = [['owner', 'namespace,kind,owner_id,deleted,updated_at,object_id'], ['conversation', 'namespace,kind,conversation_id,deleted'], ['run', 'namespace,kind,run_id,deleted'], ['plan', 'namespace,kind,plan_id,deleted'], ['entity', 'namespace,kind,entity_id,deleted']];
        for (const [name, columns] of indexes) {
          try { await db.exec(`CREATE INDEX runtime_history_${name} ON runtime_history_objects(${columns})`); }
          catch (error) { if (!/already exists|Duplicate key name/i.test(String(error))) throw error; }
        }
        return db;
      } catch (error) { await db.close().catch(() => {}); this.connection = undefined; throw error; }
    })().catch(error => { this.connection = undefined; throw error; }));
  }
  async writeBatch(namespace: string, updates: readonly RuntimeHistoryUpdate[]) {
    if (namespace !== this.options.namespace) throw new TypeError('History namespace mismatch');
    const { createHash } = await import('node:crypto');
    const normalized = [] as RuntimeHistoryUpdate[];
    for (const update of updates) {
      let payload = update.payload;
      // Large result bodies use immutable verified storage. Metadata and small answers remain queryable.
      if (this.options.content && update.kind !== 'conversations' && Buffer.byteLength(JSON.stringify(payload)) > 65536) {
        const bytes = Buffer.from(JSON.stringify(payload)), sha256 = createHash('sha256').update(bytes).digest('hex'), key = `history-content/${sha256}.json`;
        await this.options.content.put(key, bytes, sha256); payload = { id: payload.id, run_id: payload.run_id, plan_id: payload.plan_id, contentRef: { key, sha256, bytes: bytes.length } };
      }
      normalized.push({ ...update, objectId: createHash('sha256').update(update.objectId).digest('hex'), payload });
    }
    if(!normalized.length)return;
    // Consistent lock order limits deadlocks between duplicate workers. Each transaction uses bounded multi-row INSERTs.
    normalized.sort((a,b)=>a.kind.localeCompare(b.kind) || a.objectId.localeCompare(b.objectId));
    const db=await this.db();
    const columns=['entity_id','owner_id','conversation_id','run_id','plan_id','updated_at','payload_json','deleted'];
    const condition=db.dialect==='tidb'
      ? columns.map(column=>`${column}=IF(VALUES(version)>version AND deleted=0,VALUES(${column}),${column})`).join(',')+',version=GREATEST(version,VALUES(version))'
      : columns.map(column=>`${column}=excluded.${column}`).join(',')+',version=excluded.version';
    await db.transaction(async()=>{
      let rows: import('./connection.ts').SqlValue[][]=[],bytes=0;
      const flush=async()=>{
        if(!rows.length)return;
        await db.prepare('INSERT INTO runtime_history_objects(namespace,kind,object_id,entity_id,version,deleted,owner_id,conversation_id,run_id,plan_id,updated_at,payload_json) VALUES '+rows.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')+
          (db.dialect==='tidb'?` ON DUPLICATE KEY UPDATE ${condition}`:` ON CONFLICT(namespace,kind,object_id) DO UPDATE SET ${condition} WHERE excluded.version>runtime_history_objects.version AND runtime_history_objects.deleted=0`)).run(...rows.flat());
        rows=[];bytes=0;
      };
      for(const update of normalized){
        const payload=JSON.stringify(update.payload),size=Buffer.byteLength(payload);
        if(rows.length && (rows.length>=50 || bytes+size>1024*1024))await flush();
        rows.push([namespace,update.kind,update.objectId,String(update.payload.id??update.payload.run_id??update.payload.plan_id??update.runId),update.version,update.deleted?1:0,update.ownerId,update.conversationId,update.runId,update.planId,update.updatedAt,payload]);bytes+=size;
      }
      await flush();
    });
  }
  private async entities(kind: string, filter: string, values: any[], order = 'object_id') {
    const db = await this.db();
    const rows = await db.prepare(`SELECT * FROM runtime_history_objects WHERE namespace=? AND kind=? AND deleted=0 ${filter} ORDER BY ${order}`).all<any>(this.options.namespace, kind, ...values);
    return await Promise.all(rows.map(async row => {
      let payload=JSON.parse(row.payload_json);
      if(payload.contentRef){
        if(!this.options.content?.get)throw new Error('History content store is unavailable');
        const {createHash}=await import('node:crypto'),bytes=await this.options.content.get(payload.contentRef.key);
        if(createHash('sha256').update(bytes).digest('hex')!==payload.contentRef.sha256)throw new Error('History content checksum mismatch');
        payload=JSON.parse(Buffer.from(bytes).toString());
      }
      return {...row,payload};
    }));
  }
  async listConversations(ownerId: string, page: { limit?: number; cursor?: string } = {}) {
    const limit = page.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Invalid history page size');
    const cursor = page.cursor ? JSON.parse(Buffer.from(page.cursor, 'base64url').toString()) : undefined;
    if (cursor && (!Number.isSafeInteger(cursor.time) || typeof cursor.id !== 'string')) throw new TypeError('Invalid history cursor');
    const rows = await this.entities('conversations', `AND owner_id=? ${cursor ? 'AND (updated_at<? OR (updated_at=? AND object_id<?))' : ''}`,
      [ownerId, ...(cursor ? [cursor.time, cursor.time, cursor.id] : [])], `updated_at DESC,object_id DESC LIMIT ${limit + 1}`);
    const visible = rows.slice(0, limit), conversations = [] as any[];
    for (const row of visible) {
      const runs = await this.entities('runs', 'AND conversation_id=? AND owner_id=?', [row.payload.id, ownerId]);
      const ordered = runs.map(r => r.payload).filter(r => !r.parent_run_id).sort((a,b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      const last = ordered.at(-1);
      conversations.push({ id: row.payload.id, title: row.payload.title, ownerUserId: ownerId, createdAt: row.payload.created_at, updatedAt: Number(row.updated_at),
        runCount: ordered.length, lastRunId: last?.id, lastRunStatus: last?.status ?? null, summary: (last?.output ?? last?.input ?? '').slice(0, 240), historyVersion: Number(row.version) });
    }
    const last = visible.at(-1);
    return { conversations, hasMore: rows.length > limit, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ time: Number(last.updated_at), id: last.object_id })).toString('base64url') } : {}) };
  }
  async getConversation(ownerId: string, id: string) {
    const conversation = (await this.entities('conversations', 'AND owner_id=? AND entity_id=?', [ownerId,id]))[0];
    if (!conversation) return undefined;
    const rows = await this.entities('runs', 'AND conversation_id=? AND owner_id=?', [id, ownerId]);
    const runs = await Promise.all(rows.map(row => row.payload).filter(row => !row.parent_run_id).sort((a,b) => a.created_at - b.created_at || a.id.localeCompare(b.id)).map(row => this.getRun(ownerId, row.id)));
    return { conversation: { id, title: conversation.payload.title, createdAt: conversation.payload.created_at, updatedAt: Number(conversation.updated_at) }, runs: runs.filter((run): run is NonNullable<typeof run> => Boolean(run)) };
  }
  async getRun(ownerId: string, id: string): Promise<RuntimeHistoryRun | undefined> {
    const row = (await this.entities('runs', 'AND owner_id=? AND run_id=?', [ownerId, id]))[0];
    if (!row) return undefined;
    const raw = row.payload;
    const plans = await this.entities('plans', 'AND run_id=?', [id]);
    const planSteps = (await Promise.all(plans.map(plan => this.entities('plan_steps', 'AND plan_id=?', [plan.payload.id])))).flat();
    const outcome = (await this.entities('run_outcomes', 'AND run_id=?', [id]))[0]?.payload;
    const artifactRows = [...await this.entities('artifacts', 'AND run_id=?', [id]), ...(await Promise.all(plans.map(plan => this.entities('artifacts', 'AND plan_id=?', [plan.payload.id])))).flat()];
    const artifacts = [...new Map(artifactRows.map(row=>[`${row.payload.path ?? row.payload.storageRef}:${row.payload.sha256}`,row.payload])).values()];
    return { id, ownerUserId: ownerId, conversationId: raw.conversation_id, parentRunId: raw.parent_run_id, depth: raw.depth, modelKey: raw.model_key, status: raw.status,
      usage: raw.usage, input: raw.input, output: raw.output, errorCode: raw.error_code, createdAt: raw.created_at, finishedAt: raw.finished_at,
      plans: plans.map(r => r.payload), steps: planSteps.map(r => r.payload), outcome, artifacts,
      results: [...await this.entities('results', 'AND run_id=?', [id]), ...(await Promise.all(plans.map(plan => this.entities('results', 'AND plan_id=?', [plan.payload.id])))).flat()].map(r => r.payload),
      revisions: (await Promise.all(plans.map(plan => this.entities('plan_revision_snapshots', 'AND plan_id=?', [plan.payload.id])))).flat().map(r => r.payload),
      archives: (await this.entities('archives', 'AND run_id=?', [id])).map(r => r.payload), historyVersion: Number(row.version), dataSource: 'history' };
  }
  async close() { const connection = this.connection; this.connection = undefined; if (connection) await (await connection).close(); }
}

/** SQLite hosts retain their canonical SQLite history, without a second engine or worker. */
export class PersistenceRuntimeHistoryReader implements RuntimeHistoryReader {
  private readonly state: RuntimePersistence;
  constructor(state: RuntimePersistence) { this.state = state; }
  async listConversations(ownerId: string, page: { limit?: number; cursor?: string } = {}) {
    const rows = (await this.state.records.find('conversations', { owner_user_id: ownerId })).sort((a,b) => b.updated_at-a.updated_at || b.id.localeCompare(a.id));
    const cursor = page.cursor ? JSON.parse(Buffer.from(page.cursor, 'base64url').toString()) : undefined;
    const selected = rows.filter(r => !cursor || r.updated_at<cursor.time || r.updated_at===cursor.time && r.id<cursor.id).slice(0,(page.limit ?? 50)+1);
    const visible = selected.slice(0,page.limit ?? 50), last = visible.at(-1);
    return { conversations: visible.map(r => ({ id:r.id,title:r.title,createdAt:r.created_at,updatedAt:r.updated_at })), hasMore:selected.length>visible.length,
      ...(selected.length>visible.length && last ? { nextCursor:Buffer.from(JSON.stringify({time:last.updated_at,id:last.id})).toString('base64url') } : {}) };
  }
  async getConversation(ownerId: string,id: string) {
    const row=(await this.state.records.find('conversations',{id,owner_user_id:ownerId}))[0]; if(!row)return;
    const rows=await this.state.records.find('runs',{conversation_id:id,owner_user_id:ownerId,parent_run_id:null});
    return {conversation:{id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at},runs:(await Promise.all(rows.sort((a,b)=>a.created_at-b.created_at || a.id.localeCompare(b.id)).map(row=>this.getRun(ownerId,row.id)))).filter((run):run is NonNullable<typeof run>=>Boolean(run))};
  }
  async getRun(ownerId: string,id: string) {
    const row=(await this.state.records.find('runs',{id,owner_user_id:ownerId}))[0];if(!row)return;
    const plans=await this.state.records.find('plans',{run_id:id});
    return {id:row.id,ownerUserId:row.owner_user_id,conversationId:row.conversation_id,parentRunId:row.parent_run_id,status:row.status,input:row.input,output:row.output,errorCode:row.error_code,createdAt:row.created_at,finishedAt:row.finished_at,
      plans,steps:(await Promise.all(plans.map(plan=>this.state.records.find('plan_steps',{plan_id:plan.id})))).flat(),outcome:(await this.state.records.find('run_outcomes',{run_id:id}))[0]};
  }
}

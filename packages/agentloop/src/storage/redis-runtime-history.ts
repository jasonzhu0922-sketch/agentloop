import { createHash } from 'node:crypto';
import type { RuntimeRedisPort } from './redis-runtime-state-store.ts';
import type { RuntimeHistoryOutbox, RuntimeHistoryTask, RuntimeHistoryUpdate } from './runtime-history.ts';

/** All keys share the execution namespace/hash slot. Entries and acknowledgements survive restarts. */
export class RedisRuntimeHistoryOutbox implements RuntimeHistoryOutbox {
  private readonly redis: RuntimeRedisPort;
  private readonly prefix: string;
  constructor(redis: RuntimeRedisPort, prefix: string) { this.redis = redis; this.prefix = prefix; }
  async pending(limit: number, now = Date.now()): Promise<RuntimeHistoryTask[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid history batch size');
    const script = `local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,ARGV[2]); local rows={}; for _,id in ipairs(ids) do local row=redis.call('HGET',KEYS[2],id); if row then table.insert(rows,row) end end; return rows`;
    return (await this.redis.sendCommand(['EVAL', script, '2', `${this.prefix}:history:due`, `${this.prefix}:history:tasks`, String(now), String(limit)]) as string[]).map(row => {
      const {payloadJson,...task}=JSON.parse(row);
      return {...task,payload:payloadJson===undefined?task.payload:JSON.parse(payloadJson)};
    });
  }
  async acknowledge(tasks: readonly RuntimeHistoryTask[], now = Date.now()) {
    const script = `for _,task in ipairs(cjson.decode(ARGV[1])) do local raw=redis.call('HGET',KEYS[1],task.objectId); if raw then local current=cjson.decode(raw); if current.version==task.version then redis.call('HDEL',KEYS[1],task.objectId); redis.call('ZREM',KEYS[2],task.objectId); redis.call('ZREM',KEYS[3],task.objectId); redis.call('HSET',KEYS[4],'lastSuccessAt',ARGV[2],'lastLatencyMs',tonumber(ARGV[2])-current.pendingAt); redis.call('HINCRBY',KEYS[4],'acknowledged',1) end end end; return 1`;
    await this.redis.sendCommand(['EVAL',script,'4',`${this.prefix}:history:tasks`,`${this.prefix}:history:due`,`${this.prefix}:history:age`,`${this.prefix}:history:metrics`,JSON.stringify(tasks.map(t=>({objectId:t.objectId,version:t.version}))),String(now)]);
  }
  async retry(tasks: readonly RuntimeHistoryTask[], error: string, delayMs: number, now = Date.now()) {
    const script = `for _,task in ipairs(cjson.decode(ARGV[1])) do local raw=redis.call('HGET',KEYS[1],task.objectId); if raw then local current=cjson.decode(raw); if current.version==task.version then current.attempts=current.attempts+1; current.error=ARGV[2]; current.nextAttemptAt=tonumber(ARGV[3]); redis.call('HSET',KEYS[1],task.objectId,cjson.encode(current)); redis.call('ZADD',KEYS[2],ARGV[3],task.objectId) end end end; redis.call('HSET',KEYS[3],'lastError',ARGV[2],'lastFailureAt',ARGV[4]); redis.call('HINCRBY',KEYS[3],'retries',1); return 1`;
    await this.redis.sendCommand(['EVAL',script,'3',`${this.prefix}:history:tasks`,`${this.prefix}:history:due`,`${this.prefix}:history:metrics`,JSON.stringify(tasks.map(t=>({objectId:t.objectId,version:t.version}))),error,String(now+delayMs),String(now)]);
  }
  async status(now=Date.now()) {
    const script = `return {redis.call('ZCARD',KEYS[1]),redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES'),redis.call('HGETALL',KEYS[2])}`;
    const [count, oldest, fields] = await this.redis.sendCommand(['EVAL',script,'2',`${this.prefix}:history:age`,`${this.prefix}:history:metrics`]) as [number,string[],string[]];
    const metrics = Object.fromEntries(Array.from({length:fields.length/2},(_,i)=>[fields[i*2],fields[i*2+1]]));
    return { pendingCount:Number(count),oldestAgeMs:oldest.length?now-Number(oldest[1]):0,...metrics };
  }
  async publish(update: Omit<RuntimeHistoryUpdate,'version'|'updatedAt'>) {
    const script = `local run=redis.call('HGET',KEYS[6],'data'); if not run or run=='null' then return 0 end; local tracked=redis.call('HGET',KEYS[1],KEYS[6]); if not tracked or cjson.decode(tracked).deleted then return 0 end; local entry=cjson.decode(ARGV[1]); local current=redis.call('HGET',KEYS[1],entry.objectId); if current then current=cjson.decode(current); if current.deleted or current.payloadChecksum==entry.payloadChecksum then return 0 end end; entry.version=redis.call('HINCRBY',KEYS[2],entry.objectId,1); entry.updatedAt=tonumber(ARGV[2]); local pending=redis.call('HGET',KEYS[3],entry.objectId); entry.pendingAt=pending and cjson.decode(pending).pendingAt or entry.updatedAt; entry.nextAttemptAt=entry.updatedAt; entry.attempts=0; redis.call('HSET',KEYS[1],entry.objectId,cjson.encode(entry)); redis.call('HSET',KEYS[3],entry.objectId,cjson.encode(entry)); redis.call('ZADD',KEYS[4],entry.updatedAt,entry.objectId); redis.call('ZADD',KEYS[5],entry.pendingAt,entry.objectId); return 1`;
    const {payload,...metadata}=update;
    const payloadJson=JSON.stringify(payload);
    await this.redis.sendCommand(['EVAL',script,'6',`${this.prefix}:history:objects`,`${this.prefix}:history:versions`,`${this.prefix}:history:tasks`,`${this.prefix}:history:due`,`${this.prefix}:history:age`,`${this.prefix}:r:runs:${createHash('sha256').update(JSON.stringify([update.runId])).digest('hex')}`,JSON.stringify({...metadata,payloadJson,payloadChecksum:createHash('sha256').update(payloadJson).digest('hex')}),String(Date.now())]);
  }
}

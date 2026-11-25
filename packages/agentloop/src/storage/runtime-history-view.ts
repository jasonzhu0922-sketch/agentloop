import { createHash } from 'node:crypto';
import type { RuntimeHistoryReader } from './runtime-history.ts';
import type { RuntimePersistence } from './runtime-records.ts';
import type { RuntimeArchiveStore } from './runtime-record-maintenance.ts';
import { AppError } from '../shared/errors.ts';
import type { RunService } from '../runtime/run-service.ts';
import { previewProcessArtifactContent, type ProcessArtifact } from '../runtime/process-artifacts.ts';

/** One query boundary for hosts: live execution wins; finished content comes from the history reader. */
export class RuntimeHistoryView {
  private readonly state: RuntimePersistence;
  private readonly reader: RuntimeHistoryReader;
  private readonly live: RunService;
  private readonly archives?: RuntimeArchiveStore;
  constructor(state: RuntimePersistence, reader: RuntimeHistoryReader, live: RunService, archives?: RuntimeArchiveStore) { this.state=state;this.reader=reader;this.live=live;this.archives=archives; }
  listConversations(owner: string, page?: { limit?: number; cursor?: string }) { return this.reader.listConversations(owner,page); }
  async getConversation(owner: string,id: string) {
    const history = await this.reader.getConversation(owner,id);
    const active = await this.state.records.find('runs',{owner_user_id:owner,conversation_id:id,status:'running',parent_run_id:null});
    if (!history && !active.length) throw new AppError('NOT_FOUND','Conversation history is not available yet',404);
    const runs = new Map((history?.runs ?? []).map(run=>[run.id,run]));
    // Never allow a late SQL running snapshot to override the canonical execution state.
    for (const run of [...runs.values()]) {
      const current = (await this.state.records.find('runs',{id:run.id,owner_user_id:owner}))[0];
      if (current?.status === 'running') runs.set(run.id,await this.live.get(owner,run.id));
      else if (run.status === 'running') throw new AppError('CONFLICT','成果正在入库，请稍后重试',503);
    }
    for (const row of active) runs.set(row.id,await this.live.get(owner,row.id));
    return { conversation:history?.conversation ?? (await this.live.getConversation(owner,id)).conversation,
      runs:[...runs.values()].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id)) };
  }
  async getRun(owner: string,id: string) {
    const current = (await this.state.records.find('runs',{id,owner_user_id:owner}))[0];
    if (current?.status === 'running') return { run:await this.live.get(owner,id),humanLoop:await this.live.currentHumanLoop(owner,id),dataSource:'runtime' as const };
    const run = await this.reader.getRun(owner,id);
    if (!run || run.status === 'running') throw new AppError('CONFLICT','成果正在入库，请稍后重试',503);
    return { run,humanLoop:null,artifacts:run.artifacts ?? [],dataSource:'history' as const };
  }
  async processArtifacts(owner:string,id:string) {
    const snapshot=await this.getRun(owner,id);
    return snapshot.dataSource==='runtime' ? await this.live.processArtifacts(owner,id) : snapshot.run.artifacts ?? [];
  }
  async readProcessArtifact(owner:string,id:string,artifactId:string) {
    const snapshot=await this.getRun(owner,id);
    if(snapshot.dataSource==='runtime')return await this.live.readProcessArtifact(owner,id,artifactId);
    const artifact=snapshot.run.artifacts?.find(a=>a.id===artifactId);
    if(!artifact)throw new AppError('NOT_FOUND','Artifact',404);
    if(artifact.storageKind!=='archive' || !this.archives?.get)throw new AppError('CONFLICT','产物正在归档，请稍后重试',503);
    const content=Buffer.from(await this.archives.get(artifact.storageRef));
    if(content.length!==artifact.bytes || createHash('sha256').update(content).digest('hex')!==artifact.sha256)throw new Error('History artifact checksum mismatch');
    return {artifact:artifact as ProcessArtifact,content};
  }
  async previewProcessArtifact(owner:string,id:string,artifactId:string) {
    const {artifact,content}=await this.readProcessArtifact(owner,id,artifactId);
    return previewProcessArtifactContent(artifact,content);
  }
  async eventsAfter(owner: string,id: string,after: number) {
    const current = (await this.state.records.find('runs',{id,owner_user_id:owner}))[0];
    if (current && this.state.eventPage) {
      const events: any[] = []; let cursor=after;
      for (;;) {
        const rows=await this.state.eventPage(id,cursor,500); events.push(...rows);
        if (rows.length<500) {
          const sequence=(await this.state.records.find('run_event_sequences',{run_id:id}))[0];
          const lastSeq=sequence ? sequence.next_seq-1 : undefined;
          const complete=events.every((row,index)=>row.seq===after+index+1)
            && lastSeq!==undefined && (events.at(-1)?.seq ?? after)>=lastSeq;
          if(current.status==='running' || complete) return events.map(row=>({seq:row.seq,type:row.type,data:JSON.parse(row.payload_json),createdAt:row.created_at}));
          break;
        }
        cursor=rows.at(-1)!.seq;
      }
    }
    const run=await this.reader.getRun(owner,id);
    if (!run) throw new AppError('NOT_FOUND','Run',404);
    if (!run.archives?.length || !this.archives?.get) throw new Error('Confirmed process archive is unavailable');
    const reference=run.archives.at(-1)!;
    const verified=async(key:string,sha256:string)=>{ const bytes=await this.archives!.get!(key);if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error('Process archive checksum mismatch');return JSON.parse(Buffer.from(bytes).toString()); };
    const manifest=await verified(reference.key,reference.sha256),events: any[]=[];
    if(manifest.schema!=='agentloop.runtimeArchive/v1' || manifest.summary.run.id!==id || manifest.summary.lastEventSeq!==reference.lastEventSeq) throw new Error('Process archive identity/version mismatch');
    let cursor=0;
    for(const segment of manifest.segments) {
      if(segment.firstSeq!==cursor+1 || segment.lastSeq<segment.firstSeq) throw new Error('Process archive sequence gap');
      if(segment.lastSeq>after) {
        const rows=await verified(segment.key,segment.sha256);
        if(rows.length!==segment.lastSeq-segment.firstSeq+1 || rows.some((row,index)=>row.seq!==segment.firstSeq+index || row.run_id!==id)) throw new Error('Process archive event gap/identity mismatch');
        events.push(...rows);
      }
      cursor=segment.lastSeq;
    }
    if(cursor!==reference.lastEventSeq) throw new Error('Process archive is incomplete');
    return events.filter(row=>row.seq>after).map(row=>({seq:row.seq,type:row.type,data:JSON.parse(row.payload_json),createdAt:row.created_at}));
  }
}

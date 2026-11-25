import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStateConnection } from "../src/storage/runtime-state-connection.ts";
import { RuntimeStateMaintenance } from "../src/storage/runtime-state-maintenance.ts";
import { AppDatabase } from "../src/storage/database.ts";
import type { RuntimeStateCommit, RuntimeStateStore } from "../src/storage/runtime-state-store.ts";
import type { SqlConnection } from "../src/storage/connection.ts";
class Store implements RuntimeStateStore {
  records: RuntimeStateCommit[]=[];
  async open() {} async close() {}
  async read(after:number,limit:number){return this.records.filter(record=>record.version>after).slice(0,limit);}
  async append(record:RuntimeStateCommit){this.records.push(record);}
  async receipt(id:string){return this.records.find(record=>record.id===id)?.version;}
}
test("archive advances with SQL offline; projection retries, is idempotent and deletes do not resurrect", async t=>{
  const directory=await mkdtemp(join(tmpdir(),"runtime-state-archive-")); t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(), state=await RuntimeStateConnection.open(store), db=await AppDatabase.open({connection:state}), sql=new AppDatabase(":memory:");
  t.after(async()=>{await db.close();await sql.close();});
  let offline=true;
  const sink:SqlConnection={dialect:"sqlite",async exec(query){if(offline)throw new Error("SQL unavailable");await sql.exec(query);},prepare(query){return sql.prepare(query);},transaction:operation=>sql.transaction(operation),close:async()=>{}};
  const worker=new RuntimeStateMaintenance({state,store,sink,archiveDirectory:directory,namespace:"fixture"});
  await db.prepare("INSERT INTO runs(id,owner_user_id,depth,allow_dangerous_tools,status,input,created_at) VALUES ('r','owner',0,0,'running','question',1)").run();
  await assert.rejects(worker.flush()); assert.ok(worker.status().archiveVersion>0);
  const names=await readdir(directory,{recursive:true}); assert.ok(names.some(name=>name.endsWith("cursor.json")));
  offline=false;await worker.flush();
  const first=await sql.prepare("SELECT * FROM runtime_run_records").get<any>();assert.equal(first.deleted,0);assert.equal(JSON.parse(first.payload_json).run.id,"r");
  await db.prepare("UPDATE runs SET status='completed',output='answer',finished_at=2 WHERE id='r'").run();
  await worker.flush();
  const terminal=await sql.prepare("SELECT * FROM runtime_run_records").get<any>(); assert.equal(JSON.parse(terminal.payload_json).run.output,"answer");
  const files=await readdir(directory,{recursive:true});const result=files.find(name=>name.endsWith("result.json"))!;
  assert.equal(JSON.parse(await readFile(join(directory,result),"utf8")).run.output,"answer");
  await db.prepare("DELETE FROM runs WHERE id='r'").run();await worker.flush();
  assert.equal((await sql.prepare("SELECT deleted FROM runtime_run_records").get<any>()).deleted,1);
  await worker.flush(); assert.equal((await sql.prepare("SELECT COUNT(*) AS count FROM runtime_run_records").get<any>()).count,1);
  await worker.close();
});

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AsyncResource } from "node:async_hooks";
import type { SqlConnection } from "./connection.ts";
import type { RuntimeStateStore } from "./runtime-state-store.ts";

async function atomicFile(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.pending`;
  const file = await open(temporary, "w", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  if (process.platform !== "win32") { const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); } }
}
const component = (id: string) => createHash("sha256").update(id).digest("hex");

/** Background consumers never run inside a domain transaction's async context. */
export class RuntimeStateMaintenance {
  private readonly options: { state: SqlConnection; store: RuntimeStateStore; sink: SqlConnection; archiveDirectory: string; namespace: string; intervalMs?: number };
  private readonly background = new AsyncResource("RuntimeStateMaintenance");
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private archiveVersion = 0;
  private schemaReady = false;
  private closed = false;
  private lastError?: string;
  private projectionVersion = 0;
  private projectedFingerprint?: string;
  private detailIndex?: Record<string, { key: string; path: string }>;
  constructor(options: RuntimeStateMaintenance["options"]) { this.options = options; }
  status() { return { archiveVersion: this.archiveVersion, projectionVersion: this.projectionVersion, error: this.lastError }; }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.background.runInAsyncScope(() => { void this.flush().catch(() => {}); }), this.options.intervalMs ?? 5000);
    this.timer.unref();
  }
  private root() { return join(this.options.archiveDirectory, component(this.options.namespace)); }
  async flush() {
    if (this.flight) return this.flight;
    this.flight = this.background.runInAsyncScope(async () => {
      // Archive and SQL are independent: a failed TiDB connection must not prevent
      // disk archival, nor should a broken disk hide the projection error.
      const results = await Promise.allSettled([this.archive(), this.project()]);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      this.lastError = errors.length ? "Runtime background archive/projection pending; retry scheduled" : undefined;
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), this.lastError);
    });
    try { await this.flight; } finally { this.flight = undefined; }
  }
  private async archive() {
    // Existing segments are authoritative for the cursor. Never trust an unverified
    // manifest that could skip an archive write after a crash.
    if (!this.archiveVersion) {
      try {
        const manifest = JSON.parse(await readFile(join(this.root(), "cursor.json"), "utf8"));
        if (!/^segments\/[0-9]+-[0-9]+\.json$/.test(manifest.segment)) throw new Error("Invalid Runtime archive segment path");
        const bytes = await readFile(join(this.root(), manifest.segment));
        if (createHash("sha256").update(bytes).digest("hex") !== manifest.checksum) throw new Error("Runtime archive checksum mismatch");
        const records = JSON.parse(bytes.toString("utf8"));
        if (records.at(-1)?.version !== manifest.version) throw new Error("Runtime archive cursor mismatch");
        this.archiveVersion = manifest.version;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (;;) {
      const records = await this.options.store.read(this.archiveVersion, 200);
      if (!records.length) break;
      if (records[0].version !== this.archiveVersion + 1) throw new Error("Runtime archive version gap");
      const last = records.at(-1)!.version;
      const segment = `segments/${records[0].version}-${last}.json`;
      const bytes = JSON.stringify(records);
      await atomicFile(join(this.root(), segment), bytes);
      await atomicFile(join(this.root(), "cursor.json"), JSON.stringify({ version: last, segment, checksum: createHash("sha256").update(bytes).digest("hex") }));
      this.archiveVersion = last;
      if (records.length < 200) break;
    }
    await this.archiveDetails();
  }
  private async project() {
    const { state, sink, namespace } = this.options;
    // Read one consistent view, then release the Runtime lock before remote I/O.
    const snapshots = await state.transaction(async () => {
      const runs = await state.prepare("SELECT * FROM runs").all<any>();
      const plans = await state.prepare("SELECT * FROM plans").all<any>();
      const steps = await state.prepare(`SELECT plan_id,step_id,kind,parent_step_id,position,objective,dependencies_json,role,
        refinement_state,required_facts_json,skill_ids_json,required_capabilities_json,recommended_tool_names_json,
        execution_binding_json,evidence_contract_json,success_criteria_json,status,error,started_at,finished_at FROM plan_steps`).all<any>();
      const outcomes = await state.prepare("SELECT * FROM run_outcomes").all<any>();
      const version = Number(state.diagnosticEnvironment?.().stateVersion ?? 0);
      return { version, runs: runs.map(run => ({ run,
        plans: plans.filter(plan => plan.run_id === run.id).map(plan => ({ ...plan, steps: steps.filter(step => step.plan_id === plan.id) })),
        outcome: outcomes.find(outcome => outcome.run_id === run.id) ?? null })) };
    });
    const payloads = snapshots.runs.map(item => {
      const terminal = item.run.status !== "running";
      return { item, payload: { run: terminal ? item.run : { id: item.run.id, owner_user_id: item.run.owner_user_id,
        conversation_id: item.run.conversation_id, input: item.run.input, created_at: item.run.created_at },
        plans: item.plans.map(plan => ({ ...plan, status: terminal ? plan.status : undefined, updated_at: terminal ? plan.updated_at : undefined,
          steps: plan.steps.map((step: any) => {
            const { evidence_json, output, repair_boundary_json, ...definition } = step;
            return terminal ? definition : { ...definition, status: undefined, started_at: undefined, finished_at: undefined, error: undefined };
          }) })),
        outcome: terminal ? item.outcome : null } };
    });
    const fingerprint = createHash("sha256").update(JSON.stringify(payloads.map(item => item.payload))).digest("hex");
    if (this.projectedFingerprint === fingerprint) return;
    if (!this.schemaReady) {
      const text = sink.dialect === "tidb" ? "LONGTEXT" : "TEXT";
      await sink.exec(`CREATE TABLE IF NOT EXISTS runtime_run_records (namespace VARCHAR(191) NOT NULL, run_id VARCHAR(191) NOT NULL,
        owner_user_id VARCHAR(191) NOT NULL, version BIGINT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, payload_json ${text} NOT NULL,
        PRIMARY KEY(namespace,run_id))`);
      this.schemaReady = true;
    }
    await sink.transaction(async () => {
      const known = await sink.prepare("SELECT run_id FROM runtime_run_records WHERE namespace=? AND deleted=0").all<{ run_id: string }>(namespace);
      const present = new Set(snapshots.runs.map(item => item.run.id));
      for (const { run_id } of known) if (!present.has(run_id)) await sink.prepare("UPDATE runtime_run_records SET deleted=1, version=?, payload_json='{}' WHERE namespace=? AND run_id=? AND version<=?")
        .run(snapshots.version, namespace, run_id, snapshots.version);
      for (const { item, payload } of payloads) {
        const values = [namespace, item.run.id, item.run.owner_user_id, snapshots.version, JSON.stringify(payload)];
        const sql = sink.dialect === "tidb"
          ? `INSERT INTO runtime_run_records(namespace,run_id,owner_user_id,version,payload_json) VALUES (?,?,?,?,?)
            ON DUPLICATE KEY UPDATE owner_user_id=IF(VALUES(version)>=version,VALUES(owner_user_id),owner_user_id),
            payload_json=IF(VALUES(version)>=version,VALUES(payload_json),payload_json), deleted=IF(VALUES(version)>=version,0,deleted), version=GREATEST(version,VALUES(version))`
          : `INSERT INTO runtime_run_records(namespace,run_id,owner_user_id,version,payload_json) VALUES (?,?,?,?,?)
            ON CONFLICT(namespace,run_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,version=excluded.version,payload_json=excluded.payload_json,deleted=0
            WHERE excluded.version>=runtime_run_records.version`;
        await sink.prepare(sql).run(...values);
      }
    });
    this.projectionVersion = snapshots.version;
    this.projectedFingerprint = fingerprint;
  }
  private async archiveDetails() {
    const state = this.options.state;
    const snapshots = await state.transaction(async () => ({
      runs: await state.prepare("SELECT * FROM runs WHERE status != 'running'").all<any>(),
      sequences: await state.prepare("SELECT run_id, MAX(seq) AS seq FROM run_events GROUP BY run_id").all<{run_id: string; seq: number}>(),
      present: new Set((await state.prepare("SELECT id FROM runs").all<{id:string}>()).map(row=>row.id)),
    }));
    if (!this.detailIndex) {
      try { this.detailIndex = JSON.parse(await readFile(join(this.root(), "details.json"), "utf8")); }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.detailIndex = {}; }
    }
    const detailIndex = this.detailIndex!;
    let changed = false;
    for (const [id, entry] of Object.entries(detailIndex)) if (!snapshots.present.has(id)) {
      if (!/^users\/[a-f0-9]{64}\/conversations\/[a-f0-9]{64}\/runs\/[a-f0-9]{64}\/result.json$/.test(entry.path)) throw new Error("Invalid archive detail path");
      await rm(dirname(join(this.root(), entry.path)), { recursive: true, force: true });
      delete detailIndex[id]; changed = true;
    }
    // A portable per-Run archive supports detail views independently of SQL.
    for (const run of snapshots.runs) {
      const key = createHash("sha256").update(JSON.stringify([run, snapshots.sequences.find(row=>row.run_id===run.id)?.seq ?? 0])).digest("hex");
      if (detailIndex[run.id]?.key === key) continue;
      const item = await state.transaction(async () => ({ run,
        plans: await state.prepare("SELECT * FROM plans WHERE run_id=?").all(run.id),
        steps: await state.prepare("SELECT steps.* FROM plan_steps steps JOIN plans ON plans.id=steps.plan_id WHERE plans.run_id=?").all(run.id),
        outcome: await state.prepare("SELECT * FROM run_outcomes WHERE run_id=?").get(run.id),
        actions: await state.prepare("SELECT * FROM runtime_actions WHERE run_id=?").all(run.id),
        humanLoops: await state.prepare("SELECT * FROM human_loop_requests WHERE run_id=?").all(run.id),
        events: await state.prepare("SELECT * FROM run_events WHERE run_id=? ORDER BY seq").all(run.id),
      }));
      const path = `users/${component(run.owner_user_id)}/conversations/${component(run.conversation_id ?? run.id)}/runs/${component(run.id)}/result.json`;
      await atomicFile(join(this.root(), path), JSON.stringify(item));
      detailIndex[run.id] = { key, path }; changed = true;
    }
    if (changed) await atomicFile(join(this.root(), "details.json"), JSON.stringify(this.detailIndex));
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.closed = true;
    // Explicit shutdown may attempt final projection; failures remain pending in
    // Redis and must not prevent closing the durable state connection.
    await this.flush().catch(() => {});
    this.background.emitDestroy();
  }
}

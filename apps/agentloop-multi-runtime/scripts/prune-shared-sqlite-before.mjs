import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const source = resolve(sourceArgument ?? `${appRoot}/data/local/agentloop.db`);
const cutoffArgument = process.argv.slice(2).find((argument) => argument.startsWith("--before="))?.slice("--before=".length);
const cutoff = Date.parse(cutoffArgument ?? "2026-09-19T16:00:00.000Z"); // Default: 2026-09-20 00:00 Asia/Shanghai
if (!Number.isFinite(cutoff)) throw new Error("--before must be an ISO-8601 timestamp.");
if (source.includes("/local-agent/")) throw new Error("Local Runtime Agent SQLite must never be pruned by this script.");
const apply = process.argv.includes("--apply");
const db = new DatabaseSync(source, { readOnly: !apply });

const roots = () => ({
  cutoff,
  runs: Number(db.prepare("SELECT COUNT(*) AS count FROM runs WHERE created_at < ?").get(cutoff).count),
  tasks: Number(db.prepare("SELECT COUNT(*) AS count FROM mr_tasks WHERE created_at < ?").get(cutoff).count),
  events: Number(db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE created_at < ?)").get(cutoff).count),
});

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", source, cutoffIso: new Date(cutoff).toISOString(), ...roots() }));
  db.close();
  process.exit(0);
}

db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
try {
  db.exec(`
    CREATE TEMP TABLE prune_runs AS SELECT id FROM runs WHERE created_at < ${cutoff};
    CREATE TEMP TABLE prune_tasks AS SELECT id FROM mr_tasks WHERE created_at < ${cutoff};
    CREATE TEMP TABLE prune_assignments AS SELECT id FROM mr_assignments WHERE task_id IN (SELECT id FROM prune_tasks);

    DELETE FROM tool_results WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM run_event_counters WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM human_loop_responses WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM human_loop_requests WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM plan_revision_assessments WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM prune_runs));
    DELETE FROM recovery_user_responses WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM recovery_decisions WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM run_checkpoints WHERE run_id IN (SELECT id FROM prune_runs) OR child_run_id IN (SELECT id FROM prune_runs);
    DELETE FROM skill_compliance_assessments WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM prune_runs));
    DELETE FROM plan_step_retirements WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM prune_runs));
    DELETE FROM plan_revision_snapshots WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM prune_runs));
    DELETE FROM run_recovery_states WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM run_outcomes WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM runtime_actions WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM run_events WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM run_visible_directories WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM run_sources WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM batch_items WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM mr_host_dispatches WHERE remote_run_id IN (SELECT id FROM prune_runs) OR assignment_id IN (SELECT id FROM prune_assignments);
    DELETE FROM mr_run_executors WHERE remote_run_id IN (SELECT id FROM prune_runs);
    DELETE FROM plan_steps WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM prune_runs));
    DELETE FROM plans WHERE run_id IN (SELECT id FROM prune_runs);
    DELETE FROM runs WHERE id IN (SELECT id FROM prune_runs);

    DELETE FROM source_chunks WHERE source_id IN (SELECT id FROM sources WHERE created_at < ${cutoff} AND NOT EXISTS (SELECT 1 FROM run_sources WHERE run_sources.source_id = sources.id));
    DELETE FROM sources WHERE created_at < ${cutoff} AND NOT EXISTS (SELECT 1 FROM run_sources WHERE run_sources.source_id = sources.id);

    DELETE FROM mr_artifacts WHERE assignment_id IN (SELECT id FROM prune_assignments);
    DELETE FROM mr_conversation_runtime_migrations WHERE assignment_id IN (SELECT id FROM prune_assignments);
    DELETE FROM mr_turns WHERE assignment_id IN (SELECT id FROM prune_assignments);
    DELETE FROM mr_assignments WHERE id IN (SELECT id FROM prune_assignments);
    DELETE FROM mr_tasks WHERE id IN (SELECT id FROM prune_tasks);
  `);
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) throw new Error(`Refusing to commit retention prune with ${violations.length} foreign-key violation(s).`);
  db.exec("COMMIT;");
  console.log(JSON.stringify({ mode: "applied", source, cutoffIso: new Date(cutoff).toISOString(), ...roots() }));
} catch (error) {
  db.exec("ROLLBACK;");
  throw error;
} finally {
  db.close();
}

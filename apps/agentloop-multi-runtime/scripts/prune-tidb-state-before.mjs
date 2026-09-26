import { openStateDatabase } from "../src/storage/state-database.ts";

const before = argumentValue("--before");
if (before === undefined) throw new Error("Usage: --before=<ISO-8601 timestamp> [--apply --confirm=<same timestamp>]");
const cutoff = Date.parse(before);
if (!Number.isFinite(cutoff)) throw new Error("--before must be an ISO-8601 timestamp.");
const apply = process.argv.includes("--apply");
if (apply && argumentValue("--confirm") !== before) {
  throw new Error("Destructive cleanup requires --apply --confirm=<exact --before timestamp>.");
}

const routerUrl = requiredEnvironment("AGENTLOOP_ROUTER_STATE_DATABASE_URL");
const runtimeUrl = requiredEnvironment("AGENTLOOP_RUNTIME_STATE_DATABASE_URL");
const router = await openStateDatabase({ driver: "tidb", connectionString: routerUrl }, { schema: "router" });
const runtime = await openStateDatabase({ driver: "tidb", connectionString: runtimeUrl }, { schema: "runtime", autoMigrateKernel: false });

try {
  const summary = await preflight(router, runtime);
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", before, cutoff, ...publicSummary(summary) }));
    process.exit(0);
  }

  // The schemas reside in separate TiDB databases, so this is deliberately
  // ordered and idempotent rather than claiming an unavailable cross-schema
  // transaction. A retry after an interruption converges to the same state.
  await pruneRuntime(runtime, summary.assignmentIds);
  await pruneRouter(router);
  await assertNoDanglingReferences(router, runtime);
  console.log(JSON.stringify({ mode: "applied", before, cutoff, ...publicSummary(await preflight(router, runtime)) }));
} finally {
  await router.close();
  await runtime.close();
}

async function preflight(router, runtime) {
  const assignmentRows = await router.prepare(`
    SELECT a.id
    FROM mr_assignments a
    INNER JOIN mr_tasks t ON t.id = a.task_id
    WHERE t.created_at < ?
  `).all(cutoff);
  return {
    routerTasks: count(await router.prepare("SELECT COUNT(*) AS count FROM mr_tasks WHERE created_at < ?").get(cutoff)),
    routerAssignments: assignmentRows.length,
    runtimeRuns: count(await runtime.prepare("SELECT COUNT(*) AS count FROM runs WHERE created_at < ?").get(cutoff)),
    runtimeEvents: count(await runtime.prepare(`
      SELECT COUNT(*) AS count FROM run_events
      WHERE run_id IN (SELECT id FROM runs WHERE created_at < ?)
    `).get(cutoff)),
    assignmentIds: assignmentRows.map((row) => String(row.id)),
  };
}

async function pruneRuntime(runtime, assignmentIds) {
  await runtime.transaction(async () => {
    await runtime.exec("CREATE TEMPORARY TABLE retention_runs (id VARCHAR(191) PRIMARY KEY)");
    try {
      await runtime.prepare("INSERT INTO retention_runs (id) SELECT id FROM runs WHERE created_at < ?").run(cutoff);
      const byRun = async (table, column = "run_id") =>
        await runtime.prepare(`DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM retention_runs)`).run();

      await byRun("human_loop_responses");
      await byRun("human_loop_requests");
      await runtime.prepare("DELETE FROM plan_revision_assessments WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM retention_runs))").run();
      await byRun("recovery_user_responses");
      await byRun("recovery_decisions");
      await runtime.prepare("DELETE FROM run_checkpoints WHERE run_id IN (SELECT id FROM retention_runs) OR child_run_id IN (SELECT id FROM retention_runs)").run();
      await runtime.prepare("DELETE FROM skill_compliance_assessments WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM retention_runs))").run();
      await runtime.prepare("DELETE FROM plan_step_retirements WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM retention_runs))").run();
      await runtime.prepare("DELETE FROM plan_revision_snapshots WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM retention_runs))").run();
      await byRun("run_recovery_states");
      await byRun("run_outcomes");
      await byRun("runtime_actions");
      await byRun("run_events");
      await byRun("run_visible_directories");
      await byRun("run_sources");
      await byRun("batch_items");
      await byRun("mr_run_executors", "remote_run_id");
      await runtime.prepare("DELETE FROM mr_host_dispatches WHERE remote_run_id IN (SELECT id FROM retention_runs)").run();
      if (assignmentIds.length > 0) {
        const placeholders = assignmentIds.map(() => "?").join(", ");
        await runtime.prepare(`DELETE FROM mr_host_dispatches WHERE assignment_id IN (${placeholders})`).run(...assignmentIds);
      }
      await runtime.prepare("DELETE FROM plan_steps WHERE plan_id IN (SELECT id FROM plans WHERE run_id IN (SELECT id FROM retention_runs))").run();
      await runtime.prepare("DELETE FROM plans WHERE run_id IN (SELECT id FROM retention_runs)").run();
      await runtime.prepare("DELETE FROM runs WHERE id IN (SELECT id FROM retention_runs)").run();
      await runtime.prepare(`
        DELETE FROM source_chunks WHERE source_id IN (
          SELECT id FROM sources WHERE created_at < ?
          AND NOT EXISTS (SELECT 1 FROM run_sources WHERE run_sources.source_id = sources.id)
        )
      `).run(cutoff);
      await runtime.prepare(`
        DELETE FROM sources WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM run_sources WHERE run_sources.source_id = sources.id)
      `).run(cutoff);
    } finally {
      await runtime.exec("DROP TEMPORARY TABLE IF EXISTS retention_runs");
    }
  });
}

async function pruneRouter(router) {
  await router.transaction(async () => {
    await router.exec("CREATE TEMPORARY TABLE retention_assignments (id VARCHAR(191) PRIMARY KEY)");
    await router.exec("CREATE TEMPORARY TABLE retention_tasks (id VARCHAR(191) PRIMARY KEY)");
    try {
      await router.prepare("INSERT INTO retention_tasks (id) SELECT id FROM mr_tasks WHERE created_at < ?").run(cutoff);
      await router.exec("INSERT INTO retention_assignments (id) SELECT id FROM mr_assignments WHERE task_id IN (SELECT id FROM retention_tasks)");
      await router.prepare("DELETE FROM mr_artifacts WHERE assignment_id IN (SELECT id FROM retention_assignments)").run();
      await router.prepare("DELETE FROM mr_conversation_runtime_migrations WHERE assignment_id IN (SELECT id FROM retention_assignments)").run();
      await router.prepare("DELETE FROM mr_turns WHERE assignment_id IN (SELECT id FROM retention_assignments)").run();
      await router.prepare("DELETE FROM mr_assignments WHERE id IN (SELECT id FROM retention_assignments)").run();
      await router.prepare("DELETE FROM mr_tasks WHERE id IN (SELECT id FROM retention_tasks)").run();
    } finally {
      await router.exec("DROP TEMPORARY TABLE IF EXISTS retention_assignments");
      await router.exec("DROP TEMPORARY TABLE IF EXISTS retention_tasks");
    }
  });
}

async function assertNoDanglingReferences(router, runtime) {
  const [runtimePlans, routerAssignments] = await Promise.all([
    runtime.prepare("SELECT COUNT(*) AS count FROM plans p LEFT JOIN runs r ON r.id = p.run_id WHERE r.id IS NULL").get(),
    router.prepare("SELECT COUNT(*) AS count FROM mr_assignments a LEFT JOIN mr_tasks t ON t.id = a.task_id WHERE t.id IS NULL").get(),
  ]);
  if (count(runtimePlans) !== 0 || count(routerAssignments) !== 0) {
    throw new Error("Retention cleanup detected dangling references; both schemas remain safe to retry.");
  }
}

function count(row) { return Number(row?.count ?? 0); }
function publicSummary({ assignmentIds: _assignmentIds, ...summary }) { return summary; }
function argumentValue(name) {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return value?.slice(name.length + 1);
}
function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

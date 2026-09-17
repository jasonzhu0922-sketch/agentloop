/** Exact, compare-and-swap repair of task recency. Requires a previously captured before/after manifest. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: node repair-assignment-recency.mts manifest.json [--apply]");
const apply = process.argv[3] === "--apply";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  databasePath: string;
  rows: { taskId: string; assignmentId: string; runId: string; status: string; beforeUpdatedAt: number; afterUpdatedAt: number; observedAt: number }[];
};
assert.ok(manifest.rows.length > 0);
assert.equal(new Set(manifest.rows.map((row) => row.taskId)).size, manifest.rows.length);
const db = new DatabaseSync(manifest.databasePath, { readOnly: !apply });
db.exec("PRAGMA busy_timeout=5000");
try {
  db.exec(apply ? "BEGIN IMMEDIATE" : "BEGIN");
  for (const row of manifest.rows) {
    const current = db.prepare(`SELECT t.updated_at, t.status task_status, a.status assignment_status,
      a.last_observed_at, r.status run_status, r.finished_at,
      (SELECT id FROM mr_assignments WHERE task_id=t.id ORDER BY created_at DESC, id DESC LIMIT 1) latest_id
      FROM mr_tasks t JOIN mr_assignments a ON a.task_id=t.id JOIN runs r ON r.id=a.remote_run_id
      WHERE t.id=? AND a.id=? AND r.id=?`).get(row.taskId, row.assignmentId, row.runId);
    assert.ok(current, `Missing exact target ${row.taskId}`);
    assert.equal(current.updated_at, row.beforeUpdatedAt);
    assert.equal(current.finished_at, row.afterUpdatedAt);
    assert.equal(current.last_observed_at, row.observedAt);
    assert.equal(current.latest_id, row.assignmentId);
    for (const field of ["task_status", "assignment_status", "run_status"]) assert.equal(current[field], row.status);
    assert.ok(["completed", "failed", "cancelled"].includes(row.status));
    assert.ok(Number.isSafeInteger(row.afterUpdatedAt) && row.afterUpdatedAt > 0 && row.afterUpdatedAt < row.beforeUpdatedAt);
    if (apply) {
      const result = db.prepare("UPDATE mr_tasks SET updated_at=? WHERE id=? AND updated_at=?").run(row.afterUpdatedAt, row.taskId, row.beforeUpdatedAt);
      assert.equal(result.changes, 1);
    }
  }
  db.exec(apply ? "COMMIT" : "ROLLBACK");
  console.log(JSON.stringify({ applied: apply, verifiedRows: manifest.rows.length, changedField: "mr_tasks.updated_at", beforeSnapshot: manifestPath }));
} catch (error) { db.exec("ROLLBACK"); throw error; }
finally { db.close(); }

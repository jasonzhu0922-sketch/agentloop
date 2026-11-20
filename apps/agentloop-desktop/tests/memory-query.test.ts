import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MemoryQuery } from "../src/memory/memory-query.ts";
import { seedMemory, seedRun } from "./fixtures/memory-inspection.ts";
import type { LocalRuntimeSummary } from "@zhujun/agentloop-local-runtime";

const params = (value = "") => new URLSearchParams(value);
const definition = (extra = {}) => ({ id: "default", displayName: "默认", isDefault: true, storageKey: "default", ...extra }) as LocalRuntimeSummary;

test("memory queries preserve scope, source, revisions and exact evidence with read-only pagination", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-query-")); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await seedMemory(root, "alice"); await seedRun(join(root, "runtime.db"), "alice");
  await seedRun(join(root, "runtime.db"), "foreign", "foreign-run-0001");
  const query = new MemoryQuery(root, "alice");
  const before = await readFile(join(root, "memory.db"));
  const list = await query.items(params("q=中文"));
  assert.equal(list.available, true); assert.equal(list.total, 1); assert.equal(list.items[0]!.id, saved.id);
  assert.equal(JSON.stringify(list).includes("foreign-private-value"), false);
  const detail = await query.item(saved.id, params());
  assert.equal(detail.current.revision, 28); assert.deepEqual(detail.current.applicability.conditions, ["仅项目报告"]);
  assert.equal(detail.current.sources[0].runId, "memory-run-0001");
  assert.equal(detail.revisions.length, 25); assert.equal(detail.total, 28);
  assert.equal((await query.item(saved.id, params("offset=25"))).revisions.length, 3);
  const jobs = await query.jobs(params("status=dead_letter"));
  assert.equal(jobs.total, 1); assert.equal(jobs.jobs[0]!.lastError, "invalid_output");
  const run = await query.run(params("run=memory-run&limit=20"), [definition()]);
  assert.equal(run.matches.length, 1); assert.ok(run.detail);
  assert.equal(run.detail.events.length, 20); assert.equal(run.detail.hasMore, true);
  assert.equal(run.detail.projections[0].id, saved.projection!.id);
  assert.equal(run.detail.attempts[0].status, "invalid_output");
  assert.equal(run.detail.applicationReviews.length, 1);
  assert.equal(run.detail.applicationReviews[0].applications[0].adoption, "unknown");
  assert.equal(JSON.stringify(run.detail.applicationReviews).includes("foreign-private-review"), false);
  assert.equal(run.detail.invalidations.length, 1);
  assert.equal(run.detail.invalidations[0].source.runId, "followup");
  assert.equal(JSON.stringify(run.detail.invalidations).includes("foreign-private-feedback"), false);
  const page = await query.run(params("run=memory-run&afterSeq=20&limit=20"), [definition()]);
  assert.equal(page.detail!.events[0]!.seq, 21); assert.equal(page.detail!.events.length, 12); assert.equal(page.detail!.hasMore, false);
  assert.deepEqual((await query.run(params("run=foreign-run"), [definition()])).matches, []);
  const other = new MemoryQuery(root, "bob");
  assert.equal((await other.items(params())).total, 0);
  await assert.rejects(other.item(saved.id, params()), /memory_item_not_found/);
  assert.equal((await other.jobs(params())).total, 0);
  assert.deepEqual(await readFile(join(root, "memory.db")), before, "diagnostics must not modify stored memory");
  for (const input of ["limit=0", "offset=-1", "category=constructor", "status=invalid"]) await assert.rejects(query.items(params(input)), /memory_query_invalid/);
  assert.equal((await query.items(params("q=%27%20OR%201%3D1--"))).total, 0, "search is a bound value, not SQL");
});

test("old memory databases remain queryable without creating application-review tables", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-query-legacy-")); t.after(() => rm(root, { recursive: true, force: true }));
  await seedMemory(root, "alice"); await seedRun(join(root, "runtime.db"), "alice");
  const db = new DatabaseSync(join(root, "memory.db")); db.exec("DROP TABLE local_memory_application_reviews; DROP TABLE local_memory_run_invalidations"); db.close();
  const before = await readFile(join(root, "memory.db"));
  const result = await new MemoryQuery(root, "alice").run(params("run=memory-run"), [definition()]);
  assert.deepEqual(result.detail!.applicationReviews, []);
  assert.deepEqual(result.detail!.invalidations, []);
  assert.deepEqual(await readFile(join(root, "memory.db")), before);
});

test("missing memory stays missing; stopped child Runtime evidence is still queryable", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-query-empty-")); t.after(() => rm(root, { recursive: true, force: true }));
  const query = new MemoryQuery(root, "alice");
  assert.equal((await query.items(params())).available, false); assert.equal((await query.jobs(params())).available, false);
  assert.deepEqual(await readdir(root), []);
  const child = join(root, "runtimes", "child"); await mkdir(child, { recursive: true });
  await seedRun(join(child, "agentloop.db"), "alice", "child-run-0001");
  const run = await query.run(params("run=child-run"), [definition({ id: "child", isDefault: false, storageKey: "child", status: "stopped" })]);
  assert.equal(run.detail!.run.id, "child-run-0001"); assert.equal(run.detail!.memoryAvailable, false);
  await seedRun(join(root, "runtime.db"), "alice", "child-run-0002");
  const multiple = await query.run(params("run=child-run"), [definition(), definition({ id: "child", isDefault: false, storageKey: "child" })]);
  assert.equal(multiple.matches.length, 2); assert.equal(multiple.detail, null, "an ambiguous fragment must not pick an arbitrary Run");
  await assert.rejects(query.run(params("run=child-run&runtimeId=../../foreign"), [definition()]), /memory_query_invalid/);
});

test("a database symlink cannot cross the account boundary", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-query-boundary-")); t.after(() => rm(root, { recursive: true, force: true }));
  const alice = join(root, "alice"), bob = join(root, "bob"); await mkdir(alice); await mkdir(bob); await seedMemory(bob, "bob");
  await symlink(join(bob, "memory.db"), join(alice, "memory.db"));
  await assert.rejects(new MemoryQuery(alice, "alice").items(params()), /memory_storage_invalid/);
});

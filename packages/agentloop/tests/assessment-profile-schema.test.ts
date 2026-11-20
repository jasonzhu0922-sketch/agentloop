import assert from "node:assert/strict";
import test from "node:test";
import { installAssessmentProfileSchema } from "../src/storage/assessment-profile-schema.ts";
import type { SqlConnection } from "../src/storage/connection.ts";

function fixture(ddl: string) {
  const writes: string[] = [], reads: string[] = [];
  const database: SqlConnection = {
    dialect: "tidb", exec: async sql => { writes.push(sql); }, close: async () => {},
    transaction: async operation => operation(),
    prepare: sql => ({
      get: async <T>() => { reads.push(sql); return { "Create Table": ddl } as T; },
      all: async () => { throw new Error("TABLE_CONSTRAINTS omits TiDB CHECK constraints"); },
      run: async () => ({ changes: 0 }),
    }),
  };
  return { database, writes, reads };
}

test("TiDB assessment migration reads the owning table and is idempotent with character-set-introduced literals", async () => {
  const f = fixture("CREATE TABLE `skill_compliance_assessments` (\nCONSTRAINT `skill_assessment_profile_check` CHECK ((`assessment_profile` in (_utf8mb4'lookup_lite',_utf8mb4'result_judged'))),\nCONSTRAINT `other` CHECK ((`approved` in (0,1)))\n)");
  await installAssessmentProfileSchema(f.database);
  await installAssessmentProfileSchema(f.database);
  assert.equal(f.reads.length, 2);
  assert.ok(f.reads.every(sql => sql === "SHOW CREATE TABLE skill_compliance_assessments"));
  assert.deepEqual(f.writes, [], "existing current constraints must never be re-added");
});

test("TiDB assessment migration upgrades only old profile checks and preserves unrelated checks", async () => {
  const f = fixture("CREATE TABLE `skill_compliance_assessments` (\nCONSTRAINT `old``profile` CHECK (\n(`assessment_profile` in (_utf8mb4'lookup_lite',_utf8mb4'source_grounded'))\n),\nCONSTRAINT `other` CHECK ((`approved` in (0,1)))\n)");
  await installAssessmentProfileSchema(f.database);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0], "ALTER TABLE skill_compliance_assessments DROP CHECK `old``profile`");
  assert.match(f.writes[1], /result_judged/);
  assert.equal(f.writes.some(sql => sql.includes("DROP CHECK `other`")), false);
});

test("TiDB assessment migration fails closed if the native table definition is unreadable", async () => {
  const f = fixture("CREATE TABLE `skill_compliance_assessments` (CONSTRAINT `profile` CHECK ((`assessment_profile` in ('lookup_lite'))");
  await assert.rejects(installAssessmentProfileSchema(f.database), /Invalid TiDB CHECK/);
  assert.deepEqual(f.writes, []);
});

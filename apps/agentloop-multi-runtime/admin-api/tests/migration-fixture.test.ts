import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_PLANE_MIGRATION_FIXTURE } from "./fixtures/control-plane-migration-fixture.ts";

test("migration fixture reserves portable dialects without executable cp DDL", () => {
  assert.deepEqual(CONTROL_PLANE_MIGRATION_FIXTURE.dialects, ["sqlite", "postgres", "tidb"]);
  assert.equal(CONTROL_PLANE_MIGRATION_FIXTURE.expectedTableNames.every((name) => name.startsWith("cp_")), true);
  assert.equal(CONTROL_PLANE_MIGRATION_FIXTURE.migration.checksum, "fixture-not-applied");
});

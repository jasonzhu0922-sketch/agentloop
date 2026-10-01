import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import type { AdminMember } from "../../control-plane/contracts/index.ts";
import { migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

test("member identity store uses revisions, explicit lifecycle transitions, and immutable audit events", async () => {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  const store = new SqlControlPlaneStore(database);
  const member: AdminMember = { contractVersion: "control-plane/v1", memberId: "member-a", scopeId: "tenant-a", subject: "subject-a", displayName: "Member A", role: "platform_admin", status: "invited", revision: 1, createdAt: 1, updatedAt: 1 };
  await store.createMember(member, 0, "admin-a", "audit-member-create");
  assert.deepEqual(await store.listMembers("tenant-a"), [member]);
  const active = await store.transitionMember("member-a", "active", 1, "admin-a", "audit-member-active");
  assert.equal(active.revision, 2);
  await assert.rejects(() => store.transitionMember("member-a", "removed", 1, "admin-a", "audit-member-stale"), (error: unknown) => error instanceof Error && "code" in error && error.code === "revision_conflict");
  const events = await store.listAuditEvents(10);
  assert.deepEqual(events.map((event) => event.action), ["member.transitioned", "member.created"]);
  await database.close();
});

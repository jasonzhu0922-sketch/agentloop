import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { RuntimeWorkspaceService } from "../src/runtime/runtime-workspace-service.ts";

test("Runtime workspace layout is owner-scoped and rejects unsafe conversation segments", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-runtime-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new RuntimeWorkspaceService(root, { ownerScoped: true });

  const conversationRoot = await workspace.ensureConversationWorkspace("alice/ops", "conversation-1");
  assert.match(relative(await fs.realpath(root), conversationRoot), /^users\/user-[^/]+\/conversations\/conversation-1$/u);
  assert.throws(() => workspace.forConversation("alice", "../other"), /Invalid conversation workspace id/);
  assert.throws(() => workspace.forConversation("alice", "nested/path"), /Invalid conversation workspace id/);
});

test("Runtime workspace creation refuses a managed-directory symlink", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-runtime-workspace-symlink-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "agentloop-runtime-workspace-outside-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.symlink(outside, join(root, "users"));
  const workspace = new RuntimeWorkspaceService(root, { ownerScoped: true });
  await assert.rejects(workspace.ensureOwnerWorkspace("alice"), /cannot be symbolic links/);
});

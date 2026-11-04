import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDesktop } from "../src/application.ts";
import { claimInstance } from "../src/platform/instance-lock.ts";

test("packaged hosts require explicit authentication and prebuilt resources before claiming data", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-packaged-configuration-"));
  try {
    await assert.rejects(startDesktop({ mode: "packaged", dataDirectory: root, openBrowser: false }), /desktop_package_configuration_required/);
    await assert.rejects(readFile(join(root, ".desktop-instance.lock")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged data survives reopen and cannot be adopted by the development host", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-packaged-marker-"));
  try {
    const first = await claimInstance(root, "packaged"); assert.equal(first.existing, false);
    if (first.existing) throw new Error("unexpected_existing_instance");
    const id = first.lock.installationId; await first.lock.release();
    await assert.rejects(claimInstance(root, "development"), /desktop_data_marker_invalid/);
    const second = await claimInstance(root, "packaged"); assert.equal(second.existing, false);
    if (second.existing) throw new Error("unexpected_existing_instance");
    assert.equal(second.lock.installationId, id); await second.lock.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

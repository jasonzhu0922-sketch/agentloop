import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PolicyReleaseReference, RuntimeConfigurationSnapshot } from "../control-plane/contracts/index.ts";
import { assertSkillArtifactsReady } from "../control-plane/contracts/index.ts";
import { resolveControlPlanePolicy } from "../src/shared/control-plane-policy.ts";
import { SkillArtifactInstallError, installSignedSkillArtifact } from "../src/shared/control-plane-skill-artifact.ts";
import { parseRuntimeConfigurationSnapshot } from "../src/runtime-host/application/configuration/runtime-configuration-client.ts";
import { RuntimeConfigurationClient } from "../src/runtime-host/application/configuration/runtime-configuration-client.ts";
import { LocalDeliveryClient } from "../local-agent-runtime/src/control-plane/local-delivery-client.ts";

const hash = "b".repeat(64);

test("signed Skill artifacts enter the catalog only after exact package load", () => {
  const base: RuntimeConfigurationSnapshot["skills"][number] = {
    releaseId: "skill-release", packageHash: hash, contentHash: hash,
    artifact: { packageUri: "https://artifacts.example.test/skill.tgz", packageHash: hash, signer: "platform-signer", signatureAlgorithm: "ed25519", signature: "signature-bytes" },
  };
  assert.throws(() => assertSkillArtifactsReady({ skills: [base] }, [], true), /verified and loaded/);
  assert.throws(() => assertSkillArtifactsReady({ skills: [base] }, ["c".repeat(64)], true), /verified and loaded/);
  assert.doesNotThrow(() => assertSkillArtifactsReady({ skills: [base] }, [hash], true));
  assert.throws(() => assertSkillArtifactsReady({ skills: [{ releaseId: base.releaseId, packageHash: hash, contentHash: hash }] }, [hash], true), /signed artifact manifest/);
});

test("policy snapshot adapter parses guidance and execution strategy without granting capabilities", () => {
  const policies: readonly PolicyReleaseReference[] = [{
    releaseId: "policy-release", contentHash: hash,
    policy: {
      practiceProfileCatalog: { schema: "agentloop.practiceProfileCatalog/v1", enabled: true, mode: "active", profiles: [] },
      stepExecutionStrategy: { schema: "agentloop.stepExecutionStrategyConfig/v1", profile: "action-aware", projection: { terminalPreviewCharacters: 600 } },
      planTemplates: [{ id: "template-a", allowedOperationProfiles: ["direct_answer"] }],
    },
  }];
  const resolved = resolveControlPlanePolicy(policies);
  assert.equal(resolved.practiceProfileCatalog?.schema, "agentloop.practiceProfileCatalog/v1");
  assert.equal(resolved.stepExecutionStrategy?.profile, "action-aware");
  assert.deepEqual(resolved.planTemplates, [{ id: "template-a", allowedOperationProfiles: ["direct_answer"] }]);
  assert.deepEqual(resolved.releaseIds, ["policy-release"]);
});

test("delivery snapshot decoding preserves signed Skill artifact metadata across the Cloud and Local clients", () => {
  const snapshot = {
    contractVersion: "control-plane/v1",
    snapshotId: "snapshot-signed-skill",
    configurationRevision: 1,
    target: { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" },
    resolvedAt: 100,
    validUntil: 200,
    integrations: [],
    skills: [{
      releaseId: "skill-release",
      packageHash: hash,
      contentHash: hash,
      artifact: {
        packageUri: "https://artifacts.example.test/skill.tgz",
        packageHash: hash,
        signer: "platform-signer",
        signatureAlgorithm: "ed25519",
        signature: "signature-bytes",
        compatibility: { runtime: "v1" },
      },
    }],
    policies: [],
  };
  const decoded = parseRuntimeConfigurationSnapshot(snapshot);
  assert.deepEqual(decoded.skills[0]?.artifact, snapshot.skills[0].artifact);
  assert.throws(() => parseRuntimeConfigurationSnapshot({ ...snapshot, skills: [{ ...snapshot.skills[0], artifact: { ...snapshot.skills[0].artifact, signatureAlgorithm: "rsa" } }] }), /invalid/);
});

test("multiple policy releases cannot silently override one guidance or strategy adapter", () => {
  const policy = (releaseId: string): PolicyReleaseReference => ({
    releaseId, contentHash: hash,
    policy: { stepExecutionStrategy: { schema: "agentloop.stepExecutionStrategyConfig/v1", profile: "action-aware", projection: {} } },
  });
  assert.throws(() => resolveControlPlanePolicy([policy("policy-a"), policy("policy-b")]), /configuration_unavailable/);
});

test("Skill artifact installer rejects an unverified package and emits a loaded receipt only after verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-wp6-skill-artifact-"));
  let installedHash: string | undefined;
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: signed-skill\ndescription: Signed test package\n---\n\nInstructions.\n");
    const { inspectSkillPackage } = await import("@zhujun/agentloop");
    const inspection = await inspectSkillPackage(source);
    const manifest = { packageUri: "https://artifacts.example.test/signed-skill.tgz", packageHash: inspection.packageHash, signer: "platform-signer", signatureAlgorithm: "ed25519" as const, signature: "signature-bytes" };
    installedHash = manifest.packageHash;
    const common = {
      target: { plane: "local" as const, scopeId: "tenant-a", runtimeId: "runtime-a", deviceId: "device-a" }, releaseId: "skill-release", manifest,
      destinationRoot: join(root, "installed"), download: { download: async () => source }, receiptId: "receipt-a", now: () => 2_000,
    };
    await assert.rejects(() => installSignedSkillArtifact({ ...common, verifier: { verify: () => false } }), (error: unknown) => error instanceof SkillArtifactInstallError && error.code === "skill_artifact_signature_invalid");
    const receipt = await installSignedSkillArtifact({ ...common, verifier: { verify: ({ packageHash }) => packageHash === manifest.packageHash } });
    assert.equal(receipt.status, "loaded");
    assert.equal(receipt.packageHash, manifest.packageHash);
    assert.equal(await readFile(join(root, "installed", manifest.packageHash, "SKILL.md"), "utf8"), "---\nname: signed-skill\ndescription: Signed test package\n---\n\nInstructions.\n");
  } finally {
    if (installedHash !== undefined) {
      await chmod(join(root, "installed", installedHash), 0o755).catch(() => undefined);
      await chmod(join(root, "installed", installedHash, "SKILL.md"), 0o644).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloud and Local delivery clients expose authorized Skill download and install receipt paths", async () => {
  const packageHash = "d".repeat(64);
  const manifest = { packageUri: "https://artifacts.example.test/skill.tgz", packageHash, signer: "platform-signer", signatureAlgorithm: "ed25519" as const, signature: "signature" };
  const cloudBodies: unknown[] = [];
  const cloud = new RuntimeConfigurationClient({
    deliveryUrl: "https://delivery.example.test", workloadToken: "workload-token", target: { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" },
    request: (async (input, init) => {
      if (String(input).includes("skill-artifacts")) return new Response(new TextEncoder().encode("package-bytes"), { status: 200 });
      cloudBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: "recorded" }), { status: 201 });
    }) as typeof fetch,
  });
  assert.equal(new TextDecoder().decode(await cloud.downloadSkillArtifact(manifest)), "package-bytes");
  await cloud.reportSkillInstallReceipt({ contractVersion: "control-plane/v1", receiptId: "cloud-receipt", target: { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" }, releaseId: "skill-release", packageHash, signer: "platform-signer", status: "loaded", observedAt: 10 });
  assert.equal((cloudBodies[0] as { receipt: { packageHash: string } }).receipt.packageHash, packageHash);

  const localBodies: unknown[] = [];
  const local = new LocalDeliveryClient({
    deliveryUrl: "https://delivery.example.test", deviceToken: "device-token", target: { plane: "local", scopeId: "tenant-a", runtimeId: "runtime-a", deviceId: "device-a" },
    request: (async (input, init) => {
      if (String(input).includes("skill-artifacts")) return new Response(new TextEncoder().encode("local-package"), { status: 200 });
      localBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: "recorded" }), { status: 201 });
    }) as typeof fetch,
  });
  assert.equal(new TextDecoder().decode(await local.downloadSkillArtifact(manifest)), "local-package");
  await local.reportSkillInstallReceipt({ contractVersion: "control-plane/v1", receiptId: "local-receipt", target: { plane: "local", scopeId: "tenant-a", runtimeId: "runtime-a", deviceId: "device-a" }, releaseId: "skill-release", packageHash, signer: "platform-signer", status: "loaded", observedAt: 11 });
  assert.equal((localBodies[0] as { receipt: { target: { deviceId: string } } }).receipt.target.deviceId, "device-a");
});

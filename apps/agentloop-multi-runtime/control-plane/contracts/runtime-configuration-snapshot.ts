import type { PolicyReleaseReference, RuntimeConfigurationSnapshot, RuntimePolicyManifest, RuntimeTarget, SkillArtifactManifest } from "./v1.ts";

/** Strict, side-effect-free decoder shared by Cloud and Local delivery clients. */
export function parseRuntimeConfigurationSnapshot(value: unknown): RuntimeConfigurationSnapshot {
  if (!record(value) || value.contractVersion !== "control-plane/v1" || !text(value.snapshotId) || !integer(value.configurationRevision) || !integer(value.resolvedAt) || !integer(value.validUntil) || value.validUntil <= value.resolvedAt) throw new TypeError("invalid_runtime_configuration_snapshot");
  const target = parseTarget(value.target);
  if (!Array.isArray(value.integrations) || !Array.isArray(value.skills) || !Array.isArray(value.policies)) throw new TypeError("invalid_runtime_configuration_snapshot");
  const integrations = value.integrations.map((item) => {
    const reference = parseReference(item);
    if (!record(item) || !text(item.bindingId)) throw new TypeError("invalid_runtime_configuration_snapshot");
    const integration = item.integration === undefined ? undefined : requiredText(item.integration);
    const allowedActions = item.allowedActions === undefined ? undefined : requiredTextArray(item.allowedActions);
    return { bindingId: item.bindingId, ...reference, ...(integration === undefined || allowedActions === undefined ? {} : { integration, allowedActions }) };
  });
  const skills = value.skills.map((item) => {
    if (!record(item) || !text(item.releaseId) || !hash(item.packageHash) || !hash(item.contentHash)) throw new TypeError("invalid_runtime_configuration_snapshot");
    const artifact = item.artifact === undefined ? undefined : parseArtifact(item.artifact, item.packageHash);
    return { releaseId: item.releaseId, packageHash: item.packageHash, contentHash: item.contentHash, ...(artifact === undefined ? {} : { artifact }) };
  });
  const modelRoute = value.modelRoute === undefined ? undefined : parseModelRoute(value.modelRoute);
  return { contractVersion: "control-plane/v1", snapshotId: value.snapshotId, configurationRevision: value.configurationRevision, target, resolvedAt: value.resolvedAt, validUntil: value.validUntil, ...(modelRoute === undefined ? {} : { modelRoute }), integrations, skills, policies: value.policies.map(parsePolicyReference) };
}

function parseTarget(value: unknown): RuntimeTarget { if (!record(value) || (value.plane !== "cloud" && value.plane !== "local") || !text(value.tenantId) || !text(value.runtimeId)) throw new TypeError("invalid_runtime_configuration_snapshot"); return { plane: value.plane, tenantId: value.tenantId, runtimeId: value.runtimeId, ...(value.runtimeClass === undefined ? {} : { runtimeClass: requiredText(value.runtimeClass) }), ...(value.deviceId === undefined ? {} : { deviceId: requiredText(value.deviceId) }) }; }
function parseReference(value: unknown): { readonly releaseId: string; readonly contentHash: string } { if (!record(value) || !text(value.releaseId) || !hash(value.contentHash)) throw new TypeError("invalid_runtime_configuration_snapshot"); return { releaseId: value.releaseId, contentHash: value.contentHash }; }
function parseModelRoute(value: unknown): { readonly releaseId: string; readonly contentHash: string; readonly providerConfiguration: Readonly<Record<string, unknown>> } { const reference = parseReference(value); if (!record(value) || !record(value.providerConfiguration)) throw new TypeError("invalid_runtime_configuration_snapshot"); return { ...reference, providerConfiguration: value.providerConfiguration }; }
function parseArtifact(value: unknown, packageHash: string): SkillArtifactManifest {
  if (!record(value) || !text(value.packageUri) || value.packageHash !== packageHash || !text(value.signer) || !text(value.signature)
    || (value.signatureAlgorithm !== "ed25519" && value.signatureAlgorithm !== "minisign")) throw new TypeError("invalid_runtime_configuration_snapshot");
  return {
    packageUri: value.packageUri, packageHash, signer: value.signer, signatureAlgorithm: value.signatureAlgorithm, signature: value.signature,
    ...(value.compatibility === undefined ? {} : { compatibility: requiredRecord(value.compatibility) }),
  };
}
function parsePolicyReference(value: unknown): PolicyReleaseReference {
  const reference = parseReference(value);
  if (!record(value) || value.policy === undefined) return reference;
  const policy = requiredRecord(value.policy) as RuntimePolicyManifest;
  for (const key of Object.keys(policy)) if (!["practiceProfileCatalog", "stepExecutionStrategy", "planTemplates"].includes(key)) throw new TypeError("invalid_runtime_configuration_snapshot");
  if (policy.planTemplates !== undefined && (!Array.isArray(policy.planTemplates) || !policy.planTemplates.every(record))) throw new TypeError("invalid_runtime_configuration_snapshot");
  return { ...reference, policy: {
    ...(policy.practiceProfileCatalog === undefined ? {} : { practiceProfileCatalog: requiredRecord(policy.practiceProfileCatalog) }),
    ...(policy.stepExecutionStrategy === undefined ? {} : { stepExecutionStrategy: requiredRecord(policy.stepExecutionStrategy) }),
    ...(policy.planTemplates === undefined ? {} : { planTemplates: policy.planTemplates }),
  } };
}
function requiredText(value: unknown): string { if (!text(value)) throw new TypeError("invalid_runtime_configuration_snapshot"); return value; }
function requiredTextArray(value: unknown): readonly string[] { if (!Array.isArray(value) || !value.every(text)) throw new TypeError("invalid_runtime_configuration_snapshot"); return value; }
function requiredRecord(value: unknown): Record<string, unknown> { if (!record(value)) throw new TypeError("invalid_runtime_configuration_snapshot"); return value; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

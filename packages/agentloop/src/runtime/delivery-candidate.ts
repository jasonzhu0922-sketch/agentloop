import type { AgentLoopToolEvidence, RuntimeDeliveryCandidate, RuntimeDeliveryCandidateEvidenceKinds, RuntimeDeliveryReceipt } from "./contracts.ts";
import { canonicalArtifactAcceptanceVerdict } from "./tool-result-evidence.ts";
import type { StepSemanticFrame } from "./step-semantic-frame.ts";

export function normalizeDeliveryCandidate(input: {
  readonly output: string;
  readonly evidenceKinds?: Partial<RuntimeDeliveryCandidateEvidenceKinds>;
  readonly caveats?: readonly string[];
  readonly sourceToolCallIds?: readonly string[];
  readonly deliveryReceipt?: RuntimeDeliveryReceipt;
}): RuntimeDeliveryCandidate {
  const satisfied = uniqueStrings(input.evidenceKinds?.satisfied ?? []);
  const caveated = uniqueStrings(input.evidenceKinds?.caveated ?? []);
  const failed = uniqueStrings(input.evidenceKinds?.failed ?? []);
  const caveats = uniqueStrings(input.caveats ?? []);
  return {
    schema: "agentloop.runtimeDeliveryCandidate/v1",
    output: input.output.trim(),
    caveats,
    evidenceKinds: {
      satisfied,
      caveated,
      failed,
    },
    sourceToolCallIds: uniqueStrings(input.sourceToolCallIds ?? []),
    ...(input.deliveryReceipt === undefined ? {} : { deliveryReceipt: input.deliveryReceipt }),
  };
}

export function deliveryCandidateCaveats(candidate: RuntimeDeliveryCandidate): readonly string[] {
  return candidate.caveats;
}

export function deliveryCandidateMentionsCaveat(output: string, caveat: string): boolean {
  return new RegExp(escapeRegExp(caveat), "iu").test(output);
}

export function appendDeliveryCandidateCaveats(
  candidate: RuntimeDeliveryCandidate,
): RuntimeDeliveryCandidate {
  const caveats = deliveryCandidateCaveats(candidate);
  if (caveats.length === 0) return candidate;
  const missing = caveats.filter((caveat) => !deliveryCandidateMentionsCaveat(candidate.output, caveat));
  if (missing.length === 0) return candidate;
  const heading = /[\u3400-\u9fff]/u.test(candidate.output) ? "## 限制说明" : "## Limitations";
  return {
    ...candidate,
    output: [
      candidate.output.trimEnd(),
      "",
      heading,
      "",
      ...missing.map((caveat) => `- ${caveat}`),
    ].join("\n"),
  };
}

export function buildRuntimeDeliveryCandidate(input: {
  readonly output: string;
  readonly stepSemanticFrame?: Pick<StepSemanticFrame, "completionBoundary" | "evidenceMode" | "phaseRole">;
  readonly toolEvidence: readonly AgentLoopToolEvidence[];
  readonly caveats?: readonly string[];
  readonly sourceToolCallIds?: readonly string[];
}): RuntimeDeliveryCandidate {
  const evidenceKinds = collectEvidenceKinds(input.toolEvidence, input.stepSemanticFrame);
  const deliveryReceipt = collectDeliveryReceipt(input.toolEvidence);
  const caveats = uniqueStrings([
    ...(input.caveats ?? []),
    ...semanticCaveats(input.stepSemanticFrame, input.caveats),
  ]);
  return appendDeliveryCandidateCaveats(normalizeDeliveryCandidate({
    output: input.output,
    evidenceKinds,
    caveats,
    sourceToolCallIds: input.sourceToolCallIds ?? input.toolEvidence.map((item) => item.toolCallId),
    ...(deliveryReceipt === undefined ? {} : { deliveryReceipt }),
  }));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectEvidenceKinds(
  evidence: readonly AgentLoopToolEvidence[],
  stepSemanticFrame?: Pick<StepSemanticFrame, "completionBoundary" | "evidenceMode" | "phaseRole">,
): RuntimeDeliveryCandidateEvidenceKinds {
  const satisfied = new Set<string>();
  const caveated = new Set<string>();
  const failed = new Set<string>();
  let hasDeliveryReceipt = false;
  for (const item of evidence) {
    if (item.isError) continue;
    const parsed = parseJsonRecord(item.result);
    if (parsed === undefined) continue;
    const records = [parsed, parseJsonRecord(parsed.evidenceReceipt), parseJsonRecord(parsed.artifactReceipt)];
    for (const record of records) {
      if (record === undefined) continue;
      if (deliveryReceiptFromRecord(record, item.toolCallId) !== undefined) hasDeliveryReceipt = true;
      const evidenceKinds = isPlainRecord(record.evidenceKinds) ? record.evidenceKinds : undefined;
      collectStrings(evidenceKinds?.satisfied, satisfied);
      collectStrings(evidenceKinds?.caveated, caveated);
      collectStrings(evidenceKinds?.failed, failed);
    }
  }
  if (hasDeliveryReceipt) satisfied.add("delivery_receipt");
  if (stepSemanticFrame !== undefined && shouldMarkSemanticCaveats(stepSemanticFrame)) {
    caveated.add("explicit_caveats");
  }
  return {
    satisfied: [...satisfied].sort(),
    caveated: [...caveated].sort(),
    failed: [...failed].sort(),
  };
}

function collectDeliveryReceipt(evidence: readonly AgentLoopToolEvidence[]): RuntimeDeliveryReceipt | undefined {
  for (const item of evidence) {
    if (item.isError) continue;
    const parsed = parseJsonRecord(item.result);
    if (parsed === undefined) continue;
    const records = [parsed, parseJsonRecord(parsed.evidenceReceipt), parseJsonRecord(parsed.artifactReceipt)];
    for (const record of records) {
      const receipt = record === undefined ? undefined : deliveryReceiptFromRecord(record, item.toolCallId);
      if (receipt !== undefined) return receipt;
    }
  }
  return undefined;
}

function deliveryReceiptFromRecord(record: Record<string, unknown>, toolCallId: string): RuntimeDeliveryReceipt | undefined {
  const schema = typeof record.schema === "string" ? record.schema : undefined;
  if (schema !== "agentloop.artifactAcceptance/v1") return undefined;
  const verdict = canonicalArtifactAcceptanceVerdict(record);
  if (verdict !== "accepted" && verdict !== "caveated") return undefined;
  const artifact = isPlainRecord(record.artifact) ? record.artifact : undefined;
  const path = typeof artifact?.path === "string" && artifact.path.trim().length > 0 ? artifact.path : undefined;
  if (path === undefined) return undefined;
  const bytes = typeof artifact?.bytes === "number" && Number.isFinite(artifact.bytes) ? artifact.bytes : undefined;
  const sha256 = typeof artifact?.sha256 === "string" && artifact.sha256.trim().length > 0 ? artifact.sha256 : undefined;
  const kind = typeof artifact?.kind === "string" ? artifact.kind : typeof artifact?.profileId === "string" ? artifact.profileId : undefined;
  const caveats = Array.isArray(record.caveats)
    ? record.caveats.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    schema: "agentloop.runtimeDeliveryReceipt/v1",
    artifact: { path, ...(bytes === undefined ? {} : { bytes }), ...(sha256 === undefined ? {} : { sha256 }), ...(kind === undefined ? {} : { kind }) },
    verdict,
    caveats,
    sourceToolCallId: toolCallId,
  };
}

function shouldMarkSemanticCaveats(
  frame: Pick<StepSemanticFrame, "completionBoundary" | "evidenceMode" | "phaseRole">,
): boolean {
  return frame.completionBoundary.includes("explicit_caveats");
}

function semanticCaveats(
  frame: Pick<StepSemanticFrame, "completionBoundary" | "evidenceMode" | "phaseRole"> | undefined,
  existing: readonly string[] | undefined,
): string[] {
  if (frame === undefined || !shouldMarkSemanticCaveats(frame)) return [];
  if ((existing?.length ?? 0) > 0) return [];
  return ["explicit_caveats"];
}

function collectStrings(value: unknown, output: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) output.add(item.trim());
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { createHash } from "node:crypto";
import type { WorkProductObservationState } from "./work-product-observations.ts";
import { artifactMatchesExpectedTarget } from "./tool-progress-policy.ts";

export type WorkProductRole = "input" | "generator" | "experiment" | "candidate" | "unknown";
export interface WorkProductDeclarationEvent {
  readonly runId: string;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly modelStep: number;
  readonly throughSeq: number | null;
  readonly contentSha256: string;
  readonly payload: unknown;
}
export interface WorkProductDeclaration {
  readonly id: string;
  readonly kind: "role" | "issue" | "delivery_target";
  readonly path: string;
  readonly versionId: string;
  readonly replaces?: string;
  readonly source: Omit<WorkProductDeclarationEvent, "payload"> & { readonly authority: "model"; readonly index: number };
  readonly role?: WorkProductRole;
  /** An admitted, immutable Runtime target. The model may select it, never define it. */
  readonly targetId?: string;
  readonly issueId?: string;
  readonly symptom?: string;
  readonly diagnosis?: string;
  readonly evidenceToolCallIds: readonly string[];
  readonly attemptedToolCallIds: readonly string[];
  readonly pendingActions: readonly string[];
  readonly claimedStatus?: "open" | "resolved";
  readonly resolutionToolCallIds: readonly string[];
}
export interface WorkProductSemantics {
  readonly schema: "agentloop.workProductSemantics/v1";
  readonly goalId: string;
  readonly declarations: readonly WorkProductDeclaration[];
  readonly rejected: readonly { readonly modelStep: number; readonly index: number; readonly reason: string }[];
  readonly roles: readonly { readonly path: string; readonly versionId?: string; readonly role: WorkProductRole; readonly declarationId?: string;
    readonly historicalDeclaration?: { readonly id: string; readonly role: WorkProductRole; readonly versionId: string } }[];
  readonly issues: readonly (WorkProductDeclaration & {
    readonly applicability: "current" | "historical";
    /** Support is not a Runtime judgment that the task or issue is semantically complete. */
    readonly resolutionSupport: "none" | "successful_operation" | "version_scoped_check";
  })[];
  /** Current bindings only. A superseded file revision automatically ceases to fulfill its target. */
  readonly deliveryTargets?: readonly WorkProductDeliveryBinding[];
}

export interface WorkProductDeliveryTarget {
  readonly targetId: string;
  readonly deliveryTargetId?: string;
  readonly purpose: string;
  readonly kind: string;
  readonly format?: string;
}

/**
 * A Runtime-owned identity binding. The model may explicitly select a target
 * in an ambiguous leaf, but a single unambiguous trusted observation must not
 * need model prose merely to enter the canonical delivery lifecycle.
 */
export interface WorkProductDeliveryBinding {
  readonly targetId: string;
  readonly deliveryTargetId: string;
  readonly path: string;
  readonly versionId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly declarationId: string;
  readonly observedByToolCallId: string;
  readonly bindingAuthority: "model" | "runtime";
  readonly observedResultRef?: string;
}

/** Optional declaration in a normal tool-calling model turn; never parsed from tool stdout. */
export function workProductDeclarationFromContent(input: Omit<WorkProductDeclarationEvent, "contentSha256" | "payload"> & {
  readonly content: string;
}): WorkProductDeclarationEvent | undefined {
  const matches = [...input.content.matchAll(/<work_product_progress>([\s\S]*?)<\/work_product_progress>/g)];
  if (matches.length === 0 && !input.content.includes("<work_product_progress>")) return undefined;
  let payload: unknown;
  if (matches.length === 1 && matches[0][1].length <= 8_000) {
    try { payload = JSON.parse(matches[0][1]); } catch { /* Invalid declaration, not a failed Run. */ }
  }
  const { content, ...source } = input;
  return { ...source, contentSha256: digest(content), payload: payload ?? null };
}

/**
 * Pure interpretation layer: declarations never alter observations, versions,
 * or checks. Runtime derives a delivery binding only from a trusted committed
 * receipt or hash-identified Runtime file-change observation when target
 * ownership and artifact compatibility give one unambiguous answer; model
 * declarations remain the explicit route otherwise.
 */
export function deriveWorkProductSemantics(input: {
  readonly facts: WorkProductObservationState;
  readonly goalId: string;
  readonly declarations: readonly WorkProductDeclarationEvent[];
  /** The only target namespace a model declaration may select from. */
  readonly deliveryTargets?: readonly WorkProductDeliveryTarget[];
}): WorkProductSemantics {
  const { facts, goalId } = input;
  const declarations: WorkProductDeclaration[] = [];
  const rejected: { modelStep: number; index: number; reason: string }[] = [];
  const active = new Map<string, WorkProductDeclaration>();
  const admittedTargets = new Map((input.deliveryTargets ?? []).map((target) => [target.targetId, target]));
  const seen = new Map<string, string>();
  const operations = new Map(facts.operations.map((operation) => [operation.source.toolCallId, operation]));
  for (const event of input.declarations) {
    if (event.runId !== facts.runId || event.workspaceId !== facts.workspaceId || event.goalId !== goalId) continue;
    const reject = (index: number, reason: string) => rejected.push({ modelStep: event.modelStep, index, reason });
    const payload = record(event.payload);
    if (!Array.isArray(payload?.updates) || payload.updates.length > 20) { reject(-1, "invalid_updates"); continue; }
    for (const [index, raw] of payload.updates.entries()) {
      const value = record(raw);
      const id = digest(JSON.stringify([event.runId, event.workspaceId, goalId, event.modelStep, index])).slice(0, 20);
      const fingerprint = digest(JSON.stringify([event.contentSha256, raw]));
      if (seen.has(id)) {
        if (seen.get(id) !== fingerprint) reject(index, "conflicting_declaration_identity");
        continue;
      }
      seen.set(id, fingerprint);
      if (value === undefined || !["role", "issue", "delivery_target"].includes(String(value.kind))
        || !text(value.path, 1000) || !text(value.versionId, 128)) { reject(index, "invalid_object_reference"); continue; }
      const object = facts.objects.find((object) => object.path === value.path);
      const version = object?.versions.find((version) => version.id === value.versionId && version.presence === "present");
      const firstObservation = facts.observations.find((observation) => observation.id === version?.observationIds[0]);
      if (version === undefined || firstObservation === undefined || event.throughSeq === null
        || firstObservation.source.seq > event.throughSeq) { reject(index, "unobserved_object_version"); continue; }
      if (value.kind === "role" && !ROLES.includes(value.role as WorkProductRole)) { reject(index, "invalid_role"); continue; }
      if (value.kind === "delivery_target") {
        if (!text(value.targetId, 128) || !admittedTargets.has(value.targetId)) { reject(index, "unknown_delivery_target"); continue; }
        // Binding a delivery target without an immutable artifact identity would
        // merely recreate the old path/extension ambiguity.
        if (version.bytes === undefined || version.bytes <= 0 || version.sha256 === undefined) {
          reject(index, "delivery_target_requires_observed_artifact_identity"); continue;
        }
        if ([...active.values()].some((other) => other.kind === "delivery_target"
          && other.path === value.path && other.versionId === value.versionId && other.targetId !== value.targetId)) {
          reject(index, "artifact_version_already_bound"); continue;
        }
      }
      if (value.kind === "issue" && (!text(value.issueId, 80) || !text(value.symptom, 400)
        || !["open", "resolved"].includes(String(value.claimedStatus))
        || (value.diagnosis !== undefined && !text(value.diagnosis, 400)))) { reject(index, "invalid_issue"); continue; }
      const refs = ["evidenceToolCallIds", "attemptedToolCallIds", "resolutionToolCallIds"] as const;
      if (refs.some((key) => !strings(value[key], 12, 200))) { reject(index, "invalid_evidence_refs"); continue; }
      if (refs.some((key) => ((value[key] ?? []) as string[]).some((ref) => {
        const operation = operations.get(ref);
        return operation === undefined || operation.source.seq > event.throughSeq!;
      }))) { reject(index, "unknown_evidence_ref"); continue; }
      if (!strings(value.pendingActions, 6, 300)) { reject(index, "invalid_pending_actions"); continue; }
      if (value.kind === "issue" && ((value.evidenceToolCallIds ?? []) as string[]).length === 0) {
        reject(index, "issue_requires_evidence"); continue;
      }
      const key = value.kind === "role" ? `role:${value.path}`
        : value.kind === "issue" ? `issue:${value.issueId}`
        : `delivery_target:${value.targetId}`;
      const previous = active.get(key);
      if (previous?.id !== value.replaces) { reject(index, "explicit_revision_required"); continue; }
      const { payload: _, ...source } = event;
      const declaration: WorkProductDeclaration = {
        id, kind: value.kind as "role" | "issue" | "delivery_target", path: value.path as string, versionId: value.versionId as string,
        ...(previous === undefined ? {} : { replaces: previous.id }), source: { ...source, authority: "model", index },
        ...(value.kind === "role" ? { role: value.role as WorkProductRole }
          : value.kind === "delivery_target" ? { targetId: value.targetId as string }
          : {
          issueId: value.issueId as string, symptom: value.symptom as string,
          ...(value.diagnosis === undefined ? {} : { diagnosis: value.diagnosis as string }),
          claimedStatus: value.claimedStatus as "open" | "resolved",
        }),
        evidenceToolCallIds: [...(value.evidenceToolCallIds ?? []) as string[]],
        attemptedToolCallIds: [...(value.attemptedToolCallIds ?? []) as string[]],
        pendingActions: [...(value.pendingActions ?? []) as string[]],
        resolutionToolCallIds: [...(value.resolutionToolCallIds ?? []) as string[]],
      };
      declarations.push(declaration);
      active.set(key, declaration);
    }
  }
  const modelBindings = [...active.values()].filter((item) => item.kind === "delivery_target").flatMap((item): WorkProductDeliveryBinding[] => {
    const object = facts.objects.find((candidate) => candidate.path === item.path);
    const version = object?.versions.find((candidate) => candidate.id === item.versionId);
    const observation = facts.observations.find((candidate) => candidate.id === version?.observationIds[0]);
    if (
      object?.presence !== "present"
      || object.currentVersionId !== item.versionId
      || version?.bytes === undefined || version.bytes <= 0 || version.sha256 === undefined
      || observation === undefined
    ) return [];
    // A physical artifact instance can fulfill exactly one user-visible
    // target, while one leaf may still own any number of such instances.
    const duplicate = [...active.values()].some((other) => other.id !== item.id
      && other.kind === "delivery_target" && other.path === item.path && other.versionId === item.versionId
      && facts.objects.find((candidate) => candidate.path === other.path)?.currentVersionId === other.versionId);
    if (duplicate) return [];
    return [{
      targetId: item.targetId!, deliveryTargetId: admittedTargets.get(item.targetId!)?.deliveryTargetId ?? item.targetId!, path: item.path, versionId: item.versionId,
      bytes: version.bytes, sha256: version.sha256, declarationId: item.id,
      observedByToolCallId: observation.source.toolCallId, bindingAuthority: "model",
    }];
  });
  const receiptBindings = deriveReceiptSelectedDeliveryBindings({
    facts,
    goalId,
    targets: input.deliveryTargets ?? [],
  });
  const explicitBindings = [...modelBindings, ...receiptBindings];
  const runtimeBindings = deriveUnambiguousRuntimeDeliveryBindings({
    facts,
    goalId,
    targets: input.deliveryTargets ?? [],
    modelBindings: explicitBindings,
  });
  return {
    schema: "agentloop.workProductSemantics/v1", goalId, declarations, rejected,
    roles: facts.objects.map((object) => {
      const declaration = active.get(`role:${object.path}`);
      const applies = object.presence === "present" && declaration?.versionId === object.currentVersionId;
      return { path: object.path, versionId: object.currentVersionId, role: applies ? declaration!.role! : "unknown",
        ...(applies ? { declarationId: declaration!.id } : declaration === undefined ? {} : {
          historicalDeclaration: { id: declaration.id, role: declaration.role!, versionId: declaration.versionId },
        }) };
    }),
    issues: [...active.values()].filter((item) => item.kind === "issue").map((item) => {
      const object = facts.objects.find((object) => object.path === item.path)!;
      const applies = object.presence === "present" && object.currentVersionId === item.versionId;
      const successful = item.resolutionToolCallIds.filter((id) => operations.get(id)?.status === "succeeded");
      const checks = object.checks.filter((check) => {
        const observation = facts.observations.find((observation) => observation.id === check.observationId);
        return observation !== undefined && successful.includes(observation.source.toolCallId) && check.binding === "current";
      });
      return { ...item, applicability: applies ? "current" : "historical",
        resolutionSupport: item.claimedStatus !== "resolved" || !applies || successful.length === 0 ? "none"
          : checks.length > 0 && checks.every((check) => check.status === "passed") ? "version_scoped_check" : "successful_operation" };
    }),
    deliveryTargets: [...explicitBindings, ...runtimeBindings],
  };
}

/**
 * A producing Tool may select a target it was already admitted to fulfill.
 * The selection is carried in the immutable result receipt, so auxiliary files
 * do not make an otherwise valid final artifact ambiguous.  It is still
 * rejected by omission when the selected target is unknown, incompatible, or
 * shares the same artifact version with another selected target.
 */
function deriveReceiptSelectedDeliveryBindings(input: {
  readonly facts: WorkProductObservationState;
  readonly goalId: string;
  readonly targets: readonly WorkProductDeliveryTarget[];
}): WorkProductDeliveryBinding[] {
  const candidates = input.facts.objects.flatMap((object) => {
    const version = object.versions.find((candidate) => candidate.id === object.currentVersionId);
    if (object.presence !== "present" || version?.bytes === undefined || version.bytes <= 0 || version.sha256 === undefined) return [];
    return version.observationIds
      .map((id) => input.facts.observations.find((observation) => observation.id === id))
      .filter((observation): observation is NonNullable<typeof observation> =>
        observation !== undefined
        && observation.basis === "receipt"
        && observation.operationStatus === "succeeded"
        && DELIVERY_RECEIPT_TOOLS.has(observation.source.toolName)
        && observation.deliveryTargetId !== undefined,
      )
      .map((observation) => ({
        path: object.path,
        versionId: version.id,
        bytes: version.bytes!,
        sha256: version.sha256!,
        targetId: observation.deliveryTargetId!,
        observedByToolCallId: observation.source.toolCallId,
      }));
  });
  const candidateCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.path}\u0000${candidate.versionId}`;
    candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
  }
  return input.targets.flatMap((target) => {
    const matches = candidates.filter((candidate) => candidate.targetId === target.targetId
      && artifactMatchesExpectedTarget({ path: candidate.path }, target.kind, target.format));
    if (matches.length !== 1) return [];
    const candidate = matches[0]!;
    if (candidateCounts.get(`${candidate.path}\u0000${candidate.versionId}`) !== 1) return [];
    return [{
      targetId: target.targetId,
      deliveryTargetId: target.deliveryTargetId ?? target.targetId,
      path: candidate.path,
      versionId: candidate.versionId,
      bytes: candidate.bytes,
      sha256: candidate.sha256,
      declarationId: `runtime:receipt-target:${digest(JSON.stringify([input.goalId, target.targetId, candidate.path, candidate.versionId])).slice(0, 20)}`,
      observedByToolCallId: candidate.observedByToolCallId,
      bindingAuthority: "model" as const,
    }];
  });
}

/**
 * Reduce committed Runtime-observed artifact versions into delivery bindings
 * only where their relation to the admitted target set is one-to-one. This is
 * deliberately not a path or extension fallback: the candidate must carry an
 * immutable content identity, and a same-format scratch file leaves the target
 * unbound until the producer supplies an explicit target selection.
 */
function deriveUnambiguousRuntimeDeliveryBindings(input: {
  readonly facts: WorkProductObservationState;
  readonly goalId: string;
  readonly targets: readonly WorkProductDeliveryTarget[];
  readonly modelBindings: readonly WorkProductDeliveryBinding[];
}): WorkProductDeliveryBinding[] {
  const boundTargetIds = new Set(input.modelBindings.map((binding) => binding.targetId));
  const boundArtifacts = new Set(input.modelBindings.map((binding) => `${binding.path}\u0000${binding.versionId}`));
  const targets = input.targets.filter((target) => !boundTargetIds.has(target.targetId));
  const candidates = input.facts.objects.flatMap((object) => {
    const version = object.versions.find((candidate) => candidate.id === object.currentVersionId);
    if (
      object.presence !== "present"
      || version?.bytes === undefined || version.bytes <= 0 || version.sha256 === undefined
      || boundArtifacts.has(`${object.path}\u0000${version.id}`)
    ) return [];
    const observation = version.observationIds
      .map((id) => input.facts.observations.find((observation) => observation.id === id))
      .find((candidate) => candidate !== undefined
        && candidate.operationStatus === "succeeded"
        && (
          (candidate.basis === "receipt" && DELIVERY_RECEIPT_TOOLS.has(candidate.source.toolName))
          || (candidate.basis === "file_change"
            && candidate.source.toolName === "computer_run_command"
            && !input.facts.issues.some((issue) => issue.seq === candidate.source.seq && issue.code === "incomplete_file_changes"))
        ));
    if (observation === undefined) return [];
    return [{ path: object.path, versionId: version.id, bytes: version.bytes, sha256: version.sha256,
      observedByToolCallId: observation.source.toolCallId }];
  });
  const targetMatches = new Map(targets.map((target) => [target.targetId, candidates.filter((candidate) =>
    artifactMatchesExpectedTarget({ path: candidate.path }, target.kind, target.format))]));
  const candidateMatchCounts = new Map(candidates.map((candidate) => [`${candidate.path}\u0000${candidate.versionId}`, 0]));
  for (const matches of targetMatches.values()) {
    for (const candidate of matches) {
      const key = `${candidate.path}\u0000${candidate.versionId}`;
      candidateMatchCounts.set(key, (candidateMatchCounts.get(key) ?? 0) + 1);
    }
  }
  return targets.flatMap((target) => {
    const matches = targetMatches.get(target.targetId) ?? [];
    if (matches.length !== 1) return [];
    const candidate = matches[0]!;
    if (candidateMatchCounts.get(`${candidate.path}\u0000${candidate.versionId}`) !== 1) return [];
    return [{
      targetId: target.targetId,
      deliveryTargetId: target.deliveryTargetId ?? target.targetId,
      path: candidate.path,
      versionId: candidate.versionId,
      bytes: candidate.bytes,
      sha256: candidate.sha256,
      declarationId: `runtime:${digest(JSON.stringify([input.goalId, target.targetId, candidate.path, candidate.versionId])).slice(0, 20)}`,
      observedByToolCallId: candidate.observedByToolCallId,
      bindingAuthority: "runtime" as const,
    }];
  });
}

const ROLES: WorkProductRole[] = ["input", "generator", "experiment", "candidate", "unknown"];
const DELIVERY_RECEIPT_TOOLS = new Set(["computer_write_file", "computer_patch_file", "convert_artifact"]);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function strings(value: unknown, count: number, length: number): boolean {
  return value === undefined || Array.isArray(value) && value.length <= count && value.every((item) => text(item, length));
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

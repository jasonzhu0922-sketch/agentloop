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
  /** Atomic execution-selected file set for one logical instance. */
  readonly artifacts?: readonly { readonly path: string; readonly versionId: string }[];
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
  /** Includes invalidated latest selections: never fall back to an older set. */
  readonly deliverySelections?: readonly (WorkProductDeliverySelection & { readonly current: boolean })[];
}

interface WorkProductDeliverySelection {
  readonly targetId: string;
  readonly throughSeq: number;
  readonly bindings: WorkProductDeliveryBinding[];
  readonly selectedPaths?: readonly string[];
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
 * or checks. Only explicit target selections may bind an observed version.
 * A unique compatible file can still be an experiment or an incomplete draft.
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
      // Context carry-forward shares this envelope, but never creates file facts or bindings.
      if (value?.kind === "context") continue;
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
        if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 64)) {
          reject(index, "invalid_artifact_set"); continue;
        }
        const members = value.artifacts === undefined ? [value] : value.artifacts.map(record);
        if (members.some((member) => member === undefined || !text(member.path, 1000) || !text(member.versionId, 128))
          || new Set(members.map((member) => member!.path)).size !== members.length
          || !members.some((member) => member!.path === value.path && member!.versionId === value.versionId)
          || members.some((member) => {
            const object = facts.objects.find((object) => object.path === member!.path);
            const version = object?.versions.find((version) => version.id === member!.versionId && version.presence === "present");
            const observed = facts.observations.find((observation) => observation.id === version?.observationIds[0]);
            return version?.sha256 === undefined || (version.bytes ?? 0) <= 0 || observed === undefined || observed.source.seq > event.throughSeq!;
          })) { reject(index, "unobserved_artifact_set"); continue; }
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
        ...(previous === undefined ? {} : { replaces: previous.id }),
        ...(value.kind !== "delivery_target" || value.artifacts === undefined ? {} : { artifacts: value.artifacts as { path: string; versionId: string }[] }), source: { ...source, authority: "model", index },
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
  const selections = deriveReceiptSelections({ facts, goalId, targets: input.deliveryTargets ?? [] });
  for (const item of active.values()) {
    if (item.kind !== "delivery_target") continue;
    const target = admittedTargets.get(item.targetId!)!;
    const members = item.artifacts ?? [{ path: item.path, versionId: item.versionId }];
    const bindings = members.flatMap((member): WorkProductDeliveryBinding[] => {
      const object = facts.objects.find((candidate) => candidate.path === member.path);
      const version = object?.versions.find((candidate) => candidate.id === member.versionId);
      const observation = facts.observations.find((candidate) => candidate.id === version?.observationIds[0]);
      if (version?.bytes === undefined || version.sha256 === undefined || observation === undefined) return [];
      return [{ targetId: target.targetId, deliveryTargetId: target.deliveryTargetId ?? target.targetId,
        path: member.path, versionId: member.versionId, bytes: version.bytes, sha256: version.sha256,
        declarationId: item.id, observedByToolCallId: observation.source.toolCallId, bindingAuthority: "model" }];
    });
    const seq = item.source.throughSeq!;
    const previous = selections.get(target.targetId);
    // A declaration after a committed receipt at throughSeq is a newer explicit selection.
    if (previous === undefined || previous.throughSeq <= seq) selections.set(target.targetId, { targetId: target.targetId, throughSeq: seq, bindings });
  }
  const selected = [...selections.values()];
  const owners = new Map<string, Set<string>>();
  for (const selection of selected) for (const binding of selection.bindings) {
    const key = `${binding.path}\u0000${binding.versionId}`;
    owners.set(key, new Set([...(owners.get(key) ?? []), selection.targetId]));
  }
  const deliverySelections = selected.map((selection) => {
    const target = admittedTargets.get(selection.targetId)!;
    const current = selection.bindings.length > 0
      && (selection.selectedPaths === undefined || selection.selectedPaths.length === selection.bindings.length)
      && selection.bindings.every((binding) => {
        const object = facts.objects.find((object) => object.path === binding.path);
        return object?.presence === "present" && object.currentVersionId === binding.versionId
          && artifactMatchesExpectedTarget({ path: binding.path }, target.kind, target.format)
          && owners.get(`${binding.path}\u0000${binding.versionId}`)?.size === 1;
      });
    return { ...selection, current };
  });
  const explicitBindings = deliverySelections.filter((selection) => selection.current).flatMap((selection) => selection.bindings);
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
    deliveryTargets: explicitBindings,
    deliverySelections,
  };
}

/**
 * A producing Tool may select a target it was already admitted to fulfill.
 * The selection is carried in the immutable result receipt, so auxiliary files
 * do not make an otherwise valid final artifact ambiguous.  It is still
 * rejected by omission when the selected target is unknown, incompatible, or
 * shares the same artifact version with another selected target.
 */
function deriveReceiptSelections(input: {
  readonly facts: WorkProductObservationState;
  readonly goalId: string;
  readonly targets: readonly WorkProductDeliveryTarget[];
}): Map<string, WorkProductDeliverySelection> {
  const selected = new Map<string, WorkProductDeliverySelection>();
  for (const operation of input.facts.operations) {
    if (operation.status !== "succeeded" || operation.outputBindings === undefined) continue;
    for (const target of input.targets) {
      const paths = operation.outputBindings.filter((binding) => binding.targetId === target.targetId).map((binding) => binding.path);
      if (paths.length > 0) selected.set(target.targetId, {
        targetId: target.targetId, throughSeq: operation.source.seq, bindings: [], selectedPaths: paths,
      });
    }
  }
  // Select from ALL committed incarnations first, then validate currentness.
  // Filtering to present files first would resurrect an old version after deletion.
  for (const observation of input.facts.observations) {
    if (observation.operationStatus !== "succeeded" || observation.deliveryTargetId === undefined
      || !((observation.basis === "receipt" && (DELIVERY_RECEIPT_TOOLS.has(observation.source.toolName) || observation.source.toolName === "computer_run_command"))
        || (observation.basis === "file_change" && observation.source.toolName === "computer_run_command"))) continue;
    const target = input.targets.find((target) => target.targetId === observation.deliveryTargetId);
    if (target === undefined) continue;
    const object = input.facts.objects.find((object) => object.path === observation.path);
    const version = object?.versions.find((version) => version.observationIds.includes(observation.id));
    const previous = selected.get(target.targetId);
    if (previous !== undefined && previous.throughSeq > observation.source.seq) continue;
    const selection = previous?.throughSeq === observation.source.seq ? previous
      : { targetId: target.targetId, throughSeq: observation.source.seq, bindings: [] as WorkProductDeliveryBinding[] };
    selected.set(target.targetId, selection);
    if (version?.sha256 === undefined || (version.bytes ?? 0) <= 0 || observation.kind === "deleted") continue;
    if (selection.bindings.some((binding) => binding.path === object!.path && binding.versionId === version.id)) continue;
    const firstObservation = input.facts.observations.find(item => item.id === version.observationIds[0])!;
    selection.bindings.push({
      targetId: target.targetId, deliveryTargetId: target.deliveryTargetId ?? target.targetId,
      path: object!.path, versionId: version.id, bytes: version.bytes!, sha256: version.sha256,
      declarationId: `runtime:receipt-target:${digest(JSON.stringify([input.goalId, target.targetId, observation.source.seq, object!.path, version.id])).slice(0, 20)}`,
      observedByToolCallId: firstObservation.source.toolCallId, bindingAuthority: observation.source.toolName === "computer_run_command" ? "runtime" : "model",
    });
  }
  return selected;
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

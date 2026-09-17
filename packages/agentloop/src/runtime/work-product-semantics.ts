import { createHash } from "node:crypto";
import type { WorkProductObservationState } from "./work-product-observations.ts";

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
  readonly kind: "role" | "issue";
  readonly path: string;
  readonly versionId: string;
  readonly replaces?: string;
  readonly source: Omit<WorkProductDeclarationEvent, "payload"> & { readonly authority: "model"; readonly index: number };
  readonly role?: WorkProductRole;
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

/** Pure interpretation layer: declarations never alter observations, versions, checks or delivery. */
export function deriveWorkProductSemantics(input: {
  readonly facts: WorkProductObservationState;
  readonly goalId: string;
  readonly declarations: readonly WorkProductDeclarationEvent[];
}): WorkProductSemantics {
  const { facts, goalId } = input;
  const declarations: WorkProductDeclaration[] = [];
  const rejected: { modelStep: number; index: number; reason: string }[] = [];
  const active = new Map<string, WorkProductDeclaration>();
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
      if (value === undefined || !["role", "issue"].includes(String(value.kind))
        || !text(value.path, 1000) || !text(value.versionId, 128)) { reject(index, "invalid_object_reference"); continue; }
      const object = facts.objects.find((object) => object.path === value.path);
      const version = object?.versions.find((version) => version.id === value.versionId && version.presence === "present");
      const firstObservation = facts.observations.find((observation) => observation.id === version?.observationIds[0]);
      if (version === undefined || firstObservation === undefined || event.throughSeq === null
        || firstObservation.source.seq > event.throughSeq) { reject(index, "unobserved_object_version"); continue; }
      if (value.kind === "role" && !ROLES.includes(value.role as WorkProductRole)) { reject(index, "invalid_role"); continue; }
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
      const key = value.kind === "role" ? `role:${value.path}` : `issue:${value.issueId}`;
      const previous = active.get(key);
      if (previous?.id !== value.replaces) { reject(index, "explicit_revision_required"); continue; }
      const { payload: _, ...source } = event;
      const declaration: WorkProductDeclaration = {
        id, kind: value.kind as "role" | "issue", path: value.path as string, versionId: value.versionId as string,
        ...(previous === undefined ? {} : { replaces: previous.id }), source: { ...source, authority: "model", index },
        ...(value.kind === "role" ? { role: value.role as WorkProductRole } : {
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
  };
}

const ROLES: WorkProductRole[] = ["input", "generator", "experiment", "candidate", "unknown"];
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function strings(value: unknown, count: number, length: number): boolean {
  return value === undefined || Array.isArray(value) && value.length <= count && value.every((item) => text(item, length));
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

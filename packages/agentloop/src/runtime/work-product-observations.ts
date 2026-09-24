import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { AgentLoopToolEvidence } from "./contracts.ts";
import { parseJsonRecord } from "./tool-result-evidence.ts";

/** Pure factual input; live loop order must be distinguished from persisted event seq. */
export interface WorkProductToolEvent {
  readonly runId: string;
  /** Explicit workspace identity: equal relative paths in different roots are not equal objects. */
  readonly workspaceId: string;
  readonly seq: number;
  readonly sequenceKind?: "persisted_event" | "loop_observation";
  readonly sequenceScope?: string;
  readonly evidence: AgentLoopToolEvidence;
}

export interface WorkProductSource {
  readonly runId: string;
  readonly workspaceId: string;
  readonly seq: number;
  readonly sequenceKind?: "persisted_event" | "loop_observation";
  readonly sequenceScope?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** Digest of the supplied raw result, never a digest of the artifact. */
  readonly resultSha256: string;
  readonly pointer: string;
}

export interface WorkProductObservation {
  readonly id: string;
  readonly objectId: string;
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted" | "observed" | "referenced";
  readonly basis: "file_change" | "file_metadata" | "receipt";
  readonly bytes?: number;
  readonly sha256?: string;
  readonly operationStatus: "succeeded" | "failed" | "unknown";
  readonly source: WorkProductSource;
  /** Only explicit, structured, version-scoped checks; stdout prose is not a check. */
  readonly checks: readonly { readonly id: string; readonly status: string }[];
}

export interface WorkProductObservationIssue {
  readonly seq: number;
  readonly code: "invalid_result" | "invalid_path" | "invalid_metadata" | "incomplete_file_changes" | "conflicting_event" | "conflicting_observations";
  readonly pointer: string;
}

export interface WorkProductOperation {
  readonly source: WorkProductSource;
  readonly status: WorkProductObservation["operationStatus"];
  readonly contentRefs: readonly { readonly path: string; readonly sha256: string; readonly bytes?: number }[];
}

export interface WorkProductVersion {
  /** An observed incarnation, not a fabricated content hash. */
  readonly id: string;
  readonly presence: "present" | "deleted";
  readonly bytes?: number;
  readonly sha256?: string;
  readonly observationIds: readonly string[];
}

export interface WorkProductObject {
  readonly id: string;
  readonly path: string;
  readonly presence: "present" | "deleted" | "unknown";
  readonly currentVersionId?: string;
  readonly versions: readonly WorkProductVersion[];
  readonly observationIds: readonly string[];
  readonly checks: readonly {
    readonly observationId: string;
    readonly id: string;
    readonly status: string;
    readonly versionId?: string;
    readonly binding: "current" | "historical" | "unknown";
  }[];
}

export interface WorkProductObservationState {
  readonly schema: "agentloop.workProductObservations/v1";
  readonly runId: string;
  readonly workspaceId: string;
  readonly throughSeq: number | null;
  readonly operations: readonly WorkProductOperation[];
  readonly observations: readonly WorkProductObservation[];
  readonly objects: readonly WorkProductObject[];
  readonly issues: readonly WorkProductObservationIssue[];
}

/** Read a single canonical tool result, without reading files or interpreting model prose. */
export function normalizeWorkProductObservations(event: WorkProductToolEvent): {
  operation: WorkProductOperation;
  observations: WorkProductObservation[];
  issues: WorkProductObservationIssue[];
} {
  const { evidence } = event;
  const root = parseJsonRecord(evidence.result);
  const source: WorkProductSource = {
    runId: event.runId, workspaceId: event.workspaceId, seq: event.seq, toolCallId: evidence.toolCallId,
    toolName: evidence.toolName, resultSha256: digest(evidence.result), pointer: "",
    ...(event.sequenceKind === undefined ? {} : { sequenceKind: event.sequenceKind }),
    ...(event.sequenceScope === undefined ? {} : { sequenceScope: event.sequenceScope }),
  };
  const status = operationStatus(evidence, root);
  const observations: WorkProductObservation[] = [];
  const issues: WorkProductObservationIssue[] = [];
  const issue = (code: WorkProductObservationIssue["code"], pointer: string) => {
    issues.push({ seq: event.seq, code, pointer });
  };
  const contentRefs: WorkProductOperation["contentRefs"][number][] = [];
  for (const key of ["stdoutRef", "stderrRef", "contentLocation"]) {
    const ref = record(root?.[key]);
    if (typeof ref?.path === "string" && hash(ref.sha256) !== undefined) {
      contentRefs.push({ path: ref.path, sha256: hash(ref.sha256)!, ...size(ref.bytes) });
    }
  }
  const operation: WorkProductOperation = { source, status, contentRefs };
  if (root === undefined) {
    // Plain-text tools are valid, but they do not declare file observations.
    if (/^\s*[{[]/.test(evidence.result)) {
      try { JSON.parse(evidence.result); } catch { issue("invalid_result", ""); }
    }
    return { operation, observations, issues };
  }
  const add = (
    value: Record<string, unknown>, pointer: string, kind: WorkProductObservation["kind"],
    basis: WorkProductObservation["basis"], checks: WorkProductObservation["checks"] = [],
  ) => {
    const path = workspacePath(value.path);
    if (path === undefined) { issue("invalid_path", pointer); return; }
    if ((value.bytes !== undefined && size(value.bytes).bytes === undefined)
      || (value.sha256 !== undefined && hash(value.sha256) === undefined)) issue("invalid_metadata", pointer);
    const location = { ...source, pointer };
    observations.push({
      id: digest(JSON.stringify([location, kind, status])),
      objectId: JSON.stringify([event.workspaceId, path]), path, kind, basis,
      ...(kind === "deleted" ? {} : size(value.bytes)),
      ...(kind === "deleted" || hash(value.sha256) === undefined ? {} : { sha256: hash(value.sha256) }),
      operationStatus: status, source: location, checks,
    });
  };

  // This list is a transport-format adapter, not a business/extension classifier.
  // fileChanges are Runtime-observed side effects even when the operation failed.
  if (evidence.toolName === "computer_run_command") {
    if (root.fileChangesTruncated === true) issue("incomplete_file_changes", "/fileChanges");
    if (Array.isArray(root.fileChanges)) root.fileChanges.forEach((value, index) => {
      const change = record(value);
      if (change !== undefined && ["created", "modified", "deleted"].includes(String(change.changeType))) {
        add(change, `/fileChanges/${index}`, change.changeType as WorkProductObservation["kind"], "file_change");
      } else issue("invalid_metadata", `/fileChanges/${index}`);
    });
  }
  if (status === "succeeded" && evidence.toolName === "computer_write_file") {
    add(root, "", root.mode === "create" ? "created" : "modified", "file_metadata");
  } else if (status === "succeeded" && evidence.toolName === "computer_patch_file") {
    add({ ...record(root.after), path: root.path }, "/after", "modified", "file_metadata");
  } else if (status === "succeeded" && FILE_METADATA_TOOLS.has(evidence.toolName) && root.path !== undefined) {
    add(root, "", "observed", "file_metadata");
  }

  // A receipt remains a reference unless its originating Runtime tool actually
  // observed the file. In particular, never upgrade arbitrary command stdout.
  const receipts = [[root, ""], [record(root.artifactReceipt), "/artifactReceipt"]] as const;
  for (const [receipt, pointer] of receipts) {
    if (receipt === undefined || !["agentloop.artifactReceipt/v1", "agentloop.artifactAcceptance/v1"].includes(String(receipt.schema))) continue;
    const artifact = record(receipt.artifact);
    if (artifact === undefined) continue;
    const trustedAcceptance = evidence.toolName === "verify_artifact_acceptance"
      && receipt.schema === "agentloop.artifactAcceptance/v1"
      && evidence.invocationStatus !== "failed" && evidence.invocationStatus !== "rejected";
    const trustedReceipt = status === "succeeded" && RECEIPT_TOOLS.has(evidence.toolName);
    const checks = trustedAcceptance && Array.isArray(receipt.checks)
      ? receipt.checks.flatMap((value) => {
        const check = record(value);
        return typeof check?.id === "string" && ["passed", "failed", "skipped_unavailable"].includes(String(check.status))
          ? [{ id: check.id, status: String(check.status) }] : [];
      }) : [];
    add(artifact, `${pointer}/artifact`, trustedAcceptance || trustedReceipt ? "observed" : "referenced", "receipt", checks);
  }
  return { operation, observations, issues };
}

/**
 * Derive from the COMPLETE applicable event set, then let a future consumer
 * project it. No windowing, filesystem IO, delivery/purpose inference or writes.
 * seq is the persisted per-Run observation order, not proof of concurrent write order.
 * Other Runs/workspaces are excluded; authorized dependency merging is future work.
 */
export function deriveWorkProductObservations(input: {
  readonly runId: string;
  readonly workspaceId: string;
  readonly events: readonly WorkProductToolEvent[];
}): WorkProductObservationState {
  const groups = new Map<number, Map<string, WorkProductToolEvent>>();
  for (const event of input.events) {
    if (event.runId !== input.runId || event.workspaceId !== input.workspaceId) continue;
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error("Work-product events require a durable non-negative seq");
    const key = stableJson(event.evidence);
    const group = groups.get(event.seq) ?? new Map();
    group.set(key, event);
    groups.set(event.seq, group);
  }
  const operations: WorkProductOperation[] = [];
  const observations: WorkProductObservation[] = [];
  const issues: WorkProductObservationIssue[] = [];
  const conflictedSeqs = new Set<number>();
  for (const [seq, group] of [...groups].sort(([a], [b]) => a - b)) {
    if (group.size > 1) {
      conflictedSeqs.add(seq);
      issues.push({ seq, code: "conflicting_event", pointer: "" });
    }
    for (const [, event] of [...group].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const normalized = normalizeWorkProductObservations(event);
      operations.push(normalized.operation);
      observations.push(...normalized.observations);
      issues.push(...normalized.issues);
    }
  }
  const byObject = new Map<string, WorkProductObservation[]>();
  for (const observation of observations) {
    const group = byObject.get(observation.objectId) ?? [];
    group.push(observation);
    byObject.set(observation.objectId, group);
  }
  const objects = [...byObject].map(([id, history]): WorkProductObject => {
    const ambiguous = new Set<number>();
    const bySeq = new Map<number, WorkProductObservation[]>();
    for (const item of history) {
      if (item.kind === "referenced") continue;
      const group = bySeq.get(item.source.seq) ?? [];
      group.push(item);
      bySeq.set(item.source.seq, group);
    }
    for (const [seq, sameEvent] of bySeq) {
      if (new Set(sameEvent.map((item) => item.sha256).filter((hash) => hash !== undefined)).size > 1
        || new Set(sameEvent.map((item) => item.bytes).filter((bytes) => bytes !== undefined)).size > 1
        || (sameEvent.some((item) => item.kind === "deleted") && sameEvent.some((item) => item.kind !== "deleted"))) {
        ambiguous.add(seq);
        issues.push({ seq, code: "conflicting_observations", pointer: id });
      }
    }
    const versions: WorkProductVersion[] = [];
    const checks: WorkProductObject["checks"][number][] = [];
    let current: WorkProductVersion | undefined;
    for (const observation of history) {
      if (conflictedSeqs.has(observation.source.seq) || ambiguous.has(observation.source.seq)) {
        current = undefined; // Retain observations, but do not invent a winner.
      } else if (observation.kind !== "referenced") {
        const sameContent = observation.kind === "observed" && current?.presence === "present"
          && observation.sha256 !== undefined && observation.sha256 === current.sha256
          && (observation.bytes === undefined || current.bytes === undefined || observation.bytes === current.bytes);
        if (sameContent) {
          current = { ...current!, ...(observation.bytes === undefined ? {} : { bytes: observation.bytes }),
            observationIds: [...current!.observationIds, observation.id] };
          versions[versions.length - 1] = current;
        } else {
          current = {
            id: observation.id, presence: observation.kind === "deleted" ? "deleted" : "present",
            ...(observation.bytes === undefined ? {} : { bytes: observation.bytes }),
            ...(observation.sha256 === undefined ? {} : { sha256: observation.sha256 }),
            observationIds: [observation.id],
          };
          versions.push(current);
        }
      }
      for (const check of observation.checks) checks.push({
        ...check, observationId: observation.id, binding: "unknown",
        ...(observation.sha256 !== undefined && current?.presence === "present"
          && current.sha256 === observation.sha256 ? { versionId: current.id } : {}),
      });
    }
    return {
      id, path: history[0].path, presence: current?.presence ?? "unknown",
      ...(current === undefined ? {} : { currentVersionId: current.id }), versions,
      observationIds: history.map((observation) => observation.id),
      checks: checks.map((check) => ({ ...check, binding: check.versionId === undefined || current === undefined
        ? "unknown" : check.versionId === current.id && current.presence === "present" ? "current" : "historical" })),
    };
  });
  return {
    schema: "agentloop.workProductObservations/v1", runId: input.runId, workspaceId: input.workspaceId,
    throughSeq: groups.size === 0 ? null : [...groups.keys()].reduce((max, seq) => Math.max(max, seq), 0),
    operations, observations, objects, issues,
  };
}

const FILE_METADATA_TOOLS = new Set(["computer_read_json", "materialize_source_file"]);
const RECEIPT_TOOLS = new Set(["computer_write_file", "computer_patch_file", "convert_artifact"]);

function operationStatus(evidence: AgentLoopToolEvidence, result: Record<string, unknown> | undefined): WorkProductObservation["operationStatus"] {
  if (evidence.isError || evidence.operationStatus === "failed" || evidence.invocationStatus === "failed"
    || evidence.invocationStatus === "rejected" || result?.timedOut === true || typeof result?.signal === "string"
    || [evidence.exitCode, result?.exitCode].some((code) => typeof code === "number" && code !== 0)) return "failed";
  if (evidence.operationStatus === "succeeded" || evidence.exitCode === 0 || result?.exitCode === 0) return "succeeded";
  // Legacy evidence has only isError. A completed non-command tool result is observable.
  if (evidence.toolName !== "computer_run_command" && evidence.operationStatus !== "unknown") return "succeeded";
  return "unknown";
}

function workspacePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || value.startsWith("@") || /^[a-z]+:/i.test(value)) return undefined;
  const path = posix.normalize(value);
  return path === "." || path === ".." || path.startsWith("../") ? undefined : path;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function hash(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}
function size(value: unknown): { bytes?: number } {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? { bytes: value } : {};
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = record(value);
  return obj === undefined ? JSON.stringify(value) : `{${Object.keys(obj).sort().filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

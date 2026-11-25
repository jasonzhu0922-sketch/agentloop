import { createHash } from "node:crypto";
import type { CommittedDecisionRecords } from "./committed-decision-records.ts";
import type { ModelMessage } from "./contracts.ts";
import type { CurrentDecisionView } from "./current-decision-view.ts";
import { parseRuntimeResultRef, type RuntimeResultRef } from "./runtime-result.ts";
import { decisionContextArgumentUpdates, decisionContextArgumentDecisions } from "./decision-context-transport.ts";
import { deriveCurrentEvidence, type CurrentEvidence } from "./current-evidence.ts";

/** Derived from the existing committed transcript, never an authority or database. */
export interface DecisionContextItem {
  readonly id: string;
  readonly revision: string;
  readonly supersedes?: { readonly id: string; readonly revision: string };
  readonly category: "observation" | "inference" | "unknown" | "conflict" | "decision" | "commitment";
  readonly text: string;
  readonly scope: string;
  readonly certainty: "observed" | "tentative" | "unknown";
  readonly status: "active" | "resolved";
  readonly authority: "model";
  readonly source: { readonly toolCallIds: readonly string[]; readonly canonicalState?: CurrentDecisionView["identity"]["canonicalState"] };
  readonly evidence: readonly { toolCallId: string; result?: RuntimeResultRef }[];
  readonly version?: { path: string; versionId: string };
}
export interface DecisionWorkingSet {
  readonly schema: "agentloop.decisionWorkingSet/v1";
  readonly items: readonly DecisionContextItem[];
  readonly historicalItemCount: number;
  readonly absorbedExchangeCount: number;
  readonly retainedExchangeCount: number;
  /** Exact evidence materialized by Runtime even when the model emits no updates. */
  readonly currentEvidence?: readonly CurrentEvidence[];
  /** The model's current task interpretation joined to its committed action.
   * This never closes a canonical gap or proves a domain fact. */
  readonly currentDecision?: {
    readonly authority: "model";
    readonly target: string;
    readonly progress: string;
    readonly remaining: string;
    readonly purpose: string;
    readonly disposition: "carry" | "retain";
    readonly evidence: readonly { readonly toolCallId: string; readonly result?: RuntimeResultRef }[];
    readonly source: { readonly toolCallId: string; readonly toolName: string; readonly identity: CurrentDecisionView["identity"]; readonly result?: RuntimeResultRef };
    readonly outcome: { readonly invocationStatus: string; readonly operationStatus: string; readonly receipt: "committed" | "missing" };
    /** Matching arguments are a navigation hint, never permission to skip/retry effects. */
    readonly priorMatchingSuccess?: { readonly count: number; readonly toolCallId: string; readonly result?: RuntimeResultRef };
  };
  /** Other actions in the same decision batch; none is overwritten by a sibling. */
  readonly parallelDecisions?: readonly NonNullable<DecisionWorkingSet["currentDecision"]>[];
  /** Runtime observation frontier; semantic prose can predate these effects. */
  readonly latestCommittedAction?: {
    readonly checkpointOrdinal: number;
    readonly toolCalls: readonly { readonly toolCallId: string; readonly toolName: string; readonly resultRef?: RuntimeResultRef;
      readonly invocationStatus: string; readonly operationStatus: string; readonly receipt: "committed" | "missing" }[];
  };
  readonly historicalObservationCount?: number;
  readonly materializedObservationCount?: number;
  /** Completed observations not yet reconciled; explicit incompleteness, not a summary. */
  readonly pendingToolCallIds: readonly string[];
  /** Request-local names for currently relevant committed observations. */
  readonly evidenceReferences?: readonly { readonly ref: string; readonly toolCallId: string; readonly resultId?: string }[];
  readonly rejectionCount: number;
  readonly rejectedUpdates?: readonly { readonly id?: string; readonly reason: string; readonly expectedRevision?: string; readonly missingFields?: readonly string[]; readonly invalidFields?: readonly string[]; readonly taskBlocking?: false }[];
  readonly gaps: readonly string[];
  readonly history?: { readonly anchor: RuntimeResultRef; readonly runId: string; readonly planId: string; readonly stepId: string };
}
interface Exchange {
  readonly assistant: Extract<ModelMessage, { role: "assistant" }>;
  readonly results: readonly Extract<ModelMessage, { role: "tool" }>[];
  readonly start: number;
  readonly end: number;
}
export const ACTION_DECISION_INSTRUCTION = "With each ordinary action emit _agentloopContext.decision: target=stable work subject; progress=supported work with limits; remaining=open needs/unknowns; purpose=how this action advances them; evidence=visible refs ([] if none); disposition=retain or carry. These are model interpretations, not facts, authority or completion. carry declares ALL still-needed content of cited observations is preserved in progress/remaining and current items; otherwise retain. Current sources stay exact; only inactive carried detail can retire. Preserve durable conflicts, unknowns and promises with updates. currentDecision.outcome is the committed operation outcome, not proof its purpose succeeded. Reconcile it in the next normal decision, without a maintenance call. priorMatchingSuccess locates same-input/same-version success; inspect it and explain any repeat. It grants no reuse/retry permission.";

export const DECISION_WORKING_SET_INSTRUCTION = [
  "Decide from the exact user goal/authority, current state/products and exact currentEvidence; consult history for missing details. Runtime materializes committed Results without a model summary or maintenance turn. arguments identify source selection; result is the observed receipt, never proof of domain truth, completeness, authorization or completion. Different scopes/versions remain distinct. A replacement file does not repair a conclusion from another scope. Check conflicts before combining values.",
  "Use currentEvidence directly. latestCommittedAction is the Runtime receipt frontier, not a model claim. Model items and assistant statements are authored BEFORE their source action executes: pending/next language there does not undo later committed outcomes. Check the frontier before repeating actions. Repeated identical reads share one copy; obsolete consumed file reads move to history. Historical does not mean resolved. Missing necessary content remains a gap; read it before relying on it.",
  "Optional _agentloopContext.updates records CHANGED semantic findings, conflicts, unknowns, decisions or promises alongside a normal action. Runtime strips it before execution. Do not duplicate exact receipts, journal steps, emit updates as prose, or call tools solely to maintain state. Final answers use pending receipts directly.",
  "Reuse stable item ids for the same subject/scope; preserve necessary exact values, conflicts and uncertainty. Distinct sources stay distinct. evidence accepts visible @e aliases, exact Result IDs or call IDs bound to this request. Never invent references, cite another Run or an unexecuted call. Runtime checks provenance and presented revisions; all item content remains model interpretation.",
  "disposition=carry declares text contains ALL still-needed content of its cited observations; completed exchanges may then leave input if effect/protocol safety permits. retain keeps the original content. Do not claim carry merely to shorten input. version binds only an observed current file version. Superseded/deleted version-bound items leave the current view without resolving unrelated issues.",
  "To resolve an existing issue/unknown/promise, name its current id in resolves, explain the resolution and cite NEW successful evidence. A same-id finding may resolve its prior unknown incarnation. Tool success alone closes neither unrelated issues nor canonical gaps. Rejected updates preserve prior state/evidence and need no repair-only turn.",
  'History remains durable. read_result(resultId=history.anchor.resultId,view="step_history",pointer="/entries",offset/limit) locates exchanges; view="producer_exchange",toolCallId retrieves exact arguments/text/receipts. Default view reads the authorized Result. Reuse acquired same-version windows. Never repeat effects to recover output; unknown effects do not authorize retries.',
].join("\n");

/** Complete native exchanges only. Unknown, partial and provider state stay native. */
function exchanges(messages: readonly ModelMessage[]): Exchange[] {
  const output: Exchange[] = [];
  for (let start = 0; start < messages.length; start++) {
    const assistant = messages[start];
    if (assistant.role !== "assistant" || !assistant.toolCalls?.length) continue;
    let end = start + 1;
    const results: Exchange["results"][number][] = [];
    while (messages[end]?.role === "tool") results.push(messages[end++] as Exchange["results"][number]);
    const ids = new Set(assistant.toolCalls.map(call => call.id));
    if (ids.size === assistant.toolCalls.length && results.length === ids.size
      && new Set(results.map(result => result.toolCallId)).size === ids.size
      && results.every(result => ids.has(result.toolCallId) && assistant.toolCalls!.some(call => call.id === result.toolCallId && call.name === result.name))) {
      output.push({ assistant, results, start, end });
      start = end - 1;
    }
  }
  return output;
}

export function deriveDecisionWorkingSet(input: {
  readonly runId: string;
  readonly messages: readonly ModelMessage[];
  readonly currentView?: CurrentDecisionView;
  /** Authoritative semantic input. messages only control native protocol release. */
  readonly records?: CommittedDecisionRecords;
  /** Enabled only with an authorized history reader and releasable Provider. */
  readonly materializeObservations?: boolean;
  readonly evidenceBudgetCharacters?: number;
  readonly evidenceEntryCharacters?: number;
}) {
  const batches = exchanges(input.messages);
  const inScope = (identity: CurrentDecisionView["identity"] | undefined) => identity?.runId === input.runId
    && (input.currentView === undefined || input.currentView.identity.stepId === "unknown" || identity.stepId === input.currentView.identity.stepId && identity.planId === input.currentView.identity.planId);
  // Message-only hosts remain compatible; the kernel passes committed records.
  // Semantics do not depend on whether a call formed a Provider-valid exchange.
  const records: CommittedDecisionRecords = input.records ?? {
    checkpoints: input.messages.flatMap((message, position) => message.role === "assistant" && message.toolCalls?.length
      ? [{ position, content: message.content, toolCalls: message.toolCalls, basis: message.executionHistoryBasis }] : []),
    observations: input.messages.flatMap((message, position) => message.role === "tool" ? [{ ...message, position }] : []),
  };
  const owners = new Map<string, CommittedDecisionRecords["checkpoints"][number][]>();
  for (const checkpoint of records.checkpoints) for (const call of checkpoint.toolCalls) {
    owners.set(call.id, [...(owners.get(call.id) ?? []), checkpoint]);
  }
  const byId = new Map(records.observations.flatMap(result => {
    const candidates = owners.get(result.toolCallId) ?? [];
    const checkpoint = candidates.length === 1 && !records.ambiguousToolCallIds?.includes(result.toolCallId) ? candidates[0] : undefined;
    return checkpoint?.toolCalls.some(call => call.id === result.toolCallId && call.name === result.name)
      ? [[result.toolCallId, { checkpoint, result }] as const] : [];
  }));
  // Index acknowledged successes once. Looking up a previous attempt must not
  // rescan the entire ledger for each ordinary decision during reconstruction.
  const priorSuccesses = new Map<string, { availableAt: number; result: CommittedDecisionRecords["observations"][number] }[]>();
  for (const [id, { checkpoint, result }] of byId) {
    if (!inScope(checkpoint.basis?.identity) || !checkpoint.basis || result.isError
      || result.executionOutcome?.invocationStatus !== "completed" || result.executionOutcome.operationStatus !== "succeeded") continue;
    const call = checkpoint.toolCalls.find(call => call.id === id)!;
    const key = actionKey(call.name, call.arguments, checkpoint.basis);
    const entries = priorSuccesses.get(key) ?? [];
    entries.push({ availableAt: Math.max(checkpoint.position, result.position), result });
    priorSuccesses.set(key, entries);
  }
  for (const entries of priorSuccesses.values()) entries.sort((a, b) => a.availableAt - b.availableAt);
  const items = new Map<string, DecisionContextItem>();
  let currentDecision: DecisionWorkingSet["currentDecision"];
  let parallelDecisions: DecisionWorkingSet["parallelDecisions"];
  let acceptedUpdateCount = 0;
  const absorbed = new Set<string>();
  const rejections: { at: number; index: number; reason: string }[] = [];
  const unresolvedRejections = new Map<string, NonNullable<DecisionWorkingSet["rejectedUpdates"]>[number]>();
  for (const checkpoint of records.checkpoints) {
    const basis = checkpoint.basis;
    if (!basis || !inScope(basis.identity)) continue;
    const checkpointDecisions: NonNullable<DecisionWorkingSet["currentDecision"]>[] = [];
    for (const call of checkpoint.toolCalls) {
      if (!basis.contextArgumentTools?.includes(call.name)) continue;
      const proposal = decisionContextArgumentDecisions([call], basis.contextArgumentTools, basis.contextEvidenceBindings)[0]?.decision;
      // Old committed archives have no decision frame. Never invent one from
      // prose or receipts; require it only when the persisted request offered it.
      if (proposal === undefined && !basis.contextDecisionRequired) continue;
      const refs = proposal?.evidence;
      const valid = proposal && text(proposal.target, 240) && text(proposal.progress, 1600)
        && text(proposal.remaining, 1600) && text(proposal.purpose, 1000) && strings(refs, 32)
        && ["carry", "retain"].includes(String(proposal.disposition))
        && refs.every(id => {
          const source = byId.get(id);
          const identity = source?.checkpoint.basis?.identity;
          return source && source.result.position < checkpoint.position && source.checkpoint !== checkpoint
            && inScope(source.checkpoint.basis?.identity)
            && identity?.planId === basis.identity.planId && identity?.stepId === basis.identity.stepId
            && (basis.contextEvidenceToolCallIds === undefined || basis.contextEvidenceToolCallIds.includes(id));
        }) && owners.get(call.id)?.length === 1 && !records.ambiguousToolCallIds?.includes(call.id);
      if (!valid) {
        rejections.push({ at: checkpoint.position, index: -1, reason: "invalid_action_decision" });
        unresolvedRejections.set("action-decision", { reason: "invalid_action_decision", taskBlocking: false });
        continue;
      }
      unresolvedRejections.delete("action-decision");
      const sourceResult = byId.get(call.id)?.result;
      const key = actionKey(call.name, call.arguments, basis);
      const matching = priorSuccesses.get(key) ?? [];
      let low = 0, high = matching.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (matching[mid].availableAt < checkpoint.position) low = mid + 1; else high = mid;
      }
      const previous = matching[low - 1]?.result;
      checkpointDecisions.push({
        authority: "model", target: proposal.target as string, progress: proposal.progress as string,
        remaining: proposal.remaining as string, purpose: proposal.purpose as string,
        disposition: proposal.disposition as "carry" | "retain",
        evidence: [...new Set(refs as string[])].map(id => ({ toolCallId: id,
          ...(observationRef(byId.get(id)!.result) ? { result: observationRef(byId.get(id)!.result) } : {}) })),
        source: { toolCallId: call.id, toolName: call.name, identity: basis.identity,
          ...(sourceResult && observationRef(sourceResult) ? { result: observationRef(sourceResult) } : {}) },
        outcome: { invocationStatus: sourceResult?.executionOutcome?.invocationStatus ?? "unknown",
          operationStatus: sourceResult?.executionOutcome?.operationStatus ?? "unknown", receipt: sourceResult ? "committed" : "missing" },
        ...(previous ? { priorMatchingSuccess: { count: low, toolCallId: previous.toolCallId,
          ...(observationRef(previous) ? { result: observationRef(previous) } : {}) } } : {}),
      });
    }
    if (checkpointDecisions.length) {
      currentDecision = checkpointDecisions.at(-1);
      parallelDecisions = checkpointDecisions.slice(0, -1);
      // A malformed sibling cannot authorize partial retirement of a batch.
      if (checkpointDecisions.length === checkpoint.toolCalls.filter(call => basis.contextArgumentTools?.includes(call.name)).length) {
        for (const frame of checkpointDecisions) if (frame.disposition === "carry") frame.evidence.forEach(ref => absorbed.add(ref.toolCallId));
      }
    }
    const updates = decisionContextArgumentUpdates(checkpoint.toolCalls, basis.contextArgumentTools, basis.contextEvidenceBindings);
    if (updates.length > 20) {
      rejections.push({ at: checkpoint.position, index: -1, reason: "invalid_progress_envelope" });
      unresolvedRejections.set("envelope", { reason: "invalid_progress_envelope", taskBlocking: false });
      continue;
    }
    unresolvedRejections.delete("envelope");
    for (const [index, raw] of updates.entries()) {
      const value = record(raw);
      if (value?.kind !== "context") continue;
      const reject = (reason: string, repair: { expectedRevision?: string; missingFields?: readonly string[]; invalidFields?: readonly string[] } = {}) => {
        rejections.push({ at: checkpoint.position, index, reason });
        unresolvedRejections.set(typeof value.id === "string" ? value.id : "invalid-id", { ...(typeof value.id === "string" ? { id: value.id } : {}), reason, taskBlocking: false, ...repair });
      };
      if (!text(value.id, 120) || !text(value.text, 4000) || !text(value.scope, 1000)
        || !["observation", "inference", "unknown", "conflict", "decision", "commitment"].includes(String(value.category))
        || !["observed", "tentative", "unknown"].includes(String(value.certainty))
        || !strings(value.evidence, 32) || !value.evidence.length
        || !["carry", "retain"].includes(String(value.disposition)) || ["absorbs", "status", "replaces"].some(key => Object.hasOwn(value, key))) {
        reject("invalid_context_item", {
          missingFields: ["id", "category", "text", "scope", "certainty", "evidence", "disposition"].filter(key => value[key] === undefined),
          invalidFields: [
            ...(!text(value.id, 120) ? ["id"] : []), ...(!text(value.text, 4000) ? ["text"] : []), ...(!text(value.scope, 1000) ? ["scope"] : []),
            ...(!["observation", "inference", "unknown", "conflict", "decision", "commitment"].includes(String(value.category)) ? ["category"] : []),
            ...(!["observed", "tentative", "unknown"].includes(String(value.certainty)) ? ["certainty"] : []),
            ...(!strings(value.evidence, 32) || !value.evidence.length ? ["evidence"] : []),
            ...(!["carry", "retain"].includes(String(value.disposition)) ? ["disposition"] : []),
            ...["absorbs", "status", "replaces"].filter(key => Object.hasOwn(value, key)),
          ],
        }); continue;
      }
      // Only the current item and request-pinned revision can be updated.
      // Renaming/retirement uses explicit resolves, never a parallel input protocol.
      const previous = items.get(value.id);
      const presented = basis.contextItemRevisions?.[value.id];
      if (previous?.revision !== presented) {
        reject("presented_revision_required", previous ? { expectedRevision: previous.revision } : {}); continue;
      }
      const refs = [...new Set(value.evidence)];
      if (refs.some(id => {
        const source = byId.get(id);
        const identity = source?.checkpoint.basis?.identity;
        return !source || source.result.position >= checkpoint.position || source.checkpoint === checkpoint
          || (basis.contextEvidenceToolCallIds !== undefined && !basis.contextEvidenceToolCallIds.includes(id))
          || identity?.runId !== input.runId
          || identity.planId !== basis.identity.planId || identity.stepId !== basis.identity.stepId;
      })) { reject("uncommitted_or_out_of_scope_evidence"); continue; }
      // Resolution needs changed successful evidence; this validates provenance,
      // not the model's semantic conclusion. Canonical gaps are never touched.
      const version = record(value.version);
      if (value.version != null && (!version || !text(version.path, 1000) || !text(version.versionId, 128)
        || !basis.workProductVersions?.some(object => object.path === version.path
          && object.versionId === version.versionId && object.evidenceToolCallIds?.some(id => (value.evidence as string[]).includes(id))))) {
        reject("unobserved_current_version"); continue;
      }
      // Replacing an unresolved item cannot erase its evidence of a conflict,
      // unknown, or promise. A resolution must take responsibility for it.
      if (previous && previous.status === "active" && ["conflict", "unknown", "commitment"].includes(previous.category)
        && (value.category !== previous.category || previous.evidence.some(ref => !refs.includes(ref.toolCallId)))
        && !(Array.isArray(value.resolves) && value.resolves.includes(previous.id))) {
        reject("unresolved_item_requires_explicit_resolution"); continue;
      }
      const resolvedItems: DecisionContextItem[] = [];
      if (value.resolves !== undefined) {
        if (!strings(value.resolves, 20) || new Set(value.resolves).size !== value.resolves.length) { reject("invalid_item_resolution"); continue; }
        let invalidResolution: string | undefined;
        for (const id of value.resolves) {
          const target = items.get(id);
          if (!target || target.status !== "active"
            || basis.contextItemRevisions?.[id] !== target.revision
            || target.version && !basis.workProductVersions?.some(version => version.path === target.version!.path && version.versionId === target.version!.versionId)) {
            invalidResolution = "resolution_requires_presented_item"; break;
          }
          if (!value.evidence.some(id => {
            const result = byId.get(id)!.result;
            return !result.isError && result.executionOutcome?.operationStatus === "succeeded"
              && !target.evidence.some(ref => ref.toolCallId === id);
          })) { invalidResolution = "resolution_requires_new_successful_evidence"; break; }
          resolvedItems.push(target);
        }
        if (invalidResolution) { reject(invalidResolution); continue; }
      }
      const evidence = value.evidence.map(id => {
        const result = byId.get(id)!.result;
        const parsed = json(result.content);
        const ref = result.resultRef ?? parseRuntimeResultRef(parsed?.resultRef) ?? parseRuntimeResultRef(parsed?.sourceResultRef);
        return { toolCallId: id, ...(ref ? { result: ref } : {}) };
      });
      const item: DecisionContextItem = {
        id: value.id, revision: hash(JSON.stringify([checkpoint.toolCalls.map(call => call.id), index, raw])),
        ...(previous === undefined ? {} : { supersedes: { id: previous.id, revision: previous.revision } }),
        category: value.category as DecisionContextItem["category"], text: value.text, scope: value.scope,
        certainty: value.certainty as DecisionContextItem["certainty"], status: "active",
        authority: "model", evidence,
        source: { toolCallIds: checkpoint.toolCalls.map(call => call.id),
          ...(basis.identity.canonicalState === undefined ? {} : { canonicalState: basis.identity.canonicalState }) },
        ...(version ? { version: { path: version.path as string, versionId: version.versionId as string } } : {}),
      };
      items.set(item.id, item);
      // This records an explicit model resolution, not Runtime validation or
      // canonical gap closure. Every target was pinned to the request revision
      // and checked above; the complete update is applied atomically.
      for (const target of resolvedItems) {
        // A finding can explicitly resolve its previous unknown incarnation
        // under the same stable id. Keep the new current fact; its supersedes
        // link already identifies the retired item revision.
        if (target.id === item.id) continue;
        items.set(target.id, { ...target, status: "resolved",
          revision: hash(JSON.stringify(["resolve", target.revision, item.revision])),
          supersedes: { id: target.id, revision: target.revision },
          source: item.source,
          evidence: [...target.evidence, ...item.evidence.filter(ref => !target.evidence.some(previous => previous.toolCallId === ref.toolCallId))],
        });
        unresolvedRejections.delete(target.id);
      }
      acceptedUpdateCount++;
      unresolvedRejections.delete(item.id);
      if (value.disposition === "carry") for (const id of value.evidence) absorbed.add(id);
    }
  }
  const active = [...items.values()].filter(item => item.status === "active" && (!item.version || !input.currentView
    || input.currentView.workProducts.objects.some(object => object.path === item.version!.path && object.currentVersionId === item.version!.versionId && object.presence === "present")));
  const required = new Set(active.flatMap(item => item.evidence.map(ref => ref.toolCallId)));
  for (const frame of currentActionDecisions({ currentDecision, parallelDecisions })) {
    frame.evidence.forEach(ref => required.add(ref.toolCallId));
    required.add(frame.source.toolCallId);
  }
  for (const issue of input.currentView?.workProducts.issues ?? []) if (issue.applicability === "current") issue.evidenceToolCallIds.forEach(id => required.add(id));
  for (const diagnostic of input.currentView?.workProducts.diagnostics ?? []) if (diagnostic.applicability !== "historical") required.add(diagnostic.toolCallId);
  for (const binding of input.currentView?.contract.resultBindings ?? []) for (const [id, entry] of byId) {
    if (entry.result.resultRef?.resultId === binding.result.resultId) required.add(id);
  }
  const candidates = new Set(batches.filter(batch => batch.assistant.reasoningContent === undefined
    && inScope(batch.assistant.executionHistoryBasis?.identity)
    && batch.assistant.executionHistoryBasis?.identity.planId && batch.assistant.executionHistoryBasis.identity.stepId
    && batch.results.every(result => result.name !== "load_skill"
      && ["read", "write"].includes(batch.assistant.executionHistoryBasis!.toolEffects[result.name])
      && result.executionOutcome?.invocationStatus === "completed"
      && ["succeeded", "failed"].includes(result.executionOutcome.operationStatus ?? "")
      && (batch.assistant.executionHistoryBasis!.toolEffects[result.name] !== "write" || result.executionOutcome.operationStatus === "succeeded")
      && byId.has(result.toolCallId)))
    .flatMap(batch => batch.results.map(result => result.toolCallId)));
  // A current item's provenance must remain usable, not just a model's copy
  // of a value. Carry retires inactive detail; current dependencies keep exact
  // bounded content. Large dependencies retain their native read lifecycle.
  const carriedDetail = new Set([...absorbed].filter(id => !required.has(id)));
  const exact = input.materializeObservations ? deriveCurrentEvidence({ records, currentView: input.currentView, candidates, carried: carriedDetail, required,
    maxCharacters: input.evidenceBudgetCharacters, maxEntryCharacters: input.evidenceEntryCharacters }) : undefined;
  if (exact) for (const id of required) if (exact.nativeFallback.has(id)) absorbed.delete(id);
  const transferred = new Set([...absorbed, ...(exact?.materialized ?? [])]);
  const releasable = batches.filter(batch => batch.assistant.reasoningContent === undefined
    && inScope(batch.assistant.executionHistoryBasis?.identity)
    && batch.results.every(result => transferred.has(result.toolCallId)
      && result.name !== "load_skill"
      && ["read", "write"].includes(batch.assistant.executionHistoryBasis!.toolEffects[result.name])
      && result.executionOutcome?.invocationStatus === "completed"
      && ["succeeded", "failed"].includes(result.executionOutcome.operationStatus ?? "")
      // A failed write can have partial or unknown effects even after invocation completes.
      && (batch.assistant.executionHistoryBasis!.toolEffects[result.name] !== "write" || result.executionOutcome.operationStatus === "succeeded")));
  const anchor = records.observations.flatMap(result => {
    const ref = result.resultRef ?? parseRuntimeResultRef(json(result.content)?.resultRef);
    const identity = byId.get(result.toolCallId)?.checkpoint.basis?.identity;
    return ref && identity && inScope(identity) && identity.planId && identity.stepId
      ? [{ anchor: ref, runId: input.runId, planId: identity.planId, stepId: identity.stepId }] : [];
  })[0];
  const archived = new Set(releasable.flatMap(batch => batch.results.map(result => result.toolCallId)));
  const unsafeEffectToolCallIds = new Set(records.observations.filter(result => {
    const effect = byId.get(result.toolCallId)?.checkpoint.basis?.toolEffects[result.name];
    return effect === undefined || effect === "unknown" || result.executionOutcome?.operationStatus === "unknown"
      || result.executionOutcome?.invocationStatus === "failed"
      || effect === "write" && result.executionOutcome?.operationStatus !== "succeeded";
  }).map(result => result.toolCallId));
  const omitted = new Set(releasable.flatMap(batch => Array.from({ length: batch.end - batch.start }, (_, index) => batch.start + index)));
  const neededReferences = new Set([...required, ...(exact?.entries.map(entry => entry.toolCallId) ?? []),
    ...records.observations.filter(result => !transferred.has(result.toolCallId)).map(result => result.toolCallId)]);
  const evidenceReferences = records.observations.flatMap((result, index) => neededReferences.has(result.toolCallId)
    && inScope(byId.get(result.toolCallId)?.checkpoint.basis?.identity)
    && !byId.has(`@e${index + 1}`)
    ? [{ ref: `@e${index + 1}`, toolCallId: result.toolCallId,
      ...(result.resultRef ? { resultId: result.resultRef.resultId } : {}) }] : []);
  const scopedCheckpoints = records.checkpoints.filter(checkpoint => inScope(checkpoint.basis?.identity));
  const latest = scopedCheckpoints.at(-1);
  const latestCommittedAction = latest === undefined ? undefined : {
    checkpointOrdinal: scopedCheckpoints.length,
    toolCalls: latest.toolCalls.map(call => {
      const result = byId.get(call.id)?.result;
      return { toolCallId: call.id, toolName: call.name,
        ...(result?.resultRef ? { resultRef: result.resultRef } : {}),
        invocationStatus: result?.executionOutcome?.invocationStatus ?? "unknown",
        operationStatus: result?.executionOutcome?.operationStatus ?? "unknown",
        receipt: result ? "committed" as const : "missing" as const };
    }),
  };
  return {
    history: anchor,
    reconciledToolCallIds: absorbed,
    materializedToolCallIds: exact?.materialized ?? new Set<string>(),
    historicalToolCallIds: exact?.historical ?? new Set<string>(),
    unsafeEffectToolCallIds,
    items: active, allItems: [...items.values()], rejections, archived,
    messages: input.messages.filter((_, index) => !omitted.has(index)),
    view: {
      schema: "agentloop.decisionWorkingSet/v1" as const, items: active,
      historicalItemCount: acceptedUpdateCount - active.length, absorbedExchangeCount: releasable.length,
      retainedExchangeCount: batches.length - releasable.length, rejectionCount: rejections.length,
      ...(currentDecision ? { currentDecision } : {}),
      ...(parallelDecisions?.length ? { parallelDecisions } : {}),
      ...(exact ? { currentEvidence: exact.entries, historicalObservationCount: exact.historical.size,
        materializedObservationCount: exact.materialized.size,
        ...(latestCommittedAction ? { latestCommittedAction } : {}) } : {}),
      pendingToolCallIds: records.observations.filter(result => !transferred.has(result.toolCallId)).map(result => result.toolCallId),
      evidenceReferences,
      rejectedUpdates: [...unresolvedRejections.values()],
      gaps: unresolvedRejections.size ? ["Context proposals were not applied. Retained current items and original observations remain available. These metadata diagnostics are not canonical task gaps and require no extra turn or history read merely to clear them. Do not rely on rejected claims."] : [],
    } satisfies DecisionWorkingSet,
  };
}
export function currentActionDecisions(view?: Pick<DecisionWorkingSet, "currentDecision" | "parallelDecisions">): readonly NonNullable<DecisionWorkingSet["currentDecision"]>[] {
  return [...(view?.parallelDecisions ?? []), ...(view?.currentDecision ? [view.currentDecision] : [])];
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function json(value: string): Record<string, unknown> | undefined { try { return record(JSON.parse(value)); } catch { return undefined; } }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function strings(value: unknown, max: number): value is string[] { return Array.isArray(value) && value.length <= max && value.every(id => text(id, 200)); }
function observationRef(result: CommittedDecisionRecords["observations"][number]): RuntimeResultRef | undefined {
  return result.resultRef ?? parseRuntimeResultRef(json(result.content)?.resultRef);
}
function actionKey(name: string, args: unknown, basis: NonNullable<CommittedDecisionRecords["checkpoints"][number]["basis"]>): string {
  const { _agentloopContext: _, ...operation } = record(args) ?? {};
  const encoded = JSON.stringify([basis.identity.runId, basis.identity.planId, basis.identity.stepId, name,
    basis.toolEffects[name], record(args) ? operation : args,
    (basis.workProductVersions ?? []).map(({ path, versionId }) => ({ path, versionId })).sort((a, b) => a.path.localeCompare(b.path))], (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return createHash("sha256").update(encoded).digest("hex");
}

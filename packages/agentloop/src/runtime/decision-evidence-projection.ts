import type { AgentLoopToolEvidence } from "./contracts.ts";
import type { CurrentDecisionView } from "./current-decision-view.ts";
import { currentActionDecisions, type DecisionWorkingSet } from "./decision-working-set.ts";

/** Assessment selects actual committed evidence from semantic dependencies.
 * Native continuation and execution compaction are deliberately not inputs.
 * The server assessor/committer still receives the full authoritative ledger.
 */
export function projectDecisionEvidence(input: {
  readonly evidence: readonly AgentLoopToolEvidence[];
  readonly workingSet?: DecisionWorkingSet;
  readonly currentView?: CurrentDecisionView;
  readonly requiredToolCallIds?: readonly string[];
  readonly unsafeEffectToolCallIds?: ReadonlySet<string>;
  readonly reconciledToolCallIds: ReadonlySet<string>;
  readonly historicalToolCallIds?: ReadonlySet<string>;
}): readonly AgentLoopToolEvidence[] {
  // Releasing detail needs an authorized precise history entry. Legacy/opaque
  // hosts keep the original evidence rather than presenting false completeness.
  if (!input.workingSet?.history) return input.evidence;
  // Explicitly absorbed content is already carried in the current semantic
  // items. A provenance reference alone is not a request to duplicate its
  // whole source. An assessor can inspect the exact source through history.
  const required = new Set(input.requiredToolCallIds);
  for (const frame of currentActionDecisions(input.workingSet)) {
    for (const ref of frame.evidence) required.add(ref.toolCallId);
    required.add(frame.source.toolCallId);
  }
  const resultIds = new Set(input.currentView?.contract.resultBindings.map(binding => binding.result.resultId) ?? []);
  for (const object of input.currentView?.workProducts.objects ?? []) if (object.presence === "present" && object.role !== "unknown" && object.observedBy) required.add(object.observedBy);
  for (const target of input.currentView?.workProducts.deliveryTargets ?? []) required.add(target.observedByToolCallId);
  for (const issue of input.currentView?.workProducts.issues ?? []) if (issue.applicability === "current") issue.evidenceToolCallIds.forEach(id => required.add(id));
  for (const diagnostic of input.currentView?.workProducts.diagnostics ?? []) if (diagnostic.applicability !== "historical") required.add(diagnostic.toolCallId);
  for (const gap of input.currentView?.currentGap.assessmentGaps ?? []) {
    for (const ref of [...(gap.reusableEvidenceRefs ?? []), ...(gap.evidenceConcerns ?? []).flatMap(concern => [...concern.evidenceRefs, ...concern.affectedEvidenceRefs])]) {
      required.add(ref); resultIds.add(ref);
    }
  }
  return input.evidence.filter(item => !input.reconciledToolCallIds.has(item.toolCallId) && !input.historicalToolCallIds?.has(item.toolCallId)
    || required.has(item.toolCallId) || resultIds.has(item.resultRef?.resultId ?? "")
    || input.unsafeEffectToolCallIds?.has(item.toolCallId)
    // An interpretation cannot erase an uncertain external effect.
    || item.operationStatus === "unknown" || item.invocationStatus === "failed"
    || item.toolName === "load_skill");
}

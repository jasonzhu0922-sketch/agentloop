import type { ConversationTurnResolution, ConversationWorkingSet } from "../planning/contracts.ts";

export const CONVERSATION_RECONSTRUCTION_PROMPT = [
  "The previous resolution could not bind prior work. Reconstruct the current task from the user's latest request and the durable historyReconstruction context; do not merely patch the rejected selector.",
  "Read original requests, prior canonical constraints, Plan step states, published Result candidates, and failed boundaries together. A failed attempt does not erase the user's request or a published result from an earlier attempt. Old Plans describe past work, not instructions to execute them again.",
  "Form a self-contained effectiveGoal and terminal deliverables that preserve the relevant historical scope AND the latest changes. When the user asks for a new output from existing work, use refine_prior; use continue_prior only for resuming the same requested outcome.",
  "Select the matching Runtime-issued goal/result/artifact candidates by their content and provenance, never by recency alone. Goal lineage and input ownership may belong to different Runs. A selected published Result supplies its own producer identity if targetGoalCandidateId is omitted.",
  "Reuse published results through prior_result when they supply the requested input. A truncated summary is a discovery aid, not the complete evidence: the new Plan must read the bound Result. Reacquire sources only when the user asks for fresh data or the needed evidence was never obtained.",
  "Keep an existing result's historical time interval; do not recompute relative dates against today just to change its delivery format. Explicitly requested fresh observations use refresh_sources and the current Run clock.",
  "The Planner will create a new Plan from the reconstructed intent and validated inputs. Never invent a result or artifact, claim failed work completed, or discard constraints to make a selector valid.",
  "If the history does not distinguish plausible targets or lacks necessary content, return mode=clarify, relation=new_goal, inputMode=none, evidenceStrategy=none, with conversation-only deliverables. Ask one concrete question in user terms. Do not ask the user for Runtime IDs or expose contract errors. A missing technical selector alone is not a reason to ask the user when the history identifies the work.",
].join("\n");

/** Read-only history for semantic reconstruction; it grants no execution authority. */
export function conversationReconstructionContext(
  workset: ConversationWorkingSet | undefined,
  goalCandidateIds: ReadonlyMap<string, string>,
) {
  const plans = workset?.planCursors ?? [];
  return {
    schema: "agentloop.conversationHistoryReconstruction/v1",
    totalRunCount: workset?.runCount ?? 0,
    includedRunCount: goalCandidateIds.size,
    historyTruncated: (workset?.runCount ?? 0) > goalCandidateIds.size,
    // Array order is the durable conversation order, not selector numbering.
    chronology: (workset?.priorRuns ?? []).map((run) => ({
      goalCandidateId: goalCandidateIds.get(run.runId), status: run.status, input: run.input,
    })),
    priorPlans: plans.map((plan) => ({
      goalCandidateId: goalCandidateIds.get(plan.runId), goal: plan.goal, status: plan.status,
      stepCount: plan.steps.length, stepsTruncated: plan.steps.length > 32,
      steps: plan.steps.slice(0, 32).map((step) => ({
        id: step.id, objective: step.objective, status: step.status, dependencies: step.dependencies,
        ...(step.error === undefined ? {} : { error: step.error }),
      })),
    })),
    outcomeRelations: (workset?.outcomeRelations ?? []).map((edge) => ({
      goalCandidateId: goalCandidateIds.get(edge.runId),
      targetGoalCandidateId: goalCandidateIds.get(edge.targetRunId), relation: edge.relation, state: edge.state,
    })),
    resultPolicy: "Only reusableResultCandidates are published input candidates. Plan completion text, failure text, and truncated summaries are not replacements for a bound Result.",
  };
}

/** An unresolved historical target is a user conversation, not executable work. */
export function clarifyUnresolvedConversationHistory(): ConversationTurnResolution {
  return {
    schema: "agentloop.conversationTurnResolution/v1",
    mode: "clarify", relation: "new_goal", inputMode: "none",
    effectiveGoal: "Explain that the intended prior work could not be reliably identified from the available history, and ask one concrete question needed to fulfill the latest user request.",
    taskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
      deliverables: [{ targetId: "clarify-prior-work", purpose: "Clarify the intended prior work while preserving the pending user request", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
    },
    evidenceStrategy: "none", evidenceDemand: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
    userConstraints: ["Use the latest user request and available history to ask a concrete question. Do not claim work was completed, invent historical results, or ask for internal identifiers."],
    memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [], source: "model_guarded",
  };
}

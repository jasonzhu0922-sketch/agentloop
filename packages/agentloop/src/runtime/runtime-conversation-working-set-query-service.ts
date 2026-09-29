import { activeLeafSteps } from "../planning/plan-utils.ts";
import type {
  ConversationFailedBoundary,
  ConversationOutcomeRelation,
  ConversationResolvedIntent,
  ConversationReusableArtifact,
  ConversationSourceSummary,
  ConversationStepContext,
  ConversationTurnResolution,
  ConversationWorkingSet,
  ExecutionPlan,
} from "../planning/contracts.ts";
import { createRuntimeResultCard, type RuntimeResultCard, type RuntimeResultRecord } from "./runtime-result.ts";

const RUN_LIMIT = 8;
const ARTIFACT_LIMIT = 24;
const RESULT_LIMIT = 8;
const SOURCE_SUMMARY_LIMIT = 8;
const STEP_CONTEXT_LIMIT = 12;

export interface ConversationWorkingSetRun {
  readonly id: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly input: string;
  readonly ownerUserId: string;
  readonly conversationId?: string;
  readonly createdAt: number;
  readonly errorCode?: string;
}

export interface ConversationWorkingSetEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface ConversationWorkingSetOutcome {
  readonly status: string;
  readonly reasonCode: string;
  readonly planId?: string;
  readonly result?: RuntimeResultRecord;
}

/**
 * Rebuilds bounded conversation context solely from durable Run evidence.
 * It has no authority to start Runs, mutate Plans, assess Steps, or commit an Outcome.
 */
export class RuntimeConversationWorkingSetQueryService {
  private readonly input: {
    readonly runs: (conversationId: string) => Promise<readonly ConversationWorkingSetRun[]>;
    readonly events: (runId: string) => Promise<readonly ConversationWorkingSetEvent[]>;
    readonly outcome: (runId: string) => Promise<ConversationWorkingSetOutcome | undefined>;
    readonly plan: (runId: string) => Promise<ExecutionPlan | undefined>;
    readonly reusableArtifacts: (run: ConversationWorkingSetRun, events: readonly ConversationWorkingSetEvent[], plan: ExecutionPlan | undefined) => Promise<readonly ConversationReusableArtifact[]>;
    readonly turnResolution: (events: readonly ConversationWorkingSetEvent[]) => ConversationTurnResolution | undefined;
    readonly failedBoundary: (run: ConversationWorkingSetRun, outcome: ConversationWorkingSetOutcome | undefined, events: readonly ConversationWorkingSetEvent[]) => ConversationFailedBoundary | undefined;
    readonly sourceSummary: (runId: string, planId: string, step: ExecutionPlan["steps"][number]) => ConversationSourceSummary | undefined;
    readonly stepContext: (runId: string, planId: string, step: ExecutionPlan["steps"][number]) => ConversationStepContext | undefined;
    readonly resumeSuggestion: (activeGoal: ConversationWorkingSet["activeGoal"] | undefined, planCursors: ConversationWorkingSet["planCursors"], artifacts: readonly ConversationReusableArtifact[], failures: readonly ConversationFailedBoundary[]) => string | undefined;
  };

  constructor(input: RuntimeConversationWorkingSetQueryService["input"]) {
    this.input = input;
  }

  async build(conversationId: string): Promise<ConversationWorkingSet | undefined> {
    const allRuns = await this.input.runs(conversationId);
    if (allRuns.length === 0) return undefined;
    const planCursors: Array<ConversationWorkingSet["planCursors"][number]> = [];
    const reusableArtifacts: ConversationReusableArtifact[] = [];
    const resultCards: RuntimeResultCard[] = [];
    const completedStepContexts: ConversationStepContext[] = [];
    const failedBoundaries: ConversationFailedBoundary[] = [];
    const requiredSkillIds = new Set<string>();
    const recommendedCapabilityIds = new Set<string>();
    const sourceSummaries: ConversationSourceSummary[] = [];
    const outcomeRelations: ConversationOutcomeRelation[] = [];
    const resolvedIntents: ConversationResolvedIntent[] = [];
    let activeGoal: ConversationWorkingSet["activeGoal"] | undefined;

    for (const run of allRuns.slice(-RUN_LIMIT)) {
      const events = await this.input.events(run.id);
      const resolution = this.input.turnResolution(events);
      if (resolution !== undefined) resolvedIntents.push({ runId: run.id, resolution });
      for (const event of events) {
        if (event.type !== "conversation.outcome.disputed" && event.type !== "conversation.outcome.superseded") continue;
        const targetRunId = stringField(event.data, "targetRunId");
        const relation = stringField(event.data, "relation");
        if (targetRunId !== undefined && (relation === "correct_prior" || relation === "refine_prior" || relation === "challenge_prior")) {
          outcomeRelations.push({ runId: run.id, targetRunId, relation, state: event.type === "conversation.outcome.superseded" ? "superseded" : "disputed" });
        }
      }
      const outcome = await this.input.outcome(run.id);
      const failure = this.input.failedBoundary(run, outcome, events);
      if (failure !== undefined) failedBoundaries.push(failure);
      const plan = await this.input.plan(run.id);
      if (plan !== undefined) {
        for (const step of plan.steps) {
          const sourceSummary = this.input.sourceSummary(run.id, plan.id, step);
          if (sourceSummary !== undefined) sourceSummaries.push(sourceSummary);
          const stepContext = this.input.stepContext(run.id, plan.id, step);
          if (stepContext !== undefined) completedStepContexts.push(stepContext);
        }
        const cursor: ConversationWorkingSet["planCursors"][number] = {
          runId: run.id, planId: plan.id, input: run.input, goal: plan.goal, status: plan.status, selectedSkillIds: plan.selectedSkillIds,
          steps: plan.steps.filter((step) => step.retiredAt === undefined).map((step) => ({
            id: step.id, kind: step.kind, position: step.position, status: step.status, objective: step.objective,
            dependencies: step.dependencies, skillIds: step.skillIds, requiredCapabilities: step.requiredCapabilities,
            executionBinding: step.executionBinding, ...(step.error === undefined ? {} : { error: truncate(step.error, 600) }),
          })),
        };
        planCursors.push(cursor);
        const unfinishedSteps = activeLeafSteps(plan).filter((step) => step.status !== "completed");
        if (unfinishedSteps.length > 0 || run.status !== "completed") {
          activeGoal = { runId: run.id, planId: plan.id, goal: plan.goal, status: plan.status, unfinished: true,
            ...(outcome?.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }) };
          for (const step of unfinishedSteps) {
            for (const skillId of step.skillIds) requiredSkillIds.add(skillId);
            for (const capability of step.requiredCapabilities) recommendedCapabilityIds.add(capability);
          }
        }
      } else if (run.status !== "completed") {
        activeGoal = { runId: run.id, goal: run.input, status: run.status, unfinished: true,
          ...(outcome?.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }) };
      }

      const artifacts = await this.input.reusableArtifacts(run, events, plan);
      reusableArtifacts.push(...artifacts);
      const publishedRunResult = outcome?.status === "completed" ? outcome.result : undefined;
      if (publishedRunResult === undefined && plan !== undefined) {
        for (const step of plan.steps) {
          const result = step.status === "completed" ? step.evidence?.publishedResult : undefined;
          if (result === undefined) continue;
          const content = result.payload.content;
          const summary = truncate(content, 1_200);
          resultCards.push(createRuntimeResultCard({
            result, goal: truncate(step.objective, 600), summary,
            summaryTruncated: summary.length < content.replace(/\s+/g, " ").trim().length,
            artifactPaths: artifacts.filter((artifact) => artifact.sourcePlanStepId === step.id).map((artifact) => artifact.path),
            evidenceRefs: [`run:${run.id}`, `plan:${plan.id}`, `step:${step.id}`,
              ...(result.publication.assessmentRef === undefined ? [] : [`assessment:${result.publication.assessmentRef}`])],
          }));
        }
      }
      if (publishedRunResult !== undefined) {
        const content = publishedRunResult.payload.content;
        const summary = truncate(content, 1_200);
        resultCards.push(createRuntimeResultCard({
          result: publishedRunResult, goal: truncate(plan?.goal ?? run.input, 600), summary,
          summaryTruncated: summary.length < content.replace(/\s+/g, " ").trim().length,
          artifactPaths: artifacts.map((artifact) => artifact.path),
          evidenceRefs: [`run:${run.id}`, ...(publishedRunResult.producer.planId === undefined ? [] : [`plan:${publishedRunResult.producer.planId}`])],
        }));
      }
    }

    const boundedArtifacts = reusableArtifacts.slice(-ARTIFACT_LIMIT);
    const boundedResultCards = resultCards.slice(-RESULT_LIMIT);
    const boundedSourceSummaries = sourceSummaries.slice(-SOURCE_SUMMARY_LIMIT);
    const boundedStepContexts = completedStepContexts.slice(-STEP_CONTEXT_LIMIT);
    for (const stepContext of boundedStepContexts) {
      for (const skillId of stepContext.skillIds) requiredSkillIds.add(skillId);
      for (const capability of stepContext.requiredCapabilities) recommendedCapabilityIds.add(capability);
    }
    for (const artifact of boundedArtifacts) {
      for (const skillId of artifact.sourceSkillIds ?? []) requiredSkillIds.add(skillId);
      for (const capability of artifact.sourceCapabilities ?? []) recommendedCapabilityIds.add(capability);
    }
    const resumeSuggestion = this.input.resumeSuggestion(activeGoal, planCursors, boundedArtifacts, failedBoundaries);
    return {
      schema: "conversation.workset/v1", conversationId, runCount: allRuns.length,
      ...(activeGoal === undefined ? {} : { activeGoal }), planCursors,
      ...(resolvedIntents.length === 0 ? {} : { resolvedIntents }), resultCards: boundedResultCards,
      reusableArtifacts: boundedArtifacts, failedBoundaries,
      ...(outcomeRelations.length === 0 ? {} : { outcomeRelations }),
      recommendedCapabilities: { skillIds: [...requiredSkillIds], capabilityIds: [...recommendedCapabilityIds] },
      ...(boundedSourceSummaries.length === 0 ? {} : { evidenceLedger: { schema: "conversation.evidenceLedger/v1", sourceSummaries: boundedSourceSummaries } }),
      ...(boundedStepContexts.length === 0 ? {} : { completedStepContexts: boundedStepContexts }),
      ...(resumeSuggestion === undefined ? {} : { resumeSuggestion }),
    };
  }
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function truncate(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}...`;
}

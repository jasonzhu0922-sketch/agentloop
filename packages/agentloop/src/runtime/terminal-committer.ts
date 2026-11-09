import { roundEvidenceFingerprints } from "./round-evidence.ts";
import { RunInputRepository } from "./run-input-repository.ts";
import { AppError } from "../shared/errors.ts";
import type { PlanRepository } from "../planning/plan-repository.ts";
import { activeLeafSteps } from "../planning/plan-utils.ts";
import { RunOutcomeRepository } from "../storage/repositories/outcome-repository.ts";
import type { HumanLoopRepository } from "./human-loop.ts";
import { createRuntimeResult, type RuntimeResultRecord } from "./runtime-result.ts";
import { isCaveatedStepResult } from "./step-result-committer.ts";
import { commitCanonicalTerminal, markCanonicalReadyForTerminal } from "./canonical-run-state.ts";
import type { CanonicalRunStateRepository } from "./canonical-run-state-repository.ts";
import type { SqlConnection } from "../storage/connection.ts";
import { RunRoundRepository } from "./run-round-repository.ts";
import { PlanningRecoveryRepository } from "./planning-recovery-repository.ts";
import { PlanningBudgetRepository } from "./planning-budget-repository.ts";
import { decideRoundProgress } from "./round-progress.ts";
import type { CanonicalRunState } from "./canonical-run-state.ts";

export class TerminalCommitter {
  private readonly plans: PlanRepository;
  private readonly outcomes: RunOutcomeRepository;
  private readonly humanLoops?: HumanLoopRepository;
  private readonly canonicalStates: CanonicalRunStateRepository;
  private readonly connection: SqlConnection;
  private readonly maxRounds: number;

  constructor(
    plans: PlanRepository,
    outcomes: RunOutcomeRepository,
    humanLoops: HumanLoopRepository | undefined,
    canonicalStates: CanonicalRunStateRepository,
    connection: SqlConnection,
    maxRounds = 8,
  ) {
    this.plans = plans;
    this.outcomes = outcomes;
    this.humanLoops = humanLoops;
    this.canonicalStates = canonicalStates;
    this.connection = connection;
    this.maxRounds = maxRounds;
  }

  async commitCompleted(runId: string, planId: string, output: string): Promise<void> {
    await this.assertNoOpenHumanLoop(runId);
    const plan = await this.plans.get(planId);
    const leafSteps = activeLeafSteps(plan);
    if (plan.runId !== runId || leafSteps.some((step) => step.status !== "completed")) {
      throw new AppError("ASSESSMENT_ERROR", "Terminal commit requires every executable Plan leaf step to be completed", 409);
    }
    const assessments = await this.plans.assessments(planId);
    for (const step of leafSteps) {
      const latest = assessments.filter((item) => item.stepId === step.id).at(-1);
      if (latest?.approved !== true) {
        throw new AppError(
          "ASSESSMENT_ERROR",
          `Terminal commit requires an approved assessment for step ${step.id}`,
          409,
        );
      }
    }
    const result = runResult(plan, output, await new RunRoundRepository(this.connection).priorResultRefs(runId, planId));
    await this.connection.transaction(async () => {
      await new RunInputRepository(this.connection).assertDrained(runId);
      const state = await this.commitRoundResult(plan, assessments, output, "plan_assessed_and_completed");
      await this.commitCanonicalCompletion(state, "plan_assessed_and_completed");
      await this.outcomes.commitCompleted({ runId, planId, result });
      await new RunRoundRepository(this.connection).finish(runId, "completed", Date.now());
    });
  }

  async commitCompletedWithDeferredValidation(runId: string, planId: string, output: string): Promise<void> {
    await this.commitCompletedWithCaveats(runId, planId, output, "completed_with_deferred_validation");
  }

  /** Persists a fully assessed Round without closing the Run. */
  async commitRound(
    runId: string,
    planId: string,
    output: string,
    progress: Extract<ReturnType<typeof decideRoundProgress>, { kind: "next_round" }>,
    nextCanonicalState: CanonicalRunState,
    nextPlanningContext: unknown,
    reasonCode = "round_assessed_and_completed",
  ): Promise<number> {
    await this.assertNoOpenHumanLoop(runId);
    const plan = await this.plans.get(planId);
    const leafSteps = activeLeafSteps(plan);
    if (plan.runId !== runId || leafSteps.some((step) => step.status !== "completed")) {
      throw new AppError("ASSESSMENT_ERROR", "Round commit requires every executable Plan leaf step to be completed", 409);
    }
    const assessments = await this.plans.assessments(planId);
    for (const step of leafSteps) {
      const latest = assessments.filter((item) => item.stepId === step.id).at(-1);
      if (latest?.approved !== true && !isCaveatedStepResult(latest, step.evidence ?? {})) {
        throw new AppError("ASSESSMENT_ERROR", `Round commit requires an approved or caveated assessment for step ${step.id}`, 409);
      }
    }
    const state = await this.canonicalStates.get(runId);
    if (decideRoundProgress(plan, state).kind !== "next_round") throw new AppError("ASSESSMENT_ERROR", "Round is not ready for a next Round", 409);
    const rounds = new RunRoundRepository(this.connection);
    const roundNumber = await rounds.roundForPlan(runId, planId);
    const progressKey = JSON.stringify({
      openGapIds: [...progress.openGapIds].sort(),
      openTargetIds: [...progress.openTargetIds].sort(),
      evidenceFingerprints: roundEvidenceFingerprints(plan),
    });
    await rounds.assertNextAllowed({ runId, roundNumber, maxRounds: this.maxRounds, progressKey });
    if (nextCanonicalState.runId !== runId || nextCanonicalState.revision !== state.revision + 1
      || nextCanonicalState.terminal !== undefined || nextCanonicalState.plan !== undefined) {
      throw new AppError("CONFLICT", "Next Round Canonical State is invalid", 409);
    }
    await this.connection.transaction(async () => {
      await new RunInputRepository(this.connection).assertDrained(runId);
      await this.commitRoundResult(plan, assessments, output, reasonCode, progress);
      // Round result is the boundary; the global Goal remains mutable and the
      // Run stays running for a future Round.
      if (state.terminal !== undefined) throw new AppError("CONFLICT", "Cannot commit a Round after Run termination", 409);
      await this.canonicalStates.commit({ expectedRevision: state.revision, state: nextCanonicalState, reason: "round_completed_next_pending" });
      await rounds.createNext(runId, roundNumber, Date.now());
      await new PlanningBudgetRepository(this.connection).grantNextRound(runId, Date.now());
      await new PlanningRecoveryRepository(this.connection).prepareNextRound(runId, nextPlanningContext, Date.now());
    });
    return roundNumber + 1;
  }

  async commitCompletedWithCaveats(runId: string, planId: string, output: string, reasonCode: string): Promise<void> {
    await this.assertNoOpenHumanLoop(runId);
    const plan = await this.plans.get(planId);
    const leafSteps = activeLeafSteps(plan);
    if (plan.runId !== runId || leafSteps.some((step) => step.status !== "completed")) {
      throw new AppError("ASSESSMENT_ERROR", "Caveated completion commit requires every executable Plan leaf step to be completed", 409);
    }
    let hasCaveat = false;
    const assessments = await this.plans.assessments(planId);
    for (const step of leafSteps) {
      const latest = assessments.filter((item) => item.stepId === step.id).at(-1);
      if (latest?.approved === true) {
        // An approved assessment may still carry non-blocking uncertainty.
        // Treat that uncertainty as a caveat and deliver it, rather than
        // reinterpreting "approved" as "nothing is unknown" and rejecting
        // the terminal commit.
        if (isCaveatedStepResult(latest, step.evidence ?? {})) {
          hasCaveat = true;
        }
        continue;
      }
      if (isCaveatedStepResult(latest, step.evidence ?? {})) {
        hasCaveat = true;
        continue;
      }
      throw new AppError(
        "ASSESSMENT_ERROR",
        `Caveated completion commit requires an approved or caveated assessment for step ${step.id}`,
        409,
      );
    }
    if (!hasCaveat) {
      throw new AppError("ASSESSMENT_ERROR", "Caveated completion commit requires at least one caveated assessment", 409);
    }
    const result = runResult(plan, output, await new RunRoundRepository(this.connection).priorResultRefs(runId, planId));
    await this.connection.transaction(async () => {
      await new RunInputRepository(this.connection).assertDrained(runId);
      const state = await this.commitRoundResult(plan, assessments, output, reasonCode);
      await this.commitCanonicalCompletion(state, reasonCode);
      await this.outcomes.commitCompletedWithCaveats({ runId, planId, result, reasonCode });
      await new RunRoundRepository(this.connection).finish(runId, "completed", Date.now());
    });
  }

  async commitStopped(input: {
    runId: string;
    planId?: string;
    status: "failed" | "cancelled";
    reasonCode: string;
    /** User-facing partial report; never an accepted completion or receipt. */
    output?: string;
  }): Promise<void> {
    await this.connection.transaction(async () => {
      await new RunInputRepository(this.connection).stop(input.runId, input.reasonCode);
      const state = await this.canonicalStates.getOptional(input.runId);
      if (state !== undefined && state.terminal === undefined) {
        const terminal = commitCanonicalTerminal(state, { status: input.status, reasonCode: input.reasonCode });
        await this.canonicalStates.commit({
          expectedRevision: state.revision,
          state: terminal,
          reason: `terminal_${input.status}`,
        });
      }
      await this.outcomes.commitStopped(input);
      await new RunRoundRepository(this.connection).finish(input.runId, input.status, Date.now());
      await new PlanningRecoveryRepository(this.connection).finish(input.runId, "cancelled", Date.now());
    });
  }

  private async commitCanonicalCompletion(state: Awaited<ReturnType<CanonicalRunStateRepository["get"]>>, reasonCode: string): Promise<void> {
    const ready = markCanonicalReadyForTerminal(state);
    const persistedReady = await this.canonicalStates.commit({
      expectedRevision: state.revision,
      state: ready,
      reason: "terminal_ready",
    });
    const completed = commitCanonicalTerminal(persistedReady, { status: "completed", reasonCode });
    await this.canonicalStates.commit({
      expectedRevision: persistedReady.revision,
      state: completed,
      reason: "terminal_completed",
    });
  }

  private async commitRoundResult(
    plan: Awaited<ReturnType<PlanRepository["get"]>>,
    assessments: Awaited<ReturnType<PlanRepository["assessments"]>>,
    output: string,
    reasonCode: string,
    expectedDecision: Extract<ReturnType<typeof decideRoundProgress>, { kind: "complete_goal" | "next_round" }> = { kind: "complete_goal" },
  ): Promise<Awaited<ReturnType<CanonicalRunStateRepository["get"]>>> {
    const state = await this.canonicalStates.get(plan.runId);
    const progress = decideRoundProgress(plan, state);
    if (progress.kind !== expectedDecision.kind) {
      throw new AppError("ASSESSMENT_ERROR", `Round progress changed from ${expectedDecision.kind} to ${progress.kind}`, 409, { progress });
    }
    const steps = activeLeafSteps(plan).map((step) => {
      const result = step.evidence?.publishedResult;
      const assessment = assessments.find((item) => item.stepId === step.id && item.id === result?.publication.assessmentRef);
      if (assessment === undefined || result === undefined) throw new AppError("ASSESSMENT_ERROR", `Round Result requires assessed Step result ${step.id}`, 409);
      return { stepId: step.id, result: result.ref, assessmentId: assessment.id };
    });
    const roundNumber = await new RunRoundRepository(this.connection).roundForPlan(plan.runId, plan.id);
    await new RunRoundRepository(this.connection).commitResult({
      schema: "agentloop.roundResult/v1", runId: plan.runId, roundNumber,
      planId: plan.id, planVersion: plan.version, canonicalRevision: state.revision,
      ...(plan.roundScope === undefined ? {} : { roundScope: plan.roundScope }),
      output, reasonCode, steps, evidenceFingerprints: roundEvidenceFingerprints(plan), decision: { ...progress, canonicalRevision: state.revision },
    }, Date.now());
    return state;
  }

  private async assertNoOpenHumanLoop(runId: string): Promise<void> {
    if (await this.humanLoops?.hasOpen(runId)) {
      throw new AppError("CONFLICT", "HUMAN_LOOP_UNRESOLVED", 409);
    }
  }
}

function runResult(plan: Awaited<ReturnType<PlanRepository["get"]>>, output: string, priorInputs: readonly import("./runtime-result.ts").RuntimeResultRef[] = []): RuntimeResultRecord {
  const leaves = activeLeafSteps(plan);
  const inputs = leaves.map((step) => {
    const result = step.evidence?.publishedResult;
    if (result === undefined) {
      throw new AppError("ASSESSMENT_ERROR", `Terminal commit requires a published result for step ${step.id}`, 409);
    }
    return result.ref;
  });
  return createRuntimeResult({
    kind: "run",
    producer: { runId: plan.runId, planId: plan.id },
    value: output,
    inputs: [...priorInputs, ...inputs],
    publication: { status: "published" },
  });
}

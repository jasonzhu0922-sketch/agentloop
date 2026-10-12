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

export class TerminalCommitter {
  private readonly plans: PlanRepository;
  private readonly outcomes: RunOutcomeRepository;
  private readonly humanLoops?: HumanLoopRepository;
  private readonly canonicalStates: CanonicalRunStateRepository;
  private readonly connection: SqlConnection;

  constructor(
    plans: PlanRepository,
    outcomes: RunOutcomeRepository,
    humanLoops: HumanLoopRepository | undefined,
    canonicalStates: CanonicalRunStateRepository,
    connection: SqlConnection,
  ) {
    this.plans = plans;
    this.outcomes = outcomes;
    this.humanLoops = humanLoops;
    this.canonicalStates = canonicalStates;
    this.connection = connection;
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
    const result = runResult(plan, output);
    await this.connection.transaction(async () => {
      await this.commitCanonicalCompletion(runId, "plan_assessed_and_completed");
      await this.outcomes.commitCompleted({ runId, planId, result });
    });
  }

  async commitCompletedWithDeferredValidation(runId: string, planId: string, output: string): Promise<void> {
    await this.commitCompletedWithCaveats(runId, planId, output, "completed_with_deferred_validation");
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
    const result = runResult(plan, output);
    await this.connection.transaction(async () => {
      await this.commitCanonicalCompletion(runId, reasonCode);
      await this.outcomes.commitCompletedWithCaveats({ runId, planId, result, reasonCode });
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
    });
  }

  private async commitCanonicalCompletion(runId: string, reasonCode: string): Promise<void> {
    const state = await this.canonicalStates.get(runId);
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

  private async assertNoOpenHumanLoop(runId: string): Promise<void> {
    if (await this.humanLoops?.hasOpen(runId)) {
      throw new AppError("CONFLICT", "HUMAN_LOOP_UNRESOLVED", 409);
    }
  }
}

function runResult(plan: Awaited<ReturnType<PlanRepository["get"]>>, output: string): RuntimeResultRecord {
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
    inputs,
    publication: { status: "published" },
  });
}

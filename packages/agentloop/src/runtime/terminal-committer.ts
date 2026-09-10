import { AppError } from "../shared/errors.ts";
import type { PlanRepository } from "../planning/plan-repository.ts";
import type { PlanStep, SkillComplianceAssessment } from "../planning/contracts.ts";
import { activeLeafSteps } from "../planning/plan-utils.ts";
import { RunOutcomeRepository } from "../storage/repositories/outcome-repository.ts";
import type { HumanLoopRepository } from "./human-loop.ts";

export class TerminalCommitter {
  private readonly plans: PlanRepository;
  private readonly outcomes: RunOutcomeRepository;
  private readonly humanLoops?: HumanLoopRepository;

  constructor(plans: PlanRepository, outcomes: RunOutcomeRepository, humanLoops?: HumanLoopRepository) {
    this.plans = plans;
    this.outcomes = outcomes;
    this.humanLoops = humanLoops;
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
    await this.outcomes.commitCompleted({ runId, planId, output });
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
        if (latest.skills.some((skill) => skill.status === "process_caveat" || skill.status === "skipped_unavailable")) {
          hasCaveat = true;
        }
        continue;
      }
      if (isCaveatedAssessment(latest, step)) {
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
    await this.outcomes.commitCompletedWithCaveats({ runId, planId, output, reasonCode });
  }

  async commitStopped(input: {
    runId: string;
    planId?: string;
    status: "failed" | "cancelled";
    reasonCode: string;
  }): Promise<void> {
    await this.outcomes.commitStopped(input);
  }

  private async assertNoOpenHumanLoop(runId: string): Promise<void> {
    if (await this.humanLoops?.hasOpen(runId)) {
      throw new AppError("CONFLICT", "HUMAN_LOOP_UNRESOLVED", 409);
    }
  }
}

function isCaveatedAssessment(
  assessment: SkillComplianceAssessment | undefined,
  step: PlanStep,
): boolean {
  if (assessment?.skills.some((skill) => skill.status === "skipped_unavailable" || skill.status === "process_caveat") === true) {
    return true;
  }
  return step.evidence?.completionCaveat?.reason === "repair_limit"
    || step.evidence?.completionCaveat?.reason === "evidence_boundary";
}

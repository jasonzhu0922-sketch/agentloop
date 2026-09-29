import type { ExecutionPlan, SkillComplianceAssessment } from "../planning/contracts.ts";
import { PlanRepository } from "../planning/plan-repository.ts";
import { AppError } from "../shared/errors.ts";

export interface RuntimePlanQueryRun {
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export interface RuntimePlanProjection {
  readonly state: "pending" | "available" | "unavailable";
  readonly plan: ExecutionPlan;
  readonly assessments: readonly SkillComplianceAssessment[];
}

export interface RuntimeHostPlanProjection {
  readonly state: RuntimePlanProjection["state"];
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly goal: string;
  readonly selectedSkillIds: readonly string[];
  readonly steps: readonly {
    readonly id: string;
    readonly status: string;
    readonly objective: string;
    readonly dependencies: readonly string[];
    readonly skillIds: readonly string[];
    readonly requiredCapabilities: readonly string[];
    readonly executionBinding: ExecutionPlan["steps"][number]["executionBinding"];
    readonly output?: string;
    readonly error?: string;
  }[];
  readonly assessmentCount: number;
  readonly approvedAssessmentCount: number;
}

/** Read-only Plan and Host projection; all Plan mutation remains in Runtime orchestration. */
export class RuntimePlanQueryService {
  private readonly plans: PlanRepository;
  private readonly run: (actorUserId: string, runId: string) => Promise<RuntimePlanQueryRun>;

  constructor(input: { readonly plans: PlanRepository; readonly run: (actorUserId: string, runId: string) => Promise<RuntimePlanQueryRun> }) {
    this.plans = input.plans;
    this.run = input.run;
  }

  async read(actorUserId: string, runId: string): Promise<RuntimePlanProjection> {
    const run = await this.run(actorUserId, runId);
    try {
      const plan = await this.plans.getByRun(runId);
      return { state: "available", plan, assessments: await this.plans.assessments(plan.id) };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
      const now = Date.now();
      return {
        state: run.status === "running" ? "pending" : "unavailable",
        plan: {
          id: "", runId, version: 0,
          goal: run.status === "running" ? "Plan is not available yet." : "No Plan was persisted for this Run.",
          selectedSkillIds: [], status: run.status === "running" ? "pending" : "failed", steps: [],
          createdAt: run.createdAt, updatedAt: run.finishedAt ?? now,
        },
        assessments: [],
      };
    }
  }

  async hostProjection(actorUserId: string, runId: string): Promise<RuntimeHostPlanProjection> {
    const detail = await this.read(actorUserId, runId);
    return {
      state: detail.state, id: detail.plan.id, version: detail.plan.version, status: detail.plan.status,
      goal: detail.plan.goal, selectedSkillIds: detail.plan.selectedSkillIds,
      steps: detail.plan.steps.filter((step) => step.retiredAt === undefined).map((step) => ({
        id: step.id, status: step.status, objective: step.objective, dependencies: step.dependencies,
        skillIds: step.skillIds, requiredCapabilities: step.requiredCapabilities, executionBinding: step.executionBinding,
        ...(step.output === undefined ? {} : { output: truncate(step.output, 1_200) }),
        ...(step.error === undefined ? {} : { error: truncate(step.error, 600) }),
      })),
      assessmentCount: detail.assessments.length,
      approvedAssessmentCount: detail.assessments.filter((assessment) => assessment.approved).length,
    };
  }
}

function truncate(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}...`;
}

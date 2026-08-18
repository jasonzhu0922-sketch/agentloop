import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { AgentDefinition, AgentService } from "../agents/agent-service.ts";
import { ComputerExecutor } from "../computer/computer-executor.ts";
import type { ComputerDriver } from "../computer/computer-driver.ts";
import { createComputerTools, DANGEROUS_COMPUTER_TOOL_NAMES } from "../computer/computer-tools.ts";
import { admitPlan } from "../planning/admission.ts";
import { ModelStepAssessor } from "../planning/assessor.ts";
import type {
  ExecutionPlan,
  Planner,
  PlanRevisionAssessor,
  SkillComplianceAssessment,
  StepAssessor,
  StepEvidence,
} from "../planning/contracts.ts";
import { ModelPlanner } from "../planning/planner.ts";
import { PlanRepository } from "../planning/plan-repository.ts";
import { DependencyScheduler } from "../planning/scheduler.ts";
import { formatAvailableSkills, formatLoadedSkill } from "../skills/skill-context.ts";
import type { PrivateSkill, SkillService } from "../skills/skill-service.ts";
import type { AppDatabase } from "../storage/database.ts";
import { AppError, forbidden, notFound } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { createCapabilityGrant } from "./capability-grant.ts";
import type {
  CapabilityGrant,
  AgentLoopToolEvidence,
  ModelAdapter,
  ModelInvocation,
  ModelMessage,
  ModelResponse,
  ModelStreamSink,
  RuntimeContextSnapshot,
  RuntimeEvent,
} from "./contracts.ts";
import { TerminalCommitter } from "./terminal-committer.ts";
import { RuntimeActionRepository, type RuntimeActionRecord } from "./runtime-action-repository.ts";
import {
  ModelPlanRevisionAssessor,
  ModelRecoveryPlanner,
  type RecoveryPlanner,
} from "./recovery-planning.ts";
import {
  RecoveryRepository,
  type PlanRevisionAssessmentRecord,
  type RecoveryDecisionRecord,
  type RecoveryUserResponse,
  type RunRecoveryState,
} from "./recovery-repository.ts";
import { reconstructRecoveryTranscript } from "./recovery-transcript.ts";
import { RunEventHub, type LiveRunEvent } from "./run-event-hub.ts";
import { ToolRegistry } from "./tool-registry.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export type ModelFactory = (agent: AgentDefinition) => ModelAdapter;
export type PlannerFactory = (agent: AgentDefinition, model: ModelAdapter) => Planner;
export type AssessorFactory = (agent: AgentDefinition, model: ModelAdapter) => StepAssessor;
export type RecoveryPlannerFactory = (agent: AgentDefinition, model: ModelAdapter) => RecoveryPlanner;
export type PlanRevisionAssessorFactory = (agent: AgentDefinition, model: ModelAdapter) => PlanRevisionAssessor;

export interface RunRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly allowDangerousTools: boolean;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly input: string;
  readonly output?: string;
  readonly errorCode?: string;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export interface StoredRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface RecoveryDetail {
  readonly state?: RunRecoveryState;
  readonly action?: RuntimeActionRecord;
  readonly decisions: readonly RecoveryDecisionRecord[];
  readonly planRevisionAssessments: readonly PlanRevisionAssessmentRecord[];
  readonly userResponses: readonly RecoveryUserResponse[];
}

interface RunRow {
  id: string;
  owner_user_id: string;
  agent_id: string;
  parent_run_id: string | null;
  depth: number;
  allow_dangerous_tools: number;
  status: RunRecord["status"];
  input: string;
  output: string | null;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
}

interface RunEventRow {
  seq: number;
  type: string;
  payload_json: string;
  created_at: number;
}

interface ExecutionLineage {
  readonly parentRunId?: string;
  readonly depth: number;
  readonly depthCeiling: number;
  readonly toolCeiling?: ReadonlySet<string>;
  readonly skillCeiling?: ReadonlySet<string>;
  readonly childAgentCeiling?: ReadonlySet<string>;
}

interface ExecuteOptions {
  readonly allowDangerousTools: boolean;
}

export class RunService {
  private readonly database: AppDatabase;
  private readonly skills: SkillService;
  private readonly agents: AgentService;
  private readonly modelFactory: ModelFactory;
  private readonly plannerFactory: PlannerFactory;
  private readonly assessorFactory: AssessorFactory;
  private readonly recoveryPlannerFactory: RecoveryPlannerFactory;
  private readonly planRevisionAssessorFactory: PlanRevisionAssessorFactory;
  private readonly globalMaxDepth: number;
  private readonly maxChildrenPerRun: number;
  private readonly workspaceRoot: string;
  private readonly computerTools: readonly RuntimeTool<unknown>[];
  private readonly pluginTools: readonly RuntimeTool<unknown>[];
  private readonly plans: PlanRepository;
  private readonly scheduler = new DependencyScheduler();
  private readonly terminal: TerminalCommitter;
  private readonly actions: RuntimeActionRepository;
  private readonly recovery: RecoveryRepository;
  private readonly eventHub = new RunEventHub();

  constructor(options: {
    database: AppDatabase;
    skills: SkillService;
    agents: AgentService;
    modelFactory: ModelFactory;
    plannerFactory?: PlannerFactory;
    assessorFactory?: AssessorFactory;
    recoveryPlannerFactory?: RecoveryPlannerFactory;
    planRevisionAssessorFactory?: PlanRevisionAssessorFactory;
    workspaceRoot?: string;
    computerDriver?: ComputerDriver;
    computerExecutableAliases?: Readonly<Record<string, string>>;
    computerCommandEnvironment?: Readonly<Record<string, string>>;
    tools?: readonly RuntimeTool<unknown>[];
    globalMaxDepth?: number;
    maxChildrenPerRun?: number;
  }) {
    this.database = options.database;
    this.skills = options.skills;
    this.agents = options.agents;
    this.modelFactory = options.modelFactory;
    this.plannerFactory = options.plannerFactory ?? ((_agent, model) => new ModelPlanner(model));
    this.assessorFactory = options.assessorFactory ?? ((_agent, model) => new ModelStepAssessor(model));
    this.recoveryPlannerFactory = options.recoveryPlannerFactory ?? ((_agent, model) => new ModelRecoveryPlanner(model));
    this.planRevisionAssessorFactory = options.planRevisionAssessorFactory ?? ((_agent, model) => new ModelPlanRevisionAssessor(model));
    this.globalMaxDepth = options.globalMaxDepth ?? 4;
    this.maxChildrenPerRun = options.maxChildrenPerRun ?? 8;
    const skillReadOnlyRoots = [options.skills.packageStoreRoot, options.skills.skillDirectory]
      .filter((root): root is string => root !== undefined);
    const computerExecutor = new ComputerExecutor(options.workspaceRoot ?? process.cwd(), {
      executableAliases: options.computerExecutableAliases,
      commandEnvironment: options.computerCommandEnvironment,
      readOnlyRoots: skillReadOnlyRoots,
    });
    this.workspaceRoot = computerExecutor.workspaceRoot;
    this.computerTools = createComputerTools(
      computerExecutor,
      options.computerDriver,
    );
    this.pluginTools = options.tools ?? [];
    this.plans = new PlanRepository(options.database);
    this.terminal = new TerminalCommitter(options.database, this.plans);
    this.actions = new RuntimeActionRepository(options.database);
    this.recovery = new RecoveryRepository(options.database);
  }

  async execute(
    actorUserId: string,
    agentIdInput: unknown,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    const agentId = requireString(agentIdInput, "agentId", { max: 128 });
    const input = requireString(inputValue, "input", { max: 200_000 });
    const options = parseExecuteOptions(optionsValue);
    const agent = this.agents.get(actorUserId, agentId);
    const depthCeiling = Math.min(this.globalMaxDepth, agent.maxDepth);
    return this.executeInternal(actorUserId, agent, input, options, { depth: 0, depthCeiling });
  }

  async start(
    actorUserId: string,
    agentIdInput: unknown,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    const agentId = requireString(agentIdInput, "agentId", { max: 128 });
    const input = requireString(inputValue, "input", { max: 200_000 });
    const options = parseExecuteOptions(optionsValue);
    const agent = this.agents.get(actorUserId, agentId);
    const depthCeiling = Math.min(this.globalMaxDepth, agent.maxDepth);
    let returned = false;
    const created = new Promise<RunRecord>((resolve, reject) => {
      void this.executeInternal(
        actorUserId,
        agent,
        input,
        options,
        { depth: 0, depthCeiling },
        (run) => {
          returned = true;
          resolve(run);
        },
      ).catch((error) => {
        if (!returned) reject(error);
        else if (process.env.AGENTLOOP_DEBUG_ERRORS === "1") console.error(error);
      });
    });
    return created;
  }

  get(actorUserId: string, runId: string): RunRecord {
    const row = this.database.raw.prepare(`
      SELECT id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools,
             status, input, output, error_code, created_at, finished_at
      FROM runs WHERE id = ? AND owner_user_id = ?
    `).get(runId, actorUserId) as RunRow | undefined;
    if (row === undefined) throw notFound("Run");
    return toRunRecord(row);
  }

  plan(actorUserId: string, runId: string): {
    state: "pending" | "available" | "unavailable";
    plan: ExecutionPlan;
    assessments: SkillComplianceAssessment[];
  } {
    const run = this.get(actorUserId, runId);
    try {
      const plan = this.plans.getByRun(runId);
      return { state: "available", plan, assessments: this.plans.assessments(plan.id) };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
      const now = Date.now();
      return {
        state: run.status === "running" ? "pending" : "unavailable",
        plan: {
          id: "",
          runId,
          version: 0,
          goal: run.status === "running" ? "Plan is not available yet." : "No Plan was persisted for this Run.",
          selectedSkillIds: [],
          status: run.status === "running" ? "pending" : "failed",
          steps: [],
          createdAt: run.createdAt,
          updatedAt: run.finishedAt ?? now,
        },
        assessments: [],
      };
    }
  }

  events(actorUserId: string, runId: string): StoredRunEvent[] {
    this.get(actorUserId, runId);
    const rows = this.database.raw.prepare(`
      SELECT seq, type, payload_json, created_at
      FROM run_events WHERE run_id = ? ORDER BY seq
    `).all(runId) as unknown as RunEventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  /** Subscribe to live run events as they are durably appended. */
  subscribeRunEvents(runId: string, listener: (event: LiveRunEvent) => void): () => void {
    return this.eventHub.subscribe(runId, listener);
  }

  actionsForRun(actorUserId: string, runId: string): RuntimeActionRecord[] {
    this.get(actorUserId, runId);
    return this.actions.list(runId);
  }

  recoveryForRun(actorUserId: string, runId: string): RecoveryDetail {
    this.get(actorUserId, runId);
    const state = this.recovery.state(runId);
    const action = state === undefined
      ? undefined
      : this.actions.list(runId).find((item) => item.id === state.actionId);
    return {
      ...(state === undefined ? {} : { state }),
      ...(action === undefined ? {} : { action }),
      decisions: this.recovery.list(runId),
      planRevisionAssessments: this.recovery.planRevisionAssessments(runId),
      userResponses: this.recovery.userResponses(runId),
    };
  }

  async advanceRecovery(actorUserId: string, runId: string): Promise<RecoveryDetail> {
    const run = this.get(actorUserId, runId);
    if (run.status !== "running") throw new AppError("CONFLICT", "Only a running Run can advance recovery", 409);
    const state = this.recovery.state(runId);
    if (state === undefined || state.state !== "waiting_recovery") {
      throw new AppError("CONFLICT", "Run is not waiting for a recovery decision", 409);
    }
    const action = this.actions.list(runId).find((item) => item.id === state.actionId);
    if (action === undefined || action.state !== "recovery_required") {
      throw new AppError("CONFLICT", "Recovery Action is no longer available", 409);
    }

    const agent = this.agents.get(actorUserId, run.agentId);
    const actionScope = { planId: action.planId, stepId: action.stepId };
    const model = new ActionTrackedModel(this.modelFactory(agent), this.actions, runId, () => actionScope);
    let currentPlan: ExecutionPlan | undefined;
    try {
      currentPlan = this.plans.getByRun(runId);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
    }
    const proposal = await this.recoveryPlannerFactory(agent, model).decide({
      runId,
      userInput: run.input,
      action,
      ...(currentPlan === undefined ? {} : { plan: currentPlan }),
      events: this.events(actorUserId, runId),
      userResponses: this.recovery.userResponses(runId).map((item) => ({
        actionId: item.actionId,
        response: item.response,
        createdAt: item.createdAt,
      })),
    });
    const decision = this.recovery.submit(runId, proposal);
    try {
      switch (decision.decision) {
        case "resume_step":
          if (action.replayPolicy === "unsafe") {
            throw new AppError("TOOL_POLICY_DENIED", "Unsafe Recovery Action cannot be resumed without explicit new execution", 409);
          }
          this.recovery.admit(decision.id, { kind: "ready_to_resume" });
          break;
        case "ask_user":
          this.recovery.admit(decision.id, { kind: "waiting_user", question: decision.question });
          break;
        case "fail":
          this.recovery.admit(decision.id);
          this.terminal.commitStopped({
            runId,
            ...(currentPlan === undefined ? {} : { planId: currentPlan.id }),
            status: "failed",
            reasonCode: "recovery_planner_failed",
          });
          break;
        case "revise_plan":
          await this.applyPlanRevisionRecovery({ run, agent, action, decision, currentPlan, model });
          break;
      }
    } catch (error) {
      this.rejectRecoveryDecision(decision.id, error);
      throw error;
    }
    return this.recoveryForRun(actorUserId, runId);
  }

  respondRecovery(actorUserId: string, runId: string, responseValue: unknown): RecoveryDetail {
    this.get(actorUserId, runId);
    const response = requireString(responseValue, "response", { max: 20_000 });
    this.recovery.submitUserResponse(runId, response);
    return this.recoveryForRun(actorUserId, runId);
  }

  async resumeRecovery(actorUserId: string, runId: string): Promise<RunRecord> {
    const run = this.get(actorUserId, runId);
    if (run.status !== "running") throw new AppError("CONFLICT", "Only a running Run can resume recovery", 409);
    const state = this.recovery.state(runId);
    if (state?.state !== "ready_to_resume") {
      throw new AppError("CONFLICT", "Run is not ready to resume", 409);
    }
    const action = this.actions.list(runId).find((item) => item.id === state.actionId);
    if (
      action === undefined
      || action.state !== "recovery_required"
      || (action.replayPolicy !== "safe" && action.replayPolicy !== "idempotent")
      || action.planId === undefined
      || action.stepId === undefined
    ) {
      throw new AppError("TOOL_POLICY_DENIED", "Recovery Action cannot be resumed as a safe Plan step", 409);
    }
    const plan = this.plans.getByRun(runId);
    if (plan.id !== action.planId) throw new AppError("CONFLICT", "Recovery Action belongs to a different Plan", 409);
    const targetStep = plan.steps.find((step) => step.id === action.stepId);
    if (targetStep === undefined || targetStep.retiredAt !== undefined || targetStep.status !== "running") {
      throw new AppError("CONFLICT", "Recovery Action does not target a running effective Plan step", 409);
    }

    const transcript = reconstructRecoveryTranscript({
      userInput: run.input,
      stepId: targetStep.id,
      events: this.events(actorUserId, runId),
    });
    const agent = this.agents.get(actorUserId, run.agentId);
    const privateSkills = await this.skills.resolveForAgent(actorUserId, agent.skillIds);
    await this.skills.assertIntegrity(privateSkills);
    const childAgents = agent.childAgentIds.map((childId) => this.agents.get(actorUserId, childId));
    const allTools = this.createTools({
      parentAgent: agent,
      privateSkills,
      childAgents,
      lineage: {
        ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
        depth: run.depth,
        depthCeiling: Math.min(this.globalMaxDepth, run.depth + agent.maxDepth),
      },
      executeOptions: { allowDangerousTools: run.allowDangerousTools },
    });
    assertNoDuplicateTools(allTools);
    const allowedToolNames = this.recoveryAvailableToolNames(agent, privateSkills, run.allowDangerousTools);
    const rootGrant = createCapabilityGrant({
      actorUserId,
      runId,
      agentId: agent.id,
      depth: run.depth,
      allowedToolNames,
      allowedSkillIds: privateSkills.map((skill) => skill.id),
      allowedChildAgentIds: childAgents.map((child) => child.id),
    });
    const actionScope: { planId?: string; stepId?: string } = { planId: plan.id, stepId: targetStep.id };
    const model = new ActionTrackedModel(this.modelFactory(agent), this.actions, runId, () => actionScope);
    const assessor = this.assessorFactory(agent, model);
    const emit = async (event: RuntimeEvent): Promise<void> => this.appendRunEvent(runId, event);
    let resumeStarted = false;
    try {
      this.recovery.beginResume(runId, action.id);
      resumeStarted = true;
      const resumedPlan = await this.executePlanSteps({
        actorUserId,
        runId,
        input: run.input,
        agent,
        privateSkills,
        childAgents,
        rootGrant,
        plan,
        model,
        assessor,
        registry: new ToolRegistry(allTools),
        emit,
        initialRecovery: {
          stepId: targetStep.id,
          messages: transcript.messages,
          toolEvidence: transcript.toolEvidence,
          facts: transcript.facts,
        },
        onStepChanged: (stepId) => { actionScope.stepId = stepId; },
      });
      await this.skills.assertIntegrity(privateSkills);
      const output = finalPlanOutput(resumedPlan);
      this.terminal.commitCompleted(runId, resumedPlan.id, output);
      await emit({ type: "run.completed", data: { runId, planId: resumedPlan.id, output, recovered: true } });
      return this.get(actorUserId, runId);
    } catch (error) {
      if (resumeStarted && this.get(actorUserId, runId).status === "running") {
        const reason = error instanceof AppError ? error.code : "INTERNAL_ERROR";
        this.recovery.restoreRecovery(runId, action.id, reason);
      }
      throw error;
    }
  }

  toolCatalog(): Array<{ name: string; dangerous: boolean; description: string }> {
    return [...this.computerTools, ...this.pluginTools].map((tool) => ({
      name: tool.name,
      dangerous: DANGEROUS_COMPUTER_TOOL_NAMES.has(tool.name),
      description: tool.description,
    }));
  }

  reconcileInterruptedRuns(): number {
    return this.actions.reconcileRunningRuns();
  }

  private async executeInternal(
    actorUserId: string,
    agent: AgentDefinition,
    input: string,
    executeOptions: ExecuteOptions,
    lineage: ExecutionLineage,
    onRunStarted?: (run: RunRecord) => void,
  ): Promise<RunRecord> {
    if (agent.ownerUserId !== actorUserId) throw notFound("Agent");
    if (lineage.depth > lineage.depthCeiling || lineage.depth > this.globalMaxDepth) {
      throw forbidden("Sub-agent delegation depth limit reached");
    }

    const runId = randomUUID();
    this.database.raw.prepare(`
      INSERT INTO runs(
        id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      runId,
      actorUserId,
      agent.id,
      lineage.parentRunId ?? null,
      lineage.depth,
      executeOptions.allowDangerousTools ? 1 : 0,
      input,
      Date.now(),
    );

    const emit = async (event: RuntimeEvent): Promise<void> => {
      this.appendRunEvent(runId, event);
    };
    await emit({
      type: "run.started",
      data: {
        runId,
        agentId: agent.id,
        actorUserId,
        depth: lineage.depth,
        allowDangerousTools: executeOptions.allowDangerousTools,
        ...(lineage.parentRunId === undefined ? {} : { parentRunId: lineage.parentRunId }),
      },
    });
    onRunStarted?.(this.get(actorUserId, runId));

    let planId: string | undefined;
    let runningStepId: string | undefined;
    try {
      const profileSkills = await this.skills.resolveForAgent(actorUserId, agent.skillIds);
      const privateSkills = profileSkills.filter((skill) => lineage.skillCeiling?.has(skill.id) ?? true);
      await this.skills.assertIntegrity(privateSkills);
      const discoveredByName = new Map(this.skills.discovered().map((skill) => [skill.name, skill]));
      for (const skill of privateSkills) {
        if (skill.sourceKind !== "package" || skill.package === undefined) continue;
        const discovered = discoveredByName.get(skill.name);
        if (
          discovered !== undefined
          && discovered.packageHash === skill.package.packageHash
        ) {
          await emit({
            type: "skill.directory.resolved",
            data: {
              skillId: skill.id,
              name: skill.name,
              packageHash: discovered.packageHash,
              privatePackageRoot: skill.package.root,
              ...(discovered.sourceUrl === undefined ? {} : {
                sourceUrl: discovered.sourceUrl,
                sourceRevision: discovered.sourceRevision,
              }),
            },
          });
        }
        await emit({
          type: "skill.package.verified",
          data: {
            phase: "run-start",
            skillId: skill.id,
            packageHash: skill.package.packageHash,
            fileCount: skill.package.fileCount,
            totalBytes: skill.package.totalBytes,
            ...(skill.package.url === undefined ? {} : {
              sourceUrl: skill.package.url,
              sourceRevision: skill.package.revision,
            }),
          },
        });
      }
      const profileChildren = agent.childAgentIds.map((childId) => this.agents.get(actorUserId, childId));
      const childAgents = profileChildren.filter((child) => lineage.childAgentCeiling?.has(child.id) ?? true);

      const allTools = this.createTools({
        parentAgent: agent,
        privateSkills,
        childAgents,
        lineage,
        executeOptions,
      });
      assertNoDuplicateTools(allTools);
      const registeredNames = new Set(allTools.map((tool) => tool.name));
      for (const configured of agent.toolNames) {
        if (!registeredNames.has(configured)) {
          throw new AppError("PLAN_NOT_ADMITTED", `Agent references unregistered Tool ${configured}`, 422);
        }
      }

      const profileToolNames = new Set(agent.toolNames);
      if (privateSkills.length > 0) profileToolNames.add("load_skill");
      if (childAgents.length > 0) profileToolNames.add("delegate_task");
      const allowedToolNames = [...profileToolNames].filter((name) =>
        (lineage.toolCeiling?.has(name) ?? true)
        && (executeOptions.allowDangerousTools || !DANGEROUS_COMPUTER_TOOL_NAMES.has(name))
      );
      const rootGrant = createCapabilityGrant({
        actorUserId,
        runId,
        agentId: agent.id,
        depth: lineage.depth,
        allowedToolNames,
        allowedSkillIds: privateSkills.map((skill) => skill.id),
        allowedChildAgentIds: childAgents.map((child) => child.id),
      });

      const rawModel = this.modelFactory(agent);
      const actionScope: { planId?: string; stepId?: string } = {};
      const model = new ActionTrackedModel(rawModel, this.actions, runId, () => actionScope);
      const proposal = await this.plannerFactory(agent, model).plan({
        runId,
        input,
        agent,
        availableSkills: privateSkills,
        availableToolNames: allowedToolNames,
      }, undefined, emit);
      await emit({
        type: "plan.proposed",
        data: { goal: proposal.goal, selectedSkillIds: proposal.selectedSkillIds, stepCount: proposal.steps.length },
      });
      let plan = admitPlan({
        runId,
        proposal,
        availableSkills: privateSkills,
        availableToolNames: rootGrant.allowedToolNames,
      });
      plan = this.plans.create(plan);
      planId = plan.id;
      actionScope.planId = plan.id;
      await emit({
        type: "plan.admitted",
        data: { planId: plan.id, version: plan.version, goal: plan.goal, steps: plan.steps },
      });

      const assessor = this.assessorFactory(agent, model);
      const registry = new ToolRegistry(allTools);
      plan = await this.executePlanSteps({
        actorUserId,
        runId,
        input,
        agent,
        privateSkills,
        childAgents,
        rootGrant,
        plan,
        model,
        assessor,
        registry,
        emit,
        onStepChanged: (stepId) => {
          runningStepId = stepId;
          actionScope.stepId = stepId;
        },
      });

      await this.skills.assertIntegrity(privateSkills);
      for (const skill of privateSkills) {
        if (skill.sourceKind !== "package" || skill.package === undefined) continue;
        await emit({
          type: "skill.package.verified",
          data: {
            phase: "terminal",
            skillId: skill.id,
            packageHash: skill.package.packageHash,
            ...(skill.package.revision === undefined ? {} : { sourceRevision: skill.package.revision }),
          },
        });
      }
      const output = finalPlanOutput(plan);
      this.terminal.commitCompleted(runId, plan.id, output);
      await emit({ type: "run.completed", data: { runId, planId: plan.id, output } });
      return this.get(actorUserId, runId);
    } catch (error) {
      if (process.env.AGENTLOOP_DEBUG_ERRORS === "1") console.error(error);
      const appError = error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "Run failed", 500);
      if (planId !== undefined && runningStepId !== undefined) {
        this.plans.failStep(planId, runningStepId, appError.message);
      }
      const status = appError.code === "CANCELLED" ? "cancelled" : "failed";
      this.terminal.commitStopped({ runId, planId, status, reasonCode: appError.code });
      await emit({
        type: status === "cancelled" ? "run.cancelled" : "run.failed",
        data: {
          runId,
          planId,
          code: appError.code,
          message: appError.message,
          ...(appError.details === undefined ? {} : { details: appError.details }),
        },
      });
      throw new AppError(appError.code, appError.message, appError.status, {
        ...(appError.details ?? {}),
        runId,
      });
    }
  }

  private createTools(options: {
    parentAgent: AgentDefinition;
    privateSkills: readonly PrivateSkill[];
    childAgents: readonly AgentDefinition[];
    lineage: ExecutionLineage;
    executeOptions: ExecuteOptions;
  }): RuntimeTool<unknown>[] {
    const tools: RuntimeTool<unknown>[] = [...this.computerTools, ...this.pluginTools];
    if (options.privateSkills.length > 0) tools.push(createSkillLoader(options.privateSkills, this.workspaceRoot));
    if (options.childAgents.length > 0) {
      const byId = new Map(options.childAgents.map((agent) => [agent.id, agent]));
      let childrenLaunched = 0;
      tools.push({
        name: "delegate_task",
        description: "Run a bounded task in an explicitly authorized child Agent and return its terminal outcome",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["agentId", "task"],
          properties: { agentId: { type: "string" }, task: { type: "string" } },
        },
        executionMode: "exclusive",
        replaySafe: false,
        parse: (value) => {
          const record = requireRecord(value, "delegate_task arguments");
          return {
            agentId: requireString(record.agentId, "agentId", { max: 128 }),
            task: requireString(record.task, "task", { max: 200_000 }),
          };
        },
        execute: async (context, value) => {
          const inputValue = value as { agentId: string; task: string };
          const child = byId.get(inputValue.agentId);
          if (child === undefined || !context.grant.allowedChildAgentIds.has(inputValue.agentId)) {
            throw notFound("Agent");
          }
          const childDepth = options.lineage.depth + 1;
          if (childDepth > options.lineage.depthCeiling) {
            throw forbidden("Sub-agent delegation depth limit reached");
          }
          if (childrenLaunched >= this.maxChildrenPerRun) {
            throw new AppError(
              "RUN_LIMIT_EXCEEDED",
              `Run exceeded its ${this.maxChildrenPerRun}-child limit`,
              409,
            );
          }
          childrenLaunched += 1;
          const childRun = await this.executeInternal(
            context.grant.actorUserId,
            child,
            inputValue.task,
            options.executeOptions,
            {
              parentRunId: context.grant.runId,
              depth: childDepth,
              depthCeiling: Math.min(options.lineage.depthCeiling, childDepth + child.maxDepth),
              toolCeiling: context.grant.allowedToolNames,
              skillCeiling: context.grant.allowedSkillIds,
              childAgentCeiling: context.grant.allowedChildAgentIds,
            },
          );
          // DeepSeek Harness lifecycle semantics: terminal state comes from the
          // child's own persisted outcome, never from teardown success or parent prose.
          return {
            runId: childRun.id,
            agentId: childRun.agentId,
            status: childRun.status,
            output: childRun.output,
            errorCode: childRun.errorCode,
          };
        },
      });
    }
    return tools;
  }

  private async executePlanSteps(input: {
    actorUserId: string;
    runId: string;
    input: string;
    agent: AgentDefinition;
    privateSkills: readonly PrivateSkill[];
    childAgents: readonly AgentDefinition[];
    rootGrant: CapabilityGrant;
    plan: ExecutionPlan;
    model: ModelAdapter;
    assessor: StepAssessor;
    registry: ToolRegistry;
    emit: (event: RuntimeEvent) => Promise<void>;
    initialRecovery?: Readonly<{
      stepId: string;
      messages: readonly ModelMessage[];
      toolEvidence: readonly AgentLoopToolEvidence[];
      facts: unknown;
    }>;
    onStepChanged: (stepId: string | undefined) => void;
  }): Promise<ExecutionPlan> {
    let plan = input.plan;
    let forcedStepId = input.initialRecovery?.stepId;
    while (plan.steps.some((step) => step.status !== "completed" && step.retiredAt === undefined)) {
      if (forcedStepId === undefined) this.scheduler.assertProgressPossible(plan);
      const step = forcedStepId === undefined
        ? this.scheduler.nextReady(plan)
        : plan.steps.find((item) => item.id === forcedStepId && item.retiredAt === undefined);
      forcedStepId = undefined;
      if (step === undefined) break;
      if (step.status !== "pending" && step.status !== "running") {
        throw new AppError("CONFLICT", `Plan step ${step.id} cannot be resumed from ${step.status}`, 409);
      }
      input.onStepChanged(step.id);
      if (step.status === "pending") plan = this.plans.startStep(plan.id, step.id);
      const activeStep = plan.steps.find((item) => item.id === step.id)!;
      const stepSkills = activeStep.skillIds.map((skillId) => {
        const skill = input.privateSkills.find((item) => item.id === skillId);
        if (skill === undefined) throw new AppError("PLAN_NOT_ADMITTED", `Skill ${skillId} disappeared`, 409);
        return skill;
      });
      await this.skills.assertIntegrity(stepSkills);
      const stepToolNames = new Set(
        activeStep.requiredToolNames.filter((name) => input.rootGrant.allowedToolNames.has(name)),
      );
      const stepGrant = createCapabilityGrant({
        actorUserId: input.actorUserId,
        runId: input.runId,
        agentId: input.agent.id,
        depth: input.rootGrant.depth,
        allowedToolNames: stepToolNames,
        allowedSkillIds: activeStep.skillIds,
        allowedChildAgentIds: stepToolNames.has("delegate_task") ? input.rootGrant.allowedChildAgentIds : [],
      });
      await input.emit({
        type: "plan.step.started",
        data: {
          planId: plan.id,
          stepId: activeStep.id,
          skillIds: activeStep.skillIds,
          toolNames: [...stepGrant.allowedToolNames],
          ...(input.initialRecovery?.stepId === activeStep.id ? { recovered: true } : {}),
        },
      });
      let assessmentAttempt = this.plans.assessments(plan.id)
        .filter((assessment) => assessment.stepId === activeStep.id).length;
      const recovery = input.initialRecovery?.stepId === activeStep.id ? input.initialRecovery : undefined;
      const result = await runAgentLoop({
        runId: input.runId,
        systemPrompt: buildStepSystemPrompt(input.agent),
        runtimeContext: recovery === undefined
          ? buildStepRuntimeContext(activeStep, plan, stepSkills, input.childAgents, this.workspaceRoot)
          : buildRecoveredStepRuntimeContext(
            activeStep,
            plan,
            stepSkills,
            input.childAgents,
            this.workspaceRoot,
            recovery.facts,
          ),
        input: input.input,
        ...(recovery === undefined ? {} : {
          initialMessages: recovery.messages,
          initialToolEvidence: recovery.toolEvidence,
        }),
        model: input.model,
        tools: input.registry,
        grant: stepGrant,
        requiredSkills: stepSkills.map((skill) => ({ id: skill.id, name: skill.name, contentHash: skill.contentHash })),
        maxSteps: input.agent.maxSteps,
        emit: input.emit,
        actionTracker: {
          executeToolCall: (toolAction, operation) => this.actions.execute({
            runId: input.runId,
            planId: plan.id,
            stepId: activeStep.id,
            kind: "tool_call",
            replayPolicy: toolAction.replaySafe ? "safe" : "unsafe",
            deadlineMs: toolAction.timeoutMs ?? 120_000,
            metadata: {
              toolCallId: toolAction.toolCallId,
              toolName: toolAction.toolName,
              modelStep: toolAction.step,
            },
          }, operation),
        },
        evaluateCandidate: async (candidate) => {
          assessmentAttempt += 1;
          await this.skills.assertIntegrity(stepSkills);
          const evidence: StepEvidence = {
            candidateOutput: candidate.output,
            toolCalls: candidate.toolEvidence,
            modelSteps: candidate.modelSteps,
          };
          const modelEvidence: StepEvidence = {
            candidateOutput: candidate.output,
            toolCalls: candidate.projectedToolEvidence,
            modelSteps: candidate.modelSteps,
          };
          const assessment = await input.assessor.assess({
            runId: input.runId,
            planId: plan.id,
            step: activeStep,
            skills: stepSkills,
            evidence,
            modelEvidence,
            ...(candidate.contextSummary === undefined ? {} : { contextSummary: candidate.contextSummary }),
            attempt: assessmentAttempt,
          }, undefined, input.emit);
          this.plans.saveAssessment(assessment);
          await input.emit({
            type: "skill.compliance.assessed",
            data: {
              planId: plan.id,
              stepId: activeStep.id,
              attempt: assessment.attempt,
              approved: assessment.approved,
              evidenceDigest: assessment.evidenceDigest,
              criteria: assessment.criteria,
              skills: assessment.skills,
              feedback: assessment.feedback,
            },
          });
          return { approved: assessment.approved, feedback: assessment.feedback };
        },
      });
      const evidence: StepEvidence = {
        candidateOutput: result.output,
        toolCalls: result.toolEvidence,
        modelSteps: result.steps,
      };
      plan = this.plans.completeStep(plan.id, activeStep.id, result.output, evidence);
      input.onStepChanged(undefined);
      await input.emit({
        type: "plan.step.completed",
        data: { planId: plan.id, stepId: activeStep.id, output: result.output },
      });
    }
    return plan;
  }

  private async applyPlanRevisionRecovery(input: {
    run: RunRecord;
    agent: AgentDefinition;
    action: RuntimeActionRecord;
    decision: RecoveryDecisionRecord;
    currentPlan?: ExecutionPlan;
    model: ModelAdapter;
  }): Promise<void> {
    if (input.currentPlan === undefined || input.decision.planRevision === undefined) {
      throw new AppError("PLAN_NOT_ADMITTED", "Plan revision requires the persisted current Plan", 422);
    }
    const privateSkills = await this.skills.resolveForAgent(input.run.ownerUserId, input.agent.skillIds);
    await this.skills.assertIntegrity(privateSkills);
    const availableToolNames = this.recoveryAvailableToolNames(input.agent, privateSkills, input.run.allowDangerousTools);
    const admitted = admitPlan({
      runId: input.run.id,
      proposal: input.decision.planRevision,
      availableSkills: privateSkills,
      availableToolNames,
    });
    const proposedIds = new Set(admitted.steps.map((step) => step.id));
    const retiredStepIds = input.currentPlan.steps
      .filter((step) => step.retiredAt === undefined && !proposedIds.has(step.id))
      .map((step) => step.id);
    this.assertRetirementHasNoUnconfirmedUnsafeEffect(input.run.id, input.currentPlan.id, retiredStepIds);
    this.plans.validateRevision({
      planId: input.currentPlan.id,
      proposal: admitted,
      retiredStepIds,
      reason: input.decision.rationale,
      actionId: input.action.id,
    });
    const assessment = await this.planRevisionAssessorFactory(input.agent, input.model).assess({
      runId: input.run.id,
      userInput: input.run.input,
      currentPlan: input.currentPlan,
      proposal: input.decision.planRevision,
      retiredStepIds,
      recoveryAction: {
        id: input.action.id,
        kind: input.action.kind,
        replayPolicy: input.action.replayPolicy,
        metadata: input.action.metadata,
      },
    });
    this.recovery.savePlanRevisionAssessment({
      decisionId: input.decision.id,
      planId: input.currentPlan.id,
      assessment,
    });
    if (!assessment.approved) {
      throw new AppError("ASSESSMENT_ERROR", "Plan Revision Assessor did not approve the recovery revision", 422);
    }
    const revised = this.plans.revise({
      planId: input.currentPlan.id,
      proposal: admitted,
      retiredStepIds,
      reason: input.decision.rationale,
      actionId: input.action.id,
    });
    this.recovery.admit(input.decision.id);
    if (isEffectivelyComplete(revised)) {
      const output = finalPlanOutput(revised);
      this.terminal.commitCompleted(input.run.id, revised.id, output);
      this.appendRunEvent(input.run.id, { type: "run.completed", data: { runId: input.run.id, planId: revised.id, output } });
    }
  }

  private recoveryAvailableToolNames(
    agent: AgentDefinition,
    privateSkills: readonly PrivateSkill[],
    allowDangerousTools: boolean,
  ): Set<string> {
    const registered = new Set([...this.computerTools, ...this.pluginTools].map((tool) => tool.name));
    if (privateSkills.length > 0) registered.add("load_skill");
    if (agent.childAgentIds.length > 0) registered.add("delegate_task");
    for (const toolName of agent.toolNames) {
      if (!registered.has(toolName)) {
        throw new AppError("PLAN_NOT_ADMITTED", `Agent references unregistered Tool ${toolName}`, 422);
      }
    }
    const allowed = new Set(agent.toolNames);
    if (privateSkills.length > 0) allowed.add("load_skill");
    if (agent.childAgentIds.length > 0) allowed.add("delegate_task");
    return new Set([...allowed].filter((name) => allowDangerousTools || !DANGEROUS_COMPUTER_TOOL_NAMES.has(name)));
  }

  private assertRetirementHasNoUnconfirmedUnsafeEffect(
    runId: string,
    planId: string,
    retiredStepIds: readonly string[],
  ): void {
    if (retiredStepIds.length === 0) return;
    const retired = new Set(retiredStepIds);
    const unsafe = this.actions.list(runId).find((item) =>
      item.planId === planId
      && item.stepId !== undefined
      && retired.has(item.stepId)
      && item.replayPolicy === "unsafe"
      && item.state !== "succeeded",
    );
    if (unsafe !== undefined) {
      throw new AppError(
        "TOOL_POLICY_DENIED",
        `Plan revision cannot retire step ${unsafe.stepId} with unconfirmed unsafe Action ${unsafe.id}`,
        409,
      );
    }
  }

  private rejectRecoveryDecision(decisionId: string, error: unknown): void {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : "Recovery decision admission failed";
    try {
      this.recovery.reject(decisionId, code, message);
    } catch (rejectionError) {
      if (!(rejectionError instanceof AppError) || rejectionError.code !== "CONFLICT") throw rejectionError;
    }
  }

  private appendRunEvent(runId: string, event: RuntimeEvent): void {
    const createdAt = Date.now();
    const sequence = this.database.raw.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
    ).get(runId) as { seq: number };
    this.database.raw.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence.seq, event.type, JSON.stringify(event.data), createdAt);
    this.eventHub.publish(runId, {
      seq: sequence.seq,
      type: event.type,
      data: event.data,
      createdAt,
    });
  }
}

class ActionTrackedModel implements ModelAdapter {
  readonly limits: ModelAdapter["limits"];
  readonly operationTimeoutMs: number;
  private readonly model: ModelAdapter;
  private readonly actions: RuntimeActionRepository;
  private readonly runId: string;
  private readonly scope: () => { planId?: string; stepId?: string };

  constructor(
    model: ModelAdapter,
    actions: RuntimeActionRepository,
    runId: string,
    scope: () => { planId?: string; stepId?: string },
  ) {
    this.model = model;
    this.actions = actions;
    this.runId = runId;
    this.scope = scope;
    this.limits = model.limits;
    this.operationTimeoutMs = model.operationTimeoutMs ?? 120_000;
  }

  estimateInputTokens(invocation: ModelInvocation): number | undefined {
    return this.model.estimateInputTokens?.(invocation);
  }

  complete(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    const scope = this.scope();
    return this.actions.execute({
      runId: this.runId,
      planId: scope.planId,
      stepId: scope.stepId,
      kind: actionKindForPhase(invocation.phase),
      replayPolicy: "safe",
      deadlineMs: this.operationTimeoutMs + 15_000,
      metadata: { phase: invocation.phase },
    }, () => this.model.complete(invocation, signal));
  }

  streamComplete(
    invocation: ModelInvocation,
    sink: ModelStreamSink,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const scope = this.scope();
    const stream = this.model.streamComplete;
    return this.actions.execute({
      runId: this.runId,
      planId: scope.planId,
      stepId: scope.stepId,
      kind: actionKindForPhase(invocation.phase),
      replayPolicy: "safe",
      deadlineMs: this.operationTimeoutMs + 15_000,
      metadata: { phase: invocation.phase },
    }, () => stream === undefined
      ? this.model.complete(invocation, signal)
      : stream.call(this.model, invocation, sink, signal));
  }
}

function actionKindForPhase(phase: RuntimeContextSnapshot["phase"]): Exclude<RuntimeActionRecord["kind"], "recovery_review"> {
  if (phase === "planning") return "planning";
  if (phase === "assessment") return "assessment";
  if (phase === "compaction") return "compaction";
  return "model_turn";
}

function createSkillLoader(skills: readonly PrivateSkill[], workspaceRoot: string): RuntimeTool<unknown> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    name: "load_skill",
    description: [
      "Load the exact authorized private Skill version bound to the current Plan step.",
      "Use this before applying a Skill; its output injects the authoritative instructions and package-relative path base into the conversation.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } },
    },
    executionMode: "parallel",
    replaySafe: true,
    maxResultCharacters: 250_000,
    parse: (value) => ({ name: requireString(requireRecord(value).name, "name", { max: 80 }) }),
    execute: async (context, value) => {
      const skill = byName.get((value as { name: string }).name);
      if (skill === undefined || !context.grant.allowedSkillIds.has(skill.id)) throw notFound("Skill");
      return formatLoadedSkill(skill, {
        packageRoot: (item) => packageWorkspaceRoot(item, workspaceRoot),
      });
    },
  };
}

function buildStepSystemPrompt(agent: AgentDefinition): string {
  const sections = [agent.systemPrompt.trim()];
  sections.push([
    "<runtime_contract>",
    "Work only on the current admitted Plan step.",
    "The runtime owns authorization, persistence, assessment, Plan progression, and terminal completion.",
    "Your response without tool calls is only a completion candidate and may be rejected with repair feedback.",
    "Use only currently exposed tools. Tool success alone does not prove the step is complete.",
    "</runtime_contract>",
  ].join("\n"));
  return sections.join("\n\n");
}

function packageWorkspaceRoot(skill: PrivateSkill, workspaceRoot: string): string {
  if (skill.package === undefined) throw new Error(`Skill ${skill.id} is not package-backed`);
  const offset = relative(workspaceRoot, skill.package.root);
  if (offset === "") return ".";
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new AppError(
      "PLAN_NOT_ADMITTED",
      `Installed Skill package ${skill.name} is outside the Computer workspace`,
      422,
    );
  }
  return offset;
}

function buildStepRuntimeContext(
  step: ExecutionPlan["steps"][number],
  plan: ExecutionPlan,
  skills: readonly PrivateSkill[],
  childAgents: readonly AgentDefinition[],
  workspaceRoot: string,
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const skillCatalog = formatAvailableSkills(skills, {
    packageRoot: (skill) => packageWorkspaceRoot(skill, workspaceRoot),
  });
  return {
    phase: "execution",
    content: [
      "<execution_context source=\"server\">",
      JSON.stringify({
        currentPlanStep: {
          id: step.id,
          objective: step.objective,
          successCriteria: step.successCriteria,
        },
        dependencyOutputs: step.dependencies.map((dependencyId) => {
          const dependency = plan.steps.find((item) => item.id === dependencyId);
          return { stepId: dependencyId, output: dependency?.output ?? "" };
        }),
        workspace: { root: workspaceRoot, filePolicy: "workspace-write" },
        childAgents: childAgents.map((child) => ({ id: child.id, name: child.name })),
      }),
      "</execution_context>",
      skillCatalog,
    ].filter(Boolean).join("\n"),
  };
}

function buildRecoveredStepRuntimeContext(
  step: ExecutionPlan["steps"][number],
  plan: ExecutionPlan,
  skills: readonly PrivateSkill[],
  childAgents: readonly AgentDefinition[],
  workspaceRoot: string,
  recoveryFacts: unknown,
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const base = buildStepRuntimeContext(step, plan, skills, childAgents, workspaceRoot);
  return {
    ...base,
    content: [
      base.content,
      "<recovery_context source=\"server\">",
      JSON.stringify({
        contract: "Only complete persisted exchanges were restored into the transcript. Unfinished calls are facts, not results.",
        recoveryFacts,
      }),
      "</recovery_context>",
    ].join("\n"),
  };
}

function finalPlanOutput(plan: ExecutionPlan): string {
  const effectiveSteps = plan.steps.filter((step) => step.retiredAt === undefined);
  const terminalSteps = effectiveSteps.filter((candidate) =>
    !effectiveSteps.some((other) => other.dependencies.includes(candidate.id))
  );
  if (terminalSteps.length === 1) return terminalSteps[0].output ?? "";
  return JSON.stringify(terminalSteps.map((step) => ({ stepId: step.id, output: step.output ?? "" })));
}

function isEffectivelyComplete(plan: ExecutionPlan): boolean {
  return plan.steps.every((step) => step.status === "completed" || step.retiredAt !== undefined);
}

function parseExecuteOptions(value: unknown): ExecuteOptions {
  if (value === undefined) return { allowDangerousTools: false };
  const record = requireRecord(value, "run options");
  if (record.allowDangerousTools !== undefined && typeof record.allowDangerousTools !== "boolean") {
    throw new AppError("BAD_REQUEST", "allowDangerousTools must be boolean", 400);
  }
  return { allowDangerousTools: record.allowDangerousTools === true };
}

function assertNoDuplicateTools(tools: readonly RuntimeTool<unknown>[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    depth: row.depth,
    allowDangerousTools: row.allow_dangerous_tools === 1,
    status: row.status,
    input: row.input,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  };
}

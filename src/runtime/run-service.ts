import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ComputerExecutor } from "../computer/computer-executor.ts";
import type { ComputerDriver } from "../computer/computer-driver.ts";
import { createComputerTools, DANGEROUS_COMPUTER_TOOL_NAMES } from "../computer/computer-tools.ts";
import { admitPlan, hasFileProducer } from "../planning/admission.ts";
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
import type { SqlConnection } from "../storage/connection.ts";
import { RunRepository, type RunRow, type RunEventRow } from "../storage/repositories/run-repository.ts";
import { AppError, forbidden, notFound } from "../shared/errors.ts";
import { optionalPositiveInteger, requireRecord, requireString } from "../shared/validation.ts";
import { runAgentLoop, type ToolStepConvergenceContext } from "./agent-loop.ts";
import { createCapabilityGrant } from "./capability-grant.ts";
import type { ContextPolicy } from "./context-assembler.ts";
import type {
  CapabilityGrant,
  AgentLoopToolEvidence,
  ModelAdapter,
  ModelInvocation,
  ModelMessage,
  ModelResponse,
  ModelRetryReporter,
  ModelStreamSink,
  RuntimeContextSnapshot,
  RuntimeEvent,
} from "./contracts.ts";
import { TerminalCommitter } from "./terminal-committer.ts";
import { RunOutcomeRepository } from "../storage/repositories/outcome-repository.ts";
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
import {
  collectProcessArtifacts,
  readProcessArtifact,
  type ProcessArtifact,
} from "./process-artifacts.ts";
import { executionOperationProfile } from "./operation-profiles.ts";
import { ToolRegistry } from "./tool-registry.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export type ModelFactory = (onRetry?: ModelRetryReporter, modelKey?: string) => ModelAdapter;
export type PlannerFactory = (model: ModelAdapter) => Planner;
export type AssessorFactory = (model: ModelAdapter) => StepAssessor;
export type RecoveryPlannerFactory = (model: ModelAdapter) => RecoveryPlanner;
export type PlanRevisionAssessorFactory = (model: ModelAdapter) => PlanRevisionAssessor;
export type RunEventLogSink = (line: string) => void;

/**
 * AgentLoop is a single-agent runtime: this server-owned system prompt shapes
 * every run. It cannot be overridden by Run inputs.
 */
export const DEFAULT_RUNNER_SYSTEM_PROMPT =
  "你是一个严谨、可靠的智能助手。根据当前用户请求选择必要能力；在形成可核验的结果之前，不要宣称完成。";

/** Server-wide default model-turn budget per Plan step. */
export const DEFAULT_MAX_STEPS = 12;

export interface RunRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly conversationId?: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly allowDangerousTools: boolean;
  readonly modelKey?: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly input: string;
  readonly output?: string;
  readonly errorCode?: string;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly runCount: number;
  readonly lastStatus: RunRecord["status"] | null;
}

export interface StoredRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

interface ExecuteOptions {
  readonly allowDangerousTools: boolean;
  readonly conversationId?: string;
  readonly conversationIntent?: "auto";
  readonly modelKey?: string;
}

export interface RecoveryDetail {
  readonly state?: RunRecoveryState;
  readonly action?: RuntimeActionRecord;
  readonly decisions: readonly RecoveryDecisionRecord[];
  readonly planRevisionAssessments: readonly PlanRevisionAssessmentRecord[];
  readonly userResponses: readonly RecoveryUserResponse[];
}

export class RunService {
  private readonly database: SqlConnection;
  private readonly runs: RunRepository;
  private readonly skills: SkillService;
  private readonly modelFactory: ModelFactory;
  private readonly plannerFactory: PlannerFactory;
  private readonly assessorFactory: AssessorFactory;
  private readonly recoveryPlannerFactory: RecoveryPlannerFactory;
  private readonly planRevisionAssessorFactory: PlanRevisionAssessorFactory;
  private readonly systemPrompt: string;
  private readonly maxSteps: number;
  private readonly defaultModelKey?: string;
  private readonly allowedModelKeys?: ReadonlySet<string>;
  private readonly workspaceRoot: string;
  private readonly computerTools: readonly RuntimeTool<unknown>[];
  private readonly pluginTools: readonly RuntimeTool<unknown>[];
  private readonly plans: PlanRepository;
  private readonly scheduler = new DependencyScheduler();
  private readonly terminal: TerminalCommitter;
  private readonly actions: RuntimeActionRepository;
  private readonly recovery: RecoveryRepository;
  private readonly eventHub = new RunEventHub();
  private readonly runEventLogSink?: RunEventLogSink;

  constructor(options: {
    database: SqlConnection;
    skills: SkillService;
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
    systemPrompt?: string;
    maxSteps?: number;
    defaultModelKey?: string;
    modelKeys?: readonly string[];
    runEventLogSink?: RunEventLogSink;
  }) {
    this.database = options.database;
    this.skills = options.skills;
    this.modelFactory = options.modelFactory;
    this.plannerFactory = options.plannerFactory ?? ((model) => new ModelPlanner(model));
    this.assessorFactory = options.assessorFactory ?? ((model) => new ModelStepAssessor(model));
    this.recoveryPlannerFactory = options.recoveryPlannerFactory ?? ((model) => new ModelRecoveryPlanner(model));
    this.planRevisionAssessorFactory = options.planRevisionAssessorFactory ?? ((model) => new ModelPlanRevisionAssessor(model));
    this.systemPrompt = options.systemPrompt ?? DEFAULT_RUNNER_SYSTEM_PROMPT;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.defaultModelKey = options.defaultModelKey;
    this.allowedModelKeys = options.modelKeys === undefined ? undefined : new Set(options.modelKeys);
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
    this.runs = new RunRepository(options.database);
    this.plans = new PlanRepository(options.database);
    this.terminal = new TerminalCommitter(this.plans, new RunOutcomeRepository(options.database));
    this.actions = new RuntimeActionRepository(options.database);
    this.recovery = new RecoveryRepository(options.database);
    this.runEventLogSink = options.runEventLogSink;
  }

  async execute(
    actorUserId: string,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    const input = requireString(inputValue, "input", { max: 200_000 });
    const options = parseExecuteOptions(optionsValue);
    return this.executeInternal(actorUserId, input, options);
  }

  async start(
    actorUserId: string,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    const input = requireString(inputValue, "input", { max: 200_000 });
    const options = parseExecuteOptions(optionsValue);
    let returned = false;
    const created = new Promise<RunRecord>((resolve, reject) => {
      void this.executeInternal(
        actorUserId,
        input,
        options,
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
    const row = this.runs.getByOwner(runId, actorUserId);
    if (row === undefined) throw notFound("Run");
    return toRunRecord(row);
  }

  /** Most-recent-first run history for one user, bounded for the conversation list. */
  list(actorUserId: string, limitValue?: unknown): RunRecord[] {
    const limit = optionalPositiveInteger(limitValue, "limit", 200, 500);
    const rows = this.runs.listByOwner(actorUserId, limit);
    return rows.map(toRunRecord);
  }

  /** Most-recently-updated conversations for one user, for the sidebar. */
  listConversations(actorUserId: string): ConversationSummary[] {
    const rows = this.runs.listConversationSummaries(actorUserId);
    return rows.map((row) => {
      const last = this.runs.lastTopLevelStatus(row.id);
      return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        runCount: row.run_count,
        lastStatus: last?.status ?? null,
      };
    });
  }

  /** One conversation plus its top-level turns in chronological order. */
  getConversation(actorUserId: string, conversationId: string): {
    conversation: ConversationSummary;
    runs: RunRecord[];
  } {
    const conversation = this.runs.findConversation(actorUserId, conversationId);
    if (conversation === undefined) throw notFound("Conversation");
    const rows = this.runs.topLevelRunsInConversation(conversationId);
    const last = this.runs.lastTopLevelStatus(conversationId);
    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
        runCount: rows.length,
        lastStatus: last?.status ?? null,
      },
      runs: rows.map(toRunRecord),
    };
  }

  deleteConversation(actorUserId: string, conversationId: string): void {
    this.runs.deleteConversation(actorUserId, conversationId);
  }

  private resolveConversation(
    actorUserId: string,
    input: string,
    requestedId: string | undefined,
  ): string {
    if (requestedId !== undefined) {
      const row = this.runs.findConversation(actorUserId, requestedId);
      if (row === undefined) throw notFound("Conversation");
      this.runs.touchConversation(requestedId, Date.now());
      return requestedId;
    }
    const id = randomUUID();
    const now = Date.now();
    this.runs.insertConversation({ id, ownerUserId: actorUserId, title: titleFromInput(input), createdAt: now });
    return id;
  }

  private conversationHistory(conversationId: string): ModelMessage[] {
    const rows = this.runs.conversationTranscript(conversationId);
    const messages: ModelMessage[] = [];
    for (const row of rows) {
      messages.push({ role: "user", content: row.input });
      if (row.output !== null) messages.push({ role: "assistant", content: row.output });
    }
    return capConversationHistory(messages);
  }

  private runWorkspaceRoot(run: Pick<RunRecord, "conversationId">): string {
    return run.conversationId === undefined
      ? this.workspaceRoot
      : this.conversationWorkspaceRoot(run.conversationId);
  }

  private conversationWorkspaceRoot(conversationId: string): string {
    if (!isSafeWorkspaceSegment(conversationId)) {
      throw new AppError("BAD_REQUEST", "Invalid conversation workspace id", 400);
    }
    const target = resolve(this.workspaceRoot, "conversations", conversationId);
    this.assertInsideServerWorkspace(target);
    return target;
  }

  private async ensureConversationWorkspace(conversationId: string): Promise<string> {
    const parent = resolve(this.workspaceRoot, "conversations");
    const target = this.conversationWorkspaceRoot(conversationId);
    await this.ensureManagedWorkspaceDirectory(parent);
    await this.ensureManagedWorkspaceDirectory(target);
    return fs.realpath(target);
  }

  private async ensureManagedWorkspaceDirectory(directory: string): Promise<void> {
    this.assertInsideServerWorkspace(directory);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) throw forbidden("Conversation workspace directories cannot be symbolic links");
    if (!stat.isDirectory()) throw new AppError("CONFLICT", "Conversation workspace path is not a directory", 409);
    this.assertInsideServerWorkspace(await fs.realpath(directory));
  }

  private assertInsideServerWorkspace(path: string): void {
    const offset = relative(this.workspaceRoot, path);
    if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
    throw forbidden("Conversation workspace escapes the configured workspace root");
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
    const rows = this.runs.eventsByRun(runId);
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  /**
   * Process artifacts are derived from this Run's successful tool receipts and
   * revalidated inside the workspace. They are observable work-in-progress,
   * never a substitute for a completed Plan or approved Assessment.
   */
  async processArtifacts(actorUserId: string, runId: string): Promise<ProcessArtifact[]> {
    const run = this.get(actorUserId, runId);
    const workspaceRoot = this.runWorkspaceRoot(run);
    return collectProcessArtifacts({
      runId,
      workspaceRoot,
      runCreatedAt: run.createdAt,
      events: this.events(actorUserId, runId),
    });
  }

  async readProcessArtifact(actorUserId: string, runId: string, artifactId: string): Promise<{
    artifact: ProcessArtifact;
    content: Buffer;
  }> {
    const artifact = (await this.processArtifacts(actorUserId, runId)).find((item) => item.id === artifactId);
    if (artifact === undefined) throw notFound("Process artifact");
    const run = this.get(actorUserId, runId);
    try {
      return { artifact, content: await readProcessArtifact({ artifact, workspaceRoot: this.runWorkspaceRoot(run) }) };
    } catch {
      throw notFound("Process artifact");
    }
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

    const actionScope = { planId: action.planId, stepId: action.stepId };
    const model = new ActionTrackedModel(
      this.modelFactory(this.retryReporter(runId), run.modelKey),
      this.actions,
      runId,
      () => actionScope,
    );
    let currentPlan: ExecutionPlan | undefined;
    try {
      currentPlan = this.plans.getByRun(runId);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
    }
    const proposal = await this.recoveryPlannerFactory(model).decide({
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
          await this.applyPlanRevisionRecovery({ run, action, decision, currentPlan, model });
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
    const runWorkspaceRoot = run.conversationId === undefined
      ? this.workspaceRoot
      : await this.ensureConversationWorkspace(run.conversationId);

    const transcript = reconstructRecoveryTranscript({
      userInput: run.input,
      stepId: targetStep.id,
      events: this.events(actorUserId, runId),
    });
    const privateSkills = await this.skills.resolveForConversation(actorUserId);
    await this.skills.assertIntegrity(privateSkills);
    const allTools = this.createTools(privateSkills);
    assertNoDuplicateTools(allTools);
    const allowedToolNames = this.recoveryAvailableToolNames(privateSkills, run.allowDangerousTools);
    const rootGrant = createCapabilityGrant({
      actorUserId,
      runId,
      ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
      depth: run.depth,
      workspaceRoot: runWorkspaceRoot,
      allowedToolNames,
      allowedSkillIds: privateSkills.map((skill) => skill.id),
    });
    const actionScope: { planId?: string; stepId?: string } = { planId: plan.id, stepId: targetStep.id };
    const model = new ActionTrackedModel(
      this.modelFactory(this.retryReporter(runId), run.modelKey),
      this.actions,
      runId,
      () => actionScope,
    );
    const assessor = this.assessorFactory(model);
    const emit = async (event: RuntimeEvent): Promise<void> => this.appendRunEvent(runId, event);
    let resumeStarted = false;
    try {
      this.recovery.beginResume(runId, action.id);
      resumeStarted = true;
      const resumedPlan = await this.executePlanSteps({
        actorUserId,
        runId,
        input: run.input,
        privateSkills,
        rootGrant,
        plan,
        model,
        assessor,
        registry: new ToolRegistry(allTools),
        emit,
        ...(run.conversationId === undefined
          ? {}
          : { conversationHistory: this.conversationHistory(run.conversationId) }),
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

  private resolveRunModelKey(requestedModelKey: string | undefined): string | undefined {
    const modelKey = requestedModelKey ?? this.defaultModelKey;
    if (modelKey === undefined) return undefined;
    if (this.allowedModelKeys !== undefined && !this.allowedModelKeys.has(modelKey)) {
      throw new AppError("BAD_REQUEST", `Unknown modelKey: ${modelKey}`, 400);
    }
    return modelKey;
  }

  private async executeInternal(
    actorUserId: string,
    input: string,
    executeOptions: ExecuteOptions,
    onRunStarted?: (run: RunRecord) => void,
  ): Promise<RunRecord> {
    const runId = randomUUID();
    const modelKey = this.resolveRunModelKey(executeOptions.modelKey);
    const conversationId = this.resolveConversation(actorUserId, input, executeOptions.conversationId);
    const runWorkspaceRoot = conversationId === undefined
      ? this.workspaceRoot
      : await this.ensureConversationWorkspace(conversationId);
    const conversationHistory = conversationId === undefined
      ? undefined
      : this.conversationHistory(conversationId);
    this.runs.insertRun({
      id: runId,
      ownerUserId: actorUserId,
      conversationId,
      allowDangerousTools: executeOptions.allowDangerousTools,
      ...(modelKey === undefined ? {} : { modelKey }),
      input,
      createdAt: Date.now(),
    });

    const emit = async (event: RuntimeEvent): Promise<void> => {
      this.appendRunEvent(runId, event);
    };
    await emit({
      type: "run.started",
      data: {
        runId,
        actorUserId,
        depth: 0,
        allowDangerousTools: executeOptions.allowDangerousTools,
        ...(modelKey === undefined ? {} : { modelKey }),
        ...(conversationId === undefined ? {} : { conversationId }),
        workspaceRoot: runWorkspaceRoot,
      },
    });
    onRunStarted?.(this.get(actorUserId, runId));

    let planId: string | undefined;
    let runningStepId: string | undefined;
    try {
      const rawModel = this.modelFactory(this.retryReporter(runId), modelKey);
      const responseOnly = executeOptions.conversationIntent === "auto"
        && await classifyConversationTurn(rawModel, input, conversationHistory);
      if (executeOptions.conversationIntent === "auto") {
        await emit({
          type: "conversation.intent.classified",
          data: { kind: responseOnly ? "reply" : "execute" },
        });
      }
      const privateSkills = responseOnly
        ? []
        : await this.skills.resolveForConversation(actorUserId);
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

      const allTools = this.createTools(privateSkills);
      assertNoDuplicateTools(allTools);
      const allowedToolNames = responseOnly
        ? []
        : [...allTools.map((tool) => tool.name)].filter((name) =>
          executeOptions.allowDangerousTools || !DANGEROUS_COMPUTER_TOOL_NAMES.has(name)
        );
      const allowedToolSummaries = toolSummaries(allTools, new Set(allowedToolNames));
      const rootGrant = createCapabilityGrant({
        actorUserId,
        runId,
        ...(conversationId === undefined ? {} : { conversationId }),
        depth: 0,
        workspaceRoot: runWorkspaceRoot,
        allowedToolNames,
        allowedSkillIds: privateSkills.map((skill) => skill.id),
      });

      const actionScope: { planId?: string; stepId?: string } = {};
      const model = new ActionTrackedModel(rawModel, this.actions, runId, () => actionScope);
      const planningSkills = responseOnly ? [] : selectPlanningSkills(
        privateSkills,
        input,
        [],
      );
      if (planningSkills.some((skill) => skillRequiresFileOutput(skill)) && !canProduceFiles(allowedToolNames)) {
        throw new AppError(
          "PLAN_NOT_ADMITTED",
          "The selected Skill requires file-producing tools, but this Run does not allow any write or command Tool",
          422,
        );
      }
      if (!responseOnly) {
        await emit({
          type: "planning.skills.selected",
          data: {
            selectedCount: planningSkills.length,
            skills: planningSkills.map((skill) => ({ id: skill.id, name: skill.name })),
          },
        });
      }
      const proposal = await this.plannerFactory(model).plan({
        runId,
        input,
        availableSkills: planningSkills,
        availableToolNames: allowedToolNames,
        availableTools: allowedToolSummaries,
        ...(responseOnly ? { responseOnly: true } : {}),
        ...(conversationHistory === undefined ? {} : { conversationHistory }),
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

      const assessor = this.assessorFactory(model);
      const registry = new ToolRegistry(allTools);
      plan = await this.executePlanSteps({
        actorUserId,
        runId,
        input,
        privateSkills,
        rootGrant,
        plan,
        model,
        assessor,
        registry,
        emit,
        ...(conversationHistory === undefined ? {} : { conversationHistory }),
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

  private createTools(privateSkills: readonly PrivateSkill[]): RuntimeTool<unknown>[] {
    const tools: RuntimeTool<unknown>[] = [...this.computerTools, ...this.pluginTools];
    if (privateSkills.length > 0) tools.push(createSkillLoader(privateSkills));
    return tools;
  }

  private async executePlanSteps(input: {
    actorUserId: string;
    runId: string;
    input: string;
    privateSkills: readonly PrivateSkill[];
    rootGrant: CapabilityGrant;
    plan: ExecutionPlan;
    model: ModelAdapter;
    assessor: StepAssessor;
    registry: ToolRegistry;
    emit: (event: RuntimeEvent) => Promise<void>;
    conversationHistory?: readonly ModelMessage[];
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
        ...(input.rootGrant.conversationId === undefined ? {} : { conversationId: input.rootGrant.conversationId }),
        depth: input.rootGrant.depth,
        ...(input.rootGrant.workspaceRoot === undefined ? {} : { workspaceRoot: input.rootGrant.workspaceRoot }),
        allowedToolNames: stepToolNames,
        allowedSkillIds: activeStep.skillIds,
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
      const fileOutputStep = stepSkills.some((skill) => skillRequiresFileOutput(skill))
        || stepRequiresFileOutput(activeStep);
      const result = await runAgentLoop({
        runId: input.runId,
        systemPrompt: buildStepSystemPrompt(this.systemPrompt),
        runtimeContext: recovery === undefined
          ? buildStepRuntimeContext(activeStep, plan, stepSkills, input.rootGrant.workspaceRoot ?? this.workspaceRoot)
          : buildRecoveredStepRuntimeContext(
            activeStep,
            plan,
            stepSkills,
            input.rootGrant.workspaceRoot ?? this.workspaceRoot,
            recovery.facts,
          ),
        input: input.input,
        ...(input.conversationHistory === undefined ? {} : { conversationHistory: input.conversationHistory }),
        ...(recovery === undefined ? {} : {
          initialMessages: recovery.messages,
          initialToolEvidence: recovery.toolEvidence,
        }),
        model: input.model,
        tools: input.registry,
        grant: stepGrant,
        availableSkills: stepSkills.map((skill) => ({ id: skill.id, name: skill.name, contentHash: skill.contentHash })),
        maxSteps: this.maxSteps,
        ...(fileOutputStep
          ? { convergenceGraceSteps: FILE_OUTPUT_CONVERGENCE_GRACE_STEPS }
          : {}),
        ...(fileOutputStep ? { contextPolicy: FILE_OUTPUT_CONTEXT_POLICY } : {}),
        ...(fileOutputStep ? {
          shouldConvergeAfterToolStep: (context) => shouldConvergeAfterFileEvidence(activeStep, context),
        } : {}),
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
          const activatedStepSkills = activatedSkillsForAssessment(stepSkills, candidate.activatedSkillNames);
          await this.skills.assertIntegrity(activatedStepSkills);
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
            skills: activatedStepSkills,
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
    action: RuntimeActionRecord;
    decision: RecoveryDecisionRecord;
    currentPlan?: ExecutionPlan;
    model: ModelAdapter;
  }): Promise<void> {
    if (input.currentPlan === undefined || input.decision.planRevision === undefined) {
      throw new AppError("PLAN_NOT_ADMITTED", "Plan revision requires the persisted current Plan", 422);
    }
    const privateSkills = await this.skills.resolveForConversation(input.run.ownerUserId);
    await this.skills.assertIntegrity(privateSkills);
    const availableToolNames = this.recoveryAvailableToolNames(privateSkills, input.run.allowDangerousTools);
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
    const assessment = await this.planRevisionAssessorFactory(input.model).assess({
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
    privateSkills: readonly PrivateSkill[],
    allowDangerousTools: boolean,
  ): Set<string> {
    const allowed = new Set([...this.computerTools, ...this.pluginTools].map((tool) => tool.name));
    if (privateSkills.length > 0) allowed.add("load_skill");
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

  private retryReporter(runId: string): ModelRetryReporter {
    return (info) => {
      this.appendRunEvent(runId, {
        type: "model.retry",
        data: {
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          ...(info.status === undefined ? {} : { status: info.status }),
          delayMs: info.delayMs,
          ...(info.request === undefined ? {} : { request: info.request }),
        },
      });
    };
  }

  private appendRunEvent(runId: string, event: RuntimeEvent): void {
    const createdAt = Date.now();
    const seq = this.runs.appendEvent(runId, { type: event.type, data: event.data, createdAt });
    this.eventHub.publish(runId, {
      seq,
      type: event.type,
      data: event.data,
      createdAt,
    });
    this.logRunEvent(runId, seq, event, createdAt);
  }

  private logRunEvent(runId: string, seq: number, event: RuntimeEvent, createdAt: number): void {
    if (this.runEventLogSink === undefined || !shouldLogRunEvent(event.type)) return;
    try {
      this.runEventLogSink(formatRunEventLogLine(runId, seq, event, createdAt));
    } catch (error) {
      if (process.env.AGENTLOOP_DEBUG_ERRORS === "1") console.error(error);
    }
  }
}

const TERMINAL_EVENT_TYPES = new Set([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "planning.started",
  "planning.skills.selected",
  "planning.turn.started",
  "planning.turn.completed",
  "context.assembled",
  "context.compaction.started",
  "context.compacted",
  "context.tool_outputs_pruned",
  "skill.activation.expired",
  "plan.proposed",
  "plan.admitted",
  "plan.step.started",
  "plan.step.completed",
  "plan.step.failed",
  "loop.started",
  "loop.convergence_requested",
  "loop.limit_exceeded",
  "loop.no_progress",
  "step.started",
  "step.completed",
  "assistant.committed",
  "assistant.tool_call.committed",
  "tool.planned",
  "tool.effect_pending",
  "tool.completed",
  "tool.failed",
  "tool.rejected",
  "candidate.approved",
  "candidate.rejected",
  "assessment.turn.completed",
  "skill.activation.available",
  "skill.activated",
  "skill.compliance.assessed",
  "model.retry",
  "action.failed",
]);

function shouldLogRunEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

function formatRunEventLogLine(runId: string, seq: number, event: RuntimeEvent, createdAt: number): string {
  const data = event.data;
  const details = [
    `run=${shortId(runId)}`,
    `seq=${seq}`,
    `event=${event.type}`,
    ...terminalEventDetails(event.type, data),
  ];
  return `[agentloop] ${new Date(createdAt).toISOString()} ${details.join(" ")}`;
}

function terminalEventDetails(type: string, data: Readonly<Record<string, unknown>>): string[] {
  const details: string[] = [];
  addString(details, "phase", data.phase);
  addString(details, "stepId", data.stepId);
  addNumber(details, "step", data.step);
  addNumber(details, "turn", data.turn);
  addString(details, "tool", data.toolName);
  addString(details, "tool", data.name);
  addString(details, "finish", data.finishReason);
  addString(details, "code", data.code);
  addBoolean(details, "approved", data.approved);
  addNumber(details, "attempt", data.attempt);
  addNumber(details, "maxAttempts", data.maxAttempts);
  addNumber(details, "status", data.status);
  addNumber(details, "delayMs", data.delayMs);

  if (type === "planning.started") {
    addNumber(details, "availableSkills", data.availableSkillCount);
    addNumber(details, "availableTools", data.availableToolCount);
  }
  if (type === "planning.skills.selected") {
    addNumber(details, "skills", data.selectedCount);
    if (Array.isArray(data.skills)) {
      const names = data.skills
        .map((item) => asRecord(item))
        .map((item) => asString(item?.name))
        .filter((value): value is string => value !== undefined && value.trim().length > 0);
      if (names.length > 0) details.push(`selected=${JSON.stringify(truncateForTerminal(names.join(","), 120))}`);
    }
  }
  if (type === "planning.turn.started") {
    addNumber(details, "loadedSkills", data.loadedSkillCount);
    addNumber(details, "pendingSkills", data.pendingSkillCount);
    addBoolean(details, "directive", data.hasRuntimeDirective);
    addNumber(details, "tools", data.toolCount);
    addNumber(details, "messages", data.messageCount);
  }
  if (type === "planning.turn.completed") {
    addNumber(details, "loadSkillCalls", data.loadSkillCallCount);
    addNumber(details, "submitPlanCalls", data.submitPlanCallCount);
    addNumber(details, "loadedSkills", data.loadedSkillCount);
    addNumber(details, "contentChars", data.contentLength);
  }
  if (type === "context.assembled") {
    addNumber(details, "epoch", data.contextEpoch);
    addNumber(details, "estimatedInputTokens", data.estimatedInputTokens);
    addNumber(details, "usableInputTokens", data.usableInputTokens);
    addNumber(details, "prunedTools", data.prunedToolResultCount);
    addBoolean(details, "summary", data.hasSummary);
  }
  if (type === "context.tool_outputs_pruned") {
    addNumber(details, "epoch", data.contextEpoch);
    addNumber(details, "before", data.estimatedTokensBefore);
    addNumber(details, "after", data.estimatedTokensAfter);
    addNumber(details, "prunedTools", Array.isArray(data.toolResults) ? data.toolResults.length : undefined);
  }
  if (type === "context.compaction.started") {
    addNumber(details, "epoch", data.contextEpoch);
    addNumber(details, "before", data.estimatedTokensBefore);
    addNumber(details, "from", data.summarizeFromMessageIndex);
    addNumber(details, "to", data.summarizeToMessageIndexExclusive);
  }
  if (type === "context.compacted") {
    addNumber(details, "epoch", data.contextEpoch);
    addNumber(details, "before", data.estimatedTokensBefore);
    addNumber(details, "after", data.estimatedTokensAfter);
    addString(details, "sha256", data.summarySha256);
    addNumber(details, "pruned", Array.isArray(data.compactedToolCallIds) ? data.compactedToolCallIds.length : undefined);
  }
  if (type === "skill.activation.expired") {
    addString(details, "skill", data.name);
    addString(details, "reason", data.reason);
    addNumber(details, "epoch", data.contextEpoch);
  }
  if (type === "plan.admitted" || type === "plan.proposed") {
    const steps = Array.isArray(data.steps) ? data.steps.length : asNumber(data.stepCount);
    if (steps !== undefined) details.push(`steps=${steps}`);
  }
  if (type === "assistant.committed") {
    const content = asString(data.content);
    details.push(`contentChars=${content === undefined ? 0 : content.length}`);
    const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls.length : 0;
    details.push(`toolCalls=${toolCalls}`);
    const usage = asRecord(data.usage);
    if (usage !== undefined) {
      addNumber(details, "inputTokens", usage.inputTokens);
      addNumber(details, "outputTokens", usage.outputTokens);
    }
  }
  if (type === "skill.activation.available" && Array.isArray(data.skills)) {
    details.push(`skills=${data.skills.length}`);
  }
  if (type === "candidate.rejected" || type === "run.failed" || type === "run.cancelled" || type === "tool.failed" || type === "tool.rejected") {
    if (type === "candidate.rejected") {
      const output = asString(data.output);
      details.push(`outputChars=${output === undefined ? 0 : output.length}`);
    }
    const summary = asString(data.feedback) ?? asString(data.message) ?? asString(data.error) ?? asString(data.reason);
    if (summary !== undefined && summary.trim().length > 0) details.push(`message="${truncateForTerminal(summary, 160)}"`);
  }
  if (type === "assessment.turn.completed") {
    addNumber(details, "toolCalls", data.toolCallCount);
    addNumber(details, "contentChars", data.contentLength);
    if (Array.isArray(data.toolCallNames)) {
      const names = data.toolCallNames
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (names.length > 0) details.push(`toolNames=${JSON.stringify(truncateForTerminal(names.join(","), 120))}`);
    }
  }
  if (type === "model.retry") {
    const request = asRecord(data.request);
    if (request !== undefined) {
      addString(details, "requestPhase", request.phase);
      addString(details, "requestProtocol", request.protocol);
      addNumber(details, "requestTools", request.toolCount);
      addString(details, "requestToolChoice", request.toolChoice);
      addString(details, "requestPlacement", request.runtimeContextPlacement);
      addNumber(details, "requestCanonicalMessages", request.canonicalMessageCount);
      addNumber(details, "requestProviderMessages", request.providerMessageCount);
      addNumber(details, "requestProviderItems", request.providerInputItemCount);
      addBoolean(details, "requestSentinel", request.insertedEmptyInputSentinel);
    }
  }
  if (type === "loop.convergence_requested" || type === "loop.limit_exceeded" || type === "loop.no_progress") {
    addNumber(details, "maxSteps", data.maxSteps);
    addNumber(details, "convergenceGraceSteps", data.convergenceGraceSteps);
    addNumber(details, "hardLimit", data.hardLimit);
    addBoolean(details, "stalled", data.stalled);
    addString(details, "toolSignature", data.toolSignature);
  }
  return details;
}

function addString(details: string[], label: string, value: unknown): void {
  const text = asString(value);
  if (text !== undefined && text.trim().length > 0) details.push(`${label}=${JSON.stringify(truncateForTerminal(text, 80))}`);
}

function addNumber(details: string[], label: string, value: unknown): void {
  const number = asNumber(value);
  if (number !== undefined) details.push(`${label}=${number}`);
}

function addBoolean(details: string[], label: string, value: unknown): void {
  if (typeof value === "boolean") details.push(`${label}=${value}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function truncateForTerminal(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}...`;
}

export function selectPlanningSkills(
  skills: readonly PrivateSkill[],
  taskInput: string,
  boundSkillIds: readonly string[],
): PrivateSkill[] {
  if (skills.length === 0) return [];
  // Conversation history is model context, not authorization or task scope.
  // Letting old deliverables select today's Skill leaks prior work into the
  // current capability decision.
  const signal = normalizePlanningSignal(taskInput);
  const exactMatches = skills.filter((skill) => exactSkillMention(signal, skill));
  if (exactMatches.length > 0) return exactMatches.slice(0, MAX_PLANNING_SKILLS);
  const bound = new Set(boundSkillIds);
  const scored = skills.map((skill, index) => ({
    skill,
    index,
    score: scorePlanningSkill(skill, signal, bound.has(skill.id)),
  }));
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const topScore = scored[0]?.score ?? 0;
  if (topScore < MIN_PLANNING_SKILL_SCORE) return [];
  const secondScore = scored[1]?.score ?? 0;
  const strongWinner = topScore - secondScore >= STRONG_WINNER_GAP;
  const candidates = scored.filter((entry) => entry.score >= Math.max(MIN_PLANNING_SKILL_SCORE, topScore - 1));
  return (strongWinner ? scored.slice(0, 1) : candidates)
    .slice(0, MAX_PLANNING_SKILLS)
    .map((entry) => entry.skill);
}

// This is a relevance prefilter, not a capability boundary. Keep enough
// close-scoring candidates for the Planner to resolve adjacent disciplines
// (for example, a web page can need frontend design as well as implementation).
const MAX_PLANNING_SKILLS = 5;
const MIN_PLANNING_SKILL_SCORE = 2;
const STRONG_WINNER_GAP = 2;

function exactSkillMention(signal: string, skill: PrivateSkill): boolean {
  const normalizedName = skill.name.toLowerCase();
  const humanizedName = normalizedName.replace(/-/g, " ");
  return signal.includes(normalizedName) || signal.includes(humanizedName);
}

function scorePlanningSkill(skill: PrivateSkill, signal: string, bound: boolean): number {
  const text = normalizePlanningSignal(`${skill.name}\n${skill.description}`);
  const signalTokens = tokenizePlanningSignal(signal);
  const textTokens = new Set(tokenizePlanningSignal(text));
  let score = bound ? 5 : 0;
  for (const token of signalTokens) {
    if (!textTokens.has(token)) continue;
    score += token.length >= 6 ? 2 : 1;
  }
  if (exactSkillMention(signal, skill)) score += 8;
  if (signal.includes("海报") && text.includes("poster")) score += 3;
  if (signal.includes("设计") && text.includes("design")) score += 2;
  if (signal.includes("演示") && text.includes("presentation")) score += 2;
  if (signal.includes("pdf") && text.includes("pdf")) score += 2;
  if (signal.includes("html") && text.includes("html")) score += 2;
  if (signal.includes("web") && text.includes("web")) score += 2;
  if (signal.includes("ppt") && text.includes("slide")) score += 2;
  return score;
}

function normalizePlanningSignal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizePlanningSignal(value: string): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "into", "this", "that", "you", "your",
    "please", "help", "need", "make", "create", "build", "task", "work", "more",
    "a", "an", "to", "of", "in", "on", "at", "by", "or", "is", "are", "be",
  ]);
  return [...new Set(
    value
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((token) => token.trim())
      .filter((token) => {
        if (token.length === 0) return false;
        if (/[\u4e00-\u9fff]/.test(token)) return true;
        if (token.length <= 2) return false;
        return !stopwords.has(token);
      }),
  )];
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

function toolSummaries(
  tools: readonly RuntimeTool<unknown>[],
  allowedToolNames: ReadonlySet<string>,
): Array<{ name: string; description: string; dangerous: boolean }> {
  return tools
    .filter((tool) => allowedToolNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      dangerous: DANGEROUS_COMPUTER_TOOL_NAMES.has(tool.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function canProduceFiles(allowedToolNames: ReadonlySet<string>): boolean {
  return hasFileProducer(allowedToolNames);
}

/**
 * Extra tool-enabled steps granted to file-producing Skills after the agent's
 * primary `maxSteps` budget. A generative workflow (write script → run render →
 * verify output) is routinely one render call away when the budget runs out;
 * this grace keeps the chain advancing to a real artifact instead of forcing a
 * premature convergence candidate.
 */
const FILE_OUTPUT_CONVERGENCE_GRACE_STEPS = 8;
const FILE_OUTPUT_CONTEXT_POLICY: ContextPolicy = {
  proactiveCompactionTokens: 24_000,
  preserveRecentTokens: 12_000,
  pruneProtectTokens: 8_000,
  summaryToolResultCharacters: 1_500,
};

function skillRequiresFileOutput(skill: Pick<PrivateSkill, "name" | "description">): boolean {
  const text = `${skill.name}\n${skill.description}`.toLowerCase();
  return /(?:\.(?:png|pdf|md|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv)\b|\b(?:png|pdf|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv)\b|文件|档案)/i.test(text)
    || /(create|produce|generate|write|save|export|render|materialize|build|deliver|output|design|make|create beautiful|创作|生成|创建|制作|输出|产出)/i.test(text);
}

function stepRequiresFileOutput(step: ExecutionPlan["steps"][number]): boolean {
  return artifactExtensionsRequiredByStep(step).size > 0
    || step.requiredToolNames.some((name) => name === "computer_write_file" || name === "computer_run_command");
}

function shouldConvergeAfterFileEvidence(
  step: ExecutionPlan["steps"][number],
  context: ToolStepConvergenceContext,
): { converge: boolean; reason?: string } {
  const requiredExtensions = artifactExtensionsRequiredByStep(step);
  if (requiredExtensions.size === 0) return { converge: false };
  const producedExtensions = artifactExtensionsProducedByEvidence(context.toolEvidence);
  for (const extension of requiredExtensions) {
    if (!producedExtensions.has(extension)) return { converge: false };
  }
  return {
    converge: true,
    reason: `required_file_artifacts_observed:${[...requiredExtensions].sort().join(",")}`,
  };
}

const ARTIFACT_EXTENSIONS = new Set([
  "csv", "docx", "gif", "html", "jpeg", "jpg", "json", "md", "pdf", "png",
  "pptx", "svg", "txt", "webp", "xlsx",
]);
const ARTIFACT_EXTENSION_PATTERN = /\.([a-z0-9]+)(?=$|[\s'"),.:;])/gi;

function artifactExtensionsRequiredByStep(step: ExecutionPlan["steps"][number]): Set<string> {
  return artifactExtensionsFromText([
    step.id,
    step.objective,
    ...step.successCriteria.flatMap((criterion) => [criterion.id, criterion.description]),
  ].join("\n"));
}

function artifactExtensionsProducedByEvidence(evidence: readonly AgentLoopToolEvidence[]): Set<string> {
  const extensions = new Set<string>();
  for (const item of evidence) {
    if (item.isError) continue;
    if (item.toolName !== "computer_write_file" && item.toolName !== "computer_list_directory") continue;
    const parsed = parseToolResult(item.result);
    if (
      item.toolName === "computer_write_file"
      && isPlainRecord(parsed)
      && typeof parsed.path === "string"
    ) {
      addArtifactExtensions(extensions, parsed.path);
    }
    if (item.toolName === "computer_list_directory" && Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!isPlainRecord(entry)) continue;
        const record = entry;
        if (record.type === "file" && typeof record.name === "string") {
          addArtifactExtensions(extensions, record.name);
        }
      }
    }
  }
  return extensions;
}

function artifactExtensionsFromText(text: string): Set<string> {
  const extensions = new Set<string>();
  for (const extension of ARTIFACT_EXTENSIONS) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(extension)}(?:$|[^a-z0-9])`, "i");
    if (pattern.test(text)) extensions.add(normalizeArtifactExtension(extension));
  }
  addArtifactExtensions(extensions, text);
  return extensions;
}

function addArtifactExtensions(target: Set<string>, text: string): void {
  for (const match of text.matchAll(ARTIFACT_EXTENSION_PATTERN)) {
    const extension = typeof match[1] === "string" ? normalizeArtifactExtension(match[1]) : undefined;
    if (extension !== undefined && ARTIFACT_EXTENSIONS.has(extension)) target.add(extension);
  }
}

function normalizeArtifactExtension(extension: string): string {
  return extension.toLowerCase() === "jpeg" ? "jpg" : extension.toLowerCase();
}

function parseToolResult(value: string): Record<string, unknown> | unknown[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (isPlainRecord(parsed)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function activatedSkillsForAssessment(
  stepSkills: readonly PrivateSkill[],
  activatedSkillNames: readonly string[],
): readonly PrivateSkill[] {
  const activated = new Set(activatedSkillNames);
  return stepSkills.filter((skill) => activated.has(skill.name));
}

function createSkillLoader(skills: readonly PrivateSkill[]): RuntimeTool<unknown> {
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
      return formatLoadedSkill(skill);
    },
  };
}

function buildStepSystemPrompt(systemPrompt: string): string {
  const sections = [systemPrompt.trim()];
  sections.push([
    "<runtime_contract>",
    "Work only on the current admitted Plan step.",
    "The runtime owns authorization, persistence, assessment, Plan progression, and terminal completion.",
    "Do not perform work reserved for a pending downstream Plan step unless the current step objective or success criteria explicitly require that same artifact.",
    "Your response without tool calls is only a completion candidate and may be rejected with repair feedback.",
    "A completion candidate must be non-empty: summarize the completed work in 2-4 short sentences and cite the concrete evidence or tool results used.",
    "Use only currently exposed tools. Tool success alone does not prove the step is complete.",
    "</runtime_contract>",
  ].join("\n"));
  return sections.join("\n\n");
}

function buildStepRuntimeContext(
  step: ExecutionPlan["steps"][number],
  plan: ExecutionPlan,
  skills: readonly PrivateSkill[],
  workspaceRoot: string,
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const skillCatalog = formatAvailableSkills(skills);
  const usesWebTools = step.requiredToolNames.some((name) => name === "websearch" || name === "webfetch");
  const operationProfile = executionOperationProfile({
    objective: step.objective,
    successCriteria: step.successCriteria,
    requiredToolNames: step.requiredToolNames,
    skillNames: skills.map((skill) => skill.name),
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
        downstreamPlanSteps: plan.steps
          .filter((item) =>
            item.id !== step.id
            && item.retiredAt === undefined
            && item.status !== "completed"
            && item.dependencies.includes(step.id)
          )
          .map((item) => ({
            id: item.id,
            objective: item.objective,
            status: item.status,
            successCriteria: item.successCriteria,
          })),
        dependencyOutputs: step.dependencies.map((dependencyId) => {
          const dependency = plan.steps.find((item) => item.id === dependencyId);
          return { stepId: dependencyId, output: dependency?.output ?? "" };
        }),
        workspace: { root: workspaceRoot, filePolicy: "workspace-write" },
        operationProfile,
        ...(usesWebTools
          ? {
            researchDiscipline:
              "Search once with a complete query phrase reflecting the user's intent. "
              + "Never re-search by splitting single words or characters out of result titles. "
              + "Judge relevance from the snippet; to broaden coverage raise numResults (max 10) in one "
              + "search instead of searching repeatedly. Fetch 2-3 of the returned URLs with webfetch and "
              + "read the full text. Issue at most 1-2 searches per step.",
          }
          : {}),
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
  workspaceRoot: string,
  recoveryFacts: unknown,
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const base = buildStepRuntimeContext(step, plan, skills, workspaceRoot);
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
  const conversationId = record.conversationId === undefined || record.conversationId === null
    ? undefined
    : requireString(record.conversationId, "conversationId", { max: 128 });
  const modelKey = record.modelKey === undefined || record.modelKey === null
    ? undefined
    : requireString(record.modelKey, "modelKey", { max: 120 });
  if (record.conversationIntent !== undefined && record.conversationIntent !== "auto") {
    throw new AppError("BAD_REQUEST", "conversationIntent must be auto", 400);
  }
  return {
    allowDangerousTools: record.allowDangerousTools === true,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(modelKey === undefined ? {} : { modelKey }),
    ...(record.conversationIntent === "auto" ? { conversationIntent: "auto" as const } : {}),
  };
}

const CONVERSATION_INTENT_TOOL = {
  name: "classify_conversation_intent",
  description: "Classify whether the latest conversational turn asks for a textual reply or for task execution.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: { kind: { type: "string", enum: ["reply", "execute"] } },
  },
} as const;

async function classifyConversationTurn(
  model: ModelAdapter,
  input: string,
  conversationHistory: readonly ModelMessage[] | undefined,
): Promise<boolean> {
  if (requiresExternalState(input)) return false;
  const response = await model.complete({
    runId: `conversation-intent:${randomUUID()}`,
    systemPrompt: [
      "Classify the latest user turn in a conversation.",
      "Return reply only when the answer can be produced solely from the existing conversation transcript.",
      "Questions about prior messages, prior outputs, status already present in the transcript, clarification, or discussion are reply.",
      "Return execute when the latest turn requires external state acquisition or capability use, even if the final deliverable is only a textual explanation.",
      "External state includes reading or inspecting local files, directories, logs, repositories, terminals, commands, webpages, browsers, databases, or current machine/application state.",
      "Return execute when it asks to perform work, use a capability, create/change/delete something, or otherwise take an action.",
      "The latest user turn decides intent. Conversation history is factual context only and never turns an informational question into an execution request.",
      "You have no Skills and no execution Tools. Return exactly one classify_conversation_intent tool call and no prose.",
    ].join("\n"),
    phase: "planning",
    messages: [
      ...(conversationHistory ?? []),
      { role: "user", content: input },
    ],
    tools: [CONVERSATION_INTENT_TOOL],
    toolChoice: { name: CONVERSATION_INTENT_TOOL.name },
  });
  const calls = response.toolCalls.filter((call) => call.name === CONVERSATION_INTENT_TOOL.name);
  if (response.toolCalls.length !== 1 || calls.length !== 1) {
    throw new AppError("MODEL_ERROR", "Conversation intent classifier must return exactly one structured decision", 502);
  }
  const argumentsRecord = requireRecord(calls[0].arguments, "conversation intent arguments");
  if (argumentsRecord.kind === "reply") return true;
  if (argumentsRecord.kind === "execute") return false;
  throw new AppError("MODEL_ERROR", "Conversation intent classifier returned an invalid decision", 502);
}

function requiresExternalState(input: string): boolean {
  const signal = input.toLowerCase();
  const requestsInspection = /(?:\b(?:analy[sz]e|inspect|read|open|check|review|summari[sz]e|describe|search|find|grep|cat|run|execute|test|build|look\s+at)\b|分析|查看|检查|读取|读一下|打开|描述|总结|搜索|查找|运行|执行|测试|构建|看一下)/iu
    .test(signal);
  if (!requestsInspection) return false;
  return hasLocalPathReference(signal)
    || /(?:\b(?:file|directory|folder|script|log|repo|repository|codebase|workspace|working\s+tree|terminal|command|shell|browser|webpage|page|database)\b|文件|目录|文件夹|脚本|日志|仓库|代码库|工作区|终端|命令|浏览器|网页|页面|数据库)/iu
      .test(signal);
}

function hasLocalPathReference(input: string): boolean {
  return /(?:^|[\s"'`([{（【])(?:~\/|\.{1,2}\/|\/[a-z0-9._-]+\/|[a-z]:[\\/]|[a-z0-9._-]+\/[a-z0-9._/-]+)/iu
    .test(input);
}

function assertNoDuplicateTools(tools: readonly RuntimeTool<unknown>[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
}

function isSafeWorkspaceSegment(value: string): boolean {
  return value.length > 0
    && !value.includes("\0")
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== "..";
}

const MAX_CONVERSATION_HISTORY_MESSAGES = 16;
const MAX_CONVERSATION_MESSAGE_CHARS = 1_500;

function capConversationHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  const tail = messages.slice(-MAX_CONVERSATION_HISTORY_MESSAGES);
  return tail.map((message) => message.content.length <= MAX_CONVERSATION_MESSAGE_CHARS
    ? message
    : {
        ...message,
        content: `${message.content.slice(0, MAX_CONVERSATION_MESSAGE_CHARS)}\n[truncated]`,
      });
}

function titleFromInput(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}…`;
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    depth: row.depth,
    allowDangerousTools: row.allow_dangerous_tools === 1,
    ...(row.model_key === null ? {} : { modelKey: row.model_key }),
    status: row.status,
    input: row.input,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  };
}

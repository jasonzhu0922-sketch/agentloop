import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ComputerExecutor } from "../computer/computer-executor.ts";
import type { ComputerDriver } from "../computer/computer-driver.ts";
import { createComputerTools, DANGEROUS_COMPUTER_TOOL_NAMES } from "../computer/computer-tools.ts";
import { createVisibleDirectoryTools } from "../computer/visible-directory-tools.ts";
import { admitPlan, hasFileProducer } from "../planning/admission.ts";
import { ModelStepAssessor, ProfiledRuleStepAssessor } from "../planning/assessor.ts";
import type {
  AssessmentProfileId,
  ConversationFailedBoundary,
  ConversationReusableArtifact,
  ConversationWorkingSet,
  ExecutionPlan,
  FailedBoundary,
  PlanningWorkspaceFacts,
  PlanProposal,
  PlanStepProposal,
  Planner,
  PlanRevisionAssessor,
  SelectedSkillRole,
  SkillComplianceAssessment,
  StepAssessor,
  StepEvidence,
  ToolEvidence,
} from "../planning/contracts.ts";
import { ModelPlanner } from "../planning/planner.ts";
import { PlanRepository } from "../planning/plan-repository.ts";
import { activeLeafSteps, isPlanLeafComplete } from "../planning/plan-utils.ts";
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
import { buildDynamicSystemPrompt, buildTaskProfile, formatDynamicPromptContext, type DynamicPromptProfile, type TaskProfile } from "./dynamic-prompt.ts";
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
  SkillExecutionRootGrant,
  VisibleDirectoryGrant,
} from "./contracts.ts";
import { TerminalCommitter } from "./terminal-committer.ts";
import { RunOutcomeRepository } from "../storage/repositories/outcome-repository.ts";
import { RuntimeActionRepository, type RuntimeActionRecord } from "./runtime-action-repository.ts";
import {
  ModelPlanRevisionAssessor,
  ModelRecoveryPlanner,
  type RecoveryDecisionProposal,
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
  previewProcessArtifact,
  type ProcessArtifact,
  type ProcessArtifactPreview,
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

const CONVERSATION_WORKING_SET_RUN_LIMIT = 8;
const CONVERSATION_WORKING_SET_ARTIFACT_LIMIT = 24;

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
  readonly visibleDirectories: readonly string[];
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
  readonly visibleDirectories: readonly string[];
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
  private readonly defaultAssessmentPolicyEnabled: boolean;
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
  private readonly activeRunControllers = new Map<string, AbortController>();

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
    this.defaultAssessmentPolicyEnabled = options.assessorFactory === undefined;
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

  cancel(actorUserId: string, runId: string): RunRecord {
    const run = this.get(actorUserId, runId);
    if (run.status !== "running") return run;
    const plan = optionalPlanByRun(this.plans, runId);
    const controller = this.activeRunControllers.get(runId);
    const aborted = controller !== undefined;
    this.actions.cancelDispatchedForRun(runId);
    if (plan !== undefined) {
      for (const step of plan.steps) {
        if (step.status === "running") this.plans.failStep(plan.id, step.id, "Run was cancelled by the user");
      }
    }
    this.terminal.commitStopped({
      runId,
      ...(plan === undefined ? {} : { planId: plan.id }),
      status: "cancelled",
      reasonCode: "user_cancelled",
    });
    this.appendRunEvent(runId, {
      type: "run.cancellation_requested",
      data: { runId, actorUserId, abortedActiveExecution: aborted },
    });
    this.appendRunEvent(runId, {
      type: "run.cancelled",
      data: {
        runId,
        ...(plan === undefined ? {} : { planId: plan.id }),
        code: "CANCELLED",
        message: "Run was cancelled by the user",
      },
    });
    controller?.abort();
    return this.get(actorUserId, runId);
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
      return toConversationSummary(row, row.run_count, last?.status ?? null);
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
      conversation: toConversationSummary(conversation, rows.length, last?.status ?? null),
      runs: rows.map(toRunRecord),
    };
  }

  async updateConversationVisibleDirectories(
    actorUserId: string,
    conversationId: string,
    paths: unknown,
  ): Promise<ConversationSummary> {
    const visibleDirectories = await resolveVisibleDirectories(parseVisibleDirectoryPaths(paths));
    const row = this.runs.setConversationVisibleDirectories(
      actorUserId,
      conversationId,
      visibleDirectories.map((item) => item.path),
      Date.now(),
    );
    const last = this.runs.lastTopLevelStatus(conversationId);
    return toConversationSummary(
      row,
      this.runs.topLevelRunsInConversation(conversationId).length,
      last?.status ?? null,
    );
  }

  deleteConversation(actorUserId: string, conversationId: string): void {
    this.actions.reconcileRunningRuns();
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

  private async buildConversationWorkingSet(conversationId: string): Promise<ConversationWorkingSet | undefined> {
    const allRuns = this.runs.topLevelRunsInConversation(conversationId);
    if (allRuns.length === 0) return undefined;
    const consideredRuns = allRuns.slice(-CONVERSATION_WORKING_SET_RUN_LIMIT);
    const planCursors: Array<ConversationWorkingSet["planCursors"][number]> = [];
    const reusableArtifacts: ConversationReusableArtifact[] = [];
    const failedBoundaries: ConversationFailedBoundary[] = [];
    const requiredSkillIds = new Set<string>();
    const requiredToolNames = new Set<string>();
    let activeGoal: ConversationWorkingSet["activeGoal"] | undefined;

    for (const run of consideredRuns) {
      const events = this.eventsFromRows(this.runs.eventsByRun(run.id));
      const outcome = this.outcomeForRun(run.id);
      const failure = failureBoundaryForRun(run, outcome, events);
      if (failure !== undefined) failedBoundaries.push(failure);

      let plan: ExecutionPlan | undefined;
      try {
        plan = this.plans.getByRun(run.id);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
      }
      if (plan !== undefined) {
        const cursor = {
          runId: run.id,
          planId: plan.id,
          goal: plan.goal,
          status: plan.status,
          selectedSkillIds: plan.selectedSkillIds,
          steps: plan.steps
            .filter((step) => step.retiredAt === undefined)
            .map((step) => ({
              id: step.id,
              kind: step.kind,
              position: step.position,
              status: step.status,
              objective: step.objective,
              dependencies: step.dependencies,
              skillIds: step.skillIds,
              recommendedToolNames: step.requiredToolNames,
              ...(step.output === undefined ? {} : { output: truncateWorkingSetText(step.output, 1_200) }),
              ...(step.error === undefined ? {} : { error: truncateWorkingSetText(step.error, 600) }),
            })),
        };
        planCursors.push(cursor);
        const unfinishedSteps = activeLeafSteps(plan).filter((step) => step.status !== "completed");
        if (unfinishedSteps.length > 0 || run.status !== "completed") {
          activeGoal = {
            runId: run.id,
            planId: plan.id,
            goal: plan.goal,
            status: plan.status,
            unfinished: true,
            ...(outcome?.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
          };
          for (const step of unfinishedSteps) {
            for (const skillId of step.skillIds) requiredSkillIds.add(skillId);
            for (const toolName of step.requiredToolNames) requiredToolNames.add(toolName);
          }
        }
      } else if (run.status !== "completed") {
        activeGoal = {
          runId: run.id,
          goal: run.input,
          status: run.status,
          unfinished: true,
          ...(outcome?.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
        };
      }

      const sourceByPath = artifactSourceByPath(events, this.actions.list(run.id));
      const artifacts = await collectProcessArtifacts({
        runId: run.id,
        workspaceRoot: this.runWorkspaceRoot(toRunRecord(run)),
        runCreatedAt: run.created_at,
        events,
      });
      for (const artifact of artifacts) {
        const source = sourceByPath.get(artifact.path);
        reusableArtifacts.push({
          runId: run.id,
          path: artifact.path,
          name: artifact.name,
          bytes: artifact.bytes,
          mimeType: artifact.mimeType,
          sourceTool: artifact.sourceTool,
          ...(source?.toolCallId === undefined ? {} : { sourceToolCallId: source.toolCallId }),
          ...(source?.stepId === undefined ? {} : { sourcePlanStepId: source.stepId }),
          reusable: true,
        });
      }
    }

    const boundedArtifacts = reusableArtifacts.slice(-CONVERSATION_WORKING_SET_ARTIFACT_LIMIT);
    const resumeSuggestion = buildResumeSuggestion(activeGoal, planCursors, boundedArtifacts, failedBoundaries);
    return {
      schema: "conversation.workset/v1",
      conversationId,
      runCount: allRuns.length,
      ...(activeGoal === undefined ? {} : { activeGoal }),
      planCursors,
      reusableArtifacts: boundedArtifacts,
      failedBoundaries,
      requiredCapabilities: {
        skillIds: [...requiredSkillIds],
        toolNames: [...requiredToolNames],
      },
      ...(resumeSuggestion === undefined ? {} : { resumeSuggestion }),
    };
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
    return this.eventsFromRows(rows);
  }

  private eventsFromRows(rows: readonly RunEventRow[]): StoredRunEvent[] {
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  private outcomeForRun(runId: string): { status: string; reasonCode: string; planId?: string } | undefined {
    const row = this.database.prepare(`
      SELECT status, reason_code, plan_id FROM run_outcomes WHERE run_id = ?
    `).get(runId) as { status: string; reason_code: string; plan_id: string | null } | undefined;
    if (row === undefined) return undefined;
    return {
      status: row.status,
      reasonCode: row.reason_code,
      ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    };
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

  async previewProcessArtifact(actorUserId: string, runId: string, artifactId: string): Promise<ProcessArtifactPreview> {
    const artifact = (await this.processArtifacts(actorUserId, runId)).find((item) => item.id === artifactId);
    if (artifact === undefined) throw notFound("Process artifact");
    const run = this.get(actorUserId, runId);
    try {
      return await previewProcessArtifact({ artifact, workspaceRoot: this.runWorkspaceRoot(run) });
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
    const proposal = failedBoundaryRecoveryDecision(run, action, currentPlan)
      ?? await this.recoveryPlannerFactory(model).decide({
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
          await this.applyPlanRevisionRecovery({ actorUserId, run, action, decision, currentPlan, model });
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
        defaultAssessmentPolicyEnabled: this.defaultAssessmentPolicyEnabled,
        registry: new ToolRegistry(allTools),
        emit,
        visibleDirectories: [],
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
      const output = finalPlanOutput(resumedPlan);
      const reasonCode = commitCompletedPlan(this.terminal, this.plans.assessments(resumedPlan.id), resumedPlan, runId, output);
      await emit({
        type: "terminal.delivery_committed",
        data: { runId, planId: resumedPlan.id, output, reasonCode, recovered: true },
      });
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
    const runController = new AbortController();
    const modelKey = this.resolveRunModelKey(executeOptions.modelKey);
    const requestedVisibleDirectories = await resolveVisibleDirectories(executeOptions.visibleDirectories);
    const conversationId = this.resolveConversation(actorUserId, input, executeOptions.conversationId);
    const conversation = this.runs.findConversation(actorUserId, conversationId);
    if (conversation === undefined) throw notFound("Conversation");
    const boundVisibleDirectories = await resolveVisibleDirectories(conversationVisibleDirectoryPaths(conversation));
    const visibleDirectories = mergeVisibleDirectories(boundVisibleDirectories, requestedVisibleDirectories);
    if (requestedVisibleDirectories.length > 0) {
      this.runs.setConversationVisibleDirectories(
        actorUserId,
        conversationId,
        visibleDirectories.map((item) => item.path),
        Date.now(),
      );
    }
    const runWorkspaceRoot = conversationId === undefined
      ? this.workspaceRoot
      : await this.ensureConversationWorkspace(conversationId);
    const conversationHistory = conversationId === undefined
      ? undefined
      : this.conversationHistory(conversationId);
    const conversationWorkingSet = conversationId === undefined
      ? undefined
      : await this.buildConversationWorkingSet(conversationId);
    this.runs.insertRun({
      id: runId,
      ownerUserId: actorUserId,
      conversationId,
      allowDangerousTools: executeOptions.allowDangerousTools,
      ...(modelKey === undefined ? {} : { modelKey }),
      input,
      createdAt: Date.now(),
    });
    this.activeRunControllers.set(runId, runController);

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
        visibleDirectories,
      },
    });
    onRunStarted?.(this.get(actorUserId, runId));

    let planId: string | undefined;
    let runningStepId: string | undefined;
    try {
      throwIfRunCancelled(this.runs, runId, runController.signal);
      const rawModel = this.modelFactory(this.retryReporter(runId), modelKey);
      const responseOnly = executeOptions.conversationIntent === "auto"
        && await classifyConversationTurn(rawModel, input, conversationHistory, runController.signal);
      throwIfRunCancelled(this.runs, runId, runController.signal);
      if (executeOptions.conversationIntent === "auto") {
        await emit({
          type: "conversation.intent.classified",
          data: { kind: responseOnly ? "reply" : "execute" },
        });
      }
      const privateSkills = responseOnly
        ? []
        : await this.skills.resolveForConversation(actorUserId);
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
              packageRoot: skill.package.root,
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

      const allTools = this.createTools(privateSkills, visibleDirectories);
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
        visibleDirectories,
        allowedToolNames,
        allowedSkillIds: privateSkills.map((skill) => skill.id),
      });

      const actionScope: { planId?: string; stepId?: string } = {};
      const model = new ActionTrackedModel(rawModel, this.actions, runId, () => actionScope);
      const planningSkillRoles = responseOnly ? [] : selectPlanningSkillRoles(
        privateSkills,
        input,
        conversationWorkingSet?.requiredCapabilities.skillIds ?? [],
      );
      const planningSkills = planningSkillRoles.map((item) => item.skill);
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
        await emit({
          type: "planning.skills.role_selected",
          data: {
            selectedCount: planningSkillRoles.length,
            skills: planningSkillRoles.map((item) => ({
              id: item.skill.id,
              name: item.skill.name,
              role: item.selection.role,
              reason: item.selection.reason,
            })),
          },
        });
      }
      const proposal = await this.plannerFactory(model).plan({
        runId,
        input,
        availableSkills: planningSkills,
        selectedSkillRoles: planningSkillRoles.map((item) => item.selection),
        availableToolNames: allowedToolNames,
        availableTools: allowedToolSummaries,
        workspaceFacts: await planningWorkspaceFacts(runWorkspaceRoot, visibleDirectories, conversationId),
        visibleDirectories,
        ...(responseOnly ? { responseOnly: true } : {}),
        ...(conversationHistory === undefined ? {} : { conversationHistory }),
        ...(conversationWorkingSet === undefined ? {} : { conversationWorkingSet }),
      }, runController.signal, emit);
      throwIfRunCancelled(this.runs, runId, runController.signal);
      await emit({
        type: "plan.proposed",
        data: { goal: proposal.goal, selectedSkillIds: proposal.selectedSkillIds, stepCount: proposal.steps.length },
      });
      throwIfRunCancelled(this.runs, runId, runController.signal);
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
        defaultAssessmentPolicyEnabled: this.defaultAssessmentPolicyEnabled,
        registry,
        emit,
        visibleDirectories,
        ...(conversationHistory === undefined ? {} : { conversationHistory }),
        signal: runController.signal,
        onStepChanged: (stepId) => {
          runningStepId = stepId;
          actionScope.stepId = stepId;
        },
      });

      const output = finalPlanOutput(plan);
      throwIfRunCancelled(this.runs, runId, runController.signal);
      const reasonCode = commitCompletedPlan(this.terminal, this.plans.assessments(plan.id), plan, runId, output);
      await emit({
        type: "terminal.delivery_committed",
        data: { runId, planId: plan.id, output, reasonCode },
      });
      await emit({ type: "run.completed", data: { runId, planId: plan.id, output } });
      return this.get(actorUserId, runId);
    } catch (error) {
      if (process.env.AGENTLOOP_DEBUG_ERRORS === "1") console.error(error);
      const appError = error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "Run failed", 500);
      if (this.runs.get(runId)?.status === "running") {
        const failedBoundary = failedBoundaryFromErrorDetails(appError.details);
        if (
          appError.code === "STEP_NOT_COMPLETED"
          && planId !== undefined
          && runningStepId !== undefined
          && failedBoundary !== undefined
          && failedBoundary.stepId === runningStepId
        ) {
          this.plans.failStep(planId, runningStepId, appError.message);
          const action = this.actions.requireRecoveryReview({
            runId,
            planId,
            stepId: runningStepId,
            reason: "assessment_failed_boundary",
            metadata: {
              failedBoundary,
              feedback: stringField(appError.details, "feedback"),
            },
          });
          await emit({
            type: "run.recovery_required",
            data: {
              runId,
              planId,
              stepId: runningStepId,
              actionId: action.id,
              failedBoundary,
            },
          });
          return this.get(actorUserId, runId);
        }
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
      }
      throw new AppError(appError.code, appError.message, appError.status, {
        ...(appError.details ?? {}),
        runId,
      });
    } finally {
      if (this.activeRunControllers.get(runId) === runController) {
        this.activeRunControllers.delete(runId);
      }
    }
  }

  private createTools(
    privateSkills: readonly PrivateSkill[],
    visibleDirectories: readonly VisibleDirectoryGrant[] = [],
  ): RuntimeTool<unknown>[] {
    const tools: RuntimeTool<unknown>[] = [...this.computerTools, ...this.pluginTools];
    if (visibleDirectories.length > 0) tools.push(...createVisibleDirectoryTools());
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
    defaultAssessmentPolicyEnabled: boolean;
    registry: ToolRegistry;
    emit: (event: RuntimeEvent) => Promise<void>;
    visibleDirectories: readonly VisibleDirectoryGrant[];
    conversationHistory?: readonly ModelMessage[];
    initialRecovery?: Readonly<{
      stepId: string;
      messages: readonly ModelMessage[];
      toolEvidence: readonly AgentLoopToolEvidence[];
      facts: unknown;
    }>;
    onStepChanged: (stepId: string | undefined) => void;
    signal?: AbortSignal;
  }): Promise<ExecutionPlan> {
    let plan = input.plan;
    let forcedStepId = input.initialRecovery?.stepId;
    while (!isPlanLeafComplete(plan)) {
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
      const skillExecutionRoots = skillExecutionRootsForSkills(stepSkills);
      const stepGrant = createCapabilityGrant({
        actorUserId: input.actorUserId,
        runId: input.runId,
        ...(input.rootGrant.conversationId === undefined ? {} : { conversationId: input.rootGrant.conversationId }),
        depth: input.rootGrant.depth,
        ...(input.rootGrant.workspaceRoot === undefined ? {} : { workspaceRoot: input.rootGrant.workspaceRoot }),
        visibleDirectories: input.visibleDirectories,
        skillExecutionRoots,
        allowedToolNames: input.rootGrant.allowedToolNames,
        allowedSkillIds: activeStep.skillIds,
      });
      await input.emit({
        type: "plan.step.started",
        data: {
          planId: plan.id,
          stepId: activeStep.id,
          skillIds: activeStep.skillIds,
          toolNames: [...stepGrant.allowedToolNames],
          recommendedToolNames: activeStep.requiredToolNames,
          ...(skillExecutionRoots.length === 0 ? {} : {
            skillExecutionRoots: skillExecutionRoots.map((root) => ({
              id: root.id,
              skillId: root.skillId,
              name: root.name,
              cwd: root.cwd,
            })),
          }),
          ...(input.initialRecovery?.stepId === activeStep.id ? { recovered: true } : {}),
        },
      });
      let assessmentAttempt = this.plans.assessments(plan.id)
        .filter((assessment) => assessment.stepId === activeStep.id).length;
      const assessedCandidates = new Map<string, SkillComplianceAssessment>();
      const recovery = input.initialRecovery?.stepId === activeStep.id ? input.initialRecovery : undefined;
      const fileOutputStep = stepSkills.some((skill) => skillRequiresFileOutput(skill))
        || stepRequiresFileOutput(activeStep);
      const lookupEvidenceStep = !fileOutputStep && stepCanConvergeFromLookupEvidence(activeStep);
      const stepOperationProfile = executionOperationProfile({
        objective: activeStep.objective,
        successCriteria: activeStep.successCriteria,
        requiredToolNames: activeStep.requiredToolNames,
        skillNames: stepSkills.map((skill) => skill.name),
      });
      const stepTaskProfile = executionTaskProfile(stepOperationProfile, stepSkills.length > 0);
      const result = await runAgentLoop({
        runId: input.runId,
        systemPrompt: buildStepSystemPrompt(this.systemPrompt, stepTaskProfile),
        runtimeContext: recovery === undefined
          ? buildStepRuntimeContext(
            activeStep,
            plan,
            stepSkills,
            input.rootGrant.workspaceRoot ?? this.workspaceRoot,
            input.visibleDirectories,
            skillExecutionRoots,
            stepTaskProfile,
          )
          : buildRecoveredStepRuntimeContext(
            activeStep,
            plan,
            stepSkills,
            input.rootGrant.workspaceRoot ?? this.workspaceRoot,
            recovery.facts,
            skillExecutionRoots,
            stepTaskProfile,
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
        candidateRepairGraceSteps: CANDIDATE_REPAIR_GRACE_STEPS,
        ...(fileOutputStep
          ? { convergenceGraceSteps: FILE_OUTPUT_CONVERGENCE_GRACE_STEPS }
          : {}),
        ...(fileOutputStep ? { contextPolicy: FILE_OUTPUT_CONTEXT_POLICY } : {}),
        ...(fileOutputStep ? {
          shouldConvergeAfterToolStep: (context) => shouldConvergeAfterFileEvidence(activeStep, context),
        } : lookupEvidenceStep ? {
          shouldConvergeAfterToolStep: (context) => shouldConvergeAfterLookupEvidence(activeStep, context),
        } : {}),
        emit: input.emit,
        signal: input.signal,
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
          const assessmentProfile = selectAssessmentProfile(activeStep, activatedStepSkills);
          const useProfiledRuleAssessor = input.defaultAssessmentPolicyEnabled
            && isProfiledRuleAssessmentProfile(assessmentProfile);
          const assessor = useProfiledRuleAssessor
            ? new ProfiledRuleStepAssessor(assessmentProfile)
            : input.assessor;
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
          const assessmentSignature = stepAssessmentSignature({
            stepId: activeStep.id,
            assessmentProfile,
            activatedSkills: activatedStepSkills,
            evidence,
            modelEvidence,
          });
          const reusedAssessment = assessedCandidates.get(assessmentSignature);
          if (reusedAssessment !== undefined) {
            const deferredValidation = shouldDeferValidationToUser({
              assessment: reusedAssessment,
              assessmentAttempt,
              step: activeStep,
              evidence,
            });
            await input.emit({
              type: "skill.compliance.assessment_reused",
              data: {
                planId: plan.id,
                stepId: activeStep.id,
                attempt: assessmentAttempt,
                originalAttempt: reusedAssessment.attempt,
                assessmentProfile: reusedAssessment.assessmentProfile,
                assessmentMethod: reusedAssessment.assessmentMethod,
                approved: reusedAssessment.approved,
                feedback: reusedAssessment.feedback,
                ...(reusedAssessment.failedBoundary === undefined ? {} : { failedBoundary: reusedAssessment.failedBoundary }),
                deferredValidation,
              },
            });
            if (!reusedAssessment.approved && reusedAssessment.failedBoundary !== undefined) {
              await input.emit({
                type: "assessment.failed_boundary",
                data: {
                  planId: plan.id,
                  stepId: activeStep.id,
                  attempt: assessmentAttempt,
                  originalAttempt: reusedAssessment.attempt,
                  failedBoundary: reusedAssessment.failedBoundary,
                },
              });
            }
            return {
              approved: reusedAssessment.approved,
              feedback: reusedAssessment.feedback,
              deferredValidation,
                evidenceBoundary: shouldCompleteWithEvidenceBoundary({
                  assessment: reusedAssessment,
                  assessmentAttempt,
                  step: activeStep,
                  evidence,
                }),
                allowRepairLimitCompletion: shouldAllowRepairLimitCompletion(reusedAssessment),
                ...(reusedAssessment.failedBoundary === undefined ? {} : { failedBoundary: reusedAssessment.failedBoundary }),
                assessmentReused: true,
              };
          }
          const assess = () => assessor.assess({
            runId: input.runId,
            planId: plan.id,
            step: activeStep,
            skills: activatedStepSkills,
            evidence,
            modelEvidence,
            ...(candidate.contextSummary === undefined ? {} : { contextSummary: candidate.contextSummary }),
            assessmentProfile,
            attempt: assessmentAttempt,
          }, input.signal, input.emit);
          const assessment = useProfiledRuleAssessor
            ? await this.actions.execute({
              runId: input.runId,
              planId: plan.id,
              stepId: activeStep.id,
              kind: "assessment",
              replayPolicy: "safe",
              deadlineMs: 10_000,
              metadata: { phase: "assessment", assessmentProfile, assessmentMethod: "rule" },
            }, assess)
            : await assess();
          assessedCandidates.set(assessmentSignature, assessment);
          this.plans.saveAssessment(assessment);
          await input.emit({
            type: "skill.compliance.assessed",
            data: {
              planId: plan.id,
              stepId: activeStep.id,
              attempt: assessment.attempt,
              assessmentProfile: assessment.assessmentProfile,
              assessmentMethod: assessment.assessmentMethod,
              approved: assessment.approved,
              evidenceDigest: assessment.evidenceDigest,
              criteria: assessment.criteria,
              skills: assessment.skills,
              feedback: assessment.feedback,
              ...(assessment.failedBoundary === undefined ? {} : { failedBoundary: assessment.failedBoundary }),
            },
          });
          if (!assessment.approved && assessment.failedBoundary !== undefined) {
            await input.emit({
              type: "assessment.failed_boundary",
              data: {
                planId: plan.id,
                stepId: activeStep.id,
                attempt: assessment.attempt,
                failedBoundary: assessment.failedBoundary,
              },
            });
          }
          return {
            approved: assessment.approved,
            feedback: assessment.feedback,
            deferredValidation: shouldDeferValidationToUser({
              assessment,
              assessmentAttempt,
              step: activeStep,
              evidence,
            }),
            evidenceBoundary: shouldCompleteWithEvidenceBoundary({
              assessment,
              assessmentAttempt,
              step: activeStep,
              evidence,
            }),
            allowRepairLimitCompletion: shouldAllowRepairLimitCompletion(assessment),
            ...(assessment.failedBoundary === undefined ? {} : { failedBoundary: assessment.failedBoundary }),
          };
        },
      });
      const evidence: StepEvidence = {
        candidateOutput: result.output,
        toolCalls: result.toolEvidence,
        modelSteps: result.steps,
        ...(result.completionCaveat === undefined ? {} : { completionCaveat: result.completionCaveat }),
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
    actorUserId: string;
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
    const repairLeaves = revised.steps.filter((step) =>
      step.retiredAt === undefined
      && step.role === "repair"
      && !input.currentPlan!.steps.some((existing) => existing.id === step.id)
    );
    for (const step of repairLeaves) {
      this.appendRunEvent(input.run.id, {
        type: "recovery.repair_leaf_created",
        data: {
          planId: revised.id,
          stepId: step.id,
          dependencies: step.dependencies,
          evidenceContract: step.evidenceContract,
          sourceActionId: input.action.id,
        },
      });
    }
    this.recovery.admit(input.decision.id);
    if (isEffectivelyComplete(revised)) {
      const output = finalPlanOutput(revised);
      this.terminal.commitCompleted(input.run.id, revised.id, output);
      this.appendRunEvent(input.run.id, {
        type: "terminal.delivery_committed",
        data: {
          runId: input.run.id,
          planId: revised.id,
          output,
          reasonCode: "plan_assessed_and_completed",
        },
      });
      this.appendRunEvent(input.run.id, { type: "run.completed", data: { runId: input.run.id, planId: revised.id, output } });
      return;
    }

    const runWorkspaceRoot = input.run.conversationId === undefined
      ? this.workspaceRoot
      : await this.ensureConversationWorkspace(input.run.conversationId);
    const allTools = this.createTools(privateSkills);
    assertNoDuplicateTools(allTools);
    const rootGrant = createCapabilityGrant({
      actorUserId: input.actorUserId,
      runId: input.run.id,
      ...(input.run.conversationId === undefined ? {} : { conversationId: input.run.conversationId }),
      depth: input.run.depth,
      workspaceRoot: runWorkspaceRoot,
      allowedToolNames: availableToolNames,
      allowedSkillIds: privateSkills.map((skill) => skill.id),
    });
    const assessor = this.assessorFactory(input.model);
    let runningStepId: string | undefined;
    try {
      const completed = await this.executePlanSteps({
        actorUserId: input.actorUserId,
        runId: input.run.id,
        input: input.run.input,
        privateSkills,
        rootGrant,
        plan: revised,
        model: input.model,
        assessor,
        defaultAssessmentPolicyEnabled: this.defaultAssessmentPolicyEnabled,
        registry: new ToolRegistry(allTools),
        emit: async (event) => this.appendRunEvent(input.run.id, event),
        visibleDirectories: [],
        ...(input.run.conversationId === undefined
          ? {}
          : { conversationHistory: this.conversationHistory(input.run.conversationId) }),
        onStepChanged: (stepId) => { runningStepId = stepId; },
      });
      const output = finalPlanOutput(completed);
      const reasonCode = commitCompletedPlan(this.terminal, this.plans.assessments(completed.id), completed, input.run.id, output);
      this.appendRunEvent(input.run.id, {
        type: "terminal.delivery_committed",
        data: { runId: input.run.id, planId: completed.id, output, reasonCode, recovered: true },
      });
      this.appendRunEvent(input.run.id, { type: "run.completed", data: { runId: input.run.id, planId: completed.id, output, recovered: true } });
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "Recovery execution failed", 500);
      const failedBoundary = failedBoundaryFromErrorDetails(appError.details);
      if (
        appError.code === "STEP_NOT_COMPLETED"
        && runningStepId !== undefined
        && failedBoundary !== undefined
        && failedBoundary.stepId === runningStepId
      ) {
        this.plans.failStep(revised.id, runningStepId, appError.message);
        const action = this.actions.requireRecoveryReview({
          runId: input.run.id,
          planId: revised.id,
          stepId: runningStepId,
          reason: "assessment_failed_boundary",
          metadata: {
            failedBoundary,
            feedback: stringField(appError.details, "feedback"),
          },
        });
        this.appendRunEvent(input.run.id, {
          type: "run.recovery_required",
          data: {
            runId: input.run.id,
            planId: revised.id,
            stepId: runningStepId,
            actionId: action.id,
            failedBoundary,
          },
        });
        return;
      }
      throw appError;
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
      && item.kind !== "recovery_review"
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
  "run.cancellation_requested",
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
  "tool.dispatched",
  "tool.result_committed",
  "tool.completed",
  "tool.failed",
  "tool.rejected",
  "candidate.approved",
  "candidate.rejected",
  "candidate.evidence_boundary_accepted",
  "candidate.validation_deferred",
  "assessment.turn.completed",
  "assessment.failed_boundary",
  "terminal.delivery_committed",
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
  addString(details, "assessmentProfile", data.assessmentProfile);
  addString(details, "assessmentMethod", data.assessmentMethod);
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
    addNumber(details, "submitOutcomePlanCalls", data.submitOutcomePlanCallCount);
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
  if (
    type === "candidate.rejected"
    || type === "candidate.evidence_boundary_accepted"
    || type === "candidate.validation_deferred"
    || type === "run.failed"
    || type === "run.cancelled"
    || type === "tool.failed"
    || type === "tool.rejected"
  ) {
    if (
      type === "candidate.rejected"
      || type === "candidate.evidence_boundary_accepted"
      || type === "candidate.validation_deferred"
    ) {
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

function truncateWorkingSetText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}...`;
}

function failureBoundaryForRun(
  run: RunRow,
  outcome: { reasonCode: string; planId?: string } | undefined,
  events: readonly StoredRunEvent[],
): ConversationFailedBoundary | undefined {
  if (run.status === "completed") return undefined;
  const failedEvent = [...events].reverse().find((event) =>
    event.type === "run.failed" || event.type === "run.cancelled"
  );
  const eventData = failedEvent?.data;
  const code = stringField(eventData, "code") ?? run.error_code ?? outcome?.reasonCode;
  const message = stringField(eventData, "message");
  const planId = stringField(eventData, "planId") ?? outcome?.planId;
  const stepId = latestFailedStepId(events);
  return {
    runId: run.id,
    ...(planId === undefined ? {} : { planId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message: truncateWorkingSetText(message, 600) }),
    ...(outcome?.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
    category: failureCategory(code ?? outcome?.reasonCode ?? failedEvent?.type),
  };
}

function artifactSourceByPath(
  events: readonly StoredRunEvent[],
  actions: readonly RuntimeActionRecord[],
): Map<string, { toolCallId?: string; stepId?: string }> {
  const toolStepByCall = new Map<string, string>();
  for (const action of actions) {
    if (action.kind !== "tool_call" || action.stepId === undefined) continue;
    const toolCallId = typeof action.metadata.toolCallId === "string" ? action.metadata.toolCallId : undefined;
    if (toolCallId !== undefined) toolStepByCall.set(toolCallId, action.stepId);
  }
  const result = new Map<string, { toolCallId?: string; stepId?: string }>();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const toolCallId = stringField(event.data, "toolCallId");
    const toolName = stringField(event.data, "toolName");
    const parsed = parseToolResultObject(event.data.result);
    const paths = artifactPathsFromToolResult(toolName, parsed);
    for (const path of paths) {
      result.set(path, {
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(toolCallId === undefined || toolStepByCall.get(toolCallId) === undefined
          ? {}
          : { stepId: toolStepByCall.get(toolCallId) }),
      });
    }
  }
  return result;
}

function artifactPathsFromToolResult(toolName: string | undefined, result: Readonly<Record<string, unknown>> | undefined): string[] {
  if (result === undefined) return [];
  if (toolName === "computer_write_file") {
    const path = typeof result.path === "string" ? result.path : undefined;
    return path === undefined ? [] : [normalizeArtifactPath(path)];
  }
  if (toolName !== "computer_run_command") return [];
  const changes = Array.isArray(result.fileChanges) ? result.fileChanges : [];
  return changes.flatMap((item) => {
    const record = asRecord(item);
    const path = typeof record?.path === "string" ? record.path : undefined;
    return path === undefined ? [] : [normalizeArtifactPath(path)];
  });
}

function buildResumeSuggestion(
  activeGoal: ConversationWorkingSet["activeGoal"] | undefined,
  planCursors: ConversationWorkingSet["planCursors"],
  reusableArtifacts: readonly ConversationReusableArtifact[],
  failedBoundaries: readonly ConversationFailedBoundary[],
): string | undefined {
  if (activeGoal === undefined || activeGoal.planId === undefined) return undefined;
  const cursor = [...planCursors].reverse().find((item) => item.planId === activeGoal.planId);
  if (cursor === undefined) return undefined;
  const executableSteps = cursor.steps.filter((step) => step.kind !== "milestone");
  const nextStep = executableSteps.find((step) => step.status === "failed")
    ?? executableSteps.find((step) => step.status === "running")
    ?? executableSteps.find((step) => step.status === "pending");
  if (nextStep === undefined) return undefined;
  const artifacts = reusableArtifacts
    .filter((artifact) => artifact.runId === activeGoal.runId)
    .map((artifact) => artifact.path)
    .slice(-5);
  const failure = [...failedBoundaries].reverse().find((item) => item.runId === activeGoal.runId);
  return [
    `Continue from prior Run ${shortId(activeGoal.runId)} Plan step ${nextStep.id}: ${truncateWorkingSetText(nextStep.objective, 240)}.`,
    artifacts.length === 0 ? "" : `Reuse durable artifact(s): ${artifacts.join(", ")}.`,
    failure === undefined ? "" : `Preserve failure boundary: ${failure.code ?? failure.reasonCode ?? failure.category}${failure.message === undefined ? "" : ` (${truncateWorkingSetText(failure.message, 160)})`}.`,
  ].filter((item) => item.length > 0).join(" ");
}

function latestFailedStepId(events: readonly StoredRunEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "plan.step.failed" && event.type !== "run.failed") continue;
    const stepId = stringField(event.data, "stepId");
    if (stepId !== undefined) return stepId;
  }
  return undefined;
}

function failureCategory(code: string | undefined): ConversationFailedBoundary["category"] {
  if (code === undefined) return "unknown";
  if (/MODEL_ERROR|provider|HTTP 5\d\d|HTTP 4\d\d/i.test(code)) return "provider";
  if (/PLANNING|PLAN/i.test(code)) return "planning";
  if (/ASSESSMENT/i.test(code)) return "assessment";
  if (/TOOL/i.test(code)) return "tool";
  if (/CANCEL/i.test(code)) return "cancelled";
  if (/INTERNAL|CONFLICT|BAD_REQUEST/i.test(code)) return "runtime";
  return "unknown";
}

function parseToolResultObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function normalizeArtifactPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const field = record?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function failedBoundaryFromErrorDetails(value: unknown): FailedBoundary | undefined {
  const boundary = asRecord(asRecord(value)?.failedBoundary);
  if (boundary === undefined) return undefined;
  const stepId = typeof boundary.stepId === "string" && boundary.stepId.length > 0
    ? boundary.stepId
    : undefined;
  const suggestedRepairShape = boundary.suggestedRepairShape;
  if (
    stepId === undefined
    || (suggestedRepairShape !== "repair_leaf" && suggestedRepairShape !== "ask_user" && suggestedRepairShape !== "fail")
  ) {
    return undefined;
  }
  return {
    stepId,
    missingEvidenceKinds: stringArrayField(boundary.missingEvidenceKinds),
    violatedSkillRequirements: stringArrayField(boundary.violatedSkillRequirements),
    reusableEvidenceRefs: stringArrayField(boundary.reusableEvidenceRefs),
    suggestedRepairShape,
  };
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function failedBoundaryRecoveryDecision(
  run: RunRecord,
  action: RuntimeActionRecord,
  plan: ExecutionPlan | undefined,
): RecoveryDecisionProposal | undefined {
  const failedBoundary = failedBoundaryFromRecoveryAction(action);
  if (failedBoundary === undefined) return undefined;
  const evidenceRefs = failedBoundary.reusableEvidenceRefs;
  const base = {
    actionId: action.id,
    expectedActionRevision: action.revision,
    evidenceRefs,
  };
  if (failedBoundary.suggestedRepairShape === "ask_user") {
    return {
      ...base,
      decision: "ask_user",
      rationale: `Assessment rejected step ${failedBoundary.stepId}; user input is required before a safe repair can proceed.`,
      question: failedBoundaryQuestion(failedBoundary),
    };
  }
  if (failedBoundary.suggestedRepairShape === "fail" || plan === undefined) {
    return {
      ...base,
      decision: "fail",
      rationale: `Assessment rejected step ${failedBoundary.stepId}; no safe bounded repair leaf can be created.`,
    };
  }
  const target = plan.steps.find((step) =>
    step.id === failedBoundary.stepId
    && step.retiredAt === undefined
    && step.kind === "leaf"
    && step.status !== "completed"
  );
  if (target === undefined) {
    return {
      ...base,
      decision: "fail",
      rationale: `Assessment failedBoundary points to ${failedBoundary.stepId}, but no unfinished active leaf matches it.`,
    };
  }
  const activeDependents = plan.steps.filter((step) =>
    step.retiredAt === undefined
    && step.status !== "completed"
    && step.dependencies.includes(target.id)
  );
  if (activeDependents.length > 0) {
    return {
      ...base,
      decision: "ask_user",
      rationale: `Assessment rejected step ${target.id}, but pending dependent steps require an explicit user decision before a local repair can safely replace it.`,
      question: `Step ${target.id} failed assessment, and ${activeDependents.length} pending dependent step(s) still reference it. Confirm whether AgentLoop should create a repair leaf and replan the dependent work.`,
    };
  }
  const repairStep = repairLeafForFailedBoundary(target, failedBoundary, plan.version);
  const planRevision: PlanProposal = {
    goal: plan.goal,
    schema: "agentloop.outcomePlan/v2",
    shape: "recovery_patch",
    selectedSkillIds: plan.selectedSkillIds,
    selectedSkillRoles: [],
    steps: [
      ...plan.steps
        .filter((step) => step.retiredAt === undefined && step.id !== target.id)
        .map((step): PlanStepProposal => ({
          id: step.id,
          kind: step.kind,
          ...(step.parentId === undefined ? {} : { parentId: step.parentId }),
          objective: step.objective,
          dependencies: step.dependencies,
          ...(step.role === undefined ? {} : { role: step.role }),
          refinementState: step.refinementState,
          requiredFacts: step.requiredFacts,
          skillIds: step.skillIds,
          requiredToolNames: step.requiredToolNames,
          ...(step.evidenceContract === undefined ? {} : { evidenceContract: step.evidenceContract }),
          successCriteria: step.successCriteria,
        })),
      repairStep,
    ],
  };
  return {
    ...base,
    decision: "revise_plan",
    rationale: `Create a targeted repair leaf for failed assessment boundary ${target.id}; do not rerun the first-round Planner.`,
    planRevision,
  };
}

function failedBoundaryFromRecoveryAction(action: RuntimeActionRecord): FailedBoundary | undefined {
  const reason = typeof action.metadata.reason === "string" ? action.metadata.reason : undefined;
  if (reason !== "assessment_failed_boundary") return undefined;
  return failedBoundaryFromErrorDetails({ failedBoundary: action.metadata.failedBoundary });
}

function repairLeafForFailedBoundary(
  target: ExecutionPlan["steps"][number],
  failedBoundary: FailedBoundary,
  planVersion: number,
): PlanStepProposal {
  const repairId = repairLeafId(target.id, planVersion);
  const missing = failedBoundary.missingEvidenceKinds.length === 0
    ? "the rejected evidence boundary"
    : failedBoundary.missingEvidenceKinds.join(", ");
  return {
    id: repairId,
    kind: "leaf",
    objective: `Repair step ${target.id} by producing the missing assessment evidence: ${missing}.`,
    dependencies: target.dependencies,
    role: "repair",
    refinementState: "not_refinable",
    requiredFacts: target.requiredFacts,
    skillIds: target.skillIds,
    requiredToolNames: target.requiredToolNames,
    ...(target.evidenceContract === undefined ? {} : { evidenceContract: target.evidenceContract }),
    successCriteria: target.successCriteria,
  };
}

function repairLeafId(stepId: string, planVersion: number): string {
  const suffix = `.repair.${planVersion + 1}`;
  const maximumBase = 128 - suffix.length;
  const base = stepId.slice(0, Math.max(1, maximumBase)).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${base}${suffix}`;
}

function failedBoundaryQuestion(failedBoundary: FailedBoundary): string {
  const missing = failedBoundary.missingEvidenceKinds.length === 0
    ? "the missing evidence"
    : failedBoundary.missingEvidenceKinds.join(", ");
  return `Step ${failedBoundary.stepId} is missing ${missing}. Please provide the required information or confirm how to proceed.`;
}

export interface PlanningSkillRoleSelection {
  readonly skill: PrivateSkill;
  readonly selection: SelectedSkillRole;
}

export function selectPlanningSkills(
  skills: readonly PrivateSkill[],
  taskInput: string,
  boundSkillIds: readonly string[],
): PrivateSkill[] {
  return selectPlanningSkillRoles(skills, taskInput, boundSkillIds).map((item) => item.skill);
}

export function selectPlanningSkillRoles(
  skills: readonly PrivateSkill[],
  taskInput: string,
  boundSkillIds: readonly string[],
): PlanningSkillRoleSelection[] {
  if (skills.length === 0) return [];
  // Conversation history is model context, not authorization or task scope.
  // Letting old deliverables select today's Skill leaks prior work into the
  // current capability decision.
  const signal = normalizePlanningSignal(taskInput);
  const roleBySkillId = new Map<string, SelectedSkillRole>();
  const bound = new Set(boundSkillIds);
  const roleEligibleSkills = skills.filter((skill) => {
    const selection = selectFirstRoundSkillRole(skill, signal, exactSkillMention(signal, skill) || bound.has(skill.id));
    if (selection === undefined) return false;
    roleBySkillId.set(skill.id, selection);
    return true;
  });
  if (roleEligibleSkills.length === 0) return [];
  const exactMatches = roleEligibleSkills.filter((skill) => exactSkillMention(signal, skill));
  if (exactMatches.length > 0) {
    return exactMatches.slice(0, MAX_PLANNING_SKILLS).map((skill) => ({
      skill,
      selection: roleBySkillId.get(skill.id)!,
    }));
  }
  const scored = roleEligibleSkills.map((skill, index) => ({
    skill,
    index,
    score: scorePlanningSkill(skill, signal, bound.has(skill.id)),
  }));
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const topScore = scored[0]?.score ?? 0;
  if (topScore < MIN_PLANNING_SKILL_SCORE) {
    if (topScore < LOW_CONFIDENCE_PLANNING_SKILL_SCORE) return [];
    return scored
      .filter((entry) => entry.score === topScore)
      .slice(0, LOW_CONFIDENCE_PLANNING_SKILL_LIMIT)
      .map((entry) => ({ skill: entry.skill, selection: roleBySkillId.get(entry.skill.id)! }));
  }
  const secondScore = scored[1]?.score ?? 0;
  const strongWinner = topScore - secondScore >= STRONG_WINNER_GAP;
  const candidates = scored.filter((entry) => entry.score >= Math.max(MIN_PLANNING_SKILL_SCORE, topScore - 1));
  let selected = (strongWinner ? scored.slice(0, 1) : candidates)
    .slice(0, MAX_PLANNING_SKILLS);
  if (requestsArtifactBuild(signal) && !explicitStylingRequested(signal)) {
    const hasPrimaryBuilder = selected.some((entry) => {
      const text = normalizePlanningSignal(`${entry.skill.name}\n${entry.skill.description}`);
      return !isStylingSupportSurface(text) && isPrimaryArtifactBuilderSkill(text);
    });
    if (hasPrimaryBuilder) {
      selected = selected.filter((entry) => {
        if (bound.has(entry.skill.id)) return true;
        const text = normalizePlanningSignal(`${entry.skill.name}\n${entry.skill.description}`);
        return !isStylingSupportSurface(text);
      });
    }
  }
  return selected.map((entry) => ({ skill: entry.skill, selection: roleBySkillId.get(entry.skill.id)! }));
}

// This is a relevance prefilter, not a capability boundary. Keep enough
// close-scoring candidates for the Planner to resolve adjacent disciplines
// (for example, a web page can need frontend design as well as implementation).
const MAX_PLANNING_SKILLS = 5;
const MIN_PLANNING_SKILL_SCORE = 2;
const LOW_CONFIDENCE_PLANNING_SKILL_SCORE = 1;
const LOW_CONFIDENCE_PLANNING_SKILL_LIMIT = 2;
const STRONG_WINNER_GAP = 2;

function selectFirstRoundSkillRole(
  skill: PrivateSkill,
  signal: string,
  explicitlyRequested: boolean,
): SelectedSkillRole | undefined {
  const metadata = skill.agentLoop;
  if (metadata === undefined) return undefined;
  const roles = new Set(metadata.roles);
  const artifactKinds = new Set(metadata.artifactKinds);
  if (roles.has("primary_builder") && (explicitlyRequested || matchesRequestedArtifactKind(signal, artifactKinds))) {
    return {
      skillId: skill.id,
      role: "primary_builder",
      reason: "Skill metadata declares primary_builder for the requested first-round artifact boundary.",
    };
  }
  if (roles.has("source_provider") && requestsSourceWork(signal)) {
    return {
      skillId: skill.id,
      role: "source_provider",
      reason: "Skill metadata declares source_provider for requested source-grounded work.",
    };
  }
  if (roles.has("support") && explicitSupportSkillRequested(signal)) {
    return {
      skillId: skill.id,
      role: "support",
      reason: "The user explicitly requested a support capability declared by Skill metadata.",
    };
  }
  if (roles.has("qa") && explicitQaSkillRequested(signal)) {
    return {
      skillId: skill.id,
      role: "qa",
      reason: "The user explicitly requested a QA capability declared by Skill metadata.",
    };
  }
  return undefined;
}

function matchesRequestedArtifactKind(signal: string, artifactKinds: ReadonlySet<string>): boolean {
  if (artifactKinds.has("none")) return !requestsArtifactBuild(signal);
  const requested = requestedArtifactKinds(signal);
  if (requested.size === 0) return artifactKinds.size === 0;
  for (const kind of requested) {
    if (artifactKinds.has(kind)) return true;
  }
  return false;
}

function requestedArtifactKinds(signal: string): Set<string> {
  const result = new Set<string>();
  if (/(?:html|web\s?page|webpage|landing\s?page|网页|页面|浏览器|站点|website)/iu.test(signal)) result.add("html");
  if (/(?:pptx?|slides?|deck|presentation|幻灯片|演示文稿|课件)/iu.test(signal)) result.add("presentation");
  if (/(?:docx?|word|document|文档|报告书)/iu.test(signal)) result.add("document");
  if (/(?:xlsx?|spreadsheet|sheet|csv|表格|工作簿)/iu.test(signal)) result.add("spreadsheet");
  if (/(?:png|jpe?g|webp|image|visual|canvas|poster|artwork|art\s?piece|visual\s?study|海报|图片|图像|视觉|画布)/iu.test(signal)) result.add("image");
  if (/(?:code|script|program|app|代码|脚本|程序|应用)/iu.test(signal)) result.add("code");
  return result;
}

function requestsSourceWork(signal: string): boolean {
  return /(?:source|research|lookup|cite|citation|standard|policy|regulation|rating|certification|api|database|来源|调研|检索|引用|标准|政策|法规|评级|认证|出处|接口|数据源)/iu.test(signal);
}

function explicitSupportSkillRequested(signal: string): boolean {
  return /(?:support skill|theme|styling|palette|font|visual identity|辅助技能|支撑技能|主题|样式|配色|字体|视觉规范)/iu.test(signal);
}

function explicitQaSkillRequested(signal: string): boolean {
  return /(?:qa skill|quality assurance|independent qa|acceptance|review|audit|验收技能|质检技能|独立验收|质量审查|审计)/iu.test(signal);
}

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
  for (const alias of planningSkillAliases(skill)) {
    if (alias.length > 0 && signal.includes(alias)) score += alias.length >= 6 ? 4 : 3;
  }
  for (const token of signalTokens) {
    if (!textTokens.has(token)) continue;
    score += token.length >= 6 ? 2 : 1;
  }
  score += scoreCjkSubphrases(signalTokens, textTokens);
  if (exactSkillMention(signal, skill)) score += 8;
  if (signal.includes("海报") && text.includes("poster")) score += 3;
  if (signal.includes("设计") && text.includes("design")) score += 2;
  if (signal.includes("演示") && text.includes("presentation")) score += 2;
  if (signal.includes("pdf") && text.includes("pdf")) score += 2;
  if (signal.includes("html") && text.includes("html")) score += 2;
  if (signal.includes("web") && text.includes("web")) score += 2;
  if (signal.includes("ppt") && text.includes("slide")) score += 2;
  if (requestsHtmlPresentation(signal)) {
    if (isHtmlArtifactBuilderSkill(text)) score += 6;
    if (isPresentationBuilderSkill(text)) score += 3;
  }
  if (requestsArtifactBuild(signal)) {
    if (isPrimaryArtifactBuilderSkill(text)) score += 3;
    if (isStylingSupportSkill(text) && !explicitStylingRequested(signal)) score -= 4;
  }
  return score;
}

function requestsHtmlPresentation(signal: string): boolean {
  return /(?:\bhtml[-_ ]?ppt\b|\bhtml[-_ ]?(?:presentation|slides?|deck)\b|\b(?:presentation|slides?|deck)[-_ ]?html\b|html.{0,24}(?:演示|课件|幻灯片)|(?:演示|课件|幻灯片).{0,24}html)/iu.test(signal);
}

function requestsArtifactBuild(signal: string): boolean {
  return /(?:\b(?:make|create|build|generate|produce|deliver|write|export|design)\b|做|制作|创建|生成|产出|输出|交付|写|设计)/iu.test(signal)
    && /(?:\b(?:html|web\s?page|webpage|pptx?|slides?|deck|presentation|artifact|file|dashboard|report|image|visual|canvas|poster|artwork)\b|材料|课件|演示|幻灯片|页面|文件|产物|报告|看板|海报|图片|图像|视觉|画布)/iu.test(signal);
}

function explicitStylingRequested(signal: string): boolean {
  return /(?:\b(?:theme|style|styling|visual|palette|font|brand|polish|design)\b|主题|样式|视觉|配色|字体|品牌|美化|排版|设计)/iu.test(signal);
}

function isHtmlArtifactBuilderSkill(text: string): boolean {
  return /(?:web-artifacts-builder|html artifacts?|single html|frontend|react|vite|tailwind|网页|页面)/iu.test(text)
    && /(?:build|create|generate|produce|bundle|artifact|构建|创建|生成|产物)/iu.test(text);
}

function isPresentationBuilderSkill(text: string): boolean {
  return /(?:presentation-skill|powerpoint|pptx|slide[- ]?deck|deck builder|presentation generator|slides?|演示文稿|幻灯片)/iu.test(text)
    && /(?:build|create|generate|produce|render|export|editable|构建|创建|生成|渲染|导出)/iu.test(text);
}

function isPrimaryArtifactBuilderSkill(text: string): boolean {
  return isHtmlArtifactBuilderSkill(text)
    || isPresentationBuilderSkill(text)
    || /(?:build-dashboard|dashboard|report|document|pdf|docx|xlsx|canvas|image|visual|poster|artwork|artifact).{0,160}(?:build|create|generate|produce|render|export|write|design|构建|创建|生成|渲染|导出|写入|设计)/iu.test(text)
    || /(?:build|create|generate|produce|render|export|write|design|构建|创建|生成|渲染|导出|写入|设计).{0,160}(?:canvas|image|visual|poster|artwork|artifact|dashboard|report|document|pdf|docx|xlsx)/iu.test(text);
}

function isStylingSupportSkill(text: string): boolean {
  return isStylingSupportSurface(text)
    && !isHtmlArtifactBuilderSkill(text)
    && !isPresentationBuilderSkill(text);
}

function isStylingSupportSurface(text: string): boolean {
  return /(?:theme-factory|theme|styling|palette|font|color|visual identity|主题|样式|配色|字体)/iu.test(text)
    && /(?:apply|styling|style|choose|colors|fonts|应用|选择|配色|字体)/iu.test(text);
}

function planningSkillAliases(skill: PrivateSkill): string[] {
  const aliases = [
    skill.name,
    skill.name.replace(/-/g, " "),
    ...extractTriggerAliases(skill.description),
  ];
  return [...new Set(aliases.map(normalizePlanningSignal).filter(Boolean))];
}

function extractTriggerAliases(description: string): string[] {
  const aliases: string[] = [];
  const triggerPattern = /(?:触发词|trigger(?:s)?|aliases?)[:：]([^。.;\n]+)/gi;
  for (const match of description.matchAll(triggerPattern)) {
    aliases.push(
      ...match[1]
        .split(/[、,，;；]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return aliases;
}

function scoreCjkSubphrases(signalTokens: readonly string[], textTokens: ReadonlySet<string>): number {
  const signalCjkTokens = signalTokens.filter(isCjkToken);
  if (signalCjkTokens.length === 0) return 0;
  const textCjkTokens = [...textTokens].filter(isCjkToken);
  let score = 0;
  for (const signalToken of signalCjkTokens) {
    for (const textToken of textCjkTokens) {
      const length = longestCommonCjkSubstringLength(signalToken, textToken);
      if (length >= 4) {
        score += 2;
        break;
      }
      if (length >= 2) {
        score += 1;
        break;
      }
    }
  }
  return Math.min(score, 4);
}

function isCjkToken(token: string): boolean {
  return /[\u4e00-\u9fff]/.test(token);
}

function longestCommonCjkSubstringLength(left: string, right: string): number {
  let best = 0;
  for (let start = 0; start < left.length; start += 1) {
    for (let end = start + 2; end <= left.length; end += 1) {
      const phrase = left.slice(start, end);
      if (!isCjkToken(phrase) || !right.includes(phrase)) continue;
      best = Math.max(best, phrase.length);
    }
  }
  return best;
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
    }, async () => {
      const response = await this.model.complete(invocation, signal);
      throwIfAbortSignal(signal);
      return response;
    });
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
    }, async () => {
      const response = stream === undefined
        ? await this.model.complete(invocation, signal)
        : await stream.call(this.model, invocation, sink, signal);
      throwIfAbortSignal(signal);
      return response;
    });
  }
}

function throwIfAbortSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AppError("CANCELLED", "Run was cancelled", 409);
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

async function planningWorkspaceFacts(
  workspaceRoot: string,
  visibleDirectories: readonly VisibleDirectoryGrant[],
  conversationId: string | undefined,
): Promise<PlanningWorkspaceFacts> {
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    const names = entries
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((left, right) => left.localeCompare(right, "en"))
      .slice(0, 20);
    return {
      schema: "planning.workspaceFacts/v1",
      kind: conversationId === undefined ? "workspace_root" : "conversation_workspace",
      rootLabel: conversationId === undefined ? "configured workspace root" : "conversation workspace",
      state: entries.length === 0 ? "empty" : "has_entries",
      entryCount: entries.length,
      sampleEntries: names,
      visibleDirectoryCount: visibleDirectories.length,
      guidance: entries.length === 0 && visibleDirectories.length === 0
        ? "The workspace is empty and has no visible external directories. Do not create a workspace inspection Plan step unless the user asks to inspect an existing project; plan direct artifact creation when file-writing tools are available."
        : "Use these workspace facts as planning context. Create an inspection Plan step only when existing files or visible directories must be understood to satisfy the user request.",
    };
  } catch (error) {
    return {
      schema: "planning.workspaceFacts/v1",
      kind: conversationId === undefined ? "workspace_root" : "conversation_workspace",
      rootLabel: conversationId === undefined ? "configured workspace root" : "conversation workspace",
      state: "unavailable",
      visibleDirectoryCount: visibleDirectories.length,
      guidance: `Workspace facts could not be read before planning: ${error instanceof Error ? error.message : "unknown error"}. Create an inspection step only if the user request depends on workspace contents.`,
    };
  }
}

function canProduceFiles(allowedToolNames: ReadonlySet<string>): boolean {
  return hasFileProducer(allowedToolNames);
}

function commitCompletedPlan(
  terminal: TerminalCommitter,
  assessments: readonly SkillComplianceAssessment[],
  plan: ExecutionPlan,
  runId: string,
  output: string,
): string {
  const reasonCode = completionCaveatReasonCode(plan, assessments);
  if (reasonCode === undefined) {
    terminal.commitCompleted(runId, plan.id, output);
    return "plan_assessed_and_completed";
  }
  terminal.commitCompletedWithCaveats(runId, plan.id, output, reasonCode);
  return reasonCode;
}

function completionCaveatReasonCode(
  plan: ExecutionPlan,
  assessments: readonly SkillComplianceAssessment[],
): string | undefined {
  if (plan.steps.some((step) => step.evidence?.completionCaveat?.reason === "repair_limit")) {
    return "completed_with_repair_limit_caveat";
  }
  if (plan.steps.some((step) => step.evidence?.completionCaveat?.reason === "evidence_boundary")) {
    return "completed_with_evidence_boundary";
  }
  const latestByStep = new Map<string, SkillComplianceAssessment>();
  for (const assessment of assessments) latestByStep.set(assessment.stepId, assessment);
  if ([...latestByStep.values()].some((assessment) =>
    assessment.skills.some((skill) => skill.status === "process_caveat")
  )) {
    return "completed_with_process_caveat";
  }
  if ([...latestByStep.values()].some((assessment) =>
    assessment.skills.some((skill) => skill.status === "skipped_unavailable")
  )) {
    return "completed_with_deferred_validation";
  }
  return undefined;
}

function shouldDeferValidationToUser(input: {
  assessment: SkillComplianceAssessment;
  assessmentAttempt: number;
  step: ExecutionPlan["steps"][number];
  evidence: StepEvidence;
}): boolean {
  if (input.assessment.approved) return false;
  if (input.assessmentAttempt < 2) return false;
  if (!stepRequiresFileOutput(input.step)) return false;
  if (!input.assessment.skills.some((skill) => skill.status === "skipped_unavailable")) return false;
  if (artifactExtensionsProducedByEvidence(input.evidence.toolCalls).size === 0) return false;
  return input.assessment.criteria.some((criterion) => !criterion.satisfied);
}

function shouldCompleteWithEvidenceBoundary(input: {
  assessment: SkillComplianceAssessment;
  assessmentAttempt: number;
  step: ExecutionPlan["steps"][number];
  evidence: StepEvidence;
}): boolean {
  if (input.assessment.approved) return false;
  if (input.assessmentAttempt < 2) return false;
  if (!stepUsesExternalSourceTools(input.step)) return false;
  if (stepRequiresFileOutput(input.step) && artifactExtensionsProducedByEvidence(input.evidence.toolCalls).size === 0) {
    return false;
  }
  if (!hasSuccessfulExternalSourceEvidence(input.evidence.toolCalls)) return false;
  const boundaryText = [
    input.step.objective,
    ...input.step.successCriteria.map((criterion) => criterion.description),
    input.evidence.candidateOutput,
    input.assessment.feedback,
    ...input.assessment.criteria.map((criterion) => criterion.rationale),
  ].join("\n");
  if (matchesRiskSensitiveAssessment(boundaryText)) return false;
  if (requiresStrictExternalSourceCompletion(boundaryText)) return false;
  if (!acknowledgesEvidenceBoundary(boundaryText)) return false;
  return hasUnavailableExternalSourceEvidence(input.evidence.toolCalls)
    || acknowledgesMissingSourceFacts(boundaryText);
}

function stepUsesExternalSourceTools(step: ExecutionPlan["steps"][number]): boolean {
  return step.requiredToolNames.some((name) => name === "websearch" || name === "webfetch");
}

function hasSuccessfulExternalSourceEvidence(toolCalls: readonly ToolEvidence[]): boolean {
  return toolCalls.some((toolCall) =>
    !toolCall.isError && (toolCall.toolName === "websearch" || toolCall.toolName === "webfetch")
  );
}

function hasUnavailableExternalSourceEvidence(toolCalls: readonly ToolEvidence[]): boolean {
  return toolCalls.some((toolCall) =>
    (toolCall.toolName === "websearch" || toolCall.toolName === "webfetch")
    && toolCall.isError
    && /(?:\b(?:403|404|429|500|502|503|504)\b|forbidden|not found|timeout|timed out|unavailable|refused|blocked|denied|network|fetching|无法|不可访问|拒绝|超时|不可用|失败)/iu.test(toolCall.result)
  );
}

function acknowledgesEvidenceBoundary(value: string): boolean {
  return /(?:未核验|未取得|无法取得|不可获取|不可访问|尚未取得|尚未核验|访问受限|权威.*缺|缺少.*权威|有限|局部|部分|不足以|不足|边界|降级|无法|403|404|429|500|502|503|504|\bnot verified\b|\bunverified\b|\bunavailable\b|\binaccessible\b|\blimited\b|\binsufficient\b|\bpartial\b|\bboundary\b)/iu
    .test(value);
}

function acknowledgesMissingSourceFacts(value: string): boolean {
  return /(?:标准全文未|全文未|未(?:取得|获得|提供|公开|核验|验证|确认|查到).*(?:全文|权威|标准|来源|资料|事实|条款|要求|细则)|无法(?:取得|获得|访问|核验|验证|确认|公开确认|可靠核实).*(?:全文|权威|标准|来源|资料|事实|条款|要求|细则)|(?:不可用|未验证|未核验|未确认|无法公开确认|无法可靠核实).{0,24}(?:事实|内容|要求|条款|细则|全文)|没有.*(?:权威|充分).*证据|缺少.*(?:权威|来源|事实|条款|全文|要求|细则)|不可作为.*(?:标准事实|已确认事实)|不能.*(?:作为|认定|批准).*事实|不得.*(?:标为|写成).*事实|仍待核验|待核验|not claim.*verified|missing source facts|source facts remain unverified|full text remains unverified)/iu
    .test(value);
}

function requiresStrictExternalSourceCompletion(value: string): boolean {
  return /(?:必须(?:严格)?(?:依据|按照|基于).*(?:全文|原文|逐条|条款|最新|现行|权威)|不得使用.*(?:模型|自身知识|通用知识)|不能使用.*(?:模型|自身知识|通用知识)|只(?:能|允许).*(?:权威|官方|标准全文|原文)|strictly.*(?:official|authoritative|standard|clause)|must.*(?:official|authoritative|standard text|exact clause)|only.*(?:official|authoritative|standard text|exact clause))/iu
    .test(value);
}

function shouldAllowRepairLimitCompletion(assessment: SkillComplianceAssessment): boolean {
  if (assessment.approved) return true;
  if (assessment.criteria.length === 0) return true;
  return assessment.criteria.some((criterion) => criterion.satisfied);
}

/**
 * Extra tool-enabled steps granted to file-producing Skills after the agent's
 * primary `maxSteps` budget. A generative workflow (write script → run render →
 * verify output) is routinely one render call away when the budget runs out;
 * this grace keeps the chain advancing to a real artifact instead of forcing a
 * premature convergence candidate.
 */
const FILE_OUTPUT_CONVERGENCE_GRACE_STEPS = 8;
const CANDIDATE_REPAIR_GRACE_STEPS = 4;
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

function stepCanConvergeFromLookupEvidence(step: ExecutionPlan["steps"][number]): boolean {
  return step.requiredToolNames.length > 0
    && step.requiredToolNames.every((name) => isLookupToolName(name));
}

function shouldConvergeAfterLookupEvidence(
  step: ExecutionPlan["steps"][number],
  context: ToolStepConvergenceContext,
): { converge: boolean; reason?: string } {
  if (!stepCanConvergeFromLookupEvidence(step)) return { converge: false };
  const latestSuccessfulLookupEvidence = context.latestToolEvidence
    .filter((item) => !item.isError && isLookupToolName(item.toolName));
  if (latestSuccessfulLookupEvidence.length === 0) return { converge: false };

  const successfulLookupEvidence = context.toolEvidence
    .filter((item) => !item.isError && isLookupToolName(item.toolName));
  const webSearchCount = successfulLookupEvidence.filter((item) => item.toolName === "websearch").length;
  const webFetchCount = successfulLookupEvidence.filter((item) => item.toolName === "webfetch").length;
  const webStep = step.requiredToolNames.some((name) => name === "websearch" || name === "webfetch");
  if (!webStep && successfulLookupEvidence.length >= 1) {
    return { converge: true, reason: "lookup_evidence_ready" };
  }
  if (webFetchCount >= 1) {
    return { converge: true, reason: "lookup_evidence_ready:webfetch_result" };
  }
  if (webSearchCount >= 2) {
    return { converge: true, reason: "lookup_evidence_ready:websearch_results" };
  }
  if (successfulLookupEvidence.length >= 3) {
    return { converge: true, reason: "lookup_evidence_ready:bounded_research" };
  }
  return { converge: false };
}

function shouldConvergeAfterFileEvidence(
  step: ExecutionPlan["steps"][number],
  context: ToolStepConvergenceContext,
): { converge: boolean; reason?: string } {
  if (!stepAllowsFileArtifactConvergence(step)) return { converge: false };
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

function stepAllowsFileArtifactConvergence(step: ExecutionPlan["steps"][number]): boolean {
  const text = [
    step.id,
    step.objective,
    ...step.successCriteria.flatMap((criterion) => [criterion.id, criterion.description]),
  ].join("\n").toLowerCase();
  const productionTool = step.requiredToolNames.some((name) => name === "computer_write_file");
  if (productionTool) return true;
  const productionIntent =
    /\b(?:create|generate|write|build|rebuild|export|save|produce|output|materialize|render)\b/i.test(text)
    || /(?:生成|创建|制作|写入|构建|重建|导出|保存|输出|产出|渲染)/u.test(text);
  if (!productionIntent) return false;
  const verificationIntent =
    /\b(?:verify|validate|check|inspect|review|qa|quality|compare|readback)\b/i.test(text)
    || /(?:验证|校验|检查|审查|终检|验收|质量|对比|问题清单)/u.test(text);
  const onlyCommandOrLookup = step.requiredToolNames.every((name) =>
    name === "computer_run_command" || isLookupToolName(name) || name === "load_skill"
  );
  if (verificationIntent && onlyCommandOrLookup && !/\b(?:build|rebuild|export|save|write|generate|create|produce|output)\b/i.test(text)
    && !/(?:生成|创建|制作|写入|构建|重建|导出|保存|输出|产出)/u.test(text)) {
    return false;
  }
  return true;
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
    if (
      item.toolName !== "computer_write_file"
      && item.toolName !== "computer_list_directory"
      && item.toolName !== "computer_run_command"
    ) continue;
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
    if (
      item.toolName === "computer_run_command"
      && isPlainRecord(parsed)
      && Array.isArray(parsed.fileChanges)
    ) {
      for (const change of parsed.fileChanges) {
        if (!isPlainRecord(change)) continue;
        if (change.changeType !== "created" && change.changeType !== "modified") continue;
        if (typeof change.path === "string") addArtifactExtensions(extensions, change.path);
      }
    }
  }
  return extensions;
}

function isLookupToolName(name: string): boolean {
  if (name === "websearch" || name === "webfetch") return true;
  return /(?:^|_)(read|list|search|fetch|inspect|get|query)(?:_|$)/i.test(name);
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

function skillExecutionRootsForSkills(skills: readonly PrivateSkill[]): SkillExecutionRootGrant[] {
  return skills.flatMap((skill) => {
    if (skill.sourceKind !== "package" || skill.package === undefined) return [];
    return [{
      id: `skill-root:${skill.id}`,
      skillId: skill.id,
      name: skill.name,
      cwd: skillExecutionCwd(skill),
      path: skill.package.root,
    }];
  });
}

function skillExecutionCwd(skill: PrivateSkill): string {
  return `@skills/${skill.name}`;
}

function stepAssessmentSignature(input: {
  stepId: string;
  assessmentProfile: AssessmentProfileId;
  activatedSkills: readonly PrivateSkill[];
  evidence: StepEvidence;
  modelEvidence: StepEvidence;
}): string {
  return createHash("sha256").update(JSON.stringify({
    stepId: input.stepId,
    assessmentProfile: input.assessmentProfile,
    activatedSkills: input.activatedSkills
      .map((skill) => ({ id: skill.id, contentHash: skill.contentHash }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    evidence: assessmentEvidenceSignature(input.evidence),
    modelEvidence: assessmentEvidenceSignature(input.modelEvidence),
  })).digest("hex");
}

function assessmentEvidenceSignature(evidence: StepEvidence): Record<string, unknown> {
  return {
    candidateOutput: evidence.candidateOutput.trim(),
    toolCalls: [
      ...new Set(evidence.toolCalls.map((toolCall) => [
        toolCall.toolName,
        toolCall.isError ? "error" : "ok",
        createHash("sha256").update(toolCall.result).digest("hex"),
      ].join("\u0000"))),
    ].sort(),
  };
}

function selectAssessmentProfile(
  step: ExecutionPlan["steps"][number],
  activatedSkills: readonly PrivateSkill[],
): AssessmentProfileId {
  const text = [
    step.objective,
    ...step.successCriteria.map((criterion) => criterion.description),
  ].join("\n");
  if (matchesRiskSensitiveAssessment(text)) return "risk_sensitive";
  if (activatedSkills.length > 0) return "source_grounded";
  if (matchesSourceGroundedAssessment(text)) return "source_grounded";
  if (step.requiredToolNames.some((name) => name === "websearch" || name === "webfetch")) {
    return "lookup_lite";
  }
  if (step.requiredToolNames.length === 0) return "deterministic";
  if (step.requiredToolNames.every((name) => /(?:read|list|search|fetch|inspect|get|query)/i.test(name))) {
    return "lookup_lite";
  }
  return "source_grounded";
}

function isProfiledRuleAssessmentProfile(
  profile: AssessmentProfileId,
): profile is Extract<AssessmentProfileId, "deterministic" | "lookup_lite"> {
  return profile === "deterministic" || profile === "lookup_lite";
}

function matchesRiskSensitiveAssessment(value: string): boolean {
  return /(?:\b(?:medical|medicine|clinical|diagnosis|legal|law|lawsuit|contract|financial|finance|investment|securities|tax|compliance|safety|production|credential|secret|security|procurement|purchase|vendor|regulation)\b|医疗|诊断|法律|诉讼|合同|金融|投资|证券|税务|合规|安全|生产|凭证|密钥|采购|供应商|监管)/iu
    .test(value);
}

function matchesSourceGroundedAssessment(value: string): boolean {
  return /(?:\b(?:compare|comparison|conflict|contradiction|multi[-\s]?source|research|report|briefing|analysis|synthesize|citation|cite|sources?|published|publication date)\b|对比|比较|冲突|矛盾|多源|多个来源|研究|调研|报告|简报|分析|综合|引用|来源|发布日期)/iu
    .test(value);
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
      return formatLoadedSkill(skill, { executionCwd: skillExecutionCwd });
    },
  };
}

function executionTaskProfile(operationProfile: DynamicPromptProfile, skillBound: boolean): TaskProfile {
  return buildTaskProfile({
    phase: "execution",
    intent: "execute",
    operations: [operationProfile],
    skillBound,
  });
}

function buildStepSystemPrompt(
  systemPrompt: string,
  taskProfile: TaskProfile,
): string {
  return buildDynamicSystemPrompt({
    phase: "execution",
    baseInstructions: [systemPrompt.trim()],
    contractLines: [
      "Work only on the current admitted Plan step.",
      "The runtime owns authorization, persistence, assessment, Plan progression, and terminal completion.",
      "Do not perform work reserved for a pending downstream Plan step unless the current step objective or success criteria explicitly require that same artifact.",
      "Your response without tool calls is only a completion candidate and may be rejected with repair feedback.",
      "A completion candidate must be non-empty: summarize the completed work in 2-4 short sentences and cite the concrete evidence or tool results used.",
      "Use only currently exposed tools. Tool success alone does not prove the step is complete.",
    ],
    taskProfile,
  });
}

function buildStepRuntimeContext(
  step: ExecutionPlan["steps"][number],
  plan: ExecutionPlan,
  skills: readonly PrivateSkill[],
  workspaceRoot: string,
  visibleDirectories: readonly VisibleDirectoryGrant[] = [],
  skillExecutionRoots: readonly SkillExecutionRootGrant[] = [],
  taskProfile: TaskProfile = executionTaskProfile(executionOperationProfile({
    objective: step.objective,
    successCriteria: step.successCriteria,
    requiredToolNames: step.requiredToolNames,
    skillNames: skills.map((skill) => skill.name),
  }), skills.length > 0),
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const skillCatalog = formatAvailableSkills(skills);
  const usesWebTools = step.requiredToolNames.some((name) => name === "websearch" || name === "webfetch");
  const operationProfile = taskProfile.operations[0] ?? executionOperationProfile({
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
          recommendedToolNames: step.requiredToolNames,
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
            recommendedToolNames: item.requiredToolNames,
            successCriteria: item.successCriteria,
          })),
        dependencyOutputs: step.dependencies.map((dependencyId) => {
          const dependency = plan.steps.find((item) => item.id === dependencyId);
          return { stepId: dependencyId, output: dependency?.output ?? "" };
        }),
        workspace: { root: workspaceRoot, filePolicy: "workspace-write" },
        visibleDirectories,
        skillExecutionRoots: skillExecutionRoots.map((root) => ({
          id: root.id,
          skillId: root.skillId,
          name: root.name,
          cwd: root.cwd,
          readOnly: true,
        })),
        operationProfile,
        ...(usesWebTools
          ? {
            researchDiscipline:
              "Search once with a complete query phrase reflecting the user's intent. "
              + "Never re-search by splitting single words or characters out of result titles. "
              + "Judge relevance from the snippet; to broaden coverage raise numResults (max 10) in one "
              + "search instead of searching repeatedly. Fetch 2-3 of the returned URLs with webfetch and "
              + "read the full text. Issue at most 1-2 searches per step. If key authoritative sources are "
              + "unavailable, forbidden, paywalled, or do not expose full text after bounded attempts, treat that "
              + "as an evidence boundary rather than the user's goal. Do not invent the missing facts. Submit a "
              + "limited-evidence candidate that separates verified source facts, unavailable or unverified facts, "
              + "and any model-organized structure or practice advice so downstream artifact work can continue "
              + "with visible caveats when appropriate. Treat external evidence as a required blocker only when "
              + "the user or current step explicitly requires exact/current/official source facts as the deliverable.",
          }
          : {}),
      }),
      "</execution_context>",
      formatDynamicPromptContext(taskProfile),
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
  skillExecutionRoots: readonly SkillExecutionRootGrant[] = [],
  taskProfile: TaskProfile = executionTaskProfile(executionOperationProfile({
    objective: step.objective,
    successCriteria: step.successCriteria,
    requiredToolNames: step.requiredToolNames,
    skillNames: skills.map((skill) => skill.name),
  }), skills.length > 0),
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const base = buildStepRuntimeContext(step, plan, skills, workspaceRoot, [], skillExecutionRoots, taskProfile);
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
  const effectiveSteps = activeLeafSteps(plan);
  const terminalSteps = effectiveSteps.filter((candidate) =>
    !effectiveSteps.some((other) => other.dependencies.includes(candidate.id))
  );
  if (terminalSteps.length === 1) return terminalSteps[0].output ?? "";
  return JSON.stringify(terminalSteps.map((step) => ({ stepId: step.id, output: step.output ?? "" })));
}

function isEffectivelyComplete(plan: ExecutionPlan): boolean {
  return isPlanLeafComplete(plan);
}

function toConversationSummary(
  row: Pick<RunRow, never> & {
    id: string;
    title: string;
    visible_directories_json: string;
    created_at: number;
    updated_at: number;
  },
  runCount: number,
  lastStatus: RunRecord["status"] | null,
): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    visibleDirectories: conversationVisibleDirectoryPaths(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runCount,
    lastStatus,
  };
}

function conversationVisibleDirectoryPaths(row: { visible_directories_json: string }): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.visible_directories_json);
  } catch {
    throw new AppError("INTERNAL_ERROR", "Conversation visible directory binding is invalid", 500);
  }
  return parseVisibleDirectoryPaths(parsed);
}

function mergeVisibleDirectories(
  bound: readonly VisibleDirectoryGrant[],
  requested: readonly VisibleDirectoryGrant[],
): VisibleDirectoryGrant[] {
  const paths = new Set<string>();
  const merged: VisibleDirectoryGrant[] = [];
  for (const grant of [...bound, ...requested]) {
    if (paths.has(grant.path)) continue;
    paths.add(grant.path);
    merged.push({ ...grant, id: `visible_dir_${merged.length + 1}` });
  }
  return merged;
}

function parseExecuteOptions(value: unknown): ExecuteOptions {
  if (value === undefined) return { allowDangerousTools: false, visibleDirectories: [] };
  const record = requireRecord(value, "run options");
  if (record.allowDangerousTools !== undefined && typeof record.allowDangerousTools !== "boolean") {
    throw new AppError("BAD_REQUEST", "allowDangerousTools must be boolean", 400);
  }
  const visibleDirectories = parseVisibleDirectoryPaths(record.visibleDirectories);
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
    visibleDirectories,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(modelKey === undefined ? {} : { modelKey }),
    ...(record.conversationIntent === "auto" ? { conversationIntent: "auto" as const } : {}),
  };
}

function parseVisibleDirectoryPaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new AppError("BAD_REQUEST", "visibleDirectories must be an array with at most 12 entries", 400);
  }
  const result = value.map((item, index) =>
    requireString(item, `visibleDirectories[${index}]`, { max: 4_000 })
  );
  if (new Set(result).size !== result.length) {
    throw new AppError("BAD_REQUEST", "visibleDirectories must not contain duplicates", 400);
  }
  return result;
}

async function resolveVisibleDirectories(paths: readonly string[]): Promise<VisibleDirectoryGrant[]> {
  const grants: VisibleDirectoryGrant[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    if (!isAbsolute(rawPath)) {
      throw new AppError("BAD_REQUEST", "visibleDirectories entries must be absolute directory paths", 400);
    }
    const lexical = resolve(rawPath);
    const stat = await fs.lstat(lexical).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new AppError("BAD_REQUEST", `Visible directory does not exist: ${rawPath}`, 400);
      }
      throw error;
    });
    if (stat.isSymbolicLink()) {
      throw forbidden("Visible directories cannot be symbolic links");
    }
    if (!stat.isDirectory()) {
      throw new AppError("BAD_REQUEST", `Visible directory is not a directory: ${rawPath}`, 400);
    }
    const canonical = await fs.realpath(lexical);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    grants.push({
      id: `visible_dir_${grants.length + 1}`,
      name: basename(canonical) || canonical,
      path: canonical,
    });
  }
  return grants;
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
  signal?: AbortSignal,
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
  }, signal);
  const calls = response.toolCalls.filter((call) => call.name === CONVERSATION_INTENT_TOOL.name);
  if (response.toolCalls.length !== 1 || calls.length !== 1) {
    throw new AppError("MODEL_ERROR", "Conversation intent classifier must return exactly one structured decision", 502);
  }
  const argumentsRecord = requireRecord(calls[0].arguments, "conversation intent arguments");
  if (argumentsRecord.kind === "reply") return true;
  if (argumentsRecord.kind === "execute") return false;
  throw new AppError("MODEL_ERROR", "Conversation intent classifier returned an invalid decision", 502);
}

function optionalPlanByRun(plans: PlanRepository, runId: string): ExecutionPlan | undefined {
  try {
    return plans.getByRun(runId);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
}

function throwIfRunCancelled(runs: RunRepository, runId: string, signal: AbortSignal): void {
  if (signal.aborted || runs.get(runId)?.status !== "running") {
    throw new AppError("CANCELLED", "Run was cancelled", 409);
  }
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

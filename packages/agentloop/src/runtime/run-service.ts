import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ComputerExecutor } from "../computer/computer-executor.ts";
import type { ComputerDriver } from "../computer/computer-driver.ts";
import { ArtifactAcceptanceService } from "../acceptance/artifact-acceptance.ts";
import type { ArtifactAcceptanceProvider } from "../acceptance/artifact-acceptance-provider.ts";
import { admitPlan, reusableSourceEvidenceKindsForTurn } from "../planning/admission.ts";
import { ModelStepAssessor, ProfiledRuleStepAssessor } from "../planning/assessor.ts";
import type {
  AssessmentProfileId,
  ConversationStepContext,
  ConversationEvidenceLedger,
  ConversationFailedBoundary,
  ConversationOutcomeRelation,
  ConversationResolvedIntent,
  ConversationReusableArtifact,
  ConversationSourceFact,
  ConversationSourceReference,
  ConversationSourceSummary,
  ConversationTurnRelation,
  ConversationTurnInputMode,
  ConversationTurnResolution,
  ConversationWorkingSet,
  ExecutionPlan,
  FailedBoundary,
  PlanningWorkspaceFacts,
  PlanProposal,
  PlanStepProposal,
  Planner,
  PlanRevisionAssessor,
  PlanningToolSummary,
  PlanningExtensionContext,
  SelectedSkillRole,
  SkillComplianceAssessment,
  StepAssessor,
  StepEvidence,
  TaskSpec,
  ToolEvidence,
} from "../planning/contracts.ts";
import type { RuntimeResultBinding, RuntimeResultCard } from "./runtime-result.ts";
import { createRuntimeResultCard, parseRuntimeResultRef } from "./runtime-result.ts";
import type {
  PlanAdmissionObservation,
  PlanningExtension,
  PlanningExtensionInput,
  PlanningExtensionProposalSource,
  RuntimeOutcomeObservation,
} from "../planning/extensions.ts";
import { ModelPlanner } from "../planning/planner.ts";
import { PlanRepository } from "../planning/plan-repository.ts";
import { activeLeafSteps, isPlanLeafComplete } from "../planning/plan-utils.ts";
import { DependencyScheduler } from "../planning/scheduler.ts";
import {
  planningCapabilitiesFromTools,
  planningCapabilitiesFromSkills,
  requiredToolSourceIdsFromInput,
  stepHasSourceKind,
  stepHasTool,
  stepResolvedToolNames,
  stepUsesTool,
} from "../planning/step-execution-binding.ts";
import { buildSkillReferenceMap } from "../skills/skill-identity.ts";
import type { PrivateSkill, SkillService } from "../skills/skill-service.ts";
import type { SqlConnection } from "../storage/connection.ts";
import { RunRepository, type RunRow, type RunEventRow } from "../storage/repositories/run-repository.ts";
import { SourceRepository, sourceSummary } from "../storage/repositories/source-repository.ts";
import { AppError, forbidden, notFound } from "../shared/errors.ts";
import { canonicalArtifactFormatFamily } from "../shared/artifact-format.ts";
import { optionalPositiveInteger, requireRecord, requireString } from "../shared/validation.ts";
import { runAgentLoop, type ToolStepConvergenceContext } from "./agent-loop.ts";
import { createCapabilityGrant } from "./capability-grant.ts";
import { buildDynamicSystemPrompt, buildTaskProfile, type DynamicPromptProfile, type TaskProfile } from "./dynamic-prompt.ts";
import { buildStepRuntimeContextSnapshot, buildStepToolProgressPolicy } from "./execution-context-policy.ts";
import { deriveStepSemanticFrame } from "./step-semantic-frame.ts";
import type { StepExecutionStrategy } from "./step-execution-strategy.ts";
import { classifyTaskIntent, planningSkillRecallInput, requestedArtifactKindsFromIntent, requestsArtifactBuildFromIntent, requestsPriorArtifactChange } from "./task-intent.ts";
import type {
  CapabilityGrant,
  AgentLoopToolEvidence,
  ModelAdapter,
  ModelInvocation,
  ModelMessage,
  ModelRequestLogContext,
  ModelResponse,
  ModelRetryReporter,
  ModelStreamSink,
  RuntimeContextSnapshot,
  RuntimeEvent,
  SkillExecutionRootGrant,
  UploadedSourceSummary,
  VisibleDirectoryGrant,
} from "./contracts.ts";
import { SourceIntakeService } from "./source-intake-service.ts";
import {
  assertNoDuplicateTools,
  composeRunTools,
  createCoreTools,
  DANGEROUS_COMPUTER_TOOL_NAMES,
  SKILL_LOADER_TOOL_NAME,
  skillExecutionCwd,
  ToolRegistry,
  type RuntimeTool,
} from "../tools/index.ts";
import type { ToolExecutionPlugin } from "../tools/tool-execution-plugin.ts";
import { TerminalCommitter } from "./terminal-committer.ts";
import { StepResultCommitter } from "./step-result-committer.ts";
import { RunOutcomeRepository } from "../storage/repositories/outcome-repository.ts";
import { CompletionFailure, partialOutputForFailure } from "./completion-failure.ts";
import { RuntimeActionRepository, type RuntimeActionRecord } from "./runtime-action-repository.ts";
import { RuntimeResultRepository } from "./runtime-result-repository.ts";
import { createRuntimeResult, parseRuntimeResultJson, type RuntimeResultRef } from "./runtime-result.ts";
import { RunCheckpointRepository, type RunCheckpointRecord } from "./run-checkpoint-repository.ts";
import { HumanLoopRepository, type HumanLoopRequest, type HumanLoopResponse, type HumanLoopRequirement } from "./human-loop.ts";
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
  type RecoveryEventLogSink,
  type RecoveryUserResponse,
  type RunRecoveryState,
} from "./recovery-repository.ts";
import { reconstructRecoveryTranscript } from "./recovery-transcript.ts";
import { assessDecisionBindings, decisionCommitsFromEvents, type RuntimeDecisionCommit } from "./decision-ledger.ts";
import { toolOperationFailureCode } from "./tool-operation-outcome.ts";
import { RunEventHub, type LiveRunEvent } from "./run-event-hub.ts";
import {
  artifactPathsFromCommandFileChanges,
  artifactPathsMentionedInCommandOutput,
  collectProcessArtifacts,
  readProcessArtifact,
  previewProcessArtifact,
  type ProcessArtifact,
  type ProcessArtifactPreview,
} from "./process-artifacts.ts";
import { executionOperationProfile } from "./operation-profiles.ts";

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
export const DEFAULT_MAX_STEPS = 32;

const CONVERSATION_WORKING_SET_RUN_LIMIT = 8;
const CONVERSATION_WORKING_SET_ARTIFACT_LIMIT = 24;
const CONVERSATION_WORKING_SET_RESULT_LIMIT = 8;
const CONVERSATION_WORKING_SET_SOURCE_SUMMARY_LIMIT = 8;
const CONVERSATION_STEP_CONTEXT_LIMIT = 12;
const MAX_COMMAND_OUTPUT_REFERENCE_BYTES = 50 * 1024 * 1024;
const TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES = 8 * 1024;
const TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS = 600;
const MAX_TOOL_ARGUMENT_REFERENCE_BYTES = 50 * 1024 * 1024;
const MAX_UPLOADED_SOURCE_FULL_COVERAGE_CONVERGENCE_CHUNKS = 10;

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
  readonly sources?: readonly UploadedSourceSummary[];
}

export interface HostRunProjection {
  readonly schema: "agentloop.hostRun/v1";
  readonly run: RunRecord;
  readonly outcome?: {
    readonly schema: "agentloop.hostOutcome/v1";
    readonly status: string;
    readonly reasonCode: string;
    readonly planId?: string;
    readonly output?: string;
    readonly committedAt: number;
  };
  readonly plan: {
    readonly state: "pending" | "available" | "unavailable";
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
  };
  readonly artifacts: readonly ProcessArtifact[];
  readonly eventCursor: {
    readonly lastSeq: number;
  };
}

export interface CommandOutputContent {
  readonly toolCallId: string;
  readonly stream: "stdout" | "stderr";
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
}

export interface ToolArgumentsContent {
  readonly toolCallId: string;
  readonly arguments: unknown;
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
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

export interface ConversationListPage {
  readonly conversations: readonly ConversationSummary[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
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
  readonly modelKey?: string;
  readonly visibleDirectories: readonly string[];
  readonly sourceIds: readonly string[];
}

interface ContinuationOptions {
  readonly parentRunId: string;
  readonly depth: number;
  readonly checkpointId: string;
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
  private readonly coreTools: readonly RuntimeTool<unknown>[];
  private readonly plans: PlanRepository;
  private readonly sources: SourceRepository;
  private readonly sourceIntake: SourceIntakeService;
  private readonly scheduler = new DependencyScheduler();
  private readonly terminal: TerminalCommitter;
  private readonly stepResults: StepResultCommitter;
  private readonly actions: RuntimeActionRepository;
  private readonly results: RuntimeResultRepository;
  private readonly checkpoints: RunCheckpointRepository;
  private readonly recovery: RecoveryRepository;
  private readonly humanLoops: HumanLoopRepository;
  private readonly eventHub = new RunEventHub();
  private readonly runEventLogSink?: RunEventLogSink;
  private readonly activeRunControllers = new Map<string, AbortController>();
  private readonly planningExtensions: readonly PlanningExtension[];
  private readonly stepExecutionStrategy?: StepExecutionStrategy;
  private readonly toolExecutionPlugins: readonly ToolExecutionPlugin[];

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
    acceptanceProviders?: readonly ArtifactAcceptanceProvider[];
    computerExecutableAliases?: Readonly<Record<string, string>>;
    computerCommandEnvironment?: Readonly<Record<string, string>>;
    tools?: readonly RuntimeTool<unknown>[];
    systemPrompt?: string;
    maxSteps?: number;
    defaultModelKey?: string;
    modelKeys?: readonly string[];
    runEventLogSink?: RunEventLogSink;
    planningExtensions?: readonly PlanningExtension[];
    stepExecutionStrategy?: StepExecutionStrategy;
    toolExecutionPlugins?: readonly ToolExecutionPlugin[];
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
    const skillReadOnlyRoots = [
      ...options.skills.skillDirectories,
      ...(options.skills.packageStoreRoot === undefined ? [] : [options.skills.packageStoreRoot]),
    ];
    const computerExecutor = new ComputerExecutor(options.workspaceRoot ?? process.cwd(), {
      executableAliases: options.computerExecutableAliases,
      commandEnvironment: options.computerCommandEnvironment,
      readOnlyRoots: skillReadOnlyRoots,
    });
    this.workspaceRoot = computerExecutor.workspaceRoot;
    const acceptanceService = new ArtifactAcceptanceService({
      providers: options.acceptanceProviders,
    });
    this.runs = new RunRepository(options.database);
    this.plans = new PlanRepository(options.database);
    this.stepResults = new StepResultCommitter(this.plans);
    this.sources = new SourceRepository(options.database);
    this.actions = new RuntimeActionRepository(options.database);
    this.results = new RuntimeResultRepository(options.database);
    this.coreTools = createCoreTools({
      executor: computerExecutor,
      driver: options.computerDriver,
      acceptanceService,
      results: this.results,
      pluginTools: options.tools,
    });
    this.sourceIntake = new SourceIntakeService(this.sources, this.workspaceRoot);
    this.humanLoops = new HumanLoopRepository(options.database);
    this.terminal = new TerminalCommitter(this.plans, new RunOutcomeRepository(options.database), this.humanLoops);
    this.checkpoints = new RunCheckpointRepository(options.database);
    this.runEventLogSink = options.runEventLogSink;
    const recoveryEventLogSink: RecoveryEventLogSink = (event) => {
      this.logRunEvent(event.runId, event.seq, { type: event.type, data: event.data }, event.createdAt);
    };
    this.recovery = new RecoveryRepository(options.database, recoveryEventLogSink);
    this.planningExtensions = options.planningExtensions ?? [];
    this.stepExecutionStrategy = options.stepExecutionStrategy;
    this.toolExecutionPlugins = Object.freeze([...(options.toolExecutionPlugins ?? [])]);
  }

  async execute(
    actorUserId: string,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    const input = requireString(inputValue, "input", { max: 200_000 });
    const options = parseExecuteOptions(optionsValue);
    return this.executeInternal(actorUserId, input, options, false);
  }

  /**
   * Execute one user-authored conversational turn. The Runtime, rather than
   * its callers, owns the reply-versus-execution decision for this entry.
   */
  async executeConversation(
    actorUserId: string,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    const input = requireString(inputValue, "input", { max: 200_000 });
    const options = parseExecuteOptions(optionsValue);
    return this.executeInternal(actorUserId, input, options, true);
  }

  async start(
    actorUserId: string,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    return this.startInternal(actorUserId, inputValue, optionsValue, false);
  }

  /** Start one user-authored conversational turn without exposing intent policy to callers. */
  async startConversation(
    actorUserId: string,
    inputValue: unknown,
    optionsValue?: unknown,
  ): Promise<RunRecord> {
    return this.startInternal(actorUserId, inputValue, optionsValue, true);
  }

  private async startInternal(
    actorUserId: string,
    inputValue: unknown,
    optionsValue: unknown,
    conversationEntry: boolean,
  ): Promise<RunRecord> {
    const input = requireString(inputValue, "input", { max: 200_000 });
    const options = parseExecuteOptions(optionsValue);
    let returned = false;
    const created = new Promise<RunRecord>((resolve, reject) => {
      void this.executeInternal(
        actorUserId,
        input,
        options,
        conversationEntry,
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

  /** Ensure a Router-owned conversation id exists before a Runtime starts a Run. */
  async ensureConversation(actorUserId: string, conversationId: string, input: string): Promise<void> {
    await this.runs.ensureConversation({
      id: requireString(conversationId, "conversationId"),
      ownerUserId: actorUserId,
      title: titleFromInput(requireString(input, "input")),
      now: Date.now(),
    });
  }

  async get(actorUserId: string, runId: string): Promise<RunRecord> {
    const row = await this.runs.getByOwner(runId, actorUserId);
    if (row === undefined) throw notFound("Run");
    return this.toRunRecordWithSources(row);
  }

  async checkpointForRun(actorUserId: string, runId: string): Promise<RunCheckpointRecord | undefined> {
    await this.get(actorUserId, runId);
    return this.checkpoints.getByRun(runId);
  }

  async startFromCheckpoint(actorUserId: string, checkpointId: string): Promise<RunRecord> {
    const checkpoint = await this.checkpoints.get(requireString(checkpointId, "checkpointId"));
    if (checkpoint === undefined) throw notFound("Run checkpoint");
    const parent = await this.get(actorUserId, checkpoint.runId);
    if (parent.status !== "failed" || parent.errorCode !== "EXECUTION_AUTHORITY_LOST") {
      throw new AppError("CONFLICT", "Checkpoint can only continue a Run that lost execution authority", 409);
    }
    await this.checkpoints.claim(checkpoint.id);
    const visibleDirectories = (await this.runs.visibleDirectoriesForRun(parent.id)).map((item) => item.path);
    const sourceIds = (await this.sources.listByRun(parent.id)).map((item) => item.id);
    const options: ExecuteOptions = {
      allowDangerousTools: parent.allowDangerousTools,
      ...(parent.conversationId === undefined ? {} : { conversationId: parent.conversationId }),
      ...(parent.modelKey === undefined ? {} : { modelKey: parent.modelKey }),
      visibleDirectories,
      sourceIds,
    };
    let returned = false;
    const created = new Promise<RunRecord>((resolve, reject) => {
      void this.executeInternal(
        actorUserId,
        parent.input,
        options,
        false,
        (run) => {
          returned = true;
          void this.checkpoints.attachChild(checkpoint.id, run.id)
            .then(() => resolve(run), reject);
        },
        { parentRunId: parent.id, depth: parent.depth + 1, checkpointId: checkpoint.id },
      ).catch(async (error) => {
        if (!returned) {
          await this.checkpoints.releaseClaim(checkpoint.id);
          reject(error);
        } else if (process.env.AGENTLOOP_DEBUG_ERRORS === "1") console.error(error);
      });
    });
    return created;
  }

  async currentHumanLoop(actorUserId: string, runId: string): Promise<HumanLoopRequest | undefined> {
    await this.get(actorUserId, runId);
    return this.humanLoops.current(runId);
  }

  async humanLoopHistory(actorUserId: string, runId: string): Promise<HumanLoopRequest[]> {
    await this.get(actorUserId, runId);
    return this.humanLoops.list(runId);
  }

  async respondHumanLoop(actorUserId: string, runId: string, requestId: string, value: unknown, expectedRevision: unknown): Promise<HumanLoopResponse> {
    await this.get(actorUserId, runId);
    const revision = optionalPositiveInteger(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    if (revision === undefined) throw new AppError("BAD_REQUEST", "expectedRevision is required", 400);
    const request = await this.humanLoops.current(runId);
    if (request?.id !== requestId) throw new AppError("CONFLICT", "Human-in-the-Loop request is no longer open", 409);
    const response = await this.humanLoops.respond({ requestId, runId, actorUserId, expectedRevision: revision, value });
    if (request.actionId !== undefined) {
      const action = (await this.actions.list(runId)).find((item) => item.id === request.actionId);
      if (action !== undefined && action.state === "recovery_required") {
        const decision = await this.recovery.submit(runId, {
          actionId: action.id,
          expectedActionRevision: action.revision,
          decision: "resume_step",
          rationale: "A validated Human-in-the-Loop response is available for the interrupted Step.",
          evidenceRefs: [request.id, response.id],
        });
        await this.recovery.admit(decision.id, { kind: "ready_to_resume" });
        void this.resumeRecovery(actorUserId, runId).catch(async (error) => {
          await this.appendRunEvent(runId, {
            type: "human_loop.resume_failed",
            data: { requestId, code: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
          });
        });
      }
    }
    return response;
  }

  async hostRun(actorUserId: string, runId: string): Promise<HostRunProjection> {
    const run = await this.get(actorUserId, runId);
    const planProjection = await this.hostPlanProjection(actorUserId, runId);
    const outcome = await this.outcomeForRun(runId);
    const events = await this.events(actorUserId, runId);
    const artifacts = await this.processArtifacts(actorUserId, runId);
    return {
      schema: "agentloop.hostRun/v1",
      run,
      ...(outcome === undefined ? {} : {
        outcome: {
          schema: "agentloop.hostOutcome/v1",
          status: outcome.status,
          reasonCode: outcome.reasonCode,
          ...(outcome.planId === undefined ? {} : { planId: outcome.planId }),
          ...(outcome.output === undefined ? {} : { output: outcome.output }),
          committedAt: outcome.committedAt,
        },
      }),
      plan: planProjection,
      artifacts,
      eventCursor: {
        lastSeq: events.at(-1)?.seq ?? 0,
      },
    };
  }

  async cancel(actorUserId: string, runId: string): Promise<RunRecord> {
    const run = await this.get(actorUserId, runId);
    if (run.status !== "running") return run;
    const plan = await optionalPlanByRun(this.plans, runId);
    const controller = this.activeRunControllers.get(runId);
    const aborted = controller !== undefined;
    await this.actions.cancelDispatchedForRun(runId);
    if (plan !== undefined) {
      for (const step of plan.steps) {
        if (step.status === "running") await this.plans.failStep(plan.id, step.id, "Run was cancelled by the user");
      }
    }
    await this.terminal.commitStopped({
      runId,
      ...(plan === undefined ? {} : { planId: plan.id }),
      status: "cancelled",
      reasonCode: "user_cancelled",
    });
    await this.appendRunEvent(runId, {
      type: "run.cancellation_requested",
      data: { runId, actorUserId, abortedActiveExecution: aborted },
    });
    await this.appendRunEvent(runId, {
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
  async list(actorUserId: string, limitValue?: unknown): Promise<RunRecord[]> {
    const limit = optionalPositiveInteger(limitValue, "limit", 200, 500);
    const rows = await this.runs.listByOwner(actorUserId, limit);
    return Promise.all(rows.map((row) => this.toRunRecordWithSources(row)));
  }

  /** Most-recently-updated conversations for one user, for the sidebar. */
  async listConversations(actorUserId: string): Promise<ConversationSummary[]>;
  async listConversations(
    actorUserId: string,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<ConversationListPage>;
  async listConversations(
    actorUserId: string,
    page?: { readonly limit: number; readonly offset: number },
  ): Promise<ConversationSummary[] | ConversationListPage> {
    const rows = await this.runs.listConversationSummaries(
      actorUserId,
      page === undefined ? undefined : { limit: page.limit + 1, offset: page.offset },
    );
    const visibleRows = page === undefined ? rows : rows.slice(0, page.limit);
    const summaries: ConversationSummary[] = [];
    for (const row of visibleRows) {
      const last = await this.runs.lastTopLevelStatus(row.id);
      summaries.push(toConversationSummary(row, row.run_count, last?.status ?? null));
    }
    if (page === undefined) return summaries;
    const hasMore = rows.length > page.limit;
    return {
      conversations: summaries,
      hasMore,
      ...(hasMore ? { nextOffset: page.offset + summaries.length } : {}),
    };
  }

  /** One conversation plus its top-level turns in chronological order. */
  async getConversation(actorUserId: string, conversationId: string): Promise<{
    conversation: ConversationSummary;
    runs: RunRecord[];
  }> {
    const conversation = await this.runs.findConversation(actorUserId, conversationId);
    if (conversation === undefined) throw notFound("Conversation");
    const rows = await this.runs.topLevelRunsInConversation(conversationId);
    const last = await this.runs.lastTopLevelStatus(conversationId);
    return {
      conversation: toConversationSummary(conversation, rows.length, last?.status ?? null),
      runs: await Promise.all(rows.map((row) => this.toRunRecordWithSources(row))),
    };
  }

  async updateConversationVisibleDirectories(
    actorUserId: string,
    conversationId: string,
    paths: unknown,
  ): Promise<ConversationSummary> {
    const visibleDirectories = await resolveVisibleDirectories(parseVisibleDirectoryPaths(paths));
    const row = await this.runs.setConversationVisibleDirectories(
      actorUserId,
      conversationId,
      visibleDirectories.map((item) => item.path),
      Date.now(),
    );
    const last = await this.runs.lastTopLevelStatus(conversationId);
    return toConversationSummary(
      row,
      (await this.runs.topLevelRunsInConversation(conversationId)).length,
      last?.status ?? null,
    );
  }

  async uploadSource(
    actorUserId: string,
    input: { originalName: string; mimeType?: string; content: Buffer; conversationId?: string },
  ): Promise<UploadedSourceSummary> {
    if (input.conversationId !== undefined) {
      const conversation = await this.runs.findConversation(actorUserId, input.conversationId);
      if (conversation === undefined) throw notFound("Conversation");
    }
    return this.sourceIntake.upload({
      ownerUserId: actorUserId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      content: input.content,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    });
  }

  async source(actorUserId: string, sourceId: string): Promise<UploadedSourceSummary> {
    return this.sourceIntake.summary(await this.sources.requireByOwner(actorUserId, sourceId));
  }

  async deleteConversation(actorUserId: string, conversationId: string): Promise<void> {
    await this.reconcileInterruptedRuns();
    await this.runs.deleteConversation(actorUserId, conversationId);
  }

  private async resolveConversation(
    actorUserId: string,
    input: string,
    requestedId: string | undefined,
  ): Promise<string> {
    if (requestedId !== undefined) {
      const row = await this.runs.findConversation(actorUserId, requestedId);
      if (row === undefined) throw notFound("Conversation");
      await this.runs.touchConversation(requestedId, Date.now());
      return requestedId;
    }
    const id = randomUUID();
    const now = Date.now();
    await this.runs.insertConversation({ id, ownerUserId: actorUserId, title: titleFromInput(input), createdAt: now });
    return id;
  }

  private async conversationHistory(conversationId: string): Promise<ModelMessage[]> {
    const rows = await this.runs.conversationTranscript(conversationId);
    const messages: ModelMessage[] = [];
    for (const row of rows) {
      messages.push({ role: "user", content: row.input });
      if (row.output !== null) messages.push({ role: "assistant", content: row.output });
    }
    return capConversationHistory(messages);
  }

  private async buildConversationWorkingSet(conversationId: string): Promise<ConversationWorkingSet | undefined> {
    const allRuns = await this.runs.topLevelRunsInConversation(conversationId);
    if (allRuns.length === 0) return undefined;
    const consideredRuns = allRuns.slice(-CONVERSATION_WORKING_SET_RUN_LIMIT);
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

    for (const run of consideredRuns) {
      const events = this.eventsFromRows(await this.runs.eventsByRun(run.id));
      const resolvedIntent = conversationTurnResolutionFromEvents(events);
      if (resolvedIntent !== undefined) {
        resolvedIntents.push({ runId: run.id, resolution: resolvedIntent });
      }
      for (const event of events) {
        if (event.type !== "conversation.outcome.disputed" && event.type !== "conversation.outcome.superseded") continue;
        const targetRunId = stringField(event.data, "targetRunId");
        const relation = stringField(event.data, "relation");
        if (
          targetRunId !== undefined
          && (relation === "correct_prior" || relation === "refine_prior" || relation === "challenge_prior")
        ) {
          outcomeRelations.push({
            runId: run.id,
            targetRunId,
            relation,
            state: event.type === "conversation.outcome.superseded" ? "superseded" : "disputed",
          });
        }
      }
      const outcome = await this.outcomeForRun(run.id);
      const failure = failureBoundaryForRun(run, outcome, events);
      if (failure !== undefined) failedBoundaries.push(failure);

      let plan: ExecutionPlan | undefined;
      try {
        plan = await this.plans.getByRun(run.id);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
      }
      if (plan !== undefined) {
        for (const step of plan.steps) {
          const sourceSummary = conversationSourceSummaryFromStep(run.id, plan.id, step);
          if (sourceSummary !== undefined) sourceSummaries.push(sourceSummary);
          const stepContext = conversationStepContext(run.id, plan.id, step);
          if (stepContext !== undefined) completedStepContexts.push(stepContext);
        }
        const cursor = {
          runId: run.id,
          planId: plan.id,
          input: run.input,
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
              requiredCapabilities: step.requiredCapabilities,
              executionBinding: step.executionBinding,
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
            for (const capability of step.requiredCapabilities) recommendedCapabilityIds.add(capability);
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

      const sourceByPath = artifactSourceByPath(events, await this.actions.list(run.id));
      const artifacts = await collectProcessArtifacts({
        runId: run.id,
        workspaceRoot: this.runWorkspaceRoot(toRunRecord(run)),
        runCreatedAt: run.created_at,
        events,
      });
      for (const artifact of artifacts) {
        const source = artifactSourceForPath(sourceByPath, artifact.path);
        const sourcePlanStep = plan?.steps.find((step) =>
          source?.stepId !== undefined
          && step.id === source.stepId
          && step.retiredAt === undefined
        );
        const sourceSkillIds = sourcePlanStep?.skillIds ?? [];
        const sourceCapabilities = sourcePlanStep?.requiredCapabilities ?? [];
        reusableArtifacts.push({
          runId: run.id,
          path: artifact.path,
          name: artifact.name,
          bytes: artifact.bytes,
          mimeType: artifact.mimeType,
          sourceTool: artifact.sourceTool,
          ...(source?.toolCallId === undefined ? {} : { sourceToolCallId: source.toolCallId }),
          ...(source?.stepId === undefined ? {} : { sourcePlanStepId: source.stepId }),
          ...(sourceSkillIds.length === 0 ? {} : { sourceSkillIds }),
          ...(sourceCapabilities.length === 0 ? {} : { sourceCapabilities }),
          reusable: true,
        });
      }
      const publishedRunResult = outcome?.status === "completed" ? outcome.result : undefined;
      if (publishedRunResult === undefined && plan !== undefined) {
        for (const step of plan.steps) {
          const result = step.status === "completed" ? step.evidence?.publishedResult : undefined;
          if (result === undefined) continue;
          const content = result.payload.content;
          const summary = truncateWorkingSetText(content, 1_200);
          resultCards.push(createRuntimeResultCard({
            result,
            goal: truncateWorkingSetText(step.objective, 600),
            summary,
            summaryTruncated: summary.length < content.replace(/\s+/g, " ").trim().length,
            artifactPaths: artifacts
              .filter((artifact) => artifactSourceForPath(sourceByPath, artifact.path)?.stepId === step.id)
              .map((artifact) => artifact.path),
            evidenceRefs: [
              `run:${run.id}`,
              `plan:${plan.id}`,
              `step:${step.id}`,
              ...(result.publication.assessmentRef === undefined ? [] : [`assessment:${result.publication.assessmentRef}`]),
            ],
          }));
        }
      }
      if (publishedRunResult !== undefined) {
        const content = publishedRunResult.payload.content;
        const summary = truncateWorkingSetText(content, 1_200);
        resultCards.push(createRuntimeResultCard({
          result: publishedRunResult,
          goal: truncateWorkingSetText(plan?.goal ?? run.input, 600),
          summary,
          summaryTruncated: summary.length < content.replace(/\s+/g, " ").trim().length,
          artifactPaths: artifacts.map((artifact) => artifact.path),
          evidenceRefs: [
            `run:${run.id}`,
            ...(publishedRunResult.producer.planId === undefined ? [] : [`plan:${publishedRunResult.producer.planId}`]),
          ],
        }));
      }
    }

    const boundedArtifacts = reusableArtifacts.slice(-CONVERSATION_WORKING_SET_ARTIFACT_LIMIT);
    const boundedResultCards = resultCards.slice(-CONVERSATION_WORKING_SET_RESULT_LIMIT);
    const boundedSourceSummaries = sourceSummaries.slice(-CONVERSATION_WORKING_SET_SOURCE_SUMMARY_LIMIT);
    const boundedStepContexts = completedStepContexts.slice(-CONVERSATION_STEP_CONTEXT_LIMIT);
    for (const stepContext of boundedStepContexts) {
      for (const skillId of stepContext.skillIds) requiredSkillIds.add(skillId);
      for (const capability of stepContext.requiredCapabilities) recommendedCapabilityIds.add(capability);
    }
    for (const artifact of boundedArtifacts) {
      for (const skillId of artifact.sourceSkillIds ?? []) requiredSkillIds.add(skillId);
      for (const capability of artifact.sourceCapabilities ?? []) recommendedCapabilityIds.add(capability);
    }
    const resumeSuggestion = buildResumeSuggestion(activeGoal, planCursors, boundedArtifacts, failedBoundaries);
    const evidenceLedger: ConversationEvidenceLedger | undefined = boundedSourceSummaries.length === 0
      ? undefined
      : {
        schema: "conversation.evidenceLedger/v1",
        sourceSummaries: boundedSourceSummaries,
      };
    return {
      schema: "conversation.workset/v1",
      conversationId,
      runCount: allRuns.length,
      ...(activeGoal === undefined ? {} : { activeGoal }),
      planCursors,
      ...(resolvedIntents.length === 0 ? {} : { resolvedIntents }),
      resultCards: boundedResultCards,
      reusableArtifacts: boundedArtifacts,
      failedBoundaries,
      ...(outcomeRelations.length === 0 ? {} : { outcomeRelations }),
      recommendedCapabilities: {
        skillIds: [...requiredSkillIds],
        capabilityIds: [...recommendedCapabilityIds],
      },
      ...(evidenceLedger === undefined ? {} : { evidenceLedger }),
      ...(boundedStepContexts.length === 0 ? {} : { completedStepContexts: boundedStepContexts }),
      ...(resumeSuggestion === undefined ? {} : { resumeSuggestion }),
    };
  }

  private runWorkspaceRoot(run: Pick<RunRecord, "conversationId">): string {
    return run.conversationId === undefined
      ? this.workspaceRoot
      : this.conversationWorkspaceRoot(run.conversationId);
  }

  private async toRunRecordWithSources(row: RunRow): Promise<RunRecord> {
    const sources = await Promise.all(
      (await this.sources.listByRun(row.id)).map((source) => this.sourceIntake.summary(source)),
    );
    return toRunRecord(row, sources);
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

  async plan(actorUserId: string, runId: string): Promise<{
    state: "pending" | "available" | "unavailable";
    plan: ExecutionPlan;
    assessments: SkillComplianceAssessment[];
  }> {
    const run = await this.get(actorUserId, runId);
    try {
      const plan = await this.plans.getByRun(runId);
      return { state: "available", plan, assessments: await this.plans.assessments(plan.id) };
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

  private async hostPlanProjection(
    actorUserId: string,
    runId: string,
  ): Promise<HostRunProjection["plan"]> {
    const detail = await this.plan(actorUserId, runId);
    return {
      state: detail.state,
      id: detail.plan.id,
      version: detail.plan.version,
      status: detail.plan.status,
      goal: detail.plan.goal,
      selectedSkillIds: detail.plan.selectedSkillIds,
      steps: detail.plan.steps
        .filter((step) => step.retiredAt === undefined)
        .map((step) => ({
          id: step.id,
          status: step.status,
          objective: step.objective,
          dependencies: step.dependencies,
          skillIds: step.skillIds,
          requiredCapabilities: step.requiredCapabilities,
          executionBinding: step.executionBinding,
          ...(step.output === undefined ? {} : { output: truncateWorkingSetText(step.output, 1_200) }),
          ...(step.error === undefined ? {} : { error: truncateWorkingSetText(step.error, 600) }),
        })),
      assessmentCount: detail.assessments.length,
      approvedAssessmentCount: detail.assessments.filter((assessment) => assessment.approved).length,
    };
  }

  async events(actorUserId: string, runId: string): Promise<StoredRunEvent[]> {
    await this.get(actorUserId, runId);
    const rows = await this.runs.eventsByRun(runId);
    return this.eventsFromRows(rows).map(publicRunEvent);
  }

  private eventsFromRows(rows: readonly RunEventRow[]): StoredRunEvent[] {
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  private async runtimeEvents(runId: string): Promise<StoredRunEvent[]> {
    return this.eventsFromRows(await this.runs.eventsByRun(runId));
  }

  private async outcomeForRun(runId: string): Promise<{
    status: string;
    reasonCode: string;
    planId?: string;
    output?: string;
    result?: ReturnType<typeof parseRuntimeResultJson>;
    committedAt: number;
  } | undefined> {
    const row = await this.database.prepare(`
      SELECT status, reason_code, plan_id, output, result_json, committed_at FROM run_outcomes WHERE run_id = ?
    `).get(runId) as {
      status: string;
      reason_code: string;
      plan_id: string | null;
      output: string | null;
      result_json: string | null;
      committed_at: number;
    } | undefined;
    if (row === undefined) return undefined;
    return {
      status: row.status,
      reasonCode: row.reason_code,
      ...(row.plan_id === null ? {} : { planId: row.plan_id }),
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.result_json === null ? {} : { result: parseRuntimeResultJson(row.result_json) }),
      committedAt: row.committed_at,
    };
  }

  /**
   * Process artifacts are derived from this Run's successful tool receipts and
   * revalidated inside the workspace. They are observable work-in-progress,
   * never a substitute for a completed Plan or approved Assessment.
   */
  async processArtifacts(actorUserId: string, runId: string): Promise<ProcessArtifact[]> {
    const run = await this.get(actorUserId, runId);
    const workspaceRoot = this.runWorkspaceRoot(run);
    return collectProcessArtifacts({
      runId,
      workspaceRoot,
      runCreatedAt: run.createdAt,
      events: await this.events(actorUserId, runId),
    });
  }

  async readProcessArtifact(actorUserId: string, runId: string, artifactId: string): Promise<{
    artifact: ProcessArtifact;
    content: Buffer;
  }> {
    const artifact = (await this.processArtifacts(actorUserId, runId)).find((item) => item.id === artifactId);
    if (artifact === undefined) throw notFound("Process artifact");
    const run = await this.get(actorUserId, runId);
    try {
      return { artifact, content: await readProcessArtifact({ artifact, workspaceRoot: this.runWorkspaceRoot(run) }) };
    } catch {
      throw notFound("Process artifact");
    }
  }

  async previewProcessArtifact(actorUserId: string, runId: string, artifactId: string): Promise<ProcessArtifactPreview> {
    const artifact = (await this.processArtifacts(actorUserId, runId)).find((item) => item.id === artifactId);
    if (artifact === undefined) throw notFound("Process artifact");
    const run = await this.get(actorUserId, runId);
    try {
      return await previewProcessArtifact({ artifact, workspaceRoot: this.runWorkspaceRoot(run) });
    } catch {
      throw notFound("Process artifact");
    }
  }

  async readCommandOutput(
    actorUserId: string,
    runId: string,
    toolCallId: string,
    stream: "stdout" | "stderr",
  ): Promise<CommandOutputContent> {
    const run = await this.get(actorUserId, runId);
    const completedEvent = (await this.events(actorUserId, runId)).find((event) => {
      const data = event.data;
      return event.type === "tool.completed"
        && data.toolName === "computer_run_command"
        && data.toolCallId === toolCallId;
    });
    if (completedEvent === undefined) throw notFound("Command output");
    const result = parseCommandOutputResult(completedEvent.data.result);
    if (result === undefined) throw notFound("Command output");
    const ref = commandOutputReference(result[`${stream}Ref`]);
    if (ref === undefined) {
      const inlineContent = typeof result[stream] === "string" ? result[stream] : "";
      return {
        toolCallId,
        stream,
        content: inlineContent,
        bytes: Buffer.byteLength(inlineContent),
        characters: inlineContent.length,
      };
    }

    const target = await resolveCommandOutputReference(this.runWorkspaceRoot(run), ref.path);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_COMMAND_OUTPUT_REFERENCE_BYTES) throw notFound("Command output");
    return {
      toolCallId,
      stream,
      content: await fs.readFile(target, "utf8"),
      path: ref.path,
      ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }),
      ...(ref.bytes === undefined ? { bytes: stat.size } : { bytes: ref.bytes }),
      ...(ref.characters === undefined ? {} : { characters: ref.characters }),
    };
  }

  async readToolArguments(
    actorUserId: string,
    runId: string,
    toolCallId: string,
  ): Promise<ToolArgumentsContent> {
    await this.get(actorUserId, runId);
    const events = this.eventsFromRows(await this.runs.eventsByRun(runId));
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const directToolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
      if (directToolCallId === toolCallId) {
        const ref = toolArgumentsReference(event.data.argumentsRef);
        if (ref !== undefined) return this.readToolArgumentsReference(toolCallId, ref);
        if ("arguments" in event.data) {
          return inlineToolArgumentsContent(toolCallId, event.data.arguments);
        }
      }
      if ((event.type === "assistant.committed" || event.type === "assistant.streaming") && Array.isArray(event.data.toolCalls)) {
        const calls = event.data.toolCalls as readonly unknown[];
        for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
          const call = asRecord(calls[callIndex]);
          if (call?.id !== toolCallId) continue;
          const ref = toolArgumentsReference(call.argumentsRef);
          if (ref !== undefined) return this.readToolArgumentsReference(toolCallId, ref);
          if ("arguments" in call) return inlineToolArgumentsContent(toolCallId, call.arguments);
        }
      }
    }
    throw notFound("Tool arguments");
  }

  /** Subscribe to live run events as they are durably appended. */
  subscribeRunEvents(runId: string, listener: (event: LiveRunEvent) => void): () => void {
    return this.eventHub.subscribe(runId, listener);
  }

  async actionsForRun(actorUserId: string, runId: string): Promise<RuntimeActionRecord[]> {
    await this.get(actorUserId, runId);
    return this.actions.list(runId);
  }

  async recoveryForRun(actorUserId: string, runId: string): Promise<RecoveryDetail> {
    await this.get(actorUserId, runId);
    const state = await this.recovery.state(runId);
    const action = state === undefined
      ? undefined
      : (await this.actions.list(runId)).find((item) => item.id === state.actionId);
    return {
      ...(state === undefined ? {} : { state }),
      ...(action === undefined ? {} : { action }),
      decisions: await this.recovery.list(runId),
      planRevisionAssessments: await this.recovery.planRevisionAssessments(runId),
      userResponses: await this.recovery.userResponses(runId),
    };
  }

  async advanceRecovery(actorUserId: string, runId: string): Promise<RecoveryDetail> {
    const run = await this.get(actorUserId, runId);
    if (run.status !== "running") throw new AppError("CONFLICT", "Only a running Run can advance recovery", 409);
    const state = await this.recovery.state(runId);
    if (state === undefined || state.state !== "waiting_recovery") {
      throw new AppError("CONFLICT", "Run is not waiting for a recovery decision", 409);
    }
    const action = (await this.actions.list(runId)).find((item) => item.id === state.actionId);
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
      currentPlan = await this.plans.getByRun(runId);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
    }
    const failedBoundary = failedBoundaryFromRecoveryAction(action);
    const events = await this.events(actorUserId, runId);
    const proposal = failedBoundaryRecoveryDecision(
      run,
      action,
      currentPlan,
      failedBoundary,
      observedReceiptShapes(events, failedBoundary?.reusableEvidenceRefs ?? []),
    )
      ?? await this.recoveryPlannerFactory(model).decide({
        runId,
        userInput: run.input,
        action,
        ...(currentPlan === undefined ? {} : { plan: currentPlan }),
        ...(failedBoundary === undefined ? {} : { failedBoundary }),
        events,
        userResponses: (await this.recovery.userResponses(runId)).map((item) => ({
          actionId: item.actionId,
          response: item.response,
          createdAt: item.createdAt,
        })),
      });
    const decision = await this.recovery.submit(runId, proposal);
    try {
      switch (decision.decision) {
        case "resume_step":
          if (action.replayPolicy === "unsafe") {
            throw new AppError("TOOL_POLICY_DENIED", "Unsafe Recovery Action cannot be resumed without explicit new execution", 409);
          }
          await this.recovery.admit(decision.id, { kind: "ready_to_resume" });
          break;
        case "ask_user":
          await this.recovery.admit(decision.id, { kind: "waiting_user", question: decision.question });
          break;
        case "fail":
          await this.recovery.admit(decision.id);
          await this.terminal.commitStopped({
            runId,
            ...(currentPlan === undefined ? {} : { planId: currentPlan.id }),
            status: "failed",
            reasonCode: "recovery_planner_failed",
          });
          break;
        case "revise_plan":
          await this.applyPlanRevisionRecovery({
            actorUserId,
            run,
            action,
            decision,
            currentPlan,
            model,
            setActionStep: (stepId) => { actionScope.stepId = stepId; },
          });
          break;
      }
    } catch (error) {
      await this.rejectRecoveryDecision(decision.id, error);
      throw error;
    }
    return this.recoveryForRun(actorUserId, runId);
  }

  async respondRecovery(actorUserId: string, runId: string, responseValue: unknown): Promise<RecoveryDetail> {
    await this.get(actorUserId, runId);
    const response = requireString(responseValue, "response", { max: 20_000 });
    await this.recovery.submitUserResponse(runId, response);
    return this.recoveryForRun(actorUserId, runId);
  }

  async resumeRecovery(actorUserId: string, runId: string): Promise<RunRecord> {
    const run = await this.get(actorUserId, runId);
    if (run.status !== "running") throw new AppError("CONFLICT", "Only a running Run can resume recovery", 409);
    const state = await this.recovery.state(runId);
    if (state?.state !== "ready_to_resume") {
      throw new AppError("CONFLICT", "Run is not ready to resume", 409);
    }
    const action = (await this.actions.list(runId)).find((item) => item.id === state.actionId);
    if (
      action === undefined
      || action.state !== "recovery_required"
      || (action.replayPolicy !== "safe" && action.replayPolicy !== "idempotent")
      || action.planId === undefined
      || action.stepId === undefined
    ) {
      throw new AppError("TOOL_POLICY_DENIED", "Recovery Action cannot be resumed as a safe Plan step", 409);
    }
    const plan = await this.plans.getByRun(runId);
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
      events: await this.resolveToolArgumentReferences(await this.runtimeEvents(runId)),
    });
    const privateSkills = await this.skills.resolveForConversation(actorUserId);
    const visibleDirectories = await this.runs.visibleDirectoriesForRun(runId);
    const sources = (await this.sources.listByRun(runId)).map(sourceSummary);
    const allTools = composeRunTools({
      coreTools: this.coreTools,
      sourceRepository: this.sources,
      privateSkills,
      visibleDirectories,
      uploadedSources: sources,
    });
    assertNoDuplicateTools(allTools);
    const allowedToolNames = new Set(allTools
      .map((tool) => tool.name)
      .filter((name) => run.allowDangerousTools || !DANGEROUS_COMPUTER_TOOL_NAMES.has(name)));
    const rootGrant = createCapabilityGrant({
      actorUserId,
      runId,
      ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
      depth: run.depth,
      workspaceRoot: runWorkspaceRoot,
      visibleDirectories,
      uploadedSources: sources,
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
      await this.recovery.beginResume(runId, action.id);
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
        registry: new ToolRegistry(allTools, { plugins: this.toolExecutionPlugins }),
        emit,
        visibleDirectories,
        sources,
        ...(run.conversationId === undefined
          ? {}
          : { conversationHistory: await this.conversationHistory(run.conversationId) }),
        initialRecovery: {
          stepId: targetStep.id,
          messages: transcript.messages,
          toolEvidence: transcript.toolEvidence,
          facts: transcript.facts,
        },
        onStepChanged: (stepId) => { actionScope.stepId = stepId; },
      });
      const output = finalPlanOutput(resumedPlan);
      const reasonCode = await commitCompletedPlan(this.terminal, await this.plans.assessments(resumedPlan.id), resumedPlan, runId, output);
      // The answered HIL and its recovery review describe the same completed
      // continuation. Close the review before projecting completion so no
      // stale recovery state can be mistaken for an outstanding HIL.
      if (action.kind === "recovery_review") await this.actions.resolveRecoveryReview(action.id);
      await emit({
        type: "terminal.delivery_committed",
        data: { runId, planId: resumedPlan.id, output, reasonCode, recovered: true },
      });
      await emit({ type: "run.completed", data: { runId, planId: resumedPlan.id, output, recovered: true } });
      return this.get(actorUserId, runId);
    } catch (error) {
      if (resumeStarted && (await this.get(actorUserId, runId)).status === "running") {
        if (error instanceof CompletionFailure) {
          const output = await error.report();
          if ((await this.get(actorUserId, runId)).status !== "running") return this.get(actorUserId, runId);
          await this.terminal.commitStopped({ runId, planId: plan.id, status: "failed", reasonCode: error.code, output });
          await emit({ type: "run.failed", data: { runId, planId: plan.id, code: error.code, message: error.message, output, recovered: true } });
          return this.get(actorUserId, runId);
        }
        if (error instanceof AppError && error.code === "HUMAN_LOOP_REQUIRED" && actionScope.stepId !== undefined) {
          await this.persistHumanLoopPause({
            runId,
            planId: plan.id,
            stepId: actionScope.stepId,
            requirement: error.details?.requirement,
            sourceToolCallId: error.details?.sourceToolCallId,
            emit,
          });
          return this.get(actorUserId, runId);
        }
        if (error instanceof AppError && error.code === "ASSESSMENT_ERROR") {
          // A terminal protocol violation is not unanswered user input. Do
          // not restore the answered-HIL recovery review and mislabel it as a
          // HIL resume failure.
          await this.terminal.commitStopped({
            runId,
            planId: plan.id,
            status: "failed",
            reasonCode: error.code,
          });
          await emit({ type: "run.failed", data: { runId, planId: plan.id, code: error.code, message: error.message, recovered: true } });
          return this.get(actorUserId, runId);
        }
        const reason = error instanceof AppError ? error.code : "INTERNAL_ERROR";
        await this.recovery.restoreRecovery(runId, action.id, reason);
      }
      throw error;
    }
  }

  /**
   * A Human-in-the-Loop pause is a durable Runtime state. Both the initial
   * execution and a resumed Step use this path so a later pause is not reduced
   * to a recovery error with no request the user can answer.
   */
  private async persistHumanLoopPause(input: {
    readonly runId: string;
    readonly planId: string;
    readonly stepId: string;
    readonly requirement: unknown;
    readonly sourceToolCallId: unknown;
    readonly emit: (event: RuntimeEvent) => Promise<void>;
  }): Promise<void> {
    if (input.requirement === undefined || typeof input.requirement !== "object" || Array.isArray(input.requirement)) {
      throw new AppError("INTERNAL_ERROR", "Human-in-the-Loop request was not structured", 500);
    }
    const action = await this.actions.requireHumanLoopResume({
      runId: input.runId,
      planId: input.planId,
      stepId: input.stepId,
      metadata: { sourceToolCallId: input.sourceToolCallId },
    });
    const request = await this.humanLoops.create({
      ...(input.requirement as HumanLoopRequirement),
      runId: input.runId,
      planId: input.planId,
      stepId: input.stepId,
      actionId: action.id,
      origin: "tool",
    });
    // Carry the persisted request snapshot so an active SSE connection (and
    // durable replay) can render the required interaction without a second
    // best-effort lookup.
    await input.emit({
      type: "run.waiting_user",
      data: {
        runId: input.runId,
        planId: input.planId,
        stepId: input.stepId,
        requestId: request.id,
        kind: request.kind,
        request,
      },
    });
  }

  toolCatalog(): Array<{ name: string; dangerous: boolean; description: string }> {
    return this.coreTools.map((tool) => ({
      name: tool.name,
      dangerous: DANGEROUS_COMPUTER_TOOL_NAMES.has(tool.name),
      description: tool.description,
    }));
  }

  /**
   * Reconcile interrupted work. Multi-Runtime Hosts pass their durable
   * executor-owned Run IDs; the single-process app omits the scope and keeps
   * the historical global reconciliation behavior.
   */
  async reconcileInterruptedRuns(runIds?: readonly string[]): Promise<number> {
    const scopedRunIds = runIds === undefined ? undefined : [...new Set(runIds)];
    if (scopedRunIds !== undefined && scopedRunIds.length === 0) return 0;
    const runScope = scopedRunIds === undefined ? "" : ` AND runs.id IN (${scopedRunIds.map(() => "?").join(", ")})`;
    let reconciled = 0;
    const pausedAssessments = await this.database.prepare(`
      SELECT runs.id AS run_id, runs.owner_user_id, actions.metadata_json
      FROM runs
      JOIN run_recovery_states recovery ON recovery.run_id = runs.id
      JOIN runtime_actions actions ON actions.id = recovery.action_id
      WHERE runs.status = 'running'
        AND recovery.state = 'waiting_recovery'
        AND actions.state = 'recovery_required'
        ${runScope}
    `).all(...(scopedRunIds ?? [])) as unknown as Array<{ run_id: string; owner_user_id: string; metadata_json: string }>;
    for (const paused of pausedAssessments) {
      if (stringField(JSON.parse(paused.metadata_json) as unknown, "reason") !== "assessment_failed_boundary") continue;
      try {
        await this.advanceRecovery(paused.owner_user_id, paused.run_id);
      } catch (error) {
        const run = await this.get(paused.owner_user_id, paused.run_id);
        if (run.status === "running") {
          let plan: ExecutionPlan | undefined;
          try {
            plan = await this.plans.getByRun(paused.run_id);
          } catch (planError) {
            if (!(planError instanceof AppError) || planError.code !== "NOT_FOUND") throw planError;
          }
          const code = error instanceof AppError ? error.code : "ASSESSMENT_REPAIR_FAILED";
          await this.terminal.commitStopped({
            runId: paused.run_id,
            ...(plan === undefined ? {} : { planId: plan.id }),
            status: "failed",
            reasonCode: code,
          });
          await this.appendRunEvent(paused.run_id, {
            type: "run.failed",
            data: {
              runId: paused.run_id,
              ...(plan === undefined ? {} : { planId: plan.id }),
              code,
              message: error instanceof Error ? error.message : "Assessment repair failed",
            },
          });
        }
      }
      reconciled += 1;
    }
    const interrupted = await this.actions.reconcileRunningRuns(scopedRunIds);
    for (const item of interrupted) {
      const run = await this.runs.get(item.runId);
      if (run === undefined || run.status !== "running") continue;
      let plan: ExecutionPlan | undefined;
      try {
        plan = await this.plans.getByRun(item.runId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
      }
      const events = await this.events(run.owner_user_id, item.runId);
      const checkpoint = await this.checkpoints.create({
        runId: item.runId,
        ...(plan === undefined ? {} : { planId: plan.id }),
        ...(item.actionId === undefined ? {} : { actionId: item.actionId }),
        snapshot: {
          schema: "agentloop.runCheckpoint/v1",
          reason: "execution_authority_lost",
          interruption: item,
          ...(plan === undefined ? {} : { plan }),
          lastEventSeq: events.at(-1)?.seq ?? 0,
          confirmedActionIds: (await this.actions.list(item.runId))
            .filter((action) => action.state === "succeeded")
            .map((action) => action.id),
        },
      });
      await this.terminal.commitStopped({
        runId: item.runId,
        ...(plan === undefined ? {} : { planId: plan.id }),
        status: "failed",
        reasonCode: "EXECUTION_AUTHORITY_LOST",
      });
      await this.appendRunEvent(item.runId, {
        type: "run.checkpoint_created",
        data: { runId: item.runId, checkpointId: checkpoint.id, reason: checkpoint.reason },
      });
      await this.appendRunEvent(item.runId, {
        type: "run.failed",
        data: {
          runId: item.runId,
          ...(plan === undefined ? {} : { planId: plan.id }),
          code: "EXECUTION_AUTHORITY_LOST",
          message: "Runtime execution authority was lost; start a new Run from the persisted checkpoint.",
          checkpointId: checkpoint.id,
        },
      });
      reconciled += 1;
    }
    return reconciled;
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
    conversationEntry: boolean,
    onRunStarted?: (run: RunRecord) => void,
    continuation?: ContinuationOptions,
  ): Promise<RunRecord> {
    const runId = randomUUID();
    const runController = new AbortController();
    const modelKey = this.resolveRunModelKey(executeOptions.modelKey);
    const requestedVisibleDirectories = await resolveVisibleDirectories(executeOptions.visibleDirectories);
    const conversationId = await this.resolveConversation(actorUserId, input, executeOptions.conversationId);
    const conversation = await this.runs.findConversation(actorUserId, conversationId);
    if (conversation === undefined) throw notFound("Conversation");
    const boundVisibleDirectories = await resolveVisibleDirectories(conversationVisibleDirectoryPaths(conversation));
    const visibleDirectories = mergeVisibleDirectories(boundVisibleDirectories, requestedVisibleDirectories);
    if (requestedVisibleDirectories.length > 0) {
      await this.runs.setConversationVisibleDirectories(
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
      : await this.conversationHistory(conversationId);
    const conversationWorkingSet = conversationId === undefined
      ? undefined
      : await this.buildConversationWorkingSet(conversationId);
    const createdAt = Date.now();
    await this.database.transaction(async () => {
      await this.runs.insertRun({
        id: runId,
        ownerUserId: actorUserId,
        conversationId,
        ...(continuation === undefined ? {} : {
          parentRunId: continuation.parentRunId,
          depth: continuation.depth,
        }),
        allowDangerousTools: executeOptions.allowDangerousTools,
        ...(modelKey === undefined ? {} : { modelKey }),
        input,
        createdAt,
      });
      await this.sources.bindRunSources({
        ownerUserId: actorUserId,
        conversationId,
        runId,
        sourceIds: executeOptions.sourceIds,
        createdAt,
      });
      await this.runs.bindRunVisibleDirectories({ runId, visibleDirectories });
    });
    const availableSources = mergeUploadedSources(
      await Promise.all(
        (await this.sources.listForConversation(actorUserId, conversationId))
          .map((row) => this.sourceIntake.summary(row)),
      ),
    );
    this.activeRunControllers.set(runId, runController);

    const emit = async (event: RuntimeEvent): Promise<void> => {
      await this.appendRunEvent(runId, event);
    };
    await emit({
      type: "run.started",
      data: {
        runId,
        actorUserId,
        depth: continuation?.depth ?? 0,
        ...(continuation === undefined ? {} : {
          parentRunId: continuation.parentRunId,
          checkpointId: continuation.checkpointId,
          continuation: true,
        }),
        allowDangerousTools: executeOptions.allowDangerousTools,
        ...(modelKey === undefined ? {} : { modelKey }),
        ...(conversationId === undefined ? {} : { conversationId }),
        workspaceRoot: runWorkspaceRoot,
        visibleDirectories,
        sources: availableSources.map((source) => sourceEventSummary(source)),
      },
    });
    onRunStarted?.(await this.get(actorUserId, runId));

    let planId: string | undefined;
    let runningStepId: string | undefined;
    let admittedPlanSource: PlanningExtensionProposalSource | undefined;
    try {
      await throwIfRunCancelled(this.runs, runId, runController.signal);
      const rawModel = this.modelFactory(this.retryReporter(runId), modelKey);
      // The conversational intent resolver is the first model operation after
      // run.started. Track it with the same durable Action/lease contract as
      // planning and execution so a slow resolver cannot look like an
      // actionless, abandoned Run to a Runtime Host's reconciliation pass.
      const actionScope: { planId?: string; stepId?: string } = {};
      const model = new ActionTrackedModel(rawModel, this.actions, runId, () => actionScope);
      const requiresExecution = requiresDeterministicConversationExecution(input, conversationWorkingSet);
      const turnResolution = !conversationEntry
        ? undefined
        : requiresExecution && (conversationHistory?.length ?? 0) === 0
          ? deterministicConversationTurnResolution(input)
          : await resolveConversationTurn(
            model,
            input,
            conversationHistory,
            {
              visibleDirectories,
              sources: availableSources,
              conversationWorkingSet,
            },
            runController.signal,
          );
      const responseOnly = turnResolution !== undefined && turnResolution.mode !== "execute";
      await throwIfRunCancelled(this.runs, runId, runController.signal);
      if (conversationEntry) {
        await emit({
          type: "conversation.turn.resolved",
          data: turnResolution as unknown as Readonly<Record<string, unknown>>,
        });
        await emit({
          type: "conversation.intent.classified",
          data: {
            kind: responseOnly ? "reply" : "execute",
            ...(turnResolution?.mode === "clarify" ? { resolutionMode: "clarify" } : {}),
          },
        });
        if (
          turnResolution?.targetRunId !== undefined
          && (turnResolution.relation === "correct_prior" || turnResolution.relation === "challenge_prior")
        ) {
          await emit({
            type: "conversation.outcome.disputed",
            data: {
              runId,
              targetRunId: turnResolution.targetRunId,
              relation: turnResolution.relation,
            },
          });
        }
      }
      if (!responseOnly && this.skills.skillDirectories.length > 0) {
        await this.skills.refreshSkillDirectory();
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

      const allTools = composeRunTools({
        coreTools: this.coreTools,
        sourceRepository: this.sources,
        privateSkills,
        visibleDirectories,
        uploadedSources: availableSources,
      });
      assertNoDuplicateTools(allTools);
      const allowedToolNames = responseOnly
        ? []
        : [...allTools.map((tool) => tool.name)].filter((name) =>
          executeOptions.allowDangerousTools || !DANGEROUS_COMPUTER_TOOL_NAMES.has(name)
        );
      const effectiveGoal = turnResolution?.effectiveGoal ?? input;
      const taskIntent = classifyTaskIntent({
        // The resolver supplies a self-contained goal, while the immutable
        // latest user input preserves delivery verbs that a paraphrase may
        // weaken (for example, "generate a Markdown file" -> "present as Markdown").
        objective: effectiveGoal === input ? effectiveGoal : `${effectiveGoal}\n${input}`,
        userConstraints: turnResolution?.userConstraints,
        toolNames: allowedToolNames,
        skillNames: privateSkills.map((skill) => skill.name),
        responseOnly,
        evidenceDemand: turnResolution?.evidenceDemand,
      });
      const skillRecallInput = planningSkillRecallInput({
        objective: effectiveGoal === input ? effectiveGoal : `${effectiveGoal}\n${input}`,
        userConstraints: turnResolution?.userConstraints,
        evidenceDemand: turnResolution?.evidenceDemand,
        responseOnly,
        uploadedSources: availableSources,
      });
      const admissionTaskIntent = {
        ...taskIntent,
        ...(turnResolution === undefined ? {} : { evidenceDemand: turnResolution.evidenceDemand }),
      };
      const allowedToolSummaries = toolSummaries(allTools, new Set(allowedToolNames));
      const requiredToolSourceIds = requiredToolSourceIdsFromInput(`${input}\n${effectiveGoal}`, allowedToolSummaries);
      const rootGrant = createCapabilityGrant({
        actorUserId,
        runId,
        ...(conversationId === undefined ? {} : { conversationId }),
        depth: 0,
        workspaceRoot: runWorkspaceRoot,
        visibleDirectories,
        uploadedSources: availableSources,
        allowedToolNames,
        allowedSkillIds: privateSkills.map((skill) => skill.id),
      });

      // Prior Skills remain in the catalog as continuation context, but they
      // are not preselected execution dependencies. The latest task goal
      // alone determines this turn's candidate roles; the Planner can still
      // select a retained Skill when its current task and handoffs justify it.
      const continuationSkillIds = responseOnly
        ? []
        : (conversationWorkingSet?.recommendedCapabilities.skillIds ?? [])
          .filter((skillId) => privateSkills.some((skill) => skill.id === skillId));
      const planningSkillRoles = responseOnly ? [] : selectPlanningSkillRoles(
        privateSkills,
        // This carries the same resolved goal and user constraints used for
        // TaskIntent, plus neutral native-upload facts for transforms.  It
        // does not bind a Skill or let an input format decide an output kind.
        skillRecallInput,
        [],
        availableSources,
        turnResolution?.evidenceDemand,
      );
      const planningSkills = [...new Map([
        ...planningSkillRoles.map((item) => [item.skill.id, item.skill] as const),
        ...privateSkills
          .filter((skill) => continuationSkillIds.includes(skill.id))
          .map((skill) => [skill.id, skill] as const),
      ]).values()];
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
      const planningWorkspace = await planningWorkspaceFacts(runWorkspaceRoot, visibleDirectories, conversationId, availableSources);
      const planningTask: TaskSpec = {
        runId,
        input,
        ...(turnResolution === undefined ? {} : { turnResolution }),
        availableSkills: planningSkills,
        selectedSkillRoles: planningSkillRoles.map((item) => item.selection),
        ...(continuationSkillIds.length === 0 ? {} : { continuationSkillIds }),
        availableToolNames: allowedToolNames,
        availableTools: allowedToolSummaries,
        availableCapabilities: [
          ...planningCapabilitiesFromTools(allowedToolSummaries, availableSources),
          ...planningCapabilitiesFromSkills(planningSkills),
        ],
        capabilityRecovery: {
          availableSkills: privateSkills,
          availableCapabilities: [
            ...planningCapabilitiesFromTools(allowedToolSummaries, availableSources),
            ...planningCapabilitiesFromSkills(privateSkills),
          ],
        },
        ...(requiredToolSourceIds.length === 0 ? {} : { requiredToolSourceIds }),
        workspaceFacts: planningWorkspace,
        visibleDirectories,
        sources: availableSources,
        ...(responseOnly ? { responseOnly: true } : {}),
        ...(conversationHistory === undefined ? {} : { conversationHistory }),
        ...(conversationWorkingSet === undefined ? {} : { conversationWorkingSet }),
      };
      const planningExtensionResolution = await this.resolvePlanningExtensions({
        task: planningTask,
        actorUserId,
        ...(modelKey === undefined ? {} : { modelKey }),
        ...(conversationId === undefined ? {} : { conversationId }),
        responseOnly,
        emit,
      });
      const planner = this.plannerFactory(model);
      const proposalFromPlanner = async (): Promise<PlanProposal> => planner.plan({
        ...planningTask,
        ...(
          planningExtensionResolution.contexts.length === 0
            ? {}
            : { planningExtensionContexts: planningExtensionResolution.contexts }
        ),
      }, runController.signal, emit);
      let proposal = bindRequiredSkillCompanions(
        planningExtensionResolution.proposal ?? await proposalFromPlanner(),
        planningSkillRoles,
      );
      let proposalSource = planningExtensionResolution.proposalSource;
      await throwIfRunCancelled(this.runs, runId, runController.signal);
      await emit({
        type: "plan.proposed",
        data: {
          goal: proposal.goal,
          selectedSkillIds: proposal.selectedSkillIds,
          stepCount: proposal.steps.length,
          ...(proposalSource === undefined ? {} : {
            source: proposalSource,
          }),
        },
      });
      await throwIfRunCancelled(this.runs, runId, runController.signal);
      let plan: ExecutionPlan;
      const resultBindings = runtimeResultBindingsForTurn(turnResolution);
      try {
        plan = admitPlan({
          runId,
          proposal,
          availableSkills: privateSkills,
          availableToolNames: rootGrant.allowedToolNames,
          availableTools: allowedToolSummaries,
          availableCapabilities: planningCapabilitiesForAdmittedProposal(proposal, privateSkills, allowedToolSummaries, availableSources),
          ...(requiredToolSourceIds.length === 0 ? {} : { requiredToolSourceIds }),
          availableUploadedSourceIds: availableSources.map((source) => source.id),
          availableVisibleDirectoryIds: visibleDirectories.map((directory) => directory.id),
          reusableEvidenceKinds: reusableSourceEvidenceKindsForTurn(conversationWorkingSet, turnResolution),
          ...(resultBindings.length === 0 ? {} : { resultBindings }),
          taskIntent: admissionTaskIntent,
        });
      } catch (error) {
        await this.notifyPlanningExtensionsAfterAdmission({
          runId,
          proposal,
          admitted: false,
          ...(proposalSource === undefined ? {} : {
            source: proposalSource,
          }),
          errorCode: error instanceof AppError ? error.code : "PLAN_NOT_ADMITTED",
          errorMessage: error instanceof Error ? error.message : "Plan was not admitted",
        }, emit);
        if (planningExtensionResolution.proposal === undefined) throw error;
        await emit({
          type: "planning.extension.plan_admission_failed",
          data: {
            source: planningExtensionResolution.proposalSource,
            message: error instanceof Error ? error.message : "Plan was not admitted",
          },
        });
        proposal = bindRequiredSkillCompanions(await proposalFromPlanner(), planningSkillRoles);
        proposalSource = undefined;
        await throwIfRunCancelled(this.runs, runId, runController.signal);
        await emit({
          type: "plan.proposed",
          data: { goal: proposal.goal, selectedSkillIds: proposal.selectedSkillIds, stepCount: proposal.steps.length },
        });
        plan = admitPlan({
          runId,
          proposal,
          availableSkills: privateSkills,
          availableToolNames: rootGrant.allowedToolNames,
          availableTools: allowedToolSummaries,
          availableCapabilities: planningCapabilitiesForAdmittedProposal(proposal, privateSkills, allowedToolSummaries, availableSources),
          ...(requiredToolSourceIds.length === 0 ? {} : { requiredToolSourceIds }),
          availableUploadedSourceIds: availableSources.map((source) => source.id),
          availableVisibleDirectoryIds: visibleDirectories.map((directory) => directory.id),
          reusableEvidenceKinds: reusableSourceEvidenceKindsForTurn(conversationWorkingSet, turnResolution),
          ...(resultBindings.length === 0 ? {} : { resultBindings }),
          taskIntent: admissionTaskIntent,
        });
      }
      plan = await this.plans.create(plan);
      planId = plan.id;
      actionScope.planId = plan.id;
      admittedPlanSource = proposalSource;
      await this.notifyPlanningExtensionsAfterAdmission({
        runId,
        proposal,
        admitted: true,
        planId: plan.id,
        ...(proposalSource === undefined ? {} : {
          source: proposalSource,
        }),
      }, emit);
      await emit({
        type: "plan.admitted",
        data: { planId: plan.id, version: plan.version, goal: plan.goal, steps: plan.steps },
      });

      const assessor = this.assessorFactory(model);
      const registry = new ToolRegistry(allTools, { plugins: this.toolExecutionPlugins });
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
        sources: availableSources,
        ...(conversationHistory === undefined ? {} : { conversationHistory }),
        ...(conversationWorkingSet === undefined ? {} : { conversationWorkingSet }),
        ...(turnResolution === undefined ? {} : { turnResolution }),
        signal: runController.signal,
        onStepChanged: (stepId) => {
          runningStepId = stepId;
          actionScope.stepId = stepId;
        },
      });

      const output = finalPlanOutput(plan);
      await throwIfRunCancelled(this.runs, runId, runController.signal);
      const reasonCode = await commitCompletedPlan(this.terminal, await this.plans.assessments(plan.id), plan, runId, output);
      await this.notifyPlanningExtensionsAfterOutcome({
        runId,
        status: "completed",
        planId: plan.id,
        output,
        reasonCode,
        ...(admittedPlanSource === undefined ? {} : { source: admittedPlanSource }),
      }, emit);
      await emit({
        type: "terminal.delivery_committed",
        data: { runId, planId: plan.id, output, reasonCode },
      });
      if (
        turnResolution?.targetRunId !== undefined
        && (
          turnResolution.relation === "correct_prior"
          || turnResolution.relation === "refine_prior"
          || turnResolution.relation === "challenge_prior"
        )
      ) {
        await emit({
          type: "conversation.outcome.superseded",
          data: {
            runId,
            targetRunId: turnResolution.targetRunId,
            relation: turnResolution.relation,
          },
        });
      }
      await emit({ type: "run.completed", data: { runId, planId: plan.id, output } });
      return this.get(actorUserId, runId);
    } catch (error) {
      if (process.env.AGENTLOOP_DEBUG_ERRORS === "1") console.error(error);
      const appError = error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "Run failed", 500);
      if ((await this.runs.get(runId))?.status === "running") {
        if (appError.code === "HUMAN_LOOP_REQUIRED" && planId !== undefined && runningStepId !== undefined) {
          await this.persistHumanLoopPause({
            runId,
            planId,
            stepId: runningStepId,
            requirement: appError.details?.requirement,
            sourceToolCallId: appError.details?.sourceToolCallId,
            emit,
          });
          return this.get(actorUserId, runId);
        }
        const failedBoundary = failedBoundaryFromErrorDetails(appError.details);
        if (
          appError.code === "STEP_NOT_COMPLETED"
          && planId !== undefined
          && runningStepId !== undefined
          && failedBoundary !== undefined
          && failedBoundary.stepId === runningStepId
        ) {
          await this.plans.failStep(planId, runningStepId, appError.message);
          if (assessmentRepairIsExhausted(appError.details, failedBoundary) || failedBoundaryHasNoAcquisitionPath(
            await this.plans.getByRun(runId),
            runningStepId,
            failedBoundary,
            observedReceiptShapes(
              await this.events(actorUserId, runId),
              failedBoundary.reusableEvidenceRefs,
            ),
          )) {
            const output = await partialOutputForFailure(appError);
            if ((await this.runs.get(runId))?.status !== "running") return this.get(actorUserId, runId);
            await this.terminal.commitStopped({ runId, planId, status: "failed", reasonCode: appError.code, output });
            await this.notifyPlanningExtensionsAfterOutcome({
              runId,
              status: "failed",
              planId,
              reasonCode: appError.code,
              ...(admittedPlanSource === undefined ? {} : { source: admittedPlanSource }),
            }, emit);
            await emit({
              type: "run.failed",
              data: {
                runId,
                planId,
                code: appError.code,
                message: appError.message,
                details: appError.details,
                ...(output === undefined ? {} : { output }),
              },
            });
            return this.get(actorUserId, runId);
          }
          await this.applyAssessmentRepair({
            actorUserId,
            run: await this.get(actorUserId, runId),
            currentPlan: await this.plans.get(planId),
            stepId: runningStepId,
            failedBoundary,
            feedback: stringField(appError.details, "feedback"),
            ...(appError instanceof CompletionFailure ? { failureReport: () => appError.report() } : {}),
          });
          return this.get(actorUserId, runId);
        }
        if (planId !== undefined && runningStepId !== undefined) {
          await this.plans.failStep(planId, runningStepId, appError.message);
        }
        const status = appError.code === "CANCELLED" ? "cancelled" : "failed";
        const output = status === "failed" ? await partialOutputForFailure(appError) : undefined;
        if ((await this.runs.get(runId))?.status !== "running") return this.get(actorUserId, runId);
        await this.terminal.commitStopped({ runId, planId, status, reasonCode: appError.code, output });
        await this.notifyPlanningExtensionsAfterOutcome({
          runId,
          status,
          ...(planId === undefined ? {} : { planId }),
          reasonCode: appError.code,
          ...(admittedPlanSource === undefined ? {} : { source: admittedPlanSource }),
        }, emit);
        await emit({
          type: status === "cancelled" ? "run.cancelled" : "run.failed",
          data: {
            runId,
            planId,
            code: appError.code,
            message: appError.message,
            ...(output === undefined ? {} : { output }),
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

  private async resolvePlanningExtensions(input: {
    task: TaskSpec;
    actorUserId: string;
    responseOnly: boolean;
    modelKey?: string;
    conversationId?: string;
    emit: (event: RuntimeEvent) => Promise<void>;
  }): Promise<{
    proposal?: PlanProposal;
    proposalSource?: PlanningExtensionProposalSource;
    contexts: PlanningExtensionContext[];
  }> {
    if (this.planningExtensions.length === 0) return { contexts: [] };
    const contexts: PlanningExtensionContext[] = [];
    for (const extension of this.planningExtensions) {
      try {
        const extensionInput: PlanningExtensionInput = {
          runId: input.task.runId,
          actorUserId: input.actorUserId,
          input: input.task.input,
          responseOnly: input.responseOnly,
          ...(input.modelKey === undefined ? {} : { modelKey: input.modelKey }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          availableSkills: input.task.availableSkills,
          selectedSkillRoles: input.task.selectedSkillRoles ?? [],
          availableToolNames: input.task.availableToolNames,
          availableTools: input.task.availableTools ?? input.task.availableToolNames.map((name) => ({ name, description: "" })),
          ...(input.task.workspaceFacts === undefined ? {} : { workspaceFacts: input.task.workspaceFacts }),
          visibleDirectories: input.task.visibleDirectories ?? [],
          sources: input.task.sources ?? [],
          ...(input.task.conversationWorkingSet === undefined ? {} : { conversationWorkingSet: input.task.conversationWorkingSet }),
        };
        const decision = await extension.beforePlanning(extensionInput);
        await input.emit({
          type: "planning.extension.decision",
          data: {
            extensionName: extension.name,
            kind: decision.kind,
            ...(decision.kind === "planner_context" ? planningExtensionContextTelemetry(decision.context) : {}),
            ...(decision.kind === "plan_proposal" ? {
              templateId: decision.source.templateId,
              score: decision.source.score,
              stepCount: decision.proposal.steps.length,
            } : {}),
          },
        });
        if (decision.kind === "planner_context") {
          contexts.push(decision.context);
          continue;
        }
        if (decision.kind === "plan_proposal") {
          return {
            proposal: decision.proposal,
            proposalSource: decision.source,
            contexts,
          };
        }
      } catch (error) {
        await input.emit({
          type: "planning.extension.failed",
          data: {
            extensionName: extension.name,
            message: error instanceof Error ? error.message : "Planning extension failed",
          },
        });
      }
    }
    return { contexts };
  }

  private async notifyPlanningExtensionsAfterAdmission(
    observation: PlanAdmissionObservation,
    emit: (event: RuntimeEvent) => Promise<void>,
  ): Promise<void> {
    for (const extension of this.planningExtensions) {
      if (extension.afterPlanAdmission === undefined) continue;
      try {
        await extension.afterPlanAdmission(observation);
      } catch (error) {
        await emit({
          type: "planning.extension.feedback_failed",
          data: {
            extensionName: extension.name,
            phase: "afterPlanAdmission",
            message: error instanceof Error ? error.message : "Planning extension feedback failed",
          },
        });
      }
    }
  }

  private async notifyPlanningExtensionsAfterOutcome(
    observation: RuntimeOutcomeObservation,
    emit: (event: RuntimeEvent) => Promise<void>,
  ): Promise<void> {
    for (const extension of this.planningExtensions) {
      if (extension.afterOutcome === undefined) continue;
      try {
        await extension.afterOutcome(observation);
      } catch (error) {
        await emit({
          type: "planning.extension.feedback_failed",
          data: {
            extensionName: extension.name,
            phase: "afterOutcome",
            message: error instanceof Error ? error.message : "Planning extension feedback failed",
          },
        });
      }
    }
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
    sources: readonly UploadedSourceSummary[];
    conversationHistory?: readonly ModelMessage[];
    conversationWorkingSet?: ConversationWorkingSet;
    turnResolution?: ConversationTurnResolution;
    initialRecovery?: Readonly<{
      stepId: string;
      messages: readonly ModelMessage[];
      toolEvidence: readonly AgentLoopToolEvidence[];
      facts: unknown;
    }>;
    decisionLedger?: readonly RuntimeDecisionCommit[];
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
      if (step.status === "pending") plan = await this.plans.startStep(plan.id, step.id);
      const activeStep = plan.steps.find((item) => item.id === step.id)!;
      const skillsByReference = buildSkillReferenceMap(input.privateSkills);
      const stepSkills = activeStep.skillIds.map((skillId) => {
        const skill = skillsByReference.get(skillId);
        if (skill === undefined) throw new AppError("PLAN_NOT_ADMITTED", `Skill ${skillId} disappeared`, 409);
        return skill;
      });
      const stepSkillIds = stepSkills.map((skill) => skill.id);
      const skillExecutionRoots = skillExecutionRootsForSkills(stepSkills);
      // The Run grant is the execution authorization boundary. A Plan leaf
      // describes the current objective and its evidence contract, but must
      // not revoke a Tool that the user already authorized for the Run.
      // Resource and Skill grants below remain leaf-scoped.
      const stepAllowedToolNames = [...input.rootGrant.allowedToolNames].filter((name) =>
        name !== SKILL_LOADER_TOOL_NAME || stepSkillIds.length > 0
      );
      const stepVisibleDirectories = visibleDirectoriesForStep(
        input.visibleDirectories,
        activeStep.executionBinding.requiredVisibleDirectoryIds,
      );
      const stepSources = uploadedSourcesForStep(input.sources, activeStep.executionBinding.requiredUploadedSourceIds);
      const stepGrant = createCapabilityGrant({
        actorUserId: input.actorUserId,
        runId: input.runId,
        planId: plan.id,
        stepId: activeStep.id,
        ...(input.rootGrant.conversationId === undefined ? {} : { conversationId: input.rootGrant.conversationId }),
        depth: input.rootGrant.depth,
        ...(input.rootGrant.workspaceRoot === undefined ? {} : { workspaceRoot: input.rootGrant.workspaceRoot }),
        visibleDirectories: stepVisibleDirectories,
        uploadedSources: stepSources,
        skillExecutionRoots,
        allowedToolNames: stepAllowedToolNames,
        allowedSkillIds: stepSkillIds,
      });
      await input.emit({
        type: "plan.step.started",
        data: {
          planId: plan.id,
          stepId: activeStep.id,
          skillIds: stepSkillIds,
          toolNames: [...stepGrant.allowedToolNames],
          requiredCapabilities: activeStep.requiredCapabilities,
          executionBinding: activeStep.executionBinding,
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
      let assessmentAttempt = (await this.plans.assessments(plan.id))
        .filter((assessment) => assessment.stepId === activeStep.id).length;
      const assessedCandidates = new Map<string, SkillComplianceAssessment>();
      const recovery = input.initialRecovery?.stepId === activeStep.id ? input.initialRecovery : undefined;
      const decisionLedger = input.decisionLedger
        ?? (isRecord(recovery?.facts) && Array.isArray(recovery.facts.decisionLedger)
          ? recovery.facts.decisionLedger as RuntimeDecisionCommit[]
          : []);
      const fileOutputStep = (stepAllowsSkillFileOutput(activeStep)
        && stepSkills.some((skill) => skillRequiresFileOutput(skill)))
        || stepRequiresFileOutput(activeStep);
      const lookupEvidenceStep = !fileOutputStep && (
        stepCanConvergeFromLookupEvidence(activeStep)
        || stepAllowsSourceSummaryCandidateConvergence(activeStep)
      );
      const stepTaskProfile = executionTaskProfileForStep(activeStep, stepSkills);
      const stepSemanticFrame = deriveStepSemanticFrame({
        step: activeStep,
        plan,
        skills: stepSkills,
        visibleDirectories: stepVisibleDirectories,
        sources: stepSources,
        taskProfile: stepTaskProfile,
        operationProfileId: stepTaskProfile.operations[0]?.id,
        requiresFileOutput: fileOutputStep,
        conversationWorkingSet: input.conversationWorkingSet,
      });
      const stepProgressPolicy = buildStepToolProgressPolicy({
        step: activeStep,
        requiresFileOutput: fileOutputStep,
        taskProfile: stepTaskProfile,
      });
      // A delivery leaf may be deliberately tool-free: its direct dependency
      // already acquired the source facts (including an empty-result receipt).
      // Keep that receipt in the assessment evidence, rather than requiring
      // the delivery leaf to re-acquire it or treating an honest no-data report
      // as an incomplete, recoverable execution.
      const dependencyToolEvidence = directDependencyToolEvidence(activeStep, plan);
      const conversationToolEvidence = conversationEvidenceToolEvidence(
        input.conversationWorkingSet,
        input.turnResolution,
        activeStep,
      );
      const inheritedAssessmentToolEvidence = mergeAssessmentToolEvidence(
        dependencyToolEvidence,
        conversationToolEvidence,
      );
      if (conversationToolEvidence.length > 0) {
        await input.emit({
          type: "conversation.evidence.reused",
          data: {
            planId: plan.id,
            stepId: activeStep.id,
            targetRunId: input.turnResolution?.targetRunId,
            evidenceRefs: conversationToolEvidence.map((item) => item.toolCallId),
          },
        });
      }
      const initialToolEvidence = mergeAssessmentToolEvidence(
        recovery?.toolEvidence ?? [],
        conversationToolEvidence,
      );
      const result = await runAgentLoop({
        runId: input.runId,
        // Stage 3 is limited to fresh file-producing leaves with a snapshot reader.
        // Recovery inherits the same state only in stage 5, not implicitly here.
        ...(recovery === undefined && fileOutputStep && stepGrant.allowedToolNames.has("computer_read_file") ? {
          workProductContext: {
            goalId: `${plan.id}:v${plan.version}:${activeStep.id}`,
            goal: activeStep.objective,
            workspaceId: input.rootGrant.workspaceRoot ?? this.workspaceRoot,
            storeSnapshot: (content: string) => new ComputerExecutor(input.rootGrant.workspaceRoot ?? this.workspaceRoot).storeContentReference(content),
          },
        } : {}),
        systemPrompt: buildStepSystemPrompt(this.systemPrompt, stepTaskProfile),
        stepSemanticFrame,
        runtimeContext: recovery === undefined
          ? buildStepRuntimeContext(
            activeStep,
            plan,
            stepSkills,
            input.rootGrant.workspaceRoot ?? this.workspaceRoot,
            stepVisibleDirectories,
            stepSources,
            skillExecutionRoots,
            stepTaskProfile,
            input.conversationWorkingSet,
            decisionLedger,
          )
          : buildRecoveredStepRuntimeContext(
            activeStep,
            plan,
            stepSkills,
            input.rootGrant.workspaceRoot ?? this.workspaceRoot,
            recovery.facts,
            stepVisibleDirectories,
            stepSources,
            skillExecutionRoots,
            stepTaskProfile,
            input.conversationWorkingSet,
            decisionLedger,
          ),
        input: input.input,
        ...(input.conversationHistory === undefined ? {} : { conversationHistory: input.conversationHistory }),
        ...(recovery === undefined ? {} : {
          initialMessages: recovery.messages,
        }),
        ...(initialToolEvidence.length === 0 ? {} : { initialToolEvidence }),
        model: input.model,
        tools: input.registry,
        grant: stepGrant,
        availableSkills: stepSkills.map((skill) => ({ id: skill.id, name: skill.name, contentHash: skill.contentHash })),
        maxSteps: this.maxSteps,
        ...(this.stepExecutionStrategy === undefined ? {} : { stepExecutionStrategy: this.stepExecutionStrategy }),
        ...(lookupEvidenceStep ? {
          toolCallLimits: {
            websearch: Math.min(
              MAX_WEB_SEARCHES_PER_PLAN_STEP,
              Math.max(0, stepTaskProfile.researchPolicy?.maxSearches ?? MAX_WEB_SEARCHES_PER_PLAN_STEP),
            ),
          },
        } : {}),
        candidateRepairGraceSteps: CANDIDATE_REPAIR_GRACE_STEPS,
        ...(stepProgressPolicy === undefined ? {} : { progressPolicy: stepProgressPolicy }),
        ...(fileOutputStep
          ? { convergenceGraceSteps: DEFAULT_FILE_OUTPUT_CONVERGENCE_GRACE_STEPS }
          : {}),
        ...(lookupEvidenceStep && stepAllowsSourceSummaryCandidateConvergence(activeStep) ? {
          convergencePrompt: SOURCE_SUMMARY_CONVERGENCE_PROMPT,
          convergenceMaxOutputTokens: SOURCE_SUMMARY_CONVERGENCE_MAX_OUTPUT_TOKENS,
        } : {}),
        ...(lookupEvidenceStep
          && !stepAllowsSourceSummaryCandidateConvergence(activeStep)
          && stepUsesUploadedSourceEvidence(activeStep) ? {
            convergencePrompt: SOURCE_EVIDENCE_DELIVERY_CONVERGENCE_PROMPT,
          } : {}),
        ...(fileOutputStep ? {
          shouldConvergeAfterToolStep: (context) => shouldConvergeAfterFileEvidence(activeStep, context),
          shouldUseFinalConvergence: (context) => shouldUseFinalFileConvergence(activeStep, context),
        } : lookupEvidenceStep ? {
          shouldConvergeAfterToolStep: (context) => shouldConvergeAfterLookupEvidence(activeStep, context, input.sources),
        } : {}),
        emit: input.emit,
        signal: input.signal,
        actionTracker: {
          executeToolCall: async (toolAction, operation) => {
            let resultRef: RuntimeResultRef | undefined;
            const value = await this.actions.execute({
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
              resultFailureCode: toolOperationFailureCode,
              prepareResult: async (result, action) => {
                const runtimeResult = createRuntimeResult({
                  kind: "tool",
                  producer: {
                    actionId: action.id,
                    runId: input.runId,
                    planId: plan.id,
                    stepId: activeStep.id,
                    toolCallId: toolAction.toolCallId,
                    toolName: toolAction.toolName,
                  },
                  value: result,
                  publication: { status: "committed" },
                });
                resultRef = runtimeResult.ref;
                return runtimeResult;
              },
            }, operation);
            return { value, ...(resultRef === undefined ? {} : { resultRef }) };
          },
        },
        deferFailureReport: true,
        evaluateCandidate: async (candidate) => {
          assessmentAttempt += 1;
          const activatedStepSkills = activatedSkillsForAssessment(stepSkills, candidate.activatedSkillNames);
          const evidence: StepEvidence = {
            candidateOutput: candidate.output,
            deliveryCandidate: candidate.deliveryCandidate,
            toolCalls: mergeAssessmentToolEvidence(inheritedAssessmentToolEvidence, candidate.toolEvidence),
            modelSteps: candidate.modelSteps,
          };
          const temporalScopeGap = temporalScopeGapForCandidate(input.input, evidence.toolCalls);
          if (temporalScopeGap !== undefined) {
            const failedBoundary: FailedBoundary = {
              stepId: activeStep.id,
              missingEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
              violatedSkillRequirements: [],
              reusableEvidenceRefs: evidence.toolCalls.map((toolCall) => toolCall.toolCallId),
              suggestedRepairShape: "repair_leaf",
            };
            await input.emit({
              type: "candidate.temporal_scope_rejected",
              data: {
                planId: plan.id,
                stepId: activeStep.id,
                attempt: assessmentAttempt,
                requiredDurationDays: temporalScopeGap.requiredDurationDays,
                observedDurationDays: temporalScopeGap.observedDurationDays,
                feedback: temporalScopeGap.feedback,
                failedBoundary,
              },
            });
            await input.emit({
              type: "assessment.failed_boundary",
              data: { planId: plan.id, stepId: activeStep.id, attempt: assessmentAttempt, failedBoundary },
            });
            return { approved: false, feedback: temporalScopeGap.feedback, failedBoundary };
          }
          const holisticSourceContractMismatch = sourceContractNeedsHolisticAssessment(activeStep, evidence);
          const assessmentProfile = selectAssessmentProfile(activeStep, evidence, holisticSourceContractMismatch);
          const useProfiledRuleAssessor = input.defaultAssessmentPolicyEnabled
            && isProfiledRuleAssessmentProfile(assessmentProfile);
          const assessor = useProfiledRuleAssessor
            ? new ProfiledRuleStepAssessor(assessmentProfile)
            : input.assessor;
          const modelEvidence: StepEvidence = {
            candidateOutput: candidate.output,
            deliveryCandidate: candidate.deliveryCandidate,
            toolCalls: candidate.projectedToolEvidence,
            modelSteps: candidate.modelSteps,
          };
          const assessmentSignature = stepAssessmentSignature({
            stepId: activeStep.id,
            assessmentProfile,
            activatedSkills: activatedStepSkills,
            evidence,
            modelEvidence,
            decisionLedger,
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
                requiresEvidenceProgress: requiresEvidenceProgressAfterHolisticAssessment(
                  reusedAssessment,
                  holisticSourceContractMismatch,
                ),
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
            ...(holisticSourceContractMismatch ? { holisticSourceContractMismatch: true } : {}),
            attempt: assessmentAttempt,
            decisionLedger,
          }, input.signal, input.emit);
          const assessed = useProfiledRuleAssessor
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
          const assessment = assessDecisionBindings({ assessment: assessed, planId: plan.id, stepId: activeStep.id, ledger: decisionLedger, evidence: evidence.toolCalls });
          assessedCandidates.set(assessmentSignature, assessment);
          await this.plans.saveAssessment(assessment);
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
            requiresEvidenceProgress: requiresEvidenceProgressAfterHolisticAssessment(
              assessment,
              holisticSourceContractMismatch,
            ),
            ...(assessment.failedBoundary === undefined ? {} : { failedBoundary: assessment.failedBoundary }),
          };
        },
      });
      const evidence: StepEvidence = {
        candidateOutput: result.output,
        deliveryCandidate: result.deliveryCandidate,
        toolCalls: result.toolEvidence,
        modelSteps: result.steps,
        ...(result.completionCaveat === undefined ? {} : { completionCaveat: result.completionCaveat }),
      };
      const publication = await this.stepResults.commit({
        runId: input.runId,
        plan,
        step: activeStep,
        evidence,
      });
      plan = publication.plan;
      input.onStepChanged(undefined);
      await input.emit({
        type: "plan.step.completed",
        data: {
          planId: plan.id,
          stepId: activeStep.id,
          output: result.output,
          resultRef: publication.result.ref,
        },
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
    setActionStep?: (stepId: string | undefined) => void;
  }): Promise<void> {
    if (input.currentPlan === undefined || input.decision.planRevision === undefined) {
      throw new AppError("PLAN_NOT_ADMITTED", "Plan revision requires the persisted current Plan", 422);
    }
    const privateSkills = await this.skills.resolveForConversation(input.run.ownerUserId);
    const visibleDirectories = await this.runs.visibleDirectoriesForRun(input.run.id);
    const sources = (await this.sources.listByRun(input.run.id)).map(sourceSummary);
    const allTools = composeRunTools({
      coreTools: this.coreTools,
      sourceRepository: this.sources,
      privateSkills,
      visibleDirectories,
      uploadedSources: sources,
    });
    assertNoDuplicateTools(allTools);
    const availableToolNames = new Set(allTools
      .map((tool) => tool.name)
      .filter((name) => input.run.allowDangerousTools || !DANGEROUS_COMPUTER_TOOL_NAMES.has(name)));
    const availableToolSummaries = toolSummaries(allTools, availableToolNames);
    const taskIntent = classifyTaskIntent({
      objective: input.run.input,
      toolNames: [...availableToolNames],
      skillNames: privateSkills.map((skill) => skill.name),
    });
    const admitted = admitPlan({
      runId: input.run.id,
      proposal: input.decision.planRevision,
      availableSkills: privateSkills,
      availableToolNames,
      availableTools: availableToolSummaries,
      availableCapabilities: planningCapabilitiesFromTools(availableToolSummaries, sources),
      availableUploadedSourceIds: sources.map((source) => source.id),
      availableVisibleDirectoryIds: visibleDirectories.map((directory) => directory.id),
      taskIntent,
    });
    const proposedIds = new Set(admitted.steps.map((step) => step.id));
    const retiredStepIds = input.currentPlan.steps
      .filter((step) => step.retiredAt === undefined && !proposedIds.has(step.id))
      .map((step) => step.id);
    await this.assertRetirementHasNoUnconfirmedUnsafeEffect(input.run.id, input.currentPlan.id, retiredStepIds);
    await this.plans.validateRevision({
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
    await this.recovery.savePlanRevisionAssessment({
      decisionId: input.decision.id,
      planId: input.currentPlan.id,
      assessment,
    });
    if (!assessment.approved) {
      throw new AppError("ASSESSMENT_ERROR", "Plan Revision Assessor did not approve the recovery revision", 422);
    }
    const revised = await this.plans.revise({
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
      await this.appendRunEvent(input.run.id, {
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
    await this.recovery.admit(input.decision.id);
    if (input.action.kind === "recovery_review") await this.actions.resolveRecoveryReview(input.action.id);
    if (isEffectivelyComplete(revised)) {
      const output = finalPlanOutput(revised);
      await this.terminal.commitCompleted(input.run.id, revised.id, output);
      await this.appendRunEvent(input.run.id, {
        type: "terminal.delivery_committed",
        data: {
          runId: input.run.id,
          planId: revised.id,
          output,
          reasonCode: "plan_assessed_and_completed",
        },
      });
      await this.appendRunEvent(input.run.id, { type: "run.completed", data: { runId: input.run.id, planId: revised.id, output } });
      return;
    }

    const runWorkspaceRoot = input.run.conversationId === undefined
      ? this.workspaceRoot
      : await this.ensureConversationWorkspace(input.run.conversationId);
    const rootGrant = createCapabilityGrant({
      actorUserId: input.actorUserId,
      runId: input.run.id,
      ...(input.run.conversationId === undefined ? {} : { conversationId: input.run.conversationId }),
      depth: input.run.depth,
      workspaceRoot: runWorkspaceRoot,
      visibleDirectories,
      uploadedSources: sources,
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
        registry: new ToolRegistry(allTools, { plugins: this.toolExecutionPlugins }),
        emit: async (event) => this.appendRunEvent(input.run.id, event),
        visibleDirectories,
        sources,
        decisionLedger: decisionCommitsFromEvents(await this.runtimeEvents(input.run.id)),
        ...(input.run.conversationId === undefined
          ? {}
          : { conversationHistory: await this.conversationHistory(input.run.conversationId) }),
        onStepChanged: (stepId) => {
          runningStepId = stepId;
          input.setActionStep?.(stepId);
        },
      });
      const output = finalPlanOutput(completed);
      const reasonCode = await commitCompletedPlan(this.terminal, await this.plans.assessments(completed.id), completed, input.run.id, output);
      await this.appendRunEvent(input.run.id, {
        type: "terminal.delivery_committed",
        data: { runId: input.run.id, planId: completed.id, output, reasonCode, recovered: true },
      });
      await this.appendRunEvent(input.run.id, { type: "run.completed", data: { runId: input.run.id, planId: completed.id, output, recovered: true } });
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
        await this.plans.failStep(revised.id, runningStepId, appError.message);
        if (assessmentRepairIsExhausted(appError.details, failedBoundary) || failedBoundaryHasNoAcquisitionPath(
          revised,
          runningStepId,
          failedBoundary,
          observedReceiptShapes(
            await this.events(input.actorUserId, input.run.id),
            failedBoundary.reusableEvidenceRefs,
          ),
        )) {
          const output = await partialOutputForFailure(appError);
          if ((await this.runs.get(input.run.id))?.status !== "running") return;
          await this.terminal.commitStopped({
            runId: input.run.id,
            planId: revised.id,
            status: "failed",
            reasonCode: appError.code,
            output,
          });
          await this.appendRunEvent(input.run.id, {
            type: "run.failed",
            data: {
              runId: input.run.id,
              planId: revised.id,
              code: appError.code,
              message: appError.message,
              details: appError.details,
              recovered: true,
              ...(output === undefined ? {} : { output }),
            },
          });
          return;
        }
        await this.applyAssessmentRepair({
          actorUserId: input.actorUserId,
          run: input.run,
          currentPlan: revised,
          stepId: runningStepId,
          failedBoundary,
          feedback: stringField(appError.details, "feedback"),
          ...(appError instanceof CompletionFailure ? { failureReport: () => appError.report() } : {}),
        });
        return;
      }
      throw appError;
    }
  }

  private async applyAssessmentRepair(input: {
    actorUserId: string;
    run: RunRecord;
    currentPlan: ExecutionPlan;
    stepId: string;
    failedBoundary: FailedBoundary;
    feedback?: string;
    failureReport?: () => Promise<string>;
  }): Promise<void> {
    const action = await this.actions.requireAutomaticRepair({
      runId: input.run.id,
      planId: input.currentPlan.id,
      stepId: input.stepId,
      metadata: {
        failedBoundary: input.failedBoundary,
        ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      },
    });
    await this.appendRunEvent(input.run.id, {
      type: "run.repairing",
      data: {
        runId: input.run.id,
        planId: input.currentPlan.id,
        stepId: input.stepId,
        actionId: action.id,
        failedBoundary: input.failedBoundary,
      },
    });
    const actionScope = { planId: action.planId, stepId: action.stepId };
    const model = new ActionTrackedModel(
      this.modelFactory(this.retryReporter(input.run.id), input.run.modelKey),
      this.actions,
      input.run.id,
      () => actionScope,
    );
    const events = await this.events(input.actorUserId, input.run.id);
    const proposal = failedBoundaryRecoveryDecision(
      input.run,
      action,
      input.currentPlan,
      input.failedBoundary,
      observedReceiptShapes(events, input.failedBoundary.reusableEvidenceRefs),
    ) ?? await this.recoveryPlannerFactory(model).decide({
      runId: input.run.id,
      userInput: input.run.input,
      action,
      plan: input.currentPlan,
      failedBoundary: input.failedBoundary,
      events,
      userResponses: [],
    });
    const decision = await this.recovery.submit(input.run.id, proposal);
    try {
      if (decision.decision === "revise_plan") {
        await this.applyPlanRevisionRecovery({
          actorUserId: input.actorUserId,
          run: input.run,
          action,
          decision,
          currentPlan: input.currentPlan,
          model,
          setActionStep: (stepId) => { actionScope.stepId = stepId; },
        });
        return;
      }
      if (decision.decision === "ask_user") {
        await this.recovery.admit(decision.id, { kind: "waiting_user", question: decision.question });
        await this.appendRunEvent(input.run.id, {
          type: "run.waiting_user",
          data: {
            runId: input.run.id,
            planId: input.currentPlan.id,
            stepId: input.stepId,
            actionId: action.id,
            question: decision.question,
          },
        });
        return;
      }
      await this.recovery.admit(decision.id);
      await this.actions.resolveRecoveryReview(action.id);
      const output = await input.failureReport?.();
      if ((await this.runs.get(input.run.id))?.status !== "running") return;
      await this.terminal.commitStopped({
        runId: input.run.id,
        planId: input.currentPlan.id,
        status: "failed",
        reasonCode: "STEP_NOT_COMPLETED",
        output,
      });
      await this.appendRunEvent(input.run.id, {
        type: "run.failed",
        data: {
          runId: input.run.id,
          planId: input.currentPlan.id,
          stepId: input.stepId,
          code: "STEP_NOT_COMPLETED",
          message: "Assessment repair could not produce an admissible continuation.",
          ...(output === undefined ? {} : { output }),
        },
      });
    } catch (error) {
      await this.rejectRecoveryDecision(decision.id, error);
      const run = await this.get(input.actorUserId, input.run.id);
      if (run.status === "running") {
        const code = error instanceof AppError ? error.code : "ASSESSMENT_REPAIR_FAILED";
        const output = error instanceof CompletionFailure ? await error.report() : undefined;
        if ((await this.runs.get(input.run.id))?.status !== "running") return;
        await this.terminal.commitStopped({
          runId: input.run.id,
          planId: input.currentPlan.id,
          status: "failed",
          reasonCode: code,
          output,
        });
        await this.appendRunEvent(input.run.id, {
          type: "run.failed",
          data: {
            runId: input.run.id,
            planId: input.currentPlan.id,
            stepId: input.stepId,
            code,
            message: error instanceof Error ? error.message : "Assessment repair failed",
            ...(output === undefined ? {} : { output }),
          },
        });
      }
    }
  }

  private async assertRetirementHasNoUnconfirmedUnsafeEffect(
    runId: string,
    planId: string,
    retiredStepIds: readonly string[],
  ): Promise<void> {
    if (retiredStepIds.length === 0) return;
    const retired = new Set(retiredStepIds);
    const unsafe = (await this.actions.list(runId)).find((item) =>
      item.planId === planId
      && item.stepId !== undefined
      && retired.has(item.stepId)
      && item.kind !== "recovery_review"
      && item.replayPolicy === "unsafe"
      && this.unsafeActionNeedsEffectConfirmation(item),
    );
    if (unsafe !== undefined) {
      throw new AppError(
        "TOOL_POLICY_DENIED",
        `Plan revision cannot retire step ${unsafe.stepId} with unconfirmed unsafe Action ${unsafe.id}`,
        409,
      );
    }
  }

  private unsafeActionNeedsEffectConfirmation(action: RuntimeActionRecord): boolean {
    return action.effectState !== "not_started" && action.effectState !== "applied";
  }

  private async rejectRecoveryDecision(decisionId: string, error: unknown): Promise<void> {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : "Recovery decision admission failed";
    try {
      await this.recovery.reject(decisionId, code, message);
    } catch (rejectionError) {
      if (!(rejectionError instanceof AppError) || rejectionError.code !== "CONFLICT") throw rejectionError;
    }
  }

  private retryReporter(runId: string): ModelRetryReporter {
    return (info) =>
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
  }

  private async appendRunEvent(runId: string, event: RuntimeEvent): Promise<void> {
    const createdAt = Date.now();
    const data = this.projectRunEventDataForStorage(event);
    const projectedEvent: RuntimeEvent = { type: event.type, data };
    const seq = await this.runs.appendEvent(runId, { type: event.type, data, createdAt });
    this.eventHub.publish(runId, publicRunEvent({
      seq,
      type: event.type,
      data,
      createdAt,
    }));
    this.logRunEvent(runId, seq, projectedEvent, createdAt);
  }

  private projectRunEventDataForStorage(event: RuntimeEvent): Readonly<Record<string, unknown>> {
    if (event.type === "assistant.tool_call.committed" || event.type === "tool.planned") {
      const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
      if (!("arguments" in event.data)) return event.data;
      const projection = this.projectToolArguments(event.data.arguments);
      if (projection.argumentsRef === undefined) return event.data;
      return {
        ...event.data,
        toolCallId,
        arguments: projection.arguments,
        argumentsRef: projection.argumentsRef,
      };
    }
    if (event.type === "assistant.committed" || event.type === "assistant.streaming") {
      if (!Array.isArray(event.data.toolCalls)) return event.data;
      let changed = false;
      const toolCalls = event.data.toolCalls.map((item) => {
        const call = asRecord(item);
        if (call === undefined || !("arguments" in call)) return item;
        const projection = this.projectToolArguments(call.arguments);
        if (projection.argumentsRef === undefined) return item;
        changed = true;
        return {
          ...call,
          arguments: projection.arguments,
          argumentsRef: projection.argumentsRef,
        };
      });
      return changed ? { ...event.data, toolCalls } : event.data;
    }
    return event.data;
  }

  private projectToolArguments(argumentsValue: unknown): {
    readonly arguments: unknown;
    readonly argumentsRef?: ToolArgumentsReference;
  } {
    const serialized = serializeToolArguments(argumentsValue);
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES) return { arguments: argumentsValue };
    const reference = this.writeToolArgumentsReference(serialized);
    const projected = projectToolArgumentsValue(argumentsValue, reference, serialized);
    return { arguments: projected, argumentsRef: reference };
  }

  private writeToolArgumentsReference(serialized: string): ToolArgumentsReference {
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    const directory = resolve(this.workspaceRoot, ".agentloop", "tool-arguments", sha256.slice(0, 2));
    this.assertInsideServerWorkspace(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = resolve(directory, `${sha256}.json`);
    this.assertInsideServerWorkspace(target);
    try {
      writeFileSync(target, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return {
      schema: "agentloop.toolArgumentsReference/v1",
      path: relative(this.workspaceRoot, target),
      sha256,
      bytes: Buffer.byteLength(serialized),
      characters: serialized.length,
      previewCharacters: TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS,
    };
  }

  private async readToolArgumentsReference(toolCallId: string, ref: ToolArgumentsReference): Promise<ToolArgumentsContent> {
    const target = await resolveToolArgumentsReference(this.workspaceRoot, ref.path);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_TOOL_ARGUMENT_REFERENCE_BYTES) throw notFound("Tool arguments");
    const serialized = await fs.readFile(target, "utf8");
    if (ref.sha256 !== undefined) {
      const actual = createHash("sha256").update(serialized).digest("hex");
      if (actual !== ref.sha256) throw notFound("Tool arguments");
    }
    const argumentsValue = parseStoredToolArguments(serialized);
    return {
      toolCallId,
      arguments: argumentsValue,
      content: formatToolArgumentsContent(argumentsValue),
      path: ref.path,
      ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }),
      ...(ref.bytes === undefined ? { bytes: stat.size } : { bytes: ref.bytes }),
      ...(ref.characters === undefined ? { characters: serialized.length } : { characters: ref.characters }),
    };
  }

  private async resolveToolArgumentReferences(events: readonly StoredRunEvent[]): Promise<StoredRunEvent[]> {
    const resolved: StoredRunEvent[] = [];
    for (const event of events) {
      const data = await this.resolveToolArgumentReferencesInData(event.data);
      resolved.push(data === event.data ? event : { ...event, data });
    }
    return resolved;
  }

  private async resolveToolArgumentReferencesInData(data: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const directRef = toolArgumentsReference(data.argumentsRef);
    let next: Record<string, unknown> | undefined;
    if (directRef !== undefined) {
      next = { ...data, arguments: (await this.readToolArgumentsReference(String(data.toolCallId ?? ""), directRef)).arguments };
    }
    const toolCallsValue = (next ?? data).toolCalls;
    if (Array.isArray(toolCallsValue)) {
      let changed = false;
      const toolCalls: unknown[] = [];
      for (const item of toolCallsValue) {
        const call = asRecord(item);
        const ref = toolArgumentsReference(call?.argumentsRef);
        if (call === undefined || ref === undefined) {
          toolCalls.push(item);
          continue;
        }
        const resolved = await this.readToolArgumentsReference(String(call.id ?? ""), ref);
        toolCalls.push({ ...call, arguments: resolved.arguments });
        changed = true;
      }
      if (changed) next = { ...(next ?? data), toolCalls };
    }
    return next ?? data;
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
  "planning.extension.decision",
  "planning.skills.selected",
  "planning.turn.started",
  "planning.turn.completed",
  "context.assembled",
  "context.compaction.started",
  "context.compaction.skipped",
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
  "model.request.started",
  "model.stream.first_event",
  "model.stream.awaiting_completion",
  "model.request.completed",
  "model.request.failed",
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
  "recovery.resume_started",
  "recovery.resume_interrupted",
  "human_loop.resume_failed",
  "model.retry",
  "action.failed",
]);

function shouldLogRunEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

/** The run event API intentionally exposes provider reasoning content to its owner. */
function publicRunEvent(event: StoredRunEvent): StoredRunEvent {
  return event;
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
  addString(details, "invocation", data.invocationStatus);
  addString(details, "operation", data.operationStatus);
  addNumber(details, "exitCode", data.exitCode);
  addBoolean(details, "isError", data.isError);
  addString(details, "assessmentProfile", data.assessmentProfile);
  addString(details, "assessmentMethod", data.assessmentMethod);
  addBoolean(details, "approved", data.approved);
  addString(details, "actionId", data.actionId);
  addString(details, "requestId", data.requestId);
  addString(details, "reason", data.reason);
  addNumber(details, "attempt", data.attempt);
  addNumber(details, "maxAttempts", data.maxAttempts);
  addNumber(details, "status", data.status);
  addNumber(details, "delayMs", data.delayMs);

  if (type === "planning.started") {
    addNumber(details, "availableSkills", data.availableSkillCount);
    addNumber(details, "availableTools", data.availableToolCount);
  }
  if (type === "planning.extension.decision") {
    addString(details, "extension", data.extensionName);
    addString(details, "kind", data.kind);
    addString(details, "contextKind", data.contextKind);
    addString(details, "templateId", data.templateId);
    addNumber(details, "score", data.score);
    addNumber(details, "steps", data.stepCount);
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
  if (type === "context.compaction.skipped") {
    addNumber(details, "epoch", data.contextEpoch);
    addNumber(details, "estimatedInputTokens", data.estimatedInputTokens);
    addNumber(details, "usableInputTokens", data.usableInputTokens);
    addString(details, "reason", data.reason);
    addString(details, "code", data.code);
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
  if (
    type === "model.request.started"
    || type === "model.stream.first_event"
    || type === "model.stream.awaiting_completion"
    || type === "model.request.completed"
    || type === "model.request.failed"
  ) {
    appendModelRequestDetails(details, data);
    addString(details, "eventType", data.eventType);
    addNumber(details, "elapsedMs", data.elapsedMs);
    addNumber(details, "durationMs", data.durationMs);
    addNumber(details, "timeToFirstEventMs", data.timeToFirstEventMs);
    addNumber(details, "contentChars", data.contentLength);
    addNumber(details, "toolCalls", data.toolCallCount);
    const usage = asRecord(data.usage);
    if (usage !== undefined) {
      addNumber(details, "inputTokens", usage.inputTokens);
      addNumber(details, "outputTokens", usage.outputTokens);
    }
    const message = asString(data.message);
    if (message !== undefined && message.trim().length > 0) details.push(`message="${truncateForTerminal(message, 160)}"`);
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
    appendModelRequestDetails(details, data);
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

function appendModelRequestDetails(details: string[], data: Readonly<Record<string, unknown>>): void {
  const request = asRecord(data.request);
  if (request === undefined) return;
  addString(details, "requestPhase", request.phase);
  addString(details, "requestProtocol", request.protocol);
  addString(details, "requestModel", request.model);
  addBoolean(details, "requestStream", request.stream);
  addNumber(details, "requestTools", request.toolCount);
  addString(details, "requestToolChoice", request.toolChoice);
  addString(details, "requestPlacement", request.runtimeContextPlacement);
  addNumber(details, "requestCanonicalMessages", request.canonicalMessageCount);
  addNumber(details, "requestProviderMessages", request.providerMessageCount);
  addNumber(details, "requestProviderItems", request.providerInputItemCount);
  addBoolean(details, "requestSentinel", request.insertedEmptyInputSentinel);
}

function planningExtensionContextTelemetry(
  context: PlanningExtensionContext,
): Record<string, unknown> {
  const content = asRecord(context.content);
  return {
    contextKind: context.kind,
    ...(content?.templateId === undefined ? {} : { templateId: content.templateId }),
    ...(content?.score === undefined ? {} : { score: content.score }),
  };
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

function conversationSourceSummaryFromStep(
  runId: string,
  planId: string,
  step: ExecutionPlan["steps"][number],
): ConversationSourceSummary | undefined {
  if (step.status !== "completed" || step.evidence === undefined) return undefined;
  const candidate = parseJsonRecord(step.evidence.candidateOutput);
  if (candidate?.schema !== "agentloop.sourceSummaryCandidate/v1") {
    return conversationSourceSummaryFromReceipts(runId, planId, step);
  }
  const facts = Array.isArray(candidate.facts)
    ? candidate.facts
      .map((value): ConversationSourceFact | undefined => {
        const fact = asRecord(value);
        if (fact === undefined || typeof fact.claim !== "string" || fact.claim.trim().length === 0) return undefined;
        const sourceRefs = Array.isArray(fact.sourceRefs)
          ? fact.sourceRefs
            .map(conversationSourceReferenceFromValue)
            .filter((value): value is ConversationSourceReference => value !== undefined)
          : [];
        return {
          claim: truncateWorkingSetText(fact.claim, 240),
          sourceRefs: dedupeConversationSourceReferences(sourceRefs).slice(0, 8),
          ...(typeof fact.confidence === "string" && fact.confidence.trim().length > 0
            ? { confidence: truncateWorkingSetText(fact.confidence, 40) }
            : {}),
        };
      })
      .filter((value): value is ConversationSourceFact => value !== undefined)
      .slice(0, 6)
    : [];
  return {
    runId,
    planId,
    stepId: step.id,
    schema: "agentloop.sourceSummaryCandidate/v1",
    coveredTopics: stringArrayField(candidate.coveredTopics)
      .map((value) => truncateWorkingSetText(value, 120))
      .slice(0, 5),
    facts,
    missingOrUnverified: stringArrayField(candidate.missingOrUnverified)
      .map((value) => truncateWorkingSetText(value, 300))
      .slice(0, 8),
    ...(typeof candidate.recommendedNextStep === "string" && candidate.recommendedNextStep.trim().length > 0
      ? { recommendedNextStep: truncateWorkingSetText(candidate.recommendedNextStep, 320) }
      : {}),
  };
}

/**
 * Older completed fact leaves may have a canonical structured receipt but no
 * model-produced sourceSummaryCandidate (for example when a later leaf fails
 * before the Run can finish).  Preserve the neutral receipt facts so a later
 * turn can reuse the evidence without trusting or reconstructing model prose.
 */
function conversationSourceSummaryFromReceipts(
  runId: string,
  planId: string,
  step: ExecutionPlan["steps"][number],
): ConversationSourceSummary | undefined {
  const facts: ConversationSourceFact[] = [];
  const sourceRefs: ConversationSourceReference[] = [];
  const coveredTopics = new Set<string>();
  const missingOrUnverified = new Set<string>();
  for (const toolCall of step.evidence?.toolCalls ?? []) {
    if (toolCall.isError) continue;
    const result = parseJsonRecord(toolCall.result);
    const receipt = parseJsonRecord(result?.evidenceReceipt);
    const evidenceKinds = parseJsonRecord(receipt?.evidenceKinds ?? result?.evidenceKinds);
    if (!stringArrayField(evidenceKinds?.satisfied).some((kind) =>
      kind === "source_summary"
      || kind === "source_urls"
      || kind === "schema_summary"
      || kind === "record_counts"
      || kind === "structured_extraction_artifact"
    )) continue;
    const sourceType = typeof receipt?.sourceType === "string" ? receipt.sourceType : toolCall.toolName;
    coveredTopics.add(truncateWorkingSetText(sourceType, 120));
    const receiptRefs = Array.isArray(receipt?.sourceRefs) ? receipt.sourceRefs : [];
    for (const value of receiptRefs) {
      const ref = asRecord(value);
      if (ref === undefined) continue;
      const sourceRefId = firstNonEmptyString(ref.sourceRefId, ref.path, ref.sourceId, ref.originalName);
      const url = firstNonEmptyString(ref.url);
      if (sourceRefId !== undefined || url !== undefined) {
        sourceRefs.push({
          ...(sourceRefId === undefined ? {} : { sourceRefId: truncateWorkingSetText(sourceRefId, 180) }),
          ...(url === undefined ? {} : { url: truncateWorkingSetText(url, 500) }),
        });
      }
    }
    const receiptFacts = Array.isArray(receipt?.facts) ? receipt.facts : [];
    for (const value of receiptFacts) {
      const fact = asRecord(value);
      if (fact === undefined) continue;
      const claim = neutralReceiptFactClaim(toolCall.toolName, fact);
      if (claim === undefined) continue;
      const artifact = asRecord(fact.artifact);
      const artifactPath = firstNonEmptyString(artifact?.path);
      if (artifactPath !== undefined) sourceRefs.push({ sourceRefId: truncateWorkingSetText(artifactPath, 180) });
      facts.push({
        claim,
        sourceRefs: [{ sourceRefId: toolCall.toolCallId }],
        confidence: "receipt_backed",
      });
    }
    for (const caveat of stringArrayField(receipt?.caveats)) {
      missingOrUnverified.add(truncateWorkingSetText(caveat, 300));
    }
  }
  if (facts.length === 0 && sourceRefs.length === 0) return undefined;
  const dedupedRefs = dedupeConversationSourceReferences(sourceRefs).slice(0, 8);
  return {
    runId,
    planId,
    stepId: step.id,
    schema: "agentloop.sourceSummaryCandidate/v1",
    coveredTopics: [...coveredTopics].slice(0, 5),
    facts: facts.slice(0, 6).map((fact) => ({
      ...fact,
      sourceRefs: dedupeConversationSourceReferences([...fact.sourceRefs, ...dedupedRefs]).slice(0, 8),
    })),
    missingOrUnverified: [...missingOrUnverified].slice(0, 8),
    recommendedNextStep: "Reuse the persisted source receipt before acquiring the same source again.",
  };
}

function neutralReceiptFactClaim(toolName: string, fact: Record<string, unknown>): string | undefined {
  const kind = firstNonEmptyString(fact.kind) ?? "source evidence";
  const originalName = firstNonEmptyString(fact.originalName);
  const totalRecords = numberValue(fact.totalRecords) ?? numberValue(fact.recordCount);
  const totalRows = numberValue(fact.totalRows) ?? numberValue(fact.rowCount);
  const artifact = asRecord(fact.artifact);
  const artifactPath = firstNonEmptyString(artifact?.path);
  const parts = [
    `${toolName} recorded ${kind}`,
    originalName === undefined ? "" : `for ${originalName}`,
    totalRecords === undefined ? "" : `with ${totalRecords} record(s)`,
    totalRows === undefined ? "" : `and ${totalRows} row(s)`,
    artifactPath === undefined ? "" : `at ${artifactPath}`,
  ].filter((part) => part.length > 0);
  return parts.length === 0 ? undefined : truncateWorkingSetText(parts.join(" "), 240);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function conversationStepContext(
  runId: string,
  planId: string,
  step: ExecutionPlan["steps"][number],
): ConversationStepContext | undefined {
  if (step.status !== "completed") return undefined;
  return {
    runId,
    planId,
    stepId: step.id,
    ...(step.role === undefined ? {} : { role: step.role }),
    objective: truncateWorkingSetText(step.objective, 600),
    skillIds: step.skillIds,
    requiredCapabilities: step.requiredCapabilities,
  };
}

function conversationSourceReferenceFromValue(value: unknown): ConversationSourceReference | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return { sourceRefId: truncateWorkingSetText(value, 180) };
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const sourceRefId = typeof record.sourceRefId === "string" && record.sourceRefId.trim().length > 0
    ? truncateWorkingSetText(record.sourceRefId, 180)
    : undefined;
  const url = typeof record.url === "string" && record.url.trim().length > 0
    ? truncateWorkingSetText(record.url, 400)
    : undefined;
  const published = typeof record.published === "string" && record.published.trim().length > 0
    ? truncateWorkingSetText(record.published, 40)
    : undefined;
  const accessed = typeof record.accessed === "string" && record.accessed.trim().length > 0
    ? truncateWorkingSetText(record.accessed, 40)
    : undefined;
  if (sourceRefId === undefined && url === undefined) return undefined;
  return {
    ...(sourceRefId === undefined ? {} : { sourceRefId }),
    ...(url === undefined ? {} : { url }),
    ...(published === undefined ? {} : { published }),
    ...(accessed === undefined ? {} : { accessed }),
  };
}

function dedupeConversationSourceReferences(
  references: readonly ConversationSourceReference[],
): ConversationSourceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = reference.sourceRefId ?? reference.url ?? JSON.stringify(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function artifactSourceForPath(
  sources: ReadonlyMap<string, { toolCallId?: string; stepId?: string }>,
  artifactPath: string,
): { toolCallId?: string; stepId?: string } | undefined {
  const exact = sources.get(artifactPath);
  if (exact !== undefined) return exact;
  const normalizedArtifactPath = normalizeArtifactPath(artifactPath);
  for (const [sourcePath, source] of sources) {
    const normalizedSourcePath = normalizeArtifactPath(sourcePath);
    if (
      normalizedSourcePath === normalizedArtifactPath
      || normalizedSourcePath.endsWith(`/${normalizedArtifactPath}`)
    ) {
      return source;
    }
  }
  return undefined;
}

function artifactPathsFromToolResult(toolName: string | undefined, result: Readonly<Record<string, unknown>> | undefined): string[] {
  if (result === undefined) return [];
  if (toolName === "computer_write_file" || toolName === "computer_patch_file" || toolName === "materialize_paginated_html") {
    const path = typeof result.path === "string" ? result.path : undefined;
    return path === undefined ? [] : [normalizeArtifactPath(path)];
  }
  if (toolName === "convert_artifact") {
    const output = asRecord(result.output);
    const path = typeof output?.path === "string"
      ? output.path
      : typeof result.path === "string"
        ? result.path
        : undefined;
    return path === undefined ? [] : [normalizeArtifactPath(path)];
  }
  if (toolName !== "computer_run_command") return [];
  return [
    ...artifactPathsFromCommandFileChanges(result),
    ...(typeof result.stdout === "string" ? artifactPathsMentionedInCommandOutput(result.stdout) : []),
  ].map(normalizeArtifactPath);
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
    || (suggestedRepairShape !== "repair_leaf" && suggestedRepairShape !== "revise_plan" && suggestedRepairShape !== "ask_user" && suggestedRepairShape !== "fail")
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
  failedBoundary: FailedBoundary | undefined,
  observedShapes: ReadonlySet<ReceiptShape>,
): RecoveryDecisionProposal | undefined {
  if (failedBoundary === undefined) return undefined;
  const evidenceRefs = failedBoundary.reusableEvidenceRefs;
  const base = {
    actionId: action.id,
    expectedActionRevision: action.revision,
    evidenceRefs,
  };
  if (failedBoundary.suggestedRepairShape === "revise_plan") return undefined;
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
  if (planContractMismatchRequiresRevision(target, failedBoundary, observedShapes)) {
    return undefined;
  }
  const repairStep = repairLeafForFailedBoundary(target, failedBoundary, plan.version);
  const planRevision: PlanProposal = {
    goal: plan.goal,
    schema: "agentloop.outcomePlan/v2",
    shape: "recovery_patch",
    selectedSkillIds: plan.selectedSkillIds,
    selectedSkillRoles: [],
    steps: plan.steps
      .filter((step) => step.retiredAt === undefined)
      .flatMap((step): PlanStepProposal[] => step.id === target.id
        ? [repairStep]
        : [{
          id: step.id,
          kind: step.kind,
          ...(step.parentId === undefined ? {} : { parentId: step.parentId }),
          objective: step.objective,
          dependencies: step.dependencies.map((dependency) => dependency === target.id ? repairStep.id : dependency),
          ...(step.role === undefined ? {} : { role: step.role }),
          refinementState: step.refinementState,
          requiredFacts: step.requiredFacts,
          skillIds: step.skillIds,
          requiredCapabilities: step.requiredCapabilities,
          ...(step.evidenceContract === undefined ? {} : { evidenceContract: step.evidenceContract }),
          successCriteria: step.successCriteria,
        }]),
  };
  return {
    ...base,
    decision: "revise_plan",
    rationale: `Create a targeted repair leaf for failed assessment boundary ${target.id}; do not rerun the first-round Planner.`,
    planRevision,
  };
}

function planContractMismatchRequiresRevision(
  target: ExecutionPlan["steps"][number],
  failedBoundary: FailedBoundary,
  observedShapes: ReadonlySet<ReceiptShape>,
): boolean {
  const missing = new Set(failedBoundary.missingEvidenceKinds);
  if (
    !missing.has("source_summary")
    && !missing.has("source_urls")
    && !missing.has("schema_summary")
    && !missing.has("record_counts")
    && !missing.has("structured_extraction_artifact")
    && !missing.has("explicit_caveats")
  ) return false;
  const sourceContractKinds = new Set<FailedBoundary["missingEvidenceKinds"][number]>([
    "source_summary",
    "source_urls",
    "schema_summary",
    "record_counts",
    "structured_extraction_artifact",
    "explicit_caveats",
  ]);
  const stepRequiresSourceContract = target.evidenceContract?.requiredKinds.some((kind) => sourceContractKinds.has(kind)) === true;
  return stepRequiresSourceContract && observedShapes.has("artifact") && !observedShapes.has("source");
}

function failedBoundaryHasNoAcquisitionPath(
  plan: ExecutionPlan | undefined,
  stepId: string,
  failedBoundary: FailedBoundary,
  observedShapes: ReadonlySet<ReceiptShape>,
): boolean {
  const requiresSourceEvidence = failedBoundary.missingEvidenceKinds.some((kind) =>
    kind === "source_summary"
    || kind === "source_urls"
    || kind === "schema_summary"
    || kind === "record_counts"
    || kind === "table_coverage"
    || kind === "structured_extraction_artifact"
    || kind === "derived_aggregation",
  );
  if (
    !requiresSourceEvidence
    || plan === undefined
    || observedShapes.size > 0
    || failedBoundary.reusableEvidenceRefs.length > 0
  ) return false;
  const step = plan.steps.find((candidate) => candidate.id === stepId && candidate.retiredAt === undefined);
  if (step === undefined) return false;
  // A conversation-only binding cannot obtain the source evidence it is
  // missing. Retrying it through repair leaves would only reproduce the same
  // candidate; terminate rather than strand the Run in empty recovery.
  return step.executionBinding.sourceKinds.every((kind) => kind === "conversation_workset");
}

/**
 * An assessment repair is local to one Agent loop.  Once that loop has
 * exhausted its bounded candidate-repair budget, creating a recovery review
 * would only ask a later planner to replay already rejected work.  This is a
 * Runtime convergence fact, independent of the Skill or source domain.
 */
function assessmentRepairIsExhausted(details: unknown, failedBoundary: FailedBoundary): boolean {
  return asRecord(details)?.repairExhausted === true
    && failedBoundaryHasMissingSourceEvidence(failedBoundary);
}

function failedBoundaryHasMissingSourceEvidence(failedBoundary: FailedBoundary): boolean {
  return failedBoundary.missingEvidenceKinds.some((kind) =>
    kind === "source_summary"
    || kind === "source_urls"
    || kind === "schema_summary"
    || kind === "record_counts"
    || kind === "table_coverage"
    || kind === "structured_extraction_artifact"
    || kind === "derived_aggregation",
  );
}

interface TemporalScopeGap {
  readonly requiredDurationDays: number;
  readonly observedDurationDays: number;
  readonly feedback: string;
}

/**
 * Time coverage is neutral source metadata, not a provider- or Skill-specific
 * conclusion. A bounded source receipt may either cover the requested rolling
 * range or explicitly prove that the requested range is unavailable; a
 * shorter successful query may not silently stand in for it.
 */
function temporalScopeGapForCandidate(
  userInput: string,
  toolCalls: readonly ToolEvidence[],
): TemporalScopeGap | undefined {
  const requiredDurationDays = requestedRollingDurationDays(userInput);
  if (requiredDurationDays === undefined) return undefined;
  const coverage = toolCalls.flatMap((toolCall) => temporalCoverageFromToolResult(toolCall.result));
  if (coverage.length === 0) return undefined;
  if (coverage.some((item) => item.durationDays >= requiredDurationDays)) return undefined;
  if (coverage.some((item) => item.unavailableForDays >= requiredDurationDays)) return undefined;
  const observedDurationDays = Math.max(0, ...coverage.map((item) => item.durationDays));
  return {
    requiredDurationDays,
    observedDurationDays,
    feedback: `The user requested a rolling ${requiredDurationDays}-day source range, but the acquired source evidence covers only ${observedDurationDays} day(s). Do not present a shorter period as a substitute. Acquire evidence covering the requested range, or acquire a structured receipt that explicitly establishes that this exact range is unavailable and state only that boundary.`,
  };
}

function requestedRollingDurationDays(input: string): number | undefined {
  if (/(?:近\s*(?:一(?:个)?|1)\s*(?:月|个月)|过去\s*(?:一(?:个)?|1)\s*(?:月|个月)|近\s*30\s*天|过去\s*30\s*天|最近\s*30\s*天|\b(?:last|past|recent)\s*(?:one\s*)?month\b|\b(?:last|past|recent)\s*30\s*days?\b)/iu.test(input)) {
    return 30;
  }
  if (/(?:近\s*(?:一)?周|过去\s*(?:一)?周|近\s*7\s*天|过去\s*7\s*天|最近\s*7\s*天|\b(?:last|past|recent)\s*(?:one\s*)?week\b|\b(?:last|past|recent)\s*7\s*days?\b)/iu.test(input)) {
    return 7;
  }
  return undefined;
}

function temporalCoverageFromToolResult(value: string): readonly { durationDays: number; unavailableForDays: number }[] {
  const root = parseToolResultObject(value);
  return root === undefined ? [] : temporalCoverageFromRecord(root);
}

function temporalCoverageFromRecord(record: Readonly<Record<string, unknown>>, depth = 0): readonly { durationDays: number; unavailableForDays: number }[] {
  if (depth > 3) return [];
  const coverage = asRecord(record.temporalCoverage);
  const durationDays = typeof coverage?.durationDays === "number" && Number.isFinite(coverage.durationDays)
    ? Math.max(0, coverage.durationDays)
    : 0;
  const unavailableForDays = coverage?.fulfillment === "unavailable"
    && typeof coverage.requestedDurationDays === "number"
    && Number.isFinite(coverage.requestedDurationDays)
    ? Math.max(0, coverage.requestedDurationDays)
    : 0;
  const nested = [record.evidenceReceipt, record.stdout, record.content]
    .flatMap((value) => {
      const child = typeof value === "string" ? parseToolResultObject(value) : asRecord(value);
      return child === undefined ? [] : temporalCoverageFromRecord(child, depth + 1);
    });
  return durationDays > 0 || unavailableForDays > 0
    ? [{ durationDays, unavailableForDays }, ...nested]
    : nested;
}

type ReceiptShape = "artifact" | "source";

function observedReceiptShapes(
  events: readonly Readonly<{ type: string; data: Readonly<Record<string, unknown>> }>[],
  reusableEvidenceRefs: readonly string[],
): ReadonlySet<ReceiptShape> {
  const referencedCallIds = new Set(reusableEvidenceRefs);
  const shapes = new Set<ReceiptShape>();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const toolCallId = stringField(event.data, "toolCallId");
    if (toolCallId === undefined || !referencedCallIds.has(toolCallId)) continue;
    const result = parseToolResultObject(event.data.result);
    if (result === undefined) continue;
    const nestedReceipt = asRecord(result.evidenceReceipt ?? result.artifactReceipt);
    const schema = typeof result.schema === "string"
      ? result.schema
      : typeof nestedReceipt?.schema === "string"
        ? nestedReceipt.schema
        : undefined;
    if (schema === "agentloop.artifactReceipt/v1" || schema === "agentloop.artifactAcceptance/v1") {
      shapes.add("artifact");
    }
    if (schema === "agentloop.sourceSummary/v1") shapes.add("source");
    const evidenceKinds = asRecord(nestedReceipt?.evidenceKinds ?? result.evidenceKinds);
    const satisfiedKinds = stringArrayField(evidenceKinds?.satisfied);
    if (satisfiedKinds.some((kind) =>
      kind === "source_summary"
      || kind === "source_urls"
      || kind === "schema_summary"
      || kind === "record_counts"
      || kind === "structured_extraction_artifact"
    )) {
      shapes.add("source");
    }
    if (satisfiedKinds.some((kind) => kind.startsWith("artifact_") || kind === "delivery_receipt")) {
      shapes.add("artifact");
    }
  }
  return shapes;
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
    requiredCapabilities: target.requiredCapabilities,
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
  /** The matched Skill that declared this required companion. */
  readonly companionForSkillId?: string;
}

function bindRequiredSkillCompanions(
  proposal: PlanProposal,
  selections: readonly PlanningSkillRoleSelection[],
): PlanProposal {
  const companions = selections.filter((selection) => selection.companionForSkillId !== undefined);
  if (companions.length === 0) return proposal;
  const selected = new Set(proposal.selectedSkillIds);
  const roles = [...(proposal.selectedSkillRoles ?? [])];
  let steps = proposal.steps;
  for (const companion of companions) {
    const parentId = companion.companionForSkillId!;
    if (!selected.has(parentId)) continue;
    selected.add(companion.skill.id);
    if (!roles.some((role) => role.skillId === companion.skill.id)) roles.push(companion.selection);
    const databaseProvider = companion.skill.agentLoop?.sourceKinds.includes("database") === true;
    steps = steps.map((step) => {
      if (!step.skillIds.includes(parentId)) return step;
      const skillIds = step.skillIds.includes(companion.skill.id) ? step.skillIds : [...step.skillIds, companion.skill.id];
      const requiredCapabilities = databaseProvider
        ? step.requiredCapabilities.filter((capability) => capability !== "external_api_call" && capability !== "web_research")
        : step.requiredCapabilities;
      return { ...step, skillIds, requiredCapabilities };
    });
  }
  return {
    ...proposal,
    selectedSkillIds: [...selected],
    ...(roles.length === 0 ? {} : { selectedSkillRoles: roles }),
    steps,
  };
}

export function selectPlanningSkills(
  skills: readonly PrivateSkill[],
  taskInput: string,
  boundSkillIds: readonly string[],
  sources: readonly UploadedSourceSummary[] = [],
): PrivateSkill[] {
  return selectPlanningSkillRoles(skills, taskInput, boundSkillIds, sources).map((item) => item.skill);
}

/**
 * Tool capabilities are available to every admitted Plan under the Run grant.
 * A Skill-provided capability is available only when that same Plan selected
 * its declaring Skill, so a broad discovery catalog cannot become an implicit
 * execution authorization.
 */
function planningCapabilitiesForAdmittedProposal(
  proposal: PlanProposal,
  allSkills: readonly PrivateSkill[],
  tools: readonly PlanningToolSummary[],
  sources: readonly UploadedSourceSummary[],
) {
  const selected = new Set(proposal.selectedSkillIds);
  return [
    ...planningCapabilitiesFromTools(tools, sources),
    ...planningCapabilitiesFromSkills(allSkills.filter((skill) => selected.has(skill.id))),
  ];
}

export function selectPlanningSkillRoles(
  skills: readonly PrivateSkill[],
  taskInput: string,
  boundSkillIds: readonly string[],
  sources: readonly UploadedSourceSummary[] = [],
  evidenceDemand?: ConversationTurnResolution["evidenceDemand"],
): PlanningSkillRoleSelection[] {
  if (skills.length === 0) return [];
  // The latest turn still drives ordinary relevance, but a Skill canonically
  // bound by an accepted prior step must remain available as a *candidate*.
  // The Planner LLM receives the full history and working set and decides
  // whether this turn actually continues that prior work.
  const signal = normalizePlanningSignal(taskInput);
  // Skill relevance must use the same semantic intent classifier as planning.
  // A current-news request is source work even when it does not literally say
  // "source", "research", or "lookup".
  const sourceWorkRequested = requestsSourceWork(signal)
    || classifyTaskIntent({
      objective: taskInput,
      ...(evidenceDemand === undefined ? {} : { evidenceDemand }),
    }).sourceNeed !== "none";
  const roleBySkillId = new Map<string, SelectedSkillRole>();
  const bound = new Set(boundSkillIds);
  const sourceKinds = sourceKindsFromUploadedSources(sources);
  const requestedFileFormats = requestedPlanningFileFormats(signal);
  const roleEligibleSkills = skills.filter((skill) => {
    const selection = selectFirstRoundSkillRole(
      skill,
      signal,
      exactSkillMention(signal, skill) || bound.has(skill.id),
      sourceKinds,
      sourceWorkRequested,
    );
    if (selection === undefined) return false;
    roleBySkillId.set(skill.id, selection);
    return true;
  });
  if (roleEligibleSkills.length === 0) return [];
  const exactMatches = roleEligibleSkills.filter((skill) => exactSkillMention(signal, skill));
  if (exactMatches.length > 0) {
    return expandRequiredPlanningSkills(exactMatches.slice(0, MAX_PLANNING_SKILLS).map((skill) => ({
      skill,
      selection: roleBySkillId.get(skill.id)!,
    })), skills);
  }
  const scored = roleEligibleSkills.map((skill, index) => ({
    skill,
    index,
    semanticAffinity: scorePlanningSkillSemanticAffinity(skill, signal, bound.has(skill.id), requestedFileFormats),
    score: scorePlanningSkill(
      skill,
      signal,
      bound.has(skill.id),
      roleBySkillId.get(skill.id)!.role,
      sourceKinds,
      requestedFileFormats,
    ),
  }));
  // Artifact/source metadata establishes compatibility, not task relevance.
  // When at least one compatible Skill also matches the concrete request,
  // exclude metadata-only document/report builders so broad declarations do
  // not outrank the Skill that owns the requested operation or file format.
  const ranked = scored.some((entry) => entry.semanticAffinity > 0)
    ? scored.filter((entry) => entry.semanticAffinity > 0)
    : scored;
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const topScore = ranked[0]?.score ?? 0;
  if (topScore < MIN_PLANNING_SKILL_SCORE) {
    if (topScore < LOW_CONFIDENCE_PLANNING_SKILL_SCORE && isLowInformationPlanningSignal(signal)) return [];
    // Lexical ranking is a recall aid, not the final semantic authority. When
    // confidence is low but the request is substantive, expose a bounded set
    // of role-compatible summaries so the Planner can reason over descriptions
    // and intent examples. This avoids turning one tokenizer or domain glossary
    // into an irreversible no-Skill decision.
    const semanticReviewPool = [...scored]
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, MAX_SEMANTIC_REVIEW_SKILLS)
      .map((entry) => ({
        skill: entry.skill,
        selection: {
          ...roleBySkillId.get(entry.skill.id)!,
          reason: "Low-confidence lexical recall candidate; Planner must decide semantic relevance from the current goal and Skill intent examples.",
        },
      }));
    return expandRequiredPlanningSkills(semanticReviewPool, skills);
  }
  const secondScore = ranked[1]?.score ?? 0;
  const strongWinner = topScore - secondScore >= STRONG_WINNER_GAP;
  const candidates = ranked.filter((entry) => entry.score >= Math.max(MIN_PLANNING_SKILL_SCORE, topScore - 1));
  let selected = (strongWinner ? ranked.slice(0, 1) : candidates)
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
  return expandRequiredPlanningSkills(
    selected.map((entry) => ({ skill: entry.skill, selection: roleBySkillId.get(entry.skill.id)! })),
    skills,
  );
}

/**
 * Skill cooperation is resolved from package metadata before planning. A
 * Planner may shape work, but it must not be responsible for remembering a
 * domain Skill's declared data provider.
 */
function expandRequiredPlanningSkills(
  initial: readonly PlanningSkillRoleSelection[],
  allSkills: readonly PrivateSkill[],
): PlanningSkillRoleSelection[] {
  const byName = new Map(allSkills.map((skill) => [skill.name, skill]));
  const selected = new Map(initial.map((item) => [item.skill.id, item]));
  const visit = (item: PlanningSkillRoleSelection): void => {
    for (const name of item.skill.agentLoop?.requiredSkillNames ?? []) {
      const companion = byName.get(name);
      if (companion === undefined) {
        throw new TypeError(`Skill ${item.skill.name} requires unavailable Skill ${name}`);
      }
      if (selected.has(companion.id)) continue;
      const role = companion.agentLoop?.roles.includes("source_provider") === true
        ? "source_provider"
        : "primary_builder";
      const next: PlanningSkillRoleSelection = {
        skill: companion,
        selection: {
          skillId: companion.id,
          role,
          reason: `Required by selected Skill ${item.skill.name}.`,
        },
        companionForSkillId: item.skill.id,
      };
      selected.set(companion.id, next);
      visit(next);
    }
  };
  for (const item of initial) visit(item);
  return [...selected.values()];
}

// This is a relevance prefilter, not a capability boundary. Keep enough
// close-scoring candidates for the Planner to resolve adjacent disciplines
// (for example, a web page can need frontend design as well as implementation).
const MAX_PLANNING_SKILLS = 5;
const MAX_SEMANTIC_REVIEW_SKILLS = 12;
const MIN_PLANNING_SKILL_SCORE = 2;
const LOW_CONFIDENCE_PLANNING_SKILL_SCORE = 1;
const STRONG_WINNER_GAP = 2;

function selectFirstRoundSkillRole(
  skill: PrivateSkill,
  signal: string,
  explicitlyRequested: boolean,
  sourceKinds: ReadonlySet<string>,
  sourceWorkRequested: boolean,
): SelectedSkillRole | undefined {
  const metadata = skill.agentLoop;
  if (metadata === undefined) return undefined;
  const roles = new Set(metadata.roles);
  const artifactKinds = new Set(metadata.artifactKinds);
  if (
    roles.has("primary_builder")
    && (explicitlyRequested || matchesRequestedArtifactKind(signal, artifactKinds))
  ) {
    return {
      skillId: skill.id,
      role: "primary_builder",
      reason: "Skill metadata declares primary_builder for the requested first-round artifact boundary.",
    };
  }
  if (
    roles.has("source_provider")
    && (sourceWorkRequested || explicitlyRequested)
    && (explicitlyRequested || skillSourceKindsCompatible(metadata.sourceKinds, sourceKinds))
  ) {
    return {
      skillId: skill.id,
      role: "source_provider",
      reason: sourceWorkRequested
        ? "Skill metadata declares source_provider for requested source-grounded work."
        : "Prior completed-plan binding keeps this source_provider available as a multi-turn continuation candidate; the Planner decides whether the latest turn continues it.",
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
  return requestedArtifactKindsFromIntent(signal);
}

function requestsSourceWork(signal: string): boolean {
  return /(?:source|research|lookup|query|cite|citation|standard|policy|regulation|rating|certification|api|database|来源|调研|检索|查询|引用|标准|政策|法规|评级|认证|出处|接口|数据源)/iu.test(signal);
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

function scorePlanningSkill(
  skill: PrivateSkill,
  signal: string,
  bound: boolean,
  selectedRole: SelectedSkillRole["role"],
  sourceKinds: ReadonlySet<string>,
  requestedFileFormats: ReadonlySet<string>,
): number {
  let score = scorePlanningSkillSemanticAffinity(skill, signal, bound, requestedFileFormats);
  const text = planningSkillSemanticText(skill);
  if (requestsArtifactBuild(signal)) {
    if (matchesRequestedArtifactKind(signal, new Set(skill.agentLoop?.artifactKinds ?? []))) score += 4;
    if (isPrimaryArtifactBuilderSkill(text)) score += 3;
    if (isStylingSupportSkill(text) && !explicitStylingRequested(signal)) score -= 4;
  }
  // Source compatibility may rank source providers because their job is to
  // acquire the bound input. It must never rank a primary builder: the current
  // goal and requested output own that selection, not the uploaded format.
  if (selectedRole === "source_provider" && !bound && !exactSkillMention(signal, skill) && sourceKinds.size > 0) {
    const skillSourceKinds = skill.agentLoop?.sourceKinds ?? [];
    if (skillSourceKinds.some((kind) => sourceKinds.has(kind))) {
      score += 3;
    } else if (skillSourceKinds.length > 0) {
      score -= 5;
    }
  }
  return score;
}

function scorePlanningSkillSemanticAffinity(
  skill: PrivateSkill,
  signal: string,
  bound: boolean,
  requestedFileFormats: ReadonlySet<string>,
): number {
  const text = planningSkillSemanticText(skill);
  const signalTokens = tokenizePlanningSignal(signal);
  const textTokens = new Set(tokenizePlanningSignal(text));
  let score = bound ? 5 : 0;
  for (const alias of planningSkillAliases(skill)) {
    if (alias.length > 0 && signal.includes(alias)) score += alias.length >= 6 ? 4 : 3;
  }
  let tokenOverlapScore = 0;
  for (const token of signalTokens) {
    if (!textTokens.has(token)) continue;
    tokenOverlapScore += token.length >= 6 ? 2 : 1;
  }
  score += Math.min(tokenOverlapScore, 8);
  score += scoreCjkSubphrases(signalTokens, textTokens);
  if (exactSkillMention(signal, skill)) score += 8;
  for (const format of requestedFileFormats) {
    score += scorePlanningFileFormatOwnership(skill, text, format);
  }
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
  return score;
}

function requestedPlanningFileFormats(
  signal: string,
): Set<string> {
  const formats = new Set<string>();
  for (const match of signal.matchAll(/\.([a-z0-9]{2,8})(?=$|[^a-z0-9])/giu)) {
    formats.add(canonicalArtifactFormatFamily(match[1]));
  }
  return formats;
}

function scorePlanningFileFormatOwnership(
  skill: PrivateSkill,
  skillText: string,
  format: string,
): number {
  if (canonicalArtifactFormatFamily(skill.name) === format) return 12;
  if (format === "word") {
    return /(?:^|[^a-z0-9])(?:\.?docx?|word)(?:$|[^a-z0-9])/iu.test(skillText) ? 6 : 0;
  }
  const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])\\.?${escaped}(?:$|[^a-z0-9])`, "iu").test(skillText) ? 6 : 0;
}

function skillSourceKindsCompatible(
  skillSourceKinds: readonly string[],
  sourceKinds: ReadonlySet<string>,
): boolean {
  if (sourceKinds.size === 0 || skillSourceKinds.length === 0) return true;
  return skillSourceKinds.some((kind) => sourceKinds.has(kind));
}

function sourceKindsFromUploadedSources(sources: readonly UploadedSourceSummary[]): Set<string> {
  const kinds = new Set<string>();
  for (const source of sources) {
    if (source.status !== "ready") continue;
    const extension = source.extension.toLowerCase();
    const mimeType = source.mimeType.toLowerCase();
    const name = source.originalName.toLowerCase();
    if (
      [".xlsx", ".xlsm", ".xls", ".csv", ".tsv", ".json"].includes(extension)
      || /(?:spreadsheet|excel|csv|json|tab-separated|comma-separated)/iu.test(mimeType)
    ) {
      kinds.add("dataset");
    }
    if (
      [".docx", ".doc", ".pdf", ".md", ".markdown", ".txt"].includes(extension)
      || /(?:wordprocessingml|msword|pdf|markdown|plain)/iu.test(mimeType)
    ) {
      kinds.add("document");
    }
    if (extension === ".sql" || /(?:database|sql|sqlite)/iu.test(mimeType) || /\.(?:sqlite|db)$/iu.test(name)) {
      kinds.add("database");
    }
  }
  return kinds;
}

function requestsHtmlPresentation(signal: string): boolean {
  return /(?:\bhtml[-_ ]?ppt\b|\bhtml[-_ ]?(?:presentation|slides?|deck)\b|\b(?:presentation|slides?|deck)[-_ ]?html\b|html.{0,24}(?:演示|课件|幻灯片)|(?:演示|课件|幻灯片).{0,24}html)/iu.test(signal);
}

function requestsArtifactBuild(signal: string): boolean {
  return requestsArtifactBuildFromIntent(signal);
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
    || /(?:build-dashboard|dashboard|report|document|pdf|docx?|word|xlsx|canvas|image|visual|poster|artwork|artifact).{0,160}(?:build|create|generate|produce|render|export|write|design|构建|创建|生成|渲染|导出|写入|设计)/iu.test(text)
    || /(?:build|create|generate|produce|render|export|write|design|构建|创建|生成|渲染|导出|写入|设计).{0,160}(?:canvas|image|visual|poster|artwork|artifact|dashboard|report|document|pdf|docx?|word|xlsx)/iu.test(text);
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
    ...(skill.agentLoop?.semanticTags ?? []),
  ];
  return [...new Set(aliases.map(normalizePlanningSignal).filter(Boolean))];
}

function planningSkillSemanticText(skill: PrivateSkill): string {
  return normalizePlanningSignal([
    skill.name,
    skill.description,
    ...(skill.agentLoop?.semanticTags ?? []),
  ].join("\n"));
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
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const cjkPlanningStopwords = new Set([
  "查询", "了解", "相关", "信息", "这个", "那个", "哪些", "什么", "怎么",
  "为什么", "一下", "进行", "需要", "帮我", "请问",
]);

const cjkPlanningSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh", { granularity: "word" })
  : undefined;

function tokenizePlanningSignal(value: string): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "into", "this", "that", "you", "your",
    "please", "help", "need", "make", "create", "build", "task", "work", "more",
    "a", "an", "to", "of", "in", "on", "at", "by", "or", "is", "are", "be",
  ]);
  const tokens: string[] = [];
  for (const rawToken of value.match(/[\u3400-\u9fff]+|[\p{L}\p{N}]+/gu) ?? []) {
    const token = rawToken.trim();
    if (token.length === 0) continue;
    if (/[\u4e00-\u9fff]/.test(token)) {
      tokens.push(token, ...extractCjkPlanningPhrases(token));
      continue;
    }
    if (token.length <= 2 || stopwords.has(token)) continue;
    tokens.push(token);
  }
  return [...new Set(tokens)];
}

function extractCjkPlanningPhrases(token: string): string[] {
  const phrases: string[] = [];
  for (const run of token.match(/[\u4e00-\u9fff]+/gu) ?? []) {
    phrases.push(run);
    const words = segmentCjkPlanningWords(run);
    phrases.push(...words);
    for (let start = 0; start < words.length; start += 1) {
      for (let size = 2; size <= 4 && start + size <= words.length; size += 1) {
        phrases.push(words.slice(start, start + size).join(""));
      }
    }
    // Intl.Segmenter is intentionally dictionary-light and can split domain
    // terms into single characters. Character n-grams preserve neutral lexical
    // evidence without teaching Runtime that any particular term owns a domain.
    for (let size = 2; size <= 3; size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        phrases.push(run.slice(start, start + size));
      }
    }
  }
  return [...new Set(phrases.filter(isInformativeCjkPlanningPhrase))];
}

function isLowInformationPlanningSignal(signal: string): boolean {
  const compact = signal.replace(/[\s。.!！?？,，;；]+/gu, "");
  return /^(?:继续|继续处理|接着|接着做|好的?|可以|行|嗯|收到|ok|okay|continue|goon)$/iu.test(compact);
}

function segmentCjkPlanningWords(run: string): string[] {
  if (cjkPlanningSegmenter === undefined) return [];
  const words: string[] = [];
  for (const segment of cjkPlanningSegmenter.segment(run)) {
    if (!segment.isWordLike) continue;
    const word = segment.segment.trim();
    if (word.length > 0) words.push(word);
  }
  return words;
}

function isInformativeCjkPlanningPhrase(phrase: string): boolean {
  return phrase.length >= 2 && !cjkPlanningStopwords.has(phrase);
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

  requestLogContext(invocation: ModelInvocation, stream: boolean): ModelRequestLogContext | undefined {
    return this.model.requestLogContext?.(invocation, stream);
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
): PlanningToolSummary[] {
  return tools
    .filter((tool) => allowedToolNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      dangerous: DANGEROUS_COMPUTER_TOOL_NAMES.has(tool.name),
      ...(tool.source === undefined ? {} : { source: tool.source }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

async function planningWorkspaceFacts(
  workspaceRoot: string,
  visibleDirectories: readonly VisibleDirectoryGrant[],
  conversationId: string | undefined,
  sources: readonly UploadedSourceSummary[] = [],
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
      sourceCount: sources.length,
      guidance: entries.length === 0 && visibleDirectories.length === 0 && sources.length === 0
        ? "The workspace is empty and has no visible external directories or uploaded sources. Do not create a workspace inspection Plan step unless the user asks to inspect an existing project; plan direct artifact creation when file-writing tools are available."
        : "Use these workspace facts as planning context. Create an inspection Plan step only when existing files or visible directories must be understood to satisfy the user request.",
    };
  } catch (error) {
    return {
      schema: "planning.workspaceFacts/v1",
      kind: conversationId === undefined ? "workspace_root" : "conversation_workspace",
      rootLabel: conversationId === undefined ? "configured workspace root" : "conversation workspace",
      state: "unavailable",
      visibleDirectoryCount: visibleDirectories.length,
      sourceCount: sources.length,
      guidance: `Workspace facts could not be read before planning: ${error instanceof Error ? error.message : "unknown error"}. Create an inspection step only if the user request depends on workspace contents.`,
    };
  }
}

async function commitCompletedPlan(
  terminal: TerminalCommitter,
  assessments: readonly SkillComplianceAssessment[],
  plan: ExecutionPlan,
  runId: string,
  output: string,
): Promise<string> {
  const reasonCode = completionCaveatReasonCode(plan, assessments);
  if (reasonCode === undefined) {
    await terminal.commitCompleted(runId, plan.id, output);
    return "plan_assessed_and_completed";
  }
  await terminal.commitCompletedWithCaveats(runId, plan.id, output, reasonCode);
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
  if ([...latestByStep.values()].some((assessment) =>
    assessment.decisionBindings?.some((binding) => binding.status === "conflict" && !binding.blocking)
  )) {
    return "completed_with_decision_binding_conflict";
  }
  if ([...latestByStep.values()].some((assessment) =>
    assessment.criteria.some((criterion) => (criterion.status === "unverified" || criterion.status === "conflict") && !criterion.blocking)
  )) {
    return "completed_with_unverified_quality";
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

function requiresEvidenceProgressAfterHolisticAssessment(
  assessment: SkillComplianceAssessment,
  holisticSourceContractMismatch: boolean,
): boolean {
  return holisticSourceContractMismatch
    && assessment.assessmentMethod === "model"
    && !assessment.approved
    && assessment.failedBoundary?.suggestedRepairShape === "repair_leaf"
    && (assessment.failedBoundary?.missingEvidenceKinds.length ?? 0) > 0;
}

function shouldCompleteWithEvidenceBoundary(input: {
  assessment: SkillComplianceAssessment;
  assessmentAttempt: number;
  step: ExecutionPlan["steps"][number];
  evidence: StepEvidence;
}): boolean {
  if (input.assessment.approved) return false;
  if (!stepNeedsReusableSourceEvidence(input.step) && !stepUsesExternalSourceTools(input.step)) return false;
  if (stepRequiresFileOutput(input.step) && artifactExtensionsProducedByEvidence(input.evidence.toolCalls).size === 0) {
    return false;
  }
  const boundaryText = [
    input.step.objective,
    ...input.step.successCriteria.map((criterion) => criterion.description),
    input.evidence.candidateOutput,
    input.assessment.feedback,
    ...input.assessment.criteria.map((criterion) => criterion.rationale),
  ].join("\n");
  if (
    input.step.evidenceContract?.caveatPolicy === "strict_fail_on_missing_source"
    || requiresStrictExternalSourceCompletion(boundaryText)
  ) return false;
  if (!acknowledgesEvidenceBoundary(boundaryText)) return false;
  // A pure delivery leaf with no source-acquisition capability cannot change
  // the evidence state on another model turn. Accept its honest bounded result
  // immediately instead of manufacturing an unresolvable rejection loop.
  if (deliveryStepHasNoSourceAcquisitionPath(input.step)) return true;
  if (input.assessmentAttempt < 2) return false;
  if (!stepUsesExternalSourceTools(input.step)) return false;
  if (!hasSuccessfulExternalSourceEvidence(input.evidence.toolCalls)) return false;
  return hasUnavailableExternalSourceEvidence(input.evidence.toolCalls)
    || acknowledgesMissingSourceFacts(boundaryText);
}

function deliveryStepHasNoSourceAcquisitionPath(step: ExecutionPlan["steps"][number]): boolean {
  if (step.role !== "deliver") return false;
  const sourceTools = stepResolvedToolNames(step).filter((name) =>
    /(?:search|fetch|query|read|list|find|inspect|source|browser|http)/iu.test(name)
  );
  return sourceTools.length === 0
    && step.executionBinding.sourceKinds.every((kind) => kind === "conversation_workset");
}

function stepNeedsReusableSourceEvidence(step: ExecutionPlan["steps"][number]): boolean {
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return requiredKinds.some((kind) =>
    kind === "source_summary"
    || kind === "source_urls"
    || kind === "schema_summary"
    || kind === "record_counts"
    || kind === "table_coverage"
    || kind === "structured_extraction_artifact"
    || kind === "derived_aggregation"
    || kind === "explicit_caveats"
  );
}

function stepUsesExternalSourceTools(step: ExecutionPlan["steps"][number]): boolean {
  return stepHasSourceKind(step, "web");
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
  // A repair limit only bounds retries. It must never override an Assessment
  // rejection: deferred-validation and evidence-boundary completion are
  // explicit, separately classified outcomes.
  return assessment.approved;
}

/**
 * Extra tool-enabled steps granted to file-producing Skills after the agent's
 * primary `maxSteps` budget. A generative workflow (write script → run render →
 * verify output) is routinely one render call away when the budget runs out;
 * this grace keeps the chain advancing to a real artifact instead of forcing a
 * premature convergence candidate.
 */
/** Default additional model-turn budget for a file-producing Plan step. */
export const DEFAULT_FILE_OUTPUT_CONVERGENCE_GRACE_STEPS = 12;
const CANDIDATE_REPAIR_GRACE_STEPS = 4;
const MAX_WEB_SEARCHES_PER_PLAN_STEP = 3;
const SOURCE_SUMMARY_CONVERGENCE_MAX_OUTPUT_TOKENS = 4_096;
const SOURCE_SUMMARY_CONVERGENCE_PROMPT = [
  "<runtime_source_summary_convergence>",
  "This is the final model step for a source/fact acquisition leaf.",
  "No execution tools are available on this turn.",
  "Use only the canonical tool evidence already present in the conversation.",
  "Return one concise JSON object with schema agentloop.sourceSummaryCandidate/v1.",
  "Required keys: schema, coveredTopics, facts, missingOrUnverified, recommendedNextStep.",
  "coveredTopics must contain at most 5 short strings.",
  "facts must contain at most 6 objects with claim, sourceRefs, and confidence.",
  "Each claim must be at most 160 Chinese characters or 80 English words.",
  "Use sourceRefs/toolCallIds instead of raw excerpts. Put unknown or weakly supported items in missingOrUnverified.",
  "The model context may show structured evidence projections instead of raw file bodies; that means the Runtime has preserved the full canonical tool evidence, not that the read failed.",
  "Do not wrap the JSON in markdown fences.",
  "Do not write the final user-facing report here; produce a bounded source summary for the next Plan leaf.",
  "Do not request or emit tool calls.",
  "</runtime_source_summary_convergence>",
].join("\n");
const SOURCE_EVIDENCE_DELIVERY_CONVERGENCE_PROMPT = [
  "<runtime_source_evidence_convergence>",
  "No execution tools are available on this turn.",
  "The Runtime has determined that the current source evidence is sufficient for a completion candidate.",
  "Use only the canonical tool evidence already present in the conversation.",
  "Produce the requested user-facing answer for the current Plan step, with explicit caveats for any missing or unverified facts.",
  "Do not call read_source again for chunks already covered.",
  "This response is only a candidate: the independent assessor and Terminal Committer remain authoritative.",
  "</runtime_source_evidence_convergence>",
].join("\n");
function skillRequiresFileOutput(skill: Pick<PrivateSkill, "agentLoop">): boolean {
  return skill.agentLoop?.executionProfiles?.includes("local_script") === true
    || skill.agentLoop?.artifactKinds.some((kind) => kind !== "none") === true;
}

function stepRequiresFileOutput(step: ExecutionPlan["steps"][number]): boolean {
  if (step.role === "fact_acquisition") return false;
  return artifactExtensionsRequiredByStep(step).size > 0
    || stepUsesTool(step, (name) =>
      name === "computer_write_file" || name === "computer_patch_file" || name === "computer_run_command" || name === "materialize_paginated_html"
    );
}

function stepAllowsSkillFileOutput(step: ExecutionPlan["steps"][number]): boolean {
  if (step.role === "fact_acquisition") return false;
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return requiredKinds.some((kind) =>
    kind === "artifact_path"
    || kind === "artifact_non_empty"
    || kind === "artifact_openable"
    || kind === "format_matches_request"
    || kind === "artifact_acceptance"
  );
}

function stepCanConvergeFromLookupEvidence(step: ExecutionPlan["steps"][number]): boolean {
  const resolvedToolNames = stepResolvedToolNames(step);
  return resolvedToolNames.length > 0
    && resolvedToolNames.every((name) => isLookupToolName(name));
}

function shouldConvergeAfterLookupEvidence(
  step: ExecutionPlan["steps"][number],
  context: ToolStepConvergenceContext,
  sources: readonly UploadedSourceSummary[] = [],
): { converge: boolean; reason?: string } {
  // A fact-acquisition step may carry workspace-write capability solely because
  // its authorized extractor materializes a durable evidence artifact.  That
  // capability must not prevent convergence once a complete, structured
  // extraction receipt exists: continuing to offer the full tool catalog lets
  // the model re-read the same source instead of persisting a cross-turn
  // source-summary candidate.
  const sourceSummaryCandidateStep = stepAllowsSourceSummaryCandidateConvergence(step);
  const requiresSourceSummary = stepRequiresSourceSummary(step);
  if (!stepCanConvergeFromLookupEvidence(step) && !requiresSourceSummary) return { converge: false };
  const latestSuccessfulLookupEvidence = context.latestToolEvidence
    .filter((item) => !item.isError && isLookupToolName(item.toolName));
  if (latestSuccessfulLookupEvidence.length === 0) return { converge: false };

  const successfulLookupEvidence = context.toolEvidence
    .filter((item) => !item.isError && isLookupToolName(item.toolName));
  const webSearchCount = successfulLookupEvidence.filter((item) => item.toolName === "websearch").length;
  const webFetchCount = successfulLookupEvidence.filter((item) => item.toolName === "webfetch").length;
  const webStep = stepHasSourceKind(step, "web");
  const requiresContentRead = stepUsesTool(step, (name) => isSourceContentReadToolName(name));
  const sourceReadKeys = lookupSourceReadKeys(successfulLookupEvidence);
  const sourceReadCount = sourceReadKeys.size;
  const minimumSourceReads = minimumSourceReadsForLookupStep(step, successfulLookupEvidence);
  if (!requiresSourceSummary && webSearchCount >= MAX_WEB_SEARCHES_PER_PLAN_STEP) {
    return { converge: true, reason: "lookup_evidence_ready:websearch_limit" };
  }
  if (requiresContentRead && latestVisibleSourceReadHasContinuation(latestSuccessfulLookupEvidence)) {
    return { converge: false };
  }
  if (
    requiresSourceSummary
    && hasSatisfiedEvidenceKind(successfulLookupEvidence, "source_summary")
    && hasCompleteStructuredExtractionEvidence(successfulLookupEvidence)
  ) {
    return { converge: true, reason: "lookup_evidence_ready:complete_structured_extraction" };
  }
  if (stepUsesUploadedSourceEvidence(step)) {
    const coverage = uploadedSourceCoverageSummary(successfulLookupEvidence, sources);
    if (coverage.knownSourceCount > 0) {
      if (coverage.incompleteSourceCount === 0 && coverage.completeSourceCount > 0) {
        return { converge: true, reason: "lookup_evidence_ready:uploaded_source_coverage_complete" };
      }
      if (
        coverage.coveredChunkCount > 0
        && latestUploadedSourceReadAddsNoNewChunks(context.toolEvidence, context.latestToolEvidence)
      ) {
        return { converge: true, reason: "lookup_evidence_ready:repeat_source_chunks" };
      }
      if (coverage.totalChunkCount <= MAX_UPLOADED_SOURCE_FULL_COVERAGE_CONVERGENCE_CHUNKS) {
        return { converge: false };
      }
    }
  }
  if (requiresSourceSummary) {
    if (!hasSatisfiedEvidenceKind(successfulLookupEvidence, "source_summary")) {
      return { converge: false };
    }
    if (requiresContentRead && sourceReadCount < minimumSourceReads) {
      if (
        sourceReadCount >= 3
        && latestSourceReadAddsNoNewSources(context.toolEvidence, context.latestToolEvidence)
      ) {
        return { converge: true, reason: "lookup_evidence_ready:repeat_source_reads" };
      }
      return { converge: false };
    }
    return { converge: true, reason: "lookup_evidence_ready:bounded_source_reads" };
  }
  if (!webStep && successfulLookupEvidence.length >= 1) {
    if (
      requiresContentRead
      && sourceReadCount >= 3
      && latestSourceReadAddsNoNewSources(context.toolEvidence, context.latestToolEvidence)
    ) {
      return { converge: true, reason: "lookup_evidence_ready:repeat_source_reads" };
    }
    if (requiresContentRead && sourceReadCount < minimumSourceReads) {
      return { converge: false };
    }
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
  if (stepRequiresArtifactAcceptance(step) && !hasSuccessfulArtifactAcceptance(context.toolEvidence)) {
    return { converge: false };
  }
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

function shouldUseFinalFileConvergence(
  step: ExecutionPlan["steps"][number],
  context: ToolStepConvergenceContext,
): boolean {
  return !stepRequiresArtifactAcceptance(step) || hasSuccessfulArtifactAcceptance(context.toolEvidence);
}

function stepRequiresArtifactAcceptance(step: ExecutionPlan["steps"][number]): boolean {
  return stepHasTool(step, "verify_artifact_acceptance")
    || (step.evidenceContract?.requiredKinds.includes("artifact_acceptance") ?? false);
}

function hasSuccessfulArtifactAcceptance(evidence: readonly AgentLoopToolEvidence[]): boolean {
  return evidence.some((item) => {
    if (item.isError || item.toolName !== "verify_artifact_acceptance") return false;
    const acceptance = parseToolResult(item.result);
    if (!isPlainRecord(acceptance) || acceptance.schema !== "agentloop.artifactAcceptance/v1") return false;
    const evidenceKinds = acceptance.evidenceKinds;
    return isPlainRecord(evidenceKinds)
      && Array.isArray(evidenceKinds.satisfied)
      && evidenceKinds.satisfied.includes("artifact_acceptance");
  });
}

function stepAllowsFileArtifactConvergence(step: ExecutionPlan["steps"][number]): boolean {
  const text = [
    step.id,
    step.objective,
    ...step.successCriteria.flatMap((criterion) => [criterion.id, criterion.description]),
  ].join("\n").toLowerCase();
  const productionIntent =
    /\b(?:create|generate|write|build|rebuild|export|save|produce|output|materialize|render)\b/i.test(text)
    || /(?:生成|创建|制作|写入|构建|重建|导出|保存|输出|产出|渲染)/u.test(text);
  const verificationIntent =
    /\b(?:verify|validate|check|inspect|review|qa|quality|compare|readback)\b/i.test(text)
    || /(?:验证|校验|检查|审查|终检|验收|质量|对比|问题清单)/u.test(text);
  if (!productionIntent && verificationIntent) return false;
  const productionTool = stepUsesTool(step, (name) =>
    name === "computer_write_file" || name === "computer_patch_file" || name === "materialize_paginated_html" || name === "convert_artifact"
  );
  if (productionTool) return true;
  if (!productionIntent) return false;
  const onlyCommandOrLookup = stepResolvedToolNames(step).every((name) =>
    name === "computer_run_command" || isLookupToolName(name) || name === "load_skill"
  );
  if (verificationIntent && onlyCommandOrLookup && !/\b(?:build|rebuild|export|save|write|generate|create|produce|output)\b/i.test(text)
    && !/(?:生成|创建|制作|写入|构建|重建|导出|保存|输出|产出)/u.test(text)) {
    return false;
  }
  return true;
}

const ARTIFACT_EXTENSIONS = new Set([
  "csv", "doc", "docx", "gif", "html", "jpeg", "jpg", "json", "md", "pdf", "png",
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
      && item.toolName !== "computer_patch_file"
      && item.toolName !== "materialize_paginated_html"
      && item.toolName !== "convert_artifact"
      && item.toolName !== "computer_list_directory"
      && item.toolName !== "computer_run_command"
    ) continue;
    const parsed = parseToolResult(item.result);
    if (
      (item.toolName === "computer_write_file" || item.toolName === "computer_patch_file" || item.toolName === "materialize_paginated_html")
      && isPlainRecord(parsed)
      && typeof parsed.path === "string"
    ) {
      addArtifactExtensions(extensions, parsed.path);
    }
    if (item.toolName === "convert_artifact" && isPlainRecord(parsed)) {
      const output = asRecord(parsed.output);
      if (typeof output?.path === "string") addArtifactExtensions(extensions, output.path);
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
    if (item.toolName === "computer_run_command" && isPlainRecord(parsed)) {
      for (const path of artifactPathsFromCommandFileChanges(parsed)) {
        addArtifactExtensions(extensions, path);
      }
    }
  }
  return extensions;
}

function isLookupToolName(name: string): boolean {
  if (name === "websearch" || name === "webfetch") return true;
  if (
    name === "visible_find_files"
    || name === "visible_index_directory"
    || name === "visible_extract_tables"
    || name === "extract_source_tables"
    || name === "visible_search_text"
    || name === "visible_read_file"
    || name === "visible_read_files"
    || name === "visible_list_directory"
  ) return true;
  return /(?:^|_)(read|list|find|index|search|fetch|inspect|get|query)(?:_|$)/i.test(name);
}

function isSourceContentReadToolName(name: string): boolean {
  return name === "webfetch"
    || name === "extract_source_tables"
    || name === "visible_read_file"
    || name === "visible_read_files"
    || name === "visible_extract_tables"
    || /(?:^|_)read_(?:file|files|source|sources)(?:_|$)/i.test(name);
}

function stepRequiresSourceSummary(step: ExecutionPlan["steps"][number]): boolean {
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return requiredKinds.includes("source_summary")
    || requiredKinds.includes("schema_summary")
    || requiredKinds.includes("record_counts")
    || requiredKinds.includes("structured_extraction_artifact");
}

function stepUsesUploadedSourceEvidence(step: ExecutionPlan["steps"][number]): boolean {
  return stepHasSourceKind(step, "uploaded_source") && stepRequiresSourceSummary(step);
}

function stepAllowsSourceSummaryCandidateConvergence(step: ExecutionPlan["steps"][number]): boolean {
  return step.role === "fact_acquisition" && stepRequiresSourceSummary(step);
}

function minimumSourceReadsForLookupStep(
  step: ExecutionPlan["steps"][number],
  evidence: readonly AgentLoopToolEvidence[],
): number {
  if (!stepUsesTool(step, (name) => isSourceContentReadToolName(name))) return 0;
  // Any step that promises a source summary must read a bounded set of
  // distinct source bodies before tools are withdrawn. Final delivery leaves
  // are just as vulnerable to premature convergence as fact-acquisition
  // leaves; their role must not weaken the evidence boundary.
  const defaultMinimum = stepRequiresSourceSummary(step) ? 5 : 1;
  const discovered = discoveredSourceCount(evidence);
  if (discovered === undefined) return defaultMinimum;
  return Math.max(1, Math.min(defaultMinimum, discovered));
}

interface UploadedSourceCoverageSummary {
  readonly knownSourceCount: number;
  readonly completeSourceCount: number;
  readonly incompleteSourceCount: number;
  readonly coveredChunkCount: number;
  readonly totalChunkCount: number;
  readonly repeatedChunkReadCount: number;
}

interface MutableUploadedSourceCoverage {
  totalChunks?: number;
  readonly coveredChunks: Set<number>;
  repeatedChunkReadCount: number;
}

function uploadedSourceCoverageSummary(
  evidence: readonly AgentLoopToolEvidence[],
  sources: readonly UploadedSourceSummary[] = [],
): UploadedSourceCoverageSummary {
  const bySource = new Map<string, MutableUploadedSourceCoverage>();
  for (const source of sources) {
    if (source.status !== "ready" || source.chunkCount <= 0) continue;
    bySource.set(source.id, { totalChunks: source.chunkCount, coveredChunks: new Set(), repeatedChunkReadCount: 0 });
  }
  for (const item of evidence) {
    if (item.isError || item.toolName !== "read_source") continue;
    const parsed = parseJsonRecord(item.result);
    if (parsed === undefined || parsed.schema !== "agentloop.uploadedSourceRead/v1") continue;
    const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId : undefined;
    if (sourceId === undefined || sourceId.trim().length === 0) continue;
    const current = bySource.get(sourceId) ?? { coveredChunks: new Set<number>(), repeatedChunkReadCount: 0 };
    const totalChunks = numberValue(parsed.totalChunks);
    if (totalChunks !== undefined) current.totalChunks = totalChunks;
    for (const chunkIndex of uploadedSourceChunkIndexes(parsed)) {
      if (current.coveredChunks.has(chunkIndex)) current.repeatedChunkReadCount += 1;
      current.coveredChunks.add(chunkIndex);
    }
    bySource.set(sourceId, current);
  }
  const ledgers = [...bySource.values()].filter((item) => item.totalChunks !== undefined || item.coveredChunks.size > 0);
  let completeSourceCount = 0;
  let coveredChunkCount = 0;
  let totalChunkCount = 0;
  let repeatedChunkReadCount = 0;
  for (const ledger of ledgers) {
    const totalChunks = ledger.totalChunks ?? ledger.coveredChunks.size;
    coveredChunkCount += ledger.coveredChunks.size;
    totalChunkCount += totalChunks;
    repeatedChunkReadCount += ledger.repeatedChunkReadCount;
    if (totalChunks > 0 && ledger.coveredChunks.size >= totalChunks) completeSourceCount += 1;
  }
  return {
    knownSourceCount: ledgers.length,
    completeSourceCount,
    incompleteSourceCount: ledgers.length - completeSourceCount,
    coveredChunkCount,
    totalChunkCount,
    repeatedChunkReadCount,
  };
}

function uploadedSourceChunkIndexes(parsed: Record<string, unknown>): Set<number> {
  const indexes = new Set<number>();
  const chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
  for (const chunk of chunks) {
    const record = parseJsonRecord(chunk);
    const chunkIndex = numberValue(record?.chunkIndex);
    if (chunkIndex !== undefined) indexes.add(chunkIndex);
  }
  const receipt = parseJsonRecord(parsed.evidenceReceipt);
  const refs = Array.isArray(receipt?.sourceRefs) ? receipt.sourceRefs : [];
  for (const ref of refs) {
    const record = parseJsonRecord(ref);
    const chunkIndex = numberValue(record?.chunkIndex);
    if (chunkIndex !== undefined) indexes.add(chunkIndex);
  }
  const facts = Array.isArray(receipt?.facts) ? receipt.facts : [];
  for (const fact of facts) {
    const record = parseJsonRecord(fact);
    const returned = Array.isArray(record?.returnedChunkIndexes) ? record.returnedChunkIndexes : [];
    for (const value of returned) {
      const chunkIndex = numberValue(value);
      if (chunkIndex !== undefined) indexes.add(chunkIndex);
    }
  }
  return indexes;
}

function latestUploadedSourceReadAddsNoNewChunks(
  allEvidence: readonly AgentLoopToolEvidence[],
  latestEvidence: readonly AgentLoopToolEvidence[],
): boolean {
  const latestReadEvidence = latestEvidence.filter((item) => !item.isError && item.toolName === "read_source");
  if (latestReadEvidence.length === 0) return false;
  const latestKeys = lookupSourceReadKeys(latestReadEvidence);
  if (latestKeys.size === 0) return false;
  const latestIds = new Set(latestReadEvidence.map((item) => item.toolCallId));
  const priorKeys = lookupSourceReadKeys(allEvidence.filter((item) => !latestIds.has(item.toolCallId)));
  return [...latestKeys].every((key) => priorKeys.has(key));
}

function discoveredSourceCount(evidence: readonly AgentLoopToolEvidence[]): number | undefined {
  let count: number | undefined;
  for (const item of evidence) {
    const parsed = parseJsonRecord(item.result);
    if (parsed === undefined) continue;
    for (const value of [
      numberValue(parsed.totalMatches),
      numberValue(parsed.returnedMatches),
      numberValue(parsed.returned),
      sourceRefCount(parsed),
    ]) {
      if (value === undefined || value <= 0) continue;
      count = count === undefined ? value : Math.max(count, value);
    }
  }
  return count;
}

function distinctLookupSourceReadCount(evidence: readonly AgentLoopToolEvidence[]): number {
  return lookupSourceReadKeys(evidence).size;
}

function lookupSourceReadKeys(evidence: readonly AgentLoopToolEvidence[]): Set<string> {
  const paths = new Set<string>();
  let opaqueReadCount = 0;
  for (const item of evidence) {
    if (!isSourceContentReadToolName(item.toolName)) continue;
    const parsed = parseJsonRecord(item.result);
    if (parsed === undefined) {
      opaqueReadCount += 1;
      continue;
    }
    const receipt = parseJsonRecord(parsed.evidenceReceipt);
    const refs = Array.isArray(receipt?.sourceRefs) ? receipt.sourceRefs : [];
    for (const ref of refs) {
      const record = parseJsonRecord(ref);
      const sourceRefId = typeof record?.sourceRefId === "string" ? record.sourceRefId : undefined;
      const sourceId = typeof record?.sourceId === "string" ? record.sourceId : undefined;
      const chunkIndex = numberValue(record?.chunkIndex);
      const path = typeof record?.path === "string" ? record.path : undefined;
      const rootId = typeof record?.rootId === "string" ? record.rootId : "";
      const url = typeof record?.url === "string" ? record.url : undefined;
      if (sourceRefId !== undefined && sourceRefId.trim().length > 0) {
        paths.add(sourceRefId);
        continue;
      }
      if (sourceId !== undefined && sourceId.trim().length > 0 && chunkIndex !== undefined) {
        paths.add(`uploaded:${sourceId}:${chunkIndex}`);
        continue;
      }
      if (path !== undefined && path.trim().length > 0) {
        paths.add(`${rootId}:${path}`);
        continue;
      }
      if (url !== undefined && url.trim().length > 0) paths.add(`url:${url}`);
    }
    if (paths.size === 0) {
      if (parsed.schema === "agentloop.uploadedSourceRead/v1") {
        const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId : undefined;
        if (sourceId !== undefined) {
          for (const chunkIndex of uploadedSourceChunkIndexes(parsed)) paths.add(`uploaded:${sourceId}:${chunkIndex}`);
        }
      }
      const path = typeof parsed.path === "string" ? parsed.path : undefined;
      if (path !== undefined) paths.add(path);
    }
  }
  for (let index = 0; index < opaqueReadCount; index += 1) paths.add(`opaque:${index}`);
  return paths;
}

function hasSatisfiedEvidenceKind(
  evidence: readonly AgentLoopToolEvidence[],
  requiredKind: string,
): boolean {
  return evidence.some((item) => {
    if (item.isError) return false;
    const parsed = parseJsonRecord(item.result);
    const receipt = parseJsonRecord(parsed?.evidenceReceipt);
    const evidenceKinds = parseJsonRecord(receipt?.evidenceKinds ?? parsed?.evidenceKinds);
    return stringArrayField(evidenceKinds?.satisfied).includes(requiredKind);
  });
}

/**
 * `extract_source_tables` reads an authorized structured upload in full (up
 * to its declared bounds) and writes a content-addressed extraction artifact.
 * It is therefore a complete source read in its own right, unlike a projected
 * `read_source` chunk.  Keep this check receipt-shaped rather than relying on
 * a tool name alone so a truncated extraction still remains tool-enabled.
 */
function hasCompleteStructuredExtractionEvidence(evidence: readonly AgentLoopToolEvidence[]): boolean {
  return evidence.some((item) => {
    if (item.isError || item.toolName !== "extract_source_tables") return false;
    const parsed = parseJsonRecord(item.result);
    if (parsed?.schema !== "agentloop.visibleTableExtraction/v1" || parsed.truncated === true) return false;
    const artifact = parseJsonRecord(parsed.artifact);
    if (typeof artifact?.path !== "string" || artifact.path.trim().length === 0) return false;
    const receipt = parseJsonRecord(parsed.evidenceReceipt);
    const evidenceKinds = parseJsonRecord(receipt?.evidenceKinds ?? parsed.evidenceKinds);
    return stringArrayField(evidenceKinds?.satisfied).includes("structured_extraction_artifact");
  });
}

function latestSourceReadAddsNoNewSources(
  allEvidence: readonly AgentLoopToolEvidence[],
  latestEvidence: readonly AgentLoopToolEvidence[],
): boolean {
  const latestReadEvidence = latestEvidence.filter((item) => !item.isError && isSourceContentReadToolName(item.toolName));
  if (latestReadEvidence.length === 0) return false;
  const latestKeys = lookupSourceReadKeys(latestReadEvidence);
  if (latestKeys.size === 0) return false;
  const latestIds = new Set(latestReadEvidence.map((item) => item.toolCallId));
  const priorKeys = lookupSourceReadKeys(allEvidence.filter((item) => !latestIds.has(item.toolCallId)));
  return [...latestKeys].every((key) => priorKeys.has(key));
}

function latestVisibleSourceReadHasContinuation(
  latestEvidence: readonly AgentLoopToolEvidence[],
): boolean {
  return latestEvidence.some((item) => {
    if (
      item.isError
      || (item.toolName !== "visible_read_file" && item.toolName !== "visible_read_files")
    ) {
      return false;
    }
    const parsed = parseJsonRecord(item.result);
    return parsed !== undefined && visibleReadResultHasContinuation(parsed);
  });
}

function visibleReadResultHasContinuation(parsed: Record<string, unknown>): boolean {
  if (visibleReadRecordHasContinuation(parsed)) return true;
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  for (const file of files) {
    const record = parseJsonRecord(file);
    if (record !== undefined && visibleReadRecordHasContinuation(record)) return true;
  }
  const receipt = parseJsonRecord(parsed.evidenceReceipt);
  const refs = Array.isArray(receipt?.sourceRefs) ? receipt.sourceRefs : [];
  for (const ref of refs) {
    const record = parseJsonRecord(ref);
    if (record !== undefined && visibleReadRecordHasContinuation(record)) return true;
  }
  return false;
}

function visibleReadRecordHasContinuation(record: Record<string, unknown>): boolean {
  return record.truncated === true && numberValue(record.nextOffset) !== undefined;
}

function sourceRefCount(value: Record<string, unknown>): number | undefined {
  const receipt = parseJsonRecord(value.evidenceReceipt);
  if (Array.isArray(receipt?.sourceRefs)) return receipt.sourceRefs.length;
  return undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") return parseToolResult(value) as Record<string, unknown> | undefined;
  return isPlainRecord(value) ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
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
    const extension = typeof match[1] === "string" ? match[1].toLowerCase() : undefined;
    if (extension !== undefined && ARTIFACT_EXTENSIONS.has(extension)) {
      target.add(normalizeArtifactExtension(extension));
    }
  }
}

function normalizeArtifactExtension(extension: string): string {
  return canonicalArtifactFormatFamily(extension);
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

function stepAssessmentSignature(input: {
  stepId: string;
  assessmentProfile: AssessmentProfileId;
  activatedSkills: readonly PrivateSkill[];
  evidence: StepEvidence;
  modelEvidence: StepEvidence;
  decisionLedger: readonly RuntimeDecisionCommit[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    stepId: input.stepId,
    assessmentProfile: input.assessmentProfile,
    activatedSkills: input.activatedSkills
      .map((skill) => ({ id: skill.id, contentHash: skill.contentHash }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    evidence: assessmentEvidenceSignature(input.evidence),
    modelEvidence: assessmentEvidenceSignature(input.modelEvidence),
    decisionLedger: input.decisionLedger.map((commit) => ({
      id: commit.id,
      hash: commit.hash,
      planId: commit.planId,
      stepId: commit.stepId,
      mode: commit.mode,
      satisfaction: commit.satisfaction,
    })),
  })).digest("hex");
}

function assessmentEvidenceSignature(evidence: StepEvidence): Record<string, unknown> {
  return {
    candidateOutput: evidence.candidateOutput.trim(),
    deliveryCandidate: evidence.deliveryCandidate,
    toolCalls: [
      ...new Set(evidence.toolCalls.map((toolCall) => [
        toolCall.toolName,
        toolCall.isError ? "error" : "ok",
        createHash("sha256").update(toolCall.result).digest("hex"),
      ].join("\u0000"))),
    ].sort(),
  };
}

/**
 * A Plan dependency is an explicit semantic edge: its completed evidence is
 * authoritative input to the dependent leaf. Assessment needs the canonical
 * receipt as well as the execution model, especially for a final report whose
 * correct result is that the bounded query returned no observations.
 */
function directDependencyToolEvidence(
  step: ExecutionPlan["steps"][number],
  plan: ExecutionPlan,
): readonly ToolEvidence[] {
  return step.dependencies.flatMap((dependencyId) => {
    const dependency = plan.steps.find((candidate) => candidate.id === dependencyId);
    return dependency?.status === "completed" ? dependency.evidence?.toolCalls ?? [] : [];
  });
}

/**
 * A resolved continuation edge is the semantic authorization to reuse source
 * evidence from a prior Run.  Bind only summaries owned by that target Run;
 * never let unrelated conversation history satisfy a new goal's evidence
 * contract.  The compact receipt is derived from an accepted completed step
 * and retains its Run/Plan/Step provenance, so this is evidence transport
 * rather than treating prior assistant prose as a source.
 */
function conversationEvidenceToolEvidence(
  workset: ConversationWorkingSet | undefined,
  turnResolution: ConversationTurnResolution | undefined,
  step: ExecutionPlan["steps"][number],
): readonly AgentLoopToolEvidence[] {
  const reusableEvidenceKinds = reusableSourceEvidenceKindsForTurn(workset, turnResolution);
  if (
    workset?.evidenceLedger === undefined
    || turnResolution?.targetRunId === undefined
    || reusableEvidenceKinds.length === 0
    || step.role === "fact_acquisition"
  ) return [];
  return workset.evidenceLedger.sourceSummaries
    .filter((summary) => summary.runId === turnResolution.targetRunId)
    .map((summary) => {
      const sourceRefs = dedupeConversationSourceReferences(
        summary.facts.flatMap((fact) => fact.sourceRefs),
      ).slice(0, 12);
      const satisfied = new Set<string>();
      if (
        summary.facts.length > 0
        || summary.coveredTopics.length > 0
        || summary.missingOrUnverified.length > 0
      ) satisfied.add("source_summary");
      if (sourceRefs.some((ref) => ref.url !== undefined)) satisfied.add("source_urls");
      const evidenceRef = `conversation:${createHash("sha256")
        .update([summary.runId, summary.planId, summary.stepId].join("\n"))
        .digest("hex")}`;
      return {
        toolCallId: evidenceRef,
        toolName: "conversation_evidence_reuse",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.sourceSummary/v1",
          provenance: {
            runId: summary.runId,
            planId: summary.planId,
            stepId: summary.stepId,
          },
          coveredTopics: summary.coveredTopics,
          facts: summary.facts,
          sourceRefs,
          missingOrUnverified: summary.missingOrUnverified,
          evidenceKinds: {
            satisfied: [...satisfied],
            caveated: summary.missingOrUnverified.length === 0 ? [] : ["explicit_caveats"],
            failed: [],
          },
        }),
      };
    });
}

function mergeAssessmentToolEvidence(
  inherited: readonly ToolEvidence[],
  current: readonly ToolEvidence[],
): readonly ToolEvidence[] {
  const byCallId = new Map<string, ToolEvidence>();
  for (const item of [...inherited, ...current]) byCallId.set(item.toolCallId, item);
  return [...byCallId.values()];
}

function selectAssessmentProfile(
  step: ExecutionPlan["steps"][number],
  evidence?: StepEvidence,
  holisticSourceContractMismatch = sourceContractNeedsHolisticAssessment(step, evidence),
): AssessmentProfileId {
  const text = [
    step.objective,
    ...step.successCriteria.map((criterion) => criterion.description),
  ].join("\n");
  const artifactDeliveryEvidenceGate = stepUsesArtifactDeliveryEvidenceGate(step);
  if (artifactDeliveryEvidenceGate) return "evidence_gate";
  if (holisticSourceContractMismatch) return "source_grounded";
  // Runtime-owned observable evidence is a prerequisite, not a semantic
  // opinion. Check it before keyword-selected model profiles so wording such
  // as "do not fabricate" cannot approve a candidate that never acquired the
  // source material required by the admitted Plan.
  if (stepUsesRuntimeEvidenceGate(step)) return "evidence_gate";
  if (stepEvidenceSupportsRuntimeEvidenceGate(step, evidence)) return "evidence_gate";
  if (matchesRiskSensitiveAssessment(text)) return "risk_sensitive";
  if (stepUsesOnlyDirectDelivery(step)) return "deterministic";
  if (stepHasSourceKind(step, "web")) {
    return "lookup_lite";
  }
  if (matchesSourceGroundedAssessment(text)) return "source_grounded";
  const resolvedToolNames = stepResolvedToolNames(step);
  if (resolvedToolNames.length === 0) return "deterministic";
  if (resolvedToolNames.every((name) => /(?:read|list|search|fetch|inspect|get|query)/i.test(name))) {
    return "lookup_lite";
  }
  return "source_grounded";
}

const RUNTIME_RECEIPT_ASSESSMENT_KINDS = new Set([
  "source_summary",
  "source_urls",
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
  "derived_aggregation",
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
  "delivery_receipt",
  "explicit_caveats",
]);

function sourceContractNeedsHolisticAssessment(
  step: ExecutionPlan["steps"][number],
  evidence?: StepEvidence,
): boolean {
  const requiresSemanticSourceEvidence = (step.evidenceContract?.requiredKinds ?? []).some((kind) =>
    kind === "source_summary"
    || kind === "source_urls"
    || kind === "schema_summary"
    || kind === "record_counts"
    || kind === "explicit_caveats"
  );
  if (!requiresSemanticSourceEvidence || evidence === undefined || evidence.candidateOutput.trim().length === 0) return false;
  const shapes = evidenceReceiptShapes(evidence.toolCalls);
  // A bounded artifact can preserve the actual research outcome even when a
  // generic command/write tool did not emit the Skill's source-receipt shape.
  // This is a semantic sufficiency question for the LLM, not a reason to ask
  // it to rewrite the same candidate until a label appears.
  return shapes.has("artifact") && !shapes.has("source");
}

function evidenceReceiptShapes(toolCalls: readonly ToolEvidence[]): ReadonlySet<ReceiptShape> {
  const shapes = new Set<ReceiptShape>();
  for (const toolCall of toolCalls) {
    if (toolCall.isError) continue;
    for (const result of toolResultRecords(toolCall.result)) {
      const nestedReceipt = isPlainRecord(result.evidenceReceipt)
        ? result.evidenceReceipt
        : isPlainRecord(result.artifactReceipt)
          ? result.artifactReceipt
          : undefined;
      const schema = typeof result.schema === "string"
        ? result.schema
        : typeof nestedReceipt?.schema === "string"
          ? nestedReceipt.schema
          : undefined;
      if (schema === "agentloop.artifactReceipt/v1" || schema === "agentloop.artifactAcceptance/v1") {
        shapes.add("artifact");
      }
      if (schema === "agentloop.sourceSummary/v1") shapes.add("source");
      const evidenceKinds = isPlainRecord(nestedReceipt?.evidenceKinds)
        ? nestedReceipt.evidenceKinds
        : isPlainRecord(result.evidenceKinds)
          ? result.evidenceKinds
          : undefined;
      const satisfied = stringArrayField(evidenceKinds?.satisfied);
      if (satisfied.some((kind) =>
        kind === "source_summary"
        || kind === "source_urls"
        || kind === "schema_summary"
        || kind === "record_counts"
        || kind === "structured_extraction_artifact"
      )) shapes.add("source");
      if (satisfied.some((kind) => kind.startsWith("artifact_") || kind === "delivery_receipt")) shapes.add("artifact");
    }
  }
  return shapes;
}

function stepEvidenceSupportsRuntimeEvidenceGate(
  step: ExecutionPlan["steps"][number],
  evidence?: StepEvidence,
): boolean {
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return evidence !== undefined
    && evidence.candidateOutput.trim().length > 0
    && requiredKinds.length > 0
    && requiredKinds.every((kind) => RUNTIME_RECEIPT_ASSESSMENT_KINDS.has(kind))
    && evidence.toolCalls.some((toolCall) => toolCallHasRuntimeEvidenceReceipt(toolCall))
    && (!requiresTableArtifactCoverage(step, evidence) || hasTableArtifactCoverageEvidence(evidence.toolCalls));
}

function requiresTableArtifactCoverage(step: ExecutionPlan["steps"][number], evidence: StepEvidence): boolean {
  const text = [
    step.objective,
    ...step.successCriteria.map((criterion) => criterion.description),
    evidence.candidateOutput,
  ].join("\n");
  return /(?:table extraction artifact|table artifact summary|computer_summarize_table_artifact|all tables|全部表|全量表|所有表|manifest table entries)/iu.test(text);
}

function hasTableArtifactCoverageEvidence(toolCalls: readonly ToolEvidence[]): boolean {
  return toolCalls.some((toolCall) => {
    if (toolCall.isError) return false;
    const parsed = parseToolResult(toolCall.result);
    const record = isPlainRecord(parsed) ? parsed : undefined;
    if (record === undefined) return false;
    const topSchema = typeof record.schema === "string" ? record.schema : undefined;
    if (topSchema !== "agentloop.tableArtifactSummary/v1") return false;
    const receipt = isPlainRecord(record.evidenceReceipt) ? record.evidenceReceipt : undefined;
    const kinds = receipt === undefined ? undefined : receiptKinds(receipt);
    const facts = Array.isArray(receipt?.facts) ? receipt.facts : [];
    const fullCoverage = facts.some((fact) => {
      const factRecord = isPlainRecord(fact) ? fact : undefined;
      return factRecord !== undefined && factRecord.fullTableCoverage === true;
    });
    return fullCoverage && kinds?.has("table_coverage") === true;
  });
}

function receiptKinds(receipt: Record<string, unknown>): ReadonlySet<string> {
  const evidenceKinds = isPlainRecord(receipt.evidenceKinds) ? receipt.evidenceKinds : undefined;
  return new Set([
    ...stringArrayField(evidenceKinds?.satisfied),
    ...stringArrayField(evidenceKinds?.caveated),
  ]);
}

function toolCallHasRuntimeEvidenceReceipt(toolCall: ToolEvidence): boolean {
  if (toolCall.isError) return false;
  return toolResultRecords(toolCall.result).some((record) => {
    const nestedReceipt = isPlainRecord(record.evidenceReceipt)
      ? record.evidenceReceipt
      : isPlainRecord(record.artifactReceipt)
        ? record.artifactReceipt
        : undefined;
    const topLevelSchema = typeof record.schema === "string" ? record.schema : undefined;
    const nestedSchema = typeof nestedReceipt?.schema === "string" ? nestedReceipt.schema : undefined;
    const schema = topLevelSchema === "agentloop.artifactAcceptance/v1"
      || topLevelSchema === "agentloop.sourceSummary/v1"
      || topLevelSchema === "agentloop.artifactReceipt/v1"
      || topLevelSchema === "agentloop.toolEvidenceReceipt/v1"
      ? topLevelSchema
      : nestedSchema;
    return schema === "agentloop.artifactAcceptance/v1"
      || schema === "agentloop.sourceSummary/v1"
      || schema === "agentloop.artifactReceipt/v1"
      || schema === "agentloop.toolEvidenceReceipt/v1";
  });
}

function toolResultRecords(result: string): ReadonlyArray<Record<string, unknown>> {
  const parsed = parseToolResult(result);
  const records = Array.isArray(parsed)
    ? parsed.filter(isPlainRecord)
    : isPlainRecord(parsed)
      ? [parsed]
      : [];
  const stdoutRecords = records.flatMap((record) => {
    if (typeof record.stdout !== "string") return [];
    const stdout = parseToolResult(record.stdout);
    return Array.isArray(stdout)
      ? stdout.filter(isPlainRecord)
      : isPlainRecord(stdout)
        ? [stdout]
        : [];
  });
  return [...stdoutRecords, ...records];
}

function isProfiledRuleAssessmentProfile(
  profile: AssessmentProfileId,
): profile is Extract<AssessmentProfileId, "deterministic" | "evidence_gate" | "lookup_lite"> {
  return profile === "deterministic" || profile === "evidence_gate" || profile === "lookup_lite";
}

function stepUsesRuntimeEvidenceGate(step: ExecutionPlan["steps"][number]): boolean {
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return stepHasTool(step, "verify_artifact_acceptance")
    || requiredKinds.includes("artifact_acceptance")
    || requiredKinds.includes("source_summary")
    || requiredKinds.includes("schema_summary")
    || requiredKinds.includes("record_counts")
    || requiredKinds.includes("structured_extraction_artifact")
    || requiredKinds.includes("derived_aggregation");
}

function stepUsesOnlyDirectDelivery(step: ExecutionPlan["steps"][number]): boolean {
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return step.role === "deliver"
    && stepResolvedToolNames(step).length === 0
    && step.requiredFacts.length === 0
    && (requiredKinds.length === 0 || requiredKinds.every((kind) => kind === "delivery_receipt"));
}

const ARTIFACT_DELIVERY_EVIDENCE_KINDS = new Set([
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
  "explicit_caveats",
]);

const SKILL_QA_ONLY_EVIDENCE_KINDS = new Set(["basic_navigation"]);

function runtimeArtifactDeliveryRequiredKinds(requiredKinds: readonly string[]): string[] {
  return requiredKinds.filter((kind) => !SKILL_QA_ONLY_EVIDENCE_KINDS.has(kind));
}

function stepUsesArtifactDeliveryEvidenceGate(step: ExecutionPlan["steps"][number]): boolean {
  const requiredKinds = runtimeArtifactDeliveryRequiredKinds(step.evidenceContract?.requiredKinds ?? []);
  if (
    !stepHasTool(step, "verify_artifact_acceptance")
    && !requiredKinds.includes("artifact_acceptance")
  ) {
    return false;
  }
  if (requiredKinds.length > 0 && !requiredKinds.every((kind) => ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(kind))) {
    return false;
  }
  if (step.requiredFacts.length > 0) return false;
  return step.successCriteria.every((criterion) =>
    ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(criterion.id)
    || SKILL_QA_ONLY_EVIDENCE_KINDS.has(criterion.id)
    || /(?:\b(?:artifact|file|path|non-empty|format|acceptance|receipt|openable|render status)\b|产物|文件|路径|非空|格式|验收|收据|可打开|渲染状态)/iu
      .test(criterion.description)
  );
}

function matchesRiskSensitiveAssessment(value: string): boolean {
  return /(?:\b(?:medical|medicine|clinical|diagnosis|legal|law|lawsuit|contract|financial|finance|investment|securities|tax|compliance|safety|production|credential|secret|security|procurement|purchase|vendor|regulation)\b|医疗|诊断|法律|诉讼|合同|金融|投资|证券|税务|合规|安全|生产|凭证|密钥|采购|供应商|监管)/iu
    .test(value);
}

function matchesSourceGroundedAssessment(value: string): boolean {
  return /(?:\b(?:compare|comparison|conflict|contradiction|multi[-\s]?source|research|report|briefing|analysis|synthesize|citation|cite|sources?|published|publication date)\b|对比|比较|冲突|矛盾|多源|多个来源|研究|调研|报告|简报|分析|综合|引用|来源|发布日期)/iu
    .test(value);
}

function executionTaskProfile(
  operationProfile: DynamicPromptProfile,
  skillBound: boolean,
  input?: {
    readonly objective: string;
    readonly successCriteria: readonly { readonly id: string; readonly description: string }[];
    readonly toolNames: readonly string[];
    readonly skillNames?: readonly string[];
    readonly allowResearchPolicy?: boolean;
  },
): TaskProfile {
  const intent = input === undefined
    ? undefined
    : classifyTaskIntent({
      objective: input.objective,
      successCriteria: input.successCriteria,
      toolNames: input.toolNames,
      skillNames: input.skillNames,
    });
  return buildTaskProfile({
    phase: "execution",
    intent: "execute",
    operations: [operationProfile],
    ...(intent?.artifactKind === undefined ? {} : { artifactKind: intent.artifactKind }),
    ...(intent?.sourceNeed === undefined || input?.allowResearchPolicy !== true ? {} : { sourceNeed: intent.sourceNeed }),
    ...(intent?.researchPolicy === undefined || input?.allowResearchPolicy !== true ? {} : { researchPolicy: intent.researchPolicy }),
    ...(intent?.deliverySurface === undefined ? {} : { deliverySurface: intent.deliverySurface }),
    skillBound,
  });
}

function executionTaskProfileForStep(
  step: ExecutionPlan["steps"][number],
  skills: readonly PrivateSkill[],
): TaskProfile {
  const input = {
    objective: step.objective,
    successCriteria: step.successCriteria,
    toolNames: stepResolvedToolNames(step),
    skillNames: skills.map((skill) => skill.name),
    allowResearchPolicy: stepAllowsResearchPolicy(step),
  };
  return executionTaskProfile(executionOperationProfile(input), skills.length > 0, input);
}

function stepAllowsResearchPolicy(step: ExecutionPlan["steps"][number]): boolean {
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return step.role === "fact_acquisition"
    || stepHasSourceKind(step, "web")
    || requiredKinds.includes("source_summary")
    || requiredKinds.includes("source_urls")
    || requiredKinds.includes("schema_summary")
    || requiredKinds.includes("record_counts")
    || requiredKinds.includes("structured_extraction_artifact");
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
      "An answered Human-in-the-Loop selection recorded in decisionLedger is the user's final decision for its scope. Follow it exactly in subsequent reasoning and tool calls; do not reinterpret, replace, or silently broaden it. If it must change, request a new Human-in-the-Loop decision.",
      "Unless the user explicitly requests another language, all user-facing natural-language output must be in Simplified Chinese. Preserve code, commands, paths, API fields, and proper nouns in their original form.",
      "Use loopStepFrame for model-step continuity and planStepHandoffFrame for Plan-step continuity when present; preserve reusable evidence without executing a future stage unless it is explicitly part of the current boundary.",
      "Do not perform work reserved for a pending downstream Plan step unless the current step objective or success criteria explicitly require that same artifact.",
      "Before any next action, assess its expected marginal benefit to an unmet current-step success criterion. Take an authorized action only when it materially improves the available evidence or acceptance state; otherwise directly submit a concise completion candidate with explicit caveats rather than continuing for its own sake.",
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
  sources: readonly UploadedSourceSummary[] = [],
  skillExecutionRoots: readonly SkillExecutionRootGrant[] = [],
  taskProfile: TaskProfile = executionTaskProfileForStep(step, skills),
  conversationWorkingSet?: ConversationWorkingSet,
  decisionLedger: readonly RuntimeDecisionCommit[] = [],
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const operationProfile = taskProfile.operations[0] ?? executionOperationProfile({
    objective: step.objective,
    successCriteria: step.successCriteria,
    toolNames: stepResolvedToolNames(step),
    skillNames: skills.map((skill) => skill.name),
  });
  return buildStepRuntimeContextSnapshot({
    step,
    plan,
    skills,
    workspaceRoot,
    visibleDirectories,
    sources,
    skillExecutionRoots,
    taskProfile,
    operationProfile,
    requiresFileOutput: stepRequiresFileOutput(step),
    conversationWorkingSet,
    decisionLedger,
  });
}

function buildRecoveredStepRuntimeContext(
  step: ExecutionPlan["steps"][number],
  plan: ExecutionPlan,
  skills: readonly PrivateSkill[],
  workspaceRoot: string,
  recoveryFacts: unknown,
  visibleDirectories: readonly VisibleDirectoryGrant[] = [],
  sources: readonly UploadedSourceSummary[] = [],
  skillExecutionRoots: readonly SkillExecutionRootGrant[] = [],
  taskProfile: TaskProfile = executionTaskProfileForStep(step, skills),
  conversationWorkingSet?: ConversationWorkingSet,
  decisionLedger: readonly RuntimeDecisionCommit[] = [],
): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const base = buildStepRuntimeContext(
    step,
    plan,
    skills,
    workspaceRoot,
    visibleDirectories,
    sources,
    skillExecutionRoots,
    taskProfile,
    conversationWorkingSet,
    decisionLedger,
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function mergeUploadedSources(sources: readonly UploadedSourceSummary[]): UploadedSourceSummary[] {
  const seen = new Set<string>();
  const merged: UploadedSourceSummary[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    merged.push(source);
  }
  return merged;
}

function uploadedSourcesForStep(
  sources: readonly UploadedSourceSummary[],
  requiredUploadedSourceIds: readonly string[] | undefined,
): readonly UploadedSourceSummary[] {
  if (requiredUploadedSourceIds === undefined || requiredUploadedSourceIds.length === 0) return sources;
  const required = new Set(requiredUploadedSourceIds);
  return sources.filter((source) => required.has(source.id));
}

function visibleDirectoriesForStep(
  visibleDirectories: readonly VisibleDirectoryGrant[],
  requiredVisibleDirectoryIds: readonly string[] | undefined,
): readonly VisibleDirectoryGrant[] {
  if (requiredVisibleDirectoryIds === undefined || requiredVisibleDirectoryIds.length === 0) return visibleDirectories;
  const required = new Set(requiredVisibleDirectoryIds);
  return visibleDirectories.filter((directory) => required.has(directory.id));
}

function sourceEventSummary(source: UploadedSourceSummary): Record<string, unknown> {
  return {
    id: source.id,
    originalName: source.originalName,
    mimeType: source.mimeType,
    extension: source.extension,
    byteSize: source.byteSize,
    sha256: source.sha256,
    status: source.status,
    chunkCount: source.chunkCount,
    truncated: source.truncated,
    ...(source.summary === undefined ? {} : { summary: source.summary }),
  };
}

function parseExecuteOptions(value: unknown): ExecuteOptions {
  if (value === undefined) return { allowDangerousTools: true, visibleDirectories: [], sourceIds: [] };
  const record = requireRecord(value, "run options");
  if (record.allowDangerousTools !== undefined && typeof record.allowDangerousTools !== "boolean") {
    throw new AppError("BAD_REQUEST", "allowDangerousTools must be boolean", 400);
  }
  const visibleDirectories = parseVisibleDirectoryPaths(record.visibleDirectories);
  const sourceIds = parseSourceIds(record.sourceIds);
  const conversationId = record.conversationId === undefined || record.conversationId === null
    ? undefined
    : requireString(record.conversationId, "conversationId", { max: 128 });
  const modelKey = record.modelKey === undefined || record.modelKey === null
    ? undefined
    : requireString(record.modelKey, "modelKey", { max: 120 });
  if (Object.hasOwn(record, "conversationIntent")) {
    throw new AppError("BAD_REQUEST", "conversationIntent is Runtime-owned and cannot be supplied by callers", 400);
  }
  return {
    allowDangerousTools: record.allowDangerousTools !== false,
    visibleDirectories,
    sourceIds,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(modelKey === undefined ? {} : { modelKey }),
  };
}

function parseSourceIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new AppError("BAD_REQUEST", "sourceIds must be an array with at most 20 entries", 400);
  }
  const result = value.map((item, index) =>
    requireString(item, `sourceIds[${index}]`, { max: 80, pattern: /^src_[a-f0-9]{32}$/ })
  );
  if (new Set(result).size !== result.length) {
    throw new AppError("BAD_REQUEST", "sourceIds must not contain duplicates", 400);
  }
  return result;
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

const CONVERSATION_TURN_TOOL = {
  name: "resolve_conversation_turn",
  description: "Bind the latest conversational turn to its effective goal, goal lineage, and Runtime-issued prior-work candidate.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["mode", "relation", "inputMode", "effectiveGoal", "evidenceDemand", "userConstraints"],
    properties: {
      mode: { type: "string", enum: ["reply", "execute", "clarify"] },
      relation: {
        type: "string",
        enum: ["new_goal", "continue_prior", "correct_prior", "refine_prior", "challenge_prior"],
      },
      inputMode: {
        type: "string",
        enum: ["none", "prior_result", "prior_artifact", "refresh_sources"],
      },
      targetGoalCandidateId: { type: "string", pattern: "^goal_candidate_[1-9][0-9]*$" },
      targetArtifact: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 1_200 },
        },
      },
      resultCandidateId: { type: "string", pattern: "^result_candidate_[1-9][0-9]*$" },
      effectiveGoal: { type: "string", minLength: 1, maxLength: 2_000 },
      evidenceDemand: {
        type: "string",
        enum: ["none", "lookup_lite", "source_grounded", "strict_user_source"],
      },
      userConstraints: {
        type: "array",
        maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 240 },
      },
    },
  },
} as const;

const CONVERSATION_TURN_RESOLUTION_ATTEMPTS = 2;

async function resolveConversationTurn(
  model: ModelAdapter,
  input: string,
  conversationHistory: readonly ModelMessage[] | undefined,
  context: ConversationIntentExternalContext,
  signal?: AbortSignal,
): Promise<ConversationTurnResolution> {
  const runtimeContextId = `conversation-turn-context:${randomUUID()}`;
  let repairFeedback: string | undefined;
  let semanticFeedback: string | undefined;
  for (let attempt = 1; attempt <= CONVERSATION_TURN_RESOLUTION_ATTEMPTS; attempt += 1) {
    const response = await model.complete({
      runId: `conversation-turn:${randomUUID()}`,
      systemPrompt: conversationTurnResolverPrompt(repairFeedback),
      phase: "planning",
      runtimeContext: {
        id: runtimeContextId,
        phase: "planning",
        content: formatConversationTurnContext(context),
      },
      messages: [
        ...(conversationHistory ?? []),
        { role: "user", content: input },
      ],
      tools: [CONVERSATION_TURN_TOOL],
      toolChoice: { name: CONVERSATION_TURN_TOOL.name },
    }, signal);
    const resolution = parseConversationTurnResolution(response, context.conversationWorkingSet);
    if (resolution !== undefined) {
      const inherited = inheritContinuedConversationIntent(resolution, context.conversationWorkingSet);
      const inheritedBinding = inheritPriorWorkProductBinding(inherited, context.conversationWorkingSet);
      const artifactBound = bindUnambiguousPriorArtifact(inheritedBinding, input, context.conversationWorkingSet);
      const resultBound = bindUnambiguousPriorResult(artifactBound, input, context.conversationWorkingSet);
      semanticFeedback = conversationTurnSemanticFeedback(resultBound, input, context.conversationWorkingSet);
      if (semanticFeedback === undefined) {
        return applyConversationTurnEvidenceFloor(resultBound, input, context.conversationWorkingSet);
      }
      repairFeedback = semanticFeedback;
      continue;
    }
    repairFeedback = conversationTurnRepairFeedback(response);
  }
  if (semanticFeedback !== undefined) {
    return {
      schema: "agentloop.conversationTurnResolution/v1",
      mode: "clarify",
      relation: "new_goal",
      inputMode: "none",
      effectiveGoal: "Clarify which prior completed result should be used as input.",
      evidenceDemand: "none",
      userConstraints: [semanticFeedback],
      source: "deterministic",
    };
  }
  return fallbackConversationTurnResolution(input);
}

/**
 * A pure continuation keeps the canonical intent already owned by its target
 * Run. The resolver may add constraints made explicit in the latest turn, but
 * it cannot summarize away prior constraints or downgrade their evidence
 * demand. Corrections and refinements remain model-authored new intent edges.
 */
function inheritContinuedConversationIntent(
  resolution: ConversationTurnResolution,
  workset: ConversationWorkingSet | undefined,
): ConversationTurnResolution {
  if (resolution.relation !== "continue_prior" || resolution.targetRunId === undefined) return resolution;
  const target = workset?.resolvedIntents?.find((item) => item.runId === resolution.targetRunId)?.resolution;
  if (target === undefined) return resolution;
  const userConstraints = uniqueConversationConstraints([
    ...target.userConstraints,
    ...resolution.userConstraints,
  ]);
  const evidenceDemand = strongerConversationEvidenceDemand(target.evidenceDemand, resolution.evidenceDemand);
  const changed = resolution.effectiveGoal !== target.effectiveGoal
    || evidenceDemand !== resolution.evidenceDemand
    || userConstraints.length !== resolution.userConstraints.length
    || userConstraints.some((constraint, index) => constraint !== resolution.userConstraints[index]);
  if (!changed) return resolution;
  return {
    ...resolution,
    mode: "execute",
    effectiveGoal: target.effectiveGoal,
    evidenceDemand,
    userConstraints,
    source: "model_guarded",
  };
}

function uniqueConversationConstraints(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Goal lineage and work-product ownership are independent. A failed Run can
 * remain the continuation target while its accepted input is inherited from a
 * different completed Run.
 */
function inheritPriorWorkProductBinding(
  resolution: ConversationTurnResolution,
  workset: ConversationWorkingSet | undefined,
): ConversationTurnResolution {
  if (
    resolution.mode !== "execute"
    || resolution.relation === "new_goal"
    || resolution.targetRunId === undefined
    || resolution.targetResult !== undefined
    || resolution.inputMode === "refresh_sources"
  ) return resolution;
  const inherited = inheritedResultForRun(resolution.targetRunId, workset);
  if (inherited === undefined) return resolution;
  return {
    ...resolution,
    inputMode: "prior_result",
    targetResult: inherited,
    source: "model_guarded",
  };
}

function inheritedResultForRun(
  runId: string,
  workset: ConversationWorkingSet | undefined,
): RuntimeResultRef | undefined {
  const intents = new Map((workset?.resolvedIntents ?? []).map((item) => [item.runId, item.resolution]));
  const seen = new Set<string>();
  let currentRunId: string | undefined = runId;
  while (currentRunId !== undefined && !seen.has(currentRunId)) {
    seen.add(currentRunId);
    const intent = intents.get(currentRunId);
    if (intent?.targetResult !== undefined) return intent.targetResult;
    currentRunId = intent?.targetRunId;
  }
  return undefined;
}

/**
 * The resolver owns the semantic edge to a prior Run; Runtime owns binding a
 * concrete work product. When that target Run has exactly one reusable
 * artifact and the latest turn asks for a prior-artifact change, binding is
 * deterministic rather than a best-effort prompt convention. Multiple
 * artifacts deliberately remain unresolved for the model/HIL boundary.
 */
function bindUnambiguousPriorArtifact(
  resolution: ConversationTurnResolution,
  input: string,
  workset: ConversationWorkingSet | undefined,
): ConversationTurnResolution {
  if (
    resolution.mode !== "execute"
    || resolution.targetArtifact !== undefined
    || resolution.targetRunId === undefined
    || resolution.relation === "new_goal"
    || !requestsPriorArtifactChange(input)
  ) return resolution;
  const candidates = workset?.reusableArtifacts.filter((artifact) =>
    artifact.reusable && artifact.runId === resolution.targetRunId,
  ) ?? [];
  if (candidates.length !== 1) return resolution;
  const artifact = candidates[0];
  if (artifact === undefined) return resolution;
  return {
    ...resolution,
    inputMode: "prior_artifact",
    targetArtifact: { runId: artifact.runId, path: artifact.path },
    source: "model_guarded",
  };
}

/** A published Runtime Result remains reusable independently of its producer kind. */
function bindUnambiguousPriorResult(
  resolution: ConversationTurnResolution,
  input: string,
  workset: ConversationWorkingSet | undefined,
): ConversationTurnResolution {
  if (resolution.mode !== "execute" || resolution.inputMode === "refresh_sources") return resolution;
  if (resolution.targetResult !== undefined) {
    if (resolution.relation !== "new_goal") return resolution;
    const selectedCard = workset?.resultCards?.find((item) => item.result.resultId === resolution.targetResult?.resultId);
    return {
      ...resolution,
      relation: "refine_prior",
      inputMode: "prior_result",
      targetRunId: resolution.targetRunId ?? selectedCard?.producer.runId,
      source: "model_guarded",
    };
  }
  const targetCandidates = resolution.targetRunId === undefined
    ? []
    : workset?.resultCards?.filter((item) => item.producer.runId === resolution.targetRunId) ?? [];
  const candidates = targetCandidates.length > 0
    ? targetCandidates
    : referencesPriorConversationResult(input)
      ? workset?.resultCards ?? []
      : [];
  if (candidates.length !== 1) return resolution;
  const candidate = candidates[0];
  if (candidate === undefined) return resolution;
  return {
    ...resolution,
    relation: resolution.relation === "new_goal" ? "refine_prior" : resolution.relation,
    inputMode: "prior_result",
    targetRunId: resolution.targetRunId ?? candidate.producer.runId,
    targetResult: candidate.result,
    source: "model_guarded",
  };
}

function conversationTurnSemanticFeedback(
  resolution: ConversationTurnResolution,
  input: string,
  workset: ConversationWorkingSet | undefined,
): string | undefined {
  if (!referencesPriorConversationResult(input) || resolution.targetResult !== undefined) return undefined;
  const candidates = workset?.resultCards ?? [];
  if (candidates.length === 0) {
    return "The user refers to a prior result, but no completed reusable Outcome is available. Ask the user to clarify or provide the content; do not silently reacquire sources.";
  }
  return candidates.length === 1
    ? "The user refers to the available prior result. Set inputMode=prior_result and select result_candidate_1."
    : "The user refers to a prior result, but multiple reusable results are available. Select the matching opaque resultCandidateId from reusableResultCandidates; if the transcript does not distinguish them, return clarify.";
}

function referencesPriorConversationResult(input: string): boolean {
  if (!requestsArtifactBuildFromIntent(input)) return false;
  return /(?:\b(?:this|that|the\s+above|above|previous|prior|earlier|last|latest)\s+(?:analysis|result|answer|summary|report|content|findings?)\b|\b(?:analysis|result|answer|summary|findings?)\s+from\s+(?:the\s+)?(?:previous|prior|last|earlier)\b|(?:这个|该|上述|前述|之前的|先前的|刚才的|上一轮的?|上轮的?)(?:分析(?:结果)?|结果|结论|回答|总结|报告|内容|材料)|(?:分析结果|上述结论|前述结论).{0,12}(?:生成|制作|导出|转换|转成|保存))/iu.test(input);
}

function runtimeResultBindingsForTurn(
  resolution: ConversationTurnResolution | undefined,
): readonly RuntimeResultBinding[] {
  if (resolution?.targetResult === undefined || resolution.relation === "new_goal") return [];
  return [{
    schema: "agentloop.resultBinding/v1",
    result: resolution.targetResult,
    relation: resolution.relation,
  }];
}

function applyConversationTurnEvidenceFloor(
  resolution: ConversationTurnResolution,
  input: string,
  workset: ConversationWorkingSet | undefined,
): ConversationTurnResolution {
  if (resolution.mode === "clarify") return resolution;
  const hasBoundPriorWorkProduct = resolution.targetArtifact !== undefined || resolution.targetResult !== undefined;
  const targetInput = !hasBoundPriorWorkProduct && resolution.targetRunId !== undefined
    ? workset?.planCursors.find((cursor) => cursor.runId === resolution.targetRunId)?.input
    : undefined;
  const userAuthoredSourceNeed = classifyTaskIntent({
    // The evidence floor may use only user-authored text. A model-generated
    // effectiveGoal can preserve semantics, but it
    // must not silently escalate an ordinary source request into a stricter
    // contract by adding words such as "official" on its own.
    objective: [input, targetInput ?? ""].filter((value) => value.trim().length > 0).join("\n"),
  }).sourceNeed;
  const modelSourceNeed = resolution.evidenceDemand === "strict_user_source"
    && userAuthoredSourceNeed !== "strict_user_source"
    ? "source_grounded"
    : resolution.evidenceDemand;
  const guardedSourceNeed = strongerConversationEvidenceDemand(modelSourceNeed, userAuthoredSourceNeed);
  // A bound native work product is an input artifact, not a request to
  // reacquire the facts that led to its earlier creation. If the latest
  // user-authored request has no source demand, retain prior provenance in the
  // artifact lineage but do not turn a layout/file transformation into
  // source-grounded research merely because the target Run was grounded.
  if (hasBoundPriorWorkProduct && userAuthoredSourceNeed === "none") {
    if (resolution.evidenceDemand === "none" && resolution.mode === "execute") return resolution;
    return { ...resolution, mode: "execute", evidenceDemand: "none", source: "model_guarded" };
  }
  if (guardedSourceNeed === resolution.evidenceDemand && resolution.mode === "execute") return resolution;
  if (guardedSourceNeed === "none") return resolution;
  return {
    ...resolution,
    mode: "execute",
    evidenceDemand: guardedSourceNeed,
    source: "model_guarded",
  };
}

function strongerConversationEvidenceDemand(
  left: ConversationTurnResolution["evidenceDemand"],
  right: ConversationTurnResolution["evidenceDemand"],
): ConversationTurnResolution["evidenceDemand"] {
  const rank: Record<ConversationTurnResolution["evidenceDemand"], number> = {
    none: 0,
    lookup_lite: 1,
    source_grounded: 2,
    strict_user_source: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function conversationTurnResolverPrompt(repairFeedback: string | undefined): string {
  return [
      "Resolve the latest user turn against the full conversation transcript and canonical prior-Run metadata.",
      "Do not interpret an elliptical follow-up in isolation. Rebind corrections, challenges, refinements, and continuations to the concrete prior goal they modify.",
      "effectiveGoal must be a self-contained description of the outcome Runtime should now deliver; preserve the latest user constraints without requiring imperative wording.",
      "Return reply only when the effective goal can be satisfied solely from the existing transcript and supplied metadata.",
      "Return execute when faithful completion requires external state acquisition or capability use, even when the user only rejects, questions, or refines a prior answer.",
      "A request for specific externally verifiable facts that are not grounded in the transcript needs lookup_lite or source_grounded evidence even when the user did not explicitly say search or browse.",
      "When the user disputes an unsupported prior factual answer, bind to that prior Run, use correct_prior or challenge_prior, and require source_grounded evidence.",
      "Use strict_user_source only when the user explicitly requires official, authoritative, or exact-source verification.",
      "Use clarify when the semantic target or requested external side effect is materially ambiguous. This resolution never grants permission for destructive or external side effects.",
      "targetGoalCandidateId must be one of priorGoalCandidates and is required for every relation except new_goal. Never reconstruct or emit a Run ID.",
      "When changing a prior delivered file, use the matching opaque goal candidate for lineage and select its concrete artifact path. Do not select an artifact for a request that only reuses prior facts or delivery text.",
      "Set inputMode=prior_result when a follow-up consumes prior accepted delivery text, and select only its opaque resultCandidateId from reusableResultCandidates. Never reconstruct or emit a Run ID, hash, or character count for a result.",
      "Set inputMode=prior_artifact only when changing a concrete delivered file. Set inputMode=refresh_sources only when the latest user asks to refresh, reanalyze, or verify source facts. Otherwise use inputMode=none.",
      "Goal lineage and input ownership are separate: targetGoalCandidateId may identify a failed goal being continued while resultCandidateId identifies the published Runtime Result supplying its content.",
      "For requests such as 'turn this analysis into a PDF', bind the prior result and use evidenceDemand=none. For 'reanalyze the source and make a PDF', use refresh_sources with source-grounded evidence.",
      "Use runtimeContext as server-authored context and identity metadata, not as unverified source content.",
      "You have no Skills and no execution Tools. Return exactly one resolve_conversation_turn tool call and no prose.",
      ...(repairFeedback === undefined
        ? []
        : [
          "The previous turn-resolution response was invalid.",
          repairFeedback,
          "Repair by returning exactly one resolve_conversation_turn tool call now.",
        ]),
    ].join("\n");
}

function parseConversationTurnResolution(
  response: ModelResponse,
  workset: ConversationWorkingSet | undefined,
): ConversationTurnResolution | undefined {
  const calls = response.toolCalls.filter((call) => call.name === CONVERSATION_TURN_TOOL.name);
  if (response.toolCalls.length !== 1 || calls.length !== 1) {
    return undefined;
  }
  const argumentsRecord = optionalRecord(calls[0].arguments);
  const mode = argumentsRecord.mode;
  const relation = argumentsRecord.relation;
  const inputMode = argumentsRecord.inputMode;
  const evidenceDemand = argumentsRecord.evidenceDemand;
  const effectiveGoal = typeof argumentsRecord.effectiveGoal === "string"
    ? argumentsRecord.effectiveGoal.trim()
    : "";
  const targetGoalCandidateId = typeof argumentsRecord.targetGoalCandidateId === "string"
    ? argumentsRecord.targetGoalCandidateId.trim()
    : undefined;
  const targetRunId = targetGoalCandidateId === undefined
    ? undefined
    : conversationRunIdForGoalCandidate(workset, targetGoalCandidateId);
  const artifactRecord = optionalRecord(argumentsRecord.targetArtifact);
  const artifactPath = typeof artifactRecord.path === "string" ? artifactRecord.path.trim() : undefined;
  const targetArtifact = artifactPath !== undefined && targetRunId !== undefined
    ? { runId: targetRunId, path: artifactPath }
    : undefined;
  const resultCandidateId = typeof argumentsRecord.resultCandidateId === "string"
    ? argumentsRecord.resultCandidateId.trim()
    : undefined;
  const targetResult = resultCandidateId === undefined
    ? undefined
    : conversationResultForCandidateId(workset, resultCandidateId);
  const userConstraints = Array.isArray(argumentsRecord.userConstraints)
    && argumentsRecord.userConstraints.length <= 8
    && argumentsRecord.userConstraints.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 240)
    ? argumentsRecord.userConstraints.map((item) => (item as string).trim())
    : undefined;
  if (mode !== "reply" && mode !== "execute" && mode !== "clarify") return undefined;
  if (!isConversationTurnRelation(relation)) return undefined;
  if (!isConversationTurnInputMode(inputMode)) return undefined;
  if (!isConversationEvidenceDemand(evidenceDemand)) return undefined;
  if (argumentsRecord.targetArtifact !== undefined && targetArtifact === undefined) return undefined;
  if (targetGoalCandidateId !== undefined && targetRunId === undefined) return undefined;
  if (resultCandidateId !== undefined && targetResult === undefined) return undefined;
  if (inputMode === "prior_result" && targetResult === undefined) return undefined;
  if (inputMode !== "prior_result" && resultCandidateId !== undefined) return undefined;
  if (inputMode === "prior_artifact" && targetArtifact === undefined) return undefined;
  if (inputMode !== "prior_artifact" && targetArtifact !== undefined) return undefined;
  if (effectiveGoal.length === 0 || effectiveGoal.length > 2_000 || userConstraints === undefined) return undefined;
  if (mode !== "execute" && evidenceDemand !== "none") return undefined;

  const priorRunIds = conversationTurnTargetRunIds(workset);
  if (relation === "new_goal") {
    if (targetRunId !== undefined && !priorRunIds.has(targetRunId)) return undefined;
  } else if (targetRunId === undefined || !priorRunIds.has(targetRunId)) {
    return undefined;
  }
  if (targetArtifact !== undefined) {
    if (relation === "new_goal" || targetRunId !== targetArtifact.runId) return undefined;
    const isReusable = workset?.reusableArtifacts.some((artifact) =>
      artifact.runId === targetArtifact.runId && artifact.path === targetArtifact.path && artifact.reusable,
    ) === true;
    if (!isReusable) return undefined;
  }
  return {
    schema: "agentloop.conversationTurnResolution/v1",
    mode,
    relation,
    inputMode,
    ...(targetRunId === undefined ? {} : { targetRunId }),
    ...(targetArtifact === undefined ? {} : { targetArtifact }),
    ...(targetResult === undefined ? {} : { targetResult }),
    effectiveGoal,
    evidenceDemand,
    userConstraints,
    source: "model",
  };
}

function conversationResultForCandidateId(
  workset: ConversationWorkingSet | undefined,
  candidateId: string,
): RuntimeResultRef | undefined {
  const match = /^result_candidate_([1-9][0-9]*)$/u.exec(candidateId);
  if (match === null) return undefined;
  const index = Number(match[1]) - 1;
  return workset?.resultCards?.[index]?.result;
}

function conversationRunIdForGoalCandidate(
  workset: ConversationWorkingSet | undefined,
  candidateId: string,
): string | undefined {
  const match = /^goal_candidate_([1-9][0-9]*)$/u.exec(candidateId);
  if (match === null) return undefined;
  const index = Number(match[1]) - 1;
  return [...conversationTurnTargetRunIds(workset)][index];
}

function isConversationTurnInputMode(value: unknown): value is ConversationTurnInputMode {
  return value === "none"
    || value === "prior_result"
    || value === "prior_artifact"
    || value === "refresh_sources";
}

function conversationTurnRepairFeedback(response: ModelResponse): string {
  if (response.toolCalls.length === 0 && response.content.trim().length === 0) {
    return "The previous response was empty and contained no structured resolution.";
  }
  if (response.toolCalls.length !== 1) {
    return `The previous response returned ${response.toolCalls.length} tool calls; exactly one is required.`;
  }
  if (response.toolCalls[0]?.name !== CONVERSATION_TURN_TOOL.name) {
    return `The previous response called ${response.toolCalls[0]?.name ?? "an unnamed tool"} instead of ${CONVERSATION_TURN_TOOL.name}.`;
  }
  return "The previous response did not provide a valid mode, relation, input mode, opaque candidate selection, effective goal, evidence demand, and constraint list.";
}

function deterministicConversationTurnResolution(input: string): ConversationTurnResolution {
  return {
    schema: "agentloop.conversationTurnResolution/v1",
    mode: "execute",
    relation: "new_goal",
    inputMode: "none",
    effectiveGoal: input.trim() || "Complete the latest user request",
    evidenceDemand: classifyTaskIntent({ objective: input }).sourceNeed,
    userConstraints: [],
    source: "deterministic",
  };
}

function fallbackConversationTurnResolution(input: string): ConversationTurnResolution {
  return {
    ...deterministicConversationTurnResolution(input),
    source: "fallback",
  };
}

function conversationTurnResolutionFromEvents(
  events: readonly RuntimeEvent[],
): ConversationTurnResolution | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "conversation.turn.resolved") continue;
    const data = optionalRecord(event.data);
    const mode = data.mode;
    const relation = data.relation;
    const inputMode = data.inputMode === undefined
      ? data.targetResult !== undefined
        ? "prior_result"
        : data.targetArtifact !== undefined
          ? "prior_artifact"
          : "none"
      : data.inputMode;
    const evidenceDemand = data.evidenceDemand;
    const source = data.source;
    const effectiveGoal = typeof data.effectiveGoal === "string" ? data.effectiveGoal.trim() : "";
    const targetRunId = typeof data.targetRunId === "string" ? data.targetRunId.trim() : undefined;
    const targetArtifact = conversationArtifactReference(data.targetArtifact);
    const targetResult = parseResultReference(data.targetResult);
    const userConstraints = stringArrayField(data.userConstraints).map((item) => item.trim());
    if (data.schema !== "agentloop.conversationTurnResolution/v1") return undefined;
    if (!isConversationTurnMode(mode) || !isConversationTurnRelation(relation)) return undefined;
    if (!isConversationTurnInputMode(inputMode)) return undefined;
    if (!isConversationEvidenceDemand(evidenceDemand) || !isConversationTurnResolutionSource(source)) return undefined;
    if (effectiveGoal.length === 0 || effectiveGoal.length > 2_000) return undefined;
    if (
      !Array.isArray(data.userConstraints)
      || userConstraints.length !== data.userConstraints.length
      || userConstraints.some((item) => item.length > 240)
    ) return undefined;
    if (mode !== "execute" && evidenceDemand !== "none") return undefined;
    if (relation !== "new_goal" && (targetRunId === undefined || targetRunId.length === 0)) return undefined;
    if (targetArtifact !== undefined && (relation === "new_goal" || targetArtifact.runId !== targetRunId)) return undefined;
    if (data.targetResult !== undefined && targetResult === undefined) return undefined;
    return {
      schema: "agentloop.conversationTurnResolution/v1",
      mode,
      relation,
      inputMode,
      ...(targetRunId === undefined || targetRunId.length === 0 ? {} : { targetRunId }),
      ...(targetArtifact === undefined ? {} : { targetArtifact }),
      ...(targetResult === undefined ? {} : { targetResult }),
      effectiveGoal,
      evidenceDemand,
      userConstraints,
      source,
    };
  }
  return undefined;
}

function conversationArtifactReference(value: unknown): { readonly runId: string; readonly path: string } | undefined {
  const record = optionalRecord(value);
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (runId.length === 0 || runId.length > 120 || path.length === 0 || path.length > 1_200) return undefined;
  if (isAbsolute(path) || path.split(/[\\\\/]/u).some((segment) => segment === "..")) return undefined;
  return { runId, path };
}

function parseResultReference(value: unknown): RuntimeResultRef | undefined {
  return parseRuntimeResultRef(value);
}

function isConversationTurnMode(value: unknown): value is ConversationTurnResolution["mode"] {
  return value === "reply" || value === "execute" || value === "clarify";
}

function isConversationTurnResolutionSource(value: unknown): value is ConversationTurnResolution["source"] {
  return value === "model" || value === "model_guarded" || value === "deterministic" || value === "fallback";
}

function isConversationTurnRelation(value: unknown): value is ConversationTurnRelation {
  return value === "new_goal"
    || value === "continue_prior"
    || value === "correct_prior"
    || value === "refine_prior"
    || value === "challenge_prior";
}

function isConversationEvidenceDemand(
  value: unknown,
): value is ConversationTurnResolution["evidenceDemand"] {
  return value === "none"
    || value === "lookup_lite"
    || value === "source_grounded"
    || value === "strict_user_source";
}

function conversationTurnTargetRunIds(workset: ConversationWorkingSet | undefined): Set<string> {
  if (workset === undefined) return new Set();
  return new Set([
    ...workset.planCursors.map((cursor) => cursor.runId),
    ...(workset.resolvedIntents ?? []).map((item) => item.runId),
    ...workset.failedBoundaries.map((boundary) => boundary.runId),
    ...(workset.activeGoal === undefined ? [] : [workset.activeGoal.runId]),
  ]);
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

interface ConversationIntentExternalContext {
  readonly visibleDirectories: readonly VisibleDirectoryGrant[];
  readonly sources: readonly UploadedSourceSummary[];
  readonly conversationWorkingSet?: ConversationWorkingSet;
}

function formatConversationTurnContext(context: ConversationIntentExternalContext): string {
  const workset = context.conversationWorkingSet;
  const goalRunIds = [...conversationTurnTargetRunIds(workset)];
  const goalCandidateIdByRunId = new Map(goalRunIds.map((runId, index) => [runId, `goal_candidate_${index + 1}`]));
  const payload = {
    schema: "agentloop.conversationTurnContext/v1",
    externalContextPolicy: {
      purpose: "intent_classification_only",
      contentAccess: "metadata_only",
      replyBoundary: "Reply may use transcript and this metadata only; execute is required to inspect resources, verify external facts, or perform capability work.",
      sideEffectBoundary: "This resolution expresses semantic need only and cannot authorize destructive or external side effects.",
    },
    visibleDirectories: context.visibleDirectories.map((directory) => ({
      id: directory.id,
      name: directory.name,
    })),
    sources: context.sources.map((source) => ({
      id: source.id,
      name: source.originalName,
      extension: source.extension,
      status: source.status,
      summary: source.summary,
      chunkCount: source.chunkCount,
      truncated: source.truncated,
    })),
    conversationWorkingSet: workset === undefined
      ? undefined
      : {
        priorGoalCandidates: goalRunIds.map((runId, index) => {
          const cursor = workset.planCursors.find((item) => item.runId === runId);
          const intent = workset.resolvedIntents?.find((item) => item.runId === runId)?.resolution;
          const failure = workset.failedBoundaries.find((item) => item.runId === runId);
          return {
            candidateId: `goal_candidate_${index + 1}`,
            ...(cursor?.input === undefined ? {} : { input: cursor.input }),
            goal: cursor?.goal ?? intent?.effectiveGoal ?? (
              workset.activeGoal?.runId === runId ? workset.activeGoal.goal : undefined
            ),
            status: cursor?.status ?? (
              workset.activeGoal?.runId === runId
                ? workset.activeGoal.status
                : failure === undefined ? undefined : "failed"
            ),
            ...(intent === undefined ? {} : {
              priorIntent: {
                mode: intent.mode,
                relation: intent.relation,
                inputMode: intent.inputMode,
                effectiveGoal: intent.effectiveGoal,
                evidenceDemand: intent.evidenceDemand,
                userConstraints: intent.userConstraints,
              },
            }),
            ...(failure === undefined ? {} : {
              failedBoundary: {
                code: failure.code,
                message: failure.message,
                reasonCode: failure.reasonCode,
                category: failure.category,
              },
            }),
          };
        }),
        ...(workset.activeGoal === undefined ? {} : {
          activeGoalCandidateId: goalCandidateIdByRunId.get(workset.activeGoal.runId),
        }),
        reusableArtifacts: workset.reusableArtifacts.map((artifact) => ({
          goalCandidateId: goalCandidateIdByRunId.get(artifact.runId),
          path: artifact.path,
          name: artifact.name,
          mimeType: artifact.mimeType,
          bytes: artifact.bytes,
        })),
        reusableResultCandidates: (workset.resultCards ?? []).map((item, index) => ({
          candidateId: `result_candidate_${index + 1}`,
          goal: item.goal,
          summary: item.summary,
          summaryTruncated: item.summaryTruncated,
          artifactPaths: item.artifactPaths,
        })),
        failedBoundaryCount: workset.failedBoundaries.length,
        recommendedCapabilities: workset.recommendedCapabilities,
      },
  };
  return [
    "<conversation_turn_context source=\"server\">",
    JSON.stringify(payload),
    "</conversation_turn_context>",
  ].join("\n");
}

async function optionalPlanByRun(plans: PlanRepository, runId: string): Promise<ExecutionPlan | undefined> {
  try {
    return await plans.getByRun(runId);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
}

async function throwIfRunCancelled(runs: RunRepository, runId: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || (await runs.get(runId))?.status !== "running") {
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

function requiresConversationWorksetExecution(
  input: string,
  conversationWorkingSet: ConversationWorkingSet | undefined,
): boolean {
  if (conversationWorkingSet === undefined) return false;
  if (requestsPriorArtifactChange(input)) return true;
  const hasReusablePriorWork = conversationWorkingSet.reusableArtifacts.length > 0
    || (conversationWorkingSet.completedStepContexts?.length ?? 0) > 0
    || conversationWorkingSetHasCompletedStepContext(conversationWorkingSet);
  if (!hasReusablePriorWork) return false;
  return classifyTaskIntent({
    objective: input,
  }).wantsArtifact;
}

function requiresDeterministicConversationExecution(
  input: string,
  conversationWorkingSet: ConversationWorkingSet | undefined,
): boolean {
  return requiresExternalState(input)
    || requestsArtifactBuildFromIntent(input)
    || requiresConversationWorksetExecution(input, conversationWorkingSet);
}

function conversationWorkingSetHasCompletedStepContext(
  conversationWorkingSet: ConversationWorkingSet,
): boolean {
  return (conversationWorkingSet.completedStepContexts?.length ?? 0) > 0;
}

function hasLocalPathReference(input: string): boolean {
  return /(?:^|[\s"'`([{（【])(?:~\/|\.{1,2}\/|\/[a-z0-9._-]+\/|[a-z]:[\\/]|[a-z0-9._-]+\/[a-z0-9._/-]+)/iu
    .test(input);
}

function isSafeWorkspaceSegment(value: string): boolean {
  return value.length > 0
    && !value.includes("\0")
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== "..";
}

function parseCommandOutputResult(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseCommandOutputResult(parsed);
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

interface ToolArgumentsReference {
  readonly schema: "agentloop.toolArgumentsReference/v1";
  readonly path: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
  readonly previewCharacters?: number;
}

function toolArgumentsReference(value: unknown): ToolArgumentsReference | undefined {
  const record = parseCommandOutputResult(value);
  if (record === undefined || typeof record.path !== "string") return undefined;
  return {
    schema: "agentloop.toolArgumentsReference/v1",
    path: record.path,
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
    ...(typeof record.characters === "number" ? { characters: record.characters } : {}),
    ...(typeof record.previewCharacters === "number" ? { previewCharacters: record.previewCharacters } : {}),
  };
}

function inlineToolArgumentsContent(toolCallId: string, argumentsValue: unknown): ToolArgumentsContent {
  const content = formatToolArgumentsContent(argumentsValue);
  return {
    toolCallId,
    arguments: argumentsValue,
    content,
    bytes: Buffer.byteLength(content),
    characters: content.length,
  };
}

function serializeToolArguments(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? JSON.stringify(String(value)) : serialized;
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseStoredToolArguments(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw notFound("Tool arguments");
  }
}

function formatToolArgumentsContent(value: unknown): string {
  if (typeof value === "string") return value;
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? String(value) : formatted;
}

function projectToolArgumentsValue(
  value: unknown,
  reference: ToolArgumentsReference,
  serialized: string,
): unknown {
  const summarized = summarizeToolArgumentValue(value);
  if (Buffer.byteLength(serializeToolArguments(summarized)) <= TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES) return summarized;
  return {
    schema: "agentloop.toolArgumentsProjection/v1",
    projected: true,
    originalBytes: reference.bytes,
    originalCharacters: reference.characters,
    sha256: reference.sha256,
    preview: serialized.slice(0, TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS),
    omittedCharacters: Math.max(0, serialized.length - TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS),
    outline: outlineToolArguments(value),
  };
}

function summarizeToolArgumentValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) <= TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES) return value;
    const sha256 = createHash("sha256").update(value).digest("hex");
    return {
      schema: "agentloop.toolArgumentTextProjection/v1",
      projected: true,
      originalBytes: Buffer.byteLength(value),
      originalCharacters: value.length,
      sha256,
      preview: value.slice(0, TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS),
      omittedCharacters: Math.max(0, value.length - TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS),
    };
  }
  if (Array.isArray(value)) return value.map((item) => summarizeToolArgumentValue(item));
  const record = asRecord(value);
  if (record === undefined) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) projected[key] = summarizeToolArgumentValue(item);
  return projected;
}

function outlineToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    return { type: "string", characters: value.length, bytes: Buffer.byteLength(value) };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, 8).map((item) => outlineToolArguments(item)),
      truncated: value.length > 8,
    };
  }
  const record = asRecord(value);
  if (record === undefined) return { type: value === null ? "null" : typeof value };
  const entries = Object.entries(record);
  return {
    type: "object",
    keys: entries.slice(0, 24).map(([key, item]) => ({
      key,
      outline: outlineToolArguments(item),
    })),
    truncated: entries.length > 24,
  };
}

async function resolveToolArgumentsReference(workspaceRoot: string, path: string): Promise<string> {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) throw notFound("Tool arguments");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw notFound("Tool arguments");
  }
  if (!normalized.startsWith(".agentloop/tool-arguments/")) throw notFound("Tool arguments");
  const root = await fs.realpath(workspaceRoot);
  const target = resolve(root, normalized);
  const realTarget = await fs.realpath(target);
  const fromRoot = relative(root, realTarget);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw notFound("Tool arguments");
  }
  return realTarget;
}

function commandOutputReference(value: unknown): {
  readonly path: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
} | undefined {
  const record = parseCommandOutputResult(value);
  if (record === undefined || typeof record.path !== "string") return undefined;
  return {
    path: record.path,
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
    ...(typeof record.characters === "number" ? { characters: record.characters } : {}),
  };
}

async function resolveCommandOutputReference(workspaceRoot: string, path: string): Promise<string> {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) throw notFound("Command output");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw notFound("Command output");
  }
  const root = await fs.realpath(workspaceRoot);
  const target = resolve(root, normalized);
  const realTarget = await fs.realpath(target);
  const fromRoot = relative(root, realTarget);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw notFound("Command output");
  }
  return realTarget;
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

function toRunRecord(row: RunRow, sources: readonly UploadedSourceSummary[] = []): RunRecord {
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
    ...(sources.length === 0 ? {} : { sources }),
  };
}

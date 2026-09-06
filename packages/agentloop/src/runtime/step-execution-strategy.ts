import type { AgentLoopToolEvidence, ModelToolDefinition } from "./contracts.ts";
import type { StepSemanticFrame } from "./step-semantic-frame.ts";
import type { RuntimeStepArtifactRef, RuntimeStepEvidenceState } from "./tool-progress-policy.ts";

export interface StepExecutionInput {
  readonly modelStep: number;
  readonly maxSteps: number;
  readonly hardLimit: number;
  readonly convergenceOnly: boolean;
  readonly availableTools: readonly ModelToolDefinition[];
  readonly priorToolEvidence: readonly AgentLoopToolEvidence[];
  readonly stepEvidenceState?: RuntimeStepEvidenceState;
  readonly stepSemanticFrame?: Pick<StepSemanticFrame, "completionBoundary" | "evidenceMode" | "phaseRole">;
}

export interface StepExecutionDecision {
  readonly schema: "agentloop.stepExecutionDecision/v1";
  readonly strategyId: string;
  readonly loopStepFrame: LoopStepFrame;
  readonly toolCatalog: ToolCatalogDecision;
  readonly promptProjection: PromptProjectionDecision;
  readonly trace: StepExecutionPolicyTrace;
}

export interface StepExecutionStrategy {
  readonly id: string;
  prepareModelStep(input: StepExecutionInput): StepExecutionDecision;
}

export interface LoopStepPolicy {
  readonly id: string;
  buildFrame(input: LoopStepFrameInput): LoopStepFrame;
}

export interface ToolExposurePolicy {
  readonly id: string;
  selectTools(input: StepExecutionInput): ToolCatalogDecision;
}

export interface PromptProjectionPolicy {
  readonly id: string;
  buildProjection(input: StepExecutionInput, toolCatalog: ToolCatalogDecision): PromptProjectionDecision;
}

export interface LoopStepFrameInput extends StepExecutionInput {
  readonly toolCatalog: ToolCatalogDecision;
  readonly promptProjection: PromptProjectionDecision;
}

export interface LoopStepFrame {
  readonly schema: "agentloop.loopStepFrame/v1";
  readonly mode: "current_to_next" | "terminal_candidate";
  readonly modelStep: number;
  readonly limits: {
    readonly primaryMaxSteps: number;
    readonly hardLimit: number;
    readonly remainingIncludingCurrent: number;
  };
  readonly currentPlanStepBoundary?: {
    readonly phaseRole?: StepSemanticFrame["phaseRole"];
    readonly evidenceMode: StepSemanticFrame["evidenceMode"];
    readonly completionBoundary: readonly string[];
  };
  readonly priorEvidence: {
    readonly toolCallCount: number;
    readonly successfulToolCallCount: number;
    readonly failedToolCallCount: number;
    readonly recentToolNames: readonly string[];
  };
  readonly currentEvidenceState?: CompactLoopEvidenceState;
  readonly currentStage: {
    readonly objective: string;
    readonly toolUsePolicy: string;
    readonly availableToolCount: number;
  };
  readonly nextStage?: {
    readonly trigger: string;
    readonly objective: string;
  };
  readonly handoffContract: {
    readonly reusableOutputPolicy: string;
    readonly forbiddenMoves: readonly string[];
  };
  readonly toolCatalog?: LoopStepToolCatalogFrame;
  readonly projectionIntent?: PromptProjectionDecision;
}

export interface CompactLoopEvidenceState {
  readonly nextAction: RuntimeStepEvidenceState["nextAction"];
  readonly missingRequiredEvidenceKinds: readonly string[];
  readonly workProduct: {
    readonly status: RuntimeStepEvidenceState["workProduct"]["status"];
    readonly expectedArtifactKind?: string;
    readonly deliverableArtifactPaths: readonly string[];
    readonly processArtifactPaths: readonly string[];
    readonly deliverableArtifacts: readonly CompactLoopArtifactRef[];
    readonly processArtifacts: readonly CompactLoopArtifactRef[];
  };
  readonly recentActionableDiagnostic: boolean;
  readonly recentPatchPreconditionFailure: boolean;
  readonly evidenceProducingToolNames: readonly string[];
  readonly exploratoryToolNames: readonly string[];
}

export interface CompactLoopArtifactRef {
  readonly path: string;
  readonly sourceTool: string;
  readonly toolCallId: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly artifactKind?: string;
  readonly acceptanceProfile?: string;
}

export interface ToolCatalogDecision {
  readonly schema: "agentloop.toolCatalogDecision/v1";
  readonly policyId: string;
  readonly mode: "full" | "narrowed" | "none";
  readonly activeToolNames: readonly string[];
  readonly hiddenToolGroups: readonly HiddenToolGroup[];
}

export interface HiddenToolGroup {
  readonly group: string;
  readonly toolNames: readonly string[];
  readonly hiddenReason: string;
  readonly unlockWhen: string;
}

export interface LoopStepToolCatalogFrame {
  readonly policyId: string;
  readonly mode: ToolCatalogDecision["mode"];
  readonly activeToolCount: number;
  readonly hiddenToolGroups: readonly HiddenToolGroup[];
}

export interface PromptProjectionDecision {
  readonly schema: "agentloop.promptProjectionPolicy/v1";
  readonly policyId: string;
  readonly mode: "default" | "action_aware" | "custom";
  readonly instruction: string;
  readonly largeToolResultProjectionCharacters?: number;
  readonly largeToolResultPreviewCharacters?: number;
}

export interface StepExecutionPolicyTrace {
  readonly schema: "agentloop.stepExecutionPolicyTrace/v1";
  readonly strategyId: string;
  readonly loopStepPolicyId: string;
  readonly toolExposurePolicyId: string;
  readonly promptProjectionPolicyId: string;
}

export class DefaultStepExecutionStrategy implements StepExecutionStrategy {
  readonly id: string;
  private readonly loopStepPolicy: LoopStepPolicy;
  private readonly toolExposurePolicy: ToolExposurePolicy;
  private readonly promptProjectionPolicy: PromptProjectionPolicy;

  constructor(options: {
    readonly id?: string;
    readonly loopStepPolicy?: LoopStepPolicy;
    readonly toolExposurePolicy?: ToolExposurePolicy;
    readonly promptProjectionPolicy?: PromptProjectionPolicy;
  } = {}) {
    this.id = options.id ?? "agentloop.defaultStepExecutionStrategy/v1";
    this.loopStepPolicy = options.loopStepPolicy ?? new DefaultLoopStepPolicy();
    this.toolExposurePolicy = options.toolExposurePolicy ?? new DefaultToolExposurePolicy();
    this.promptProjectionPolicy = options.promptProjectionPolicy ?? new DefaultPromptProjectionPolicy();
  }

  prepareModelStep(input: StepExecutionInput): StepExecutionDecision {
    const toolCatalog = this.toolExposurePolicy.selectTools(input);
    const promptProjection = this.promptProjectionPolicy.buildProjection(input, toolCatalog);
    const loopStepFrame = this.loopStepPolicy.buildFrame({
      ...input,
      toolCatalog,
      promptProjection,
    });
    return {
      schema: "agentloop.stepExecutionDecision/v1",
      strategyId: this.id,
      loopStepFrame,
      toolCatalog,
      promptProjection,
      trace: {
        schema: "agentloop.stepExecutionPolicyTrace/v1",
        strategyId: this.id,
        loopStepPolicyId: this.loopStepPolicy.id,
        toolExposurePolicyId: this.toolExposurePolicy.id,
        promptProjectionPolicyId: this.promptProjectionPolicy.id,
      },
    };
  }
}

export class DefaultLoopStepPolicy implements LoopStepPolicy {
  readonly id = "agentloop.defaultLoopStepPolicy/v1";

  buildFrame(input: LoopStepFrameInput): LoopStepFrame {
    const priorSuccess = input.priorToolEvidence.filter((item) => !item.isError);
    const priorFailures = input.priorToolEvidence.filter((item) => item.isError);
    const mode = input.convergenceOnly || input.toolCatalog.activeToolNames.length === 0
      ? "terminal_candidate"
      : "current_to_next";
    return {
      schema: "agentloop.loopStepFrame/v1",
      mode,
      modelStep: input.modelStep,
      limits: {
        primaryMaxSteps: input.maxSteps,
        hardLimit: input.hardLimit,
        remainingIncludingCurrent: Math.max(0, input.hardLimit - input.modelStep + 1),
      },
      currentPlanStepBoundary: input.stepSemanticFrame === undefined
        ? undefined
        : {
          phaseRole: input.stepSemanticFrame.phaseRole,
          evidenceMode: input.stepSemanticFrame.evidenceMode,
          completionBoundary: input.stepSemanticFrame.completionBoundary,
        },
      priorEvidence: {
        toolCallCount: input.priorToolEvidence.length,
        successfulToolCallCount: priorSuccess.length,
        failedToolCallCount: priorFailures.length,
        recentToolNames: [...new Set(input.priorToolEvidence.slice(-6).map((item) => item.toolName))],
      },
      currentEvidenceState: input.stepEvidenceState === undefined
        ? undefined
        : compactLoopEvidenceState(input.stepEvidenceState),
      currentStage: {
        objective: loopCurrentStageObjective(mode, input.priorToolEvidence.length),
        toolUsePolicy: input.convergenceOnly
          ? "No tools are available in this stage; return a completion candidate from existing evidence."
          : input.stepEvidenceState !== undefined
            ? input.stepEvidenceState.instruction
          : input.priorToolEvidence.length === 0
            ? "If tools are needed, choose one bounded batch that advances the current Plan step evidence boundary."
            : "Inspect reusable prior evidence first; call tools only for missing, stale, contradictory, or explicitly refreshed facts.",
        availableToolCount: input.toolCatalog.activeToolNames.length,
      },
      ...(mode === "terminal_candidate"
        ? {}
        : {
          nextStage: {
            trigger: "after the current model step's tool results or completion candidate are committed",
            objective:
              "Consume the current stage's reusable evidence and either complete the current Plan step or request one targeted missing-evidence batch.",
          },
        }),
      handoffContract: {
        reusableOutputPolicy:
          "Name durable tool evidence, source summaries, artifact refs, caveats, and missing facts so the next loop step does not rediscover them.",
        forbiddenMoves: [
          "do not repeat a successful prior tool call for the same fact set",
          "do not request one obvious missing fact per model step when the same source family can provide the batch now",
          "do not summarize completion before the current Plan step evidence boundary is satisfied",
        ],
      },
      toolCatalog: {
        policyId: input.toolCatalog.policyId,
        mode: input.toolCatalog.mode,
        activeToolCount: input.toolCatalog.activeToolNames.length,
        hiddenToolGroups: input.toolCatalog.hiddenToolGroups,
      },
      projectionIntent: input.promptProjection,
    };
  }
}

export class DefaultToolExposurePolicy implements ToolExposurePolicy {
  readonly id = "agentloop.defaultToolExposurePolicy/v1";

  selectTools(input: StepExecutionInput): ToolCatalogDecision {
    const availableToolNames = input.availableTools.map((tool) => tool.name);
    if (input.convergenceOnly) {
      return {
        schema: "agentloop.toolCatalogDecision/v1",
        policyId: this.id,
        mode: "none",
        activeToolNames: [],
        hiddenToolGroups: hiddenToolGroups({
          hiddenToolNames: availableToolNames,
          state: input.stepEvidenceState,
          reason: "convergence-only model step",
          unlockWhen: "a later execution step exposes tools again",
        }),
      };
    }
    if (input.stepEvidenceState === undefined) {
      return fullToolCatalog(this.id, availableToolNames);
    }
    const selected = activeToolNamesForEvidenceState(input.stepEvidenceState, availableToolNames, input.priorToolEvidence);
    if (selected === undefined) {
      return fullToolCatalog(this.id, availableToolNames);
    }
    const activeToolNames = selected.filter((name) => availableToolNames.includes(name));
    if (activeToolNames.length === 0 && input.stepEvidenceState.nextAction !== "submit_completion_candidate") {
      return fullToolCatalog(this.id, availableToolNames);
    }
    const hiddenToolNames = availableToolNames.filter((name) => !activeToolNames.includes(name));
    return {
      schema: "agentloop.toolCatalogDecision/v1",
      policyId: this.id,
      mode: activeToolNames.length === availableToolNames.length
        ? "full"
        : activeToolNames.length === 0 ? "none" : "narrowed",
      activeToolNames,
      hiddenToolGroups: hiddenToolGroups({
        hiddenToolNames,
        state: input.stepEvidenceState,
        reason: `current nextAction is ${input.stepEvidenceState.nextAction}`,
        unlockWhen: unlockWhenForEvidenceState(input.stepEvidenceState),
      }),
    };
  }
}

export class DefaultPromptProjectionPolicy implements PromptProjectionPolicy {
  readonly id = "agentloop.defaultPromptProjectionPolicy/v1";
  private readonly diagnosticProjectionCharacters: number;
  private readonly diagnosticPreviewCharacters: number;
  private readonly terminalProjectionCharacters: number;
  private readonly terminalPreviewCharacters: number;

  constructor(options: {
    readonly diagnosticProjectionCharacters?: number;
    readonly diagnosticPreviewCharacters?: number;
    readonly terminalProjectionCharacters?: number;
    readonly terminalPreviewCharacters?: number;
  } = {}) {
    this.diagnosticProjectionCharacters = options.diagnosticProjectionCharacters ?? 4_096;
    this.diagnosticPreviewCharacters = options.diagnosticPreviewCharacters ?? 1_200;
    this.terminalProjectionCharacters = options.terminalProjectionCharacters ?? 2_048;
    this.terminalPreviewCharacters = options.terminalPreviewCharacters ?? 800;
    validateProjectionThresholds(this.diagnosticProjectionCharacters, this.diagnosticPreviewCharacters, "diagnostic");
    validateProjectionThresholds(this.terminalProjectionCharacters, this.terminalPreviewCharacters, "terminal");
  }

  buildProjection(input: StepExecutionInput, _toolCatalog: ToolCatalogDecision): PromptProjectionDecision {
    const thresholds = projectionThresholds(input.stepEvidenceState, {
      diagnosticProjectionCharacters: this.diagnosticProjectionCharacters,
      diagnosticPreviewCharacters: this.diagnosticPreviewCharacters,
      terminalProjectionCharacters: this.terminalProjectionCharacters,
      terminalPreviewCharacters: this.terminalPreviewCharacters,
    });
    return {
      schema: "agentloop.promptProjectionPolicy/v1",
      policyId: this.id,
      mode: input.stepEvidenceState === undefined ? "default" : "action_aware",
      instruction: input.stepEvidenceState === undefined
        ? "Use the Runtime's default structured evidence and large-result projection rules."
        : `Project prior results toward nextAction=${input.stepEvidenceState.nextAction}; preserve receipts, diagnostics, artifact refs, caveats, and missing evidence before raw content.`,
      ...thresholds,
    };
  }
}

export class FullCatalogToolExposurePolicy implements ToolExposurePolicy {
  readonly id = "agentloop.fullCatalogToolExposurePolicy/v1";

  selectTools(input: StepExecutionInput): ToolCatalogDecision {
    const activeToolNames = input.convergenceOnly ? [] : input.availableTools.map((tool) => tool.name);
    return fullToolCatalog(this.id, activeToolNames);
  }
}

export function createStepExecutionStrategyProfile(
  profile: "action-aware" | "full-catalog",
  options: {
    readonly diagnosticProjectionCharacters?: number;
    readonly diagnosticPreviewCharacters?: number;
    readonly terminalProjectionCharacters?: number;
    readonly terminalPreviewCharacters?: number;
  } = {},
): StepExecutionStrategy {
  const promptProjectionPolicy = new DefaultPromptProjectionPolicy(options);
  if (profile === "full-catalog") {
    return new DefaultStepExecutionStrategy({
      id: "agentloop.fullCatalogStepExecutionStrategy/v1",
      toolExposurePolicy: new FullCatalogToolExposurePolicy(),
      promptProjectionPolicy,
    });
  }
  return new DefaultStepExecutionStrategy({
    id: "agentloop.actionAwareStepExecutionStrategy/v1",
    promptProjectionPolicy,
  });
}

function fullToolCatalog(policyId: string, activeToolNames: readonly string[]): ToolCatalogDecision {
  return {
    schema: "agentloop.toolCatalogDecision/v1",
    policyId,
    mode: activeToolNames.length === 0 ? "none" : "full",
    activeToolNames,
    hiddenToolGroups: [],
  };
}

function activeToolNamesForEvidenceState(
  state: RuntimeStepEvidenceState,
  availableToolNames: readonly string[],
  priorToolEvidence: readonly AgentLoopToolEvidence[],
): readonly string[] | undefined {
  const setupToolNames = availableToolNames.filter((name) => SETUP_TOOL_NAMES.has(name));
  switch (state.nextAction) {
    case "acquire_source_evidence":
      return uniqueStrings([...setupToolNames, ...state.exploratoryToolNames]);
    case "produce_artifact":
      return state.recentPatchPreconditionFailure
        ? uniqueStrings([...setupToolNames, ...state.exploratoryToolNames, ...state.evidenceProducingToolNames])
        : uniqueStrings([...setupToolNames, ...state.evidenceProducingToolNames]);
    case "repair_artifact_source":
      return state.recentPatchPreconditionFailure
        ? uniqueStrings([...setupToolNames, ...state.exploratoryToolNames, ...state.evidenceProducingToolNames])
        : uniqueStrings([...setupToolNames, ...state.evidenceProducingToolNames]);
    case "verify_existing_artifact":
    case "produce_required_evidence":
      return uniqueStrings([...setupToolNames, ...state.evidenceProducingToolNames]);
    case "submit_completion_candidate":
      if (!hasSuccessfulNonSetupEvidence(priorToolEvidence)) return availableToolNames;
      return uniqueStrings([...setupToolNames, ...state.exploratoryToolNames]);
  }
}

function hiddenToolGroups(input: {
  readonly hiddenToolNames: readonly string[];
  readonly state?: RuntimeStepEvidenceState;
  readonly reason: string;
  readonly unlockWhen: string;
}): readonly HiddenToolGroup[] {
  if (input.hiddenToolNames.length === 0) return [];
  const groups = [
    toolGroup("setup", input.hiddenToolNames.filter((name) => SETUP_TOOL_NAMES.has(name))),
    toolGroup("read_only_exploration", input.hiddenToolNames.filter((name) => isExploratoryTool(name, input.state))),
    toolGroup("evidence_production", input.hiddenToolNames.filter((name) => isEvidenceProducingTool(name, input.state))),
    toolGroup("other_authorized_tools", input.hiddenToolNames.filter((name) =>
      !SETUP_TOOL_NAMES.has(name)
      && !isExploratoryTool(name, input.state)
      && !isEvidenceProducingTool(name, input.state)
    )),
  ];
  return groups
    .filter((group): group is { readonly group: string; readonly toolNames: readonly string[] } => group !== undefined)
    .map((group) => ({
      group: group.group,
      toolNames: group.toolNames,
      hiddenReason: input.reason,
      unlockWhen: input.unlockWhen,
    }));
}

function toolGroup(group: string, toolNames: readonly string[]): { readonly group: string; readonly toolNames: readonly string[] } | undefined {
  return toolNames.length === 0 ? undefined : { group, toolNames };
}

function isExploratoryTool(name: string, state: RuntimeStepEvidenceState | undefined): boolean {
  return state?.exploratoryToolNames.includes(name) === true || EXPLORATORY_TOOL_NAMES.has(name);
}

function isEvidenceProducingTool(name: string, state: RuntimeStepEvidenceState | undefined): boolean {
  return state?.evidenceProducingToolNames.includes(name) === true || EVIDENCE_PRODUCING_TOOL_NAMES.has(name);
}

function hasSuccessfulNonSetupEvidence(evidence: readonly AgentLoopToolEvidence[]): boolean {
  return evidence.some((item) => !item.isError && !SETUP_TOOL_NAMES.has(item.toolName));
}

function unlockWhenForEvidenceState(state: RuntimeStepEvidenceState): string {
  switch (state.nextAction) {
    case "acquire_source_evidence":
      return "source evidence is acquired or the evidence state changes to artifact production, repair, verification, or completion";
    case "produce_artifact":
      return "a deliverable artifact exists, an actionable diagnostic requires repair, or source acquisition becomes the next action";
    case "repair_artifact_source":
      return "the artifact source has been repaired, rerun, or the evidence state names a different next action";
    case "verify_existing_artifact":
      return "artifact acceptance is recorded or verification produces a diagnostic requiring repair";
    case "submit_completion_candidate":
      return "Assessment rejects the completion candidate or new evidence is required";
    case "produce_required_evidence":
      return "the missing required evidence changes to a more specific acquisition, artifact, verification, or completion action";
  }
}

function projectionThresholds(
  state: RuntimeStepEvidenceState | undefined,
  options: {
    readonly diagnosticProjectionCharacters: number;
    readonly diagnosticPreviewCharacters: number;
    readonly terminalProjectionCharacters: number;
    readonly terminalPreviewCharacters: number;
  },
): Pick<
  PromptProjectionDecision,
  "largeToolResultProjectionCharacters" | "largeToolResultPreviewCharacters"
> {
  if (state === undefined) return {};
  if (
    state.recentActionableDiagnostic
    || state.nextAction === "repair_artifact_source"
    || (state.nextAction === "produce_artifact" && state.workProduct.status === "process_artifact_available")
  ) {
    return {
      largeToolResultProjectionCharacters: options.diagnosticProjectionCharacters,
      largeToolResultPreviewCharacters: options.diagnosticPreviewCharacters,
    };
  }
  if (state.nextAction === "verify_existing_artifact" || state.nextAction === "submit_completion_candidate") {
    return {
      largeToolResultProjectionCharacters: options.terminalProjectionCharacters,
      largeToolResultPreviewCharacters: options.terminalPreviewCharacters,
    };
  }
  return {};
}

function validateProjectionThresholds(projection: number, preview: number, label: string): void {
  if (!Number.isInteger(projection) || projection < 1) {
    throw new TypeError(`${label} projection characters must be a positive integer`);
  }
  if (!Number.isInteger(preview) || preview < 1) {
    throw new TypeError(`${label} preview characters must be a positive integer`);
  }
  if (preview > projection) {
    throw new TypeError(`${label} preview characters must not exceed projection characters`);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const SETUP_TOOL_NAMES = new Set(["load_skill"]);
const EXPLORATORY_TOOL_NAMES = new Set([
  "computer_find_files",
  "computer_list_directory",
  "computer_read_file",
  "computer_read_files",
  "computer_read_json",
  "computer_search_text",
  "read_source",
  "visible_find_files",
  "visible_read_file",
  "visible_read_files",
  "visible_extract_tables",
  "visible_list_directory",
  "webfetch",
  "websearch",
]);
const EVIDENCE_PRODUCING_TOOL_NAMES = new Set([
  "computer_patch_file",
  "computer_write_file",
  "computer_run_command",
  "convert_artifact",
  "materialize_paginated_html",
  "visible_extract_tables",
  "verify_artifact_acceptance",
]);

function compactLoopEvidenceState(state: RuntimeStepEvidenceState): CompactLoopEvidenceState {
  return {
    nextAction: state.nextAction,
    missingRequiredEvidenceKinds: state.missingRequiredEvidenceKinds,
    workProduct: {
      status: state.workProduct.status,
      ...(state.workProduct.expectedArtifactKind === undefined
        ? {}
        : { expectedArtifactKind: state.workProduct.expectedArtifactKind }),
      deliverableArtifactPaths: state.workProduct.deliverableArtifacts.map((artifact) => artifact.path),
      processArtifactPaths: state.workProduct.processArtifacts.map((artifact) => artifact.path),
      deliverableArtifacts: state.workProduct.deliverableArtifacts.map(compactLoopArtifactRef),
      processArtifacts: state.workProduct.processArtifacts.map(compactLoopArtifactRef),
    },
    recentActionableDiagnostic: state.recentActionableDiagnostic,
    recentPatchPreconditionFailure: state.recentPatchPreconditionFailure,
    evidenceProducingToolNames: state.evidenceProducingToolNames,
    exploratoryToolNames: state.exploratoryToolNames,
  };
}

function compactLoopArtifactRef(artifact: RuntimeStepArtifactRef): CompactLoopArtifactRef {
  return {
    path: artifact.path,
    sourceTool: artifact.sourceTool,
    toolCallId: artifact.toolCallId,
    ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
    ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256 }),
    ...(artifact.artifactKind === undefined ? {} : { artifactKind: artifact.artifactKind }),
    ...(artifact.acceptanceProfile === undefined ? {} : { acceptanceProfile: artifact.acceptanceProfile }),
  };
}

function loopCurrentStageObjective(mode: "current_to_next" | "terminal_candidate", priorToolEvidenceCount: number): string {
  if (mode === "terminal_candidate") {
    return "Produce one non-empty completion candidate using only evidence already present in this Plan step.";
  }
  if (priorToolEvidenceCount === 0) {
    return "Plan and execute the first bounded evidence/tool batch for this Plan step.";
  }
  return "Advance from existing tool evidence toward completion without reacquiring already satisfied facts.";
}

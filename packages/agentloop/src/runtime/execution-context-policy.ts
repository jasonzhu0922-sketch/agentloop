import type { ConversationWorkingSet, ExecutionPlan, EvidenceKind, StepEvidence } from "../planning/contracts.ts";
import { formatAvailableSkills } from "../skills/skill-context.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import { skillExecutionRootEnvName } from "../tools/skill-loader.ts";
import type { DynamicPromptProfile, TaskProfile } from "./dynamic-prompt.ts";
import { formatDynamicPromptContext } from "./dynamic-prompt.ts";
import { deriveStepSemanticFrame } from "./step-semantic-frame.ts";
import { artifactStepToolProgressPolicy, type RuntimeToolProgressPolicy } from "./tool-progress-policy.ts";
import type {
  RuntimeContextSnapshot,
  SkillExecutionRootGrant,
  UploadedSourceSummary,
  VisibleDirectoryGrant,
} from "./contracts.ts";

export function buildStepRuntimeContextSnapshot(input: {
  readonly step: ExecutionPlan["steps"][number];
  readonly plan: ExecutionPlan;
  readonly skills: readonly PrivateSkill[];
  readonly workspaceRoot: string;
  readonly visibleDirectories?: readonly VisibleDirectoryGrant[];
  readonly sources?: readonly UploadedSourceSummary[];
  readonly skillExecutionRoots?: readonly SkillExecutionRootGrant[];
  readonly taskProfile: TaskProfile;
  readonly operationProfile: DynamicPromptProfile;
  readonly requiresFileOutput: boolean;
  readonly conversationWorkingSet?: ConversationWorkingSet;
}): Omit<RuntimeContextSnapshot, "id" | "supersedesId"> {
  const visibleDirectories = input.visibleDirectories ?? [];
  const sources = input.sources ?? [];
  const skillExecutionRoots = input.skillExecutionRoots ?? [];
  const usesWebTools = input.step.recommendedToolNames.some((name) => name === "websearch" || name === "webfetch");
  const usesVisibleDirectoryTools = input.step.recommendedToolNames.some((name) => name.startsWith("visible_"));
  const usesSourceTools = input.step.recommendedToolNames.some((name) => name === "read_source");
  const dependencyEvidenceBindings = buildDependencyEvidenceBindings(input.step, input.plan);
  const hasStructuredJsonArtifactDependencies = hasStructuredJsonArtifacts(dependencyEvidenceBindings);
  const conversationReuseContext = buildConversationReuseContext(input.conversationWorkingSet);
  const stepSemanticFrame = deriveStepSemanticFrame({
    step: input.step,
    plan: input.plan,
    skills: input.skills,
    visibleDirectories,
    sources,
    taskProfile: input.taskProfile,
    operationProfileId: input.operationProfile.id,
    requiresFileOutput: input.requiresFileOutput,
    conversationWorkingSet: input.conversationWorkingSet,
  });
  const evidenceAcquisitionDiscipline = buildEvidenceAcquisitionDiscipline({
    stepSemanticFrame,
    usesWebTools,
    usesVisibleDirectoryTools,
    usesSourceTools,
  });
  return {
    phase: "execution",
    content: [
      "<execution_context source=\"server\">",
      JSON.stringify({
        toolSelectionPolicy: {
          recommendedToolNamesAreAdvisory: true,
          instruction: "Use the recommended tools as a starting point, but choose any currently exposed tool when it better satisfies the current step evidence contract.",
          beforeWritingCustomCode: "Before writing a script or custom code to create, convert, inspect, or verify an artifact, check whether an exposed purpose-built Tool or loaded Skill workflow already handles that operation.",
          beforeAcquiringEvidence: "Before searching, listing directories, reading source files, or re-running extraction, inspect dependencyEvidenceBindings and conversationReuseContext. Reuse existing satisfied receipts, source summaries, and artifact references first; acquire new evidence only for missing, stale, contradictory, or explicitly refreshed requirements. When several missing facts are independent, batch the reads/searches/queries in the same turn instead of fetching one fact, waiting for assessment, and then fetching the next.",
        },
        currentPlanStep: {
          id: input.step.id,
          objective: input.step.objective,
          role: input.step.role,
          recommendedToolNames: input.step.recommendedToolNames,
          ...(input.step.evidenceContract === undefined ? {} : { evidenceContract: input.step.evidenceContract }),
          successCriteria: input.step.successCriteria,
        },
        stepSemanticFrame,
        downstreamPlanSteps: input.plan.steps
          .filter((item) =>
            item.id !== input.step.id
            && item.retiredAt === undefined
            && item.status !== "completed"
            && item.dependencies.includes(input.step.id)
          )
          .map((item) => ({
            id: item.id,
            objective: item.objective,
            status: item.status,
            recommendedToolNames: item.recommendedToolNames,
            successCriteria: item.successCriteria,
          })),
        dependencyOutputs: input.step.dependencies.map((dependencyId) => {
          const dependency = input.plan.steps.find((item) => item.id === dependencyId);
          return { stepId: dependencyId, output: dependency?.output ?? "" };
        }),
        ...(dependencyEvidenceBindings === undefined ? {} : { dependencyEvidenceBindings }),
        ...(hasStructuredJsonArtifactDependencies
          ? {
            structuredArtifactConsumptionDiscipline:
              "Dependency evidence includes durable structured JSON artifacts. First inspect artifact schema and any manifest in dependencyEvidenceBindings; for agentloop.tableExtractionArtifact/v1, use the manifest table entries and their recordsPointer/rowsPointer/columnsPointer with computer_read_json JSON Pointer queries and array windows. Use computer_summarize_table_artifact first to cover all manifest tables with compact field/count/stat summaries; then use computer_read_json only for missing details or narrow windows. Use computer_search_text only for unknown keyword locations in unstructured text, or when the manifest/profile is insufficient after structured reads.",
          }
          : {}),
        ...(evidenceAcquisitionDiscipline === undefined ? {} : { evidenceAcquisitionDiscipline }),
        workspace: { root: input.workspaceRoot, filePolicy: "workspace-write" },
        visibleDirectories,
        visibleCommandRoots: visibleDirectories.map((root) => ({
          rootId: root.id,
          name: root.name,
          cwd: `@visible/${root.id}`,
          readOnly: true,
        })),
        sources,
        skillExecutionRoots: skillExecutionRoots.map((root) => ({
          id: root.id,
          skillId: root.skillId,
          name: root.name,
          cwd: root.cwd,
          env: skillExecutionRootEnvName(root),
          readOnly: true,
        })),
        ...(input.conversationWorkingSet?.evidenceLedger === undefined
          ? {}
          : { conversationEvidenceLedger: input.conversationWorkingSet.evidenceLedger }),
        ...(conversationReuseContext === undefined ? {} : { conversationReuseContext }),
        operationProfile: input.operationProfile,
        ...(skillExecutionRoots.length > 0 && input.requiresFileOutput
          ? { skillArtifactWorkflowDiscipline: skillArtifactWorkflowDiscipline(input.workspaceRoot, skillExecutionRoots) }
          : {}),
        ...(usesWebTools && input.taskProfile.researchPolicy !== undefined
          ? {
            researchPolicy: input.taskProfile.researchPolicy,
            researchDiscipline:
              "Apply researchPolicy only to the current Plan step. Use complete intent-level queries, prefer high-tier sources, classify low-value pages as caveats, and stop when the policy budget or source-summary boundary is reached.",
          }
          : {}),
        ...(usesVisibleDirectoryTools
          ? {
            visibleSourceDiscipline:
              "Use visible_* tools for user-authorized visibleDirectories. Treat visible_read_file and visible_read_files "
              + "and visible_extract_tables results as successful source reads even when later context shows only structured evidence projections; "
              + "the full canonical tool evidence remains persisted for assessment. Prefer visible_read_files batches for "
              + "multiple text sourceRefs, and visible_extract_tables for spreadsheet sourceRefs when table rows are needed. Do not switch to computer_read_file for visible directory sources; computer_read_file "
              + "reads the workspace root, not the visible directory grant. If computer_run_command is needed to process "
              + "visible source files with a local parser, set cwd to the matching read-only @visible/<rootId> command root "
              + "from visibleCommandRoots and pass the relative paths/sourceRefs returned by visible_* tools. Do not reconstruct "
              + "absolute visible-directory paths, and do not use ls/find for visible source discovery.",
          }
          : {}),
        ...(usesSourceTools
          ? {
            uploadedSourceDiscipline:
              "Use read_source for uploaded sources listed in sources. Treat read_source results as canonical "
              + "source evidence. When reading consecutive uploaded chunks, pass chunkIndex as the start and "
              + "maxChunks as the window size. "
              + "Do not use computer_read_file for uploaded sources; uploaded source storage "
              + "paths are not a workspace authorization surface. Do not claim complete file analysis beyond "
              + "the summary and chunks actually inspected.",
          }
          : {}),
      }),
      "</execution_context>",
      formatDynamicPromptContext(input.taskProfile),
      formatAvailableSkills(input.skills),
    ].filter(Boolean).join("\n"),
  };
}

function buildEvidenceAcquisitionDiscipline(input: {
  readonly stepSemanticFrame: Pick<ReturnType<typeof deriveStepSemanticFrame>, "phaseRole" | "evidenceMode" | "firstAction">;
  readonly usesWebTools: boolean;
  readonly usesVisibleDirectoryTools: boolean;
  readonly usesSourceTools: boolean;
}): string | undefined {
  const shouldGuideAcquisition = input.stepSemanticFrame.phaseRole === "evidence_acquisition"
    || input.stepSemanticFrame.evidenceMode === "acquire_new_evidence"
    || input.stepSemanticFrame.firstAction === "inspect_available_sources"
    || input.usesWebTools
    || input.usesVisibleDirectoryTools
    || input.usesSourceTools;
  if (!shouldGuideAcquisition) return undefined;
  const lines = [
    "Treat the current step as one acquisition pass, not a fact-by-fact conversation.",
    "Before calling tools, identify the full set of independent facts needed to satisfy the current evidence contract.",
    "When several facts can be discovered from the same source family, fetch them in the same turn and prefer batch-capable or windowed reads over serial one-fact-at-a-time loops.",
    "Use visible_read_files batches for multiple visible file reads, read_source chunk windows for consecutive uploaded source chunks, and multiple web queries only when they are genuinely independent.",
    "Do not wait for Assessment to ask for the next obvious fact if the same source family can provide it now.",
  ];
  return lines.join(" ");
}

export function buildStepToolProgressPolicy(input: {
  readonly step: ExecutionPlan["steps"][number];
  readonly requiresFileOutput: boolean;
  readonly taskProfile?: TaskProfile;
}): RuntimeToolProgressPolicy | undefined {
  if (!input.requiresFileOutput && !stepRequiresArtifactEvidence(input.step)) return undefined;
  return artifactStepToolProgressPolicy(input.step.evidenceContract?.requiredKinds ?? [], {
    expectedArtifactKind: input.taskProfile?.artifactKind === "none" ? undefined : input.taskProfile?.artifactKind,
  });
}

function skillArtifactWorkflowDiscipline(
  workspaceRoot: string,
  skillExecutionRoots: readonly SkillExecutionRootGrant[],
): {
  readonly schema: "agentloop.skillArtifactWorkflowDiscipline/v1";
  readonly instruction: string;
  readonly commandRoots: readonly {
    readonly cwd: string;
    readonly name: string;
    readonly readOnly: true;
    readonly usage: string;
  }[];
  readonly writableWorkspaceRoot: string;
  readonly rules: readonly string[];
} {
  return {
    schema: "agentloop.skillArtifactWorkflowDiscipline/v1",
    instruction: "Apply only to the current Skill-bound file/artifact step.",
    commandRoots: skillExecutionRoots.map((root) => ({
      cwd: root.cwd,
      name: root.name,
      readOnly: true,
      usage: "Use this cwd to run package scripts and read package assets; do not create outputs relative to this root.",
    })),
    writableWorkspaceRoot: workspaceRoot,
    rules: [
      "If computer_run_command cwd is a read-only @skills/<name> root, writable arguments such as --workspace, --output, --outdir, --input-output workspace paths, or generated source paths must resolve under writableWorkspaceRoot.",
      "A relative writable argument passed while cwd is @skills/<name> resolves under the read-only Skill package and can trigger SKILL_PACKAGE_MUTATED; pass an absolute path under writableWorkspaceRoot or run from the workspace root when the Skill script supports it.",
      "After the required Skill entrypoint and generated brief/readiness file are read, move to authoring or building the artifact. Do not continue listing, searching, or reading Skill references unless a validator, build, render, or acceptance diagnostic identifies a concrete missing field or contract.",
      "Do not add optional strict QA or fail-on-warning command flags merely because a Skill supports them. Use strict QA gates only when the currentPlanStep evidenceContract, the user request, or a concrete Skill delivery rubric requires that QA evidence; otherwise surface warnings and continue toward artifact_path, artifact_non_empty, artifact_openable, format_matches_request, and artifact_acceptance.",
      "Completion still requires the currentPlanStep evidenceContract; Skill instructions, command success, and fileChanges are inputs to that evidence, not terminal completion by themselves.",
    ],
  };
}

function buildDependencyEvidenceBindings(
  step: ExecutionPlan["steps"][number],
  plan: ExecutionPlan,
):
  | {
      readonly schema: "agentloop.dependencyEvidenceBindings/v1";
      readonly instruction: string;
      readonly currentStepId: string;
      readonly bindings: readonly DependencyEvidenceBinding[];
    }
  | undefined {
  if (step.dependencies.length === 0) return undefined;
  const bindings = step.dependencies
    .map((dependencyId): DependencyEvidenceBinding | undefined => {
      const dependency = plan.steps.find((item) => item.id === dependencyId);
      if (dependency === undefined) return {
        stepId: dependencyId,
        status: "missing",
        output: "",
        satisfiedEvidenceKinds: [],
        caveatedEvidenceKinds: [],
        failedEvidenceKinds: [],
        missingRequiredEvidenceKinds: [],
        toolEvidence: [],
      };
      const summary = summarizeStepEvidence(dependency.evidence);
      const requiredKinds = dependency.evidenceContract?.requiredKinds ?? [];
      const satisfied = new Set(summary.satisfiedEvidenceKinds);
      const missingRequiredEvidenceKinds = requiredKinds.filter((kind) => !satisfied.has(kind));
      return {
        stepId: dependency.id,
        objective: dependency.objective,
        status: dependency.status,
        output: truncateContextText(dependency.output ?? "", DEPENDENCY_OUTPUT_LIMIT),
        ...(requiredKinds.length === 0 ? {} : { requiredEvidenceKinds: requiredKinds }),
        satisfiedEvidenceKinds: summary.satisfiedEvidenceKinds,
        caveatedEvidenceKinds: summary.caveatedEvidenceKinds,
        failedEvidenceKinds: summary.failedEvidenceKinds,
        missingRequiredEvidenceKinds,
        ...(dependency.evidence?.completionCaveat === undefined
          ? {}
          : { completionCaveat: dependency.evidence.completionCaveat }),
        ...(summary.sourceSummaryCandidate === undefined
          ? {}
          : { sourceSummaryCandidate: summary.sourceSummaryCandidate }),
        toolEvidence: summary.toolEvidence,
      };
    })
    .filter((binding): binding is DependencyEvidenceBinding => binding !== undefined);
  if (bindings.length === 0) return undefined;
  return {
    schema: "agentloop.dependencyEvidenceBindings/v1",
    instruction:
      "Evaluate these dependency bindings before acquiring new source evidence. Treat satisfied kinds and artifact refs as reusable inputs for the current step; preserve caveats and acquire only missing, stale, contradictory, or explicitly refreshed evidence.",
    currentStepId: step.id,
    bindings,
  };
}

interface DependencyEvidenceBinding {
  readonly stepId: string;
  readonly objective?: string;
  readonly status: ExecutionPlan["steps"][number]["status"] | "missing";
  readonly output: string;
  readonly requiredEvidenceKinds?: readonly EvidenceKind[];
  readonly satisfiedEvidenceKinds: readonly string[];
  readonly caveatedEvidenceKinds: readonly string[];
  readonly failedEvidenceKinds: readonly string[];
  readonly missingRequiredEvidenceKinds: readonly EvidenceKind[];
  readonly completionCaveat?: StepEvidence["completionCaveat"];
  readonly sourceSummaryCandidate?: unknown;
  readonly toolEvidence: readonly ProjectedToolEvidence[];
}

interface ProjectedToolEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly resultSchemas: readonly string[];
  readonly evidenceKinds?: {
    readonly satisfied: readonly string[];
    readonly caveated: readonly string[];
    readonly failed: readonly string[];
  };
  readonly artifacts?: readonly ProjectedArtifactRef[];
  readonly sourceRefs?: readonly unknown[];
  readonly preview: string;
  readonly previewTruncated: boolean;
}

interface ProjectedArtifactRef {
  readonly path: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly schema?: string;
  readonly kind?: string;
  readonly manifest?: unknown;
}

function summarizeStepEvidence(evidence: StepEvidence | undefined): {
  readonly satisfiedEvidenceKinds: readonly string[];
  readonly caveatedEvidenceKinds: readonly string[];
  readonly failedEvidenceKinds: readonly string[];
  readonly sourceSummaryCandidate?: unknown;
  readonly toolEvidence: readonly ProjectedToolEvidence[];
} {
  const satisfied = new Set<string>();
  const caveated = new Set<string>();
  const failed = new Set<string>();
  const sourceSummaryCandidate = parseSourceSummaryCandidate(evidence?.candidateOutput);
  if (sourceSummaryCandidate !== undefined) satisfied.add("source_summary");
  const toolEvidence = (evidence?.toolCalls ?? [])
    .slice(-DEPENDENCY_TOOL_EVIDENCE_LIMIT)
    .map((toolCall) => {
      const parsed = parseJsonRecord(toolCall.result);
      const projection = projectToolResult(parsed);
      for (const kind of projection.evidenceKinds?.satisfied ?? []) satisfied.add(kind);
      for (const kind of projection.evidenceKinds?.caveated ?? []) caveated.add(kind);
      for (const kind of projection.evidenceKinds?.failed ?? []) failed.add(kind);
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        isError: toolCall.isError,
        resultSchemas: projection.resultSchemas,
        ...(projection.evidenceKinds === undefined ? {} : { evidenceKinds: projection.evidenceKinds }),
        ...(projection.artifacts.length === 0 ? {} : { artifacts: projection.artifacts }),
        ...(projection.sourceRefs.length === 0 ? {} : { sourceRefs: projection.sourceRefs }),
        preview: truncateContextText(compactToolResultPreview(toolCall.result, parsed), DEPENDENCY_TOOL_PREVIEW_LIMIT),
        previewTruncated: toolCall.result.length > DEPENDENCY_TOOL_PREVIEW_LIMIT,
      };
    });
  return {
    satisfiedEvidenceKinds: [...satisfied].sort(),
    caveatedEvidenceKinds: [...caveated].sort(),
    failedEvidenceKinds: [...failed].sort(),
    ...(sourceSummaryCandidate === undefined ? {} : { sourceSummaryCandidate }),
    toolEvidence,
  };
}

function buildConversationReuseContext(
  workset: ConversationWorkingSet | undefined,
):
  | {
      readonly schema: "agentloop.conversationReuseContext/v1";
      readonly instruction: string;
      readonly reusableArtifacts: ConversationWorkingSet["reusableArtifacts"];
      readonly sourceSummaries?: NonNullable<ConversationWorkingSet["evidenceLedger"]>["sourceSummaries"];
    }
  | undefined {
  if (workset === undefined) return undefined;
  const sourceSummaries = workset.evidenceLedger?.sourceSummaries ?? [];
  if (workset.reusableArtifacts.length === 0 && sourceSummaries.length === 0) return undefined;
  return {
    schema: "agentloop.conversationReuseContext/v1",
    instruction:
      "Use prior conversation artifacts and source summaries as reusable context before re-running equivalent acquisition. Re-read or regenerate only when the current step needs fresher, stricter, missing, or contradictory evidence.",
    reusableArtifacts: workset.reusableArtifacts,
    ...(sourceSummaries.length === 0 ? {} : { sourceSummaries }),
  };
}

function projectToolResult(result: Record<string, unknown> | undefined): {
  readonly resultSchemas: readonly string[];
  readonly evidenceKinds?: {
    readonly satisfied: readonly string[];
    readonly caveated: readonly string[];
    readonly failed: readonly string[];
  };
  readonly artifacts: readonly ProjectedArtifactRef[];
  readonly sourceRefs: readonly unknown[];
} {
  if (result === undefined) return { resultSchemas: [], artifacts: [], sourceRefs: [] };
  const schemas = new Set<string>();
  const satisfied = new Set<string>();
  const caveated = new Set<string>();
  const failed = new Set<string>();
  const artifacts: ProjectedArtifactRef[] = [];
  const sourceRefs: unknown[] = [];
  collectReceiptProjection(result, schemas, satisfied, caveated, failed, artifacts, sourceRefs);
  const evidenceKinds = satisfied.size === 0 && caveated.size === 0 && failed.size === 0
    ? undefined
    : {
      satisfied: [...satisfied].sort(),
      caveated: [...caveated].sort(),
      failed: [...failed].sort(),
    };
  return {
    resultSchemas: [...schemas].sort(),
    ...(evidenceKinds === undefined ? {} : { evidenceKinds }),
    artifacts,
    sourceRefs,
  };
}

function collectReceiptProjection(
  record: Record<string, unknown>,
  schemas: Set<string>,
  satisfied: Set<string>,
  caveated: Set<string>,
  failed: Set<string>,
  artifacts: ProjectedArtifactRef[],
  sourceRefs: unknown[],
): void {
  addStringField(record.schema, schemas);
  addEvidenceKinds(record.evidenceKinds, satisfied, caveated, failed);
  addArtifactRef(record.artifact, artifacts);
  addSourceRefs(record.sourceRefs, sourceRefs);
  const evidenceReceipt = asRecord(record.evidenceReceipt);
  if (evidenceReceipt !== undefined) {
    addStringField(evidenceReceipt.schema, schemas);
    addEvidenceKinds(evidenceReceipt.evidenceKinds, satisfied, caveated, failed);
    addSourceRefs(evidenceReceipt.sourceRefs, sourceRefs);
  }
  const artifactReceipt = asRecord(record.artifactReceipt);
  if (artifactReceipt !== undefined) {
    addStringField(artifactReceipt.schema, schemas);
    addEvidenceKinds(artifactReceipt.evidenceKinds, satisfied, caveated, failed);
    addArtifactRef(artifactReceipt.artifact, artifacts);
  }
}

function addStringField(value: unknown, target: Set<string>): void {
  if (typeof value === "string" && value.trim().length > 0) target.add(value);
}

function addEvidenceKinds(
  value: unknown,
  satisfied: Set<string>,
  caveated: Set<string>,
  failed: Set<string>,
): void {
  const record = asRecord(value);
  if (record === undefined) return;
  for (const kind of stringArray(record.satisfied)) satisfied.add(kind);
  for (const kind of stringArray(record.caveated)) caveated.add(kind);
  for (const kind of stringArray(record.failed)) failed.add(kind);
}

function addArtifactRef(value: unknown, artifacts: ProjectedArtifactRef[]): void {
  const record = asRecord(value);
  if (record === undefined || typeof record.path !== "string" || record.path.trim().length === 0) return;
  artifacts.push({
    path: record.path,
    ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
    ...(typeof record.sha256 === "string" && record.sha256.trim().length > 0 ? { sha256: record.sha256 } : {}),
    ...(typeof record.schema === "string" && record.schema.trim().length > 0 ? { schema: record.schema } : {}),
    ...(typeof record.kind === "string" && record.kind.trim().length > 0 ? { kind: record.kind } : {}),
    ...(record.manifest === undefined ? {} : { manifest: record.manifest }),
  });
}

function hasStructuredJsonArtifacts(
  bindings: ReturnType<typeof buildDependencyEvidenceBindings>,
): boolean {
  return bindings?.bindings.some((binding) =>
    binding.toolEvidence.some((evidence) =>
      evidence.resultSchemas.includes("agentloop.visibleTableExtraction/v1")
      || evidence.resultSchemas.includes("agentloop.tableExtractionArtifact/v1")
      || evidence.artifacts?.some((artifact) =>
        artifact.schema === "agentloop.tableExtractionArtifact/v1"
        || artifact.path.endsWith(".json")
      ) === true
    )
  ) === true;
}

function addSourceRefs(value: unknown, sourceRefs: unknown[]): void {
  if (!Array.isArray(value)) return;
  const remaining = DEPENDENCY_SOURCE_REF_LIMIT - sourceRefs.length;
  if (remaining <= 0) return;
  sourceRefs.push(...value.slice(0, remaining));
}

function compactToolResultPreview(raw: string, parsed: Record<string, unknown> | undefined): string {
  if (parsed === undefined) return raw;
  const compact: Record<string, unknown> = {};
  for (const key of ["schema", "path", "rootId", "exitCode", "signal", "stdout", "stderr", "content", "artifact", "artifactReceipt", "evidenceReceipt", "evidenceKinds", "caveats"] as const) {
    if (parsed[key] !== undefined) compact[key] = parsed[key];
  }
  return Object.keys(compact).length === 0 ? raw : JSON.stringify(compact);
}

function parseSourceSummaryCandidate(value: string | undefined): unknown {
  const record = parseJsonRecord(value);
  return record?.schema === "agentloop.sourceSummaryCandidate/v1" ? record : undefined;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function truncateContextText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}...`;
}

function stepRequiresArtifactEvidence(step: ExecutionPlan["steps"][number]): boolean {
  return step.evidenceContract?.requiredKinds.some((kind) =>
    kind === "artifact_path"
    || kind === "artifact_non_empty"
    || kind === "artifact_openable"
    || kind === "format_matches_request"
    || kind === "artifact_acceptance"
    || kind === "delivery_receipt"
  ) ?? false;
}

const DEPENDENCY_OUTPUT_LIMIT = 1_200;
const DEPENDENCY_TOOL_EVIDENCE_LIMIT = 12;
const DEPENDENCY_TOOL_PREVIEW_LIMIT = 900;
const DEPENDENCY_SOURCE_REF_LIMIT = 12;

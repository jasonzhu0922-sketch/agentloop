import type { AgentLoopToolEvidence, ModelToolCall } from "./contracts.ts";

export interface RuntimeToolProgressPolicy {
  readonly schema: "agentloop.runtimeToolProgressPolicy/v1";
  readonly requiredEvidenceKinds: readonly string[];
  readonly expectedArtifactKind?: string;
  readonly autoCompleteFromEvidence?: boolean;
  readonly maxExploratoryPrimarySteps: number;
  readonly maxExploratoryGraceSteps: number;
  readonly exploratoryToolNames: readonly string[];
  readonly setupToolNames: readonly string[];
  readonly evidenceProducingToolNames: readonly string[];
  readonly repairDirective: string;
  readonly diagnosticRepairDirective: string;
}

export interface RuntimeToolProgressState {
  readonly exploratoryOnlyPrimarySteps: number;
  readonly exploratoryOnlyPrimaryRejections: number;
  readonly exploratoryOnlyGraceSteps: number;
  readonly exploratoryOnlyRejections: number;
  readonly diagnosticExploratoryRejections: number;
  readonly nonDeliverableSourceMutationRejections: number;
}

export interface RuntimeToolProgressDecision {
  readonly allow: boolean;
  readonly state: RuntimeToolProgressState;
  readonly reason?: string;
  readonly stalled?: boolean;
  readonly directive?: string;
}

export type RuntimeStepNextAction =
  | "acquire_source_evidence"
  | "produce_artifact"
  | "verify_existing_artifact"
  | "repair_artifact_source"
  | "submit_completion_candidate"
  | "produce_required_evidence";

export type RuntimeStepWorkProductStatus =
  | "none"
  | "process_artifact_available"
  | "deliverable_available"
  | "accepted";

export interface RuntimeStepArtifactRef {
  readonly path: string;
  readonly sourceTool: string;
  readonly toolCallId: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly artifactKind?: string;
  readonly acceptanceProfile?: string;
}

export interface RuntimeStepWorkProductState {
  readonly schema: "agentloop.runtimeStepWorkProductState/v1";
  readonly status: RuntimeStepWorkProductStatus;
  readonly acceptanceRequired: boolean;
  readonly expectedArtifactKind?: string;
  readonly deliverableArtifacts: readonly RuntimeStepArtifactRef[];
  readonly processArtifacts: readonly RuntimeStepArtifactRef[];
}

export interface RuntimeStepEvidenceState {
  readonly schema: "agentloop.runtimeStepEvidenceState/v1";
  readonly requiredEvidenceKinds: readonly string[];
  readonly satisfiedEvidenceKinds: readonly string[];
  readonly caveatedEvidenceKinds: readonly string[];
  readonly failedEvidenceKinds: readonly string[];
  readonly missingRequiredEvidenceKinds: readonly string[];
  readonly workProduct: RuntimeStepWorkProductState;
  readonly knownArtifacts: readonly RuntimeStepArtifactRef[];
  readonly processArtifacts: readonly RuntimeStepArtifactRef[];
  readonly recentActionableDiagnostic: boolean;
  readonly recentPatchPreconditionFailure: boolean;
  readonly nextAction: RuntimeStepNextAction;
  readonly evidenceProducingToolNames: readonly string[];
  readonly exploratoryToolNames: readonly string[];
  readonly instruction: string;
}

export interface RuntimeEvidenceCompletionCandidate {
  readonly schema: "agentloop.runtimeEvidenceCompletionCandidate/v1";
  readonly output: string;
  readonly requiredEvidenceKinds: readonly string[];
  readonly satisfiedEvidenceKinds: readonly string[];
  readonly caveatedEvidenceKinds: readonly string[];
  readonly sourceToolCallIds: readonly string[];
  readonly artifacts: readonly RuntimeStepArtifactRef[];
}

export function initialRuntimeToolProgressState(): RuntimeToolProgressState {
  return {
    exploratoryOnlyPrimarySteps: 0,
    exploratoryOnlyPrimaryRejections: 0,
    exploratoryOnlyGraceSteps: 0,
    exploratoryOnlyRejections: 0,
    diagnosticExploratoryRejections: 0,
    nonDeliverableSourceMutationRejections: 0,
  };
}

export function deriveEvidenceCompletionCandidate(input: {
  readonly policy?: RuntimeToolProgressPolicy;
  readonly evidence: readonly AgentLoopToolEvidence[];
  readonly latestEvidence: readonly AgentLoopToolEvidence[];
  readonly userInput?: string;
}): RuntimeEvidenceCompletionCandidate | undefined {
  const policy = input.policy;
  if (policy === undefined || policy.requiredEvidenceKinds.length === 0) return undefined;
  if (policy.autoCompleteFromEvidence !== true) return undefined;
  if (input.latestEvidence.length === 0 || input.latestEvidence.some((item) => item.isError)) return undefined;
  const evidenceKinds = collectPolicyEvidenceKinds(input.evidence, policy);
  const workProduct = classifyWorkProduct(input.evidence, policy, evidenceKinds);
  const successfulToolCallIds = input.evidence
    .filter((item) => !item.isError)
    .map((item) => item.toolCallId);
  const missingRequiredEvidenceKinds = policy.requiredEvidenceKinds.filter((kind) =>
    !evidenceKindSatisfiedByCompletionGate(kind, evidenceKinds)
  );
  if (missingRequiredEvidenceKinds.length > 0) return undefined;
  const artifacts = workProduct.deliverableArtifacts;
  const satisfiedEvidenceKinds = [...evidenceKinds.satisfied].sort();
  const caveatedEvidenceKinds = [...evidenceKinds.caveated].sort();
  const sourceToolCallIds = uniqueStrings(successfulToolCallIds);
  return {
    schema: "agentloop.runtimeEvidenceCompletionCandidate/v1",
    output: formatEvidenceCompletionDelivery({
      artifacts,
      caveatedEvidenceKinds,
      language: preferredDeliveryLanguage(input.userInput),
    }),
    requiredEvidenceKinds: policy.requiredEvidenceKinds,
    satisfiedEvidenceKinds,
    caveatedEvidenceKinds,
    sourceToolCallIds,
    artifacts,
  };
}

export function deriveRuntimeStepEvidenceState(input: {
  readonly policy?: RuntimeToolProgressPolicy;
  readonly evidence: readonly AgentLoopToolEvidence[];
}): RuntimeStepEvidenceState | undefined {
  const policy = input.policy;
  if (policy === undefined) return undefined;
  const evidenceKinds = collectPolicyEvidenceKinds(input.evidence, policy);
  const missingRequiredEvidenceKinds = policy.requiredEvidenceKinds
    .filter((kind) => !evidenceKinds.satisfied.has(kind));
  const workProduct = classifyWorkProduct(input.evidence, policy, evidenceKinds);
  const recentActionableDiagnostic = hasRecentActionableDiagnostic(input.evidence);
  const recentPatchPreconditionFailure = hasRecentPatchPreconditionFailure(input.evidence);
  const nextAction = nextActionForEvidenceGap({
    missingRequiredEvidenceKinds,
    failedEvidenceKinds: [...evidenceKinds.failed],
    workProduct,
    policy,
  });
  const evidenceProducingToolNames = evidenceProducingToolsForAction(nextAction, policy);
  return {
    schema: "agentloop.runtimeStepEvidenceState/v1",
    requiredEvidenceKinds: policy.requiredEvidenceKinds,
    satisfiedEvidenceKinds: [...evidenceKinds.satisfied].sort(),
    caveatedEvidenceKinds: [...evidenceKinds.caveated].sort(),
    failedEvidenceKinds: [...evidenceKinds.failed].sort(),
    missingRequiredEvidenceKinds,
    workProduct,
    knownArtifacts: workProduct.deliverableArtifacts,
    processArtifacts: workProduct.processArtifacts,
    recentActionableDiagnostic,
    recentPatchPreconditionFailure,
    nextAction,
    evidenceProducingToolNames,
    exploratoryToolNames: recentPatchPreconditionFailure
      ? policy.exploratoryToolNames.filter((name) => PATCH_REBASE_READ_TOOL_NAMES.has(name))
      : recentActionableDiagnostic || nextAction === "verify_existing_artifact" ? [] : policy.exploratoryToolNames,
    instruction: instructionForStepState({
      workProduct,
      nextAction,
      recentActionableDiagnostic,
      recentPatchPreconditionFailure,
      evidenceProducingToolNames,
    }),
  };
}

export function artifactStepToolProgressPolicy(
  requiredEvidenceKinds: readonly string[],
  options: { readonly expectedArtifactKind?: string } = {},
): RuntimeToolProgressPolicy {
  return {
    schema: "agentloop.runtimeToolProgressPolicy/v1",
    requiredEvidenceKinds,
    ...(options.expectedArtifactKind === undefined ? {} : { expectedArtifactKind: options.expectedArtifactKind }),
    autoCompleteFromEvidence: requiredEvidenceKinds.some((kind) => AUTO_COMPLETABLE_EVIDENCE_KINDS.has(kind)),
    maxExploratoryPrimarySteps: 3,
    maxExploratoryGraceSteps: 2,
    exploratoryToolNames: [
      "computer_find_files",
      "computer_list_directory",
      "computer_read_file",
      "computer_read_files",
      "computer_read_json",
      "computer_search_text",
      "read_source",
      "visible_read_file",
      "visible_read_files",
      "visible_extract_tables",
      "visible_list_directory",
      "webfetch",
      "websearch",
    ],
    setupToolNames: ["load_skill"],
    evidenceProducingToolNames: [
      "computer_patch_file",
      "computer_write_file",
      "computer_run_command",
      "convert_artifact",
      "materialize_paginated_html",
      "visible_extract_tables",
      "verify_artifact_acceptance",
    ],
    repairDirective: [
      "<runtime_tool_progress_repair>",
      "Read-only exploration has exceeded the bounded exploration budget for this artifact-producing step.",
      `Required evidence kinds: ${requiredEvidenceKinds.length === 0 ? "unspecified" : requiredEvidenceKinds.join(", ")}.`,
      "Use an evidence-producing tool next: write or update the artifact source, run the Skill validator/build/render command, or verify artifact acceptance.",
      "Do not keep listing, searching, or reading references unless a validator, build, render, or acceptance diagnostic names a concrete missing field or contract.",
      "If the artifact cannot be produced with the current evidence, return a truthful incomplete completion candidate instead of spending more read-only tool turns.",
      "</runtime_tool_progress_repair>",
    ].join("\n"),
    diagnosticRepairDirective: [
      "<runtime_validation_diagnostic_repair>",
      "A recent validator, build, render, parser, or acceptance tool result already named a concrete artifact diagnostic.",
      `Required evidence kinds: ${requiredEvidenceKinds.length === 0 ? "unspecified" : requiredEvidenceKinds.join(", ")}.`,
      "Use an evidence-producing tool next: patch the named source file, rerun the validator/build/render command, or call verify_artifact_acceptance for the produced artifact.",
      "Do not spend additional turns listing, searching, or rereading references when the diagnostic already includes a concrete path, line/column, rule, missing field, suggested fix, or artifact path.",
      "</runtime_validation_diagnostic_repair>",
    ].join("\n"),
  };
}

const AUTO_COMPLETABLE_EVIDENCE_KINDS = new Set([
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
  "delivery_receipt",
]);

const NON_DELIVERABLE_ARTIFACT_EVIDENCE_KINDS = new Set([
  "artifact_path",
  "artifact_non_empty",
  "artifact_integrity",
  "artifact_inspection",
  "artifact_openable",
  "format_matches_request",
]);

function collectEvidenceKinds(evidence: readonly AgentLoopToolEvidence[]): {
  readonly satisfied: Set<string>;
  readonly caveated: Set<string>;
  readonly failed: Set<string>;
} {
  const satisfied = new Set<string>();
  const caveated = new Set<string>();
  const failed = new Set<string>();
  for (const item of evidence) {
    const parsed = parseToolEvidenceRecord(item);
    if (parsed === undefined) continue;
    collectEvidenceKindsFromRecord(parsed, { satisfied, caveated, failed });
    collectEvidenceKindsFromRecord(asRecord(parsed.artifactReceipt), { satisfied, caveated, failed });
    collectEvidenceKindsFromRecord(asRecord(parsed.evidenceReceipt), { satisfied, caveated, failed });
  }
  return { satisfied, caveated, failed };
}

function collectPolicyEvidenceKinds(
  evidence: readonly AgentLoopToolEvidence[],
  policy: RuntimeToolProgressPolicy,
): {
  readonly satisfied: Set<string>;
  readonly caveated: Set<string>;
  readonly failed: Set<string>;
} {
  const evidenceKinds = collectEvidenceKinds(evidence);
  const workProduct = classifyWorkProduct(evidence, policy, evidenceKinds);
  if (workProduct.status === "process_artifact_available") {
    for (const kind of NON_DELIVERABLE_ARTIFACT_EVIDENCE_KINDS) {
      evidenceKinds.satisfied.delete(kind);
      evidenceKinds.caveated.delete(kind);
    }
    return evidenceKinds;
  }
  if (workProduct.deliverableArtifacts.length > 0) {
    evidenceKinds.satisfied.add("artifact_path");
    if (workProduct.deliverableArtifacts.some((artifact) => (artifact.bytes ?? 0) > 0)) {
      evidenceKinds.satisfied.add("artifact_non_empty");
    }
  }
  return evidenceKinds;
}

function evidenceKindSatisfiedByCompletionGate(
  kind: string,
  evidenceKinds: {
    readonly satisfied: ReadonlySet<string>;
    readonly caveated: ReadonlySet<string>;
    readonly failed: ReadonlySet<string>;
  },
): boolean {
  if (evidenceKinds.failed.has(kind)) return false;
  if (kind === "explicit_caveats") return evidenceKinds.satisfied.has(kind) || evidenceKinds.caveated.has(kind);
  return evidenceKinds.satisfied.has(kind);
}

function collectEvidenceKindsFromRecord(
  record: Record<string, unknown> | undefined,
  output: { readonly satisfied: Set<string>; readonly caveated: Set<string>; readonly failed: Set<string> },
): void {
  const evidenceKinds = asRecord(record?.evidenceKinds);
  collectStringArray(evidenceKinds?.satisfied, output.satisfied);
  collectStringArray(evidenceKinds?.caveated, output.caveated);
  collectStringArray(evidenceKinds?.failed, output.failed);
}

function collectStringArray(value: unknown, output: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) output.add(item);
  }
}

function collectKnownArtifacts(evidence: readonly AgentLoopToolEvidence[]): RuntimeStepArtifactRef[] {
  const byPath = new Map<string, RuntimeStepArtifactRef>();
  for (const item of evidence) {
    if (item.isError) continue;
    const parsed = parseToolEvidenceRecord(item);
    if (parsed === undefined) continue;
    const artifact = artifactRecordFromResult(parsed);
    const path = stringField(parsed, "path")
      ?? stringField(artifact, "path")
      ?? stringField(asRecord(parsed.output), "path");
    if (path === undefined) continue;
    byPath.set(path, {
      path,
      sourceTool: item.toolName,
      toolCallId: item.toolCallId,
      bytes: numberField(parsed, "bytes") ?? numberField(artifact, "bytes"),
      sha256: stringField(parsed, "sha256") ?? stringField(artifact, "sha256"),
      artifactKind: stringField(parsed, "artifactKind")
        ?? stringField(parsed, "kind")
        ?? stringField(artifact, "artifactKind")
        ?? stringField(artifact, "kind"),
      acceptanceProfile: stringField(parsed, "acceptanceProfile")
        ?? stringField(artifact, "acceptanceProfile"),
    });
  }
  return [...byPath.values()];
}

function classifyWorkProduct(
  evidence: readonly AgentLoopToolEvidence[],
  policy: RuntimeToolProgressPolicy,
  evidenceKinds: {
    readonly satisfied: ReadonlySet<string>;
    readonly failed: ReadonlySet<string>;
  },
): RuntimeStepWorkProductState {
  const artifacts = collectKnownArtifacts(evidence)
    .filter((artifact) => WORK_PRODUCT_TOOL_NAMES.has(artifact.sourceTool));
  const acceptanceRequired = policy.requiredEvidenceKinds.includes("artifact_acceptance");
  const deliverableArtifacts = acceptanceRequired
    ? artifacts.filter((artifact) => isAcceptanceDeliverableArtifact(artifact, policy))
    : artifacts;
  const processArtifacts = acceptanceRequired
    ? artifacts.filter((artifact) => !isAcceptanceDeliverableArtifact(artifact, policy))
    : [];
  const acceptanceSatisfied = acceptanceRequired
    && evidenceKinds.satisfied.has("artifact_acceptance")
    && !evidenceKinds.failed.has("artifact_acceptance");
  const status: RuntimeStepWorkProductStatus = deliverableArtifacts.length > 0 && acceptanceSatisfied
    ? "accepted"
    : deliverableArtifacts.length > 0
    ? "deliverable_available"
    : processArtifacts.length > 0
    ? "process_artifact_available"
    : "none";
  return {
    schema: "agentloop.runtimeStepWorkProductState/v1",
    status,
    acceptanceRequired,
    ...(policy.expectedArtifactKind === undefined ? {} : { expectedArtifactKind: policy.expectedArtifactKind }),
    deliverableArtifacts,
    processArtifacts,
  };
}

function isAcceptanceDeliverableArtifact(
  artifact: RuntimeStepArtifactRef,
  policy: RuntimeToolProgressPolicy,
): boolean {
  if (artifact.acceptanceProfile !== undefined) return true;
  if (artifact.sourceTool === "convert_artifact" || artifact.sourceTool === "materialize_paginated_html") return true;
  if (policy.expectedArtifactKind !== undefined) {
    if (artifact.artifactKind !== undefined) return artifactKindMatchesExpected(artifact.artifactKind, policy.expectedArtifactKind);
    return artifactPathMatchesExpectedKind(artifact.path, policy.expectedArtifactKind);
  }
  if (artifact.artifactKind !== undefined && artifact.artifactKind !== "code" && artifact.artifactKind !== "source") return true;
  return !isGeneratedSourcePath(artifact.path);
}

function formatEvidenceCompletionDelivery(input: {
  readonly caveatedEvidenceKinds: readonly string[];
  readonly artifacts: readonly RuntimeStepArtifactRef[];
  readonly language: "zh" | "en";
}): string {
  if (input.language === "zh") {
    const lines = ["已完成并通过当前步骤的验收检查。"];
    if (input.artifacts.length > 0) {
      lines.push(`产物：${input.artifacts.map(formatArtifactDeliveryRef).join("；")}。`);
    }
    if (input.caveatedEvidenceKinds.length > 0) {
      lines.push("注意：部分验收项带有保留说明，详情见运行记录。");
    }
    return lines.join("\n");
  }

  const lines = ["Done and verified for the current step."];
  if (input.artifacts.length > 0) {
    lines.push(`Artifact: ${input.artifacts.map(formatArtifactDeliveryRef).join("; ")}.`);
  }
  if (input.caveatedEvidenceKinds.length > 0) {
    lines.push("Note: Some acceptance checks include caveats; see the run record for details.");
  }
  return lines.join("\n");
}

function formatArtifactDeliveryRef(artifact: RuntimeStepArtifactRef): string {
  return [
    artifact.path,
    artifact.artifactKind === undefined ? undefined : artifact.artifactKind,
    artifact.bytes === undefined ? undefined : `${artifact.bytes} bytes`,
  ].filter((item): item is string => item !== undefined).join(" ");
}

function preferredDeliveryLanguage(text: string | undefined): "zh" | "en" {
  return text !== undefined && /[\u3400-\u9fff]/u.test(text) ? "zh" : "en";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function artifactRecordFromResult(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const artifactReceipt = asRecord(record.artifactReceipt);
  return asRecord(record.artifact) ?? asRecord(artifactReceipt?.artifact);
}

function nextActionForEvidenceGap(input: {
  readonly missingRequiredEvidenceKinds: readonly string[];
  readonly failedEvidenceKinds: readonly string[];
  readonly workProduct: RuntimeStepWorkProductState;
  readonly policy: RuntimeToolProgressPolicy;
}): RuntimeStepNextAction {
  const missing = new Set(input.missingRequiredEvidenceKinds);
  if (input.failedEvidenceKinds.length > 0 && hasAnyTool(input.policy, ["computer_patch_file", "computer_write_file"])) {
    return "repair_artifact_source";
  }
  if (
    missing.has("source_summary")
    || missing.has("source_urls")
    || missing.has("schema_summary")
    || missing.has("record_counts")
    || missing.has("structured_extraction_artifact")
  ) return "acquire_source_evidence";
  if (
    input.workProduct.status === "deliverable_available"
    && (missing.has("artifact_acceptance") || missing.has("artifact_openable") || missing.has("format_matches_request"))
    && hasAnyTool(input.policy, ["verify_artifact_acceptance"])
  ) {
    return "verify_existing_artifact";
  }
  if (
    input.workProduct.status === "deliverable_available"
    && [...missing].every((kind) =>
      kind === "artifact_acceptance"
      || kind === "artifact_openable"
      || kind === "format_matches_request"
      || kind === "delivery_receipt"
    )
  ) {
    return "submit_completion_candidate";
  }
  if ((missing.has("artifact_path") || missing.has("artifact_non_empty")) && hasArtifactProducer(input.policy)) {
    return "produce_artifact";
  }
  if (input.missingRequiredEvidenceKinds.length === 0 || (
    input.missingRequiredEvidenceKinds.length === 1 && missing.has("delivery_receipt")
  )) {
    return "submit_completion_candidate";
  }
  return "produce_required_evidence";
}

function evidenceProducingToolsForAction(
  action: RuntimeStepNextAction,
  policy: RuntimeToolProgressPolicy,
): string[] {
  const tools = policy.evidenceProducingToolNames;
  switch (action) {
    case "acquire_source_evidence":
      return [];
    case "produce_artifact":
      return tools.filter((name) =>
        name === "computer_patch_file"
        || name === "computer_write_file"
        || name === "computer_run_command"
        || name === "convert_artifact"
        || name === "materialize_paginated_html"
      );
    case "verify_existing_artifact":
      return tools.filter((name) => name === "verify_artifact_acceptance");
    case "repair_artifact_source":
      return tools.filter((name) =>
        name === "computer_patch_file"
        || name === "computer_write_file"
        || name === "computer_run_command"
        || name === "verify_artifact_acceptance"
      );
    case "submit_completion_candidate":
      return [];
    case "produce_required_evidence":
      return [...tools];
  }
}

function hasArtifactProducer(policy: RuntimeToolProgressPolicy): boolean {
  return hasAnyTool(policy, [
    "computer_patch_file",
    "computer_write_file",
    "computer_run_command",
    "convert_artifact",
    "materialize_paginated_html",
  ]);
}

function hasAnyTool(policy: RuntimeToolProgressPolicy, names: readonly string[]): boolean {
  return names.some((name) => policy.evidenceProducingToolNames.includes(name));
}

function instructionForStepState(input: {
  readonly workProduct: RuntimeStepWorkProductState;
  readonly nextAction: RuntimeStepNextAction;
  readonly recentActionableDiagnostic: boolean;
  readonly recentPatchPreconditionFailure: boolean;
  readonly evidenceProducingToolNames: readonly string[];
}): string {
  const lines = [
    "Use this current-step semantic state before choosing a tool.",
    `Work product status is ${input.workProduct.status}.`,
  ];
  if (input.workProduct.expectedArtifactKind !== undefined) {
    lines.push(`The requested final artifact kind is ${input.workProduct.expectedArtifactKind}.`);
  }
  if (input.recentPatchPreconditionFailure) {
    lines.push("The last patch failed because its patch precondition did not match the current file.");
    lines.push("Read that exact patch target once to rebase the edit, then patch, write, run, or verify; do not broaden into directory listing or reference search.");
    return lines.join(" ");
  }
  if (input.recentActionableDiagnostic) {
    lines.push("A recent validator, build, render, parser, or acceptance result already named a concrete artifact diagnostic.");
    lines.push("Read-only exploration is no longer useful; patch, run, or verify next.");
    return lines.join(" ");
  }
  switch (input.nextAction) {
    case "verify_existing_artifact":
      lines.push("A deliverable artifact exists, but required artifact acceptance is still missing.");
      lines.push("Verify the artifact next; do not reread the same artifact merely to decide whether to verify it.");
      break;
    case "produce_artifact":
      if (input.workProduct.status === "process_artifact_available") {
        lines.push("Process artifacts already exist, but they are not the final deliverable.");
        lines.push("Run/build/render/convert them into the requested artifact kind, or write the final requested artifact directly.");
      } else {
        lines.push("Produce the requested artifact with an evidence-producing tool.");
      }
      break;
    case "acquire_source_evidence":
      lines.push("Acquire only the missing source evidence required by the current evidence contract.");
      break;
    case "submit_completion_candidate":
      lines.push("Required evidence is satisfied; submit a truthful completion candidate for Assessment.");
      break;
    case "repair_artifact_source":
      lines.push("Repair the artifact source or rerun the named command based on the failed evidence.");
      break;
    case "produce_required_evidence":
      lines.push("Produce the missing required evidence with one of the listed evidence-producing tools.");
      break;
  }
  if (input.evidenceProducingToolNames.length > 0) {
    lines.push(`Allowed next evidence-producing tools: ${input.evidenceProducingToolNames.join(", ")}.`);
  }
  return lines.join(" ");
}

export function evaluateRuntimeToolProgress(input: {
  readonly policy?: RuntimeToolProgressPolicy;
  readonly state: RuntimeToolProgressState;
  readonly inGrace: boolean;
  readonly calls: readonly ModelToolCall[];
  readonly priorEvidence?: readonly AgentLoopToolEvidence[];
}): RuntimeToolProgressDecision {
  const policy = input.policy;
  if (policy === undefined || input.calls.length === 0) {
    return { allow: true, state: input.state };
  }
  const priorEvidence = input.priorEvidence ?? [];
  const priorEvidenceKinds = collectEvidenceKinds(priorEvidence);
  const workProduct = classifyWorkProduct(priorEvidence, policy, priorEvidenceKinds);
  const recentActionableDiagnostic = hasRecentActionableDiagnostic(priorEvidence);
  const recentPatchPreconditionFailure = hasRecentPatchPreconditionFailure(priorEvidence);
  const recentPatchRebaseReadAfterPreconditionFailure = hasRecentPatchRebaseReadAfterPreconditionFailure(priorEvidence);
  const allExploratory = input.calls.every((call) => policy.exploratoryToolNames.includes(call.name));
  const hasEvidenceProducer = input.calls.some((call) => policy.evidenceProducingToolNames.includes(call.name));
  const hasSetupOnly = input.calls.every((call) => policy.setupToolNames.includes(call.name));
  if (
    !hasSetupOnly
    && shouldRejectRepeatedNonDeliverableSourceMutation({
      calls: input.calls,
      policy,
      workProduct,
      recentActionableDiagnostic,
      recentPatchPreconditionFailure,
      recentPatchRebaseReadAfterPreconditionFailure,
    })
  ) {
    const nonDeliverableSourceMutationRejections = input.state.nonDeliverableSourceMutationRejections + 1;
    return {
      allow: false,
      stalled: nonDeliverableSourceMutationRejections > 1,
      reason: "Intermediate artifact/source evidence exists but final artifact evidence is still missing",
      directive: intermediateArtifactProductionRepairDirective(policy),
      state: {
        ...input.state,
        nonDeliverableSourceMutationRejections,
      },
    };
  }
  if (!allExploratory || hasEvidenceProducer || hasSetupOnly) {
    return {
      allow: true,
      state: {
        exploratoryOnlyGraceSteps: 0,
        exploratoryOnlyRejections: input.state.exploratoryOnlyRejections,
        exploratoryOnlyPrimarySteps: 0,
        exploratoryOnlyPrimaryRejections: input.state.exploratoryOnlyPrimaryRejections,
        diagnosticExploratoryRejections: input.state.diagnosticExploratoryRejections,
        nonDeliverableSourceMutationRejections: 0,
      },
    };
  }

  if (
    recentPatchPreconditionFailure
    && callsAreTargetedPatchRebaseReads(input.calls, priorEvidence)
  ) {
    return { allow: true, state: input.state };
  }

  if (workProduct.status === "process_artifact_available") {
    const exploratoryOnlyRejections = input.state.exploratoryOnlyRejections + 1;
    return {
      allow: false,
      stalled: exploratoryOnlyRejections > 1,
      reason: "Intermediate artifact/source evidence exists but final artifact evidence is still missing",
      directive: intermediateArtifactProductionRepairDirective(policy),
      state: {
        ...input.state,
        exploratoryOnlyRejections,
      },
    };
  }

  if (workProduct.status === "deliverable_available") {
    const exploratoryOnlyRejections = input.state.exploratoryOnlyRejections + 1;
    return {
      allow: false,
      stalled: exploratoryOnlyRejections > 1,
      reason: "Artifact path evidence exists but artifact acceptance is still missing",
      directive: artifactAcceptanceRepairDirective(policy),
      state: {
        ...input.state,
        exploratoryOnlyRejections,
      },
    };
  }

  if (recentActionableDiagnostic) {
    const diagnosticExploratoryRejections = input.state.diagnosticExploratoryRejections + 1;
    return {
      allow: false,
      stalled: diagnosticExploratoryRejections > 1,
      reason: "Read-only exploratory tool calls are not allowed after an actionable artifact diagnostic",
      directive: policy.diagnosticRepairDirective,
      state: {
        ...input.state,
        diagnosticExploratoryRejections,
      },
    };
  }

  if (!input.inGrace) {
    const exploratoryOnlyPrimarySteps = input.state.exploratoryOnlyPrimarySteps + 1;
    if (exploratoryOnlyPrimarySteps <= policy.maxExploratoryPrimarySteps) {
      return {
        allow: true,
        state: { ...input.state, exploratoryOnlyPrimarySteps },
      };
    }
    const exploratoryOnlyPrimaryRejections = input.state.exploratoryOnlyPrimaryRejections + 1;
    return {
      allow: false,
      stalled: exploratoryOnlyPrimaryRejections > 1,
      reason: "Read-only exploratory tool calls exceeded the artifact step primary budget",
      directive: policy.repairDirective,
      state: {
        ...input.state,
        exploratoryOnlyPrimarySteps,
        exploratoryOnlyPrimaryRejections,
      },
    };
  }

  const exploratoryOnlyGraceSteps = input.state.exploratoryOnlyGraceSteps + 1;
  if (exploratoryOnlyGraceSteps <= policy.maxExploratoryGraceSteps) {
    return {
      allow: true,
      state: { ...input.state, exploratoryOnlyGraceSteps },
    };
  }

  const exploratoryOnlyRejections = input.state.exploratoryOnlyRejections + 1;
  const stalled = exploratoryOnlyRejections > 1;
  return {
    allow: false,
    stalled,
    reason: stalled
      ? "Read-only exploratory tool calls repeated after the Runtime requested an evidence-producing action"
      : "Read-only exploratory tool calls exceeded the artifact step grace budget",
    directive: policy.repairDirective,
    state: {
      ...input.state,
      exploratoryOnlyGraceSteps,
      exploratoryOnlyRejections,
    },
  };
}

function intermediateArtifactProductionRepairDirective(policy: RuntimeToolProgressPolicy): string {
  return [
    "<runtime_artifact_source_production_repair>",
    "The current artifact-producing step has intermediate artifact/source files, but no final deliverable artifact evidence yet.",
    "Use an evidence-producing tool next: run the build/render script or command, write the requested final artifact, convert the source into the requested artifact format, or materialize the final artifact.",
    "Do not verify a target path until a tool result or receipt proves that final artifact exists.",
    `Required evidence kinds: ${policy.requiredEvidenceKinds.length === 0 ? "unspecified" : policy.requiredEvidenceKinds.join(", ")}.`,
    "</runtime_artifact_source_production_repair>",
  ].join("\n");
}

function artifactAcceptanceRepairDirective(policy: RuntimeToolProgressPolicy): string {
  return [
    "<runtime_artifact_acceptance_repair>",
    "The current artifact-producing step already has artifact_path evidence, but artifact_acceptance is still missing.",
    "Call verify_artifact_acceptance for the produced artifact, or use an evidence-producing tool to patch a known incomplete artifact source before verifying.",
    "Do not spend another turn listing, searching, or rereading the artifact merely to decide whether to verify it.",
    `Required evidence kinds: ${policy.requiredEvidenceKinds.length === 0 ? "unspecified" : policy.requiredEvidenceKinds.join(", ")}.`,
    "</runtime_artifact_acceptance_repair>",
  ].join("\n");
}

function shouldRejectRepeatedNonDeliverableSourceMutation(input: {
  readonly calls: readonly ModelToolCall[];
  readonly policy: RuntimeToolProgressPolicy;
  readonly workProduct: RuntimeStepWorkProductState;
  readonly recentActionableDiagnostic: boolean;
  readonly recentPatchPreconditionFailure: boolean;
  readonly recentPatchRebaseReadAfterPreconditionFailure: boolean;
}): boolean {
  if (input.workProduct.status !== "process_artifact_available") return false;
  if (input.recentActionableDiagnostic) return false;
  if (input.recentPatchPreconditionFailure) return false;
  if (input.recentPatchRebaseReadAfterPreconditionFailure) return false;
  if (input.calls.some((call) => callMaterializesOrVerifiesArtifact(call.name))) return false;

  const mutationCalls = input.calls.filter((call) => REPLACE_SOURCE_TOOL_NAMES.has(call.name));
  if (mutationCalls.length === 0) return false;
  if (input.calls.some((call) => !REPLACE_SOURCE_TOOL_NAMES.has(call.name) && !input.policy.exploratoryToolNames.includes(call.name))) {
    return false;
  }

  const targetPaths = mutationCalls.flatMap((call) => sourceMutationTargetPaths(call));
  if (targetPaths.length === 0) return false;
  if (targetPaths.some((path) => pathCanBeAcceptanceDeliverable(path, input.policy))) return false;

  const knownNonDeliverablePaths = new Set(
    input.workProduct.processArtifacts.map((artifact) => normalizeArtifactPath(artifact.path)),
  );
  if (knownNonDeliverablePaths.size === 0) return false;
  return targetPaths.every((path) => knownNonDeliverablePaths.has(normalizeArtifactPath(path)));
}

const REPLACE_SOURCE_TOOL_NAMES = new Set(["computer_write_file"]);
const WORK_PRODUCT_TOOL_NAMES = new Set([
  "computer_write_file",
  "computer_patch_file",
  "computer_run_command",
  "convert_artifact",
  "materialize_paginated_html",
  "verify_artifact_acceptance",
]);

function callMaterializesOrVerifiesArtifact(toolName: string): boolean {
  return WORK_PRODUCT_TOOL_NAMES.has(toolName) && toolName !== "computer_write_file" && toolName !== "computer_patch_file";
}

function sourceMutationTargetPaths(call: ModelToolCall): string[] {
  const args = asRecord(call.arguments);
  if (args === undefined) return [];
  const paths = [
    stringField(args, "path"),
    stringField(args, "filePath"),
    stringField(args, "targetPath"),
    stringField(args, "artifactPath"),
  ].filter((path): path is string => path !== undefined);
  return uniqueStrings(paths);
}

function pathCanBeAcceptanceDeliverable(path: string, policy: RuntimeToolProgressPolicy): boolean {
  if (policy.expectedArtifactKind !== undefined) {
    return artifactPathMatchesExpectedKind(path, policy.expectedArtifactKind);
  }
  return !isGeneratedSourcePath(path);
}

function normalizeArtifactPath(path: string): string {
  return path.trim();
}

function artifactRefFromEvidence(evidence: AgentLoopToolEvidence): RuntimeStepArtifactRef | undefined {
  const parsed = parseToolEvidenceRecord(evidence);
  if (parsed === undefined) return undefined;
  const artifact = artifactRecordFromResult(parsed);
  const path = stringField(parsed, "path")
    ?? stringField(artifact, "path")
    ?? stringField(asRecord(parsed.output), "path");
  if (path === undefined) return undefined;
  return {
    path,
    sourceTool: evidence.toolName,
    toolCallId: evidence.toolCallId,
    bytes: numberField(parsed, "bytes") ?? numberField(artifact, "bytes"),
    sha256: stringField(parsed, "sha256") ?? stringField(artifact, "sha256"),
    artifactKind: stringField(parsed, "artifactKind")
      ?? stringField(parsed, "kind")
      ?? stringField(artifact, "artifactKind")
      ?? stringField(artifact, "kind"),
    acceptanceProfile: stringField(parsed, "acceptanceProfile")
      ?? stringField(artifact, "acceptanceProfile"),
  };
}

const GENERATED_SOURCE_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
  ".zsh",
]);

function isGeneratedSourcePath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (basename === "makefile" || basename === "dockerfile") return true;
  const dot = basename.lastIndexOf(".");
  return dot > 0 && GENERATED_SOURCE_EXTENSIONS.has(basename.slice(dot));
}

function artifactKindMatchesExpected(actual: string, expected: string): boolean {
  const normalizedActual = normalizeArtifactKind(actual);
  const normalizedExpected = normalizeArtifactKind(expected);
  if (normalizedActual === normalizedExpected) return true;
  if (normalizedExpected === "document") return normalizedActual === "pdf" || normalizedActual === "markdown" || normalizedActual === "generic_file";
  if (normalizedExpected === "spreadsheet") return normalizedActual === "xlsx" || normalizedActual === "csv";
  if (normalizedExpected === "image") return normalizedActual === "svg";
  return false;
}

function artifactPathMatchesExpectedKind(path: string, expected: string): boolean {
  const normalizedExpected = normalizeArtifactKind(expected);
  const extension = pathExtension(path);
  if (extension === undefined) return false;
  switch (normalizedExpected) {
    case "html":
      return extension === ".html" || extension === ".htm";
    case "document":
      return extension === ".pdf" || extension === ".docx" || extension === ".md" || extension === ".markdown" || extension === ".txt";
    case "presentation":
      return extension === ".pptx";
    case "spreadsheet":
      return extension === ".xlsx" || extension === ".csv";
    case "image":
      return extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp" || extension === ".gif" || extension === ".svg";
    case "code":
      return extension === ".json" || extension === ".jsx" || extension === ".tsx" || isGeneratedSourcePath(path);
    default:
      return false;
  }
}

function normalizeArtifactKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "htm") return "html";
  if (normalized === "md") return "markdown";
  if (normalized === "jpg" || normalized === "jpeg" || normalized === "png" || normalized === "webp" || normalized === "gif") return "image";
  if (normalized === "docx" || normalized === "pdf" || normalized === "txt") return normalized;
  if (normalized === "xlsx") return "spreadsheet";
  return normalized;
}

function pathExtension(path: string): string | undefined {
  const normalized = path.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot) : undefined;
}

function parseToolEvidenceRecord(evidence: AgentLoopToolEvidence): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(evidence.result));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function hasRecentActionableDiagnostic(evidence: readonly AgentLoopToolEvidence[]): boolean {
  for (const item of [...evidence].reverse()) {
    if (item.toolName === "computer_write_file" || item.toolName === "computer_patch_file") return false;
    if (item.toolName !== "computer_run_command" && item.toolName !== "verify_artifact_acceptance") continue;
    return isActionableDiagnostic(item);
  }
  return false;
}

const PATCH_REBASE_READ_TOOL_NAMES = new Set(["computer_read_file", "computer_read_files", "computer_read_json"]);

function hasRecentPatchPreconditionFailure(evidence: readonly AgentLoopToolEvidence[]): boolean {
  for (const item of [...evidence].reverse()) {
    if (PATCH_REBASE_READ_TOOL_NAMES.has(item.toolName)) return false;
    if (item.toolName === "computer_write_file" || item.toolName === "computer_run_command" || item.toolName === "verify_artifact_acceptance") return false;
    if (item.toolName !== "computer_patch_file") continue;
    return item.isError && isPatchPreconditionDiagnostic(item.result);
  }
  return false;
}

function hasRecentPatchRebaseReadAfterPreconditionFailure(evidence: readonly AgentLoopToolEvidence[]): boolean {
  let sawRecentRebaseRead = false;
  for (const item of [...evidence].reverse()) {
    if (!sawRecentRebaseRead) {
      if (!item.isError && PATCH_REBASE_READ_TOOL_NAMES.has(item.toolName)) {
        sawRecentRebaseRead = true;
        continue;
      }
      return false;
    }
    if (item.toolName === "computer_patch_file" && item.isError && isPatchPreconditionDiagnostic(item.result)) {
      return true;
    }
    if (
      item.toolName === "computer_write_file"
      || item.toolName === "computer_run_command"
      || item.toolName === "verify_artifact_acceptance"
    ) {
      return false;
    }
  }
  return false;
}

function callsAreTargetedPatchRebaseReads(
  calls: readonly ModelToolCall[],
  evidence: readonly AgentLoopToolEvidence[],
): boolean {
  if (calls.length === 0 || calls.some((call) => !PATCH_REBASE_READ_TOOL_NAMES.has(call.name))) return false;
  const knownPaths = new Set(collectKnownArtifacts(evidence).map((artifact) => artifact.path));
  if (knownPaths.size === 0) return false;
  return calls.every((call) => {
    const paths = readTargetPaths(call);
    return paths.length > 0 && paths.every((path) => knownPaths.has(path));
  });
}

function readTargetPaths(call: ModelToolCall): string[] {
  const args = asRecord(call.arguments);
  if (args === undefined) return [];
  const path = stringField(args, "path");
  if (path !== undefined) return [path];
  const paths = args.paths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isPatchPreconditionDiagnostic(result: string): boolean {
  return /oldText was not found|oldText matched more than once|expectedSha256 does not match current file/iu.test(result);
}

function isActionableDiagnostic(evidence: AgentLoopToolEvidence): boolean {
  const text = toolEvidenceText(evidence);
  if (text.length === 0) return false;
  const hasDiagnostic =
    evidence.isError
    || /(?:validation failed|validator|preflight|parse|parser|syntax|error_count["']?\s*:\s*[1-9]|\berror\(s\)|failed evidence|artifact_acceptance)/iu.test(text);
  if (!hasDiagnostic) return false;
  return /(?:line\s+\d+|column\s+\d+|position\s+\d+|slide[_\s-]*(?:index)?\s*\d+|rule["']?\s*:|suggested[_\s-]*fix|requires|missing|artifact[_\s-]*path|wrote\s+\S+\.[A-Za-z0-9]+|\.(?:pdf|png|jpe?g|webp|gif|svg|html?|md|txt|csv|json|docx|pptx|xlsx)\b)/iu
    .test(text);
}

function toolEvidenceText(evidence: AgentLoopToolEvidence): string {
  try {
    const parsed = JSON.parse(evidence.result) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return [
        typeof record.stdout === "string" ? record.stdout : "",
        typeof record.stderr === "string" ? record.stderr : "",
        JSON.stringify(record).slice(0, 8_000),
      ].join("\n");
    }
  } catch {
    // Fall through to raw text.
  }
  return evidence.result;
}

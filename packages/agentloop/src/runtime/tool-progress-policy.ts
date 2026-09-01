import type { AgentLoopToolEvidence, ModelToolCall } from "./contracts.ts";

export interface RuntimeToolProgressPolicy {
  readonly schema: "agentloop.runtimeToolProgressPolicy/v1";
  readonly requiredEvidenceKinds: readonly string[];
  readonly maxExploratoryPrimarySteps: number;
  readonly maxExploratoryGraceSteps: number;
  readonly maxDiagnosticExploratorySteps: number;
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
  readonly diagnosticExploratorySteps: number;
  readonly diagnosticExploratoryRejections: number;
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

export interface RuntimeStepArtifactRef {
  readonly path: string;
  readonly sourceTool: string;
  readonly toolCallId: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly artifactKind?: string;
}

export interface RuntimeStepEvidenceState {
  readonly schema: "agentloop.runtimeStepEvidenceState/v1";
  readonly requiredEvidenceKinds: readonly string[];
  readonly satisfiedEvidenceKinds: readonly string[];
  readonly caveatedEvidenceKinds: readonly string[];
  readonly failedEvidenceKinds: readonly string[];
  readonly missingRequiredEvidenceKinds: readonly string[];
  readonly knownArtifacts: readonly RuntimeStepArtifactRef[];
  readonly nextAction: RuntimeStepNextAction;
  readonly evidenceProducingToolNames: readonly string[];
  readonly exploratoryToolNames: readonly string[];
  readonly instruction: string;
}

export function initialRuntimeToolProgressState(): RuntimeToolProgressState {
  return {
    exploratoryOnlyPrimarySteps: 0,
    exploratoryOnlyPrimaryRejections: 0,
    exploratoryOnlyGraceSteps: 0,
    exploratoryOnlyRejections: 0,
    diagnosticExploratorySteps: 0,
    diagnosticExploratoryRejections: 0,
  };
}

export function deriveRuntimeStepEvidenceState(input: {
  readonly policy?: RuntimeToolProgressPolicy;
  readonly evidence: readonly AgentLoopToolEvidence[];
}): RuntimeStepEvidenceState | undefined {
  const policy = input.policy;
  if (policy === undefined) return undefined;
  const evidenceKinds = collectEvidenceKinds(input.evidence);
  const missingRequiredEvidenceKinds = policy.requiredEvidenceKinds
    .filter((kind) => !evidenceKinds.satisfied.has(kind));
  const knownArtifacts = collectKnownArtifacts(input.evidence);
  const nextAction = nextActionForEvidenceGap({
    missingRequiredEvidenceKinds,
    failedEvidenceKinds: [...evidenceKinds.failed],
    knownArtifacts,
    policy,
  });
  return {
    schema: "agentloop.runtimeStepEvidenceState/v1",
    requiredEvidenceKinds: policy.requiredEvidenceKinds,
    satisfiedEvidenceKinds: [...evidenceKinds.satisfied].sort(),
    caveatedEvidenceKinds: [...evidenceKinds.caveated].sort(),
    failedEvidenceKinds: [...evidenceKinds.failed].sort(),
    missingRequiredEvidenceKinds,
    knownArtifacts,
    nextAction,
    evidenceProducingToolNames: evidenceProducingToolsForAction(nextAction, policy),
    exploratoryToolNames: policy.exploratoryToolNames,
    instruction: "Use this current-step semantic state before choosing a tool. Prefer a listed evidence-producing tool when required evidence is missing; use exploratory tools only for a specifically missing fact that is not already represented by receipts or known artifacts.",
  };
}

export function artifactStepToolProgressPolicy(requiredEvidenceKinds: readonly string[]): RuntimeToolProgressPolicy {
  return {
    schema: "agentloop.runtimeToolProgressPolicy/v1",
    requiredEvidenceKinds,
    maxExploratoryPrimarySteps: 3,
    maxExploratoryGraceSteps: 2,
    maxDiagnosticExploratorySteps: 1,
    exploratoryToolNames: [
      "computer_find_files",
      "computer_list_directory",
      "computer_read_file",
      "computer_read_files",
      "computer_search_text",
      "read_source",
      "visible_read_file",
      "visible_read_files",
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
    });
  }
  return [...byPath.values()];
}

function artifactRecordFromResult(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const artifactReceipt = asRecord(record.artifactReceipt);
  return asRecord(record.artifact) ?? asRecord(artifactReceipt?.artifact);
}

function nextActionForEvidenceGap(input: {
  readonly missingRequiredEvidenceKinds: readonly string[];
  readonly failedEvidenceKinds: readonly string[];
  readonly knownArtifacts: readonly RuntimeStepArtifactRef[];
  readonly policy: RuntimeToolProgressPolicy;
}): RuntimeStepNextAction {
  const missing = new Set(input.missingRequiredEvidenceKinds);
  if (input.failedEvidenceKinds.length > 0 && hasAnyTool(input.policy, ["computer_patch_file", "computer_write_file"])) {
    return "repair_artifact_source";
  }
  if (missing.has("source_summary") || missing.has("source_urls")) return "acquire_source_evidence";
  if ((missing.has("artifact_path") || missing.has("artifact_non_empty")) && hasArtifactProducer(input.policy)) {
    return "produce_artifact";
  }
  if (
    input.knownArtifacts.length > 0
    && (missing.has("artifact_acceptance") || missing.has("artifact_openable") || missing.has("format_matches_request"))
    && hasAnyTool(input.policy, ["verify_artifact_acceptance"])
  ) {
    return "verify_existing_artifact";
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
  const allExploratory = input.calls.every((call) => policy.exploratoryToolNames.includes(call.name));
  const hasEvidenceProducer = input.calls.some((call) => policy.evidenceProducingToolNames.includes(call.name));
  const hasSetupOnly = input.calls.every((call) => policy.setupToolNames.includes(call.name));
  if (!allExploratory || hasEvidenceProducer || hasSetupOnly) {
    return {
      allow: true,
      state: {
        exploratoryOnlyGraceSteps: 0,
        exploratoryOnlyRejections: input.state.exploratoryOnlyRejections,
        exploratoryOnlyPrimarySteps: 0,
        exploratoryOnlyPrimaryRejections: input.state.exploratoryOnlyPrimaryRejections,
        diagnosticExploratorySteps: 0,
        diagnosticExploratoryRejections: input.state.diagnosticExploratoryRejections,
      },
    };
  }

  if (hasArtifactPathWithoutAcceptance(input.priorEvidence ?? [], policy)) {
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

  if (hasRecentActionableDiagnostic(input.priorEvidence ?? [])) {
    const diagnosticExploratorySteps = input.state.diagnosticExploratorySteps + 1;
    if (diagnosticExploratorySteps <= policy.maxDiagnosticExploratorySteps) {
      return {
        allow: true,
        state: { ...input.state, diagnosticExploratorySteps },
      };
    }
    const diagnosticExploratoryRejections = input.state.diagnosticExploratoryRejections + 1;
    return {
      allow: false,
      stalled: diagnosticExploratoryRejections > 1,
      reason: "Read-only exploratory tool calls continued after an actionable artifact diagnostic",
      directive: policy.diagnosticRepairDirective,
      state: {
        ...input.state,
        diagnosticExploratorySteps,
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

function hasArtifactPathWithoutAcceptance(
  evidence: readonly AgentLoopToolEvidence[],
  policy: RuntimeToolProgressPolicy,
): boolean {
  if (!policy.requiredEvidenceKinds.includes("artifact_acceptance")) return false;
  let sawArtifactPath = false;
  for (const item of evidence) {
    if (item.isError) continue;
    if (item.toolName === "verify_artifact_acceptance" && hasSatisfiedEvidenceKind(item, "artifact_acceptance")) {
      sawArtifactPath = false;
      continue;
    }
    if (
      item.toolName === "computer_write_file"
      || item.toolName === "computer_patch_file"
      || item.toolName === "materialize_paginated_html"
      || item.toolName === "convert_artifact"
    ) {
      sawArtifactPath = hasSatisfiedEvidenceKind(item, "artifact_path") || hasArtifactPathResult(item);
    }
  }
  return sawArtifactPath;
}

function hasSatisfiedEvidenceKind(evidence: AgentLoopToolEvidence, kind: string): boolean {
  const parsed = parseToolEvidenceRecord(evidence);
  if (parsed === undefined) return false;
  return recordSatisfiesEvidenceKind(parsed, kind)
    || recordSatisfiesEvidenceKind(asRecord(parsed.artifactReceipt), kind)
    || recordSatisfiesEvidenceKind(asRecord(parsed.evidenceReceipt), kind);
}

function recordSatisfiesEvidenceKind(record: Record<string, unknown> | undefined, kind: string): boolean {
  const evidenceKinds = asRecord(record?.evidenceKinds);
  return Array.isArray(evidenceKinds?.satisfied)
    && evidenceKinds.satisfied.includes(kind);
}

function hasArtifactPathResult(evidence: AgentLoopToolEvidence): boolean {
  const parsed = parseToolEvidenceRecord(evidence);
  if (parsed === undefined) return false;
  if (typeof parsed.path === "string" && parsed.path.trim().length > 0) return true;
  const artifactReceipt = asRecord(parsed.artifactReceipt);
  const artifact = asRecord(artifactReceipt?.artifact);
  if (typeof artifact?.path === "string" && artifact.path.trim().length > 0) return true;
  const output = asRecord(parsed.output);
  return typeof output?.path === "string" && output.path.trim().length > 0;
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

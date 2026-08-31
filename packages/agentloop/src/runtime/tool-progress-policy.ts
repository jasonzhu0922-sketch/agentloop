import type { AgentLoopToolEvidence, ModelToolCall } from "./contracts.ts";

export interface RuntimeToolProgressPolicy {
  readonly schema: "agentloop.runtimeToolProgressPolicy/v1";
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

export function artifactStepToolProgressPolicy(requiredEvidenceKinds: readonly string[]): RuntimeToolProgressPolicy {
  return {
    schema: "agentloop.runtimeToolProgressPolicy/v1",
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
      "computer_write_file",
      "computer_run_command",
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

function hasRecentActionableDiagnostic(evidence: readonly AgentLoopToolEvidence[]): boolean {
  for (const item of [...evidence].reverse()) {
    if (item.toolName === "computer_write_file") return false;
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

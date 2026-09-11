import type {
  CapabilitySideEffect,
  EvidenceContract,
  EvidenceKind,
  PlanStep,
  PlanStepProposal,
  PlanningCapability,
  PlanningToolSummary,
  SourceKind,
  StepExecutionBinding,
} from "./contracts.ts";
import type { UploadedSourceSummary } from "../runtime/contracts.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";

const ARTIFACT_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
]);

const SOURCE_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "source_summary",
  "source_urls",
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
  "derived_aggregation",
  "explicit_caveats",
]);

export function createStepExecutionBinding(input: {
  readonly step: PlanStepProposal;
  readonly availableToolNames: ReadonlySet<string>;
  readonly availableTools?: readonly PlanningToolSummary[];
  readonly evidenceContract?: EvidenceContract;
}): StepExecutionBinding {
  const requiredCapabilities = uniqueStrings(input.step.requiredCapabilities);
  const requiredToolSourceIds = uniqueStrings(input.step.sourceConstraint?.requiredToolSourceIds ?? []);
  const requiredUploadedSourceIds = uniqueStrings(input.step.sourceConstraint?.requiredUploadedSourceIds ?? []);
  const requiredVisibleDirectoryIds = uniqueStrings(input.step.sourceConstraint?.requiredVisibleDirectoryIds ?? []);
  const resolvedToolNames = resolveToolNamesForCapabilities(
    requiredCapabilities,
    input.availableToolNames,
    input.availableTools,
    requiredToolSourceIds,
  );
  const evidenceKinds = uniqueEvidenceKinds(input.evidenceContract?.requiredKinds ?? []);
  return {
    schema: "agentloop.stepExecutionBinding/v1",
    requiredCapabilities,
    resolvedToolNames,
    sourceKinds: inferSourceKinds(requiredCapabilities, evidenceKinds),
    sideEffect: inferSideEffect(requiredCapabilities),
    evidenceKinds,
    ...(requiredToolSourceIds.length === 0 ? {} : { requiredToolSourceIds }),
    ...(requiredUploadedSourceIds.length === 0 ? {} : { requiredUploadedSourceIds }),
    ...(requiredVisibleDirectoryIds.length === 0 ? {} : { requiredVisibleDirectoryIds }),
  };
}

export function stepRequiredCapabilities(step: Pick<PlanStep, "requiredCapabilities" | "executionBinding">): readonly string[] {
  return step.executionBinding.requiredCapabilities;
}

export function stepResolvedToolNames(step: Pick<PlanStep, "executionBinding">): readonly string[] {
  return step.executionBinding.resolvedToolNames;
}

export function stepUsesTool(
  step: Pick<PlanStep, "executionBinding">,
  predicate: (toolName: string) => boolean,
): boolean {
  return stepResolvedToolNames(step).some(predicate);
}

export function stepHasTool(
  step: Pick<PlanStep, "executionBinding">,
  toolName: string,
): boolean {
  return stepResolvedToolNames(step).includes(toolName);
}

export function stepSourceKinds(step: Pick<PlanStep, "executionBinding">): readonly SourceKind[] {
  return step.executionBinding.sourceKinds;
}

export function stepHasSourceKind(step: Pick<PlanStep, "executionBinding">, kind: SourceKind): boolean {
  return step.executionBinding.sourceKinds.includes(kind);
}

export function planningCapabilitiesFromToolNames(
  toolNames: readonly string[],
  sources?: readonly UploadedSourceSummary[],
): PlanningCapability[] {
  const available = new Set(toolNames);
  return CAPABILITY_DEFINITIONS
    .filter((definition) => capabilityIsAvailableForSources(definition.id, sources))
    .map((definition) => ({
      ...definition,
      resolvedToolNames: resolveToolNamesForCapabilities([definition.id], available),
    }))
    .filter((definition) => definition.resolvedToolNames.length > 0 || definition.id === "conversation_delivery")
    .map(({ resolvedToolNames: _resolvedToolNames, ...definition }) => definition);
}

/**
 * Merges kernel capabilities with host-declared source vocabulary. The host
 * owns vocabulary registration; the kernel only binds declared IDs to Tools.
 */
export function planningCapabilitiesFromTools(
  tools: readonly PlanningToolSummary[],
  sources?: readonly UploadedSourceSummary[],
): PlanningCapability[] {
  const staticCapabilities = planningCapabilitiesFromToolNames(tools.map((tool) => tool.name), sources);
  const dynamic = new Map<string, PlanningCapability>();
  for (const tool of tools) {
    const source = tool.source;
    if (source === undefined) continue;
    for (const capability of source.capabilities) {
      const current = dynamic.get(capability.id);
      if (current === undefined) {
        dynamic.set(capability.id, {
          id: capability.id,
          category: capability.category,
          ...(capability.label === undefined ? {} : { label: capability.label }),
          ...(capability.description === undefined ? {} : { description: capability.description }),
          sourceIds: [source.id],
          produces: ["source_summary", "explicit_caveats"],
          sourceKinds: ["web"],
          sideEffect: "external_read",
          risk: "medium",
        });
        continue;
      }
      if (!current.sourceIds?.includes(source.id)) {
        dynamic.set(capability.id, { ...current, sourceIds: [...(current.sourceIds ?? []), source.id] });
      }
    }
  }
  return [...staticCapabilities, ...dynamic.values()];
}

const SKILL_SOURCE_PROVIDER_CAPABILITY_PREFIX = "skill_source_provider.";

/**
 * The Runtime selects source-provider Skills before planning. Their declared
 * evidence interface is then available to the Planner and is added to every
 * bound leaf by Admission; the Planner never needs to reconstruct it.
 */
export function planningCapabilitiesFromSkills(skills: readonly PrivateSkill[]): PlanningCapability[] {
  return skills.flatMap((skill) => {
    const metadata = skill.agentLoop;
    const produces = metadata?.producesEvidenceKinds ?? [];
    if (!metadata?.roles.includes("source_provider") || produces.length === 0) return [];
    return metadata.sourceKinds.map((sourceKind) => ({
      id: skillSourceProviderCapabilityId(skill.id, sourceKind),
      category: "skill_source_provider",
      label: `Read ${skill.name} source`,
      produces: [...produces],
      sourceKinds: [sourceKind],
      sideEffect: "external_read",
      risk: "medium",
      constraints: ["requires the declaring source-provider Skill to be bound to the step"],
    }));
  });
}

export function skillSourceProviderCapabilityId(skillId: string, sourceKind: string): string {
  return `${SKILL_SOURCE_PROVIDER_CAPABILITY_PREFIX}${sourceKind}.${skillId}`;
}

/**
 * Resolves source names deliberately mentioned in user input. Source aliases
 * are host registration data, so this remains independent of a transport,
 * provider, or individual Tool name.
 */
export function requiredToolSourceIdsFromInput(input: string, tools: readonly PlanningToolSummary[]): string[] {
  const normalizedInput = normalizeSourceMatchText(input);
  if (normalizedInput.length === 0) return [];
  const sources = new Map<string, NonNullable<PlanningToolSummary["source"]>>();
  for (const tool of tools) {
    if (tool.source !== undefined && !sources.has(tool.source.id)) sources.set(tool.source.id, tool.source);
  }
  return [...sources.values()]
    .filter((source) => [source.id, ...(source.aliases ?? [])]
      .map(normalizeSourceMatchText)
      .some((alias) => alias.length > 0 && normalizedInput.includes(alias)))
    .map((source) => source.id);
}

export function unknownToolSourceIds(
  sourceIds: readonly string[],
  availableTools: readonly PlanningToolSummary[],
): string[] {
  const available = new Set(availableTools.flatMap((tool) => tool.source === undefined ? [] : [tool.source.id]));
  return uniqueStrings(sourceIds).filter((sourceId) => !available.has(sourceId));
}

export function unknownUploadedSourceIds(sourceIds: readonly string[], availableUploadedSourceIds: readonly string[]): string[] {
  const available = new Set(availableUploadedSourceIds);
  return uniqueStrings(sourceIds).filter((sourceId) => !available.has(sourceId));
}

export function unknownVisibleDirectoryIds(
  directoryIds: readonly string[],
  availableVisibleDirectoryIds: readonly string[],
): string[] {
  const available = new Set(availableVisibleDirectoryIds);
  return uniqueStrings(directoryIds).filter((directoryId) => !available.has(directoryId));
}

export function unresolvedToolSourceIds(
  sourceIds: readonly string[],
  resolvedToolNames: readonly string[],
  availableTools: readonly PlanningToolSummary[],
): string[] {
  const sourceByToolName = new Map(availableTools.map((tool) => [tool.name, tool.source?.id]));
  const resolvedSourceIds = new Set(resolvedToolNames.map((toolName) => sourceByToolName.get(toolName)));
  return uniqueStrings(sourceIds).filter((sourceId) => !resolvedSourceIds.has(sourceId));
}

export function capabilityRequiresTool(capability: string): boolean {
  if (capability === "external_api_call") return true;
  if (capability === "custom_tool_call") return true;
  const binding = CAPABILITY_TOOL_BINDINGS[capability];
  return binding !== undefined && binding.length > 0;
}

export function unknownPlanningCapabilities(
  capabilities: readonly string[],
  availableTools: readonly PlanningToolSummary[] = [],
  declaredCapabilities: readonly PlanningCapability[] = [],
): string[] {
  const dynamic = dynamicCapabilityIds(availableTools);
  const declared = new Set(declaredCapabilities.map((capability) => capability.id));
  return uniqueStrings(capabilities).filter((capability) =>
    CAPABILITY_TOOL_BINDINGS[capability] === undefined && !dynamic.has(capability) && !declared.has(capability)
  );
}

export function unsatisfiedToolCapabilities(
  capabilities: readonly string[],
  availableToolNames: ReadonlySet<string>,
  availableTools: readonly PlanningToolSummary[] = [],
  requiredToolSourceIds: readonly string[] = [],
): string[] {
  const dynamic = dynamicCapabilityIds(availableTools);
  return uniqueStrings(capabilities).filter((capability) =>
    (capabilityRequiresTool(capability) || dynamic.has(capability))
    && resolveToolNamesForCapabilities([capability], availableToolNames, availableTools, requiredToolSourceIds).length === 0
  );
}

export function resolveToolNamesForCapabilities(
  capabilities: readonly string[],
  availableToolNames: ReadonlySet<string>,
  availableTools: readonly PlanningToolSummary[] = [],
  requiredToolSourceIds: readonly string[] = [],
): string[] {
  const resolved = new Set<string>();
  for (const capability of capabilities) {
    if (capability === "external_api_call") {
      for (const toolName of availableToolNames) {
        if (isExternalApiToolName(toolName)) resolved.add(toolName);
      }
      continue;
    }
    if (capability === "custom_tool_call") {
      for (const toolName of availableToolNames) {
        if (!CORE_WORKSPACE_TOOL_NAMES.has(toolName) && !isExternalApiToolName(toolName)) resolved.add(toolName);
      }
      continue;
    }
    const definition = CAPABILITY_TOOL_BINDINGS[capability];
    if (definition !== undefined) {
      for (const toolName of definition) {
        if (availableToolNames.has(toolName)) resolved.add(toolName);
      }
      continue;
    }
    for (const tool of availableTools) {
      if (
        availableToolNames.has(tool.name)
        && tool.source?.capabilities.some((declared) => declared.id === capability)
      ) {
        resolved.add(tool.name);
      }
    }
  }
  if (requiredToolSourceIds.length === 0) return [...resolved];
  const required = new Set(requiredToolSourceIds);
  const sourceByTool = new Map(availableTools.map((tool) => [tool.name, tool.source?.id]));
  return [...resolved].filter((toolName) => required.has(sourceByTool.get(toolName) ?? ""));
}

function dynamicCapabilityIds(tools: readonly PlanningToolSummary[]): ReadonlySet<string> {
  return new Set(tools.flatMap((tool) => tool.source?.capabilities.map((capability) => capability.id) ?? []));
}

function isExternalApiToolName(toolName: string): boolean {
  return /(?:^mcp_|_mcp_|api|http|request|query|search|fetch|maps?|email|send|publish|collect|proof|source)/iu.test(toolName)
    && !CORE_WORKSPACE_TOOL_NAMES.has(toolName);
}

function inferSourceKinds(capabilities: readonly string[], evidenceKinds: readonly EvidenceKind[]): SourceKind[] {
  const kinds = new Set<SourceKind>();
  for (const capability of capabilities) {
    const match = capability.match(/^skill_source_provider\.([a-z]+)\./u);
    if (match !== null && isSkillSourceKind(match[1])) kinds.add(match[1]);
  }
  if (capabilities.includes("uploaded_source_read") || capabilities.includes("uploaded_table_extraction")) kinds.add("uploaded_source");
  if (capabilities.includes("visible_directory_read") || capabilities.includes("visible_table_extraction")) kinds.add("visible_directory");
  if (capabilities.includes("web_research")) kinds.add("web");
  if (capabilities.includes("external_api_call")) kinds.add("web");
  if (capabilities.includes("workspace_file_read") || capabilities.includes("workspace_structured_artifact_read") || capabilities.includes("workspace_artifact_write")) kinds.add("workspace_file");
  if (evidenceKinds.some((kind) => SOURCE_EVIDENCE_KINDS.has(kind)) && kinds.size === 0) {
    kinds.add("conversation_workset");
  }
  if (evidenceKinds.some((kind) => ARTIFACT_EVIDENCE_KINDS.has(kind))) kinds.add("generated_artifact");
  return [...kinds];
}

function isSkillSourceKind(value: string): value is SourceKind {
  return value === "api"
    || value === "database"
    || value === "dataset"
    || value === "document"
    || value === "repository"
    || value === "rubric";
}

function inferSideEffect(capabilities: readonly string[]): CapabilitySideEffect {
  if (capabilities.includes("external_side_effect")) return "external_write";
  if (capabilities.includes("workspace_artifact_write") || capabilities.includes("artifact_acceptance")) return "workspace_write";
  if (capabilities.includes("web_research")) return "external_read";
  if (capabilities.includes("external_api_call")) return "external_read";
  if (capabilities.includes("custom_tool_call")) return "workspace_write";
  if (
    capabilities.includes("uploaded_source_read")
    || capabilities.includes("uploaded_table_extraction")
    || capabilities.includes("visible_directory_read")
    || capabilities.includes("visible_table_extraction")
    || capabilities.includes("workspace_file_read")
    || capabilities.includes("workspace_structured_artifact_read")
    || capabilities.includes("skill_instruction_load")
  ) {
    return "workspace_read";
  }
  return "none";
}

function uniqueEvidenceKinds(values: readonly EvidenceKind[]): EvidenceKind[] {
  return uniqueStrings(values) as EvidenceKind[];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeSourceMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const CORE_WORKSPACE_TOOL_NAMES = new Set([
  "read_source",
  "visible_index_directory",
  "visible_find_files",
  "visible_read_file",
  "visible_read_files",
  "visible_search_text",
  "visible_extract_tables",
  "computer_list_directory",
  "computer_find_files",
  "computer_search_text",
  "computer_read_file",
  "computer_read_json",
  "computer_summarize_table_artifact",
  "computer_aggregate_table_artifact",
  "computer_write_file",
  "computer_patch_file",
  "computer_run_command",
  "materialize_paginated_html",
  "convert_artifact",
  "verify_artifact_acceptance",
  "load_skill",
]);

function capabilityIsAvailableForSources(
  capability: string,
  sources: readonly UploadedSourceSummary[] | undefined,
): boolean {
  if (capability !== "uploaded_table_extraction" || sources === undefined) return true;
  return sources.some((source) => source.status === "ready" && isTabularUpload(source.extension));
}

function isTabularUpload(extension: string): boolean {
  return extension === ".csv" || extension === ".xlsx" || extension === ".xlsm";
}

const CAPABILITY_TOOL_BINDINGS: Record<string, readonly string[]> = {
  uploaded_source_read: ["read_source"],
  uploaded_table_extraction: ["extract_source_tables"],
  visible_directory_read: [
    "visible_index_directory",
    "visible_find_files",
    "visible_read_file",
    "visible_read_files",
    "visible_search_text",
  ],
  visible_table_extraction: ["visible_extract_tables"],
  web_research: ["websearch", "webfetch"],
  workspace_file_read: [
    "computer_list_directory",
    "computer_find_files",
    "computer_search_text",
    "computer_read_file",
    "computer_read_json",
  ],
  workspace_structured_artifact_read: [
    "computer_read_json",
    "computer_summarize_table_artifact",
    "computer_aggregate_table_artifact",
  ],
  workspace_artifact_write: [
    "computer_write_file",
    "computer_patch_file",
    "computer_run_command",
    "materialize_paginated_html",
    "convert_artifact",
  ],
  external_api_call: [],
  custom_tool_call: [],
  artifact_acceptance: ["verify_artifact_acceptance"],
  skill_instruction_load: ["load_skill"],
  conversation_delivery: [],
};

const CAPABILITY_DEFINITIONS: readonly PlanningCapability[] = [
  {
    id: "uploaded_source_read",
    category: "information_retrieval",
    label: "Read uploaded source",
    produces: ["source_summary", "explicit_caveats"],
    sourceKinds: ["uploaded_source"],
    sideEffect: "none",
    risk: "low",
    constraints: ["requires uploaded source grant"],
  },
  {
    id: "uploaded_table_extraction",
    category: "structured_extraction",
    label: "Extract uploaded table",
    produces: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
    sourceKinds: ["uploaded_source"],
    sideEffect: "workspace_write",
    risk: "low",
    constraints: ["requires at least one authorized tabular uploaded source"],
  },
  {
    id: "visible_directory_read",
    category: "information_retrieval",
    label: "Read visible directory",
    produces: ["source_summary", "explicit_caveats"],
    sourceKinds: ["visible_directory"],
    sideEffect: "workspace_read",
    risk: "low",
    constraints: ["requires visible directory grant"],
  },
  {
    id: "visible_table_extraction",
    category: "structured_extraction",
    label: "Extract visible table",
    produces: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
    sourceKinds: ["visible_directory"],
    sideEffect: "workspace_read",
    risk: "low",
    constraints: ["requires a visible-directory table source selected by Runtime tools"],
  },
  {
    id: "web_research",
    category: "information_retrieval",
    label: "Research web sources",
    produces: ["source_summary", "source_urls", "explicit_caveats"],
    sourceKinds: ["web"],
    sideEffect: "external_read",
    risk: "medium",
  },
  {
    id: "workspace_file_read",
    category: "information_retrieval",
    label: "Read workspace files",
    produces: ["source_summary", "explicit_caveats"],
    sourceKinds: ["workspace_file"],
    sideEffect: "workspace_read",
    risk: "low",
  },
  {
    id: "workspace_structured_artifact_read",
    category: "structured_data",
    label: "Read structured workspace artifact",
    produces: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "derived_aggregation", "explicit_caveats"],
    sourceKinds: ["workspace_file"],
    sideEffect: "workspace_read",
    risk: "low",
    constraints: ["requires a durable structured artifact produced by an earlier step"],
  },
  {
    id: "workspace_artifact_write",
    category: "artifact_production",
    label: "Write workspace artifact",
    produces: ["artifact_path", "artifact_non_empty", "format_matches_request"],
    sourceKinds: ["workspace_file", "generated_artifact"],
    sideEffect: "workspace_write",
    risk: "medium",
  },
  {
    id: "external_api_call",
    category: "external_integration",
    label: "Call external API capability",
    produces: ["source_summary", "explicit_caveats"],
    sourceKinds: ["web"],
    sideEffect: "external_read",
    risk: "medium",
    constraints: ["requires an authorized external API Tool"],
  },
  {
    id: "artifact_acceptance",
    category: "artifact_verification",
    label: "Verify artifact acceptance",
    produces: ["artifact_acceptance", "artifact_openable", "explicit_caveats"],
    sourceKinds: ["generated_artifact"],
    sideEffect: "workspace_read",
    risk: "low",
  },
  {
    id: "skill_instruction_load",
    category: "skill_application",
    label: "Load selected Skill instructions",
    produces: ["explicit_caveats"],
    sourceKinds: ["workspace_file"],
    sideEffect: "workspace_read",
    risk: "low",
    constraints: ["requires selected Skill binding"],
  },
  {
    id: "custom_tool_call",
    category: "external_integration",
    label: "Use authorized custom tool",
    produces: ["explicit_caveats"],
    sourceKinds: ["workspace_file"],
    sideEffect: "workspace_write",
    risk: "medium",
    constraints: ["requires an authorized custom Tool outside the core catalog"],
  },
  {
    id: "conversation_delivery",
    category: "conversation_delivery",
    label: "Deliver conversation answer",
    produces: ["delivery_receipt", "explicit_caveats"],
    sourceKinds: ["conversation_workset"],
    sideEffect: "none",
    risk: "low",
  },
];

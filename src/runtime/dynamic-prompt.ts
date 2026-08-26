export type DynamicPromptPhase = "planning" | "execution" | "assessment" | "compaction";
export type TaskIntent = "reply" | "execute" | "continue" | "recover" | "clarify";
export type EvidenceProfile = "deterministic" | "evidence_gate" | "lookup_lite" | "source_grounded" | "risk_sensitive";
export type RiskProfile =
  | "no_tool"
  | "read_only"
  | "workspace_write"
  | "external_network"
  | "external_side_effect"
  | "dangerous_or_irreversible";
export type PlanShape = "single_leaf" | "fact_then_produce" | "multi_deliverable" | "pipeline" | "recovery_patch" | "human_blocked";
export type ArtifactKind = "html" | "document" | "presentation" | "spreadsheet" | "image" | "code" | "none";
export type SourceNeed = "none" | "lookup_lite" | "source_grounded" | "strict_user_source";
export type DeliverySurface = "conversation" | "workspace_artifact";

export interface DynamicPromptProfile {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly planningRules?: readonly string[];
  readonly executionRules?: readonly string[];
  readonly successEvidence?: readonly string[];
}

export interface TaskProfile {
  readonly schema: "agentloop.taskProfile/v2";
  readonly phase: DynamicPromptPhase;
  readonly intent: TaskIntent;
  readonly operations: readonly DynamicPromptProfile[];
  readonly evidenceProfile?: EvidenceProfile;
  readonly riskProfile?: RiskProfile;
  readonly planShape?: PlanShape;
  readonly artifactKind?: ArtifactKind;
  readonly sourceNeed?: SourceNeed;
  readonly deliverySurface?: DeliverySurface;
  readonly skillBound: boolean;
  readonly responseOnly?: boolean;
}

export type DynamicPromptClassification = TaskProfile;

export function buildTaskProfile(input: {
  readonly phase: DynamicPromptPhase;
  readonly intent: TaskIntent;
  readonly operations?: readonly DynamicPromptProfile[];
  readonly evidenceProfile?: EvidenceProfile;
  readonly riskProfile?: RiskProfile;
  readonly planShape?: PlanShape;
  readonly artifactKind?: ArtifactKind;
  readonly sourceNeed?: SourceNeed;
  readonly deliverySurface?: DeliverySurface;
  readonly skillBound?: boolean;
  readonly responseOnly?: boolean;
}): TaskProfile {
  return {
    schema: "agentloop.taskProfile/v2",
    phase: input.phase,
    intent: input.intent,
    operations: input.operations ?? [],
    ...(input.evidenceProfile === undefined ? {} : { evidenceProfile: input.evidenceProfile }),
    ...(input.riskProfile === undefined ? {} : { riskProfile: input.riskProfile }),
    ...(input.planShape === undefined ? {} : { planShape: input.planShape }),
    ...(input.artifactKind === undefined ? {} : { artifactKind: input.artifactKind }),
    ...(input.sourceNeed === undefined ? {} : { sourceNeed: input.sourceNeed }),
    ...(input.deliverySurface === undefined ? {} : { deliverySurface: input.deliverySurface }),
    skillBound: input.skillBound === true,
    ...(input.responseOnly === undefined ? {} : { responseOnly: input.responseOnly }),
  };
}

export function buildDynamicSystemPrompt(input: {
  readonly phase: DynamicPromptPhase;
  readonly baseInstructions: readonly string[];
  readonly contractLines: readonly string[];
  readonly taskProfile?: TaskProfile;
  readonly extraLines?: readonly string[];
}): string {
  const sections = [
    input.baseInstructions.join("\n\n"),
    [
      "<runtime_contract>",
      ...input.contractLines,
      "Prompt profiles shape attention only; Runtime owns authorization, evidence, assessment, Plan progression, and terminal completion.",
      "</runtime_contract>",
    ].join("\n"),
    taskProfileSystemSection(input.taskProfile),
    ...(input.extraLines === undefined || input.extraLines.length === 0
      ? []
      : [input.extraLines.join("\n")]),
  ].filter((section) => section.trim().length > 0);
  return sections.join("\n\n");
}

export function formatDynamicPromptContext(taskProfile: TaskProfile): string {
  return [
    `<dynamic_prompt_context source="server" phase="${escapeXmlAttribute(taskProfile.phase)}">`,
    JSON.stringify(taskProfile),
    "</dynamic_prompt_context>",
  ].join("\n");
}

function taskProfileSystemSection(taskProfile: TaskProfile | undefined): string {
  if (taskProfile === undefined) return "";
  const payload = {
    phase: taskProfile.phase,
    intent: taskProfile.intent,
    ops: taskProfile.operations.map((profile) => profile.id),
    ...(taskProfile.evidenceProfile === undefined ? {} : { evidence: taskProfile.evidenceProfile }),
    ...(taskProfile.riskProfile === undefined ? {} : { risk: taskProfile.riskProfile }),
    ...(taskProfile.planShape === undefined ? {} : { shape: taskProfile.planShape }),
    ...(taskProfile.artifactKind === undefined ? {} : { artifactKind: taskProfile.artifactKind }),
    ...(taskProfile.sourceNeed === undefined ? {} : { sourceNeed: taskProfile.sourceNeed }),
    ...(taskProfile.deliverySurface === undefined ? {} : { deliverySurface: taskProfile.deliverySurface }),
    skillBound: taskProfile.skillBound,
    ...(taskProfile.responseOnly === undefined ? {} : { responseOnly: taskProfile.responseOnly }),
  };
  return [
    "<dynamic_prompt_profile source=\"server\" semantics=\"classification-only\">",
    JSON.stringify(payload),
    "</dynamic_prompt_profile>",
  ].join("\n");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

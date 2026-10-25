import type {
  SkillAgentLoopArtifactKind,
  SkillAgentLoopMetadata,
  SkillAgentLoopQaKind,
  SkillAgentLoopRole,
  SkillAgentLoopSourceKind,
} from "./agentloop-metadata.ts";
import {
  SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES,
  SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES,
  SKILL_AGENT_LOOP_PRODUCED_EVIDENCE_KIND_VALUES,
  SKILL_AGENT_LOOP_QA_KIND_VALUES,
  SKILL_AGENT_LOOP_ROLE_VALUES,
  SKILL_AGENT_LOOP_SOURCE_KIND_VALUES,
} from "./agentloop-metadata.ts";

export const SKILL_DECLARATION_SCHEMA = "agentloop.skillDeclaration/v1" as const;

export interface SkillDeclaration {
  readonly schema: typeof SKILL_DECLARATION_SCHEMA;
  readonly identity: {
    readonly name: string;
    readonly description: string;
  };
  readonly activation: {
    readonly semanticTags: readonly string[];
    readonly intentExamples: readonly string[];
  };
  readonly workflow: {
    readonly roles: readonly SkillAgentLoopRole[];
    readonly artifactKinds: readonly SkillAgentLoopArtifactKind[];
    readonly sourceKinds: readonly SkillAgentLoopSourceKind[];
    readonly qaKinds: readonly SkillAgentLoopQaKind[];
    readonly requiredSkills: readonly string[];
  };
  readonly execution?: {
    readonly manifest: "agentloop.executors.json";
  };
  /** Temporary migration projection for consumers not yet on ResolvedSkillContract. */
  readonly compatibility?: {
    readonly executionProfiles?: readonly (typeof SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES[number])[];
    readonly producesEvidenceKinds?: readonly (typeof SKILL_AGENT_LOOP_PRODUCED_EVIDENCE_KIND_VALUES[number])[];
  };
}

export type SkillDeclarationSource = "package" | "legacy-frontmatter" | "detected";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ROLE_VALUES = new Set<string>(SKILL_AGENT_LOOP_ROLE_VALUES);
const ARTIFACT_VALUES = new Set<string>(SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES);
const SOURCE_VALUES = new Set<string>(SKILL_AGENT_LOOP_SOURCE_KIND_VALUES);
const QA_VALUES = new Set<string>(SKILL_AGENT_LOOP_QA_KIND_VALUES);
const EXECUTION_PROFILE_VALUES = new Set<string>(SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES);
const EVIDENCE_VALUES = new Set<string>(SKILL_AGENT_LOOP_PRODUCED_EVIDENCE_KIND_VALUES);

export function parseSkillDeclaration(value: unknown): SkillDeclaration {
  const root = record(value, "Skill declaration");
  if (root.schema !== SKILL_DECLARATION_SCHEMA) throw invalid("skill_declaration_schema_invalid");
  const identity = record(root.identity, "Skill declaration identity");
  const name = string(identity.name, "skill_declaration_identity_name");
  const description = string(identity.description, "skill_declaration_identity_description");
  if (!NAME_PATTERN.test(name) || name.length > 80) throw invalid("skill_declaration_identity_name_invalid");
  if (description.length < 1 || description.length > 2_000) throw invalid("skill_declaration_identity_description_invalid");
  const activation = record(root.activation, "Skill declaration activation");
  const workflow = record(root.workflow, "Skill declaration workflow");
  const semanticTags = stringList(activation.semanticTags, "skill_declaration_semantic_tags", TAG_PATTERN, 32);
  const intentExamples = stringList(activation.intentExamples, "skill_declaration_intent_examples", undefined, 16, 500);
  const roles = enumList(workflow.roles, "skill_declaration_roles", ROLE_VALUES, 1) as SkillAgentLoopRole[];
  const artifactKinds = enumList(workflow.artifactKinds, "skill_declaration_artifact_kinds", ARTIFACT_VALUES, 1) as SkillAgentLoopArtifactKind[];
  const sourceKinds = enumList(workflow.sourceKinds, "skill_declaration_source_kinds", SOURCE_VALUES) as SkillAgentLoopSourceKind[];
  const qaKinds = enumList(workflow.qaKinds, "skill_declaration_qa_kinds", QA_VALUES) as SkillAgentLoopQaKind[];
  const requiredSkills = stringList(workflow.requiredSkills, "skill_declaration_required_skills", NAME_PATTERN, 32, 80);
  const execution = root.execution === undefined ? undefined : record(root.execution, "Skill declaration execution");
  if (execution !== undefined && execution.manifest !== "agentloop.executors.json") throw invalid("skill_declaration_manifest_invalid");
  const compatibility = root.compatibility === undefined ? undefined : record(root.compatibility, "Skill declaration compatibility");
  const executionProfiles = compatibility?.executionProfiles === undefined ? [] : enumList(compatibility.executionProfiles, "skill_declaration_execution_profiles", EXECUTION_PROFILE_VALUES) as typeof SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES[number][];
  const producesEvidenceKinds = compatibility?.producesEvidenceKinds === undefined ? [] : enumList(compatibility.producesEvidenceKinds, "skill_declaration_evidence_kinds", EVIDENCE_VALUES) as typeof SKILL_AGENT_LOOP_PRODUCED_EVIDENCE_KIND_VALUES[number][];
  return {
    schema: SKILL_DECLARATION_SCHEMA,
    identity: { name, description },
    activation: { semanticTags, intentExamples },
    workflow: { roles, artifactKinds, sourceKinds, qaKinds, requiredSkills },
    ...(execution === undefined ? {} : { execution: { manifest: "agentloop.executors.json" as const } }),
    ...(compatibility === undefined || (executionProfiles.length === 0 && producesEvidenceKinds.length === 0) ? {} : {
      compatibility: {
        ...(executionProfiles.length === 0 ? {} : { executionProfiles }),
        ...(producesEvidenceKinds.length === 0 ? {} : { producesEvidenceKinds }),
      },
    }),
  };
}

export function parseSkillDeclarationJson(source: string): SkillDeclaration {
  try {
    return parseSkillDeclaration(JSON.parse(source));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("skill_declaration_")) throw error;
    throw invalid("skill_declaration_json_invalid");
  }
}

export function serializeSkillDeclaration(declaration: SkillDeclaration): string {
  return `${JSON.stringify(parseSkillDeclaration(declaration), null, 2)}\n`;
}

export function declarationFromLegacyMetadata(
  name: string,
  description: string,
  metadata: SkillAgentLoopMetadata,
  hasExecutorManifest = false,
): SkillDeclaration {
  return parseSkillDeclaration({
    schema: SKILL_DECLARATION_SCHEMA,
    identity: { name, description },
    activation: {
      semanticTags: metadata.semanticTags ?? [],
      intentExamples: metadata.intentExamples ?? [],
    },
    workflow: {
      roles: metadata.roles,
      artifactKinds: metadata.artifactKinds,
      sourceKinds: metadata.sourceKinds,
      qaKinds: metadata.qaKinds,
      requiredSkills: metadata.requiredSkillNames ?? [],
    },
    ...(hasExecutorManifest ? { execution: { manifest: "agentloop.executors.json" } } : {}),
    compatibility: {
      ...(metadata.executionProfiles === undefined ? {} : { executionProfiles: metadata.executionProfiles }),
      ...(metadata.producesEvidenceKinds === undefined ? {} : { producesEvidenceKinds: metadata.producesEvidenceKinds }),
    },
  });
}

/** Deterministic, non-authorizing metadata proposal for packages without metadata. */
export function detectSkillDeclaration(
  name: string,
  description: string,
  instructions: string,
  files: readonly string[],
  hasExecutorManifest = false,
): SkillDeclaration {
  const text = `${name} ${description} ${instructions}`.toLowerCase();
  const artifactKinds: SkillAgentLoopArtifactKind[] = [];
  const artifactHints: Array<[string, SkillAgentLoopArtifactKind]> = [
    ["pptx|presentation|slide|deck", "presentation"],
    ["docx|word|document|report", "document"],
    ["xlsx|spreadsheet|excel|csv", "spreadsheet"],
    ["png|jpg|image|visual", "image"],
    ["audio|sound|mp3|wav", "audio"],
    ["html|web|dashboard", "html"],
    ["code|script|repository|repo", "code"],
  ];
  for (const [pattern, kind] of artifactHints) if (new RegExp(pattern, "u").test(text) || files.some((file) => new RegExp(pattern, "iu").test(file))) artifactKinds.push(kind);
  // Detection is a review proposal, not an authorization source. Keep the
  // role and source capability conservative until the user explicitly edits
  // and activates the declaration.
  const roles: SkillAgentLoopRole[] = ["support"];
  const sourceKinds: SkillAgentLoopSourceKind[] = [];
  const tags = [...new Set(name.split("-").filter((tag) => TAG_PATTERN.test(tag)))];
  return parseSkillDeclaration({
    schema: SKILL_DECLARATION_SCHEMA,
    identity: { name, description },
    activation: { semanticTags: tags, intentExamples: description.length > 0 ? [description] : [] },
    workflow: {
      roles,
      artifactKinds: artifactKinds.length === 0 ? ["none"] : [...new Set(artifactKinds)],
      sourceKinds: [...new Set(sourceKinds)],
      qaKinds: [],
      requiredSkills: [],
    },
    ...(hasExecutorManifest ? { execution: { manifest: "agentloop.executors.json" } } : {}),
  });
}

export function projectSkillAgentLoopMetadata(declaration: SkillDeclaration): SkillAgentLoopMetadata {
  return {
    roles: declaration.workflow.roles,
    artifactKinds: declaration.workflow.artifactKinds,
    sourceKinds: declaration.workflow.sourceKinds,
    qaKinds: declaration.workflow.qaKinds,
    ...(declaration.activation.semanticTags.length === 0 ? {} : { semanticTags: declaration.activation.semanticTags }),
    ...(declaration.activation.intentExamples.length === 0 ? {} : { intentExamples: declaration.activation.intentExamples }),
    ...(declaration.workflow.requiredSkills.length === 0 ? {} : { requiredSkillNames: declaration.workflow.requiredSkills }),
    ...(declaration.compatibility?.executionProfiles === undefined ? {} : { executionProfiles: declaration.compatibility.executionProfiles }),
    ...(declaration.compatibility?.producesEvidenceKinds === undefined ? {} : { producesEvidenceKinds: declaration.compatibility.producesEvidenceKinds }),
  };
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(code);
  return value as Record<string, unknown>;
}
function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) throw invalid(code);
  return value;
}
function stringList(value: unknown, code: string, pattern?: RegExp, max = 32, maxLength = 64): string[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(code);
  const result = value.map((item) => string(item, code));
  if (result.some((item) => item.length > maxLength || (pattern !== undefined && !pattern.test(item)))) throw invalid(code);
  return [...new Set(result)];
}
function enumList(value: unknown, code: string, allowed: ReadonlySet<string>, min = 0): string[] {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || !allowed.has(item))) throw invalid(code);
  return [...new Set(value as string[])];
}
function invalid(code: string): Error { return new Error(code); }

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

export interface SkillRequirements {
  readonly python?: {
    readonly version?: string;
    readonly packages: readonly string[];
    readonly files: readonly string[];
  };
  readonly commands: readonly string[];
  readonly environment: readonly string[];
  readonly mcpServers: readonly string[];
}

/** Public form contract. Enum choices and limits are shared with the parser. */
export const SKILL_DECLARATION_EDITOR_SCHEMA = {
  schema: SKILL_DECLARATION_SCHEMA,
  groups: [
    { id: "identity", fields: [
      { path: "identity.name", type: "text", readOnly: true, maxLength: 80 },
      { path: "identity.description", type: "textarea", readOnly: true, maxLength: 2000 },
    ] },
    { id: "activation", fields: [
      { path: "activation.semanticTags", type: "list", maxItems: 32, maxLength: 64, pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      { path: "activation.intentExamples", type: "list", maxItems: 16, maxLength: 500 },
    ] },
    { id: "workflow", fields: [
      { path: "workflow.roles", type: "choices", values: SKILL_AGENT_LOOP_ROLE_VALUES, minItems: 1 },
      { path: "workflow.artifactKinds", type: "choices", values: SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES, minItems: 1 },
      { path: "workflow.sourceKinds", type: "choices", values: SKILL_AGENT_LOOP_SOURCE_KIND_VALUES },
      { path: "workflow.qaKinds", type: "choices", values: SKILL_AGENT_LOOP_QA_KIND_VALUES },
      { path: "workflow.requiredSkills", type: "skills", maxItems: 32, maxLength: 80, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    ] },
    { id: "requirements", fields: [
      { path: "requirements.python.version", type: "text", maxLength: 120, pattern: "^[0-9.*<>=!~, \\t]+$", optional: true },
      { path: "requirements.python.packages", type: "list", maxItems: 128, maxLength: 500 },
      { path: "requirements.python.files", type: "list", maxItems: 16, maxLength: 240 },
      { path: "requirements.commands", type: "list", maxItems: 32, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._+-]*$" },
      { path: "requirements.environment", type: "list", maxItems: 32, maxLength: 80, pattern: "^[A-Z_][A-Z0-9_]*$" },
      { path: "requirements.mcpServers", type: "list", maxItems: 32, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
    ] },
    { id: "execution", fields: [
      { path: "execution.manifest", type: "text", readOnly: true },
      { path: "compatibility.executionProfiles", type: "choices", values: SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES, readOnly: true },
      { path: "compatibility.producesEvidenceKinds", type: "choices", values: SKILL_AGENT_LOOP_PRODUCED_EVIDENCE_KIND_VALUES, readOnly: true },
    ] },
  ],
} as const;

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
  readonly requirements?: SkillRequirements;
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
  const requirements = root.requirements === undefined ? undefined : parseSkillRequirements(root.requirements);
  return {
    schema: SKILL_DECLARATION_SCHEMA,
    identity: { name, description },
    activation: { semanticTags, intentExamples },
    workflow: { roles, artifactKinds, sourceKinds, qaKinds, requiredSkills },
    ...(requirements === undefined ? {} : { requirements }),
    ...(execution === undefined ? {} : { execution: { manifest: "agentloop.executors.json" as const } }),
    ...(compatibility === undefined || (executionProfiles.length === 0 && producesEvidenceKinds.length === 0) ? {} : {
      compatibility: {
        ...(executionProfiles.length === 0 ? {} : { executionProfiles }),
        ...(producesEvidenceKinds.length === 0 ? {} : { producesEvidenceKinds }),
      },
    }),
  };
}

export function parseSkillRequirements(value: unknown): SkillRequirements {
  const root = record(value, "skill_requirements_invalid");
  if (Object.keys(root).some(key => !["python", "commands", "environment", "mcpServers"].includes(key))) throw invalid("skill_requirements_field_invalid");
  let python: SkillRequirements["python"];
  if (root.python !== undefined) {
    const entry = record(root.python, "skill_requirements_python_invalid");
    if (Object.keys(entry).some(key => !["version", "packages", "files"].includes(key))) throw invalid("skill_requirements_python_field_invalid");
    const version = entry.version === undefined ? undefined : string(entry.version, "skill_requirements_python_version_invalid");
    if (version !== undefined && (version.length > 120 || !/^[0-9.*<>=!~, \t]+$/u.test(version))) throw invalid("skill_requirements_python_version_invalid");
    const packages = stringList(entry.packages ?? [], "skill_requirements_python_packages_invalid", /^[A-Za-z0-9][^\r\n\0]*$/u, 128, 500);
    const files = stringList(entry.files ?? [], "skill_requirements_python_files_invalid", undefined, 16, 240);
    if (files.some(path => path.includes("\\") || path.startsWith("/") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === ".."))) throw invalid("skill_requirements_python_files_invalid");
    python = { ...(version === undefined ? {} : { version }), packages, files };
  }
  return {
    ...(python === undefined ? {} : { python }),
    commands: stringList(root.commands ?? [], "skill_requirements_commands_invalid", /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u, 32, 80),
    environment: stringList(root.environment ?? [], "skill_requirements_environment_invalid", /^[A-Z_][A-Z0-9_]*$/u, 32, 80),
    mcpServers: stringList(root.mcpServers ?? [], "skill_requirements_mcp_invalid", /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u, 32, 80),
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
  // Package assets and frontmatter field names do not establish a delivery
  // contract ("description" itself contains "script"). Semantic recognition
  // or an explicit package declaration owns roles, inputs and output kinds.
  // The basic declaration stays usable without making users confirm it.
  const roles: SkillAgentLoopRole[] = ["support"];
  const sourceKinds: SkillAgentLoopSourceKind[] = [];
  const tags = [...new Set(name.split("-").filter((tag) => TAG_PATTERN.test(tag)))];
  return parseSkillDeclaration({
    schema: SKILL_DECLARATION_SCHEMA,
    identity: { name, description },
    activation: { semanticTags: tags, intentExamples: description.length > 0 ? [description] : [] },
    workflow: {
      roles,
      artifactKinds: ["none"],
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

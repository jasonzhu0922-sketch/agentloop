export const SKILL_AGENT_LOOP_ROLE_VALUES = [
  "primary_builder",
  "source_provider",
  "support",
  "qa",
] as const;

export const SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES = [
  "html",
  "document",
  "presentation",
  "spreadsheet",
  "image",
  "code",
  "none",
] as const;

export const SKILL_AGENT_LOOP_SOURCE_KIND_VALUES = [
  "api",
  "database",
  "dataset",
  "document",
  "repository",
  "rubric",
  "web",
] as const;

export const SKILL_AGENT_LOOP_QA_KIND_VALUES = [
  "browser",
  "content",
  "openability",
  "playwright",
  "visual",
] as const;

export const SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES = [
  "local_script",
] as const;

export type SkillAgentLoopRole = typeof SKILL_AGENT_LOOP_ROLE_VALUES[number];
export type SkillAgentLoopArtifactKind = typeof SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES[number];
export type SkillAgentLoopSourceKind = typeof SKILL_AGENT_LOOP_SOURCE_KIND_VALUES[number];
export type SkillAgentLoopQaKind = typeof SKILL_AGENT_LOOP_QA_KIND_VALUES[number];
export type SkillAgentLoopExecutionProfile = typeof SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES[number];

export interface SkillAgentLoopMetadata {
  readonly roles: readonly SkillAgentLoopRole[];
  readonly artifactKinds: readonly SkillAgentLoopArtifactKind[];
  readonly sourceKinds: readonly SkillAgentLoopSourceKind[];
  readonly qaKinds: readonly SkillAgentLoopQaKind[];
  readonly executionProfiles?: readonly SkillAgentLoopExecutionProfile[];
}

export const SKILL_AGENT_LOOP_METADATA_FIELDS = {
  roles: {
    required: true,
    type: "list",
    values: SKILL_AGENT_LOOP_ROLE_VALUES,
  },
  artifactKinds: {
    required: true,
    type: "list",
    values: SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES,
  },
  sourceKinds: {
    required: false,
    type: "list",
    values: SKILL_AGENT_LOOP_SOURCE_KIND_VALUES,
  },
  qaKinds: {
    required: false,
    type: "list",
    values: SKILL_AGENT_LOOP_QA_KIND_VALUES,
  },
  executionProfiles: {
    required: false,
    type: "list",
    values: SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES,
  },
} as const;

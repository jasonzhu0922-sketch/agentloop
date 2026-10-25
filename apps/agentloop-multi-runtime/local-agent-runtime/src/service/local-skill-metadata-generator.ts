import { randomUUID } from "node:crypto";
import {
  detectSkillDeclaration,
  parseSkillDeclaration,
  type ModelAdapter,
  type SkillDeclaration,
  type SkillPackageInspection,
  SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES,
  SKILL_AGENT_LOOP_QA_KIND_VALUES,
  SKILL_AGENT_LOOP_ROLE_VALUES,
  SKILL_AGENT_LOOP_SOURCE_KIND_VALUES,
} from "@zhujun/agentloop";

export interface SkillMetadataModelInvoker {
  orderedModelKeys(): Promise<readonly string[]>;
  createModel(modelKey: string): ModelAdapter;
}

export interface GeneratedSkillMetadata {
  readonly declaration: SkillDeclaration;
  readonly fields: Readonly<Record<string, SkillMetadataFieldInfo>>;
  readonly source: "package" | "legacy-frontmatter" | "detected";
  readonly generationMethod: "none" | "legacy-projection" | "deterministic" | "model" | "deterministic+model";
  readonly modelKey?: string;
  readonly attemptedModelKeys?: readonly string[];
  readonly generationStatus: "not-needed" | "completed" | "fallback" | "failed";
  readonly generationError?: string;
}

export interface SkillMetadataFieldInfo {
  readonly origin: "package" | "legacy" | "detected" | "suggested" | "user";
  readonly confidence?: "high" | "medium" | "low";
  readonly editable: boolean;
  readonly evidence: readonly string[];
}

export async function generateSkillMetadata(
  inspection: SkillPackageInspection,
  invoker?: SkillMetadataModelInvoker,
): Promise<GeneratedSkillMetadata> {
  if (inspection.declaration !== undefined && inspection.declarationSource !== undefined) {
    return {
      declaration: inspection.declaration,
      fields: declarationFields(inspection.declaration, inspection.declarationSource === "legacy-frontmatter" ? "legacy" : "package", "high"),
      source: inspection.declarationSource,
      generationMethod: inspection.declarationSource === "legacy-frontmatter" ? "legacy-projection" : "none",
      generationStatus: "not-needed",
    };
  }

  const baseline = detectSkillDeclaration(
    inspection.name,
    inspection.description,
    inspection.instructions,
    inspection.files,
    inspection.files.includes("agentloop.executors.json"),
  );
  if (invoker === undefined) {
    return { declaration: baseline, fields: declarationFields(baseline, "detected", "low"), source: "detected", generationMethod: "deterministic", generationStatus: "fallback" };
  }

  const attemptedModelKeys: string[] = [];
  let lastError: string | undefined;
  for (const modelKey of await invoker.orderedModelKeys()) {
    attemptedModelKeys.push(modelKey);
    try {
      const response = await invoker.createModel(modelKey).complete(metadataInvocation(inspection, baseline), AbortSignal.timeout(20_000));
      const declaration = parseModelDeclaration(response.content, baseline);
      return {
        declaration,
        fields: declarationFields(declaration, "suggested", "medium"),
        source: "detected",
        generationMethod: "deterministic+model",
        modelKey,
        attemptedModelKeys,
        generationStatus: "completed",
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    }
  }
  return {
    declaration: baseline,
    fields: declarationFields(baseline, "detected", "low"),
    source: "detected",
    generationMethod: "deterministic",
    ...(attemptedModelKeys.length === 0 ? {} : { attemptedModelKeys }),
    generationStatus: attemptedModelKeys.length === 0 ? "fallback" : "failed",
    ...(lastError === undefined ? {} : { generationError: lastError }),
  };
}

function declarationFields(declaration: SkillDeclaration, origin: SkillMetadataFieldInfo["origin"], confidence: SkillMetadataFieldInfo["confidence"]): Readonly<Record<string, SkillMetadataFieldInfo>> {
  const field = (editable: boolean): SkillMetadataFieldInfo => ({ origin, confidence, editable, evidence: [] });
  return {
    "identity.name": field(false),
    "identity.description": field(false),
    "activation.semanticTags": field(true),
    "activation.intentExamples": field(true),
    "workflow.roles": field(true),
    "workflow.artifactKinds": field(true),
    "workflow.sourceKinds": field(true),
    "workflow.qaKinds": field(true),
    "workflow.requiredSkills": field(true),
    "compatibility.executionProfiles": field(false),
    "compatibility.producesEvidenceKinds": field(false),
    ...(declaration.execution === undefined ? {} : { "execution.manifest": field(false) }),
  };
}

function metadataInvocation(inspection: SkillPackageInspection, baseline: SkillDeclaration) {
  const instructions = inspection.instructions.length > 120_000 ? inspection.instructions.slice(0, 120_000) : inspection.instructions;
  return {
    runId: `skill-metadata:${randomUUID()}`,
    phase: "planning" as const,
    systemPrompt: [
      "You generate AgentLoop Skill metadata. Return exactly one JSON object and no prose.",
      "Do not invent identity, commands, scripts, capabilities, secrets, paths, MCP sources, or evidence producers.",
      "Use only the enumerated values below. Keep identity.name and identity.description exactly as provided.",
      `roles: ${SKILL_AGENT_LOOP_ROLE_VALUES.join(", ")}`,
      `artifactKinds: ${SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES.join(", ")}`,
      `sourceKinds: ${SKILL_AGENT_LOOP_SOURCE_KIND_VALUES.join(", ")}`,
      `qaKinds: ${SKILL_AGENT_LOOP_QA_KIND_VALUES.join(", ")}`,
      "semanticTags must be lowercase kebab/dot/underscore tags; intentExamples must be short representative requests.",
    ].join("\n"),
    messages: [{
      role: "user" as const,
      content: JSON.stringify({
        task: "Complete the declaration fields for this Skill using only evidence in the package.",
        package: { name: inspection.name, description: inspection.description, files: inspection.files, instructions },
        deterministicBaseline: baseline,
        outputShape: {
          schema: "agentloop.skillDeclaration/v1",
          identity: { name: inspection.name, description: inspection.description },
          activation: { semanticTags: [], intentExamples: [] },
          workflow: { roles: [], artifactKinds: [], sourceKinds: [], qaKinds: [], requiredSkills: [] },
        },
      }),
    }],
    tools: [],
    maxOutputTokens: 2048,
  };
}

function parseModelDeclaration(content: string, baseline: SkillDeclaration): SkillDeclaration {
  const trimmed = content.trim().replace(/^~~~(?:json)?\s*/u, "").replace(/\s*~~~$/u, "");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("skill_metadata_model_json_invalid");
    value = JSON.parse(trimmed.slice(start, end + 1));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("skill_metadata_model_object_invalid");
  const candidate = value as Record<string, unknown>;
  const merged = {
    ...candidate,
    identity: baseline.identity,
    ...(candidate.execution === undefined && baseline.execution === undefined ? {} : {
      execution: candidate.execution ?? baseline.execution,
    }),
    ...(candidate.compatibility === undefined && baseline.compatibility === undefined ? {} : {
      compatibility: candidate.compatibility ?? baseline.compatibility,
    }),
  };
  return parseSkillDeclaration(merged);
}

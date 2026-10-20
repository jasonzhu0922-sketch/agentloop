import type { PlanningToolSummary, RequiredCapabilityReference } from "./contracts.ts";
import { buildSkillReferenceMap, type SkillIdentity } from "../skills/skill-identity.ts";

/** Supply userInput for model responses; persisted requirements have already passed that grounding check. */
export function parseRequiredCapabilityReferences(value: unknown, userInput?: string): RequiredCapabilityReference[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const references = new Map<string, RequiredCapabilityReference>();
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const { kind, reference } = item as Record<string, unknown>;
    if (kind !== "skill" && kind !== "tool_source" && kind !== "tool") return undefined;
    if (typeof reference !== "string" || !reference.trim() || reference.length > 200) return undefined;
    // A model may recognize an unavailable name, but cannot invent a new
    // mandatory resource that the user never named.
    const normalized = reference.trim();
    if (userInput !== undefined && !userInput.includes(normalized)) return undefined;
    references.set(`${kind}:${normalized}`, { kind, reference: normalized });
  }
  return [...references.values()];
}

/** Resolve explicit requirements only against this Run's authorized catalog. */
export function resolveCapabilityRequirements(
  requirements: readonly RequiredCapabilityReference[],
  skills: readonly SkillIdentity[],
  tools: readonly PlanningToolSummary[],
): { missing: RequiredCapabilityReference[]; skillIds: string[]; toolSourceIds: string[] } {
  const skillsByReference = buildSkillReferenceMap(skills);
  const missing: RequiredCapabilityReference[] = [];
  const skillIds = new Set<string>();
  const toolSourceIds = new Set<string>();
  const requestedSourceIds = new Set(requirements.flatMap((requirement) => requirement.kind === "tool_source"
    ? tools.flatMap((tool) => tool.source !== undefined
      && [tool.source.id, ...(tool.source.aliases ?? [])].includes(requirement.reference)
      ? [tool.source.id] : [])
    : []));
  for (const requirement of requirements) {
    if (requirement.kind === "skill") {
      const skill = skillsByReference.get(requirement.reference);
      if (skill === undefined) missing.push(requirement);
      else skillIds.add(skill.id);
    } else if (requirement.kind === "tool_source") {
      const sourceIds = new Set(tools.flatMap((tool) => tool.source !== undefined
        && [tool.source.id, ...(tool.source.aliases ?? [])].includes(requirement.reference)
        ? [tool.source.id] : []));
      if (sourceIds.size !== 1) missing.push(requirement);
      else toolSourceIds.add([...sourceIds][0]!);
    } else {
      // Runtime names remain authoritative for invocation. Source-native names
      // resolve only through preserved provenance in the authorized catalog,
      // and must identify exactly one tool within explicitly requested sources.
      const exact = tools.find((tool) => tool.name === requirement.reference);
      const candidates = exact === undefined ? tools.filter((tool) => tool.source?.toolName === requirement.reference
        && (requestedSourceIds.size === 0 || requestedSourceIds.has(tool.source.id))) : [exact];
      const tool = candidates.length === 1 ? candidates[0] : undefined;
      if (tool === undefined) missing.push(requirement);
      else if (tool.source !== undefined) toolSourceIds.add(tool.source.id);
    }
  }
  return { missing, skillIds: [...skillIds], toolSourceIds: [...toolSourceIds] };
}

export function unavailableCapabilityOutput(missing: readonly RequiredCapabilityReference[], userInput: string): string {
  const chinese = /[\u3400-\u9fff]/u.test(userInput);
  const labels = chinese
    ? { skill: "Skill", tool_source: "MCP／工具来源", tool: "工具" }
    : { skill: "Skill", tool_source: "MCP / tool source", tool: "Tool" };
  return [
    chinese ? "任务未执行：当前 Runtime 缺少任务明确要求的能力。" : "Task not executed: this Runtime lacks explicitly required capabilities.",
    "",
    ...missing.map((item) => `- ${labels[item.kind]}: ${item.reference}`),
    "",
    chinese
      ? "未执行查询、生成文件或发布交付结果。请为当前 Runtime 配置上述能力，或选择具备这些能力的 Runtime 后重新运行。"
      : "No queries, files, or deliverables were produced. Configure these capabilities on this Runtime, or rerun on a Runtime that provides them.",
  ].join("\n");
}

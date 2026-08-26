import { notFound } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import { formatLoadedSkill } from "../skills/skill-context.ts";
import { buildSkillReferenceMap } from "../skills/skill-identity.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export const SKILL_LOADER_TOOL_NAME = "load_skill";

export function skillExecutionCwd(skill: PrivateSkill): string {
  return `@skills/${skill.name}`;
}

export function skillExecutionRootEnvName(skill: Pick<PrivateSkill, "name">): string {
  const normalized = skill.name.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase() || "ROOT";
  return `AGENTLOOP_SKILL_ROOT_${normalized}`;
}

export function createSkillLoader(skills: readonly PrivateSkill[]): RuntimeTool<unknown> {
  const byReference = buildSkillReferenceMap(skills);
  return {
    name: SKILL_LOADER_TOOL_NAME,
    description: [
      "Load the exact authorized private Skill version bound to the current Plan step.",
      "Use this before applying a Skill; its output injects the authoritative instructions and package-relative path base into the conversation.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } },
    },
    executionMode: "parallel",
    replaySafe: true,
    maxResultCharacters: 250_000,
    parse: (value) => ({ name: requireString(requireRecord(value).name, "name", { max: 80 }) }),
    execute: async (context, value) => {
      const skill = byReference.get((value as { name: string }).name);
      if (skill === undefined || !context.grant.allowedSkillIds.has(skill.id)) throw notFound("Skill");
      return formatLoadedSkill(skill, {
        executionCwd: skillExecutionCwd,
        executionRootEnvName: skillExecutionRootEnvName,
      });
    },
  };
}

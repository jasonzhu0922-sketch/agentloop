import type { PrivateSkill } from "./skill-service.ts";

export interface SkillContextOptions {
  readonly packageRoot?: (skill: PrivateSkill) => string;
  readonly executionCwd?: (skill: PrivateSkill) => string | undefined;
}

/**
 * Format the stable, low-token Skill catalog shown before a Skill is activated.
 *
 * Adapted from PI and OpenCode's progressive-disclosure contract: discovery
 * exposes identity, description, and location; the complete body is returned
 * only by load_skill.
 */
export function formatAvailableSkills(
  skills: readonly PrivateSkill[],
  options: SkillContextOptions = {},
): string {
  if (skills.length === 0) return "";
  return [
    "Skills provide specialized instructions and workflows for matching tasks.",
    "Use load_skill to load the exact body of a Skill before applying that Skill; do not load unrelated catalog entries.",
    "The content returned by load_skill is authoritative; do not reconstruct or expand it from the catalog.",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <id>${escapeXml(skill.id)}</id>`,
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <version>${skill.version}</version>`,
      `    <location>${escapeXml(skillLocation(skill, options))}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

/** Format the exact authorized Skill body returned by load_skill. */
export function formatLoadedSkill(
  skill: PrivateSkill,
  options: SkillContextOptions = {},
): string {
  const packageRoot = skill.package === undefined
    ? undefined
    : options.packageRoot?.(skill) ?? skill.package.root;
  const executionCwd = skill.package === undefined ? undefined : options.executionCwd?.(skill);
  const metadata = skill.package === undefined
    ? []
    : [
        "",
        `<skill_package${formatSourceAttributes(skill.package.url, skill.package.revision)} package_sha256="${escapeXml(skill.package.packageHash)}" read_only="true" />`,
        ...(executionCwd === undefined ? [] : [
          `Runtime execution cwd for this Skill: ${executionCwd}`,
          `When running package scripts with computer_run_command, set cwd to "${executionCwd}" and pass script paths relative to that Skill root.`,
        ]),
        `Base directory for this Skill: ${packageRoot}`,
        `Read-only package directory for this Skill: ${packageRoot}`,
        "Relative paths in this Skill are relative to the Skill root.",
        "Do not edit the installed Skill package; write task sources, work, QA evidence, and artifacts to the task workspace.",
      ];
  return [
    `<skill_content id="${escapeXml(skill.id)}" name="${escapeXml(skill.name)}" version="${skill.version}" sha256="${escapeXml(skill.contentHash)}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.instructions,
    ...metadata,
    "</skill_content>",
  ].join("\n");
}

function formatSourceAttributes(url: string | undefined, revision: string | undefined): string {
  if (url === undefined || revision === undefined) return "";
  return ` source_url="${escapeXml(url)}" source_revision="${escapeXml(revision)}"`;
}

function skillLocation(skill: PrivateSkill, options: SkillContextOptions): string {
  if (skill.package === undefined) return `private-skill:${skill.id}`;
  const root = options.packageRoot?.(skill) ?? skill.package.root;
  return `${root.replace(/[\\/]+$/, "")}/${skill.package.entrypointPath}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

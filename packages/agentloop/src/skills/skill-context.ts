import type { PrivateSkill } from "./skill-service.ts";

export interface SkillContextOptions {
  readonly packageRoot?: (skill: PrivateSkill) => string;
  readonly executionCwd?: (skill: PrivateSkill) => string | undefined;
  readonly executionRootEnvName?: (skill: PrivateSkill) => string | undefined;
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
    "AgentLoop executionProfiles are stable Runtime capability profiles; local_script means a Skill-bound leaf needs computer_run_command plus load_skill.",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <id>${escapeXml(skill.id)}</id>`,
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <version>${skill.version}</version>`,
      ...formatAgentLoopCatalog(skill),
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
  const executionRootEnvName = skill.package === undefined ? undefined : options.executionRootEnvName?.(skill);
  const metadata = skill.package === undefined
    ? []
    : [
        "",
        `<skill_package${formatSourceAttributes(skill.package.url, skill.package.revision)} package_sha256="${escapeXml(skill.package.packageHash)}" read_only="true" />`,
        ...(executionCwd === undefined ? [] : [
          `Runtime execution cwd for this Skill: ${executionCwd}`,
          `The ${executionCwd} token is a Runtime command-root alias, not an operating-system path.`,
          `For read-only Skill reference files, use ${executionCwd}/... paths with computer_read_file, computer_list_directory, computer_find_files, or computer_search_text.`,
          `Use ${executionCwd} only as computer_run_command.cwd. Do not write ${executionCwd}/... into generated scripts, config files, or ordinary command arguments.`,
          `When running package scripts with computer_run_command, set cwd to "${executionCwd}" and pass script paths relative to that Skill root.`,
          "If a package script needs task inputs, outputs, workspaces, QA directories, or generated artifacts, pass absolute paths under the execution_context.workspace.root value from the current Runtime context.",
          `Do not pass relative writable task paths such as decks/my-deck, out.pptx, renders, or review while cwd is ${executionCwd}; those paths resolve inside the read-only Skill package.`,
        ]),
        ...(executionRootEnvName === undefined ? [] : [
          `Script-readable Skill root environment variable: ${executionRootEnvName}`,
          `Generated scripts that need read-only Skill assets should read process.env.${executionRootEnvName} / os.environ["${executionRootEnvName}"] and join package-relative asset paths from there.`,
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
    ...metadata,
    "",
    skill.instructions,
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

function formatAgentLoopCatalog(skill: PrivateSkill): string[] {
  const metadata = skill.agentLoop;
  if (metadata === undefined) return [];
  const attributes = [
    `roles="${escapeXml(metadata.roles.join(","))}"`,
    `artifact_kinds="${escapeXml(metadata.artifactKinds.join(","))}"`,
    `source_kinds="${escapeXml(metadata.sourceKinds.join(","))}"`,
    `qa_kinds="${escapeXml(metadata.qaKinds.join(","))}"`,
    ...(metadata.executionProfiles === undefined
      ? []
      : [`execution_profiles="${escapeXml(metadata.executionProfiles.join(","))}"`]),
  ];
  return [
    `    <agentloop ${attributes.join(" ")} />`,
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

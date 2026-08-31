import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Skill directories bundled with the publishable AgentLoop Skills package.
 */
export function bundledSkillDirectories(): readonly string[] {
  return [resolve(moduleDirectory, "..", "skills")];
}

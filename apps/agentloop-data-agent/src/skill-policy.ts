import { readSkillExecutionManifest, type PrivateSkill, type ToolExecutionPlugin } from "@zhujun/agentloop";
import { posix } from "node:path";

/** Host-authorized command scope follows the fixed package's execution manifest. */
export async function fixedSkillExecutionPolicy(skill: PrivateSkill, fileSkills: readonly PrivateSkill[] = []): Promise<ToolExecutionPlugin> {
  if (!skill.package) throw new Error("The fixed data Skill must be a package");
  const entries = await readSkillExecutionManifest(skill.package.root);
  const root = `@skills/${skill.name}`;
  const fileRoots = new Set(fileSkills.map(item => `@skills/${item.name}`));
  return {
    id: "data-agent.fixed-skill", version: "1",
    evaluate({ tool, input, context }) {
      const value = input as { command?: string; args?: string[]; cwd?: string; path?: string };
      if (tool.name === "computer_run_command") {
        if (value.cwd === root) {
          const allowed = entries.some(entry => entry.command === value.command && value.args?.[0] === entry.script);
          if (!allowed) return { decision: "deny", code: "FIXED_SKILL_COMMAND_REQUIRED", reason: "data-analysis 只执行声明的查询入口。" };
          const formatIndex = value.args?.indexOf("--format") ?? -1;
          const markdownExport = value.args?.[0] === "scripts/file_export.py" && formatIndex >= 0
            && value.args?.[formatIndex + 1] === "markdown";
          if (value.args?.[0] === "scripts/file_export.py" && !markdownExport
            && !fileSkills.some(item => context.grant.skillExecutionRoots.some(grant => grant.skillId === item.id))) {
            return { decision: "deny", code: "FILE_SKILL_REQUIRED", reason: "只有明确的文件交付步骤可以运行固定生成器。" };
          }
          return { decision: "allow" };
        }
        return { decision: "deny", code: "FILE_SCRIPT_REQUIRED", reason: "文件导出只运行 data-analysis 清单中声明的固定生成器。" };
      }
      if (typeof value.path === "string" && value.path.startsWith("@skills")) {
        const path = posix.normalize(value.path.replaceAll("\\", "/"));
        if (path === `${root}/SKILL.md` || path.startsWith(`${root}/references/`) || path === `${root}/agentloop.executors.json`) return { decision: "allow" };
        if ([...fileRoots].some(fileRoot => path === fileRoot || path.startsWith(`${fileRoot}/`))) {
          return { decision: "allow" };
        }
        return { decision: "deny", code: "SKILL_PRIVATE_FILE", reason: "连接配置和程序内部文件由执行器读取，不作为模型输入。" };
      }
      return { decision: "allow" };
    },
  };
}

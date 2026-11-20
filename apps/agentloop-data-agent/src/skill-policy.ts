import { readSkillExecutionManifest, type PrivateSkill, type ToolExecutionPlugin } from "@zhujun/agentloop";
import { posix } from "node:path";

/** Host-authorized command scope follows the fixed package's execution manifest. */
export async function fixedSkillExecutionPolicy(skill: PrivateSkill): Promise<ToolExecutionPlugin> {
  if (!skill.package) throw new Error("The fixed data Skill must be a package");
  const entries = await readSkillExecutionManifest(skill.package.root);
  const root = `@skills/${skill.name}`;
  return {
    id: "data-agent.fixed-skill", version: "1",
    evaluate({ tool, input }) {
      const value = input as { command?: string; args?: string[]; cwd?: string; path?: string };
      if (tool.name === "computer_run_command") {
        const allowed = value.cwd === root && entries.some(entry => entry.command === value.command && value.args?.[0] === entry.script);
        return allowed ? { decision: "allow" } : { decision: "deny", code: "FIXED_SKILL_COMMAND_REQUIRED", reason: "本应用只执行固定 Skill 声明的查询入口。" };
      }
      if (typeof value.path === "string" && value.path.startsWith("@skills")) {
        const path = posix.normalize(value.path.replaceAll("\\", "/"));
        if (path === `${root}/SKILL.md` || path.startsWith(`${root}/references/`) || path === `${root}/agentloop.executors.json`) return { decision: "allow" };
        return { decision: "deny", code: "SKILL_PRIVATE_FILE", reason: "连接配置和程序内部文件由执行器读取，不作为模型输入。" };
      }
      return { decision: "allow" };
    },
  };
}

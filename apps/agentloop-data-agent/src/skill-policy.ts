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
        if (!allowed) return { decision: "deny", code: "FIXED_SKILL_COMMAND_REQUIRED", reason: "本应用只执行固定 Skill 声明的查询入口。" };
        // A business SQL call is the terminal edge of the semantic plan. The
        // Python gateway validates the plan contents; this host policy makes
        // it impossible for the model to omit that edge accidentally. Entity
        // resolution and metadata/probe actions remain available beforehand.
        const args = value.args ?? [];
        if (args[1] === "execute") {
          const hasPlanFile = args.includes("--query-plan");
          const requestIndex = args.indexOf("--request-json");
          let hasInlinePlan = false;
          let hasWorkspaceRequest = false;
          if (requestIndex >= 0 && typeof args[requestIndex + 1] === "string") {
            const requestValue = args[requestIndex + 1] as string;
            hasWorkspaceRequest = requestValue.startsWith("@workspace/") || requestValue.startsWith("@/workspace/");
            try {
              const request = JSON.parse(requestValue) as Record<string, unknown>;
              hasInlinePlan = request.query_plan !== undefined && request.query_plan !== null;
            } catch {
              // Workspace request artifacts are parsed and validated by the
              // Skill script. Keep the host policy focused on command scope;
              // inline malformed JSON still fails closed here.
            }
          }
          if (!hasPlanFile && !hasInlinePlan && !hasWorkspaceRequest) {
            return { decision: "deny", code: "SEMANTIC_QUERY_PLAN_REQUIRED", reason: "业务 SQL 必须携带 get-query-context 生成并补充后的 query_plan。" };
          }
        }
        return { decision: "allow" };
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

import type { ToolExecutionPlugin, ToolExecutionPluginDecision } from "./tool-execution-plugin.ts";

const BLOCKED_COMMANDS = new Set([
  "apt", "apt-get", "brew", "chmod", "chown", "dd", "kill", "killall", "mkfs", "mount", "npm", "pip", "pip3",
  "pkill", "reboot", "rm", "rmdir", "service", "shutdown", "sudo", "su", "systemctl", "umount", "wget",
]);

const INTERPRETER_INLINE_FLAGS = new Set(["-c", "-e", "-m"]);

/** Small, conservative first policy. It is intentionally replaceable. */
export class SimpleCommandSafetyPlugin implements ToolExecutionPlugin {
  readonly id = "agentloop.simpleCommandSafety";
  readonly version = "1";

  evaluate(input: Parameters<ToolExecutionPlugin["evaluate"]>[0]): ToolExecutionPluginDecision {
    if (input.tool.name !== "computer_run_command") return { decision: "allow" };
    const command = typeof input.input === "object" && input.input !== null
      ? (input.input as { command?: unknown }).command
      : undefined;
    const args = typeof input.input === "object" && input.input !== null
      ? (input.input as { args?: unknown }).args
      : undefined;
    if (typeof command !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      return { decision: "deny", code: "INVALID_COMMAND_SHAPE", reason: "Command safety policy could not validate the command shape", ruleId: "shape" };
    }
    const normalized = command.trim().toLowerCase();
    if (BLOCKED_COMMANDS.has(normalized)) {
      return { decision: "deny", code: "BLOCKED_COMMAND", reason: `Command ${normalized} is blocked by the default safety policy`, ruleId: "blocked-command" };
    }
    if (["node", "nodejs", "python", "python3", "perl", "ruby", "php", "bash", "sh", "zsh"].includes(normalized)
      && args.some((arg) => INTERPRETER_INLINE_FLAGS.has(arg))) {
      return { decision: "deny", code: "INLINE_INTERPRETER", reason: "Inline interpreter programs are blocked by the default safety policy", ruleId: "inline-interpreter" };
    }
    return { decision: "allow" };
  }
}

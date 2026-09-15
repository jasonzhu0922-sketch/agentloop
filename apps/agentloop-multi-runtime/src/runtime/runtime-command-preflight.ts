import { spawnSync } from "node:child_process";

const COMMAND_NAME = /^[a-zA-Z0-9._-]+$/;

export function requiredRuntimeCommands(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const commands = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  for (const command of commands) {
    if (!COMMAND_NAME.test(command)) throw new Error(`Invalid required Runtime command: ${command}`);
  }
  return [...new Set(commands)];
}

export function assertRequiredRuntimeCommands(commands: readonly string[]): void {
  for (const command of commands) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      const detail = result.error?.message ?? (result.stderr.trim() || `exit status ${result.status ?? "unknown"}`);
      throw new Error(`Required Runtime command is unavailable: ${command} (${detail})`);
    }
  }
}

import { colorizeTerminalLogLabel, colorizeTerminalLogLine, type TerminalLogColorOptions } from "@zhujun/agentloop";

/**
 * Formats one child Runtime event for the Local Runtime Agent process.  The
 * Agent may host several local Runtimes, so its process label alone is not a
 * sufficient execution identity in a shared development terminal.
 */
export function localRuntimeTerminalLogLine(runtimeId: string, line: string, options: TerminalLogColorOptions = {}): string {
  const label = colorizeTerminalLogLabel(`[local-runtime:${runtimeId}]`, runtimeId, options);
  return `${label} ${colorizeTerminalLogLine(line, options)}`;
}

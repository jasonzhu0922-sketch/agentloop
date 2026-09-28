import assert from "node:assert/strict";
import test from "node:test";
import { localRuntimeTerminalLogLine } from "../local-agent-runtime/src/observability/runtime-terminal-log.ts";

test("Local Runtime terminal logs retain the concrete child Runtime identity", () => {
  assert.equal(
    localRuntimeTerminalLogLine("local-runtime-research", "[agentloop] event=tool.completed tool=computer_run_command", { colorMode: "never" }),
    "[local-runtime:local-runtime-research] [agentloop] event=tool.completed tool=computer_run_command",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { colorizeTerminalLogLabel, colorizeTerminalLogLine, shouldUseTerminalLogColor } from "../src/runtime/terminal-log.ts";

test("terminal event logs use semantic colors when color is enabled", () => {
  assert.equal(
    colorizeTerminalLogLine("[agentloop] event=tool.failed tool=computer_run_command", { colorMode: "always" }),
    "[agentloop] \u001B[31mevent=tool.failed\u001B[0m tool=computer_run_command",
  );
  assert.equal(
    colorizeTerminalLogLine("[agentloop] event=step.completed step=2", { colorMode: "always" }),
    "[agentloop] \u001B[32mevent=step.completed\u001B[0m step=2",
  );
  assert.equal(
    colorizeTerminalLogLine("[agentloop] event=model.request.started step=2", { colorMode: "always" }),
    "[agentloop] \u001B[36mevent=model.request.started\u001B[0m step=2",
  );
  assert.equal(
    colorizeTerminalLogLine("[agentloop] event=skill.activated skill=steel-market-analysis", { colorMode: "always" }),
    "[agentloop] \u001B[35mevent=skill.activated\u001B[0m skill=steel-market-analysis",
  );
  assert.equal(colorizeTerminalLogLabel("[general-01]", "general-01", { colorMode: "always" }), "\u001B[34m[general-01]\u001B[0m");
  assert.equal(colorizeTerminalLogLabel("[general-02]", "general-02", { colorMode: "always" }), "\u001B[96m[general-02]\u001B[0m");
});

test("terminal event logs preserve raw lines for redirected output and NO_COLOR", () => {
  const line = "[agentloop] event=tool.failed tool=computer_run_command";
  assert.equal(colorizeTerminalLogLine(line, { isTTY: false }), line);
  assert.equal(colorizeTerminalLogLine(line, { colorMode: "always", noColor: "1" }), line);
  assert.equal(colorizeTerminalLogLabel("[general-01]", "general-01", { colorMode: "always", noColor: "1" }), "[general-01]");
  assert.equal(colorizeTerminalLogLine(line, { isTTY: true, noColor: "1" }), line);
  assert.equal(shouldUseTerminalLogColor({ colorMode: "never", isTTY: true }), false);
});

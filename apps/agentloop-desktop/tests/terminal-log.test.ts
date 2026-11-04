import assert from "node:assert/strict";
import test from "node:test";
import { formatDesktopTerminalLog } from "../src/main.ts";

test("Desktop terminal output uses Multi-Runtime event colors without changing redirected logs", () => {
  const entry = "[agentloop] event=tool.failed tool=computer_run_command";
  const timestamp = "2026-11-04T00:00:00.000Z";
  const plain = `[AgentLoop Desktop] ${timestamp} ${entry}`;
  const colored = formatDesktopTerminalLog(entry, timestamp, { isTTY: true });
  assert.match(colored, /\u001b\[31mevent=tool\.failed\u001b\[0m/);
  assert.equal(colored.replace(/\u001b\[\d+m/g, ""), plain);
  assert.equal(formatDesktopTerminalLog(entry, timestamp, { isTTY: false }), plain);
  assert.equal(formatDesktopTerminalLog(entry, timestamp, { colorMode: "always", noColor: "1" }), plain);
  assert.match(formatDesktopTerminalLog(entry, timestamp, { colorMode: "always", isTTY: false }), /\u001b\[31m/);
});

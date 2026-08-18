import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readMaskedSecret, supportsMaskedSecretInput } from "../src/tui/secret-input.ts";

test("masked TTY password input resumes stdin after raw mode and never echoes the secret", async () => {
  const input = new FakeSecretInput();
  const output = new FakeSecretOutput();
  assert.equal(supportsMaskedSecretInput(input, output), true);

  const secret = readMaskedSecret(input, output, "密码: ");
  assert.deepEqual(input.rawModes, [true]);
  assert.equal(input.resumeCalls, 1);
  input.emit("keypress", "s", { name: "s" });
  input.emit("keypress", "e", { name: "e" });
  input.emit("keypress", "c", { name: "c" });
  input.emit("keypress", "r", { name: "r" });
  input.emit("keypress", "e", { name: "e" });
  input.emit("keypress", "t", { name: "t" });
  input.emit("keypress", "\r", { name: "return" });

  assert.equal(await secret, "secret");
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(output.text, "密码: ******\n");
  assert.doesNotMatch(output.text, /secret/);
});

class FakeSecretInput extends EventEmitter {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];
  resumeCalls = 0;

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }

  resume(): void {
    this.resumeCalls += 1;
  }
}

class FakeSecretOutput {
  readonly isTTY = true;
  text = "";

  write(value: string): void {
    this.text += value;
  }
}

import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";

export interface MaskedSecretInput {
  readonly isTTY?: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  on(event: "keypress", listener: MaskedKeypressListener): unknown;
  off(event: "keypress", listener: MaskedKeypressListener): unknown;
}

export interface MaskedSecretOutput {
  readonly isTTY?: boolean;
  write(value: string): unknown;
}

type MaskedKeypressListener = (
  character: string | undefined,
  key: { name?: string; ctrl?: boolean },
) => void;

export function supportsMaskedSecretInput(
  input: Pick<MaskedSecretInput, "isTTY" | "setRawMode">,
  output: Pick<MaskedSecretOutput, "isTTY">,
): boolean {
  return input.isTTY === true && output.isTTY === true && typeof input.setRawMode === "function";
}

/**
 * Reads a terminal secret without echoing its characters. The caller owns any
 * surrounding readline Interface and should resume it after this Promise
 * settles. This function resumes the underlying stream after raw mode is set:
 * readline.pause() pauses that stream as well, so omitting resume would leave
 * the returned Promise permanently pending.
 */
export function readMaskedSecret(
  input: MaskedSecretInput,
  output: MaskedSecretOutput,
  prompt: string,
): Promise<string> {
  output.write(prompt);
  emitKeypressEvents(input as unknown as NodeJS.ReadStream);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onKeypress: MaskedKeypressListener = (character, key) => {
      if (key.ctrl === true && key.name === "c") return finish(new Error("TUI closed"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      if (key.ctrl !== true && character !== undefined && character >= " ") {
        value += character;
        output.write("*");
      }
    };
    input.on("keypress", onKeypress);
    input.setRawMode(true);
    input.resume();
  });
}

/**
 * Node raw mode is not sufficient to suppress ECHO on every POSIX TTY.
 * Disable the terminal driver's ECHO flag explicitly before accepting a
 * password and restore it in the caller's finally block.
 */
export async function setTerminalEcho(enabled: boolean): Promise<void> {
  if (process.platform === "win32") return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("stty", [enabled ? "echo" : "-echo"], {
      stdio: ["inherit", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unable to ${enabled ? "restore" : "disable"} terminal echo${stderr.length === 0 ? "" : `: ${stderr.trim()}`}`));
    });
  });
}

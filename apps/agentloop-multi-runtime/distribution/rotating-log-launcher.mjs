import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOG_ROTATION_BYTES = 20 * 1024 * 1024;

/**
 * A sequential file sink that keeps the active log at `filePath` and moves
 * full files to `filePath.1`, `filePath.2`, ... . Writes are split at the
 * byte boundary, so one unusually large stdout chunk cannot exceed the limit.
 */
export class RotatingLogWritable extends Writable {
  #filePath;
  #maxBytes;
  #handle;
  #size = 0;
  #nextArchive = 1;

  constructor(filePath, maxBytes = LOG_ROTATION_BYTES) {
    super();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
    this.#filePath = filePath;
    this.#maxBytes = maxBytes;
  }

  async _construct(callback) {
    try {
      await mkdir(dirname(this.#filePath), { recursive: true });
      this.#nextArchive = await nextArchiveNumber(this.#filePath);
      const existing = await stat(this.#filePath).catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
      this.#handle = await open(this.#filePath, "a", 0o600);
      this.#size = existing?.size ?? 0;
      if (this.#size >= this.#maxBytes) await this.#rotate();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  async _write(chunk, encoding, callback) {
    try {
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      while (buffer.length > 0) {
        if (this.#size >= this.#maxBytes) await this.#rotate();
        const remaining = this.#maxBytes - this.#size;
        const part = buffer.subarray(0, remaining);
        await this.#handle.write(part);
        this.#size += part.length;
        buffer = buffer.subarray(part.length);
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  async _final(callback) {
    try {
      const handle = this.#handle;
      this.#handle = undefined;
      await handle?.close();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  async _destroy(error, callback) {
    try {
      const handle = this.#handle;
      this.#handle = undefined;
      await handle?.close();
    } catch (closeError) {
      error ??= closeError;
    }
    callback(error);
  }

  async #rotate() {
    await this.#handle?.close();
    this.#handle = undefined;
    await rename(this.#filePath, `${this.#filePath}.${this.#nextArchive++}`);
    this.#handle = await open(this.#filePath, "a", 0o600);
    this.#size = 0;
  }
}

export async function runRotatingLogLauncher({ command, args = [], logRoot, stdoutName = "agent.out.log", stderrName = "agent.err.log", maxBytes = LOG_ROTATION_BYTES }) {
  if (!Array.isArray(command) || command.length === 0 || typeof logRoot !== "string" || logRoot.trim() === "") {
    throw new TypeError("command and logRoot are required");
  }
  const child = spawn(command[0], [...command.slice(1), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = new RotatingLogWritable(join(logRoot, stdoutName), maxBytes);
  const stderr = new RotatingLogWritable(join(logRoot, stderrName), maxBytes);
  const streams = Promise.all([pipeline(child.stdout, stdout), pipeline(child.stderr, stderr)]);
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  const result = await exit;
  await streams;
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const separator = process.argv.indexOf("--");
  if (separator < 0 || separator === process.argv.length - 1) throw new Error("Usage: rotating-log-launcher.mjs --log-root <directory> -- <command> [args...]");
  const options = process.argv.slice(2, separator);
  const logRoot = option(options, "--log-root");
  const result = await runRotatingLogLauncher({ command: process.argv.slice(separator + 1), logRoot });
  if (result.signal !== null) process.kill(process.pid, result.signal);
  process.exit(result.code);
}

function option(options, name) {
  const index = options.indexOf(name);
  const value = index < 0 ? undefined : options[index + 1];
  if (value === undefined || value.trim() === "") throw new Error(`${name} requires a value`);
  return value;
}

async function nextArchiveNumber(filePath) {
  const directory = dirname(filePath);
  const prefix = `${basename(filePath)}.`;
  const entries = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let max = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const number = Number(entry.slice(prefix.length));
    if (Number.isSafeInteger(number) && number > max) max = number;
  }
  return max + 1;
}

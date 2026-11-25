import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type { RuntimeRedisPort } from "./redis-runtime-state-store.ts";

class RedisCommandError extends Error {}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
/** Small RESP2 transport; host applications can alternatively supply their own Redis port. */
export class RuntimeRedisClient implements RuntimeRedisPort {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private pending: Pending[] = [];
  private buffer = Buffer.alloc(0);
  private closed = false;
  private failed?: Error;
  private readonly target: URL;
  private readonly timeoutMs: number;
  constructor(url: string, timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
    this.target = new URL(url);
    if (!["redis:", "rediss:"].includes(this.target.protocol) || !this.target.hostname) throw new TypeError("Invalid Runtime Redis URL");
    if (!/^\/\d*$/.test(this.target.pathname || "/")) throw new TypeError("Invalid Redis database number");
  }
  private async open() {
    if (this.closed) throw new Error("Runtime Redis client is closed");
    if (this.failed) throw this.failed;
    if (this.connecting) return await this.connecting;
    if (this.socket) return;
    this.connecting = (async () => {
      const options = { host: this.target.hostname, port: Number(this.target.port || 6379) };
      const socket = this.target.protocol === "rediss:" ? connectTls({ ...options, servername: this.target.hostname }) : connectTcp(options);
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on("data", data => {
        this.buffer = Buffer.concat([this.buffer, typeof data === "string" ? Buffer.from(data) : data]);
        try {
          for (;;) {
            const result = parse(this.buffer, 0);
            if (!result) break;
            this.buffer = this.buffer.subarray(result.end);
            const pending = this.pending.shift();
            if (!pending) throw new Error("Unexpected Redis response");
            if (result.value instanceof RedisCommandError) pending.reject(result.value); else pending.resolve(result.value);
          }
        } catch (error) { this.fail(error as Error); }
      });
      socket.on("error", error => this.fail(error));
      socket.on("close", () => this.fail(new Error("Runtime Redis connection closed")));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { const error = new Error("Runtime Redis connection timed out"); this.fail(error); reject(error); }, this.timeoutMs);
        const ready = this.target.protocol === "rediss:" ? "secureConnect" : "connect";
        const done = () => { clearTimeout(timer); socket.off("error", reject); resolve(); };
        socket.once(ready, done);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
      });
      if (this.target.password) await this.command(["AUTH", ...(this.target.username ? [decodeURIComponent(this.target.username)] : []), decodeURIComponent(this.target.password)]);
      const db = Number(this.target.pathname.slice(1) || 0);
      if (db) await this.command(["SELECT", String(db)]);
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private fail(error: Error) {
    this.failed ??= error;
    for (const pending of this.pending.splice(0)) pending.reject(error);
    this.socket?.destroy();
  }
  private async command(args: string[]): Promise<unknown> {
    if (this.failed) throw this.failed;
    if (this.pending.length >= 1000) throw new Error("Runtime Redis command queue is full");
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Runtime Redis command timed out; receipt reconciliation required")), this.timeoutMs);
      this.pending.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      const chunks = [Buffer.from(`*${args.length}\r\n`)];
      for (const arg of args) { const data = Buffer.from(arg); chunks.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from("\r\n")); }
      this.socket!.write(Buffer.concat(chunks));
    });
  }
  async sendCommand(args: string[]) { await this.open(); return await this.command(args); }
  async close() { this.closed = true; this.fail(new Error("Runtime Redis client closed")); }
}

function parse(buffer: Buffer, offset: number): { value: unknown; end: number } | undefined {
  if (offset >= buffer.length) return;
  const newline = buffer.indexOf("\r\n", offset);
  if (newline < 0) return;
  const type = String.fromCharCode(buffer[offset]), text = buffer.toString("utf8", offset + 1, newline), end = newline + 2;
  if (type === "+") return { value: text, end };
  if (type === "-") return { value: new RedisCommandError(text), end };
  if (type === ":") return { value: Number(text), end };
  const length = Number(text);
  if (!Number.isSafeInteger(length) || length < -1) throw new Error("Invalid Redis response length");
  if (type === "$") {
    if (length === -1) return { value: null, end };
    if (buffer.length < end + length + 2) return;
    if (buffer.toString("ascii", end + length, end + length + 2) !== "\r\n") throw new Error("Invalid Redis bulk response");
    return { value: buffer.toString("utf8", end, end + length), end: end + length + 2 };
  }
  if (type === "*") {
    if (length === -1) return { value: null, end };
    const values: unknown[] = []; let cursor = end;
    for (let i = 0; i < length; i++) { const item = parse(buffer, cursor); if (!item) return; values.push(item.value); cursor = item.end; }
    return { value: values, end: cursor };
  }
  throw new Error("Unsupported Redis response type");
}

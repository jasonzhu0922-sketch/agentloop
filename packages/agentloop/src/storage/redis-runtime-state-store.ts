import type { RuntimeStateCommit, RuntimeStateStore } from "./runtime-state-store.ts";

export interface RuntimeRedisPort {
  sendCommand(args: string[]): Promise<unknown>;
  close(): Promise<void>;
}
const APPEND = `
local previous=redis.call('HGET',KEYS[2],ARGV[1])
if previous then
  if previous ~= ARGV[2]..':'..ARGV[4] then return redis.error_reply('STATE_COMMAND_CONFLICT') end
  return tonumber(ARGV[2])
end
local version=tonumber(redis.call('GET',KEYS[3]) or '0')
if version+1 ~= tonumber(ARGV[2]) then return redis.error_reply('STATE_VERSION_CONFLICT') end
local size=tonumber(redis.call('GET',KEYS[4]) or '0')
if size+string.len(ARGV[3]) > tonumber(ARGV[5]) then return redis.error_reply('STATE_CAPACITY_EXCEEDED') end
redis.call('XADD',KEYS[1],ARGV[2]..'-0','record',ARGV[3])
redis.call('HSET',KEYS[2],ARGV[1],ARGV[2]..':'..ARGV[4])
redis.call('SET',KEYS[3],ARGV[2])
redis.call('INCRBY',KEYS[4],string.len(ARGV[3]))
return tonumber(ARGV[2])`;

/** Legacy SQLite-changeset journal, not native queryable Runtime state. No writer lease. */
export class RedisRuntimeStateStore implements RuntimeStateStore {
  private readonly keys: string[];
  private readonly redis: RuntimeRedisPort;
  constructor(redis: RuntimeRedisPort, options: { prefix: string; maxBytes?: number }) {
    this.redis = redis;
    if (!/^[A-Za-z0-9:{}_-]{1,180}$/.test(options.prefix)) throw new Error("Invalid Runtime state namespace");
    this.keys = ["commits", "receipts", "version", "bytes"].map(name => `${options.prefix}:${name}`);
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024) throw new Error("Invalid Runtime state capacity");
  }
  private readonly maxBytes: number;
  async open() {
    const info = String(await this.redis.sendCommand(["INFO", "persistence"]));
    const config = await this.redis.sendCommand(["CONFIG", "GET", "appendfsync", "maxmemory-policy"]) as string[];
    const values = Object.fromEntries(Array.from({ length: config.length / 2 }, (_, i) => [config[2*i], config[2*i+1]]));
    if (!/^aof_enabled:1\r?$/m.test(info) || values.appendfsync !== "always" || values["maxmemory-policy"] !== "noeviction")
      throw new Error("Runtime Redis requires appendonly yes, appendfsync always and noeviction");
    // Lua runtime errors do not roll back earlier writes. Validate all owned key types
    // before any script can mutate them; these keys are private to this Runtime.
    for (let i = 0; i < this.keys.length; i++) {
      const type = await this.redis.sendCommand(["TYPE", this.keys[i]]);
      if (type !== "none" && type !== ["stream", "hash", "string", "string"][i]) throw new Error("Runtime Redis key type mismatch");
    }
  }
  async read(afterVersion: number, limit: number): Promise<readonly RuntimeStateCommit[]> {
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid Runtime journal cursor");
    const rows = await this.redis.sendCommand(["XRANGE", this.keys[0], `(${afterVersion}-0`, "+", "COUNT", String(limit)]) as [string, string[]][];
    return rows.map(([id, fields]) => {
      const record = JSON.parse(fields[fields.indexOf("record") + 1]) as RuntimeStateCommit;
      if (id !== `${record.version}-0`) throw new Error("Runtime journal version mismatch");
      return record;
    });
  }
  async append(commit: RuntimeStateCommit) {
    const payload = JSON.stringify(commit);
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error("Runtime transaction exceeds 16 MiB; store large results as files");
    await this.redis.sendCommand(["EVAL", APPEND, "4", ...this.keys, commit.id, String(commit.version), payload, commit.checksum, String(this.maxBytes)]);
  }
  async assertAdmissionCapacity() {
    const bytes = Number(await this.redis.sendCommand(["GET", this.keys[3]]) ?? 0);
    if (bytes >= this.maxBytes * 0.8) throw new Error("Runtime state capacity is low; archive/expand storage before accepting new Runs");
  }
  async receipt(id: string): Promise<number | undefined> {
    const value = await this.redis.sendCommand(["HGET", this.keys[1], id]);
    return value === null ? undefined : Number(String(value).split(":")[0]);
  }
  async close() { await this.redis.close(); }
}

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalRuntimeSecretStore } from "./local-runtime-configuration-store.ts";

interface EncryptedSecretDocument {
  readonly schema: "agentloop.localRuntimeSecret/v1";
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

/** Device-local encrypted persistence; secret values never enter Supervisor SQLite. */
export class EncryptedLocalRuntimeSecretStore implements LocalRuntimeSecretStore {
  private key?: Buffer;

  constructor(privateRoot: string) {
    this.root = resolve(privateRoot);
  }

  private readonly root: string;

  async write(values: Readonly<Record<string, string>>): Promise<string> {
    const id = `local_secret_${randomUUID()}`;
    await this.writeAt(id, values, true);
    return id;
  }

  /** Rotate a secret in place so credential references remain stable. */
  async replace(secretStorageKey: string, values: Readonly<Record<string, string>>): Promise<void> {
    await this.writeAt(secretStorageKey, values, false);
  }

  private async writeAt(secretStorageKey: string, values: Readonly<Record<string, string>>, exclusive: boolean): Promise<void> {
    const normalized = validateSecretValues(values);
    const key = await this.encryptionKey();
    const id = secretStorageKey;
    if (!/^local_secret_[0-9a-f-]{36}$/.test(id)) throw new Error("local_runtime_secret_key_invalid");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(normalized), "utf8"), cipher.final()]);
    const document: EncryptedSecretDocument = {
      schema: "agentloop.localRuntimeSecret/v1",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.${id}.${randomUUID()}.tmp`);
    const target = this.path(id);
    if (!exclusive) await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("local_runtime_secret_not_found");
      throw error;
    });
    await writeFile(temporary, JSON.stringify(document), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }

  async read(secretStorageKey: string): Promise<Readonly<Record<string, string>> | undefined> {
    const source = await readFile(this.path(secretStorageKey), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (source === undefined) return undefined;
    const document = parseDocument(source);
    const decipher = createDecipheriv("aes-256-gcm", await this.encryptionKey(), Buffer.from(document.iv, "base64"));
    decipher.setAuthTag(Buffer.from(document.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(document.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("local_runtime_secret_invalid");
    return validateSecretValues(parsed as Record<string, unknown>);
  }

  async remove(secretStorageKey: string): Promise<void> {
    await rm(this.path(secretStorageKey), { force: true });
  }

  async listKeys(): Promise<readonly string[]> {
    const entries = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return entries
      .filter((entry) => /^local_secret_[0-9a-f-]{36}\.json$/.test(entry))
      .map((entry) => entry.slice(0, -".json".length));
  }

  private async encryptionKey(): Promise<Buffer> {
    if (this.key !== undefined) return this.key;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "master.key");
    let key = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (key === undefined) {
      const candidate = randomBytes(32);
      const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return undefined;
        throw error;
      });
      if (handle !== undefined) {
        try { await handle.writeFile(candidate); } finally { await handle.close(); }
        key = candidate;
      } else key = await readFile(path);
    }
    if (key.length !== 32) throw new Error("local_runtime_secret_master_key_invalid");
    this.key = key;
    return key;
  }

  private path(secretStorageKey: string): string {
    if (!/^local_secret_[0-9a-f-]{36}$/.test(secretStorageKey)) throw new Error("local_runtime_secret_key_invalid");
    return join(this.root, `${secretStorageKey}.json`);
  }
}

function parseDocument(source: string): EncryptedSecretDocument {
  const value = JSON.parse(source) as Partial<EncryptedSecretDocument>;
  if (value.schema !== "agentloop.localRuntimeSecret/v1"
    || typeof value.iv !== "string"
    || typeof value.authTag !== "string"
    || typeof value.ciphertext !== "string") {
    throw new Error("local_runtime_secret_invalid");
  }
  return value as EncryptedSecretDocument;
}

function validateSecretValues(values: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const entries = Object.entries(values);
  if (entries.length < 1 || entries.length > 64) throw new Error("local_runtime_secret_invalid");
  const result: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.length < 1 || name.length > 200 || typeof value !== "string" || value.length < 1 || value.length > 100_000) {
      throw new Error("local_runtime_secret_invalid");
    }
    result[name] = value;
  }
  return result;
}

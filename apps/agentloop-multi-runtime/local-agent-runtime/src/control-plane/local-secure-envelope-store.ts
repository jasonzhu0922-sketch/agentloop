import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeviceCredentialEnvelope } from "../../../control-plane/contracts/index.ts";

type EncryptedRecord = { readonly nonce: string; readonly tag: string; readonly ciphertext: string };

/** Encrypted device-local envelope store. It never persists a Cloud credential or returns data to HTTP/RPC callers. */
export class LocalSecureEnvelopeStore {
  private readonly key: Buffer;
  private readonly path: string;
  public constructor(path: string, devicePrivateKey: string) {
    this.path = path;
    if (devicePrivateKey.trim() === "") throw new TypeError("device private key is required for secure envelope storage");
    this.key = createHash("sha256").update(devicePrivateKey).digest();
  }
  async put(envelope: DeviceCredentialEnvelope): Promise<void> {
    assertEnvelope(envelope);
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
    await this.write({ nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") });
  }
  async get(envelopeId: string, deviceId: string, now: () => number = Date.now): Promise<DeviceCredentialEnvelope | undefined> {
    try {
      const record = JSON.parse(await readFile(this.path, "utf8")) as EncryptedRecord;
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.nonce, "base64url"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
      const envelope = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64url")), decipher.final()]).toString("utf8")) as DeviceCredentialEnvelope;
      assertEnvelope(envelope);
      return envelope.envelopeId === envelopeId && envelope.deviceId === deviceId && envelope.expiresAt > now() ? envelope : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("local_credential_envelope_invalid"); }
  }
  private async write(record: EncryptedRecord): Promise<void> { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const pending = `${this.path}.tmp`; await writeFile(pending, JSON.stringify(record), { encoding: "utf8", mode: 0o600 }); await chmod(pending, 0o600); await rename(pending, this.path); await chmod(this.path, 0o600); }
}
function assertEnvelope(value: DeviceCredentialEnvelope): void { if (value.contractVersion !== "control-plane/v1" || !text(value.envelopeId) || !text(value.grantId) || !text(value.deviceId) || !text(value.bindingId) || !text(value.releaseId) || !/^[a-f0-9]{64}$/.test(value.contentHash) || !text(value.secretReferenceVersion) || !text(value.encryptedPayload) || !Number.isSafeInteger(value.expiresAt)) throw new TypeError("local_credential_envelope_invalid"); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }

import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import type { SqlConnection } from "@zhujun/agentloop";
import type { Principal } from "../auth/identity-service.ts";

const REGISTRATION_TOKEN_BYTES = 32;
const AGENT_TOKEN_BYTES = 32;
const LOCAL_SESSION_BYTES = 32;
const DEFAULT_LOCAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RegisteredDevice {
  readonly id: string;
  readonly displayName: string;
  readonly status: "active" | "revoked";
  readonly lastSeenAt?: number;
  readonly createdAt: number;
}

export interface RegisteredDeviceAgent extends RegisteredDevice {
  readonly agentToken: string;
}

export interface LocalDeviceSession {
  readonly token: string;
  readonly expiresAt: number;
  readonly deviceId: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
}

export interface AuthenticatedDeviceAgent {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
}

/** Device-auth persistence port consumed by HTTP and connection orchestration. */
export interface DeviceRepository {
  ready(): Promise<void>;
  issueRegistrationToken(principal: Principal): Promise<{ readonly token: string; readonly expiresAt: number }>;
  registerAgent(input: { readonly registrationToken: unknown; readonly displayName: unknown; readonly publicKey: unknown }): Promise<RegisteredDeviceAgent>;
  heartbeat(agentToken: unknown): Promise<RegisteredDevice>;
  authenticateAgent(agentToken: unknown): Promise<AuthenticatedDeviceAgent>;
  list(principal: Principal): Promise<readonly RegisteredDevice[]>;
  revoke(principal: Principal, deviceId: string): Promise<void>;
  issueLocalSession(principal: Principal, deviceId: string, ttlMs?: number): Promise<LocalDeviceSession>;
  authorizeLocalSession(agentToken: unknown, sessionToken: unknown): Promise<LocalDeviceSession>;
}

/** Cloud authority for a user-approved Local Runtime Agent registration. */
export class SqlDeviceRepository implements DeviceRepository {
  private readonly database: SqlConnection;
  private readonly registrationTtlMs: number;
  private readonly localSessionTtlMs: number;

  constructor(database: SqlConnection, registrationTtlMs = 5 * 60 * 1000, localSessionTtlMs = DEFAULT_LOCAL_SESSION_TTL_MS) {
    this.database = database;
    this.registrationTtlMs = registrationTtlMs;
    this.localSessionTtlMs = localSessionTtlMs;
  }

  async ready(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS mr_devices (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_devices_owner_idx ON mr_devices(tenant_id, owner_user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS mr_device_registration_tokens (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mr_device_agent_sessions (
        device_id TEXT PRIMARY KEY REFERENCES mr_devices(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mr_device_local_sessions (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES mr_devices(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_device_local_sessions_expiry_idx ON mr_device_local_sessions(expires_at);
    `);
  }

  async issueRegistrationToken(principal: Principal): Promise<{ readonly token: string; readonly expiresAt: number }> {
    await this.ready();
    const token = randomBytes(REGISTRATION_TOKEN_BYTES).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.registrationTtlMs;
    await this.database.prepare(`
      INSERT INTO mr_device_registration_tokens(id, tenant_id, owner_user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`device_registration_${randomUUID()}`, principal.tenantId, principal.userId, hashToken(token), expiresAt, now);
    return { token, expiresAt };
  }

  async registerAgent(input: { readonly registrationToken: unknown; readonly displayName: unknown; readonly publicKey: unknown }): Promise<RegisteredDeviceAgent> {
    await this.ready();
    const registrationToken = tokenValue(input.registrationToken, "registrationToken");
    const displayName = textValue(input.displayName, "displayName", 100);
    const publicKey = validEd25519PublicKey(input.publicKey);
    const now = Date.now();
    const agentToken = randomBytes(AGENT_TOKEN_BYTES).toString("base64url");
    return await this.database.transaction(async () => {
      const token = await this.database.prepare(`
        SELECT id, tenant_id, owner_user_id FROM mr_device_registration_tokens
        WHERE token_hash = ? AND expires_at > ?
      `).get(hashToken(registrationToken), now) as { id: string; tenant_id: string; owner_user_id: string } | undefined;
      if (token === undefined) throw new DeviceError(401, "registration_token_invalid", "Device registration authorization is invalid or expired");
      // Consume before creating the device: a token can never authorize a
      // second Agent, including after a network retry.
      await this.database.prepare("DELETE FROM mr_device_registration_tokens WHERE id = ?").run(token.id);
      const id = `device_${randomUUID()}`;
      await this.database.prepare(`
        INSERT INTO mr_devices(id, tenant_id, owner_user_id, display_name, public_key, status, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(id, token.tenant_id, token.owner_user_id, displayName, publicKey, now, now);
      await this.database.prepare(`INSERT INTO mr_device_agent_sessions(device_id, token_hash, created_at) VALUES (?, ?, ?)`)
        .run(id, hashToken(agentToken), now);
      return { id, displayName, status: "active", lastSeenAt: now, createdAt: now, agentToken };
    });
  }

  async heartbeat(agentToken: unknown): Promise<RegisteredDevice> {
    await this.ready();
    const row = await this.database.prepare(`
      SELECT d.id, d.display_name, d.status, d.created_at
      FROM mr_device_agent_sessions s JOIN mr_devices d ON d.id = s.device_id
      WHERE s.token_hash = ?
    `).get(hashToken(tokenValue(agentToken, "agentToken"))) as { id: string; display_name: string; status: "active" | "revoked"; created_at: number } | undefined;
    if (row === undefined || row.status !== "active") throw new DeviceError(401, "device_session_invalid", "Local Runtime Agent is not authorized");
    const now = Date.now();
    await this.database.prepare("UPDATE mr_devices SET last_seen_at = ? WHERE id = ?").run(now, row.id);
    return { id: row.id, displayName: row.display_name, status: row.status, lastSeenAt: now, createdAt: row.created_at };
  }

  async authenticateAgent(agentToken: unknown): Promise<AuthenticatedDeviceAgent> {
    await this.ready();
    const row = await this.database.prepare(`
      SELECT d.id AS device_id, d.tenant_id, d.owner_user_id
      FROM mr_device_agent_sessions s JOIN mr_devices d ON d.id = s.device_id
      WHERE s.token_hash = ? AND d.status = 'active'
    `).get(hashToken(tokenValue(agentToken, "agentToken"))) as {
      device_id: string; tenant_id: string; owner_user_id: string;
    } | undefined;
    if (row === undefined) throw new DeviceError(401, "device_session_invalid", "Local Runtime Agent is not authorized");
    await this.database.prepare("UPDATE mr_devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), row.device_id);
    return { deviceId: row.device_id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id };
  }

  async list(principal: Principal): Promise<readonly RegisteredDevice[]> {
    await this.ready();
    const rows = await this.database.prepare(`
      SELECT id, display_name, status, last_seen_at, created_at FROM mr_devices
      WHERE tenant_id = ? AND owner_user_id = ? ORDER BY created_at DESC
    `).all(principal.tenantId, principal.userId) as Array<{ id: string; display_name: string; status: "active" | "revoked"; last_seen_at: number | null; created_at: number }>;
    return rows.map((row) => ({ id: row.id, displayName: row.display_name, status: row.status, ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }), createdAt: row.created_at }));
  }

  async revoke(principal: Principal, deviceId: string): Promise<void> {
    await this.ready();
    const result = await this.database.prepare(`
      UPDATE mr_devices SET status = 'revoked' WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'active'
    `).run(deviceId, principal.tenantId, principal.userId);
    if (result.changes !== 1) throw new DeviceError(404, "device_not_found", "Device was not found");
    await this.database.prepare("DELETE FROM mr_device_agent_sessions WHERE device_id = ?").run(deviceId);
    await this.database.prepare("DELETE FROM mr_device_local_sessions WHERE device_id = ?").run(deviceId);
  }

  /**
   * Rotates the browser-to-local-Agent capability on login.  It is durable for
   * the same lifetime as a browser login, while the browser never receives
   * the long-lived device Agent credential.
   */
  async issueLocalSession(principal: Principal, deviceId: string, ttlMs = this.localSessionTtlMs): Promise<LocalDeviceSession> {
    await this.ready();
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("local_session_ttl_invalid");
    const token = randomBytes(LOCAL_SESSION_BYTES).toString("base64url");
    const now = Date.now();
    const expiresAt = now + ttlMs;
    return await this.database.transaction(async () => {
      const device = await this.database.prepare(`
        SELECT id FROM mr_devices WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'active'
      `).get(deviceId, principal.tenantId, principal.userId) as { id: string } | undefined;
      if (device === undefined) throw new DeviceError(404, "device_not_found", "Device was not found");
      // A new authenticated login becomes the single current browser binding
      // for this Agent. Old tabs receive 401 and renew through the Router.
      await this.database.prepare("DELETE FROM mr_device_local_sessions WHERE device_id = ?").run(device.id);
      await this.database.prepare(`
        INSERT INTO mr_device_local_sessions(id, device_id, tenant_id, owner_user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`local_session_${randomUUID()}`, device.id, principal.tenantId, principal.userId, hashToken(token), expiresAt, now);
      return { token, expiresAt, deviceId: device.id, tenantId: principal.tenantId, ownerUserId: principal.userId };
    });
  }

  /** Validates a browser capability through the Agent's long-lived device credential. */
  async authorizeLocalSession(agentToken: unknown, sessionToken: unknown): Promise<LocalDeviceSession> {
    await this.ready();
    const now = Date.now();
    const row = await this.database.prepare(`
      SELECT d.id AS device_id, s.tenant_id, s.owner_user_id, s.expires_at
      FROM mr_device_agent_sessions a
      JOIN mr_devices d ON d.id = a.device_id
      JOIN mr_device_local_sessions s ON s.device_id = d.id
      WHERE a.token_hash = ? AND d.status = 'active' AND s.token_hash = ? AND s.expires_at > ?
    `).get(hashToken(tokenValue(agentToken, "agentToken")), hashToken(tokenValue(sessionToken, "sessionToken")), now) as { device_id: string; tenant_id: string; owner_user_id: string; expires_at: number } | undefined;
    if (row === undefined) throw new DeviceError(401, "local_session_invalid", "Local Runtime session is invalid or expired");
    return { token: tokenValue(sessionToken, "sessionToken"), expiresAt: row.expires_at, deviceId: row.device_id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id };
  }
}

export class DeviceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function tokenValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(value)) throw new DeviceError(400, "invalid_device_token", `${label} is invalid`);
  return value;
}
function textValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maximum || value.includes("\0")) throw new DeviceError(400, "invalid_device_registration", `${label} is invalid`);
  return value.trim();
}
function validEd25519PublicKey(value: unknown): string {
  const pem = textValue(value, "publicKey", 8_000);
  try {
    if (createPublicKey(pem).asymmetricKeyType !== "ed25519") throw new Error("not_ed25519");
    return pem;
  } catch {
    throw new DeviceError(400, "invalid_device_registration", "publicKey must be an Ed25519 public key");
  }
}

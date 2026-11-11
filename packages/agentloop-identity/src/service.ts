import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { type SqlConnection } from "@zhujun/agentloop";
import { TIDB_IDENTITY_SCHEMA_SQL } from "./tidb-schema.ts";

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TOKEN_BYTES = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDENTITY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mr_identity_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mr_identity_tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mr_identity_profiles (
    user_id TEXT PRIMARY KEY REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mr_identity_memberships (
    tenant_id TEXT NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(tenant_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS mr_identity_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mr_identity_sessions_user_idx ON mr_identity_sessions(user_id);
  CREATE INDEX IF NOT EXISTS mr_identity_sessions_expiry_idx ON mr_identity_sessions(expires_at);
`;

export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly displayName?: string;
}

export interface IdentitySession {
  readonly token: string;
  readonly expiresAt: number;
  readonly principal: Principal;
}

export class IdentityError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Shared account authority and initial personal tenant; independent of any Runtime host. */
export class IdentityService {
  private readonly database: SqlConnection;
  private readonly sessionTtlMs: number;

  constructor(database: SqlConnection, sessionTtlMs = 7 * 24 * 60 * 60 * 1000, private readonly initialize?: () => Promise<void>) {
    this.database = database;
    this.sessionTtlMs = sessionTtlMs;
  }

  async ready(): Promise<void> {
    await (this.initialize?.() ?? installIdentitySchema(this.database));
  }

  async register(emailInput: unknown, passwordInput: unknown, displayNameInput?: unknown): Promise<IdentitySession> {
    await this.ready();
    const email = normalizeEmail(emailInput);
    const password = validatePassword(passwordInput);
    const displayName = validateDisplayName(displayNameInput);
    const passwordHash = await hashPassword(password);
    const userId = `user_${randomUUID()}`;
    const tenantId = `tenant_${randomUUID()}`;
    const now = Date.now();
    try {
      await this.database.transaction(async () => {
        await this.database.prepare("INSERT INTO mr_identity_users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .run(userId, email, passwordHash, now);
        if (displayName !== undefined) await this.database.prepare("INSERT INTO mr_identity_profiles(user_id, display_name) VALUES (?, ?)").run(userId, displayName);
        await this.database.prepare("INSERT INTO mr_identity_tenants(id, name, created_at) VALUES (?, ?, ?)")
          .run(tenantId, `${email} workspace`, now);
        await this.database.prepare("INSERT INTO mr_identity_memberships(tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
          .run(tenantId, userId, now);
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new IdentityError(409, "email_registered", "Email is already registered");
      throw error;
    }
    return this.issueSession({ userId, tenantId, email, ...(displayName === undefined ? {} : { displayName }) });
  }

  async login(emailInput: unknown, passwordInput: unknown): Promise<IdentitySession> {
    await this.ready();
    const email = normalizeEmail(emailInput);
    if (typeof passwordInput !== "string") throw new IdentityError(401, "invalid_credentials", "Invalid email or password");
    const user = await this.database.prepare(`
      SELECT u.id, u.email, u.password_hash, m.tenant_id, p.display_name
      FROM mr_identity_users u
      LEFT JOIN mr_identity_profiles p ON p.user_id = u.id
      JOIN mr_identity_memberships m ON m.user_id = u.id
      WHERE u.email = ? AND m.role = 'owner'
      ORDER BY m.created_at ASC LIMIT 1
    `).get(email) as { id: string; email: string; password_hash: string; tenant_id: string; display_name: string | null } | undefined;
    if (user === undefined || !(await verifyPassword(passwordInput, user.password_hash))) {
      throw new IdentityError(401, "invalid_credentials", "Invalid email or password");
    }
    return this.issueSession({ userId: user.id, tenantId: user.tenant_id, email: user.email, ...(user.display_name === null ? {} : { displayName: user.display_name }) });
  }

  async authenticate(authorization: string | string[] | undefined): Promise<Principal> {
    await this.ready();
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = header?.match(/^Bearer\s+([A-Za-z0-9_-]{32,})$/i);
    if (match === undefined || match === null) throw new IdentityError(401, "authentication_required", "Authentication required");
    const row = await this.database.prepare(`
      SELECT u.id, u.email, m.tenant_id, p.display_name
      FROM mr_identity_sessions s
      JOIN mr_identity_users u ON u.id = s.user_id
      LEFT JOIN mr_identity_profiles p ON p.user_id = u.id
      JOIN mr_identity_memberships m ON m.user_id = u.id AND m.role = 'owner'
      WHERE s.token_hash = ? AND s.expires_at > ?
      ORDER BY m.created_at ASC LIMIT 1
    `).get(hashToken(match[1]), Date.now()) as { id: string; email: string; tenant_id: string; display_name: string | null } | undefined;
    if (row === undefined) throw new IdentityError(401, "session_invalid", "Session is invalid or expired");
    return { userId: row.id, tenantId: row.tenant_id, email: row.email, ...(row.display_name === null ? {} : { displayName: row.display_name }) };
  }

  async revoke(authorization: string | string[] | undefined): Promise<void> {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = header?.match(/^Bearer\s+([A-Za-z0-9_-]{32,})$/i);
    if (match === undefined || match === null) return;
    await this.database.prepare("DELETE FROM mr_identity_sessions WHERE token_hash = ?").run(hashToken(match[1]));
  }

  private async issueSession(principal: Principal): Promise<IdentitySession> {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    await this.database.prepare(`
      INSERT INTO mr_identity_sessions(id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(`session_${randomUUID()}`, principal.userId, hashToken(token), expiresAt, now);
    return { token, expiresAt, principal };
  }
}

/** Account-only schema. Router invokes this from its versioned migration registry. */
export async function installIdentitySchema(database: SqlConnection): Promise<void> {
  await database.exec(database.dialect === "tidb" ? TIDB_IDENTITY_SCHEMA_SQL : IDENTITY_SCHEMA_SQL);
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new IdentityError(400, "invalid_email", "email must be a string");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new IdentityError(400, "invalid_email", "email has an invalid format");
  return email;
}

function validatePassword(value: unknown): string {
  if (typeof value !== "string") throw new IdentityError(400, "invalid_password", "password must be a string");
  if (value.length < 12) throw new IdentityError(400, "invalid_password", "password must contain at least 12 characters");
  if (value.length > 256) throw new IdentityError(400, "invalid_password", "password must contain at most 256 characters");
  return value;
}

function validateDisplayName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 40 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new IdentityError(400, "invalid_display_name");
  }
  return value.trim();
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await scrypt(password, salt, PASSWORD_KEY_LENGTH) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, saltText, digestText] = encoded.split("$");
  if (scheme !== "scrypt" || saltText === undefined || digestText === undefined) return false;
  const expected = Buffer.from(digestText, "base64url");
  if (expected.length !== PASSWORD_KEY_LENGTH) return false;
  const actual = await scrypt(password, Buffer.from(saltText, "base64url"), expected.length) as Buffer;
  return timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

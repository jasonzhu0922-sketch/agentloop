import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { TIDB_IDENTITY_SCHEMA_SQL, type AppDatabase, type SqlConnection } from "@zhujun/agentloop";
import { migrateRouterState } from "../persistence/state-migrations.ts";

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
}

export interface IdentitySession {
  readonly token: string;
  readonly expiresAt: number;
  readonly principal: Principal;
}

export class IdentityError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Cloud identity authority for Multi Runtime users and their initial personal tenant. */
export class IdentityService {
  private readonly database: AppDatabase;
  private readonly sessionTtlMs: number;

  constructor(database: AppDatabase, sessionTtlMs = 7 * 24 * 60 * 60 * 1000) {
    this.database = database;
    this.sessionTtlMs = sessionTtlMs;
  }

  async ready(): Promise<void> {
    await migrateRouterState(this.database);
  }

  async register(emailInput: unknown, passwordInput: unknown): Promise<IdentitySession> {
    await this.ready();
    const email = normalizeEmail(emailInput);
    const password = validatePassword(passwordInput);
    const passwordHash = await hashPassword(password);
    const userId = `user_${randomUUID()}`;
    const tenantId = `tenant_${randomUUID()}`;
    const now = Date.now();
    try {
      await this.database.transaction(async () => {
        await this.database.prepare("INSERT INTO mr_identity_users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .run(userId, email, passwordHash, now);
        await this.database.prepare("INSERT INTO mr_identity_tenants(id, name, created_at) VALUES (?, ?, ?)")
          .run(tenantId, `${email} workspace`, now);
        await this.database.prepare("INSERT INTO mr_identity_memberships(tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
          .run(tenantId, userId, now);
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new IdentityError(409, "email_registered", "Email is already registered");
      throw error;
    }
    return this.issueSession({ userId, tenantId, email });
  }

  async login(emailInput: unknown, passwordInput: unknown): Promise<IdentitySession> {
    await this.ready();
    const email = normalizeEmail(emailInput);
    if (typeof passwordInput !== "string") throw new IdentityError(401, "invalid_credentials", "Invalid email or password");
    const user = await this.database.prepare(`
      SELECT u.id, u.email, u.password_hash, m.tenant_id
      FROM mr_identity_users u
      JOIN mr_identity_memberships m ON m.user_id = u.id
      WHERE u.email = ? AND m.role = 'owner'
      ORDER BY m.created_at ASC LIMIT 1
    `).get(email) as { id: string; email: string; password_hash: string; tenant_id: string } | undefined;
    if (user === undefined || !(await verifyPassword(passwordInput, user.password_hash))) {
      throw new IdentityError(401, "invalid_credentials", "Invalid email or password");
    }
    return this.issueSession({ userId: user.id, tenantId: user.tenant_id, email: user.email });
  }

  async authenticate(authorization: string | string[] | undefined): Promise<Principal> {
    await this.ready();
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = header?.match(/^Bearer\s+([A-Za-z0-9_-]{32,})$/i);
    if (match === undefined || match === null) throw new IdentityError(401, "authentication_required", "Authentication required");
    const row = await this.database.prepare(`
      SELECT u.id, u.email, m.tenant_id
      FROM mr_identity_sessions s
      JOIN mr_identity_users u ON u.id = s.user_id
      JOIN mr_identity_memberships m ON m.user_id = u.id AND m.role = 'owner'
      WHERE s.token_hash = ? AND s.expires_at > ?
      ORDER BY m.created_at ASC LIMIT 1
    `).get(hashToken(match[1]), Date.now()) as { id: string; email: string; tenant_id: string } | undefined;
    if (row === undefined) throw new IdentityError(401, "session_invalid", "Session is invalid or expired");
    return { userId: row.id, tenantId: row.tenant_id, email: row.email };
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

/** Schema installer invoked only by the versioned migration registry. */
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

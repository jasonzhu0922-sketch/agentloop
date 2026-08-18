import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AppDatabase } from "../storage/database.ts";
import { badRequest, conflict, unauthenticated } from "../shared/errors.ts";

const scrypt = promisify(scryptCallback);
const PASSWORD_SCHEME = "scrypt";
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TOKEN_BYTES = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
}

export interface AuthResult {
  readonly user: AuthenticatedUser;
  readonly token: string;
  readonly expiresAt: number;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

interface SessionUserRow {
  id: string;
  email: string;
}

export class AuthService {
  private readonly database: AppDatabase;
  private readonly sessionTtlMs: number;

  constructor(database: AppDatabase, sessionTtlMs = 7 * 24 * 60 * 60 * 1000) {
    this.database = database;
    this.sessionTtlMs = sessionTtlMs;
  }

  async register(emailInput: unknown, passwordInput: unknown): Promise<AuthResult> {
    const email = normalizeEmail(emailInput);
    const password = validatePassword(passwordInput);
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    const now = Date.now();
    try {
      this.database.raw
        .prepare("INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(id, email, passwordHash, now);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw conflict("Email is already registered");
      throw error;
    }
    return this.issueSession({ id, email });
  }

  async login(emailInput: unknown, passwordInput: unknown): Promise<AuthResult> {
    const email = normalizeEmail(emailInput);
    if (typeof passwordInput !== "string") throw unauthenticated("Invalid email or password");
    const row = this.database.raw
      .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .get(email) as UserRow | undefined;
    if (row === undefined || !(await verifyPassword(passwordInput, row.password_hash))) {
      throw unauthenticated("Invalid email or password");
    }
    return this.issueSession({ id: row.id, email: row.email });
  }

  authenticate(token: string | undefined): AuthenticatedUser {
    if (token === undefined || token.length < 20) throw unauthenticated();
    const tokenHash = hashToken(token);
    const row = this.database.raw
      .prepare(`
        SELECT users.id, users.email
        FROM auth_sessions
        JOIN users ON users.id = auth_sessions.user_id
        WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
      `)
      .get(tokenHash, Date.now()) as SessionUserRow | undefined;
    if (row === undefined) throw unauthenticated("Session is invalid or expired");
    return { id: row.id, email: row.email };
  }

  revoke(token: string): void {
    this.database.raw.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
  }

  private issueSession(user: AuthenticatedUser): AuthResult {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    this.database.raw
      .prepare(`
        INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), user.id, hashToken(token), expiresAt, now);
    return { user, token, expiresAt };
  }
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw badRequest("email must be a string");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw badRequest("email has an invalid format");
  return email;
}

function validatePassword(value: unknown): string {
  if (typeof value !== "string") throw badRequest("password must be a string");
  if (value.length < 12) throw badRequest("password must contain at least 12 characters");
  if (value.length > 256) throw badRequest("password must contain at most 256 characters");
  return value;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  return `${PASSWORD_SCHEME}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, saltText, digestText] = encoded.split("$");
  if (scheme !== PASSWORD_SCHEME || saltText === undefined || digestText === undefined) return false;
  const expected = Buffer.from(digestText, "base64url");
  if (expected.length !== PASSWORD_KEY_LENGTH) return false;
  const actual = (await scrypt(password, Buffer.from(saltText, "base64url"), expected.length)) as Buffer;
  return timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

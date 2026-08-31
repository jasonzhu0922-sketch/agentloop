import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { badRequest, conflict, unauthenticated } from "@zhujun/agentloop";
import type { SqlConnection } from "@zhujun/agentloop";
import { AuthRepository } from "./auth-repository.ts";

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

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly sessionTtlMs: number;

  constructor(database: SqlConnection, sessionTtlMs = 7 * 24 * 60 * 60 * 1000) {
    this.repository = new AuthRepository(database);
    this.sessionTtlMs = sessionTtlMs;
  }

  async register(emailInput: unknown, passwordInput: unknown): Promise<AuthResult> {
    const email = normalizeEmail(emailInput);
    const password = validatePassword(passwordInput);
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    const now = Date.now();
    try {
      await this.repository.insertUser({ id, email, passwordHash, createdAt: now });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw conflict("Email is already registered");
      throw error;
    }
    return this.issueSession({ id, email });
  }

  async login(emailInput: unknown, passwordInput: unknown): Promise<AuthResult> {
    const email = normalizeEmail(emailInput);
    if (typeof passwordInput !== "string") throw unauthenticated("Invalid email or password");
    const row = await this.repository.findByEmail(email);
    if (row === undefined || !(await verifyPassword(passwordInput, row.password_hash))) {
      throw unauthenticated("Invalid email or password");
    }
    return this.issueSession({ id: row.id, email: row.email });
  }

  async authenticate(token: string | undefined): Promise<AuthenticatedUser> {
    if (token === undefined || token.length < 20) throw unauthenticated();
    const tokenHash = hashToken(token);
    const row = await this.repository.findSessionUser(tokenHash, Date.now());
    if (row === undefined) throw unauthenticated("Session is invalid or expired");
    return { id: row.id, email: row.email };
  }

  async revoke(token: string): Promise<void> {
    await this.repository.deleteSessionByTokenHash(hashToken(token));
  }

  private async issueSession(user: AuthenticatedUser): Promise<AuthResult> {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    await this.repository.insertSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
    });
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

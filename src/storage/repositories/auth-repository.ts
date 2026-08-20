import type { SqlConnection } from "../connection.ts";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export interface SessionUserRow {
  id: string;
  email: string;
}

export class AuthRepository {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
  }

  insertUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    createdAt: number;
  }): void {
    this.connection.prepare("INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(input.id, input.email, input.passwordHash, input.createdAt);
  }

  findByEmail(email: string): UserRow | undefined {
    return this.connection.prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .get(email) as UserRow | undefined;
  }

  findSessionUser(tokenHash: string, now: number): SessionUserRow | undefined {
    return this.connection.prepare(`
      SELECT users.id, users.email
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
    `).get(tokenHash, now) as SessionUserRow | undefined;
  }

  insertSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: number;
    createdAt: number;
  }): void {
    this.connection.prepare(`
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.id, input.userId, input.tokenHash, input.expiresAt, input.createdAt);
  }

  deleteSessionByTokenHash(tokenHash: string): void {
    this.connection.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }
}
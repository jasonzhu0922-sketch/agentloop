import type { SqlConnection } from "@zhujun/agentloop";

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
  private readonly readyPromise: Promise<void>;

  constructor(connection: SqlConnection) {
    this.connection = connection;
    this.readyPromise = this.migrate();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async insertUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    createdAt: number;
  }): Promise<void> {
    await this.ready();
    await this.connection.prepare("INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(input.id, input.email, input.passwordHash, input.createdAt);
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    await this.ready();
    return await this.connection.prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .get(email) as UserRow | undefined;
  }

  async findSessionUser(tokenHash: string, now: number): Promise<SessionUserRow | undefined> {
    await this.ready();
    return await this.connection.prepare(`
      SELECT users.id, users.email
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
    `).get(tokenHash, now) as SessionUserRow | undefined;
  }

  async insertSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<void> {
    await this.ready();
    await this.connection.prepare(`
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.id, input.userId, input.tokenHash, input.expiresAt, input.createdAt);
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.ready();
    await this.connection.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  private async migrate(): Promise<void> {
    await this.connection.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
    `);
  }
}

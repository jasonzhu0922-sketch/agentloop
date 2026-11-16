/** Account timestamps are epoch milliseconds and require PostgreSQL BIGINT. */
export const POSTGRES_IDENTITY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mr_identity_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mr_identity_tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mr_identity_profiles (
    user_id TEXT PRIMARY KEY REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mr_identity_memberships (
    tenant_id TEXT NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at BIGINT NOT NULL, PRIMARY KEY (tenant_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS mr_identity_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mr_identity_sessions_user_idx ON mr_identity_sessions(user_id);
  CREATE INDEX IF NOT EXISTS mr_identity_sessions_expiry_idx ON mr_identity_sessions(expires_at);
`;

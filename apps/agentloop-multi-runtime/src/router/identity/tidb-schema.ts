/** TiDB DDL owned by Router identity persistence. */
export const TIDB_IDENTITY_SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS mr_identity_users (
    id VARCHAR(191) PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    updated_at BIGINT NOT NULL DEFAULT 0,
    last_active_at BIGINT NULL
  );
CREATE TABLE IF NOT EXISTS mr_identity_tenants (
    id VARCHAR(191) PRIMARY KEY,
    name LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
CREATE TABLE IF NOT EXISTS mr_identity_memberships (
    tenant_id VARCHAR(191) NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
    user_id VARCHAR(191) NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    role LONGTEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
    created_at BIGINT NOT NULL,
    PRIMARY KEY(tenant_id, user_id)
  );
CREATE TABLE IF NOT EXISTS mr_identity_sessions (
    id VARCHAR(191) PRIMARY KEY,
    user_id VARCHAR(191) NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  );
CREATE INDEX IF NOT EXISTS mr_identity_sessions_user_idx ON mr_identity_sessions(user_id);
CREATE INDEX IF NOT EXISTS mr_identity_sessions_expiry_idx ON mr_identity_sessions(expires_at)`;

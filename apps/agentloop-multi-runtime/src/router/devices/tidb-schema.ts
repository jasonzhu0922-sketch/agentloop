/** TiDB DDL owned by Router Local Runtime device persistence. */
export const TIDB_DEVICE_SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS mr_devices (
        id VARCHAR(191) PRIMARY KEY,
        tenant_id VARCHAR(191) NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
        owner_user_id VARCHAR(191) NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
        display_name LONGTEXT NOT NULL,
        public_key LONGTEXT NOT NULL,
        status LONGTEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        last_seen_at BIGINT,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS mr_devices_owner_idx ON mr_devices(tenant_id, owner_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mr_device_registration_tokens (
        id VARCHAR(191) PRIMARY KEY,
        tenant_id VARCHAR(191) NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
        owner_user_id VARCHAR(191) NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );
CREATE TABLE IF NOT EXISTS mr_device_agent_sessions (
        device_id VARCHAR(191) PRIMARY KEY REFERENCES mr_devices(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        created_at BIGINT NOT NULL
      );
CREATE TABLE IF NOT EXISTS mr_device_local_sessions (
        id VARCHAR(191) PRIMARY KEY,
        device_id VARCHAR(191) NOT NULL REFERENCES mr_devices(id) ON DELETE CASCADE,
        tenant_id VARCHAR(191) NOT NULL REFERENCES mr_identity_tenants(id) ON DELETE CASCADE,
        owner_user_id VARCHAR(191) NOT NULL REFERENCES mr_identity_users(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS mr_device_local_sessions_expiry_idx ON mr_device_local_sessions(expires_at)`;

/** TiDB DDL owned by Router attachment metadata persistence. */
export const TIDB_ATTACHMENT_SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS mr_attachments (
        id VARCHAR(191) PRIMARY KEY,
        tenant_id VARCHAR(191) NOT NULL,
        owner_user_id VARCHAR(191) NOT NULL,
        conversation_id VARCHAR(191) NOT NULL,
        original_name LONGTEXT NOT NULL,
        media_type LONGTEXT NOT NULL,
        byte_size BIGINT NOT NULL,
        sha256 LONGTEXT NOT NULL,
        storage_name VARCHAR(191) NOT NULL UNIQUE,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS mr_attachments_subject_idx
        ON mr_attachments(tenant_id, owner_user_id, conversation_id, created_at DESC)`;

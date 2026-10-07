/** TiDB DDL owned by the Runtime Host's durable dispatch ledger. */
export const TIDB_HOST_DISPATCH_SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS mr_host_dispatches (
        dispatch_key VARCHAR(191) PRIMARY KEY,
        assignment_id LONGTEXT NOT NULL,
        owner_user_id LONGTEXT NOT NULL,
        remote_run_id VARCHAR(191),
        state LONGTEXT NOT NULL,
        lease_expires_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
-- Every supported relational backend permits multiple NULL values in a
      -- UNIQUE index. Avoid a SQLite/PostgreSQL partial index so this durable
      -- Host ledger has the same invariant on TiDB.
      CREATE UNIQUE INDEX IF NOT EXISTS mr_host_dispatches_run_idx ON mr_host_dispatches(remote_run_id);
CREATE TABLE IF NOT EXISTS mr_run_executors (
        remote_run_id VARCHAR(191) PRIMARY KEY,
        runtime_id VARCHAR(191) NOT NULL,
        dispatch_key VARCHAR(191) NOT NULL UNIQUE,
        owner_user_id LONGTEXT NOT NULL,
        accepted_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS mr_run_executors_runtime_idx ON mr_run_executors(runtime_id, accepted_at DESC)`;

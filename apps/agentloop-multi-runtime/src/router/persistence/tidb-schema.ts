/** TiDB DDL owned by the Router control-plane persistence adapter. */
export const TIDB_CONTROL_PLANE_SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS mr_runtime_nodes (
        id VARCHAR(191) PRIMARY KEY,
        display_name LONGTEXT,
        endpoint LONGTEXT NOT NULL,
        kind LONGTEXT NOT NULL,
        device_id VARCHAR(191),
        tenant_id VARCHAR(191),
        owner_user_id VARCHAR(191),
        connection_id LONGTEXT,
        connection_epoch BIGINT,
        lease_expires_at BIGINT,
        catalog_version LONGTEXT,
        profile LONGTEXT NOT NULL,
        capabilities_json LONGTEXT NOT NULL,
        max_concurrent_runs BIGINT NOT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'offline',
        active_run_count BIGINT NOT NULL DEFAULT 0,
        queued_run_count BIGINT NOT NULL DEFAULT 0,
        last_heartbeat_at BIGINT,
        updated_at BIGINT NOT NULL
      );
CREATE TABLE IF NOT EXISTS mr_tasks (
        id VARCHAR(191) PRIMARY KEY,
        tenant_id VARCHAR(191) NOT NULL,
        owner_user_id VARCHAR(191) NOT NULL,
        conversation_id VARCHAR(191) NOT NULL,
        client_message_id VARCHAR(191) NOT NULL,
        input LONGTEXT NOT NULL,
        requested_runtime_id LONGTEXT,
        requested_profile LONGTEXT,
        execution_target_json LONGTEXT NOT NULL,
        data_policy_json LONGTEXT NOT NULL,
        required_capabilities_json LONGTEXT NOT NULL,
        requested_model_key LONGTEXT,
        allow_dangerous_tools BIGINT NOT NULL,
        resource_refs_json LONGTEXT NOT NULL,
        message_attachments_json LONGTEXT NOT NULL,
        local_directory_scope_ids_json LONGTEXT NOT NULL,
        status LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(tenant_id, owner_user_id, conversation_id, client_message_id)
      );
CREATE TABLE IF NOT EXISTS mr_assignments (
        id VARCHAR(191) PRIMARY KEY,
        task_id VARCHAR(191) NOT NULL REFERENCES mr_tasks(id) ON DELETE CASCADE,
        runtime_id VARCHAR(191) NOT NULL REFERENCES mr_runtime_nodes(id),
        dispatch_key VARCHAR(191) NOT NULL UNIQUE,
        remote_run_id LONGTEXT,
        status VARCHAR(64) NOT NULL,
        reservation_expires_at BIGINT,
        error_code LONGTEXT,
        error_message LONGTEXT,
        last_observed_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS mr_assignments_task_idx ON mr_assignments(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mr_assignments_runtime_state_idx ON mr_assignments(runtime_id, status, reservation_expires_at);
CREATE TABLE IF NOT EXISTS mr_turns (
        assignment_id VARCHAR(191) PRIMARY KEY REFERENCES mr_assignments(id) ON DELETE CASCADE,
        tenant_id VARCHAR(191) NOT NULL,
        owner_user_id VARCHAR(191) NOT NULL,
        conversation_id VARCHAR(191) NOT NULL,
        client_message_id VARCHAR(191) NOT NULL,
        runtime_id LONGTEXT NOT NULL,
        execution_location LONGTEXT NOT NULL,
        model_key LONGTEXT,
        user_input LONGTEXT,
        assistant_output LONGTEXT,
        status LONGTEXT NOT NULL,
        error_code LONGTEXT,
        created_at BIGINT NOT NULL,
        completed_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS mr_turns_conversation_idx ON mr_turns(tenant_id, owner_user_id, conversation_id, created_at);
CREATE TABLE IF NOT EXISTS mr_conversation_runtime_migrations (
        id VARCHAR(191) PRIMARY KEY,
        tenant_id VARCHAR(191) NOT NULL,
        owner_user_id VARCHAR(191) NOT NULL,
        conversation_id VARCHAR(191) NOT NULL,
        assignment_id VARCHAR(191) NOT NULL REFERENCES mr_assignments(id) ON DELETE CASCADE,
        previous_runtime_id VARCHAR(191) NOT NULL REFERENCES mr_runtime_nodes(id),
        selected_runtime_id VARCHAR(191) NOT NULL REFERENCES mr_runtime_nodes(id),
        reason LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS mr_conversation_runtime_migrations_conversation_idx
        ON mr_conversation_runtime_migrations(tenant_id, owner_user_id, conversation_id, created_at DESC)`;

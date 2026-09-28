/**
 * Executable TiDB DDL. These declarations are deliberately independent from
 * SQLite/PostgreSQL schemas; no runtime SQL rewriting is permitted.
 */
export const TIDB_KERNEL_SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS skills (
        id VARCHAR(191) PRIMARY KEY,
        owner_user_id VARCHAR(191) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description LONGTEXT NOT NULL,
        instructions LONGTEXT NOT NULL,
        source_kind VARCHAR(64) NOT NULL DEFAULT 'inline' CHECK(source_kind IN ('inline', 'package')),
        source_url LONGTEXT,
        source_revision LONGTEXT,
        package_root LONGTEXT,
        entrypoint_path LONGTEXT,
        package_hash VARCHAR(128),
        package_file_count BIGINT,
        package_total_bytes BIGINT,
        content_hash VARCHAR(128) NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(owner_user_id, name)
      );
CREATE INDEX IF NOT EXISTS skills_owner_idx ON skills(owner_user_id);
CREATE TABLE IF NOT EXISTS discovered_skills (
        name VARCHAR(255) PRIMARY KEY,
        description LONGTEXT NOT NULL,
        source_directory LONGTEXT NOT NULL,
        package_hash VARCHAR(128) NOT NULL,
        file_count BIGINT NOT NULL,
        total_bytes BIGINT NOT NULL,
        agent_loop_json LONGTEXT,
        version BIGINT NOT NULL DEFAULT 1,
        synced_at BIGINT NOT NULL
      );
CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(191) PRIMARY KEY,
        owner_user_id VARCHAR(191) NOT NULL,
        title LONGTEXT NOT NULL,
        visible_directories_json LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS conversations_owner_idx
        ON conversations(owner_user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS runs (
        id VARCHAR(191) PRIMARY KEY,
        owner_user_id VARCHAR(191) NOT NULL,
        conversation_id VARCHAR(191) REFERENCES conversations(id) ON DELETE SET NULL,
        parent_run_id VARCHAR(191) REFERENCES runs(id) ON DELETE SET NULL,
        depth BIGINT NOT NULL,
        allow_dangerous_tools BIGINT NOT NULL DEFAULT 0,
        model_key LONGTEXT,
        status VARCHAR(64) NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        input LONGTEXT NOT NULL,
        output LONGTEXT,
        error_code LONGTEXT,
        created_at BIGINT NOT NULL,
        finished_at BIGINT
      );
CREATE INDEX IF NOT EXISTS runs_owner_idx ON runs(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_parent_idx ON runs(parent_run_id);
CREATE TABLE IF NOT EXISTS plans (
        id VARCHAR(191) PRIMARY KEY,
        run_id VARCHAR(191) NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        version BIGINT NOT NULL,
        goal LONGTEXT NOT NULL,
        selected_skill_ids_json LONGTEXT NOT NULL,
        task_semantics_json LONGTEXT,
        input_bindings_json LONGTEXT NOT NULL,
        status VARCHAR(64) NOT NULL CHECK(status IN ('admitted', 'running', 'completed', 'failed')),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
CREATE TABLE IF NOT EXISTS plan_steps (
        plan_id VARCHAR(191) NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        step_id VARCHAR(191) NOT NULL,
        kind VARCHAR(64) NOT NULL DEFAULT 'leaf' CHECK(kind IN ('leaf', 'milestone')),
        parent_step_id VARCHAR(191),
        position BIGINT NOT NULL,
        objective LONGTEXT NOT NULL,
        dependencies_json LONGTEXT NOT NULL,
        role LONGTEXT,
        refinement_state VARCHAR(64) NOT NULL DEFAULT 'not_refinable'
          CHECK(refinement_state IN ('not_refinable', 'pending_facts', 'ready_to_refine', 'refining', 'refined')),
        required_facts_json LONGTEXT NOT NULL,
        skill_ids_json LONGTEXT NOT NULL,
        required_capabilities_json LONGTEXT NOT NULL,
        recommended_tool_names_json LONGTEXT NOT NULL,
        execution_binding_json LONGTEXT,
        evidence_contract_json LONGTEXT,
        success_criteria_json LONGTEXT NOT NULL,
        status VARCHAR(64) NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        output LONGTEXT,
        evidence_json LONGTEXT,
        error LONGTEXT,
        repair_boundary_json LONGTEXT,
        started_at BIGINT,
        finished_at BIGINT,
        PRIMARY KEY(plan_id, step_id),
        UNIQUE(plan_id, position)
      );
CREATE INDEX IF NOT EXISTS plan_steps_status_idx ON plan_steps(plan_id, status, position);
CREATE TABLE IF NOT EXISTS run_events (
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq BIGINT NOT NULL,
        type LONGTEXT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(run_id, seq)
      );
CREATE TABLE IF NOT EXISTS run_event_sequences (
        run_id VARCHAR(191) PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        next_seq BIGINT NOT NULL
      );
CREATE TABLE IF NOT EXISTS runtime_actions (
        id VARCHAR(191) PRIMARY KEY,
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        plan_id VARCHAR(191) REFERENCES plans(id) ON DELETE SET NULL,
        step_id LONGTEXT,
        kind LONGTEXT NOT NULL CHECK(kind IN ('planning', 'model_turn', 'tool_call', 'assessment', 'compaction', 'recovery_review')),
        state VARCHAR(64) NOT NULL CHECK(state IN ('dispatched', 'succeeded', 'failed', 'recovery_required')),
        attempt BIGINT NOT NULL,
        max_attempts BIGINT NOT NULL,
        replay_policy LONGTEXT NOT NULL CHECK(replay_policy IN ('safe', 'idempotent', 'unsafe')),
        deadline_at BIGINT,
        lease_until BIGINT,
        fence BIGINT NOT NULL,
        revision BIGINT NOT NULL,
        metadata_json LONGTEXT NOT NULL,
        result_ref VARCHAR(191),
        error_code LONGTEXT,
        effect_state LONGTEXT NOT NULL CHECK(effect_state IN ('not_started', 'unknown', 'applied')),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        closed_at BIGINT
      );
CREATE INDEX IF NOT EXISTS runtime_actions_run_idx ON runtime_actions(run_id, created_at);
CREATE INDEX IF NOT EXISTS runtime_actions_recovery_idx ON runtime_actions(state, lease_until, deadline_at);
CREATE TABLE IF NOT EXISTS human_loop_requests (
        id VARCHAR(191) PRIMARY KEY,
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        plan_id VARCHAR(191) REFERENCES plans(id) ON DELETE SET NULL,
        step_id LONGTEXT,
        action_id VARCHAR(191) REFERENCES runtime_actions(id) ON DELETE SET NULL,
        origin LONGTEXT NOT NULL CHECK(origin IN ('skill', 'tool', 'planner', 'assessor', 'recovery')),
        kind LONGTEXT NOT NULL CHECK(kind IN ('selection', 'input', 'confirmation', 'approval')),
        title LONGTEXT NOT NULL,
        prompt LONGTEXT NOT NULL,
        rationale LONGTEXT NOT NULL,
        evidence_refs_json LONGTEXT NOT NULL,
        response_schema_json LONGTEXT NOT NULL,
        resume_json LONGTEXT NOT NULL,
        status VARCHAR(64) NOT NULL CHECK(status IN ('open', 'answered', 'superseded', 'cancelled', 'expired')),
        revision BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        resolved_at BIGINT
      );
CREATE INDEX IF NOT EXISTS human_loop_requests_run_idx ON human_loop_requests(run_id, status, created_at);
CREATE TABLE IF NOT EXISTS human_loop_responses (
        id VARCHAR(191) PRIMARY KEY,
        request_id VARCHAR(191) NOT NULL UNIQUE REFERENCES human_loop_requests(id) ON DELETE CASCADE,
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        request_revision BIGINT NOT NULL,
        response_json LONGTEXT NOT NULL,
        actor_user_id LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS human_loop_responses_run_idx ON human_loop_responses(run_id, created_at);
CREATE TABLE IF NOT EXISTS run_recovery_states (
        run_id VARCHAR(191) PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        state LONGTEXT NOT NULL CHECK(state IN ('waiting_recovery', 'waiting_user', 'ready_to_resume')),
        action_id VARCHAR(191) NOT NULL REFERENCES runtime_actions(id) ON DELETE RESTRICT,
        question LONGTEXT,
        resume_token LONGTEXT,
        resume_lease_until BIGINT,
        resume_fence BIGINT,
        planning_token LONGTEXT,
        planning_lease_until BIGINT,
        planning_fence BIGINT,
        updated_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS run_recovery_states_action_idx ON run_recovery_states(action_id);
CREATE TABLE IF NOT EXISTS run_checkpoints (
        id VARCHAR(191) PRIMARY KEY,
        run_id VARCHAR(191) NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        plan_id VARCHAR(191) REFERENCES plans(id) ON DELETE SET NULL,
        action_id VARCHAR(191) REFERENCES runtime_actions(id) ON DELETE SET NULL,
        reason LONGTEXT NOT NULL CHECK(reason IN ('execution_authority_lost')),
        snapshot_json LONGTEXT NOT NULL,
        child_run_id VARCHAR(191) REFERENCES runs(id) ON DELETE SET NULL,
        created_at BIGINT NOT NULL,
        consumed_at BIGINT
      );
CREATE INDEX IF NOT EXISTS run_checkpoints_child_idx ON run_checkpoints(child_run_id);
CREATE TABLE IF NOT EXISTS recovery_decisions (
        id VARCHAR(191) PRIMARY KEY,
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        action_id VARCHAR(191) NOT NULL REFERENCES runtime_actions(id) ON DELETE CASCADE,
        expected_action_revision BIGINT NOT NULL,
        decision LONGTEXT NOT NULL CHECK(decision IN ('resume_step', 'revise_plan', 'ask_user', 'fail')),
        rationale LONGTEXT NOT NULL,
        evidence_refs_json LONGTEXT NOT NULL,
        plan_revision_json LONGTEXT,
        question LONGTEXT,
        response_schema_json LONGTEXT,
        state LONGTEXT NOT NULL CHECK(state IN ('submitted', 'admitted', 'rejected')),
        rejection_code LONGTEXT,
        created_at BIGINT NOT NULL,
        resolved_at BIGINT
      );
CREATE INDEX IF NOT EXISTS recovery_decisions_run_idx ON recovery_decisions(run_id, created_at);
CREATE INDEX IF NOT EXISTS recovery_decisions_action_idx ON recovery_decisions(action_id, created_at);
CREATE TABLE IF NOT EXISTS recovery_user_responses (
        id VARCHAR(191) PRIMARY KEY,
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        action_id VARCHAR(191) NOT NULL REFERENCES runtime_actions(id) ON DELETE CASCADE,
        response LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS recovery_user_responses_run_idx
        ON recovery_user_responses(run_id, created_at);
CREATE TABLE IF NOT EXISTS plan_revision_snapshots (
        plan_id VARCHAR(191) NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        version BIGINT NOT NULL,
        proposal_json LONGTEXT NOT NULL,
        reason LONGTEXT NOT NULL,
        action_id VARCHAR(191) REFERENCES runtime_actions(id) ON DELETE SET NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(plan_id, version)
      );
CREATE TABLE IF NOT EXISTS plan_step_retirements (
        plan_id VARCHAR(191) NOT NULL,
        step_id VARCHAR(191) NOT NULL,
        action_id VARCHAR(191) REFERENCES runtime_actions(id) ON DELETE SET NULL,
        reason LONGTEXT NOT NULL,
        retired_at BIGINT NOT NULL,
        PRIMARY KEY(plan_id, step_id),
        FOREIGN KEY(plan_id, step_id) REFERENCES plan_steps(plan_id, step_id) ON DELETE CASCADE
      );
CREATE TABLE IF NOT EXISTS plan_revision_assessments (
        id VARCHAR(191) PRIMARY KEY,
        recovery_decision_id VARCHAR(191) NOT NULL UNIQUE REFERENCES recovery_decisions(id) ON DELETE CASCADE,
        plan_id VARCHAR(191) NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        approved BIGINT NOT NULL CHECK(approved IN (0, 1)),
        feedback LONGTEXT NOT NULL,
        evidence_refs_json LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS plan_revision_assessments_plan_idx
        ON plan_revision_assessments(plan_id, created_at DESC);
CREATE TABLE IF NOT EXISTS skill_compliance_assessments (
        id VARCHAR(191) PRIMARY KEY,
        plan_id VARCHAR(191) NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        step_id VARCHAR(191) NOT NULL,
        attempt BIGINT NOT NULL,
        assessment_profile LONGTEXT NOT NULL
          CHECK(assessment_profile IN ('deterministic', 'evidence_gate', 'lookup_lite', 'source_grounded', 'risk_sensitive')),
        assessment_method LONGTEXT NOT NULL
          CHECK(assessment_method IN ('rule', 'model')),
        approved BIGINT NOT NULL CHECK(approved IN (0, 1)),
        criteria_json LONGTEXT NOT NULL,
        skills_json LONGTEXT NOT NULL,
        evidence_digest LONGTEXT NOT NULL,
        feedback LONGTEXT NOT NULL,
        failed_boundary_json LONGTEXT,
        decision_bindings_json LONGTEXT NOT NULL,
        binding_json LONGTEXT,
        inspection_json LONGTEXT,
        created_at BIGINT NOT NULL,
        UNIQUE(plan_id, step_id, attempt),
        FOREIGN KEY(plan_id, step_id) REFERENCES plan_steps(plan_id, step_id) ON DELETE CASCADE
      );
CREATE INDEX IF NOT EXISTS skill_assessment_step_idx
        ON skill_compliance_assessments(plan_id, step_id, attempt DESC);
CREATE TABLE IF NOT EXISTS run_outcomes (
        run_id VARCHAR(191) PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        plan_id VARCHAR(191) REFERENCES plans(id) ON DELETE CASCADE,
        status LONGTEXT NOT NULL CHECK(status IN ('completed', 'failed', 'cancelled')),
        output LONGTEXT,
        result_ref VARCHAR(191),
        result_json LONGTEXT,
        delivery_receipt_json LONGTEXT,
        reason_code LONGTEXT NOT NULL,
        committed_at BIGINT NOT NULL
      );
CREATE TABLE IF NOT EXISTS sources (
        id VARCHAR(191) PRIMARY KEY,
        owner_user_id VARCHAR(191) NOT NULL,
        conversation_id VARCHAR(191) REFERENCES conversations(id) ON DELETE CASCADE,
        original_name LONGTEXT NOT NULL,
        mime_type LONGTEXT NOT NULL,
        extension LONGTEXT NOT NULL,
        byte_size BIGINT NOT NULL,
        sha256 VARCHAR(128) NOT NULL,
        storage_path LONGTEXT NOT NULL,
        status LONGTEXT NOT NULL CHECK(status IN (
          'uploaded',
          'ready',
          'unsupported',
          'oversized',
          'unreadable',
          'extract_failed',
          'deleted'
        )),
        summary LONGTEXT,
        token_estimate BIGINT NOT NULL DEFAULT 0,
        character_count BIGINT NOT NULL DEFAULT 0,
        truncated BIGINT NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
        error_code LONGTEXT,
        error_message LONGTEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS sources_owner_conversation_idx
        ON sources(owner_user_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sources_sha_idx ON sources(owner_user_id, sha256);
CREATE TABLE IF NOT EXISTS source_chunks (
        source_id VARCHAR(191) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        chunk_index BIGINT NOT NULL,
        kind LONGTEXT NOT NULL CHECK(kind IN ('text', 'table', 'metadata')),
        locator LONGTEXT NOT NULL,
        content LONGTEXT NOT NULL,
        token_estimate BIGINT NOT NULL,
        sha256 LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(source_id, chunk_index)
      );
CREATE TABLE IF NOT EXISTS run_sources (
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        source_id VARCHAR(191) NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
        position BIGINT NOT NULL,
        role LONGTEXT NOT NULL CHECK(role IN ('user_supplied', 'derived')),
        created_at BIGINT NOT NULL,
        PRIMARY KEY(run_id, source_id),
        UNIQUE(run_id, position)
      );
CREATE TABLE IF NOT EXISTS run_visible_directories (
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        directory_id VARCHAR(191) NOT NULL,
        name LONGTEXT NOT NULL,
        path LONGTEXT NOT NULL,
        position BIGINT NOT NULL,
        PRIMARY KEY(run_id, directory_id),
        UNIQUE(run_id, position)
      );
CREATE TABLE IF NOT EXISTS batches (
        id VARCHAR(191) PRIMARY KEY,
        owner_user_id VARCHAR(191) NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL,
        status VARCHAR(64) NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        concurrency BIGINT NOT NULL,
        failure_policy LONGTEXT NOT NULL CHECK(failure_policy IN ('continue', 'fail-fast')),
        allow_dangerous_tools BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        finished_at BIGINT,
        UNIQUE(owner_user_id, idempotency_key)
      );
CREATE INDEX IF NOT EXISTS batches_owner_idx ON batches(owner_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS batch_items (
        id VARCHAR(191) PRIMARY KEY,
        batch_id VARCHAR(191) NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        item_key VARCHAR(191) NOT NULL,
        position BIGINT NOT NULL,
        input LONGTEXT NOT NULL,
        status VARCHAR(64) NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        run_id VARCHAR(191) REFERENCES runs(id) ON DELETE SET NULL,
        output LONGTEXT,
        error_code LONGTEXT,
        started_at BIGINT,
        finished_at BIGINT,
        UNIQUE(batch_id, item_key),
        UNIQUE(batch_id, position)
      );
CREATE INDEX IF NOT EXISTS batch_items_status_idx ON batch_items(batch_id, status, position);
CREATE TABLE IF NOT EXISTS audit_events (
        id VARCHAR(191) PRIMARY KEY,
        actor_user_id VARCHAR(191),
        action LONGTEXT NOT NULL,
        resource_type LONGTEXT NOT NULL,
        resource_id LONGTEXT,
        outcome LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_events(actor_user_id, created_at DESC)`;

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

export const TIDB_IDENTITY_SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS mr_identity_users (
    id VARCHAR(191) PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL
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

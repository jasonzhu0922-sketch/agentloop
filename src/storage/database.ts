import { DatabaseSync } from "node:sqlite";

export class AppDatabase {
  readonly raw: DatabaseSync;

  constructor(filename: string) {
    this.raw = new DatabaseSync(filename);
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(operation: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.raw.exec(`
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

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'inline' CHECK(source_kind IN ('inline', 'package')),
        source_url TEXT,
        source_revision TEXT,
        package_root TEXT,
        entrypoint_path TEXT,
        package_hash TEXT,
        package_file_count INTEGER,
        package_total_bytes INTEGER,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_user_id, name)
      );
      CREATE INDEX IF NOT EXISTS skills_owner_idx ON skills(owner_user_id);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        model_id TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        max_depth INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_user_id, name)
      );
      CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_user_id);

      CREATE TABLE IF NOT EXISTS agent_skills (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
        PRIMARY KEY(agent_id, skill_id)
      );

      CREATE TABLE IF NOT EXISTS agent_delegates (
        parent_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        child_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        PRIMARY KEY(parent_agent_id, child_agent_id),
        CHECK(parent_agent_id <> child_agent_id)
      );

      CREATE TABLE IF NOT EXISTS agent_tools (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        PRIMARY KEY(agent_id, tool_name)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        depth INTEGER NOT NULL,
        allow_dangerous_tools INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        input TEXT NOT NULL,
        output TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_owner_idx ON runs(owner_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS runs_parent_idx ON runs(parent_run_id);

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq)
      );

      CREATE TABLE IF NOT EXISTS runtime_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
        step_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('planning', 'model_turn', 'tool_call', 'assessment', 'compaction', 'recovery_review')),
        state TEXT NOT NULL CHECK(state IN ('dispatched', 'succeeded', 'failed', 'recovery_required')),
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        replay_policy TEXT NOT NULL CHECK(replay_policy IN ('safe', 'idempotent', 'unsafe')),
        deadline_at INTEGER,
        lease_until INTEGER,
        fence INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        result_ref TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS runtime_actions_run_idx ON runtime_actions(run_id, created_at);
      CREATE INDEX IF NOT EXISTS runtime_actions_recovery_idx ON runtime_actions(state, lease_until, deadline_at);

      CREATE TABLE IF NOT EXISTS run_recovery_states (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('waiting_recovery', 'waiting_user', 'ready_to_resume')),
        action_id TEXT NOT NULL REFERENCES runtime_actions(id) ON DELETE RESTRICT,
        question TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_recovery_states_action_idx ON run_recovery_states(action_id);

      CREATE TABLE IF NOT EXISTS recovery_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL REFERENCES runtime_actions(id) ON DELETE CASCADE,
        expected_action_revision INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('resume_step', 'revise_plan', 'ask_user', 'fail')),
        rationale TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        plan_revision_json TEXT,
        question TEXT,
        state TEXT NOT NULL CHECK(state IN ('submitted', 'admitted', 'rejected')),
        rejection_code TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS recovery_decisions_run_idx ON recovery_decisions(run_id, created_at);
      CREATE INDEX IF NOT EXISTS recovery_decisions_action_idx ON recovery_decisions(action_id, created_at);

      CREATE TABLE IF NOT EXISTS recovery_user_responses (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL REFERENCES runtime_actions(id) ON DELETE CASCADE,
        response TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recovery_user_responses_run_idx
        ON recovery_user_responses(run_id, created_at);

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        goal TEXT NOT NULL,
        selected_skill_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('admitted', 'running', 'completed', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plan_steps (
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        objective TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        skill_ids_json TEXT NOT NULL,
        required_tool_names_json TEXT NOT NULL,
        success_criteria_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        output TEXT,
        evidence_json TEXT,
        error TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY(plan_id, step_id),
        UNIQUE(plan_id, position)
      );
      CREATE INDEX IF NOT EXISTS plan_steps_status_idx ON plan_steps(plan_id, status, position);

      CREATE TABLE IF NOT EXISTS plan_revision_snapshots (
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        proposal_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        action_id TEXT REFERENCES runtime_actions(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(plan_id, version)
      );

      CREATE TABLE IF NOT EXISTS plan_step_retirements (
        plan_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        action_id TEXT REFERENCES runtime_actions(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        retired_at INTEGER NOT NULL,
        PRIMARY KEY(plan_id, step_id),
        FOREIGN KEY(plan_id, step_id) REFERENCES plan_steps(plan_id, step_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plan_revision_assessments (
        id TEXT PRIMARY KEY,
        recovery_decision_id TEXT NOT NULL UNIQUE REFERENCES recovery_decisions(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
        feedback TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plan_revision_assessments_plan_idx
        ON plan_revision_assessments(plan_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS skill_compliance_assessments (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
        criteria_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        feedback TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(plan_id, step_id, attempt),
        FOREIGN KEY(plan_id, step_id) REFERENCES plan_steps(plan_id, step_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS skill_assessment_step_idx
        ON skill_compliance_assessments(plan_id, step_id, attempt DESC);

      CREATE TABLE IF NOT EXISTS run_outcomes (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'cancelled')),
        output TEXT,
        reason_code TEXT NOT NULL,
        committed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        concurrency INTEGER NOT NULL,
        failure_policy TEXT NOT NULL CHECK(failure_policy IN ('continue', 'fail-fast')),
        allow_dangerous_tools INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE(owner_user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS batches_owner_idx ON batches(owner_user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        output TEXT,
        error_code TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        UNIQUE(batch_id, item_key),
        UNIQUE(batch_id, position)
      );
      CREATE INDEX IF NOT EXISTS batch_items_status_idx ON batch_items(batch_id, status, position);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_events(actor_user_id, created_at DESC);
    `);

    // Forward-only schema migration for databases created by the initial
    // vertical slice. The new runtime has one canonical schema after migration;
    // no dual-read or compatibility behavior is retained.
    this.ensureColumn("skills", "source_kind", "TEXT NOT NULL DEFAULT 'inline'");
    this.ensureColumn("skills", "source_url", "TEXT");
    this.ensureColumn("skills", "source_revision", "TEXT");
    this.ensureColumn("skills", "package_root", "TEXT");
    this.ensureColumn("skills", "entrypoint_path", "TEXT");
    this.ensureColumn("skills", "package_hash", "TEXT");
    this.ensureColumn("skills", "package_file_count", "INTEGER");
    this.ensureColumn("skills", "package_total_bytes", "INTEGER");
    this.ensureColumn("runs", "allow_dangerous_tools", "INTEGER NOT NULL DEFAULT 0");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.raw.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

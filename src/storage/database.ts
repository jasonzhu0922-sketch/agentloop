import type { SqlConnection, SqlStatement } from "./connection.ts";
import { SqliteConnection } from "./sqlite-connection.ts";

/**
 * Schema owner and connection facade. Implements the `SqlConnection` data-access
 * boundary on top of SQLite; a future Postgres deployment swaps in a different
 * connection adapter and keeps this schema/evolution logic.
 */
export class AppDatabase implements SqlConnection {
  private readonly connection: SqliteConnection;

  constructor(filename: string) {
    this.connection = new SqliteConnection(filename);
    this.migrate();
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return this.connection.prepare(sql);
  }

  transaction<T>(operation: () => T): T {
    return this.connection.transaction(operation);
  }

  close(): void {
    this.connection.close();
  }

  private migrate(): void {
    this.connection.exec(`
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

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        visible_directories_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_owner_idx
        ON conversations(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        depth INTEGER NOT NULL,
        allow_dangerous_tools INTEGER NOT NULL DEFAULT 0,
        model_key TEXT,
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
        kind TEXT NOT NULL DEFAULT 'leaf' CHECK(kind IN ('leaf', 'milestone')),
        parent_step_id TEXT,
        position INTEGER NOT NULL,
        objective TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        role TEXT,
        refinement_state TEXT NOT NULL DEFAULT 'not_refinable'
          CHECK(refinement_state IN ('not_refinable', 'pending_facts', 'ready_to_refine', 'refining', 'refined')),
        required_facts_json TEXT NOT NULL DEFAULT '[]',
        skill_ids_json TEXT NOT NULL,
        recommended_tool_names_json TEXT NOT NULL,
        evidence_contract_json TEXT,
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
        assessment_profile TEXT NOT NULL DEFAULT 'source_grounded'
          CHECK(assessment_profile IN ('deterministic', 'evidence_gate', 'lookup_lite', 'source_grounded', 'risk_sensitive')),
        assessment_method TEXT NOT NULL DEFAULT 'model'
          CHECK(assessment_method IN ('rule', 'model')),
        approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
        criteria_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        feedback TEXT NOT NULL,
        failed_boundary_json TEXT,
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

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        extension TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'uploaded',
          'ready',
          'unsupported',
          'oversized',
          'unreadable',
          'extract_failed',
          'deleted'
        )),
        summary TEXT,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        character_count INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sources_owner_conversation_idx
        ON sources(owner_user_id, conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS sources_sha_idx ON sources(owner_user_id, sha256);

      CREATE TABLE IF NOT EXISTS source_chunks (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text', 'table', 'metadata')),
        locator TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(source_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS run_sources (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user_supplied', 'derived')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, source_id),
        UNIQUE(run_id, position)
      );

      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    this.renameColumnIfNeeded("plan_steps", "required_tool_names_json", "recommended_tool_names_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("skills", "source_kind", "TEXT NOT NULL DEFAULT 'inline'");
    this.ensureColumn("skills", "source_url", "TEXT");
    this.ensureColumn("skills", "source_revision", "TEXT");
    this.ensureColumn("skills", "package_root", "TEXT");
    this.ensureColumn("skills", "entrypoint_path", "TEXT");
    this.ensureColumn("skills", "package_hash", "TEXT");
    this.ensureColumn("skills", "package_file_count", "INTEGER");
    this.ensureColumn("skills", "package_total_bytes", "INTEGER");
    this.ensureColumn("conversations", "visible_directories_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("runs", "allow_dangerous_tools", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "conversation_id", "TEXT REFERENCES conversations(id) ON DELETE SET NULL");
    this.ensureColumn("runs", "model_key", "TEXT");
    this.ensureColumn("plan_steps", "kind", "TEXT NOT NULL DEFAULT 'leaf'");
    this.ensureColumn("plan_steps", "parent_step_id", "TEXT");
    this.ensureColumn("plan_steps", "role", "TEXT");
    this.ensureColumn("plan_steps", "refinement_state", "TEXT NOT NULL DEFAULT 'not_refinable'");
    this.ensureColumn("plan_steps", "required_facts_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("plan_steps", "evidence_contract_json", "TEXT");
    this.ensureColumn("skill_compliance_assessments", "assessment_profile", "TEXT NOT NULL DEFAULT 'source_grounded'");
    this.ensureColumn("skill_compliance_assessments", "assessment_method", "TEXT NOT NULL DEFAULT 'model'");
    this.ensureColumn("skill_compliance_assessments", "failed_boundary_json", "TEXT");
    this.ensureSkillAssessmentProfileConstraint();
    this.connection.exec("CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_id, created_at)");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.connection.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private renameColumnIfNeeded(table: string, oldColumn: string, newColumn: string, newDefinition: string): void {
    const columns = this.connection.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    const hasOld = columns.some((item) => item.name === oldColumn);
    const hasNew = columns.some((item) => item.name === newColumn);
    if (hasNew) return;
    if (hasOld) {
      this.connection.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldColumn} TO ${newColumn}`);
      return;
    }
    this.connection.exec(`ALTER TABLE ${table} ADD COLUMN ${newColumn} ${newDefinition}`);
  }

  private ensureSkillAssessmentProfileConstraint(): void {
    const row = this.connection.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skill_compliance_assessments'
    `).get() as { sql?: string } | undefined;
    if (row?.sql?.includes("'evidence_gate'")) return;
    this.connection.transaction(() => {
      this.connection.exec(`
        ALTER TABLE skill_compliance_assessments RENAME TO skill_compliance_assessments_old;
        CREATE TABLE skill_compliance_assessments (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          assessment_profile TEXT NOT NULL DEFAULT 'source_grounded'
            CHECK(assessment_profile IN ('deterministic', 'evidence_gate', 'lookup_lite', 'source_grounded', 'risk_sensitive')),
          assessment_method TEXT NOT NULL DEFAULT 'model'
            CHECK(assessment_method IN ('rule', 'model')),
          approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
          criteria_json TEXT NOT NULL,
          skills_json TEXT NOT NULL,
          evidence_digest TEXT NOT NULL,
          feedback TEXT NOT NULL,
          failed_boundary_json TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(plan_id, step_id, attempt),
          FOREIGN KEY(plan_id, step_id) REFERENCES plan_steps(plan_id, step_id) ON DELETE CASCADE
        );
        INSERT INTO skill_compliance_assessments(
          id, plan_id, step_id, attempt, assessment_profile, assessment_method,
          approved, criteria_json, skills_json, evidence_digest, feedback, failed_boundary_json, created_at
        )
        SELECT
          id, plan_id, step_id, attempt, assessment_profile, assessment_method,
          approved, criteria_json, skills_json, evidence_digest, feedback, failed_boundary_json, created_at
        FROM skill_compliance_assessments_old;
        DROP TABLE skill_compliance_assessments_old;
        CREATE INDEX IF NOT EXISTS skill_assessment_step_idx
          ON skill_compliance_assessments(plan_id, step_id, attempt DESC);
      `);
    });
  }
}

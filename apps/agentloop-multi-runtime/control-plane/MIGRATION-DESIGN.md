# Control-plane migration boundary (WP-0)

`cp_*` schema ownership is reserved for a separate one-shot deployment job. This work package intentionally registers no DDL and opens no database connection.

Later migrations will be immutable, checksum-addressed entries executed through `ControlPlaneMigrationPort` for `sqlite`, `postgres`, and `tidb`. They will own only the following table names: `cp_resources`, `cp_releases`, `cp_target_assignments`, `cp_apply_receipts`, `cp_integration_bindings`, `cp_skill_artifacts`, `cp_secret_references`, `cp_audit_events`, and `cp_delivery_cursors`.

The Admin API, Router, Cloud Host, and Local Agent startup paths must only verify delivery/application readiness after that separate job has run; they must never create these tables.

import type { ControlPlaneDialect, ControlPlaneMigration } from "../../../control-plane/domain/ports.ts";

/** Contract fixture only: it does not contain SQL and is never applied by startup code. */
export const CONTROL_PLANE_MIGRATION_FIXTURE: Readonly<{
  dialects: readonly ControlPlaneDialect[];
  expectedTableNames: readonly string[];
  migration: ControlPlaneMigration;
}> = {
  dialects: ["sqlite", "postgres", "tidb"],
  expectedTableNames: [
    "cp_resources", "cp_releases", "cp_target_assignments", "cp_apply_receipts", "cp_integration_bindings",
    "cp_skill_artifacts", "cp_secret_references", "cp_credential_grants", "cp_integration_invocations", "cp_audit_events", "cp_delivery_cursors",
  ],
  migration: {
    id: "control-plane/0001_initial",
    checksum: "fixture-not-applied",
    description: "Reserved initial control-plane schema for a later one-shot migration job",
  },
};

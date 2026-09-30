import type { ApplyReceipt, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeTarget, TargetAssignment } from "../contracts/index.ts";

/** Ports describe later persistence/delivery work without selecting SQL, HTTP, or a secret provider. */
export interface ReleaseRepositoryPort {
  getRelease(releaseId: string): Promise<ResourceRelease | undefined>;
  listAssignments(resourceId: string): Promise<readonly TargetAssignment[]>;
}

export interface ConfigurationDeliveryPort {
  desiredSnapshot(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot | undefined>;
  recordReceipt(receipt: ApplyReceipt): Promise<void>;
}

export type ControlPlaneDialect = "sqlite" | "postgres" | "tidb";

export interface ControlPlaneMigration {
  readonly id: string;
  readonly checksum: string;
  readonly description: string;
}

/** One-shot migration execution is a deployment concern; application startup never receives this port. */
export interface ControlPlaneMigrationPort {
  appliedMigrations(): Promise<readonly { readonly id: string; readonly checksum: string }[]>;
  apply(migration: ControlPlaneMigration, dialect: ControlPlaneDialect): Promise<void>;
}

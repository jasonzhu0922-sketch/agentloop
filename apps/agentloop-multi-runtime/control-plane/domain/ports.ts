import type {
  ApplyReceipt, CreateTargetAssignmentCommand, PublishReleaseCommand, RecordApplyReceiptCommand,
  ControlPlaneResource, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeTarget, TargetAssignment, TransitionReleaseCommand,
} from "../contracts/index.ts";

/** Ports describe later persistence/delivery work without selecting SQL, HTTP, or a secret provider. */
export interface ReleaseRepositoryPort {
  getRelease(releaseId: string): Promise<ResourceRelease | undefined>;
  listAssignments(resourceId: string): Promise<readonly TargetAssignment[]>;
}

export interface ConfigurationDeliveryPort {
  desiredSnapshot(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot | undefined>;
  recordReceipt(receipt: ApplyReceipt): Promise<void>;
}

/** Read side used to resolve a target snapshot without exposing SQL to the domain/application layer. */
export interface ConfigurationSnapshotRepositoryPort extends ReleaseRepositoryPort {
  listResources(): Promise<readonly ControlPlaneResource[]>;
  configurationRevision(): Promise<number>;
  skillPackageHash(releaseId: string): Promise<string | undefined>;
}

/** Write boundary used by application services; adapters own transactions and audit persistence. */
export interface ControlPlaneWritePort extends ReleaseRepositoryPort {
  publishRelease(command: PublishReleaseCommand): Promise<ResourceRelease>;
  createTargetAssignment(command: CreateTargetAssignmentCommand): Promise<TargetAssignment>;
  transitionRelease(command: TransitionReleaseCommand): Promise<ResourceRelease>;
  recordApplyReceipt(command: RecordApplyReceiptCommand): Promise<void>;
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

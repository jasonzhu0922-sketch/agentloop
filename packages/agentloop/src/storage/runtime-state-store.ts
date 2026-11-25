/** Durable transaction log. The relational query view is disposable; this log is authoritative. */
export interface RuntimeStateCommit {
  readonly format: "agentloop.runtimeState/v1";
  readonly id: string;
  readonly version: number;
  readonly schema: readonly string[];
  readonly changeset: string;
  readonly snapshot?: readonly { table: string; rows: readonly Record<string, unknown>[] }[];
  readonly checksum: string;
}
export interface RuntimeStateStore {
  /** Opens an exclusively scheduled Runtime namespace. No writer lease is acquired. */
  open(): Promise<void>;
  read(afterVersion: number, limit: number): Promise<readonly RuntimeStateCommit[]>;
  /** Atomic expected-version check and idempotent append. Must acknowledge durable storage. */
  append(commit: RuntimeStateCommit): Promise<void>;
  receipt(id: string): Promise<number | undefined>;
  assertAdmissionCapacity?(): Promise<void>;
  close(): Promise<void>;
}

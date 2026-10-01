import type { LocalRuntimeDefinition } from "./runtime-supervisor.ts";

/** Deployment and device configuration used to compose the Local Agent. */
export interface LocalAgentOptions {
  readonly appRoot: string;
  readonly routerUrl?: string;
  readonly statePath: string;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly skillPackageStoreRoot: string;
  readonly maxConcurrentRuns?: number;
  readonly runtimeDataRoot?: string;
  readonly supervisorDatabasePath?: string;
  readonly providerConfigPath: string;
  /** Optional device delivery endpoint. Its token/scope identity comes from LocalAgentState, never this configuration. */
  readonly controlPlaneDeliveryUrl?: string;
  readonly controlPlane?: { readonly deliveryUrl: string; readonly deviceId: string; readonly deviceToken: string; readonly scopeId: string; readonly devicePrivateKey: string };
  readonly skillDirectoriesConfigPath: string;
  readonly stepExecutionStrategyConfigPath: string;
  readonly practiceProfileConfigPath?: string;
  readonly computerCommandEnvironment?: Readonly<Record<string, string>>;
  readonly integrationEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly webOrigin?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly runEventLogSink?: (runtime: LocalRuntimeDefinition, line: string) => void;
}

import type { LocalRuntimeDefinition } from "../service/runtime-supervisor.ts";

/** Deployment and device configuration used to compose the Local Agent. */
export interface LocalAgentOptions {
  readonly appRoot: string;
  readonly routerUrl?: string;
  readonly statePath: string;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly skillPackageStoreRoot: string;
  readonly maxConcurrentRuns?: number;
  /** Bounded Planner contract-repair turns for each device-local Runtime. */
  readonly planningMaxTurns?: number;
  /** Bounded model turns for each executable Plan step on this device. */
  readonly stepMaxTurns?: number;
  readonly runtimeDataRoot?: string;
  readonly supervisorDatabasePath?: string;
  readonly providerConfigPath: string;
  readonly skillDirectoriesConfigPath: string;
  readonly stepExecutionStrategyConfigPath: string;
  readonly practiceProfileConfigPath?: string;
  readonly mcpServersConfigPath?: string;
  readonly computerCommandEnvironment?: Readonly<Record<string, string>>;
  readonly integrationEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly webOrigin?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly runEventLogSink?: (runtime: LocalRuntimeDefinition, line: string) => void;
}

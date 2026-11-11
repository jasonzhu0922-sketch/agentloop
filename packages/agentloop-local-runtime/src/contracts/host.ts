import type { AppDatabase, ModelAdapter, ModelFactory, ModelRetryReporter, RunService, McpServerRegistration, WebToolsOptions, SkillLoadDiagnostic } from "@zhujun/agentloop";
import type { MemoryStore } from "@zhujun/agentloop-memory";
import type { ConnectorConnection } from "@zhujun/agentloop-connector-sdk";
import type { ConnectorConnectionRuntime, ConnectorModuleRegistration } from "../connectors/index.ts";
import type { LocalDirectoryScopeStore } from "../persistence/directory-scope-store.ts";
import type { LocalRuntimeDatabaseRegistry } from "../memory/local-runtime-database-registry.ts";

/** Already authenticated by the embedding host; never decoded from a request body. */
export interface LocalExecutionContext { readonly ownerUserId: string }

export interface LocalIdentityPort { installationId(): Promise<string> }

export interface LocalSecretStorePort {
  write(values: Readonly<Record<string, string>>): Promise<string>;
  read(reference: string): Promise<Readonly<Record<string, string>> | undefined>;
  remove(reference: string): Promise<void>;
  replace?(reference: string, values: Readonly<Record<string, string>>): Promise<void>;
}

/** Keys are provider-local; the local Runtime qualifies them with `local:`. */
export interface LocalModelProviderPort {
  modelKeys(): readonly string[];
  create(key: string, onRetry?: ModelRetryReporter): ModelAdapter;
}

export interface ResolvedLocalModelConfiguration {
  readonly configured: boolean;
  readonly reuseCloudModels: boolean;
  readonly registryConfig: unknown;
  readonly environment: Readonly<Record<string, string | undefined>>;
}
export interface LocalModelConfigurationPort { current(): ResolvedLocalModelConfiguration }

export interface LocalConnectorRuntimeResolution {
  readonly modules: readonly ConnectorModuleRegistration[];
  readonly connections: readonly ConnectorConnection[];
  readonly runtime: ConnectorConnectionRuntime;
}
export interface LocalConnectorConfigurationPort {
  resolve(runtimeId: string): Promise<LocalConnectorRuntimeResolution>;
}

export interface ResolvedLocalRuntimeConfiguration {
  readonly skillDiagnostics?: readonly SkillLoadDiagnostic[];
  readonly modelConfiguration?: ResolvedLocalModelConfiguration;
  readonly customSkillDirectories: readonly string[];
  readonly mcpServers: readonly McpServerRegistration[];
  readonly integrationEnvironment: Readonly<Record<string, string | undefined>>;
  /** Account-scoped web search configuration. The API key is resolved only
   * inside the Runtime factory and is never part of the management projection. */
  readonly webSearch?: WebToolsOptions;
  readonly memory?: { readonly enabled: boolean; readonly settlementModelKey?: string };
}

export interface LocalRuntimeDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly storageKey: string;
  readonly isDefault: boolean;
}

/** Transitional trusted-host API for the existing Supervisor, not a UI API. */
export interface LocalRuntimeControl extends LocalRuntimeDefinition {
  readonly skillDiagnostics?: readonly SkillLoadDiagnostic[];
  readonly database: AppDatabase;
  readonly runs: RunService;
  readonly scopes: LocalDirectoryScopeStore;
  readonly modelKeys: readonly string[];
  readonly assertModelAvailable?: (modelKey: string) => void;
  readonly connectorConnectionIds: readonly string[];
  readonly activeRunIds: Set<string>;
  readonly memory?: { readonly store: MemoryStore; readonly tenantId: string };
  readonly close?: () => Promise<void>;
}

type KernelOptions = ConstructorParameters<typeof RunService>[0];
export interface LocalRuntimeExecutionPolicy {
  readonly stepExecutionStrategy?: KernelOptions["stepExecutionStrategy"];
  readonly practiceProfileCatalog?: KernelOptions["practiceProfileCatalog"];
}

export interface LocalRuntimeHostOptions {
  readonly databasePath: string;
  readonly runtimeDataRoot?: string;
  readonly skillPackageStoreRoot: string;
  readonly extensionBaseDirectory?: string;
  readonly providerConfigPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly integrationEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly planningMaxTurns?: number;
  readonly stepMaxTurns?: number;
  readonly computerCommandEnvironment?: Readonly<Record<string, string>>;
  readonly computerCommandSandbox?: KernelOptions["computerCommandSandbox"];
  readonly runEventLogSink?: (runtime: LocalRuntimeDefinition, line: string) => void;
  readonly loadExecutionPolicy?: () => Promise<LocalRuntimeExecutionPolicy>;
  readonly identity?: LocalIdentityPort;
  readonly models?: LocalModelProviderPort;
  readonly cloudModelFactory?: ModelFactory;
  readonly databases?: LocalRuntimeDatabaseRegistry;
  readonly webToolsOptions?: WebToolsOptions;
}

export class LocalRuntimeSupervisorError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

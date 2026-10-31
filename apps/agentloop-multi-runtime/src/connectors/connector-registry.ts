import type {
  ConnectorDefinition,
  ConnectorInstance,
  ConnectorModule,
  ConnectorConnection,
  ConnectorConnectionInput,
  CredentialProvider,
} from "@zhujun/agentloop-connector-sdk";

export interface RegisteredConnector {
  readonly module: ConnectorModule;
  readonly installedAt: number;
  readonly enabled: boolean;
}

export class ConnectorRegistry {
  private readonly modules = new Map<string, RegisteredConnector>();

  register(module: ConnectorModule, options: { enabled?: boolean } = {}): void {
    const key = module.definition.manifest.key;
    const version = module.definition.manifest.version;
    const registryKey = `${key}@${version}`;
    if (this.modules.has(registryKey)) {
      throw new Error(`Connector already registered: ${registryKey}`);
    }
    this.modules.set(registryKey, {
      module,
      installedAt: Date.now(),
      enabled: options.enabled ?? true,
    });
  }

  enable(key: string, version: string): void {
    this.updateEnabled(key, version, true);
  }

  disable(key: string, version: string): void {
    this.updateEnabled(key, version, false);
  }

  list(): readonly RegisteredConnector[] {
    return [...this.modules.values()];
  }

  resolve(key: string, version?: string): ConnectorModule {
    const matches = this.list().filter((item) =>
      item.module.definition.manifest.key === key
      && item.enabled
      && (version === undefined || item.module.definition.manifest.version === version)
    );
    if (matches.length === 0) throw new Error(`Enabled Connector not found: ${key}${version ? `@${version}` : ""}`);
    if (matches.length > 1) throw new Error(`Multiple enabled versions for Connector: ${key}`);
    return matches[0].module;
  }

  async connect(input: {
    connectorKey: string;
    version?: string;
    connection: ConnectorConnection;
    credentialProvider: CredentialProvider;
  }): Promise<ConnectorInstance> {
    const module = this.resolve(input.connectorKey, input.version);
    const connectionInput: ConnectorConnectionInput = {
      connection: input.connection,
      credentialProvider: input.credentialProvider,
    };
    return module.connect(connectionInput);
  }

  private updateEnabled(key: string, version: string, enabled: boolean): void {
    const registryKey = `${key}@${version}`;
    const registered = this.modules.get(registryKey);
    if (registered === undefined) throw new Error(`Connector not registered: ${registryKey}`);
    this.modules.set(registryKey, { ...registered, enabled });
  }
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export type ConnectorRisk = "low" | "medium" | "high";
export type ConnectorSourceKind =
  | "api"
  | "database"
  | "dataset"
  | "document"
  | "spreadsheet"
  | "email"
  | "attachment"
  | "repository"
  | "web";
export type ConnectorEvidenceKind =
  | "source_summary"
  | "source_urls"
  | "schema_summary"
  | "record_counts"
  | "table_coverage"
  | "structured_extraction_artifact"
  | "artifact_path"
  | "explicit_caveats"
  | "delivery_receipt";

export interface ConnectorManifest {
  readonly schema: "agentloop.connectorManifest/v1";
  readonly key: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly agentloopSdk: string;
  readonly apiVersion?: string;
}

export interface ConnectorCapabilityDefinition {
  readonly id: string;
  readonly category: "source" | "read" | "write" | "event";
  readonly label: string;
  readonly description: string;
  readonly sourceKinds?: readonly ConnectorSourceKind[];
  readonly producesEvidenceKinds?: readonly ConnectorEvidenceKind[];
  readonly risk: ConnectorRisk;
  readonly replaySafe: boolean;
  readonly requiresConfirmation?: boolean;
}

export interface ConnectorDefinition {
  readonly manifest: ConnectorManifest;
  readonly capabilities: readonly ConnectorCapabilityDefinition[];
}

export interface ConnectorOperation {
  readonly id: string;
  readonly capabilityId: string;
  readonly mode: "read" | "write";
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly executionMode: "parallel" | "exclusive";
  readonly replaySafe: boolean;
  readonly timeoutMs?: number;
  readonly requiresConfirmation?: boolean;
}

export interface ConnectorConnection {
  readonly id: string;
  readonly connectorKey: string;
  readonly ownerType: "user" | "workspace";
  readonly ownerId: string;
  readonly externalAccountId?: string;
  readonly scopes: readonly string[];
  readonly credentialRef: string;
  readonly status: "active" | "expired" | "revoked" | "error";
}

export interface ConnectorConnectionInput {
  readonly connection: ConnectorConnection;
  readonly credentialProvider: CredentialProvider;
}

export interface CredentialProvider {
  get(credentialRef: string): Promise<Readonly<Record<string, string>>>;
}

export interface ConnectorExecutionContext {
  readonly runId: string;
  readonly actorUserId: string;
  readonly workspaceId?: string;
  readonly connection: ConnectorConnection;
  readonly credentialProvider: CredentialProvider;
  readonly signal?: AbortSignal;
}

export interface ConnectorExecutionResult {
  readonly operationId: string;
  readonly data: unknown;
  readonly externalRequestId?: string;
  readonly sourceRefs?: readonly Record<string, unknown>[];
  readonly warnings?: readonly string[];
  readonly retryable?: boolean;
}

export interface CanonicalConnectorEvidence {
  readonly schema: "agentloop.connectorEvidence/v1";
  readonly evidenceId: string;
  readonly connectorKey: string;
  readonly connectionId: string;
  readonly operationId: string;
  readonly sourceRefs: readonly Record<string, unknown>[];
  readonly facts: readonly Record<string, unknown>[];
  readonly evidenceKinds: readonly ConnectorEvidenceKind[];
  readonly retrievedAt: number;
  readonly caveats: readonly string[];
  readonly contentHash?: string;
}

export interface ConnectorEvidenceMapper {
  map(
    result: ConnectorExecutionResult,
    context: ConnectorExecutionContext,
  ): readonly CanonicalConnectorEvidence[];
}

export interface ConnectorInstance {
  readonly definition: ConnectorDefinition;
  readonly connection: ConnectorConnection;
  readonly operations: readonly ConnectorOperation[];
  execute(
    operationId: string,
    input: unknown,
    context: ConnectorExecutionContext,
  ): Promise<ConnectorExecutionResult>;
  mapEvidence(
    result: ConnectorExecutionResult,
    context: ConnectorExecutionContext,
  ): readonly CanonicalConnectorEvidence[];
}

export interface ConnectorProjection {
  readonly connectorKey: string;
  readonly connectorVersion: string;
  readonly capabilities: readonly ConnectorCapabilityDefinition[];
  readonly operations: readonly ConnectorOperation[];
  readonly runtimeTools: readonly unknown[];
}

export interface ConnectorModule {
  readonly definition: ConnectorDefinition;
  connect(input: ConnectorConnectionInput): Promise<ConnectorInstance>;
  project(input: {
    instance: ConnectorInstance;
    runId: string;
    actorUserId: string;
    workspaceId?: string;
  }): Promise<ConnectorProjection>;
}
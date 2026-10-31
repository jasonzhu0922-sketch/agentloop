export type {
  ConnectorDefinition,
  ConnectorManifest,
  ConnectorCapabilityDefinition,
  ConnectorOperation,
  ConnectorConnection,
  ConnectorConnectionInput,
  ConnectorExecutionContext,
  ConnectorExecutionResult,
  ConnectorInstance,
  ConnectorModule,
  ConnectorProjection,
  ConnectorEvidenceMapper,
  CanonicalConnectorEvidence,
  CredentialProvider,
  JsonSchema,
  ConnectorRisk,
  ConnectorSourceKind,
  ConnectorEvidenceKind,
} from "./types.ts";

export {
  connectorSourceDescriptor,
  connectorPlanningCapabilities,
  connectorOperationTools,
} from "./agentloop-adapter.ts";

export type { PlanningCapabilityProjection } from "./agentloop-adapter.ts";
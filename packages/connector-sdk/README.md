# AgentLoop Connector SDK

The Connector SDK defines the platform-neutral contract for external system integrations.

A Connector module owns its platform definition, connection lifecycle, capabilities,
operations, execution and evidence mapping. Applications own persistence and
authorization records. Runtime Hosts instantiate Connector instances and project
their operations into AgentLoop tools.

## Boundaries

- `ConnectorModule`: self-contained external-system integration.
- `ConnectorConnection`: an application-owned authorized connection reference.
- `ConnectorOperation`: a read/write operation with risk and replay semantics.
- `ConnectorProjection`: the runtime view exposed to AgentLoop.
- `CanonicalConnectorEvidence`: normalized evidence returned to the kernel.

This package intentionally contains no database adapter, OAuth UI, provider-specific
API client or application persistence implementation.

## Current status

This is the foundation contract on `feature/connectors-foundation`. The next
implementation stages are:

1. Add the AgentLoop RuntimeTool and PlanningCapability projection adapter.
2. Add Runtime ConnectorRegistry and ConnectionResolver.
3. Implement the Feishu read-only Connector.
4. Add the 126 mail and Kingsoft/WPS document Connectors.
5. Add an optional MCP adapter over the same Connector modules.

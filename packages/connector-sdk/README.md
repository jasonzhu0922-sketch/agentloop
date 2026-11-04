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
API client or application persistence implementation. Connector modules are loaded
by Runtime registration and do not need to be compile-time dependencies of the
Multi Runtime application.

Connector manifests may declare stable service `aliases` in addition to their
`key` and `displayName`. The host may supply a connection `displayName` for an
individual account. The SDK projects these names into ToolSource aliases so an
explicit user request can be resolved against the authorized Run catalog. A
name shared by multiple connections remains ambiguous and cannot select one.

`connectorOperationTools` preserves canonical Connector evidence for audit and
also projects it as `agentloop.toolEvidenceReceipt/v1`, the neutral receipt used
by ordinary MCP tools. The receipt preserves source references, facts and
caveats. Semantic kinds must be both declared by the executing operation's
capability and present in returned, connection/operation-bound evidence with
facts; capability inventory alone never becomes proof. Mismatched evidence
identity and mismatched result operation IDs fail closed. The adapter does not
invent a file artifact or relax the kernel's evidence admission rules.

## Current status

This is the foundation contract on `feature/connectors-foundation`. The next
implementation stages are:

1. Add the AgentLoop RuntimeTool and PlanningCapability projection adapter.
2. Add Runtime ConnectorRegistry and ConnectionResolver.
3. Implement the Feishu read-only Connector.
4. Add the 126 mail and Kingsoft/WPS document Connectors.
5. Add an optional MCP adapter over the same Connector modules.

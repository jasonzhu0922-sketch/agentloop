# AgentLoop Feishu Connector

Read-only Feishu connector foundation.

Current operations:

- `document.search`
- `document.read`

The package owns Feishu API access and maps responses to Connector evidence.
Applications own OAuth, connection persistence and credential storage.
Runtime Hosts create an instance from an authorized ConnectionRecord.

Write operations and tenant-specific resource filtering are intentionally deferred
until the read-only execution path is validated.

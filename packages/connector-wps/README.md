# AgentLoop Kingsoft/WPS Connector

Read-only Kingsoft/WPS online document connector foundation.

The package keeps WPS API details behind a `WpsDocumentTransport` adapter.
The Connector owns capabilities, operations and Evidence mapping; the
application owns Connection and credential persistence; the Runtime Host
instantiates the transport for an authorized Connection.

Current operations:

- `document.search`
- `document.read`
- `spreadsheet.read`

Write operations and automatic export are deferred until the read-only path and
resource scope policy are validated.

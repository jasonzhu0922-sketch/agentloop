# AgentLoop Kingsoft/WPS Connector

Read-only Kingsoft/WPS online document connector.

The configured module calls WPS's standard Cloud Document REST APIs. Its user
access token is acquired through the Local Agent's WPS OAuth callback and is
kept in that device's encrypted Secret Store. Users do not enter an endpoint
or a token in the Connector dialog.

The generic `WpsDocumentTransport` factory remains exported for tests or a
separately managed transport, while `createConfiguredWpsConnector` uses the
WPS-owned REST API origin. WPS document reads resolve the required `driveId`
from file metadata when it was not supplied by the caller.

Current operations:

- `document.search`
- `document.read`
- `spreadsheet.read`

The configured OAuth scopes are `kso.file.read` and
`kso.file_search.readwrite`, which are the user-level REST scopes currently
available in the WPS app console. Write operations and automatic export are
deliberately not enabled.

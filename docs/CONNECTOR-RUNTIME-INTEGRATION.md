# Connector Runtime Integration

The Multi Runtime Host resolves Connector tools per Run.

## Module registration

Multi Runtime does not import platform Connector packages at compile time. The
Host loads self-contained Connector modules from `CONNECTOR_MODULES_JSON`:

```json
[
  {
    "modulePath": "/opt/agentloop/connectors/feishu/dist/index.js",
    "exportName": "feishuConnector"
  }
]
```

The module path may point to a separately deployed Connector bundle or package.
A Connector can be upgraded, disabled or rolled back by changing the Runtime
registration configuration without changing the Host application.

## Run contract

A dispatch may carry application-authorized connection IDs:

```json
{
  "connectorConnectionIds": ["conn_feishu_user_1"]
}
```

The Host resolves each ID through its application-side ConnectionResolver.
The ID alone does not grant access: the resolver must enforce the Run owner and
Workspace scope.

## Development configuration

The Local Agent presents a built-in Connector catalog and owns the module
registration details. The packaged Agent ships Feishu, 126 Mail and WPS
Connector bundles. 126 Mail connects directly using the locally encrypted
mailbox account and client authorization code over IMAP. WPS uses WPS Cloud
Document REST APIs after its Local Agent OAuth callback has stored the user
token in the local encrypted Secret Store; no endpoint or access token is
entered in the browser.

For WPS OAuth, the device owner creates a WPS Open Platform application and
adds its registered application credentials to the Local Agent's private
`.env` file. The user then only clicks **Connect** in the Connector dialog:

```ini
WPS_OAUTH_CLIENT_ID=
WPS_OAUTH_CLIENT_SECRET=
WPS_OAUTH_REDIRECT_URI=http://127.0.0.1:18790/v1/local-connectors/kingsoft-wps/callback
WPS_OAUTH_SCOPES=kso.file.read,kso.file_search.readwrite
```

The redirect URI must exactly match the one registered in WPS Open Platform.
Never place these values, an authorization code, or a refresh token in a
Runtime JSON configuration or a cloud-side Router setting.

The WPS application must be a third-party/personal application that has been
approved for the listed user-level REST scopes. The current WPS permission
catalog exposes these as `kso.file.read` and
`kso.file_search.readwrite`; use the exact names shown in the app console.
The Cloud Document MCP scope is not required and must not be configured for
this Connector. Do not start authorization until both requested permissions
are approved.

The current Host foundation includes an environment-backed resolver for local
development. Configure connection metadata with `CONNECTOR_CONNECTIONS_JSON`:

```json
[
  {
    "id": "conn_feishu_user_1",
    "connectorKey": "feishu",
    "ownerType": "user",
    "ownerId": "user-1",
    "scopes": ["document:read", "document:search"],
    "credentialRef": "FEISHU_USER_1_CREDENTIAL",
    "status": "active"
  }
]
```

The credential reference points to an environment variable. Its value may be a
JSON object such as:

```json
{"accessToken":"..."}
```

or a plain value, which the development resolver treats as `accessToken`.
Production deployments should replace this resolver with an application-backed
ConnectionStore and a Vault/KMS-backed CredentialProvider.

## Execution path

```text
RuntimeDispatchEnvelope.connectorConnectionIds
→ RunService.parseExecuteOptions
→ RunToolProvider.resolve
→ ConnectorRuntimeService
→ ConnectorRegistry
→ ConnectorInstance
→ RuntimeTool projection
→ Planner / Admission / Step Agent Loop
```

Connector tools are scoped to the Run. They are not global tools and are not
available when the Run has no authorized connection IDs.

# Connector Runtime Integration

The Multi Runtime Host resolves Connector tools per Run.

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

The current Host foundation registers the Feishu read-only Connector. The 126 Mail and WPS packages expose transport-factory-based modules; their IMAP or platform API transports will be registered when the application supplies those adapters.

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

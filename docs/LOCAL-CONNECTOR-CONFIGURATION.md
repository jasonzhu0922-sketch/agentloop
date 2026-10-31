# Local Connector Configuration

Personal Connectors are configured inside the Local Agent. Cloud Runtime does not
load or resolve these connections.

## API

For a local Runtime:

```text
GET    /v1/local-runtimes/:runtimeId/connectors
POST   /v1/local-runtimes/:runtimeId/connectors
DELETE /v1/local-runtimes/:runtimeId/connectors/:connectorId
```

Example:

```json
{
  "connector": {
    "connectorKey": "feishu",
    "displayName": "我的飞书",
    "modulePath": "/opt/agentloop/connectors/feishu/dist/index.js",
    "exportName": "feishuConnector",
    "enabled": true,
    "config": {},
    "externalAccountId": "account-1",
    "scopes": ["document:read"],
    "credentials": {
      "accessToken": "stored by the Local Agent secret store"
    }
  }
}
```

The credential is written to the encrypted Local Agent secret store. The
configuration response only returns `credentialConfigured`, never the secret.

The Local Runtime loads enabled Connector modules and their Connection records
when it creates a Runtime. A Runtime restart is required after changing module
registration or connection configuration in the current foundation version.

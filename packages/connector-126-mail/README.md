# AgentLoop 126 Mail Connector

Read-only 126 Mail Connector.

The configured Local Agent module connects directly to 126 Mail over IMAP:

- credentials are stored only in the Local Agent encrypted Secret Store;
- set `credentials.email` (or `credentials.username`) to the 126 address;
- set `credentials.authorizationCode` to the client authorization code generated
  in 126 Mail settings (not the web-login password);
- the default connection is `imap.126.com:993` with TLS. `host`, `port` and
  `secure` are optional Connector config overrides for managed deployments.

The package still exposes `create126MailConnector()` for applications that
need to supply another approved mail transport programmatically.

Current operations:

- `email.search`
- `email.read`

Write operations, sending mail and automatic attachment materialization are
deferred until the read-only path and idempotency policy are validated.

# AgentLoop 126 Mail Connector

Read-only 126 Mail connector foundation.

The package separates 126 Mail account management from the mail protocol:

- the Connector owns capabilities, operations and Evidence mapping;
- the application owns Connection and credential persistence;
- the Runtime Host supplies a `MailTransport`;
- the transport may be IMAP, an enterprise mail gateway or another approved adapter.

Current operations:

- `email.search`
- `email.read`

Write operations, sending mail and automatic attachment materialization are
deferred until the read-only path and idempotency policy are validated.

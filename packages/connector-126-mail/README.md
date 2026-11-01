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
- `email.count`
- `email.read`

`email.search` accepts optional literal `query`, a pair of `receivedAtGte` /
`receivedAtLt` RFC3339 bounds, `folder` (default `INBOX`), `limit` (1–100) and
`offset`. Supply text or a time range. A date in `query` is only a text match;
it is never interpreted as a received-time filter. The result is an object
containing `messages`, exact `totalMatches`, `returnedCount`, `complete`, optional
`nextOffset`, and the actual query `scope`. The number of returned messages is
not necessarily the total count. Custom `MailTransport` implementations must
implement this result contract and the new `count` method, not return a bare array.

`email.count` requires both time bounds plus an IANA `timeZone`. It returns an
exact `count` and `dailyCounts` (including zero days and computed English
`weekday` labels for the query's civil dates) for that folder and optional
text restriction, with `complete`, `temporalCoverage`, `scope` and `observedAt`.
Bounds are start-inclusive/end-exclusive. Counting uses the server's IMAP
`INTERNALDATE`, not the sender-controlled Date header. Today is only observed up
to the query snapshot; the rest of the day is not a prediction. No envelope,
message body, or attachment is fetched for statistics.

IMAP day predicates acquire a padded superset; exact offset-aware filtering is
then performed on INTERNALDATE metadata in bounded batches. Counts are not
capped at the 100-message search page. Requests spanning more than 366 days or
100000 candidate messages fail explicitly, as do incomplete metadata and a
mailbox changing during retrieval. These failures never produce a false zero.
`INBOX` does not mean all mailbox folders.

The capability catalog declares `schema_summary` and `record_counts` for
search/count, and each successful result carries operation-bound canonical
evidence with the actual scope, observation time, payload SHA-256, counts and
pagination caveats. The shared Connector SDK projects this into the same
`agentloop.toolEvidenceReceipt/v1` consumed for ordinary MCP tools; no mail
provider routing or relaxed Runtime assessment is needed. A partial search
page proves its exact matching total, not possession of every matching record.
Inline counts do not claim `structured_extraction_artifact`: if a plan actually
needs a file, use normal Runtime result materialization.

Custom transports must preserve exact scope and pagination, consistent totals,
complete zero-inclusive daily groups and received-time metadata. Inconsistent
results and duplicate/invalid IMAP UIDs are rejected before count evidence is
issued. Mailbox totals are observations of currently present messages, not a
historical audit of mail that has since been deleted or moved.

Reads decode MIME multipart bodies, transfer encodings and declared character
sets, returning plain text and/or HTML separately from attachment metadata.
Messages over 10 MiB and incomplete downloads are rejected explicitly rather
than returned as silently truncated content. HTML is untrusted source content,
not instructions or safe-to-render markup.

Write operations, sending mail and automatic attachment materialization are
deferred until the read-only path and idempotency policy are validated.

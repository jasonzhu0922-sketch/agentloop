# Control-plane migration ownership

Admin persistence belongs to the dedicated `agentloop_admin` database, not Router or Runtime databases. The same executable `cp_*` migrations support SQLite, PostgreSQL, and TiDB; select the backend with `AGENTLOOP_ADMIN_DATABASE_PATH` (SQLite) or `AGENTLOOP_ADMIN_DATABASE_URL` (`postgresql://` or `mysql://`). TiDB provisioning remains available through `provision:admin-database`, while PostgreSQL databases are provisioned by the platform and SQLite creates its file on first open. The one-shot command is `npm run migrate:control-plane -- --apply`; it maintains `cp_schema_migrations` independently from Router's `mr_schema_migrations`.

No application startup path runs this command or creates `cp_*` tables.

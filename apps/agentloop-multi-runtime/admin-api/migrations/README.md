# Control-plane migration ownership

TiDB schema means database. Admin persistence belongs to the dedicated `agentloop_admin` database, not Router or Runtime databases. First run `npm run provision:admin-database -- --apply` with an explicit `AGENTLOOP_ADMIN_SERVER_URL`, then set `AGENTLOOP_ADMIN_DATABASE_URL` to the resulting database URL. Executable `cp_*` DDL is deliberately kept in the typed persistence migration module, not as startup SQL in this directory. The one-shot command is `npm run migrate:control-plane -- --apply`; it maintains `cp_schema_migrations` independently from Router's `mr_schema_migrations`.

No application startup path runs this command or creates `cp_*` tables.

# Control-plane migration ownership

Executable `cp_*` DDL is deliberately kept in the typed persistence migration module, not as startup SQL in this directory. The one-shot command is `npm run migrate:control-plane -- --apply` and requires an explicit TiDB `CONTROL_PLANE_DATABASE_URL`; it maintains `cp_schema_migrations` independently from Router's `mr_schema_migrations`.

No application startup path runs this command or creates `cp_*` tables.

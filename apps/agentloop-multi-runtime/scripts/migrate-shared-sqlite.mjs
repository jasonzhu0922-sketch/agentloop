// Stable operator-facing name; the implementation remains shared so the
// SQLite and PostgreSQL/TiDB paths cannot drift into separate DDL.
if (!process.argv.includes("--driver")) process.argv.splice(2, 0, "--driver", "sqlite");
await import("./migrate-shared-state.mjs");

// Stable operator-facing name; the implementation remains shared so the
// PostgreSQL and TiDB/SQLite paths cannot drift into separate DDL.
if (!process.argv.includes("--driver")) process.argv.splice(2, 0, "--driver", "postgres");
await import("./migrate-shared-state.mjs");

export { IdentityService, IdentityError, installIdentitySchema, type Principal, type IdentitySession } from "./service.ts";
export { AccountServiceClient, authBaseUrl, localAccountId, type CloudAuthPort, type CloudPrincipal, type CloudSession } from "./client.ts";
export { RemoteIdentityService } from "./remote.ts";
export { TIDB_IDENTITY_SCHEMA_SQL } from "./tidb-schema.ts";
export { migrateIdentityRows, rewriteIdentityReferences, clearLegacyIdentityRows, type IdentityMigrationResult } from "./migration.ts";

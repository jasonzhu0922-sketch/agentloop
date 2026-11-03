import type { AppDatabase } from "@zhujun/agentloop";
import { IdentityService as SharedIdentityService } from "@zhujun/agentloop-identity";
import { migrateRouterState } from "../persistence/state-migrations.ts";
export { IdentityError, installIdentitySchema, type Principal, type IdentitySession } from "@zhujun/agentloop-identity";

/** Router migrations remain host-owned; credential semantics are shared with the standalone account service. */
export class IdentityService extends SharedIdentityService {
  constructor(database: AppDatabase, sessionTtlMs = 7 * 24 * 60 * 60 * 1000) {
    super(database, sessionTtlMs, () => migrateRouterState(database));
  }
}

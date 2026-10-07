import { type RuntimeActionRecord, RuntimeActionRepository } from "./runtime-action-repository.ts";

/** Authorized read-only Action history. Recovery and execution mutations remain outside this service. */
export class RuntimeActionQueryService {
  private readonly actions: Pick<RuntimeActionRepository, "list">;
  private readonly authorizeRun: (actorUserId: string, runId: string) => Promise<void>;

  constructor(input: {
    readonly actions: Pick<RuntimeActionRepository, "list">;
    readonly authorizeRun: (actorUserId: string, runId: string) => Promise<void>;
  }) {
    this.actions = input.actions;
    this.authorizeRun = input.authorizeRun;
  }

  async list(actorUserId: string, runId: string): Promise<RuntimeActionRecord[]> {
    await this.authorizeRun(actorUserId, runId);
    return await this.actions.list(runId);
  }
}

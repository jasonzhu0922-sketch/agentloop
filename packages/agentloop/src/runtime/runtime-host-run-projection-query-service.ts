import type { RuntimeDeliveryReceipt } from "./contracts.ts";
import type { RuntimeHostPlanProjection } from "./runtime-plan-query-service.ts";
import type { RuntimeOutcomeProjection } from "./runtime-outcome-query-service.ts";
import type { ProcessArtifact } from "./process-artifacts.ts";
import type { StoredRunEvent } from "./runtime-event-query-service.ts";

export interface RuntimeHostRunProjection<TRun> {
  readonly schema: "agentloop.hostRun/v1";
  readonly run: TRun;
  readonly outcome?: {
    readonly schema: "agentloop.hostOutcome/v1";
    readonly status: string;
    readonly reasonCode: string;
    readonly planId?: string;
    readonly output?: string;
    readonly deliveryReceipt?: RuntimeDeliveryReceipt;
    readonly committedAt: number;
  };
  readonly plan: RuntimeHostPlanProjection;
  readonly artifacts: readonly ProcessArtifact[];
  readonly eventCursor: { readonly lastSeq: number };
}

/**
 * Host-facing composition of persisted Runtime facts. It never infers an
 * Outcome from artifacts or events and has no execution or mutation authority.
 */
export class RuntimeHostRunProjectionQueryService<TRun> {
  private readonly input: {
    readonly run: (actorUserId: string, runId: string) => Promise<TRun>;
    readonly plan: (actorUserId: string, runId: string) => Promise<RuntimeHostPlanProjection>;
    readonly outcome: (runId: string) => Promise<RuntimeOutcomeProjection | undefined>;
    readonly artifacts: (actorUserId: string, runId: string) => Promise<readonly ProcessArtifact[]>;
    readonly events: (actorUserId: string, runId: string) => Promise<readonly StoredRunEvent[]>;
  };

  constructor(input: RuntimeHostRunProjectionQueryService<TRun>["input"]) {
    this.input = input;
  }

  async read(actorUserId: string, runId: string): Promise<RuntimeHostRunProjection<TRun>> {
    const run = await this.input.run(actorUserId, runId);
    const [plan, outcome, artifacts, events] = await Promise.all([
      this.input.plan(actorUserId, runId),
      this.input.outcome(runId),
      this.input.artifacts(actorUserId, runId),
      this.input.events(actorUserId, runId),
    ]);
    return {
      schema: "agentloop.hostRun/v1",
      run,
      ...(outcome === undefined ? {} : { outcome: hostOutcome(outcome) }),
      plan,
      artifacts,
      eventCursor: { lastSeq: events.at(-1)?.seq ?? 0 },
    };
  }
}

function hostOutcome(outcome: RuntimeOutcomeProjection): NonNullable<RuntimeHostRunProjection<unknown>["outcome"]> {
  return {
    schema: "agentloop.hostOutcome/v1",
    status: outcome.status,
    reasonCode: outcome.reasonCode,
    ...(outcome.planId === undefined ? {} : { planId: outcome.planId }),
    ...(outcome.output === undefined ? {} : { output: outcome.output }),
    ...(outcome.deliveryReceipt === undefined ? {} : { deliveryReceipt: outcome.deliveryReceipt }),
    committedAt: outcome.committedAt,
  };
}

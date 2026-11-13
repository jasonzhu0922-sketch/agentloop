import type { AgentLoopToolEvidence, ModelToolCall } from "./contracts.ts";
import type { CurrentDecisionView } from "./current-decision-view.ts";
import type { RuntimeToolProgressPolicy } from "./tool-progress-policy.ts";
import { parseJsonRecord } from "./tool-result-evidence.ts";

export interface ArtifactRepairCheckpoint {
  readonly turnsWithoutDeliveryProgress: number;
  readonly failedToolCallIds: readonly string[];
  readonly observedToolCallIds: readonly string[];
  readonly warning: boolean;
  readonly assessmentRequired: boolean;
}

/**
 * A bounded local repair episode, activated by a failed write operation.
 * File versions, call IDs, diagnostic wording and process-file counts are
 * deliberately absent from the progress milestones. They describe activity,
 * not repaired delivery. Semantic acceptance still belongs to Assessment.
 */
export class ArtifactRepairProgress {
  private readonly milestones = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly observed = new Set<string>();
  private readonly failedExecutions = new Set<string>();
  private turns = 0;

  observe(input: {
    readonly policy?: RuntimeToolProgressPolicy;
    readonly view: CurrentDecisionView;
    readonly latestEvidence: readonly AgentLoopToolEvidence[];
    readonly toolEffect: (name: string) => "read" | "write" | undefined;
    readonly toolCall?: (id: string) => ModelToolCall | undefined;
  }): ArtifactRepairCheckpoint | undefined {
    const { policy, view, latestEvidence } = input;
    const ownsDelivery = policy?.artifactDeliveryRequired === true || policy?.expectedArtifactKind !== undefined
      || policy?.expectedArtifactFormat !== undefined || (policy?.artifactTargets?.length ?? 0) > 0;
    if (!ownsDelivery || view.evidence === undefined || latestEvidence.length === 0) return undefined;
    if (view.evidence.workProduct.status === "accepted" && view.evidence.missingToolEvidenceKinds.length === 0) {
      this.turns = 0; this.failed.clear(); this.observed.clear();
      return undefined;
    }
    const required = new Set(view.evidence.requiredEvidenceKinds);
    const current = view.evidence.satisfiedEvidenceKinds.filter(kind => required.has(kind)).map(kind => `receipt:${kind}`);
    for (const item of latestEvidence) {
      const call = input.toolCall?.(item.toolCallId);
      // This is an operation transition, not an assertion about stdout or
      // artifact correctness. Unrelated exit-0 commands and successful file
      // patches cannot discharge an earlier failed executable invocation.
      if (item.toolName !== "computer_run_command" || !call) continue;
      const args = call.arguments as Record<string, unknown> | null;
      if (!args || typeof args.command !== "string" || !Array.isArray(args.args)) continue;
      const key = JSON.stringify([args.command, args.cwd ?? ".", args.args]);
      if (item.isError || item.operationStatus === "failed") this.failedExecutions.add(key);
      else {
        const result = parseJsonRecord(item.result);
        const receipt = result?.executionReceipt as Record<string, unknown> | undefined;
        if (this.failedExecutions.has(key) && result?.exitCode === 0 && receipt?.schema === "agentloop.commandExecutionReceipt/v1"
          && receipt.startState === "started" && receipt.completionState === "exited") current.push(`recovered_execution:${key}`);
      }
    }
    if (["deliverable_available", "accepted"].includes(view.evidence.workProduct.status)) current.push("delivery:produced");
    if (view.evidence.workProduct.status === "accepted") current.push("delivery:accepted");
    for (const target of view.workProducts.deliveryTargets) current.push(`target:${target.targetId}`);
    // Only Runtime-observed, current-version checks count. Model declarations
    // and successful mutations cannot assert that an issue was resolved.
    for (const object of view.workProducts.objects) {
      for (const check of object.checks) {
        if (check.binding === "current" && check.status === "passed") current.push(`check:${object.path}:${check.id}`);
      }
    }
    const progressed = current.some(key => !this.milestones.has(key));
    for (const key of current) this.milestones.add(key);
    if (progressed) { this.turns = 0; this.failed.clear(); this.observed.clear(); }
    for (const item of latestEvidence) {
      if (input.toolEffect(item.toolName) === "write" && (item.isError || item.operationStatus === "failed")) this.failed.add(item.toolCallId);
    }
    if (this.failed.size === 0) return undefined;
    for (const item of latestEvidence) this.observed.add(item.toolCallId);
    this.turns += 1;
    return { turnsWithoutDeliveryProgress: this.turns, failedToolCallIds: [...this.failed], observedToolCallIds: [...this.observed],
      warning: this.turns >= 6, assessmentRequired: this.turns >= 10 };
  }
}

export function artifactRepairCheckpointAdvice(checkpoint: ArtifactRepairCheckpoint): string {
  return [
    `A failed artifact operation has been followed by ${checkpoint.turnsWithoutDeliveryProgress} local repair turns without new delivery evidence, a current-version passing check, or recovery of a failed executable invocation.`,
    `Reuse committed Results, including failed calls ${checkpoint.failedToolCallIds.join(", ")}.`,
    "A changed file, new script name, successful patch or successful command exit does not establish that the artifact defect was repaired.",
    "Use a bounded repair and execute/validate the affected result. If this approach cannot advance the current delivery, submit a truthful incomplete candidate so Assessment and Recovery can choose a different plan or request missing input.",
    "The full authorized tool catalog remains available; this checkpoint changes no permissions or acceptance requirements.",
  ].join(" ");
}

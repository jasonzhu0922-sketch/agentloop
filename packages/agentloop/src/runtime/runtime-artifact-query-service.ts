import { notFound } from "../shared/errors.ts";
import {
  collectProcessArtifacts,
  previewProcessArtifact,
  readProcessArtifact,
  type ProcessArtifact,
  type ProcessArtifactPreview,
} from "./process-artifacts.ts";

export interface ArtifactQueryRun {
  readonly id: string;
  readonly ownerUserId: string;
  readonly conversationId?: string;
  readonly createdAt: number;
}

export interface ArtifactQueryEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/**
 * Read-only artifact reconstruction from durable Run evidence.
 * It owns no planning, execution, assessment, or terminal state transitions.
 */
export class RuntimeArtifactQueryService {
  private readonly input: {
    readonly run: (actorUserId: string, runId: string) => Promise<ArtifactQueryRun>;
    readonly events: (actorUserId: string, runId: string) => Promise<readonly ArtifactQueryEvent[]>;
    readonly workspaceRoot: (run: ArtifactQueryRun) => string;
  };

  constructor(input: RuntimeArtifactQueryService["input"]) {
    this.input = input;
  }

  async list(actorUserId: string, runId: string): Promise<ProcessArtifact[]> {
    const run = await this.input.run(actorUserId, runId);
    const events = await this.input.events(actorUserId, runId);
    return collectProcessArtifacts({
      runId,
      workspaceRoot: this.input.workspaceRoot(run),
      runCreatedAt: run.createdAt,
      events,
      promoteProducedArtifacts: conversationCandidateApproved(events),
    });
  }

  async read(actorUserId: string, runId: string, artifactId: string): Promise<{ artifact: ProcessArtifact; content: Buffer }> {
    const artifact = (await this.list(actorUserId, runId)).find((item) => item.id === artifactId);
    if (artifact === undefined) throw notFound("Process artifact");
    const run = await this.input.run(actorUserId, runId);
    try {
      return { artifact, content: await readProcessArtifact({ artifact, workspaceRoot: this.input.workspaceRoot(run) }) };
    } catch {
      throw notFound("Process artifact");
    }
  }

  async preview(actorUserId: string, runId: string, artifactId: string): Promise<ProcessArtifactPreview> {
    const artifact = (await this.list(actorUserId, runId)).find((item) => item.id === artifactId);
    if (artifact === undefined) throw notFound("Process artifact");
    const run = await this.input.run(actorUserId, runId);
    try {
      return await previewProcessArtifact({ artifact, workspaceRoot: this.input.workspaceRoot(run) });
    } catch {
      throw notFound("Process artifact");
    }
  }
}

export function conversationCandidateApproved(events: readonly Pick<ArtifactQueryEvent, "type">[]): boolean {
  return events.some((event) => event.type === "candidate.approved");
}

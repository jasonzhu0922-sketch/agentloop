import { notFound } from "../shared/errors.ts";
import {
  inlineToolArgumentsContent,
  toolArgumentsReference,
  type ToolArgumentsContent,
  type ToolArgumentsReferenceStore,
} from "./tool-arguments-reference-store.ts";

export interface ToolArgumentsQueryRun {
  readonly ownerUserId: string;
  readonly conversationId?: string;
}

export interface ToolArgumentsQueryEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Read-only tool-argument reconstruction from durable Run events. */
export class RuntimeToolArgumentsQueryService {
  private readonly input: {
    readonly run: (actorUserId: string, runId: string) => Promise<ToolArgumentsQueryRun>;
    readonly events: (actorUserId: string, runId: string) => Promise<readonly ToolArgumentsQueryEvent[]>;
    readonly store: (run: ToolArgumentsQueryRun) => ToolArgumentsReferenceStore;
  };

  constructor(input: RuntimeToolArgumentsQueryService["input"]) {
    this.input = input;
  }

  async read(actorUserId: string, runId: string, toolCallId: string): Promise<ToolArgumentsContent> {
    const run = await this.input.run(actorUserId, runId);
    const store = this.input.store(run);
    const events = await this.input.events(actorUserId, runId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const directToolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
      if (directToolCallId === toolCallId) {
        const ref = toolArgumentsReference(event.data.argumentsRef);
        if (ref !== undefined) return await store.read(toolCallId, ref);
        if ("arguments" in event.data) return inlineToolArgumentsContent(toolCallId, event.data.arguments);
      }
      if ((event.type === "assistant.committed" || event.type === "assistant.streaming") && Array.isArray(event.data.toolCalls)) {
        for (let callIndex = event.data.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
          const call = record(event.data.toolCalls[callIndex]);
          if (call?.id !== toolCallId) continue;
          const ref = toolArgumentsReference(call.argumentsRef);
          if (ref !== undefined) return await store.read(toolCallId, ref);
          if ("arguments" in call) return inlineToolArgumentsContent(toolCallId, call.arguments);
        }
      }
    }
    throw notFound("Tool arguments");
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

import type {
  CapabilityGrant,
  JsonSchema,
  ModelToolCall,
  ModelToolDefinition,
} from "./contracts.ts";
import { badRequest, forbidden } from "../shared/errors.ts";

export interface ToolExecutionContext {
  readonly grant: CapabilityGrant;
  readonly signal?: AbortSignal;
}

export interface RuntimeTool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly executionMode: "parallel" | "exclusive";
  readonly replaySafe: boolean;
  /** Upper bound for one Tool execution, used by the Runtime Action deadline. */
  readonly timeoutMs?: number;
  readonly maxResultCharacters?: number;
  parse(input: unknown): TInput;
  execute(context: ToolExecutionContext, input: TInput): Promise<unknown>;
}

export interface PreparedToolCall {
  readonly call: ModelToolCall;
  readonly tool: RuntimeTool<unknown>;
  readonly input: unknown;
}

export interface MaterializedTools {
  readonly definitions: readonly ModelToolDefinition[];
  readonly prepare: (call: ModelToolCall) => PreparedToolCall;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool<unknown>>();

  constructor(tools: readonly RuntimeTool<unknown>[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  materialize(grant: CapabilityGrant): MaterializedTools {
    const visible = [...this.tools.values()].filter((tool) => grant.allowedToolNames.has(tool.name));
    const byName = new Map(visible.map((tool) => [tool.name, tool]));
    return {
      definitions: visible.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      prepare: (call) => {
        const tool = byName.get(call.name);
        if (tool === undefined) throw forbidden(`Tool "${call.name}" is not available in this run`);
        let input: unknown;
        try {
          input = tool.parse(call.arguments);
        } catch (error) {
          if (error instanceof Error) throw badRequest(`Invalid arguments for ${call.name}: ${error.message}`);
          throw badRequest(`Invalid arguments for ${call.name}`);
        }
        return { call, tool, input };
      },
    };
  }
}

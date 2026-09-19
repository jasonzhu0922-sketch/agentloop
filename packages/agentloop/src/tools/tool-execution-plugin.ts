import type { ModelToolCall } from "../runtime/contracts.ts";
import type { RuntimeTool, ToolExecutionContext } from "./tool-registry.ts";

export interface ToolExecutionPluginInput {
  readonly call: ModelToolCall;
  readonly tool: Pick<RuntimeTool<unknown>, "name" | "executionMode" | "replaySafe">;
  readonly input: unknown;
  readonly context: ToolExecutionContext;
}

export type ToolExecutionPluginDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly code: string; readonly reason: string; readonly ruleId?: string };

/**
 * Host-owned, pre-side-effect policy extension. Plugins may deny a parsed
 * call, but cannot alter its arguments or grant additional capabilities.
 */
export interface ToolExecutionPlugin {
  readonly id: string;
  readonly version: string;
  evaluate(input: ToolExecutionPluginInput): Promise<ToolExecutionPluginDecision> | ToolExecutionPluginDecision;
}

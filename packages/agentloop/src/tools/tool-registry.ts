import type {
  CapabilityGrant,
  JsonSchema,
  ModelToolCall,
  ModelToolDefinition,
} from "../runtime/contracts.ts";
import { AppError, badRequest, forbidden } from "../shared/errors.ts";
import { markActionFailedBeforeEffect } from "../runtime/action-effect.ts";
import type { RuntimeDecisionCommit } from "../runtime/decision-ledger.ts";
import type { ToolExecutionPlugin } from "./tool-execution-plugin.ts";

export interface ToolExecutionContext {
  readonly grant: CapabilityGrant;
  readonly signal?: AbortSignal;
}

/**
 * Declarative, host-owned semantics for a ToolSource capability. The kernel
 * treats identifiers as vocabulary entries: categories and capabilities can be
 * added by an App or plugin without extending a kernel enum.
 */
export interface ToolSourceCapability {
  readonly id: string;
  readonly category: string;
  readonly label?: string;
  readonly description?: string;
}

/**
 * Stable provenance for Tools materialized by one source. `transport` is an
 * implementation detail; planning matches source identity and capabilities.
 */
export interface ToolSourceDescriptor {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly transport?: string;
  readonly capabilities: readonly ToolSourceCapability[];
}

export interface RuntimeTool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly source?: ToolSourceDescriptor;
  readonly inputSchema: JsonSchema;
  readonly executionMode: "parallel" | "exclusive";
  readonly replaySafe: boolean;
  /** Upper bound for one Tool execution, used by the Runtime Action deadline. */
  readonly timeoutMs?: number;
  readonly maxResultCharacters?: number;
  /**
   * Optional, source-declared semantic identity fields. When an exact user
   * decision is active for the current Plan step, values supplied in these
   * fields must be one of its selected values before any Tool effect begins.
   * This is intentionally Tool-schema vocabulary, not a domain-name rule.
   */
  readonly decisionBinding?: {
    readonly identityRefFields?: readonly string[];
    readonly selectedOptionIdFields?: readonly string[];
  };
  parse(input: unknown): TInput;
  /** Validates a call before the Tool can begin its external effect. */
  preflight?(context: ToolExecutionContext, input: TInput): Promise<void>;
  execute(context: ToolExecutionContext, input: TInput): Promise<unknown>;
}

export interface PreparedToolCall {
  readonly call: ModelToolCall;
  readonly tool: RuntimeTool<unknown>;
  readonly input: unknown;
  readonly execute: (context: ToolExecutionContext) => Promise<unknown>;
}

export interface MaterializedTools {
  readonly definitions: readonly ModelToolDefinition[];
  readonly prepare: (call: ModelToolCall) => PreparedToolCall;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool<unknown>>();
  private readonly plugins: readonly ToolExecutionPlugin[];

  constructor(tools: readonly RuntimeTool<unknown>[], options: { readonly plugins?: readonly ToolExecutionPlugin[] } = {}) {
    this.plugins = Object.freeze([...(options.plugins ?? [])]);
    const pluginIds = new Set<string>();
    for (const plugin of this.plugins) {
      if (pluginIds.has(plugin.id)) throw new TypeError(`Duplicate tool execution plugin: ${plugin.id}`);
      if (plugin.id.trim().length === 0 || plugin.version.trim().length === 0) {
        throw new TypeError("Tool execution plugins require non-empty id and version");
      }
      pluginIds.add(plugin.id);
    }
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  materialize(
    grant: CapabilityGrant,
    options: { readonly decisionLedger?: readonly RuntimeDecisionCommit[] } = {},
  ): MaterializedTools {
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
        assertDecisionBinding(tool, input, grant, options.decisionLedger ?? []);
        const execute = async (context: ToolExecutionContext): Promise<unknown> => {
          try {
            for (const plugin of this.plugins) {
              let decision;
              try {
                decision = await plugin.evaluate({ call, tool, input, context });
              } catch {
                throw new AppError(
                  "TOOL_POLICY_DENIED",
                  `Tool execution plugin ${plugin.id}@${plugin.version} failed closed`,
                  403,
                  { pluginId: plugin.id, pluginVersion: plugin.version, toolName: tool.name },
                );
              }
              if (decision?.decision === "allow") continue;
              if (decision?.decision === "deny") {
                throw new AppError(
                  "TOOL_POLICY_DENIED",
                  decision.reason,
                  403,
                  {
                    pluginId: plugin.id,
                    pluginVersion: plugin.version,
                    toolName: tool.name,
                    policyCode: decision.code,
                    ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
                  },
                );
              }
              throw new AppError(
                "TOOL_POLICY_DENIED",
                `Tool execution plugin ${plugin.id}@${plugin.version} returned an invalid decision`,
                403,
                { pluginId: plugin.id, pluginVersion: plugin.version, toolName: tool.name },
              );
            }
            await tool.preflight?.(context, input);
          } catch (error) {
            throw markActionFailedBeforeEffect(error);
          }
          return tool.execute(context, input);
        };
        const guardedTool: RuntimeTool<unknown> = { ...tool, execute };
        return {
          call,
          tool: guardedTool,
          input,
          execute,
        };
      },
    };
  }
}

function assertDecisionBinding(
  tool: RuntimeTool<unknown>,
  input: unknown,
  grant: CapabilityGrant,
  ledger: readonly RuntimeDecisionCommit[],
): void {
  const binding = tool.decisionBinding;
  if (binding === undefined || input === null || typeof input !== "object" || Array.isArray(input)) return;
  const required = ledger.filter((commit) =>
    commit.mode === "exact"
    && commit.satisfaction === "required"
    && (commit.planId === undefined || commit.planId === grant.planId)
    && (commit.stepId === undefined || commit.stepId === grant.stepId)
  );
  if (required.length === 0) return;
  const record = input as Record<string, unknown>;
  for (const commit of required) {
    assertDeclaredFieldValues(
      tool.name,
      commit.id,
      record,
      binding.identityRefFields ?? [],
      new Set(commit.selectedOptions.flatMap((option) => option.identityRefs ?? [])),
      "identity reference",
    );
    assertDeclaredFieldValues(
      tool.name,
      commit.id,
      record,
      binding.selectedOptionIdFields ?? [],
      new Set(commit.selectedOptions.map((option) => option.id)),
      "selected option",
    );
  }
}

function assertDeclaredFieldValues(
  toolName: string,
  decisionId: string,
  input: Record<string, unknown>,
  fields: readonly string[],
  selected: ReadonlySet<string>,
  label: string,
): void {
  if (selected.size === 0) return;
  for (const field of fields) {
    const value = input[field];
    if (value === undefined) continue;
    const values = typeof value === "string"
      ? [value]
      : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    if (values.length === 0 || values.some((item) => !selected.has(item))) {
      throw new AppError(
        "TOOL_POLICY_DENIED",
        `Tool ${toolName} ${label} conflicts with committed user decision ${decisionId}`,
        403,
        { toolName, decisionId, policyCode: "decision_binding_conflict", field },
      );
    }
  }
}

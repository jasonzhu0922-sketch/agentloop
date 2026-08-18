import type { ModelInvocation, ModelMessage } from "./contracts.ts";

/**
 * The internal Runtime always distinguishes server context from user input.
 * This setting only controls the last-mile encoding for an OpenAI-compatible
 * chat endpoint, whose role vocabulary may be smaller than the Runtime's.
 */
export type RuntimeContextPlacement = "system" | "user-envelope";

export interface OpenAICompatiblePrompt {
  readonly messages: readonly Record<string, unknown>[];
}

export function encodeOpenAICompatiblePrompt(
  invocation: ModelInvocation,
  placement: RuntimeContextPlacement,
): OpenAICompatiblePrompt {
  const context = invocation.runtimeContext === undefined
    ? undefined
    : formatRuntimeContext(invocation.runtimeContext);
  const systemContent = placement === "system" && context !== undefined
    ? `${invocation.systemPrompt}\n\n${context}`
    : invocation.systemPrompt;
  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemContent },
    ...invocation.messages.map(toProviderMessage),
  ];
  if (placement === "user-envelope" && context !== undefined) {
    messages.push({ role: "user", content: context });
  }
  return { messages };
}

function formatRuntimeContext(context: NonNullable<ModelInvocation["runtimeContext"]>): string {
  const payload = JSON.stringify({
    schema: "agentloop.runtimeContext/v1",
    snapshotId: context.id,
    phase: context.phase,
    ...(context.supersedesId === undefined ? {} : { supersedesId: context.supersedesId }),
    content: context.content,
  }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  const supersedes = context.supersedesId === undefined
    ? ""
    : ` supersedes=\"${escapeXmlAttribute(context.supersedesId)}\"`;
  return [
    `<runtime_context source="server" encoding="json" snapshot_id="${escapeXmlAttribute(context.id)}" phase="${context.phase}"${supersedes}>`,
    payload,
    "</runtime_context>",
  ].join("\n");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

function toProviderMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }),
  };
}

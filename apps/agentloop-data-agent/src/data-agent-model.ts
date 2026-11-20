import type { ModelAdapter, ModelInvocation, ModelResponse, ModelStreamEvent, ModelToolCall } from "@zhujun/agentloop";
import { basename } from "node:path";
import { detectDataAgentFileExport } from "./file-export.ts";

const BAD_RESULT_POINTERS = new Set(["/sql", "/sources"]);
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DATA_REQUEST = /(?:查询|查一下|统计|分析|对比|比较|趋势|排名|分布|差异|同比|环比|完成率|财务|经营|指标|计划|实际|人力|员工|人数|采购|合同|金额|行情|月份|季度|年度|多少|最高|最低|平均|合计)/u;
const FOLLOW_UP = /^(?:继续|再|然后|另外|刚才|上面|上述|前面|之前|这个|那个|改成|换成|同样|还是|那么|那就|也查|再查)/u;
const PRIOR_REFERENCE = /(?:刚才|上面|上述|前面|之前|上次|上一轮|这个结果|那个结果|previous|prior|earlier|above)/iu;

function workspaceFileName(path: string): string {
  return basename(path.replaceAll("\\", "/").replace(/^@workspace\//, ""));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function latestUserInput(invocation: ModelInvocation): string | undefined {
  for (let index = invocation.messages.length - 1; index >= 0; index -= 1) {
    const message = invocation.messages[index];
    if (message?.role === "user" && typeof message.content === "string") return message.content.trim();
  }
  return undefined;
}

function fixedConversationResolution(invocation: ModelInvocation): ModelResponse | undefined {
  if (invocation.phase !== "planning" || invocation.tools.length !== 1
    || invocation.tools[0]?.name !== "resolve_conversation_turn") return undefined;
  const input = latestUserInput(invocation);
  if (!input || !DATA_REQUEST.test(input) || FOLLOW_UP.test(input) || PRIOR_REFERENCE.test(input)) return undefined;
  const analytical = /(?:分析|对比|比较|趋势|排名|分布|差异|同比|环比|完成率|变化)/u.test(input);
  const fileExport = detectDataAgentFileExport(input);
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "data-agent-fixed-intent",
      name: "resolve_conversation_turn",
      arguments: {
        mode: "execute",
        relation: "new_goal",
        inputMode: "none",
        effectiveGoal: input.slice(0, 2_000),
        taskIntent: {
          schema: "agentloop.conversationTaskIntent/v1",
          operation: fileExport ? "create_artifact" : analytical ? "analysis" : "lookup",
          requiresExecution: true,
          deliverables: fileExport ? [{
            targetId: "answer-file", purpose: input.slice(0, 500), expectedArtifactCount: 1,
            action: "create", kind: fileExport.kind, format: fileExport.format, surface: "workspace_artifact",
          }] : [{
            targetId: "answer", purpose: input.slice(0, 500), expectedArtifactCount: 1,
            action: "none", kind: "none", surface: "conversation",
          }],
        },
        evidenceStrategy: "source_grounded",
        sourceBinding: { mode: "none", visibleDirectoryIds: [] },
        userConstraints: [],
        memoryAction: "none",
        memoryIntents: [],
        requiredCapabilityReferences: [],
      },
    }],
  };
}

function fixedSkillLoad(invocation: ModelInvocation): ModelResponse | undefined {
  if (invocation.phase !== "execution" || !invocation.tools.some(tool => tool.name === "load_skill")) return undefined;
  const successfulLoadCallIds = new Set(invocation.messages.flatMap(message =>
    message.role === "tool" && message.name === "load_skill" && !message.isError ? [message.toolCallId] : []));
  const loadedNames = new Set(invocation.messages.flatMap(message => {
    if (message.role !== "assistant") return [];
    return (message.toolCalls ?? []).filter(call => call.name === "load_skill" && successfulLoadCallIds.has(call.id)).flatMap(call => {
      const value = record(call.arguments);
      return typeof value?.name === "string" ? [value.name] : [];
    });
  }));
  const fileExport = detectDataAgentFileExport(latestUserInput(invocation) ?? "");
  const required = ["data-analysis", ...(fileExport?.skillName ? [fileExport.skillName] : [])];
  const missing = required.filter(name => !loadedNames.has(name));
  if (missing.length === 0) return undefined;
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: missing.map((name, index) => ({
      id: `data-agent-fixed-skill-load-${index + 1}`, name: "load_skill", arguments: { name },
    })),
  };
}

function withRequiredAssessmentTool(invocation: ModelInvocation): ModelInvocation {
  if (invocation.phase !== "assessment" || invocation.tools.length !== 1) return invocation;
  const tool = invocation.tools[0];
  return tool ? { ...invocation, toolChoice: { name: tool.name } } : invocation;
}

async function streamWithFirstEventRetry(
  model: ModelAdapter,
  invocation: ModelInvocation,
  sink: (event: ModelStreamEvent) => void | Promise<void>,
  signal: AbortSignal | undefined,
  firstEventTimeoutMs: number,
): Promise<ModelResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    let firstEventSeen = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const localSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (firstEventSeen || signal?.aborted) return;
        timedOut = true;
        const error = new Error("Data-agent model produced no usable event before the timeout");
        controller.abort(error);
        reject(error);
      }, firstEventTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([
        model.streamComplete!(invocation, async event => {
          firstEventSeen = true;
          if (timer !== undefined) clearTimeout(timer);
          await sink(event);
        }, localSignal),
        timeout,
      ]);
    } catch (error) {
      if (!timedOut || attempt > 0 || signal?.aborted) throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) controller.abort();
    }
  }
  throw new Error("Data-agent model exhausted its first-event retry");
}

function priorResultReads(invocation: ModelInvocation): Set<string> {
  const ids = new Set<string>();
  for (const message of invocation.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.name !== "read_result") continue;
      const value = record(call.arguments);
      if (typeof value?.resultId === "string") ids.add(value.resultId);
    }
  }
  return ids;
}

function normalizeCommand(argumentsValue: unknown): unknown {
  const value = record(argumentsValue);
  if (!value) return argumentsValue;
  let normalized: Record<string, unknown>;
  if (typeof value.command === "string") {
    normalized = typeof value.args === "string" ? { ...value, args: [value.args] } : value;
  } else if (Array.isArray(value.command) && value.command.length > 0 && value.command.every(item => typeof item === "string")) {
    normalized = { ...value, command: value.command[0], args: [...value.command.slice(1), ...(Array.isArray(value.args) ? value.args : [])] };
  } else {
    const nested = record(value.command);
    if (typeof nested?.command !== "string") return argumentsValue;
    normalized = { ...value, ...nested, command: nested.command, args: nested.args ?? value.args };
  }
  return normalizeDataClientRequest(normalized);
}

function normalizeDataClientRequest(value: Record<string, unknown>): Record<string, unknown> {
  if (value.command !== "python3" || !Array.isArray(value.args)
    || value.args[0] !== "scripts/data_client.py" || value.args[1] !== "execute") return value;
  const requestIndex = value.args.indexOf("--request-json");
  if (requestIndex < 0 || typeof value.args[requestIndex + 1] !== "string") return value;
  try {
    const requestRecord = record(JSON.parse(value.args[requestIndex + 1]));
    const queryPlan = record(requestRecord?.query_plan);
    if (!requestRecord || !queryPlan || !Array.isArray(queryPlan.metric_bindings)) return value;
    const metricBindings = queryPlan.metric_bindings.map(binding => {
      const item = record(binding);
      return typeof item?.source_id === "string" && typeof item.metric_id === "string"
        ? { source_id: item.source_id, metric_id: item.metric_id } : binding;
    });
    const args = [...value.args];
    args[requestIndex + 1] = JSON.stringify({ ...requestRecord, query_plan: { ...queryPlan, metric_bindings: metricBindings } });
    return { ...value, args };
  } catch {
    return value;
  }
}

function retrieveKnowledgeOutputs(invocation: ModelInvocation): Set<string> {
  const paths = new Set<string>();
  for (const message of invocation.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.name !== "computer_run_command") continue;
      const value = record(normalizeCommand(call.arguments));
      if (!Array.isArray(value?.args) || value.args[0] !== "scripts/data_client.py" || value.args[1] !== "retrieve-knowledge") continue;
      const outputIndex = value.args.indexOf("--output");
      const output = outputIndex >= 0 ? value.args[outputIndex + 1] : undefined;
      if (typeof output === "string") paths.add(workspaceFileName(output));
    }
  }
  return paths;
}

function priorJsonReads(invocation: ModelInvocation): Set<string> {
  const paths = new Set<string>();
  for (const message of invocation.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.name !== "computer_read_json") continue;
      const value = record(call.arguments);
      if (typeof value?.path === "string") paths.add(workspaceFileName(value.path));
    }
  }
  return paths;
}

function normalizeJsonRead(argumentsValue: unknown, knowledgeOutputs: Set<string>, jsonReads: Set<string>): unknown {
  const value = record(argumentsValue);
  if (!value || typeof value.path !== "string") return argumentsValue;
  const path = workspaceFileName(value.path);
  if (!knowledgeOutputs.has(path) || jsonReads.has(path)) return argumentsValue;
  jsonReads.add(path);
  return { ...value, path, queries: [
    { pointer: "/sources" }, { pointer: "/terms" }, { pointer: "/metrics" },
    { pointer: "/ambiguities" }, { pointer: "/gaps" }, { pointer: "/selection_contract" },
    { pointer: "/relationships" },
  ] };
}

function normalizeReadResult(argumentsValue: unknown, readResultIds: Set<string>): unknown {
  const value = record(argumentsValue);
  if (!value || typeof value.resultId !== "string") return argumentsValue;
  const firstRead = !readResultIds.has(value.resultId);
  const badPointer = typeof value.pointer === "string" && BAD_RESULT_POINTERS.has(value.pointer);
  readResultIds.add(value.resultId);
  if (!firstRead && !badPointer) return value;
  const { pointer: _pointer, offset: _offset, limit: _limit, ...rootRead } = value;
  return rootRead;
}

function normalizeCall(call: ModelToolCall, readResultIds: Set<string>, knowledgeOutputs: Set<string>, jsonReads: Set<string>): ModelToolCall {
  if (call.name === "computer_run_command") return { ...call, arguments: normalizeCommand(call.arguments) };
  if (call.name === "computer_read_json") return { ...call, arguments: normalizeJsonRead(call.arguments, knowledgeOutputs, jsonReads) };
  if (call.name === "computer_read_file") {
    const value = record(call.arguments);
    const path = typeof value?.path === "string" ? workspaceFileName(value.path) : undefined;
    if (path && knowledgeOutputs.has(path)) {
      return { ...call, name: "computer_read_json", arguments: normalizeJsonRead({ ...value, path }, knowledgeOutputs, new Set()) };
    }
  }
  if (call.name === "read_result") return { ...call, arguments: normalizeReadResult(call.arguments, readResultIds) };
  return call;
}

function signature(call: ModelToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

function normalizeCalls(calls: readonly ModelToolCall[], readResultIds: Set<string>, knowledgeOutputs: Set<string>, jsonReads: Set<string>): ModelToolCall[] {
  const seen = new Set<string>();
  const output: ModelToolCall[] = [];
  for (const original of calls) {
    const call = normalizeCall(original, readResultIds, knowledgeOutputs, jsonReads);
    const key = signature(call);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(call);
  }
  return output;
}

function cleanFinalResponse(invocation: ModelInvocation, response: ModelResponse): ModelResponse {
  if (invocation.phase !== "execution" || response.finishReason !== "stop" || response.toolCalls.length > 0) return response;
  const matches = [...response.content.matchAll(/\r?\n\s*---+\s*\r?\n/g)];
  const last = matches.at(-1);
  let content = (last && last.index !== undefined
    ? response.content.slice(last.index + last[0].length) : response.content).trim();
  content = content.replace(/^(?:#{1,3}\s*)?(?:\*\*)?(?:最终)?回答(?:\*\*)?[：:]?\s*/u, "");
  const repeatedCount = content.match(/^共有\s*(\d+)\s*项结果[。.]\s*\r?\n\r?\n((?:[-*]\s+[^\n]+\r?\n?)+)/u);
  if (repeatedCount) {
    const expected = Number(repeatedCount[1]);
    const actual = (repeatedCount[2].match(/^[-*]\s+/gmu) ?? []).length;
    if (expected === actual) content = content.slice(repeatedCount[0].length - repeatedCount[2].length).trimStart();
  }
  return content.length >= 20 ? { ...response, content } : response;
}

/** Application-only guardrails for the fixed data-analysis workflow. */
export function dataAgentModel(
  model: ModelAdapter,
  options: { readonly firstEventTimeoutMs?: number } = {},
): ModelAdapter {
  const firstEventTimeoutMs = options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  return {
    limits: model.limits,
    completeTimeoutMs: model.completeTimeoutMs,
    operationTimeoutMs: model.operationTimeoutMs,
    reasoningVisibility: model.reasoningVisibility,
    estimateInputTokens: model.estimateInputTokens?.bind(model),
    requestLogContext: model.requestLogContext?.bind(model),
    async complete(invocation, signal) {
      const fixed = fixedConversationResolution(invocation) ?? fixedSkillLoad(invocation);
      if (fixed) return fixed;
      const response = await model.complete(withRequiredAssessmentTool(invocation), signal);
      const normalized = { ...response, toolCalls: normalizeCalls(response.toolCalls, priorResultReads(invocation), retrieveKnowledgeOutputs(invocation), priorJsonReads(invocation)) };
      return cleanFinalResponse(invocation, normalized);
    },
    ...(model.streamComplete === undefined ? {} : {
      async streamComplete(invocation: ModelInvocation, sink: (event: ModelStreamEvent) => void | Promise<void>, signal?: AbortSignal): Promise<ModelResponse> {
        const fixed = fixedConversationResolution(invocation) ?? fixedSkillLoad(invocation);
        if (fixed) return fixed;
        const readResultIds = priorResultReads(invocation);
        const knowledgeOutputs = retrieveKnowledgeOutputs(invocation);
        const jsonReads = priorJsonReads(invocation);
        const seenReady = new Set<string>();
        const request = withRequiredAssessmentTool(invocation);
        const response = await streamWithFirstEventRetry(model, request, async event => {
          if (event.type !== "tool_call_ready") return sink(event);
          const call = normalizeCall({ id: event.id, name: event.name, arguments: event.arguments }, readResultIds, knowledgeOutputs, jsonReads);
          const key = signature(call);
          if (seenReady.has(key)) return;
          seenReady.add(key);
          await sink({ ...event, name: call.name, arguments: call.arguments });
        }, signal, firstEventTimeoutMs);
        const normalized = { ...response, toolCalls: normalizeCalls(response.toolCalls, priorResultReads(invocation), knowledgeOutputs, jsonReads) };
        return cleanFinalResponse(invocation, normalized);
      },
    }),
  };
}

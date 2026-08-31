import type { RunEvent } from "./types";

export type ExecutedToolStatus = "running" | "completed" | "failed" | "rejected";

export interface ExecutedTool {
  readonly name: string;
  readonly calls: number;
  readonly status: ExecutedToolStatus;
}

export interface ExecutionCapabilities {
  readonly skills: readonly string[];
  readonly tools: readonly ExecutedTool[];
}

interface ToolCallState {
  readonly name: string;
  readonly status: ExecutedToolStatus;
}

const toolEventStatus: Readonly<Record<string, ExecutedToolStatus>> = {
  "tool.dispatched": "running",
  "tool.completed": "completed",
  "tool.failed": "failed",
  "tool.rejected": "rejected",
};

export function executionCapabilities(events: readonly RunEvent[]): ExecutionCapabilities {
  const skills = new Set<string>();
  const toolCalls = new Map<string, ToolCallState>();

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "skill.activated") {
      const name = stringValue(data.name) ?? stringValue(data.skillId);
      if (name !== undefined) skills.add(name);
      continue;
    }

    const status = toolEventStatus[event.type];
    if (status === undefined) continue;
    const toolCallId = stringValue(data.toolCallId);
    if (toolCallId === undefined) continue;
    const existing = toolCalls.get(toolCallId);
    const name = stringValue(data.toolName) ?? stringValue(data.name) ?? existing?.name;
    if (name === undefined) continue;
    toolCalls.set(toolCallId, { name, status });
  }

  const tools = new Map<string, ExecutedTool>();
  for (const call of toolCalls.values()) {
    const current = tools.get(call.name);
    tools.set(call.name, {
      name: call.name,
      calls: (current?.calls ?? 0) + 1,
      status: current === undefined ? call.status : aggregateStatus(current.status, call.status),
    });
  }

  return {
    skills: [...skills].sort((left, right) => left.localeCompare(right)),
    tools: [...tools.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function aggregateStatus(left: ExecutedToolStatus, right: ExecutedToolStatus): ExecutedToolStatus {
  const priority: Readonly<Record<ExecutedToolStatus, number>> = {
    completed: 0,
    running: 1,
    rejected: 2,
    failed: 3,
  };
  return priority[right] > priority[left] ? right : left;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

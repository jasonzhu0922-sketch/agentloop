export type ToolInvocationStatus = "completed" | "failed" | "rejected";
export type ToolOperationStatus = "succeeded" | "failed" | "unknown";

export interface ToolOperationOutcome {
  readonly status: ToolOperationStatus;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly reason?: "nonzero_exit_code" | "terminated_by_signal" | "missing_exit_status";
}

/**
 * A Tool may return normally while the operation it invoked failed. Command
 * adapters expose that distinction as a top-level exitCode instead of
 * throwing, which preserves stdout/stderr and file-change diagnostics for the
 * next turn. This classifier keeps that neutral result shape authoritative at
 * Runtime boundaries.
 */
export function classifyToolOperationOutcome(value: unknown): ToolOperationOutcome {
  const record = operationRecord(value);
  if (record === undefined || !("exitCode" in record)) return { status: "succeeded" };
  const exitCode = record.exitCode;
  const signal = typeof record.signal === "string" || record.signal === null
    ? record.signal
    : undefined;
  if (exitCode === 0) {
    return {
      status: "succeeded",
      exitCode,
      ...(signal === undefined ? {} : { signal }),
    };
  }
  if (typeof exitCode === "number") {
    return {
      status: "failed",
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      reason: "nonzero_exit_code",
    };
  }
  if (exitCode === null && typeof signal === "string" && signal.length > 0) {
    return { status: "failed", exitCode, signal, reason: "terminated_by_signal" };
  }
  return {
    status: "unknown",
    ...(exitCode === null ? { exitCode } : {}),
    ...(signal === undefined ? {} : { signal }),
    reason: "missing_exit_status",
  };
}

export function toolOperationFailureCode(value: unknown): string | undefined {
  return classifyToolOperationOutcome(value).status === "failed"
    ? "TOOL_OPERATION_FAILED"
    : undefined;
}

function operationRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

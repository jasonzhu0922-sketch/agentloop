export type TerminalLogColorMode = "auto" | "always" | "never";

export interface TerminalLogColorOptions {
  readonly colorMode?: string | undefined;
  readonly isTTY?: boolean | undefined;
  readonly noColor?: string | undefined;
}

const ANSI = {
  reset: "\u001B[0m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  cyan: "\u001B[36m",
  magenta: "\u001B[35m",
  blue: "\u001B[34m",
  brightCyan: "\u001B[96m",
  brightGreen: "\u001B[92m",
  brightMagenta: "\u001B[95m",
  brightYellow: "\u001B[93m",
} as const;

const LABEL_COLORS = [
  ANSI.blue,
  ANSI.brightCyan,
  ANSI.brightGreen,
  ANSI.brightMagenta,
  ANSI.brightYellow,
] as const;

const ERROR_EVENTS = new Set([
  "run.failed",
  "plan.step.failed",
  "model.request.failed",
  "tool.failed",
  "tool.rejected",
  "candidate.rejected",
  "assessment.failed_boundary",
  "action.failed",
  "loop.limit_exceeded",
]);

const WARNING_EVENTS = new Set([
  "run.cancellation_requested",
  "run.cancelled",
  "context.compaction.skipped",
  "context.tool_outputs_pruned",
  "loop.convergence_requested",
  "loop.no_progress",
  "candidate.validation_deferred",
  "model.retry",
]);

const SUCCESS_EVENTS = new Set([
  "run.completed",
  "plan.step.completed",
  "step.completed",
  "tool.completed",
  "candidate.approved",
  "candidate.evidence_boundary_accepted",
  "terminal.delivery_committed",
]);

const ACTIVE_EVENTS = new Set([
  "run.started",
  "planning.started",
  "planning.turn.started",
  "plan.step.started",
  "step.started",
  "model.request.started",
  "model.stream.first_event",
  "tool.planned",
  "tool.effect_pending",
  "tool.dispatched",
]);

/**
 * Adds presentation-only ANSI color to a durable Runtime event summary.
 * The passed log line remains untouched when output is not interactive or
 * color has been disabled, so file and log-collector output stays parseable.
 */
export function colorizeTerminalLogLine(line: string, options: TerminalLogColorOptions = {}): string {
  if (!shouldUseColor(options)) return line;
  const event = /(?:^|\s)event=([^\s]+)/.exec(line)?.[1];
  const color = event === undefined ? undefined : colorForEvent(event);
  return color === undefined ? line : line.replace(`event=${event}`, `${color}event=${event}${ANSI.reset}`);
}

/** Uses one stable, readable color for an identity such as a Runtime Host ID. */
export function colorizeTerminalLogLabel(label: string, identity: string, options: TerminalLogColorOptions = {}): string {
  if (!shouldUseColor(options)) return label;
  return `${LABEL_COLORS[stableColorIndex(identity)]}${label}${ANSI.reset}`;
}

export function shouldUseTerminalLogColor(options: TerminalLogColorOptions = {}): boolean {
  return shouldUseColor(options);
}

function shouldUseColor({ colorMode, isTTY, noColor }: TerminalLogColorOptions): boolean {
  const mode = normalizeColorMode(colorMode);
  if (mode === "never" || noColor !== undefined) return false;
  if (mode === "always") return true;
  return isTTY === true;
}

function normalizeColorMode(value: string | undefined): TerminalLogColorMode {
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "always" || value === "never") return value;
  return "auto";
}

function colorForEvent(event: string): string | undefined {
  if (ERROR_EVENTS.has(event)) return ANSI.red;
  if (WARNING_EVENTS.has(event)) return ANSI.yellow;
  if (SUCCESS_EVENTS.has(event)) return ANSI.green;
  if (event.startsWith("skill.")) return ANSI.magenta;
  if (ACTIVE_EVENTS.has(event)) return ANSI.cyan;
  return undefined;
}

function stableColorIndex(identity: string): number {
  const trailingNumber = /(?:^|\D)(\d+)$/.exec(identity)?.[1];
  if (trailingNumber !== undefined) {
    const ordinal = Number(trailingNumber) - 1;
    return ((ordinal % LABEL_COLORS.length) + LABEL_COLORS.length) % LABEL_COLORS.length;
  }
  let hash = 0;
  for (const character of identity) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % LABEL_COLORS.length;
}

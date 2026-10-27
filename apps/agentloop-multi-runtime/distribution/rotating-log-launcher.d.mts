import { Writable } from "node:stream";

export const LOG_ROTATION_BYTES: number;

export class RotatingLogWritable extends Writable {
  constructor(filePath: string, maxBytes?: number);
}

export function runRotatingLogLauncher(input: {
  command: readonly string[];
  args?: readonly string[];
  logRoot: string;
  stdoutName?: string;
  stderrName?: string;
  maxBytes?: number;
}): Promise<{ code: number; signal: NodeJS.Signals | null }>;

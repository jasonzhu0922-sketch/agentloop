import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";

export const SKILL_EXECUTION_MANIFEST_FILE = "agentloop.executors.json";

export interface SkillExecutionInput {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface SkillExecutionAction {
  readonly id: string;
  readonly description: string;
  readonly inputs: readonly SkillExecutionInput[];
  readonly args: readonly string[];
  readonly result: string;
}

export interface SkillExecutionEntrypoint {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly script: string;
  readonly actions: readonly SkillExecutionAction[];
}

/**
 * Read a package-owned execution interface for model guidance. This describes
 * how to invoke an already-authorized Skill asset; it grants no capability and
 * does not participate in Runtime state transitions.
 */
export async function readSkillExecutionManifest(packageRoot: string): Promise<readonly SkillExecutionEntrypoint[]> {
  const path = resolve(packageRoot, SKILL_EXECUTION_MANIFEST_FILE);
  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return [];
    throw new Error(`Unable to read ${SKILL_EXECUTION_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (content.length > 64_000) throw new Error(`${SKILL_EXECUTION_MANIFEST_FILE} exceeds 64000 characters`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${SKILL_EXECUTION_MANIFEST_FILE} is not valid JSON`);
  }
  return parseManifest(parsed);
}

function parseManifest(value: unknown): readonly SkillExecutionEntrypoint[] {
  const root = record(value, "Skill execution manifest");
  if (root.schema !== "agentloop.skillExecutors/v1") throw new Error("Skill execution manifest has an unsupported schema");
  const executors = array(root.executors, "Skill execution manifest executors", 1, 16);
  return executors.map((entry) => parseEntrypoint(entry));
}

function parseEntrypoint(value: unknown): SkillExecutionEntrypoint {
  const entry = record(value, "Skill executor");
  const id = identifier(entry.id, "Skill executor id");
  const description = text(entry.description, "Skill executor description", 500);
  const command = text(entry.command, "Skill executor command", 120);
  if (command.includes("/") || command.includes("\\") || /\s/u.test(command)) throw new Error("Skill executor command must be a bare executable name");
  const script = relativePath(entry.script, "Skill executor script");
  const actions = array(entry.actions, "Skill executor actions", 1, 32).map((action) => parseAction(action));
  if (new Set(actions.map((action) => action.id)).size !== actions.length) throw new Error("Skill executor action ids must be unique");
  return { id, description, command, script, actions };
}

function parseAction(value: unknown): SkillExecutionAction {
  const action = record(value, "Skill executor action");
  const id = identifier(action.id, "Skill executor action id");
  const description = text(action.description, "Skill executor action description", 500);
  const inputs = array(action.inputs, "Skill executor action inputs", 0, 16).map((input) => parseInput(input));
  if (new Set(inputs.map((input) => input.name)).size !== inputs.length) throw new Error("Skill executor action input names must be unique");
  const args = array(action.args, "Skill executor action args", 1, 32)
    .map((argument) => text(argument, "Skill executor action argument", 2_000));
  for (const input of inputs) {
    if (!args.some((argument) => argument.includes(`{{${input.name}}}`))) {
      throw new Error(`Skill executor action ${id} does not use declared input ${input.name}`);
    }
  }
  const result = text(action.result, "Skill executor action result", 500);
  return { id, description, inputs, args, result };
}

function parseInput(value: unknown): SkillExecutionInput {
  const input = record(value, "Skill executor action input");
  if (typeof input.required !== "boolean") throw new Error("Skill executor action input required must be boolean");
  return {
    name: identifier(input.name, "Skill executor action input name"),
    description: text(input.description, "Skill executor action input description", 300),
    required: input.required,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}-${maximum} items`);
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value, label, 80);
  if (!/^[a-z][a-z0-9-]*$/u.test(normalized)) throw new Error(`${label} must use lowercase kebab-case`);
  return normalized;
}

function relativePath(value: unknown, label: string): string {
  const path = text(value, label, 240);
  if (path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe package-relative path`);
  }
  if (resolve("/skill", ...path.split("/")) === resolve("/skill") || path.includes(sep + "..")) throw new Error(`${label} must be a safe package-relative path`);
  return path;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

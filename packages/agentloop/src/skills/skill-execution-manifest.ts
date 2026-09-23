import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";

export const SKILL_EXECUTION_MANIFEST_FILE = "agentloop.executors.json";

export interface SkillExecutionInput {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  /**
   * A path-valued input whose bytes must be captured by Runtime when this
   * action publishes workflow evidence.  This is provenance, not a domain
   * schema: the Skill still owns how it interprets those bytes.
   */
  readonly evidenceInput?: "immutable_workspace_artifact";
}

export interface SkillExecutionDecisionBinding {
  readonly labelInputs?: readonly string[];
  readonly identityRefInputs?: readonly string[];
  readonly selectedOptionIdInputs?: readonly string[];
}

export interface SkillExecutionAction {
  readonly id: string;
  readonly description: string;
  readonly inputs: readonly SkillExecutionInput[];
  readonly args: readonly string[];
  readonly result: string;
  /**
   * Runtime-neutral evidence vocabulary published by this package action.
   * The package owns the computation and the result schema; Runtime only uses
   * this declaration to order a bound workflow before a dependent delivery.
   */
  readonly producesEvidenceKinds: readonly string[];
  readonly decisionBinding?: SkillExecutionDecisionBinding;
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
  for (const input of inputs.filter((entry) => entry.evidenceInput !== undefined)) {
    if (!args.includes(`{{${input.name}}}`)) {
      throw new Error(`Skill executor action ${id} evidenceInput ${input.name} must occupy one complete argument`);
    }
  }
  const result = text(action.result, "Skill executor action result", 500);
  const producesEvidenceKinds = optionalEvidenceKinds(action.producesEvidenceKinds, id);
  const decisionBinding = parseDecisionBinding(action.decisionBinding, inputs, id);
  return {
    id,
    description,
    inputs,
    args,
    result,
    producesEvidenceKinds,
    ...(decisionBinding === undefined ? {} : { decisionBinding }),
  };
}

function optionalEvidenceKinds(value: unknown, actionId: string): readonly string[] {
  if (value === undefined) return [];
  const kinds = array(value, `Skill executor action ${actionId} producesEvidenceKinds`, 1, 32)
    .map((kind) => evidenceKind(kind, `Skill executor action ${actionId} evidence kind`));
  if (new Set(kinds).size !== kinds.length) {
    throw new Error(`Skill executor action ${actionId} producesEvidenceKinds must be unique`);
  }
  return kinds;
}

function evidenceKind(value: unknown, label: string): string {
  const normalized = text(value, label, 80);
  if (!/^[a-z][a-z0-9_-]*$/u.test(normalized)) {
    throw new Error(`${label} must use lowercase identifier syntax`);
  }
  return normalized;
}

function parseDecisionBinding(
  value: unknown,
  inputs: readonly SkillExecutionInput[],
  actionId: string,
): SkillExecutionDecisionBinding | undefined {
  if (value === undefined) return undefined;
  const binding = record(value, `Skill executor action ${actionId} decisionBinding`);
  const inputNames = new Set(inputs.map((input) => input.name));
  const parseNames = (field: string): readonly string[] | undefined => {
    if (binding[field] === undefined) return undefined;
    const names = array(binding[field], `Skill executor action ${actionId} decisionBinding.${field}`, 1, 16)
      .map((name) => identifier(name, `Skill executor action ${actionId} decision binding input`));
    if (names.some((name) => !inputNames.has(name))) {
      throw new Error(`Skill executor action ${actionId} decision binding references an undeclared input`);
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`Skill executor action ${actionId} decision binding inputs must be unique`);
    }
    return names;
  };
  const labelInputs = parseNames("labelInputs");
  const identityRefInputs = parseNames("identityRefInputs");
  const selectedOptionIdInputs = parseNames("selectedOptionIdInputs");
  const parsed = {
    ...(labelInputs === undefined ? {} : { labelInputs }),
    ...(identityRefInputs === undefined ? {} : { identityRefInputs }),
    ...(selectedOptionIdInputs === undefined ? {} : { selectedOptionIdInputs }),
  };
  if (Object.keys(parsed).length === 0) throw new Error(`Skill executor action ${actionId} decisionBinding must declare at least one input`);
  return parsed;
}

function parseInput(value: unknown): SkillExecutionInput {
  const input = record(value, "Skill executor action input");
  if (typeof input.required !== "boolean") throw new Error("Skill executor action input required must be boolean");
  const evidenceInput = input.evidenceInput;
  if (evidenceInput !== undefined && evidenceInput !== "immutable_workspace_artifact") {
    throw new Error("Skill executor action input evidenceInput must be immutable_workspace_artifact");
  }
  if (evidenceInput !== undefined && input.required !== true) {
    throw new Error("Skill executor action evidenceInput must be required");
  }
  return {
    name: identifier(input.name, "Skill executor action input name"),
    description: text(input.description, "Skill executor action input description", 300),
    required: input.required,
    ...(evidenceInput === undefined ? {} : { evidenceInput }),
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

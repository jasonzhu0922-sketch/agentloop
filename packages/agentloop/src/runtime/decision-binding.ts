import type { PrivateSkill } from "../skills/skill-service.ts";
import type {
  SkillExecutionAction,
  SkillExecutionDecisionBinding,
  SkillExecutionEntrypoint,
} from "../skills/skill-execution-manifest.ts";
import type { RuntimeDecisionCommit } from "./decision-ledger.ts";

export interface ResolvedOperationBinding {
  readonly schema: "agentloop.resolvedOperationBinding/v1";
  readonly skillId: string;
  readonly skillName: string;
  readonly executorId: string;
  readonly actionId: string;
  readonly decisionId: string;
  readonly requestRevision: number;
  readonly selectedOptionId: string;
  readonly resolvedInputs: Readonly<Record<string, string>>;
  readonly command: string;
  readonly cwd: string;
  readonly argumentConstraints: readonly { readonly index: number; readonly value: string }[];
}

/**
 * Compile package-owned operation metadata and a Runtime-authoritative choice
 * into immutable command constraints. This is deliberately generic: Skills
 * declare which operation inputs carry the selected label/identity/option;
 * Runtime owns the decision and the pre-effect enforcement.
 */
export function resolveOperationBindings(input: {
  readonly skills: readonly PrivateSkill[];
  readonly manifests: ReadonlyMap<string, readonly SkillExecutionEntrypoint[]>;
  readonly decisionLedger: readonly RuntimeDecisionCommit[];
  readonly planId?: string;
  readonly stepId?: string;
}): readonly ResolvedOperationBinding[] {
  const commits = input.decisionLedger.filter((commit) =>
    commit.mode === "exact"
    && commit.satisfaction === "required"
    && (commit.planId === undefined || commit.planId === input.planId)
    && (commit.stepId === undefined || commit.stepId === input.stepId)
    && commit.selectedOptions.length === 1,
  );
  const bindings: ResolvedOperationBinding[] = [];
  for (const skill of input.skills) {
    const entrypoints = input.manifests.get(skill.id) ?? [];
    for (const entrypoint of entrypoints) {
      for (const action of entrypoint.actions) {
        if (action.decisionBinding === undefined) continue;
        for (const commit of commits) {
          const resolvedInputs = resolveInputs(action.decisionBinding, commit.selectedOptions[0]!);
          if (resolvedInputs === undefined) continue;
          const argumentConstraints = [
            { index: 0, value: entrypoint.script },
            ...action.args.flatMap((argument, index) => {
              const rendered = renderBoundArgument(argument, resolvedInputs);
              return rendered === undefined ? [] : [{ index: index + 1, value: rendered }];
            }),
          ];
          if (argumentConstraints.length === 0) continue;
          bindings.push(Object.freeze({
            schema: "agentloop.resolvedOperationBinding/v1",
            skillId: skill.id,
            skillName: skill.name,
            executorId: entrypoint.id,
            actionId: action.id,
            decisionId: commit.id,
            requestRevision: commit.requestRevision,
            selectedOptionId: commit.selectedOptions[0]!.id,
            resolvedInputs: Object.freeze({ ...resolvedInputs }),
            command: entrypoint.command,
            cwd: `@skills/${skill.name}`,
            argumentConstraints: Object.freeze(argumentConstraints),
          }));
        }
      }
    }
  }
  return Object.freeze(bindings);
}

function resolveInputs(
  binding: SkillExecutionDecisionBinding,
  option: RuntimeDecisionCommit["selectedOptions"][number],
): Record<string, string> | undefined {
  const resolved: Record<string, string> = {};
  for (const name of binding.labelInputs ?? []) resolved[name] = option.label;
  for (const name of binding.identityRefInputs ?? []) {
    const identityRef = option.identityRefs?.[0];
    if (identityRef === undefined) return undefined;
    resolved[name] = identityRef;
  }
  for (const name of binding.selectedOptionIdInputs ?? []) resolved[name] = option.id;
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

function renderBoundArgument(argument: string, inputs: Readonly<Record<string, string>>): string | undefined {
  let rendered = argument;
  for (const [name, value] of Object.entries(inputs)) {
    const token = `{{${name}}}`;
    if (!rendered.includes(token)) continue;
    rendered = rendered.split(token).join(value);
  }
  if (/\{\{[^}]+\}\}/u.test(rendered)) return undefined;
  return rendered;
}

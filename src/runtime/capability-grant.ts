import type { CapabilityGrant } from "./contracts.ts";

class ImmutableStringSet implements ReadonlySet<string> {
  readonly #values: Set<string>;

  constructor(values: Iterable<string>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[string, string]> {
    return this.#values.entries();
  }

  keys(): SetIterator<string> {
    return this.#values.keys();
  }

  values(): SetIterator<string> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.#values[Symbol.iterator]();
  }
}

export function createCapabilityGrant(input: {
  actorUserId: string;
  runId: string;
  conversationId?: string;
  depth: number;
  workspaceRoot?: string;
  visibleDirectories?: CapabilityGrant["visibleDirectories"];
  skillExecutionRoots?: CapabilityGrant["skillExecutionRoots"];
  allowedToolNames: Iterable<string>;
  allowedSkillIds: Iterable<string>;
}): CapabilityGrant {
  return Object.freeze({
    actorUserId: input.actorUserId,
    runId: input.runId,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    depth: input.depth,
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    visibleDirectories: Object.freeze([...(input.visibleDirectories ?? [])]),
    skillExecutionRoots: Object.freeze([...(input.skillExecutionRoots ?? [])]),
    allowedToolNames: new ImmutableStringSet(input.allowedToolNames),
    allowedSkillIds: new ImmutableStringSet(input.allowedSkillIds),
  });
}

export const DISCOVERED_SKILL_ID_PREFIX = "discovered:";

export interface SkillIdentity {
  readonly id: string;
  readonly name: string;
}

export function discoveredSkillId(name: string): string {
  return `${DISCOVERED_SKILL_ID_PREFIX}${name}`;
}

export function skillReferenceKeys(skill: SkillIdentity): readonly string[] {
  return [skill.id, skill.name];
}

export function buildSkillReferenceMap<T extends SkillIdentity>(
  skills: readonly T[],
): ReadonlyMap<string, T> {
  const byReference = new Map<string, T>();
  for (const skill of skills) {
    for (const key of skillReferenceKeys(skill)) {
      if (!byReference.has(key)) byReference.set(key, skill);
    }
  }
  return byReference;
}

export function resolveSkillReference<T extends SkillIdentity>(
  skills: readonly T[],
  reference: string,
): T | undefined {
  return buildSkillReferenceMap(skills).get(reference);
}

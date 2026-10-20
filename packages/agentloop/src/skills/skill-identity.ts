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
  // Canonical IDs always take precedence over another Skill's name.
  for (const skill of skills) byReference.set(skill.id, skill);
  const byName = new Map<string, T>();
  const ambiguousNames = new Set<string>();
  for (const skill of skills) {
    const previous = byName.get(skill.name);
    if (previous !== undefined && previous.id !== skill.id) ambiguousNames.add(skill.name);
    byName.set(skill.name, skill);
  }
  for (const [name, skill] of byName) {
    if (!byReference.has(name) && !ambiguousNames.has(name)) byReference.set(name, skill);
  }
  return byReference;
}

export function resolveSkillReference<T extends SkillIdentity>(
  skills: readonly T[],
  reference: string,
): T | undefined {
  return buildSkillReferenceMap(skills).get(reference);
}

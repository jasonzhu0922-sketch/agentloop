import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillReferenceMap, resolveSkillReference } from "../src/skills/skill-identity.ts";

test("Skill references resolve exact IDs and unique names without prefix assumptions", () => {
  const skills = [{ id: "discovered:analysis", name: "analysis" }, { id: "uuid-123", name: "provider" }];
  for (const skill of skills) {
    assert.equal(resolveSkillReference(skills, skill.id), skill);
    assert.equal(resolveSkillReference(skills, skill.name), skill);
  }
  assert.equal(resolveSkillReference(skills, "discovered:provider"), undefined);
  assert.equal(resolveSkillReference(skills, "Analysis"), undefined);
  assert.equal(resolveSkillReference(skills, "analysi"), undefined);
});

test("ambiguous names cannot resolve by catalog ordering while canonical IDs still work", () => {
  const skills = [{ id: "first", name: "shared" }, { id: "second", name: "shared" }];
  for (const ordered of [skills, [...skills].reverse()]) {
    const references = buildSkillReferenceMap(ordered);
    assert.equal(references.get("shared"), undefined);
    assert.equal(references.get("first"), skills[0]);
    assert.equal(references.get("second"), skills[1]);
  }
});

test("canonical IDs take precedence over a different Skill's name regardless of ordering", () => {
  const skills = [{ id: "first", name: "second" }, { id: "second", name: "provider" }];
  for (const ordered of [skills, [...skills].reverse()]) {
    assert.equal(resolveSkillReference(ordered, "second"), skills[1]);
  }
});

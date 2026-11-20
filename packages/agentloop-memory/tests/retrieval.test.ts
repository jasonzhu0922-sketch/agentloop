import assert from "node:assert/strict";
import test from "node:test";
import { rankMemoryRevisions, retrievalText } from "../src/retrieval.ts";
import type { MemoryRevision } from "../src/types.ts";

function revision(id: string, text: string, fingerprint = {}): MemoryRevision {
  return { schema: "agentloop.userMemoryRevision/v1", id, memoryId: id, revision: 1, authority: "verified_run", sensitivity: "normal",
    temporalClass: "stable", experienceMaturity: "procedure", activation: { mode: "always" }, applicationTargets: ["planner"],
    value: { settlementPattern: { title: text, goalSummary: "", applicability: { taskFingerprint: fingerprint }, classicPath: [], toolUsage: [], reusableKnowledge: [], failureLessons: [] } },
    contentMarkdown: "AUDIT_ONLY historical answer 二月为负值", applicability: { conditions: [], exclusions: [] }, confidence: 0.7, validFrom: 0,
    sourceRefs: [], changeReason: "test", createdAt: 0 };
}

test("local hybrid ranks Chinese boundaries and length-normalized evidence while ignoring audit answers", () => {
  const focused = revision("focused", "核对报表汇总口径与组织月份", { taskKind: "analysis", sourceKind: "database" });
  const verbose = revision("verbose", "核对报表 " + "通用操作过程与记录保存 ".repeat(100));
  const unrelated = revision("unrelated", "生成文档封面布局");
  const ranks = rankMemoryRevisions([verbose, unrelated, focused], "报表汇总口径", { taskKind: "analysis", sourceKind: "database" });
  assert.ok(ranks.get("focused")!.lexical > ranks.get("verbose")!.lexical, "long generic content must not crowd out focused knowledge");
  assert.ok(ranks.get("focused")!.character > 0, "Han character view survives segmentation boundaries");
  assert.ok(ranks.get("focused")!.score > ranks.get("verbose")!.score);
  assert.equal(ranks.get("unrelated")!.score, 0);
  assert.equal(retrievalText(focused).includes("AUDIT_ONLY"), false);
  assert.equal(rankMemoryRevisions([focused], "二月为负值").get("focused")!.score, 0);
});

test("structured similarity and common English letter pairs cannot admit an unrelated method", () => {
  const method = revision("source", "Inspect schema, read source, verify current output", { taskKind: "lookup" });
  assert.equal(rankMemoryRevisions([method], "Write a poem about mountains", { taskKind: "lookup" }).get("source")!.score, 0);
  assert.ok(rankMemoryRevisions([method], "Inspect source schema").get("source")!.score > 0);
  assert.equal(rankMemoryRevisions([method], "\n").get("source")!.score, 0);
});

test("equivalent documents tie independently of input ordering and show tool identities as lexical signals", () => {
  const a = revision("a", "校验数据"), b = revision("b", "校验数据");
  (a.value.settlementPattern as any).toolUsage = [{ toolName: "source.read", purpose: "读取当前来源" }];
  (b.value.settlementPattern as any).toolUsage = [{ toolName: "source.read", purpose: "读取当前来源" }];
  const forward = rankMemoryRevisions([a, b], "source.read 校验数据");
  const reverse = rankMemoryRevisions([b, a], "source.read 校验数据");
  assert.deepEqual(forward.get("a"), reverse.get("a"));
  assert.equal(forward.get("a")!.score, forward.get("b")!.score);
  assert.ok(forward.get("a")!.lexical > 0);
});

test("original-language retrieval descriptions support new subjects and months without indexing case answers", () => {
  const method = revision("headcount", "Employee Headcount Query");
  (method.value.settlementPattern as any).retrievalQueries = ["查询指定组织和月份的在岗员工人数，分别列示全公司和总部口径"];
  (method.value.settlementPattern as any).caseFacts = [{ statement: "Historical answer was 38932" }];
  assert.ok(rankMemoryRevisions([method], "2025年4月第三家公司全公司和总部在岗员工人数").get("headcount")!.score > 0);
  assert.equal(rankMemoryRevisions([method], "38932").get("headcount")!.score, 0);
});

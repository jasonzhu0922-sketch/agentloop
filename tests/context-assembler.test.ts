import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ContextAssembler, estimateTextTokens } from "../src/runtime/context-assembler.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse, RuntimeEvent } from "../src/runtime/contracts.ts";
import { ToolRegistry, type RuntimeTool } from "../src/runtime/tool-registry.ts";

test("ContextAssembler rejects an unclosed ToolCall instead of cutting an invalid provider transcript", async () => {
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 32_000, maxOutputTokens: 2_048 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-unclosed",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  await assert.rejects(
    () => assembler.assemble([{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "missing-result", name: "read", arguments: {} }],
    }], []),
    /ToolCalls without results/,
  );
});

test("ContextAssembler reduces an overlong persisted summary before treating compaction as successful", async () => {
  const requests: ModelInvocation[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 20_000, maxOutputTokens: 16_384 },
    complete: async (request) => {
      requests.push(request);
      if (request.messages[0]?.content.includes("<summary_to_reduce>")) {
        return { content: structuredSummary("kept"), toolCalls: [], finishReason: "stop" };
      }
      return { content: structuredSummary("verbose ".repeat(2_000)), toolCalls: [], finishReason: "stop" };
    },
  };
  const assembler = new ContextAssembler({
    runId: "run-summary-reduction",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  const assembly = await assembler.assemble([
    { role: "user", content: "source ".repeat(7_000) },
    { role: "assistant", content: "latest action" },
  ], []);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].maxOutputTokens, 8_192);
  assert.match(requests[1].messages[0]?.content ?? "", /at most 1600 estimated tokens/);
  assert.ok(estimateTextTokens(assembly.runtimeContext.content) < 1_600);
});

test("ContextAssembler summarizes an oversized terminal candidate instead of retaining an over-budget tail", async () => {
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 20_000, maxOutputTokens: 1_024 },
    complete: async () => ({ content: structuredSummary("the original candidate remains canonical evidence"), toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-oversized-candidate",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  const oversizedCandidate = `candidate ${"detail ".repeat(12_000)}`;
  const assembly = await assembler.assemble([
    { role: "user", content: "Produce a verifiable result." },
    { role: "assistant", content: oversizedCandidate },
  ], []);

  assert.deepEqual(assembly.messages, []);
  assert.match(assembly.runtimeContext.content, /<structured_summary>/);
  assert.match(assembly.runtimeContext.content, /original candidate remains canonical evidence/);
  assert.ok(assembly.runtimeContext.supersedesId !== undefined);
  assert.ok(assembly.estimatedInputTokens <= assembly.usableInputTokens);
});

test("the Loop prunes old Tool output, compacts complete exchanges, and reloads a Skill whose body left the tail", async () => {
  const model = new CompactingSkillModel();
  const events: RuntimeEvent[] = [];
  const largeEvidence = "renderer-source-line\n".repeat(450);
  const registry = new ToolRegistry([
    stringTool("load_skill", () => [
      '<skill_content id="skill-1" name="presentation-skill" version="1" sha256="skill-hash">',
      "EXACT THIRD PARTY SKILL BODY",
      "</skill_content>",
    ].join("\n")),
    stringTool("inspect_renderer", () => largeEvidence),
  ]);
  const result = await runAgentLoop({
    runId: "run-compaction",
    systemPrompt: [
      "Follow the current Plan step.",
      "The exact Skill body is authoritative.",
    ].join("\n"),
    input: "Create the requested artifact without modifying the third-party Skill.",
    model,
    tools: registry,
    grant: createCapabilityGrant({
      actorUserId: "user-1",
      runId: "run-compaction",
      agentId: "agent-1",
      depth: 0,
      allowedToolNames: ["load_skill", "inspect_renderer"],
      allowedSkillIds: ["skill-1"],
      allowedChildAgentIds: [],
    }),
    requiredSkills: [{ id: "skill-1", name: "presentation-skill", contentHash: "skill-hash" }],
    maxSteps: 20,
    emit: (event) => events.push(event),
  });

  assert.equal(result.output, "artifact candidate complete");
  assert.ok(model.summaryCalls >= 1);
  assert.ok(model.skillLoadCalls >= 2, "Skill must be loaded again after its exact body is compacted out");
  assert.ok(events.some((event) => event.type === "context.tool_outputs_pruned"));
  assert.ok(events.some((event) => event.type === "context.compacted"));
  assert.ok(events.some((event) => event.type === "skill.activation.expired"));
  assert.ok(events.filter((event) => event.type === "skill.activated").length >= 2);
  const pruneIndex = events.findIndex((event) => event.type === "context.tool_outputs_pruned");
  const compactionIndex = events.findIndex((event) => event.type === "context.compaction.started");
  assert.ok(pruneIndex >= 0 && compactionIndex > pruneIndex, "Tool output pruning must precede summarization");
  const compacted = events.find((event) => event.type === "context.compacted");
  assert.ok(Number(compacted?.data.estimatedTokensAfter) < Number(compacted?.data.estimatedTokensBefore));
  assert.match(String(compacted?.data.summary), /Goal/);
  assert.ok(
    result.messages.some((message) => message.role === "tool" && message.content === largeEvidence),
    "Canonical messages retain the full ToolResult even though the model projection was pruned",
  );
});

class CompactingSkillModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 20_000, maxOutputTokens: 16_384 } as const;
  summaryCalls = 0;
  skillLoadCalls = 0;
  private inspections = 0;
  private serial = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.systemPrompt.includes("context summarization component")) {
      this.summaryCalls += 1;
      assert.deepEqual(request.tools, []);
      assert.equal(request.maxOutputTokens, 8_192);
      return {
        content: [
          "## Goal",
          "Create the requested artifact.",
          "## Constraints & Preferences",
          "- Do not modify the third-party Skill.",
          "## Progress",
          "### Done",
          "- Renderer evidence was inspected.",
          "### In Progress",
          "- Continue the admitted step.",
          "### Blocked",
          "- none",
          "## Key Decisions",
          "- **Skill authority**: reload the exact body after compaction.",
          "## Evidence",
          "- Canonical ToolResults remain persisted.",
          "## Next Steps",
          "1. Continue inspection and submit a candidate.",
          "## Critical Context",
          "- presentation-skill must be reloaded when absent.",
        ].join("\n"),
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 2_000, outputTokens: 300 },
      };
    }

    const toolNames = request.tools.map((tool) => tool.name);
    if (toolNames.length === 1 && toolNames[0] === "load_skill") {
      this.skillLoadCalls += 1;
      this.serial += 1;
      return {
        content: "",
        toolCalls: [{
          id: `load-${this.serial}`,
          name: "load_skill",
          arguments: { name: "presentation-skill" },
        }],
        finishReason: "tool_calls",
      };
    }

    assert.ok(toolNames.includes("inspect_renderer"));
    if (this.inspections < 5) {
      this.inspections += 1;
      this.serial += 1;
      return {
        content: `Inspection reasoning ${this.inspections}: ${"analysis ".repeat(1_100)}`,
        toolCalls: [{
          id: `inspect-${this.serial}`,
          name: "inspect_renderer",
          arguments: { pass: this.inspections },
        }],
        finishReason: "tool_calls",
      };
    }
    return { content: "artifact candidate complete", toolCalls: [], finishReason: "stop" };
  }
}

function stringTool(name: string, execute: () => string): RuntimeTool<unknown> {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => execute(),
  };
}

function structuredSummary(body: string): string {
  return [
    "## Goal",
    body,
    "## Constraints & Preferences",
    "- constraint",
    "## Progress",
    "### Done",
    "- done",
    "### In Progress",
    "- work",
    "### Blocked",
    "- none",
    "## Key Decisions",
    "- **Decision**: reason",
    "## Evidence",
    "- evidence",
    "## Next Steps",
    "1. continue",
    "## Critical Context",
    "- identifier",
  ].join("\n");
}

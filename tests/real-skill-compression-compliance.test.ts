import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { AgentService } from "../src/agents/agent-service.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import type { RuntimeTool } from "../src/runtime/tool-registry.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { removeSkillPackage } from "../src/skills/skill-package.ts";
import { AppDatabase } from "../src/storage/database.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIRECTORY = resolve(ROOT, "skills");
const DELIVERY_TOOL = "test_record_skill_delivery";

interface SkillScenario {
  readonly skillName: "frontend-design" | "canvas-design";
  readonly task: string;
  readonly criterion: string;
  readonly instructionProbes: readonly string[];
  readonly finalOutput: string;
  readonly deliveryFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

const SCENARIOS: readonly SkillScenario[] = [
  {
    skillName: "frontend-design",
    task: "Design a public web page for a coastal ferry archive.",
    criterion: "Provide a subject-grounded, distinctive, accessible frontend design delivery.",
    instructionProbes: [
      "one concrete subject, its audience, and the page's single job",
      "4–6 named hex values",
      "responsive down to mobile, visible keyboard focus, reduced motion respected",
    ],
    finalOutput: [
      "Delivery: output/frontend-design/ferry-archive.html",
      "Subject / audience / job: a public coastal ferry archive for local-history visitors; help them locate a voyage record.",
      "Tokens: Fog #DCE7E5, Hull #173C4A, Signal #E4552D, Brass #C8A45C, Wake #F5F0E6.",
      "Type roles: Fraunces display, Source Sans 3 body, IBM Plex Mono timetable utility.",
      "Signature: a tide-line route index that shifts only on hover; it replaces generic stat-card hero treatment.",
      "Self-critique: removed a generic numbered-section pattern because the archive is browsed by port, not sequence.",
      "Accessibility: responsive mobile layout, visible keyboard focus, and reduced-motion fallback are specified.",
    ].join("\n"),
    deliveryFiles: [{
      path: "output/frontend-design/ferry-archive.html",
      content: [
        "<!doctype html>",
        "<main aria-label=\"Coastal ferry archive\">",
        "  <h1>Find a crossing</h1>",
        "  <button type=\"button\">Search voyages</button>",
        "</main>",
      ].join("\n"),
    }],
  },
  {
    skillName: "canvas-design",
    task: "Create a one-page visual study of a lunar tide table.",
    criterion: "Provide a visual-first canvas delivery with a design philosophy and restrained text.",
    instructionProbes: [
      "Output only .md files, .pdf files, and .png files",
      "Text is always minimal and visual-first",
      "nothing falls off the page and nothing overlaps",
    ],
    finalOutput: [
      "Delivery: output/canvas-design/lunar-tide-philosophy.md and output/canvas-design/lunar-tide-study.png.",
      "Visual philosophy: Chromatic Tides treats the tide table as measured light: repeated lunar marks form a precise field, with quiet space around a single orbital trace.",
      "Canvas decision: the PNG is visual-first, uses only sparse clinical labels, keeps every mark within margin, and records a no-overlap review.",
      "Typography decision: use the package's canvas-fonts catalogue for a thin label face and keep copy to essential coordinates.",
    ].join("\n"),
    deliveryFiles: [
      {
        path: "output/canvas-design/lunar-tide-philosophy.md",
        content: "# Chromatic Tides\n\nA visual philosophy for an observational lunar tide study.\n",
      },
      {
        path: "output/canvas-design/lunar-tide-study.png",
        content: "PNG-DELIVERY-RECORDED-BY-CONTROLLED-TEST\n",
      },
    ],
  },
];

test("real frontend-design and canvas-design packages survive compaction and require renewed compliance", async (t) => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-real-skill-compression-"));
  const packageStore = join(workspace, ".agentloop", "skill-packages");
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const owner = await auth.register("skill-compression@example.com", "skill compression secure password");
    const skills = new SkillService(database, {
      packageStoreRoot: packageStore,
      skillDirectory: SKILL_DIRECTORY,
    });
    await skills.refreshSkillDirectory();
    const available = await skills.listAvailable(owner.user.id);
    const agents = new AgentService(database, skills);

    for (const scenario of SCENARIOS) {
      await t.test(`${scenario.skillName} is reloaded after its exact body leaves the context tail`, async () => {
        const skill = available.find((candidate) => candidate.name === scenario.skillName);
        assert.notEqual(skill, undefined);
        const model = new CompressionComplianceModel(scenario, skill!.id);
        const agent = agents.create(owner.user.id, {
          name: `${scenario.skillName}-compression-agent`,
          systemPrompt: "Follow the admitted Skill and provide only evidence-backed completion candidates.",
          providerKey: "controlled-scenario",
          maxSteps: 5,
          skillIds: [skill!.id],
          toolNames: [DELIVERY_TOOL],
        });
        const runs = new RunService({
          database,
          skills,
          agents,
          workspaceRoot: workspace,
          tools: [createDeliveryTool(workspace, scenario)],
          modelFactory: () => model,
        });

        const run = await runs.execute(owner.user.id, agent.id, scenario.task);
        assert.equal(run.status, "completed");
        assert.equal(run.output, scenario.finalOutput);
        assert.equal(model.summaryCalls, 1);
        assert.equal(model.assessmentCalls, 2);
        assert.equal(model.executionCalls, 5);

        for (const file of scenario.deliveryFiles) {
          assert.equal(await fs.readFile(join(workspace, file.path), "utf8"), file.content);
        }

        const { plan, assessments } = runs.plan(owner.user.id, run.id);
        assert.deepEqual(plan.selectedSkillIds, [skill!.id]);
        assert.equal(plan.steps[0].skillIds[0], skill!.id);
        assert.equal(assessments.length, 2);
        assert.equal(assessments[0].approved, false);
        assert.equal(assessments[0].skills[0].followed, false);
        assert.equal(assessments[1].approved, true);
        assert.equal(assessments[1].skills[0].followed, true);

        const events = runs.events(owner.user.id, run.id);
        const activated = events.filter((event) => event.type === "skill.activated");
        assert.equal(activated.length, 2);
        assert.equal(activated.every((event) => event.data.name === scenario.skillName), true);
        const compacted = events.filter((event) => event.type === "context.compacted");
        assert.equal(compacted.length, 1);
        assert.deepEqual(compacted[0].data.expiredSkillNames, [scenario.skillName]);
        assert.equal(events.some((event) =>
          event.type === "skill.activation.expired"
          && event.data.name === scenario.skillName
          && event.data.reason === "load_skill_result_compacted"
        ), true);
        assert.equal(events.filter((event) => event.type === "skill.compliance.assessed").length, 2);
        assert.equal(events.at(-1)?.type, "run.completed");
      });
    }
  } finally {
    database.close();
    await removeSkillPackage(workspace).catch(() => undefined);
  }
});

function createDeliveryTool(workspace: string, scenario: SkillScenario): RuntimeTool<unknown> {
  return {
    name: DELIVERY_TOOL,
    description: "Controlled test-only delivery recorder for a Skill scenario.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["skillName"],
      properties: { skillName: { type: "string" } },
    },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (input) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("delivery arguments must be an object");
      }
      const skillName = (input as Record<string, unknown>).skillName;
      if (skillName !== scenario.skillName) throw new TypeError("delivery must name the bound Skill");
      return { skillName };
    },
    execute: async () => {
      for (const file of scenario.deliveryFiles) {
        const output = join(workspace, file.path);
        await fs.mkdir(dirname(output), { recursive: true });
        await fs.writeFile(output, file.content, "utf8");
      }
      return {
        skillName: scenario.skillName,
        files: scenario.deliveryFiles.map((file) => file.path),
        note: "Controlled delivery receipt; visual quality is not asserted by this runtime test.",
      };
    },
  };
}

class CompressionComplianceModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 20_000, maxOutputTokens: 1_024 } as const;
  readonly scenario: SkillScenario;
  readonly skillId: string;
  plannerCalls = 0;
  executionCalls = 0;
  summaryCalls = 0;
  assessmentCalls = 0;

  constructor(scenario: SkillScenario, skillId: string) {
    this.scenario = scenario;
    this.skillId = skillId;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.systemPrompt.includes("planning phase of a plan-first agent runtime")) {
      return this.plan(request);
    }
    if (request.systemPrompt.includes("context summarization component inside an agent runtime")) {
      return this.summarize(request);
    }
    if (request.systemPrompt.includes("independent completion assessor in a plan-first agent runtime")) {
      return this.assess(request);
    }
    return this.execute(request);
  }

  private plan(request: ModelInvocation): ModelResponse {
    this.plannerCalls += 1;
    if (this.plannerCalls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill", "submit_plan"]);
      assert.match(request.runtimeContext?.content ?? "", new RegExp(`<name>${this.scenario.skillName}</name>`));
      this.assertSkillIsNotVisible(request);
      return toolResponse("planner-load", "load_skill", { name: this.scenario.skillName });
    }
    assert.equal(this.plannerCalls, 2);
    this.assertExactLoadedSkill(request);
    return toolResponse("planner-submit", "submit_plan", {
      goal: this.scenario.task,
      selectedSkillIds: [this.skillId],
      steps: [{
        id: `deliver-${this.scenario.skillName}`,
        objective: this.scenario.criterion,
        dependencies: [],
        skillIds: [this.skillId],
        requiredToolNames: [DELIVERY_TOOL],
        successCriteria: [{ id: "delivery", description: this.scenario.criterion }],
      }],
    });
  }

  private summarize(request: ModelInvocation): ModelResponse {
    this.summaryCalls += 1;
    assert.equal(this.summaryCalls, 1);
    const conversation = request.messages.map((message) => message.content).join("\n");
    assert.match(conversation, /Exact Skill body omitted from compaction input; reload after compaction/);
    this.assertSkillIsNotVisible(request);
    return {
      content: [
        "## Goal",
        this.scenario.task,
        "",
        "## Constraints & Preferences",
        "- Reload the exact bound Skill after compaction.",
        "",
        "## Progress",
        "### Done",
        "- A controlled delivery receipt was recorded.",
        "",
        "### In Progress",
        "- Candidate completion requires renewed Skill activation.",
        "",
        "### Blocked",
        "- none",
        "",
        "## Key Decisions",
        "- **Skill authority**: The compacted body must not be inferred from the summary.",
        "",
        "## Evidence",
        "- The first load_skill result is preserved only as canonical evidence.",
        "",
        "## Next Steps",
        "1. Reload the bound Skill before the final candidate.",
        "",
        "## Critical Context",
        `- Bound Skill: ${this.scenario.skillName}.`,
      ].join("\n"),
      toolCalls: [],
      finishReason: "stop",
    };
  }

  private assess(request: ModelInvocation): ModelResponse {
    this.assessmentCalls += 1;
    assert.equal(request.messages.length, 0);
    const assessmentInput = JSON.parse(contextPayload(request, "assessment_context")) as {
      readonly skills: readonly { readonly instructions: string }[];
      readonly evidence: { readonly candidateOutput: string };
      readonly contextSummary?: string;
    };
    assert.equal(assessmentInput.skills.length, 1);
    for (const probe of this.scenario.instructionProbes) {
      assert.match(assessmentInput.skills[0].instructions, new RegExp(escapeRegExp(probe)));
    }
    if (this.assessmentCalls === 1) {
      assert.match(assessmentInput.evidence.candidateOutput, /INTENTIONALLY-OVERLONG-UNVERIFIED-DRAFT/);
      return toolResponse("assessment-reject", "submit_assessment", {
        criteria: [{
          criterionId: "delivery",
          satisfied: false,
          rationale: "The first candidate is intentionally unverified and does not cite the controlled delivery.",
          evidenceRefs: [],
        }],
        skills: [{
          skillId: this.skillId,
          followed: false,
          rationale: "The first candidate does not demonstrate the bound Skill's required design decisions.",
          evidenceRefs: [],
        }],
        feedback: "Reload the exact Skill after compaction and submit a delivery-backed candidate.",
      });
    }
    assert.equal(this.assessmentCalls, 2);
    assert.equal(typeof assessmentInput.contextSummary, "string");
    assert.equal(assessmentInput.evidence.candidateOutput, this.scenario.finalOutput);
    return toolResponse("assessment-approve", "submit_assessment", {
      criteria: [{
        criterionId: "delivery",
        satisfied: true,
        rationale: "The final candidate cites the controlled delivery and its Skill-specific design decisions.",
        evidenceRefs: ["candidateOutput", "test-record-delivery"],
      }],
      skills: [{
        skillId: this.skillId,
        followed: true,
        rationale: "The final candidate directly addresses the bound Skill's loaded requirements after renewed activation.",
        evidenceRefs: ["candidateOutput", "load_skill"],
      }],
      feedback: "",
    });
  }

  private execute(request: ModelInvocation): ModelResponse {
    this.executionCalls += 1;
    const tools = request.tools.map((tool) => tool.name);
    if (this.executionCalls === 1) {
      assert.deepEqual(tools, ["load_skill"]);
      this.assertSkillIsNotVisible(request);
      return toolResponse("step-load", "load_skill", { name: this.scenario.skillName });
    }
    if (this.executionCalls === 2) {
      assert.deepEqual(tools, [DELIVERY_TOOL, "load_skill"]);
      this.assertExactLoadedSkill(request);
      return toolResponse("record-delivery", DELIVERY_TOOL, { skillName: this.scenario.skillName });
    }
    if (this.executionCalls === 3) {
      assert.deepEqual(tools, [DELIVERY_TOOL, "load_skill"]);
      this.assertExactLoadedSkill(request);
      return {
        content: `INTENTIONALLY-OVERLONG-UNVERIFIED-DRAFT\n${"draft ".repeat(5_000)}`,
        toolCalls: [],
        finishReason: "stop",
      };
    }
    if (this.executionCalls === 4) {
      assert.deepEqual(tools, ["load_skill"]);
      assert.match(request.runtimeContext?.content ?? "", /structured_summary/);
      this.assertSkillIsNotVisible(request);
      return toolResponse("step-reload", "load_skill", { name: this.scenario.skillName });
    }
    assert.equal(this.executionCalls, 5);
    assert.deepEqual(tools, []);
    this.assertExactLoadedSkill(request);
    return { content: this.scenario.finalOutput, toolCalls: [], finishReason: "stop" };
  }

  private assertExactLoadedSkill(request: ModelInvocation): void {
    const content = request.messages.map((message) => message.content).join("\n");
    for (const probe of this.scenario.instructionProbes) assert.match(content, new RegExp(escapeRegExp(probe)));
    assert.match(content, new RegExp(`<skill_content [^>]*name=\"${this.scenario.skillName}\"`));
  }

  private assertSkillIsNotVisible(request: ModelInvocation): void {
    const content = [request.systemPrompt, request.runtimeContext?.content ?? "", ...request.messages.map((message) => message.content)].join("\n");
    for (const probe of this.scenario.instructionProbes) assert.doesNotMatch(content, new RegExp(escapeRegExp(probe)));
  }
}

function contextPayload(request: ModelInvocation, tag: string): string {
  const match = (request.runtimeContext?.content ?? "").match(new RegExp(`<${tag}[^>]*>\\n([\\s\\S]*?)\\n</${tag}>`));
  assert.ok(match?.[1], `${tag} must be present in the server Runtime Context`);
  return match[1];
}

function toolResponse(id: string, name: string, argumentsValue: unknown): ModelResponse {
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id, name, arguments: argumentsValue }],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppError } from "../src/shared/errors.ts";
import { AppDatabase } from "../src/storage/database.ts";
import {
  evaluateAcceptance,
  parsePresentationE2EArgs,
  renderPresentationTaskTemplate,
  writeFailureEvidence,
} from "../scripts/run-presentation-e2e.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import {
  classifyRenderEnvironmentCredibility,
  type FontResolutionEvidence,
} from "../src/acceptance/render-environment.ts";

test("presentation E2E accepts a bounded task template and configurable visual acceptance", () => {
  const cli = parsePresentationE2EArgs([
    "--task-file",
    "scripts/prompts/presentation-visual-redesign.txt",
    "--expected-slides",
    "8",
    "--require-visual-review",
    "--max-steps",
    "80",
  ]);
  assert.deepEqual(cli, {
    taskFile: "scripts/prompts/presentation-visual-redesign.txt",
    expectedSlideCount: 8,
    requireVisualReview: true,
    maxSteps: 80,
  });
  const task = renderPresentationTaskTemplate(
    "workspace={{ABS_WORK_ROOT}} slides={{EXPECTED_SLIDE_COUNT}} output={{FINAL_PPTX}}",
    {
      relativeRunRoot: "outputs/run",
      workRoot: "outputs/run/work",
      outlinePath: "outputs/run/work/outline.json",
      finalPptx: "outputs/run/deck.pptx",
      qaDir: "outputs/run/work/qa",
      qaReport: "outputs/run/work/qa/qa_report.json",
    },
    8,
  );
  assert.match(task, /workspace=\/.*\/outputs\/run\/work slides=8 output=outputs\/run\/deck\.pptx/);
  assert.doesNotMatch(task, /\{\{/);
});

test("Saved Workspace build and rendered visual review satisfy the original-package acceptance lane", () => {
  const packageRoot = "outputs/run/installed/package";
  const acceptance = evaluateAcceptance({
    events: [{
      type: "tool.planned",
      data: {
        arguments: {
          command: "python3",
          args: [`${packageRoot}/scripts/build_workspace.py`, "--qa", "--visual-review"],
        },
      },
    }] as never,
    installedPackageRoot: packageRoot,
    sourceBefore: { packageHash: "hash" } as never,
    sourceAfter: { packageHash: "hash" } as never,
    installedAfter: { packageHash: "hash" } as never,
    finalPptx: "outputs/run/deck.pptx",
    qa: {
      expected_slide_count: 8,
      rendered_slide_count: 8,
      render_rc: 0,
      overflow_count: 0,
      overlap_count: 0,
      design_error_count: 0,
      design_warning_count: 0,
      visual_review_rc: 0,
      visual_review_warning_count: 0,
      visual_review_report: "/tmp/visual-review.json",
      visual_review_contact_sheet: "/tmp/contact-sheet.png",
      font_families: ["Helvetica Neue"],
    },
    renderEnvironment: {
      schema: "agentloop.renderEnvironment/v1",
      renderer: { engine: "soffice" },
      declaredFonts: [{ requestedFamily: "Helvetica Neue" }],
      credibility: { level: "reproducible" },
    } as never,
    outcome: { status: "completed", reason_code: "plan_assessed_and_completed" },
    expectedSlideCount: 8,
    requireVisualReview: true,
  });

  assert.equal(acceptance.passed, true);
  assert.equal(acceptance.originalBuilderObserved, true);
  assert.equal(acceptance.originalQaObserved, true);
  assert.equal(acceptance.visualReviewPassed, true);
});

test("presentation E2E failure persists its canonical Run evidence before exiting", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-ppt-evidence-"));
  const database = new AppDatabase(join(workspace, "runtime.db"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("ppt-evidence@example.com", "ppt evidence secure password");
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new LocalFailureModel(),
      workspaceRoot: workspace,
    });
    let runFailure: unknown;
    try {
      await runs.execute(owner.user.id, "trigger a local planner failure");
    } catch (error) {
      runFailure = error;
    }
    assert.ok(runFailure instanceof AppError);
    const runId = runFailure.details?.runId;
    assert.equal(typeof runId, "string");

    const evidencePath = join(workspace, "evidence.json");
    const qaReport = join(workspace, "qa-report.json");
    await fs.writeFile(qaReport, JSON.stringify({
      render_stdout_tail: "[render] PDF via soffice in 0.62s",
      rendered_slide_count: 6,
      expected_slide_count: 6,
      font_families: ["Calibri", "Trebuchet MS"],
      manual_review_passed: false,
    }));
    await writeFailureEvidence({
      evidencePath,
      stage: "execute-run",
      error: runFailure,
      database,
      runs,
      actorUserId: owner.user.id,
      finalPptx: join(workspace, "missing.pptx"),
      outlinePath: join(workspace, "missing-outline.json"),
      qaReport,
      announce: false,
    });

    const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8")) as {
      status: string;
      stage: string;
      runId: string;
      run: { status: string };
      outcome: { status: string; reason_code: string };
      eventSummary: Record<string, number>;
      artifact: {
        renderEnvironment: {
          schema: string;
          renderer: { engine: string };
          declaredFonts: Array<{ requestedFamily: string }>;
          credibility: { humanVisualInspection: string; targetViewerParity: string };
        };
      };
    };
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.stage, "execute-run");
    assert.equal(evidence.runId, runId);
    assert.equal(evidence.run.status, "failed");
    assert.equal(evidence.outcome.status, "failed");
    assert.equal(evidence.outcome.reason_code, "MODEL_ERROR");
    assert.equal(evidence.eventSummary["run.started"], 1);
    assert.equal(evidence.eventSummary["run.failed"], 1);
    assert.equal(evidence.artifact.renderEnvironment.schema, "agentloop.renderEnvironment/v1");
    assert.equal(evidence.artifact.renderEnvironment.renderer.engine, "soffice");
    assert.deepEqual(
      evidence.artifact.renderEnvironment.declaredFonts.map((item) => item.requestedFamily),
      ["Calibri", "Trebuchet MS"],
    );
    assert.equal(evidence.artifact.renderEnvironment.credibility.humanVisualInspection, "not-established");
    assert.equal(evidence.artifact.renderEnvironment.credibility.targetViewerParity, "not-established");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("font substitution limits automated render credibility without declaring the PPT invalid", () => {
  const fonts: FontResolutionEvidence[] = [
    {
      requestedFamily: "Calibri",
      resolver: "fontconfig",
      resolved: true,
      exactFamilyMatch: false,
      matchedFamilies: ["Hiragino Sans"],
      matchedFile: "/fonts/hiragino.ttc",
    },
    {
      requestedFamily: "Trebuchet MS",
      resolver: "fontconfig",
      resolved: true,
      exactFamilyMatch: true,
      matchedFamilies: ["Trebuchet MS"],
      matchedFile: "/fonts/trebuchet.ttf",
    },
  ];

  const credibility = classifyRenderEnvironmentCredibility({
    renderer: { engine: "soffice", version: "LibreOffice 26.8" },
    declaredFonts: fonts,
  });

  assert.equal(credibility.level, "environment-limited");
  assert.equal(credibility.substitutedFontCount, 1);
  assert.equal(credibility.unresolvedFontCount, 0);
  assert.ok(credibility.reasons.includes("font-substituted:Calibri->Hiragino Sans"));
  assert.equal(credibility.glyphCoverage, "not-measured");
  assert.equal(credibility.targetViewerParity, "not-established");
  assert.equal(credibility.humanVisualInspection, "not-established");
});

class LocalFailureModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  async complete(): Promise<never> {
    throw new AppError("MODEL_ERROR", "Deliberate local model failure", 502);
  }
}

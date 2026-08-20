import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  collectRenderEnvironmentEvidence,
  type RenderEnvironmentEvidence,
} from "../src/acceptance/render-environment.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { OpenAICompatibleModel } from "../src/runtime/models.ts";
import { inspectSkillPackage } from "../src/skills/skill-package.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import { AppError } from "../src/shared/errors.ts";
import { AppDatabase } from "../src/storage/database.ts";

const ROOT = resolve(import.meta.dirname, "..");
const RUNTIME_NODE = "/Users/zhujun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const RUNTIME_NODE_MODULES = "/Users/zhujun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const RUNTIME_PYTHON = "/Users/zhujun/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const RUNTIME_BIN_DIR = "/Users/zhujun/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override";
const UPSTREAM_SKILL_ROOT = resolve(ROOT, "skills/presentation-skill");
const UPSTREAM_SOURCE_LOCK = resolve(ROOT, "skills/presentation-skill.source.json");
const UPSTREAM_REPOSITORY = "https://github.com/siril9/presentation-skill";
const UPSTREAM_REVISION = "3a22eed290fa2205b6a1e2de5549b4429c5fffd0";

export interface PresentationE2ECliOptions {
  readonly taskFile?: string;
  readonly expectedSlideCount: number;
  readonly requireVisualReview: boolean;
  readonly maxSteps: number;
}

interface PresentationTaskEvidence {
  readonly source: string;
  readonly sha256: string;
  readonly expectedSlideCount: number;
  readonly requireVisualReview: boolean;
  readonly maxSteps: number;
}

interface PresentationTaskPaths {
  readonly relativeRunRoot: string;
  readonly workRoot: string;
  readonly outlinePath: string;
  readonly finalPptx: string;
  readonly qaDir: string;
  readonly qaReport: string;
}

export function parsePresentationE2EArgs(args: readonly string[]): PresentationE2ECliOptions {
  let taskFile: string | undefined;
  let expectedSlideCount = 6;
  let requireVisualReview = false;
  let maxSteps = 48;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--task-file") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--task-file requires a path");
      taskFile = value;
      index += 1;
      continue;
    }
    if (argument === "--expected-slides") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new Error("--expected-slides must be an integer from 1 to 50");
      }
      expectedSlideCount = value;
      index += 1;
      continue;
    }
    if (argument === "--require-visual-review") {
      requireVisualReview = true;
      continue;
    }
    if (argument === "--max-steps") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--max-steps must be an integer from 1 to 100");
      }
      maxSteps = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown presentation E2E argument: ${argument}`);
  }
  return {
    ...(taskFile === undefined ? {} : { taskFile }),
    expectedSlideCount,
    requireVisualReview,
    maxSteps,
  };
}

export function renderPresentationTaskTemplate(
  template: string,
  paths: PresentationTaskPaths,
  expectedSlideCount: number,
): string {
  const replacements: Record<string, string> = {
    "{{RUN_ROOT}}": paths.relativeRunRoot,
    "{{WORK_ROOT}}": paths.workRoot,
    "{{OUTLINE_PATH}}": paths.outlinePath,
    "{{FINAL_PPTX}}": paths.finalPptx,
    "{{QA_DIR}}": paths.qaDir,
    "{{QA_REPORT}}": paths.qaReport,
    "{{ABS_RUN_ROOT}}": resolve(ROOT, paths.relativeRunRoot),
    "{{ABS_WORK_ROOT}}": resolve(ROOT, paths.workRoot),
    "{{ABS_OUTLINE_PATH}}": resolve(ROOT, paths.outlinePath),
    "{{ABS_FINAL_PPTX}}": resolve(ROOT, paths.finalPptx),
    "{{ABS_QA_DIR}}": resolve(ROOT, paths.qaDir),
    "{{ABS_QA_REPORT}}": resolve(ROOT, paths.qaReport),
    "{{EXPECTED_SLIDE_COUNT}}": String(expectedSlideCount),
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) {
    throw new Error("Presentation E2E task contains an unresolved placeholder");
  }
  if (rendered.trim().length === 0) throw new Error("Presentation E2E task is empty");
  return rendered.trim();
}

async function readApiKey(): Promise<string> {
  const rawInput = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (rawInput) process.stdin.setRawMode(true);
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of lines) {
      const apiKey = line.trim();
      if (apiKey.length < 16) throw new Error("DeepSeek API key was not supplied on stdin");
      return apiKey;
    }
  } finally {
    lines.close();
    if (rawInput) process.stdin.setRawMode(false);
  }
  throw new Error("DeepSeek API key was not supplied on stdin");
}

async function readTaskFile(requestedPath: string): Promise<string> {
  const candidate = resolve(ROOT, requestedPath);
  const actual = await fs.realpath(candidate).catch(() => undefined);
  if (actual === undefined) throw new Error(`Presentation E2E task file does not exist: ${requestedPath}`);
  const offset = relative(ROOT, actual);
  if (offset === ".." || offset.startsWith("../") || resolve(ROOT, offset) !== actual) {
    throw new Error("Presentation E2E task file must stay inside the AgentLoop workspace");
  }
  const stat = await fs.stat(actual);
  if (!stat.isFile() || stat.size > 200_000) {
    throw new Error("Presentation E2E task file must be a regular file no larger than 200 KB");
  }
  return fs.readFile(actual, "utf8");
}

function defaultPresentationTask(paths: PresentationTaskPaths, expectedSlideCount: number): string {
  return [
    "必须使用并严格遵循已安装的原始 presentation-skill Package，不能修改、包装或补充该 Skill。",
    `创建一份 ${expectedSlideCount} 页中文可编辑 PPTX，主题为“AgentLoop Plan-first 智能体框架”，面向企业技术决策者。`,
    "内容只允许来自本地 README.md 与 docs/ARCHITECTURE.md，不得虚构客户、效果指标、部署结果或上游事实。",
    "叙事需覆盖核心 Agent Loop、Plan/Admission、私有 Skill 遵循、Computer Tool、会话式单 Agent 执行、Batch 与安全边界。",
    `将唯一 outline.json 写到 ${paths.outlinePath}，最终 PPTX 写到 ${paths.finalPptx}，QA 输出目录固定为 ${paths.qaDir}。`,
    "选择原始 Skill 支持的 Quick Deck 路径与合适的 style preset；使用原始 Package 自带 builder 和 qa_gate.py。",
    `最终自动化 QA 必须实际渲染全部 ${expectedSlideCount} 页，不得以 --skip-render 作为最终证据；可以明确跳过人工复核门槛，但不得声称人工视觉检查已完成。`,
    `完成前必须读取 ${paths.qaReport} 并报告 slide count、render count、overflow、overlap、design errors/warnings 与 QA 返回状态。`,
    "计划应包含 2-3 个有依赖关系的步骤，并将 presentation-skill 绑定到实际需要其规范的步骤。",
    "禁止使用 python-pptx 自制脚本、@oai/artifact-tool 自制脚本或其他替代 renderer。",
  ].join("\n");
}

async function main(): Promise<void> {
  const cli = parsePresentationE2EArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const relativeRunRoot = `outputs/presentation-skill-e2e/${stamp}`;
  const runRoot = resolve(ROOT, relativeRunRoot);
  const evidencePath = resolve(runRoot, "evidence.json");
  const workRoot = `${relativeRunRoot}/work`;
  const outlinePath = `${workRoot}/outline.json`;
  const finalPptx = `${relativeRunRoot}/agentloop-framework.pptx`;
  const qaDir = `${workRoot}/qa`;
  const qaReport = `${qaDir}/qa_report.json`;
  await fs.mkdir(resolve(ROOT, workRoot), { recursive: true });
  const taskPaths = { relativeRunRoot, workRoot, outlinePath, finalPptx, qaDir, qaReport };
  const taskTemplate = cli.taskFile === undefined
    ? defaultPresentationTask(taskPaths, cli.expectedSlideCount)
    : await readTaskFile(cli.taskFile);
  const task = renderPresentationTaskTemplate(taskTemplate, taskPaths, cli.expectedSlideCount);
  const taskEvidence: PresentationTaskEvidence = {
    source: cli.taskFile === undefined ? "builtin:quick-deck" : relative(ROOT, resolve(ROOT, cli.taskFile)),
    sha256: sha256(task),
    expectedSlideCount: cli.expectedSlideCount,
    requireVisualReview: cli.requireVisualReview,
    maxSteps: cli.maxSteps,
  };
  const apiKey = await readApiKey();

  let stage = "verify-upstream-source";
  let database: AppDatabase | undefined;
  let runs: RunService | undefined;
  let actorUserId: string | undefined;
  let runId: string | undefined;
  let sourceBefore: Awaited<ReturnType<typeof inspectSkillPackage>> | undefined;
  let sourceLock: Record<string, unknown> | undefined;
  let installedSkill: PrivateSkill | undefined;
  let evidenceWritten = false;
  try {
    const verifiedSource = await inspectSkillPackage(UPSTREAM_SKILL_ROOT);
    sourceBefore = verifiedSource;
    const sourceSkillMdSha256 = sha256(verifiedSource.instructions);
    const verifiedSourceLock = await readOptionalSourceLock();
    sourceLock = verifiedSourceLock;
    if (verifiedSourceLock !== undefined && (
      verifiedSourceLock.repository !== UPSTREAM_REPOSITORY
      || verifiedSourceLock.revision !== UPSTREAM_REVISION
      || verifiedSourceLock.packageSha256 !== verifiedSource.packageHash
      || verifiedSourceLock.skillMdSha256 !== sourceSkillMdSha256
      || verifiedSourceLock.packageFileCount !== verifiedSource.fileCount
      || verifiedSourceLock.packageTotalBytes !== verifiedSource.totalBytes
    )) {
      throw new Error("Local upstream Skill snapshot does not match its optional source lock");
    }

    stage = "initialize-runtime";
    database = new AppDatabase(resolve(runRoot, "agentloop-e2e.db"));
    const auth = new AuthService(database);
    const skills = new SkillService(database, {
      packageStoreRoot: resolve(runRoot, "installed-skills"),
      skillDirectory: resolve(ROOT, "skills"),
    });
    await skills.refreshSkillDirectory();
    const user = await auth.register(
      `ppt-e2e-${randomUUID()}@example.invalid`,
      `E2E-${randomUUID()}-strong-password`,
    );
    actorUserId = user.user.id;
    stage = "discover-and-provision-upstream-package";
    const currentInstalledSkill = (await skills.resolveForConversation(user.user.id))
      .find((skill) => skill.name === "presentation-skill");
    if (currentInstalledSkill === undefined) {
      throw new Error("AgentLoop did not discover presentation-skill from the configured Skill directory");
    }
    installedSkill = currentInstalledSkill;
    if (currentInstalledSkill.package === undefined) throw new Error("Installed Skill is not package-backed");
    if (
      currentInstalledSkill.instructions !== verifiedSource.instructions
      || currentInstalledSkill.package.packageHash !== verifiedSource.packageHash
    ) {
      throw new Error("Installed Skill package differs from the upstream source snapshot");
    }

    stage = "initialize-model";
    const model = new OpenAICompatibleModel({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey,
      model: "deepseek-chat",
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
      timeoutMs: 240_000,
    });
    runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      workspaceRoot: ROOT,
      computerExecutableAliases: {
        node: RUNTIME_NODE,
        python3: RUNTIME_PYTHON,
      },
      computerCommandEnvironment: {
        PPTX_NODE_MODULES: RUNTIME_NODE_MODULES,
        PATH: `${RUNTIME_BIN_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    stage = "execute-run";
    let run: Awaited<ReturnType<RunService["execute"]>>;
    try {
      run = await runs.execute(user.user.id, task, { allowDangerousTools: true });
      runId = run.id;
    } catch (error) {
      runId = extractRunId(error);
      throw error;
    }
    stage = "collect-run-evidence";
    const plan = runs.plan(user.user.id, run.id);
    const events = runs.events(user.user.id, run.id);
    const outcome = database.prepare(
      "SELECT run_id, plan_id, status, output, reason_code, committed_at FROM run_outcomes WHERE run_id = ?",
    ).get(run.id) as Record<string, unknown> | undefined;

    const sourceAfter = await inspectSkillPackage(UPSTREAM_SKILL_ROOT);
    const installedAfter = await inspectSkillPackage(currentInstalledSkill.package.root);
    const artifact = await requireFile(resolve(ROOT, finalPptx));
    const qaArtifact = await requireFile(resolve(ROOT, qaReport));
    const qa = JSON.parse(await fs.readFile(resolve(ROOT, qaReport), "utf8")) as Record<string, unknown>;
    const renderEnvironment = await collectRenderEnvironmentEvidence({
      qa,
      runtimeBinDirectory: RUNTIME_BIN_DIR,
      searchPath: `${RUNTIME_BIN_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    const acceptance = evaluateAcceptance({
      events,
      installedPackageRoot: relative(ROOT, currentInstalledSkill.package.root),
      sourceBefore: verifiedSource,
      sourceAfter,
      installedAfter,
      finalPptx,
      qa,
      renderEnvironment,
      outcome,
      expectedSlideCount: cli.expectedSlideCount,
      requireVisualReview: cli.requireVisualReview,
    });
    const evidence = {
      generatedAt: new Date().toISOString(),
      task: taskEvidence,
      sourceSkill: {
        sourcePath: relative(ROOT, UPSTREAM_SKILL_ROOT),
        entrypoint: "SKILL.md",
        skillMdSha256: sourceSkillMdSha256,
        sourcePackageHashBefore: verifiedSource.packageHash,
        sourcePackageHashAfter: sourceAfter.packageHash,
        installedPackageHash: installedAfter.packageHash,
        fileCount: verifiedSource.fileCount,
        totalBytes: verifiedSource.totalBytes,
        installedSkillId: currentInstalledSkill.id,
        sourceKind: currentInstalledSkill.sourceKind,
        ...(verifiedSourceLock === undefined ? { provenance: "unlocked" } : {
          repository: UPSTREAM_REPOSITORY,
          revision: UPSTREAM_REVISION,
          archiveUrl: verifiedSourceLock.archiveUrl,
          archiveSha256: verifiedSourceLock.archiveSha256,
          packageSubpath: verifiedSourceLock.packageSubpath,
        }),
      },
      acceptance,
      run,
      plan,
      outcome,
      eventSummary: events.reduce<Record<string, number>>((counts, event) => {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        return counts;
      }, {}),
      toolEvents: events.filter((event) => event.type.startsWith("tool.")),
      artifact: {
        pptx: finalPptx,
        pptxBytes: artifact.size,
        pptxSha256: await sha256File(resolve(ROOT, finalPptx)),
        outline: outlinePath,
        qaReport,
        qaReportBytes: qaArtifact.size,
        qa,
        renderEnvironment,
      },
    };
    await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    evidenceWritten = true;
    if (!acceptance.passed) {
      throw new Error(`Presentation Skill E2E acceptance failed: ${acceptance.failures.join("; ")}`);
    }
    process.stdout.write(`${JSON.stringify({
      runId: run.id,
      status: run.status,
      planId: plan.plan.id,
      planSteps: plan.plan.steps.length,
      approvedAssessments: plan.assessments.filter((item) => item.approved).length,
      totalAssessments: plan.assessments.length,
      packageHash: installedAfter.packageHash,
      packageUnchanged: acceptance.packageUnchanged,
      originalBuilderObserved: acceptance.originalBuilderObserved,
      originalQaObserved: acceptance.originalQaObserved,
      renderCredibility: acceptance.renderCredibility,
      finalPptx,
      qaReport,
      evidence: `${relativeRunRoot}/evidence.json`,
    })}\n`);
  } catch (error) {
    if (!evidenceWritten) {
      await writeFailureEvidence({
        evidencePath,
        stage,
        error,
        database,
        runs,
        actorUserId,
        runId,
        sourceBefore,
        sourceLock,
        installedSkill,
        taskEvidence,
        finalPptx,
        outlinePath,
        qaReport,
      });
    }
    throw error;
  } finally {
    database?.close();
  }
}

export function evaluateAcceptance(input: {
  events: ReturnType<RunService["events"]>;
  installedPackageRoot: string;
  sourceBefore: Awaited<ReturnType<typeof inspectSkillPackage>>;
  sourceAfter: Awaited<ReturnType<typeof inspectSkillPackage>>;
  installedAfter: Awaited<ReturnType<typeof inspectSkillPackage>>;
  finalPptx: string;
  qa: Record<string, unknown>;
  renderEnvironment: RenderEnvironmentEvidence;
  outcome: Record<string, unknown> | undefined;
  expectedSlideCount?: number;
  requireVisualReview?: boolean;
}): {
  passed: boolean;
  failures: string[];
  packageUnchanged: boolean;
  originalBuilderObserved: boolean;
  originalQaObserved: boolean;
  forbiddenCustomRendererObserved: boolean;
  terminalCompleted: boolean;
  automatedQaPassed: boolean;
  visualReviewPassed: boolean;
  renderEnvironmentRecorded: boolean;
  renderCredibility: RenderEnvironmentEvidence["credibility"];
  humanVisualInspection: string;
  finalPptx: string;
} {
  const plannedCalls = input.events
    .filter((event) => event.type === "tool.planned")
    .map((event) => JSON.stringify(event.data.arguments ?? {}));
  const packagePrefix = input.installedPackageRoot.replaceAll("\\", "/");
  const workspaceBuildCalls = plannedCalls.filter((call) =>
    call.includes(`${packagePrefix}/scripts/build_workspace.py`)
  );
  const originalBuilderObserved = workspaceBuildCalls.length > 0 || plannedCalls.some((call) =>
    call.includes(`${packagePrefix}/scripts/build_deck_pptxgenjs.js`)
  );
  const originalQaObserved = plannedCalls.some((call) =>
    call.includes(`${packagePrefix}/scripts/qa_gate.py`)
  ) || workspaceBuildCalls.some((call) => call.includes('"--qa"'));
  const forbiddenCustomRendererObserved = plannedCalls.some((call) => call.includes("@oai/artifact-tool"));
  const packageUnchanged = input.sourceBefore.packageHash === input.sourceAfter.packageHash
    && input.sourceBefore.packageHash === input.installedAfter.packageHash;
  const terminalCompleted = input.outcome?.status === "completed"
    && input.outcome?.reason_code === "plan_assessed_and_completed";
  const requiredSlideCount = input.expectedSlideCount ?? 6;
  const expectedSlideCount = Number(input.qa.expected_slide_count ?? -1);
  const renderedSlideCount = Number(input.qa.rendered_slide_count ?? -1);
  const automatedQaPassed = expectedSlideCount === requiredSlideCount
    && renderedSlideCount === requiredSlideCount
    && Number(input.qa.render_rc ?? -1) === 0
    && Number(input.qa.overflow_count ?? -1) === 0
    && Number(input.qa.overlap_count ?? -1) === 0
    && Number(input.qa.design_error_count ?? -1) === 0
    && Number(input.qa.design_warning_count ?? -1) === 0;
  const visualReviewPassed = input.requireVisualReview !== true || (
    Number(input.qa.visual_review_rc ?? -1) === 0
    && Number(input.qa.visual_review_warning_count ?? -1) === 0
    && typeof input.qa.visual_review_report === "string"
    && input.qa.visual_review_report.length > 0
    && typeof input.qa.visual_review_contact_sheet === "string"
    && input.qa.visual_review_contact_sheet.length > 0
  );
  const qaFontFamilies = Array.isArray(input.qa.font_families)
    ? input.qa.font_families.filter((item): item is string => typeof item === "string")
    : [];
  const recordedFontFamilies = input.renderEnvironment.declaredFonts.map((item) => item.requestedFamily);
  const renderEnvironmentRecorded = input.renderEnvironment.schema === "agentloop.renderEnvironment/v1"
    && input.renderEnvironment.renderer.engine !== "unknown"
    && qaFontFamilies.length === recordedFontFamilies.length
    && qaFontFamilies.every((family) => recordedFontFamilies.includes(family));
  const failures = [
    packageUnchanged ? "" : "Skill package hash changed",
    originalBuilderObserved ? "" : "Original Skill builder was not observed",
    originalQaObserved ? "" : "Original Skill QA gate was not observed",
    forbiddenCustomRendererObserved ? "Forbidden custom renderer was used" : "",
    terminalCompleted ? "" : "Persisted terminal outcome is not completed",
    automatedQaPassed ? "" : "Original Skill automated QA evidence is incomplete",
    visualReviewPassed ? "" : "Original Skill rendered visual review evidence is incomplete",
    renderEnvironmentRecorded ? "" : "Render and font environment evidence is incomplete",
  ].filter(Boolean);
  return {
    passed: failures.length === 0,
    failures,
    packageUnchanged,
    originalBuilderObserved,
    originalQaObserved,
    forbiddenCustomRendererObserved,
    terminalCompleted,
    automatedQaPassed,
    visualReviewPassed,
    renderEnvironmentRecorded,
    renderCredibility: input.renderEnvironment.credibility,
    humanVisualInspection: "not-claimed-by-agent; required as independent post-run acceptance",
    finalPptx: input.finalPptx,
  };
}

export async function writeFailureEvidence(input: {
  evidencePath: string;
  stage: string;
  error: unknown;
  database?: AppDatabase;
  runs?: RunService;
  actorUserId?: string;
  runId?: string;
  sourceBefore?: Awaited<ReturnType<typeof inspectSkillPackage>>;
  sourceLock?: Record<string, unknown>;
  installedSkill?: PrivateSkill;
  taskEvidence?: PresentationTaskEvidence;
  finalPptx: string;
  outlinePath: string;
  qaReport: string;
  announce?: boolean;
}): Promise<void> {
  const detectedRunId = input.runId ?? extractRunId(input.error) ?? findLatestRunId(input);
  const run = collectPersisted(() => {
    if (detectedRunId === undefined || input.runs === undefined || input.actorUserId === undefined) return undefined;
    return input.runs.get(input.actorUserId, detectedRunId);
  });
  const plan = collectPersisted(() => {
    if (detectedRunId === undefined || input.runs === undefined || input.actorUserId === undefined) return undefined;
    return input.runs.plan(input.actorUserId, detectedRunId);
  });
  const events = collectPersisted(() => {
    if (detectedRunId === undefined || input.runs === undefined || input.actorUserId === undefined) return [];
    return input.runs.events(input.actorUserId, detectedRunId);
  }) ?? [];
  const outcome = collectPersisted(() => {
    if (detectedRunId === undefined || input.database === undefined) return undefined;
    return input.database.prepare(
      "SELECT run_id, plan_id, status, output, reason_code, committed_at FROM run_outcomes WHERE run_id = ?",
    ).get(detectedRunId) as Record<string, unknown> | undefined;
  });
  const sourceAfter = input.sourceBefore === undefined
    ? undefined
    : await inspectSkillPackage(UPSTREAM_SKILL_ROOT).catch(() => undefined);
  const installedAfter = input.installedSkill?.package === undefined
    ? undefined
    : await inspectSkillPackage(input.installedSkill.package.root).catch(() => undefined);
  const pptx = await fileEvidence(input.finalPptx);
  const qaReport = await fileEvidence(input.qaReport);
  const qa = await readJsonIfPresent(input.qaReport);
  const renderEnvironment = isRecord(qa)
    ? await collectRenderEnvironmentEvidence({
      qa,
      runtimeBinDirectory: RUNTIME_BIN_DIR,
      searchPath: `${RUNTIME_BIN_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    })
    : undefined;
  const eventSummary = events.reduce<Record<string, number>>((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});
  const evidence = {
    generatedAt: new Date().toISOString(),
    status: "failed",
    stage: input.stage,
    failure: serializeError(input.error),
    task: input.taskEvidence,
    sourceSkill: {
      sourcePath: relative(ROOT, UPSTREAM_SKILL_ROOT),
      sourcePackageHashBefore: input.sourceBefore?.packageHash,
      sourcePackageHashAfter: sourceAfter?.packageHash,
      installedPackageHash: installedAfter?.packageHash,
      installedSkillId: input.installedSkill?.id,
      sourceKind: input.installedSkill?.sourceKind,
      ...(input.sourceLock === undefined ? { provenance: "unlocked" } : {
        repository: UPSTREAM_REPOSITORY,
        revision: UPSTREAM_REVISION,
        sourceLock: input.sourceLock,
      }),
    },
    runId: detectedRunId,
    run,
    plan,
    outcome,
    eventSummary,
    toolEvents: events.filter((event) => event.type.startsWith("tool.")),
    artifact: {
      pptx: input.finalPptx,
      pptxEvidence: pptx,
      outline: input.outlinePath,
      qaReport: input.qaReport,
      qaReportEvidence: qaReport,
      qa,
      renderEnvironment,
    },
  };
  await fs.writeFile(input.evidencePath, JSON.stringify(evidence, null, 2));
  if (input.announce !== false) {
    process.stderr.write(`Diagnostic evidence: ${relative(ROOT, input.evidencePath)}\n`);
  }
}

function extractRunId(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined;
  const value = error.details?.runId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findLatestRunId(input: {
  database?: AppDatabase;
  actorUserId?: string;
}): string | undefined {
  if (input.database === undefined || input.actorUserId === undefined) return undefined;
  const row = input.database.prepare(`
    SELECT id FROM runs
    WHERE owner_user_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(input.actorUserId) as { id: string } | undefined;
  return row?.id;
}

function collectPersisted<T>(load: () => T): T | undefined {
  try {
    return load();
  } catch {
    return undefined;
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      name: error.name,
      code: error.code,
      status: error.status,
      message: error.message,
      details: error.details,
    };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function fileEvidence(path: string): Promise<Record<string, unknown> | undefined> {
  const stat = await fs.stat(resolve(ROOT, path)).catch(() => undefined);
  if (stat === undefined || !stat.isFile()) return undefined;
  return { size: stat.size, sha256: await sha256File(resolve(ROOT, path)) };
}

async function readOptionalSourceLock(): Promise<Record<string, unknown> | undefined> {
  const source = await fs.readFile(UPSTREAM_SOURCE_LOCK, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source === undefined) return undefined;
  try {
    const value = JSON.parse(source) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonIfPresent(path: string): Promise<unknown> {
  const content = await fs.readFile(resolve(ROOT, path), "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return { invalidJson: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function requireFile(path: string): Promise<{ size: number }> {
  const stat = await fs.stat(path).catch(() => undefined);
  if (stat === undefined || !stat.isFile() || stat.size === 0) throw new Error(`Required artifact is missing: ${path}`);
  return { size: stat.size };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}

if (import.meta.main) {
  main().catch((error) => {
    const publicError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${publicError}\n`);
    process.exitCode = 1;
  });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactAcceptanceService } from "../src/acceptance/artifact-acceptance.ts";
import type { ArtifactAcceptanceProvider } from "../src/acceptance/artifact-acceptance-provider.ts";
import { createPlaywrightArtifactAcceptanceProvider } from "../src/acceptance/playwright-artifact-acceptance-provider.ts";
import { buildCommandEnvironment, ComputerExecutor, parseGrepLine, parseRgJsonLine } from "../src/computer/computer-executor.ts";
import { createComputerTools } from "../src/tools/computer-tools.ts";
import { createVisibleDirectoryTools } from "../src/tools/visible-directory-tools.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

test("computer paths cannot escape the workspace lexically or through a symbolic link", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-computer-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "agentloop-outside-"));
  try {
    await fs.writeFile(join(outside, "secret.txt"), "outside");
    await fs.symlink(outside, join(root, "escape"));
    const executor = new ComputerExecutor(root);
    await assert.rejects(() => executor.readFile("../secret.txt"), (error: unknown) => hasCode(error, "FORBIDDEN"));
    await assert.rejects(() => executor.readFile("escape/secret.txt"), (error: unknown) => hasCode(error, "FORBIDDEN"));
    await assert.rejects(() => executor.writeFile("escape/new.txt", "bad", false), (error: unknown) => hasCode(error, "FORBIDDEN"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("computer_read_file reports a missing path as actionable NOT_FOUND", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-missing-path-"));
  try {
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.readFile("missing.json"),
      (error: unknown) => hasCode(error, "NOT_FOUND")
        && error instanceof Error
        && error.message === "Path not found: missing.json",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file resolves a missing bare filename from a nested evidence file", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-basename-"));
  try {
    await fs.mkdir(join(root, "evidence"), { recursive: true });
    await fs.writeFile(join(root, "evidence", "content_distribution.json"), "{\"total\":61}");
    const executor = new ComputerExecutor(root);
    const result = await executor.readFile("content_distribution.json");
    assert.equal(result.content, "{\"total\":61}");
    assert.equal(result.requestedPath, "content_distribution.json");
    assert.equal(result.resolvedPath, "evidence/content_distribution.json");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file prefers ranked evidence paths over lower-priority duplicate basenames", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-basename-priority-"));
  try {
    await fs.mkdir(join(root, "archive"), { recursive: true });
    await fs.mkdir(join(root, "evidence"), { recursive: true });
    await fs.writeFile(join(root, "archive", "progress_stats.json"), "{\"source\":\"archive\"}");
    await fs.writeFile(join(root, "evidence", "progress_stats.json"), "{\"source\":\"evidence\"}");
    const executor = new ComputerExecutor(root);
    const result = await executor.readFile("progress_stats.json");
    assert.equal(result.content, "{\"source\":\"evidence\"}");
    assert.equal(result.resolvedPath, "evidence/progress_stats.json");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file reports same-priority duplicate basenames as an explicit conflict", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-basename-conflict-"));
  try {
    await fs.mkdir(join(root, "alpha"), { recursive: true });
    await fs.mkdir(join(root, "beta"), { recursive: true });
    await fs.writeFile(join(root, "alpha", "summary.json"), "{\"source\":\"alpha\"}\n");
    await fs.writeFile(join(root, "beta", "summary.json"), "{\"source\":\"beta\"}\n");
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.readFile("summary.json"),
      (error: unknown) => hasCode(error, "CONFLICT")
        && error instanceof Error
        && /Multiple files named summary\.json/.test(error.message)
        && Array.isArray((error as { details?: { candidates?: unknown } }).details?.candidates),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer discovery tools normalize empty root paths to workspace root", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-computer-root-path-"));
  try {
    await fs.writeFile(join(root, "note.txt"), "hello root\n");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_list_directory", "computer_search_text"]));
    const listEmpty = allowed.prepare({
      id: "list-empty",
      name: "computer_list_directory",
      arguments: { path: "" },
    });
    const listSlash = allowed.prepare({
      id: "list-slash",
      name: "computer_list_directory",
      arguments: { path: "/" },
    });
    const searchEmpty = allowed.prepare({
      id: "search-empty",
      name: "computer_search_text",
      arguments: { path: "", query: "hello" },
    });

    const emptyResult = await listEmpty.tool.execute({ grant: grant(["computer_list_directory"]) }, listEmpty.input) as Array<{ name: string }>;
    const slashResult = await listSlash.tool.execute({ grant: grant(["computer_list_directory"]) }, listSlash.input) as Array<{ name: string }>;
    const searchResult = await searchEmpty.tool.execute({ grant: grant(["computer_search_text"]) }, searchEmpty.input) as Array<{ path: string; text: string }>;

    assert.deepEqual(emptyResult.map((entry) => entry.name), ["note.txt"]);
    assert.deepEqual(slashResult.map((entry) => entry.name), ["note.txt"]);
    assert.deepEqual(searchResult, [{ path: "note.txt", line: 1, text: "hello root" }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dangerous computer tools remain unavailable until the Run grant explicitly includes them", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-grant-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const denied = registry.materialize(grant([]));
    assert.equal(denied.definitions.some((tool) => tool.name === "computer_write_file"), false);
    assert.equal(denied.definitions.some((tool) => tool.name === "materialize_paginated_html"), false);
    assert.throws(
      () => denied.prepare({ id: "write-1", name: "computer_write_file", arguments: { path: "x", content: "x" } }),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
    assert.throws(
      () => denied.prepare({
        id: "materialize-1",
        name: "materialize_paginated_html",
        arguments: {
          path: "deck.html",
          title: "Deck",
          renderMode: "slides",
          acceptanceProfile: "html_ppt",
          pages: [{ title: "Intro" }],
        },
      }),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
    const allowed = registry.materialize(grant(["computer_write_file"]));
    const prepared = allowed.prepare({
      id: "write-2", name: "computer_write_file", arguments: { path: "created.txt", content: "kept\n" },
    });
    await prepared.tool.execute({ grant: grant(["computer_write_file"]) }, prepared.input);
    assert.equal(await fs.readFile(join(root, "created.txt"), "utf8"), "kept\n");

    const nested = allowed.prepare({
      id: "write-3", name: "computer_write_file", arguments: { path: "deliveries/issue-42/proof.txt", content: "nested\n" },
    });
    await nested.tool.execute({ grant: grant(["computer_write_file"]) }, nested.input);
    assert.equal(await fs.readFile(join(root, "deliveries/issue-42/proof.txt"), "utf8"), "nested\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("materialize_paginated_html writes structured paginated HTML and exposes acceptance-ready evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-html-ppt-materialize-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["materialize_paginated_html", "verify_artifact_acceptance"]));
    const definition = allowed.definitions.find((tool) => tool.name === "materialize_paginated_html");
    assert.match(definition?.description ?? "", /structured page specification/);
    assert.match(definition?.description ?? "", /verify_artifact_acceptance/);

    const pageSpec = {
      path: "deliverables/dcmm-training.html",
      title: "DCMM 4 评级培训",
      subtitle: "能力建设案例",
      renderMode: "slides",
      acceptanceProfile: "html_ppt",
      theme: { accent: "#0f766e", background: "#edf2ef", text: "#10201c", surface: "#fffdf8" },
      pages: [
        {
          eyebrow: "Case",
          title: "从目标到证据",
          subtitle: "围绕任务拆解、执行和验收形成闭环。",
          bullets: ["明确评级目标", "沉淀过程证据", "统一交付验收"],
          sourceRefs: ["DCMM training brief"],
        },
        {
          title: "执行节奏",
          body: "用结构化规格驱动 HTML-PPT 物化，减少大段 HTML 在模型和工具之间往返。",
          callout: "最终仍以 artifact_acceptance 作为交付证据。",
        },
      ],
    };
    const materialize = allowed.prepare({
      id: "materialize-deck",
      name: "materialize_paginated_html",
      arguments: pageSpec,
    });

    const result = await materialize.tool.execute(grantContext(["materialize_paginated_html", "verify_artifact_acceptance"]), materialize.input) as {
      schema: string;
      artifactKind: string;
      renderMode: string;
      acceptanceProfile: string;
      path: string;
      bytes: number;
      sha256: string;
      pageCount: number;
      specSha256: string;
      inspection: {
        sha256: string;
        outline: Array<{ line: number; text: string }>;
        sampleRanges: Array<{ startLine: number; endLine: number; content: string; truncated: boolean }>;
      };
      artifactReceipt: {
        schema: string;
        sourceTool: string;
        artifact: { path: string; artifactKind: string; acceptanceProfile: string; pageCount: number; sha256: string };
        inspection: { sampleRangeCount: number };
        canonicalEvidence: { fullInspectionInToolResult: boolean };
      };
    };

    assert.equal(result.schema, "agentloop.paginatedHtmlMaterialization/v1");
    assert.equal(result.artifactKind, "html");
    assert.equal(result.renderMode, "slides");
    assert.equal(result.acceptanceProfile, "html_ppt");
    assert.equal(result.path, "deliverables/dcmm-training.html");
    assert.equal(result.pageCount, 2);
    assert.equal(result.sha256, result.inspection.sha256);
    assert.match(result.specSha256, /^[0-9a-f]{64}$/);
    assert.ok(result.bytes > JSON.stringify(pageSpec).length);
    assert.equal(result.artifactReceipt.schema, "agentloop.artifactReceipt/v1");
    assert.equal(result.artifactReceipt.sourceTool, "materialize_paginated_html");
    assert.equal(result.artifactReceipt.artifact.path, "deliverables/dcmm-training.html");
    assert.equal(result.artifactReceipt.artifact.artifactKind, "html");
    assert.equal(result.artifactReceipt.artifact.acceptanceProfile, "html_ppt");
    assert.equal(result.artifactReceipt.artifact.pageCount, 2);
    assert.equal(result.artifactReceipt.artifact.sha256, result.sha256);
    assert.equal(result.artifactReceipt.inspection.sampleRangeCount, result.inspection.sampleRanges.length);
    assert.equal(result.artifactReceipt.canonicalEvidence.fullInspectionInToolResult, true);

    const html = await fs.readFile(join(root, "deliverables", "dcmm-training.html"), "utf8");
    assert.match(html, /<section class="slide" data-slide="1"/);
    assert.match(html, /DCMM 4 评级培训/);
    assert.match(html, /function nextSlide/);

    const accept = allowed.prepare({
      id: "accept-materialized-deck",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "deliverables/dcmm-training.html", profileId: "html_ppt" },
    });
    const acceptance = await accept.tool.execute(grantContext(["materialize_paginated_html", "verify_artifact_acceptance"]), accept.input) as {
      verdict: string;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown>; diagnostics?: string }>;
    };

    assert.equal(acceptance.verdict, "caveated");
    assert.deepEqual(acceptance.evidenceKinds.failed, []);
    assert.ok(acceptance.evidenceKinds.satisfied.includes("artifact_acceptance"));
    assert.ok(acceptance.evidenceKinds.satisfied.includes("format_matches_request"));
    assert.equal(check(acceptance, "slide_structure")?.status, "passed");
    assert.deepEqual(check(acceptance, "slide_structure")?.evidence.slideCount, 2);
    assert.equal(check(acceptance, "static_navigation_signals")?.status, "passed");

    const htmlAccept = allowed.prepare({
      id: "accept-materialized-html",
      name: "verify_artifact_acceptance",
      arguments: {
        artifactPath: "deliverables/dcmm-training.html",
        profileId: "html",
        checks: ["browser-openable paginated HTML with page navigation (pageCount=2)"],
      },
    });
    const htmlAcceptance = await htmlAccept.tool.execute(grantContext(["materialize_paginated_html", "verify_artifact_acceptance"]), htmlAccept.input) as {
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown>; diagnostics?: string }>;
    };

    assert.deepEqual(htmlAcceptance.evidenceKinds.failed, []);
    assert.ok(htmlAcceptance.evidenceKinds.satisfied.includes("basic_navigation"));
    assert.equal(check(htmlAcceptance, "basic_navigation")?.status, "passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("materialize_paginated_html rejects invalid page specs before writing files", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-html-ppt-invalid-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["materialize_paginated_html"]));
    assert.throws(
      () => allowed.prepare({
        id: "invalid-theme",
        name: "materialize_paginated_html",
        arguments: {
          path: "deck.html",
          title: "Deck",
          renderMode: "slides",
          acceptanceProfile: "html_ppt",
          theme: { accent: "teal" },
          pages: [{ title: "Intro" }],
        },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
    assert.throws(
      () => allowed.prepare({
        id: "too-many-pages",
        name: "materialize_paginated_html",
        arguments: {
          path: "deck.html",
          title: "Deck",
          renderMode: "slides",
          acceptanceProfile: "html_ppt",
          pages: Array.from({ length: 81 }, (_, index) => ({ title: `Page ${index + 1}` })),
        },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
    await assert.rejects(() => fs.stat(join(root, "deck.html")), (error: unknown) =>
      error instanceof Error && "code" in error && (error as { code: unknown }).code === "ENOENT"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance records aggregate HTML-PPT evidence and renderer caveats", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-html-"));
  try {
    const html = [
      "<!doctype html>",
      "<html><head><title>Deck</title></head><body>",
      "<main>",
      "<section class=\"slide active\"><h1>Intro</h1></section>",
      "<section class=\"slide\"><h1>Details</h1></section>",
      "</main>",
      "<button aria-label=\"Previous slide\">Prev</button>",
      "<button aria-label=\"Next slide\" data-action=\"next\">Next</button>",
      "<script>",
      "let currentSlide = 0;",
      "function nextSlide(){ currentSlide += 1; }",
      "window.addEventListener('keydown', event => { if (event.key === 'ArrowRight') nextSlide(); });",
      "</script>",
      "</body></html>",
    ].join("\n");
    await fs.mkdir(join(root, "deliverables"), { recursive: true });
    await fs.writeFile(join(root, "deliverables", "deck.html"), html);
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const definition = allowed.definitions.find((tool) => tool.name === "verify_artifact_acceptance");
    assert.match(definition?.description ?? "", /aggregate artifact acceptance evidence/);
    assert.match(definition?.description ?? "", /skipped_unavailable/);
    const prepared = allowed.prepare({
      id: "accept-html-ppt",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "deliverables/deck.html", profileId: "html_ppt" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      schema: string;
      verdict: string;
      artifact: { path: string; bytes: number; sha256: string; kind: string; profileId: string };
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown>; diagnostics?: string }>;
      caveats: string[];
    };

    assert.equal(result.schema, "agentloop.artifactAcceptance/v1");
    assert.equal(result.verdict, "caveated");
    assert.equal(result.artifact.path, "deliverables/deck.html");
    assert.equal(result.artifact.kind, "html_ppt");
    assert.equal(result.artifact.profileId, "html_ppt");
    assert.equal(result.artifact.bytes, Buffer.byteLength(html));
    assert.equal(result.artifact.sha256, createHash("sha256").update(html).digest("hex"));
    assert.deepEqual(result.evidenceKinds.failed, []);
    assert.ok(result.evidenceKinds.satisfied.includes("artifact_acceptance"));
    assert.ok(result.evidenceKinds.satisfied.includes("artifact_openable"));
    assert.ok(result.evidenceKinds.satisfied.includes("format_matches_request"));
    assert.ok(result.evidenceKinds.caveated.includes("basic_navigation"));
    assert.ok(result.evidenceKinds.caveated.includes("explicit_caveats"));
    assert.equal(check(result, "slide_structure")?.status, "passed");
    assert.deepEqual(check(result, "slide_structure")?.evidence.slideCount, 2);
    assert.equal(check(result, "static_navigation_signals")?.status, "passed");
    assert.equal(check(result, "basic_navigation")?.status, "skipped_unavailable");
    assert.match(result.caveats.join("\n"), /Browser-rendered navigation was not executed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance accepts bounded human-readable check descriptions", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-checks-"));
  try {
    const html = [
      "<!doctype html>",
      "<html><head><title>Portal</title></head><body>",
      "<main><form><input aria-label=\"Email\"><button>Sign in</button></form></main>",
      "</body></html>",
    ].join("\n");
    await fs.writeFile(join(root, "portal.html"), html);
    const longCheck = [
      "single-page login portal renders the concrete product identity in the first viewport,",
      "keeps the sign-in form visible without overlapping controls, and preserves enough",
      "semantic markup for deterministic local acceptance before any browser provider runs",
    ].join(" ");
    assert.ok(longCheck.length > 128);

    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-html-with-check-descriptions",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "portal.html", profileId: "html", checks: [longCheck] },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      requestedChecks?: string[];
    };

    assert.notEqual(result.verdict, "rejected");
    assert.deepEqual(result.requestedChecks, [longCheck]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance does not mistake next-week content for a navigation requirement", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-next-week-"));
  try {
    await fs.writeFile(join(root, "weekly-report.html"), [
      "<!doctype html>",
      "<html><head><title>Weekly report</title></head><body>",
      "<main><h1>Weekly report</h1><section><h2>Next-week plan</h2></section></main>",
      "</body></html>",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-weekly-report",
      name: "verify_artifact_acceptance",
      arguments: {
        artifactPath: "weekly-report.html",
        profileId: "html",
        checks: ["Contains weekly report sections including the next-week plan"],
      },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string }>;
    };

    assert.equal(result.verdict, "caveated");
    assert.ok(result.evidenceKinds.satisfied.includes("artifact_acceptance"));
    assert.equal(result.evidenceKinds.failed.includes("artifact_acceptance"), false);
    assert.equal(check(result, "basic_navigation"), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance accepts ordinary in-page anchor navigation for HTML", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-anchor-nav-"));
  try {
    await fs.writeFile(join(root, "portal.html"), [
      "<!doctype html>",
      "<html><head><title>Portal</title></head><body>",
      "<nav><a href=\"#about\">About</a><a href=\"#products\">Products</a><a href=\"#careers\">Careers</a></nav>",
      "<main><section id=\"about\"><h1>About</h1></section><section id=\"products\"><h2>Products</h2></section><section id=\"careers\"><h2>Careers</h2></section></main>",
      "<footer><a href=\"#\">News</a></footer>",
      "</body></html>",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-portal-anchor-nav",
      name: "verify_artifact_acceptance",
      arguments: {
        artifactPath: "portal.html",
        profileId: "html",
        checks: ["页面含基本导航"],
      },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.notEqual(result.verdict, "rejected");
    assert.ok(result.evidenceKinds.satisfied.includes("basic_navigation"));
    assert.equal(result.evidenceKinds.failed.includes("basic_navigation"), false);
    assert.equal(check(result, "basic_navigation")?.status, "passed");
    assert.deepEqual(check(result, "basic_navigation")?.evidence.signals, ["anchor_navigation"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance verifies self-contained HTML when requested", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-self-contained-"));
  try {
    await fs.writeFile(join(root, "portal.html"), [
      "<!doctype html>",
      "<html><head><title>Portal</title><style>body{font-family:sans-serif}</style></head><body>",
      "<nav><a href=\"#products\">Products</a><a href=\"#careers\">Careers</a></nav>",
      "<main><section id=\"products\">Products</section><section id=\"careers\">Careers</section></main>",
      "<script>document.documentElement.dataset.ready='true';</script>",
      "</body></html>",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-self-contained-html",
      name: "verify_artifact_acceptance",
      arguments: {
        artifactPath: "portal.html",
        profileId: "html",
        checks: ["所有CSS和JS均内联无外部CDN依赖"],
      },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.notEqual(result.verdict, "rejected");
    assert.deepEqual(result.evidenceKinds.failed, []);
    assert.equal(check(result, "self_contained_resources")?.status, "passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance rejects external HTML resources when self-contained output is requested", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-external-resource-"));
  try {
    await fs.writeFile(join(root, "portal.html"), [
      "<!doctype html>",
      "<html><head><title>Portal</title><script src=\"https://cdn.example/app.js\"></script></head><body>",
      "<main><h1>Portal</h1></main>",
      "</body></html>",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "reject-external-html",
      name: "verify_artifact_acceptance",
      arguments: {
        artifactPath: "portal.html",
        profileId: "html",
        checks: ["No external CDN dependencies"],
      },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.equal(result.verdict, "rejected");
    assert.ok(result.evidenceKinds.failed.includes("artifact_acceptance"));
    assert.equal(check(result, "self_contained_resources")?.status, "failed");
    assert.deepEqual(check(result, "self_contained_resources")?.evidence.externalResources, ["external_script_src"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance merges injected provider checks into the aggregate evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-provider-"));
  try {
    const html = [
      "<!doctype html>",
      "<html><body>",
      "<section class=\"slide active\"><h1>One</h1></section>",
      "<section class=\"slide\"><h1>Two</h1></section>",
      "<button id=\"prev\" aria-label=\"Previous slide\">Prev</button>",
      "<button id=\"next\" aria-label=\"Next slide\">Next</button>",
      "<script>document.addEventListener('keydown', event => history.replaceState(null,'','#2'));</script>",
      "</body></html>",
    ].join("\n");
    await fs.writeFile(join(root, "deck.html"), html);
    const seenProfiles: string[] = [];
    const provider: ArtifactAcceptanceProvider = {
      id: "test-browser-provider",
      supports: (query) => {
        seenProfiles.push(query.profileId);
        return query.profileId === "html_ppt";
      },
      verify: async (request) => ({
        providerId: "test-browser-provider",
        diagnostics: [`verified ${request.artifact.path}`],
        checks: [
          {
            id: "basic_navigation",
            status: "passed",
            evidence: {
              mode: "provider_browser_interaction",
              key: "ArrowRight",
              beforeHash: "#1",
              afterHash: "#2",
            },
          },
          {
            id: "rendered_interaction",
            status: "passed",
            evidence: {
              viewport: { width: 1280, height: 720 },
              screenshotPath: ".acceptance/deck.png",
            },
          },
        ],
      }),
    };
    const service = new ArtifactAcceptanceService({ providers: [provider] });
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root), undefined, service));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-html-ppt-provider",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "deck.html", profileId: "html_ppt" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown>; diagnostics?: string }>;
      caveats: string[];
    };

    assert.deepEqual(seenProfiles, ["html_ppt"]);
    assert.equal(result.verdict, "accepted");
    assert.deepEqual(result.caveats, []);
    assert.ok(result.evidenceKinds.satisfied.includes("artifact_acceptance"));
    assert.ok(result.evidenceKinds.satisfied.includes("basic_navigation"));
    assert.equal(result.evidenceKinds.caveated.includes("basic_navigation"), false);
    assert.equal(check(result, "basic_navigation")?.status, "passed");
    assert.equal(check(result, "basic_navigation")?.evidence.providerId, "test-browser-provider");
    assert.equal(check(result, "rendered_interaction")?.status, "passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance accepts Playwright provider evidence when injected", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-playwright-"));
  try {
    await fs.writeFile(join(root, "deck.html"), [
      "<!doctype html>",
      "<html><body>",
      "<section class=\"slide active\"><h1>One</h1></section>",
      "<section class=\"slide\"><h1>Two</h1></section>",
      "<button aria-label=\"Next slide\">Next</button>",
      "<script>document.addEventListener('keydown', () => location.hash = '#2');</script>",
      "</body></html>",
    ].join("\n"));
    const screenshot = Buffer.from("fake-png");
    let navigated = false;
    const provider = createPlaywrightArtifactAcceptanceProvider({
      moduleLoader: (async () => ({
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              goto: async () => undefined,
              waitForLoadState: async () => undefined,
              waitForTimeout: async () => undefined,
              screenshot: async (options: { path: string }) => {
                await fs.writeFile(options.path, screenshot);
                return screenshot;
              },
              evaluate: async () => renderedState(navigated),
              keyboard: {
                press: async () => {
                  navigated = true;
                },
              },
            }),
            close: async () => undefined,
          }),
        },
      })) as unknown as NonNullable<Parameters<typeof createPlaywrightArtifactAcceptanceProvider>[0]>["moduleLoader"],
    });
    const service = new ArtifactAcceptanceService({ providers: [provider] });
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root), undefined, service));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-html-ppt-playwright",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "deck.html", profileId: "html_ppt" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
      caveats: string[];
    };

    assert.equal(result.verdict, "accepted");
    assert.deepEqual(result.caveats, []);
    assert.ok(result.evidenceKinds.satisfied.includes("basic_navigation"));
    assert.equal(check(result, "basic_navigation")?.status, "passed");
    assert.equal(check(result, "basic_navigation")?.evidence.mode, "playwright_chromium");
    assert.equal(check(result, "rendered_interaction")?.status, "passed");
    assert.match(String(check(result, "rendered_interaction")?.evidence.screenshotPath), /^\.agentloop\/acceptance-artifacts\/html_ppt-/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance keeps Playwright runtime absence as an explicit caveat", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-playwright-missing-"));
  try {
    await fs.writeFile(join(root, "deck.html"), [
      "<!doctype html>",
      "<html><body>",
      "<section class=\"slide\"><h1>One</h1></section>",
      "<button aria-label=\"Next slide\">Next</button>",
      "</body></html>",
    ].join("\n"));
    const provider = createPlaywrightArtifactAcceptanceProvider({
      moduleLoader: async () => {
        throw new Error("playwright module is not installed");
      },
    });
    const service = new ArtifactAcceptanceService({ providers: [provider] });
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root), undefined, service));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-html-ppt-playwright-missing",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "deck.html", profileId: "html_ppt" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown>; diagnostics?: string }>;
      caveats: string[];
    };

    assert.equal(result.verdict, "caveated");
    assert.equal(check(result, "basic_navigation")?.status, "skipped_unavailable");
    assert.equal(check(result, "rendered_interaction")?.status, "skipped_unavailable");
    assert.match(result.caveats.join("\n"), /playwright module is not installed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance decodes image dimensions through the local image profile", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-image-"));
  try {
    await fs.writeFile(join(root, "pixel.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAADZSiLoAAAAD0lEQVR42mP8z8AARLJAgAEAGf0EA/hL4dIAAAAASUVORK5CYII=",
      "base64",
    ));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-image",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "pixel.png", artifactKind: "image" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.equal(result.verdict, "accepted");
    assert.equal(result.evidenceKinds.caveated.includes("explicit_caveats"), false);
    assert.equal(check(result, "artifact_openable")?.status, "passed");
    assert.equal(check(result, "artifact_openable")?.evidence.mode, "image_decoder");
    assert.equal(check(result, "rendered_open")?.status, "passed");
    assert.equal(check(result, "rendered_open")?.evidence.width, 2);
    assert.equal(check(result, "rendered_open")?.evidence.height, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance validates OpenXML package structure through the same tool", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-xlsx-"));
  try {
    const workbook = storedZip([
      ["[Content_Types].xml", "<Types></Types>"],
      ["xl/workbook.xml", "<workbook></workbook>"],
      ["xl/worksheets/sheet1.xml", "<worksheet></worksheet>"],
    ]);
    await fs.writeFile(join(root, "workbook.xlsx"), workbook);
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-xlsx",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "workbook.xlsx", artifactKind: "xlsx" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      artifact: { kind: string; profileId: string; bytes: number; sha256: string };
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.equal(result.verdict, "caveated");
    assert.equal(result.artifact.kind, "xlsx");
    assert.equal(result.artifact.profileId, "xlsx");
    assert.equal(result.artifact.bytes, workbook.length);
    assert.equal(result.artifact.sha256, createHash("sha256").update(workbook).digest("hex"));
    assert.ok(result.evidenceKinds.satisfied.includes("artifact_acceptance"));
    assert.ok(result.evidenceKinds.satisfied.includes("artifact_openable"));
    assert.ok(result.evidenceKinds.caveated.includes("explicit_caveats"));
    assert.equal(check(result, "format_matches_request")?.status, "passed");
    assert.deepEqual(check(result, "artifact_openable")?.evidence.worksheetCount, 1);
    assert.equal(check(result, "rendered_open")?.status, "skipped_unavailable");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance records PPTX slide sequence as basic navigation evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-pptx-navigation-"));
  try {
    const deck = storedZip([
      ["[Content_Types].xml", "<Types></Types>"],
      ["ppt/presentation.xml", "<p:presentation><p:sldIdLst><p:sldId id=\"256\"/><p:sldId id=\"257\"/></p:sldIdLst></p:presentation>"],
      ["ppt/slides/slide1.xml", "<p:sld></p:sld>"],
      ["ppt/slides/slide2.xml", "<p:sld></p:sld>"],
    ]);
    await fs.writeFile(join(root, "deck.pptx"), deck);
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-pptx",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "deck.pptx", artifactKind: "pptx" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.equal(result.verdict, "caveated");
    assert.ok(result.evidenceKinds.satisfied.includes("basic_navigation"));
    assert.equal(result.evidenceKinds.caveated.includes("basic_navigation"), false);
    assert.equal(check(result, "basic_navigation")?.status, "passed");
    assert.equal(check(result, "basic_navigation")?.evidence.mode, "openxml_slide_sequence");
    assert.equal(check(result, "basic_navigation")?.evidence.slideCount, 2);
    assert.equal(check(result, "rendered_open")?.status, "skipped_unavailable");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance rejects PDF text-layer markup leaks", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-pdf-markup-"));
  try {
    await fs.writeFile(join(root, "bad-formula.pdf"), [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog >> endobj",
      "2 0 obj << /Length 54 >> stream",
      "BT /F1 12 Tf 72 720 Td (<super>v</super>=<super>s</super>/t) Tj ET",
      "endstream endobj",
      "%%EOF",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-bad-pdf",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "bad-formula.pdf", profileId: "pdf" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { failed: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.equal(result.verdict, "rejected");
    assert.ok(result.evidenceKinds.failed.includes("artifact_acceptance"));
    assert.equal(check(result, "pdf_static_text_sanity")?.status, "failed");
    assert.deepEqual(check(result, "pdf_static_text_sanity")?.evidence.rawMarkupLeak, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance keeps structurally valid PDF evidence caveated without text leaks", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-pdf-ok-"));
  try {
    await fs.writeFile(join(root, "plain.pdf"), [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog >> endobj",
      "%%EOF",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-plain-pdf",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "plain.pdf", profileId: "pdf" },
    });

    const result = await prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input) as {
      verdict: string;
      evidenceKinds: { failed: string[]; caveated: string[] };
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };

    assert.equal(result.verdict, "caveated");
    assert.deepEqual(result.evidenceKinds.failed, []);
    assert.ok(result.evidenceKinds.caveated.includes("explicit_caveats"));
    assert.equal(check(result, "pdf_static_text_sanity")?.status, "passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_artifact_acceptance preserves workspace escape rejection", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-root-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-acceptance-outside-"));
  try {
    await fs.writeFile(join(outside, "secret.html"), "<!doctype html><html></html>");
    await fs.symlink(outside, join(root, "escape"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["verify_artifact_acceptance"]));
    const prepared = allowed.prepare({
      id: "accept-escape",
      name: "verify_artifact_acceptance",
      arguments: { artifactPath: "escape/secret.html", artifactKind: "html" },
    });

    await assert.rejects(
      () => prepared.tool.execute(grantContext(["verify_artifact_acceptance"]), prepared.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("computer command execution uses an enforced timeout instead of an unbounded child process", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-timeout-"));
  try {
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.runCommand({
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: ".",
        timeoutMs: 100,
      }),
      (error: unknown) => hasCode(error, "TOOL_EXECUTION_ERROR"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_write_file reports an existing target as an actionable conflict", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-write-conflict-"));
  try {
    const executor = new ComputerExecutor(root);
    await fs.writeFile(join(root, "measure.py"), "original\n");
    await assert.rejects(
      () => executor.writeFile("measure.py", "replacement\n", false),
      (error: unknown) => hasCode(error, "CONFLICT")
        && error instanceof Error
        && error.message === "File already exists; set mode=\"overwrite\" or overwrite=true to replace it",
    );
    assert.equal(await fs.readFile(join(root, "measure.py"), "utf8"), "original\n");
    await executor.writeFile("measure.py", "replacement\n", "overwrite");
    assert.equal(await fs.readFile(join(root, "measure.py"), "utf8"), "replacement\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_write_file appends chunks and receipts the final file state", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-write-append-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_write_file"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_write_file");
    assert.match(definition?.description ?? "", /mode to create, overwrite, or append/);
    assert.match(definition?.description ?? "", /Append requires an existing file/);
    assert.match(definition?.description ?? "", /final file sha256/);

    const first = allowed.prepare({
      id: "write-first",
      name: "computer_write_file",
      arguments: { path: "reports/large.md", content: "# Report\npart one\n", mode: "create" },
    });
    await first.tool.execute(grantContext(["computer_write_file"]), first.input);

    const second = allowed.prepare({
      id: "write-second",
      name: "computer_write_file",
      arguments: { path: "reports/large.md", content: "## Tail\npart two\n", mode: "append" },
    });
    const result = await second.tool.execute(grantContext(["computer_write_file"]), second.input) as {
      path: string;
      mode: string;
      writtenBytes: number;
      bytes: number;
      sha256: string;
      totalLines: number;
      artifactReceipt: {
        artifact: { path: string; bytes: number; sha256: string; totalLines: number };
        operation?: { mode?: string; writtenBytes?: number };
      };
    };

    const finalContent = "# Report\npart one\n## Tail\npart two\n";
    assert.equal(await fs.readFile(join(root, "reports", "large.md"), "utf8"), finalContent);
    assert.equal(result.path, "reports/large.md");
    assert.equal(result.mode, "append");
    assert.equal(result.writtenBytes, Buffer.byteLength("## Tail\npart two\n"));
    assert.equal(result.bytes, Buffer.byteLength(finalContent));
    assert.equal(result.sha256, createHash("sha256").update(finalContent).digest("hex"));
    assert.equal(result.totalLines, 4);
    assert.equal(result.artifactReceipt.artifact.path, "reports/large.md");
    assert.equal(result.artifactReceipt.artifact.bytes, result.bytes);
    assert.equal(result.artifactReceipt.artifact.sha256, result.sha256);
    assert.equal(result.artifactReceipt.artifact.totalLines, result.totalLines);
    assert.deepEqual(result.artifactReceipt.operation, {
      mode: "append",
      writtenBytes: Buffer.byteLength("## Tail\npart two\n"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_write_file append fails closed when the target is missing", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-write-append-missing-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_write_file"]));
    const prepared = allowed.prepare({
      id: "append-missing",
      name: "computer_write_file",
      arguments: { path: "reports/missing.md", content: "tail\n", mode: "append" },
    });
    await assert.rejects(
      () => prepared.tool.execute(grantContext(["computer_write_file"]), prepared.input),
      (error: unknown) => hasCode(error, "NOT_FOUND")
        && error instanceof Error
        && /mode="create"/.test(error.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_write_file rejects ambiguous mode and legacy overwrite arguments", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-write-mode-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_write_file"]));
    assert.throws(
      () => allowed.prepare({
        id: "ambiguous-write",
        name: "computer_write_file",
        arguments: { path: "x.txt", content: "x", mode: "append", overwrite: true },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST")
        && error instanceof Error
        && /mode and overwrite cannot both be set/.test(error.message),
    );
    assert.throws(
      () => allowed.prepare({
        id: "invalid-write",
        name: "computer_write_file",
        arguments: { path: "x.txt", content: "x", mode: "replace" },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST")
        && error instanceof Error
        && /mode must be one of create, overwrite, or append/.test(error.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server-owned executable aliases expose a safe name instead of an arbitrary binary path", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-alias-"));
  try {
    const executor = new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
      commandEnvironment: { DEMO_FLAG: "server-owned" },
    });
    const result = await executor.runCommand({
      command: "trusted-node",
      args: ["-e", "process.stdout.write('alias-ok:' + process.env.DEMO_FLAG)"],
      cwd: ".",
      timeoutMs: 2_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "alias-ok:server-owned");
    assert.throws(
      () => new ComputerExecutor(root, { executableAliases: { node: "relative/node" } }),
      /absolute path/,
    );
    assert.throws(
      () => new ComputerExecutor(root, { commandEnvironment: { API_KEY: "must-not-leak" } }),
      /must not contain sensitive variable/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer command arguments preserve long workspace paths while rejecting outside absolute paths", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-long-command-argument-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const longWorkspaceDirectory = join(root, "nested-directory/".repeat(20));
    await fs.mkdir(longWorkspaceDirectory, { recursive: true });
    const longWorkspacePath = join(longWorkspaceDirectory, "render_slides.py");
    await fs.writeFile(longWorkspacePath, "");
    assert.ok(longWorkspacePath.length > 128);
    const prepared = allowed.prepare({
      id: "long-argument",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write(process.argv.slice(1).join('\\n'))", longWorkspacePath, longWorkspacePath],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${longWorkspacePath}\n${longWorkspacePath}`);

    await fs.mkdir(join(root, "nested-cwd"), { recursive: true });
    await fs.writeFile(join(root, "input.txt"), "workspace-relative-ok");
    const relativeWithinWorkspace = allowed.prepare({
      id: "relative-within-workspace",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", "../input.txt"],
        cwd: "nested-cwd",
        timeoutMs: 2_000,
      },
    });
    const relativeResult = await relativeWithinWorkspace.tool.execute(
      grantContext(["computer_run_command"]),
      relativeWithinWorkspace.input,
    ) as { exitCode: number | null; stdout: string };
    assert.equal(relativeResult.exitCode, 0);
    assert.equal(relativeResult.stdout, "workspace-relative-ok");

    const outsideRelative = allowed.prepare({
      id: "outside-relative-argument",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write('must not run')", "../secret.txt"],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => outsideRelative.tool.execute(grantContext(["computer_run_command"]), outsideRelative.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    const outsidePath = `/${"nested-directory/".repeat(20)}render_slides.py`;
    const outside = allowed.prepare({
      id: "outside-absolute-argument",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write('must not run')", outsidePath],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => outside.tool.execute(grantContext(["computer_run_command"]), outside.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
    const embeddedOutside = allowed.prepare({
      id: "embedded-outside-absolute-argument",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", `require('fs').readFileSync('${outsidePath}', 'utf8')`],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => embeddedOutside.tool.execute(grantContext(["computer_run_command"]), embeddedOutside.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    assert.throws(
      () => allowed.prepare({
        id: "oversized-argument",
        name: "computer_run_command",
        arguments: { command: "trusted-node", args: ["x".repeat(4_097)] },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
    assert.throws(
      () => allowed.prepare({
        id: "oversized-total",
        name: "computer_run_command",
        arguments: { command: "trusted-node", args: Array.from({ length: 17 }, () => "x".repeat(4_000)) },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_write_file returns bounded write-after-inspection evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-write-inspection-"));
  try {
    const content = [
      "# Report",
      "opening evidence",
      ...Array.from({ length: 90 }, (_, index) => `body line ${index + 1}`),
      "## Source list",
      "- source A",
      "## Final checks",
      "- tail evidence",
    ].join("\n");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_write_file"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_write_file");
    assert.match(definition?.description ?? "", /write-after-inspection evidence/);
    const prepared = allowed.prepare({
      id: "write-report",
      name: "computer_write_file",
      arguments: { path: "reports/summary.md", content },
    });
    await fs.mkdir(join(root, "reports"), { recursive: true });

    const result = await prepared.tool.execute(grantContext(["computer_write_file"]), prepared.input) as {
      path: string;
      bytes: number;
      sha256: string;
      totalLines: number;
      inspection: {
        sha256: string;
        characters: number;
        totalLines: number;
        outline: Array<{ line: number; text: string }>;
        sampleRanges: Array<{ startLine: number; endLine: number; content: string; truncated: boolean }>;
      };
      artifactReceipt: {
        schema: string;
        sourceTool: string;
        artifact: { path: string; sha256: string; bytes: number; totalLines: number };
        inspection: { sampleRangeCount: number };
        canonicalEvidence: { fullInspectionInToolResult: boolean };
      };
    };

    assert.equal(result.path, "reports/summary.md");
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(result.inspection.sha256, result.sha256);
    assert.equal(result.totalLines, 96);
    assert.deepEqual(result.inspection.outline, [
      { line: 1, text: "# Report" },
      { line: 93, text: "## Source list" },
      { line: 95, text: "## Final checks" },
    ]);
    assert.equal(result.inspection.sampleRanges.length, 2);
    assert.match(result.inspection.sampleRanges[0].content, /opening evidence/);
    assert.match(result.inspection.sampleRanges[1].content, /tail evidence/);
    assert.equal(result.artifactReceipt.schema, "agentloop.artifactReceipt/v1");
    assert.equal(result.artifactReceipt.sourceTool, "computer_write_file");
    assert.equal(result.artifactReceipt.artifact.path, "reports/summary.md");
    assert.equal(result.artifactReceipt.artifact.sha256, result.sha256);
    assert.equal(result.artifactReceipt.artifact.bytes, result.bytes);
    assert.equal(result.artifactReceipt.artifact.totalLines, result.totalLines);
    assert.equal(result.artifactReceipt.inspection.sampleRangeCount, result.inspection.sampleRanges.length);
    assert.equal(result.artifactReceipt.canonicalEvidence.fullInspectionInToolResult, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command treats empty cwd as the workspace root", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-empty-cwd-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const prepared = allowed.prepare({
      id: "empty-cwd",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: "",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, await fs.realpath(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command stores large stdout as reusable content-addressed evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-output-ref-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_run_command");
    assert.match(definition?.description ?? "", /stdoutRef\/stderrRef/);
    const prepared = allowed.prepare({
      id: "large-output",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write('row-data\\n'.repeat(1200))"],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
      stdoutRef?: { path: string; sha256: string; characters: number; bytes: number; previewCharacters: number };
    };
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdoutRef !== undefined);
    assert.equal(result.stdoutRef.characters, "row-data\n".repeat(1200).length);
    assert.ok(result.stdout.length < result.stdoutRef.characters);
    assert.match(result.stdout, /stored as content-addressed evidence/);
    assert.match(result.stdout, new RegExp(result.stdoutRef.sha256));
    assert.equal(await fs.readFile(join(root, result.stdoutRef.path), "utf8"), "row-data\n".repeat(1200));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command preserves structured delivery candidates when stdout is referenced", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-structured-ref-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const script = [
      "const payload = {",
      "schema: 'api_catalog_result/v1',",
      "deliveryCandidate: { output: '员工画像标签人员查询 API has countNum and sql inputs.' },",
      "assessmentProjection: { match_count: 1, primary_api_id: 'M_ADS_FACT_MDYG_USER_TRIP_LABEL.D_A_BSTAMDYG_CL002' },",
      "evidenceReceipt: {",
      "schema: 'agentloop.toolEvidenceReceipt/v1',",
      "sourceType: 'api_catalog',",
      "receiptId: 'api-receipt-1',",
      "sourceRefs: [{ url: 'https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT' }],",
      "facts: [{ kind: 'source_summary', primary_api_id: 'M_ADS_FACT_MDYG_USER_TRIP_LABEL.D_A_BSTAMDYG_CL002' }],",
      "caveats: ['candidate ranking requires exact API_ID confirmation'],",
      "evidenceKinds: { satisfied: ['source_summary', 'source_urls'], caveated: ['explicit_caveats'], failed: [] },",
      "},",
      "rawRows: 'x'.repeat(20000),",
      "};",
      "process.stdout.write(JSON.stringify(payload));",
    ].join("\n");
    const prepared = allowed.prepare({
      id: "large-structured-output",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", script],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
      stdoutRef?: { path: string; sha256: string; characters: number; bytes: number; previewCharacters: number };
    };
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdoutRef !== undefined);
    const projected = JSON.parse(result.stdout) as {
      schema: string;
      sourceSchema: string;
      deliveryCandidate: { output: string };
      assessmentProjection: { primary_api_id: string };
      evidenceReceipt: { schema: string; receiptId: string };
      contentLocation: { kind: string; path: string; sha256: string; instruction: string };
      rawRows?: string;
      stdoutReferenceNotice: string;
    };
    assert.equal(projected.schema, "agentloop.commandOutputProjection/v1");
    assert.equal(projected.sourceSchema, "api_catalog_result/v1");
    assert.match(projected.deliveryCandidate.output, /countNum/);
    assert.equal(projected.assessmentProjection.primary_api_id, "M_ADS_FACT_MDYG_USER_TRIP_LABEL.D_A_BSTAMDYG_CL002");
    assert.equal(projected.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(projected.evidenceReceipt.receiptId, "api-receipt-1");
    assert.equal(projected.contentLocation.kind, "content_addressed");
    assert.equal(projected.contentLocation.path, result.stdoutRef.path);
    assert.equal(projected.contentLocation.sha256, result.stdoutRef.sha256);
    assert.match(projected.contentLocation.instruction, /use evidenceReceipt first/);
    assert.equal(projected.rawRows, undefined);
    assert.match(projected.stdoutReferenceNotice, /stored as content-addressed evidence/);
    assert.match(projected.stdoutReferenceNotice, new RegExp(result.stdoutRef.sha256));
    const stored = JSON.parse(await fs.readFile(join(root, result.stdoutRef.path), "utf8")) as { rawRows?: string };
    assert.equal(stored.rawRows?.length, 20_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command preserves oversized structured delivery candidates when stdout is referenced", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-large-candidate-ref-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const delivery = `合同备案记录查询 API has sysId input.\n${"出参字段 ".repeat(1200)}`;
    const script = [
      "const delivery = '合同备案记录查询 API has sysId input.\\n' + '出参字段 '.repeat(1200);",
      "const payload = {",
      "schema: 'api_catalog_result/v1',",
      "deliveryCandidate: { output: delivery, format: 'markdown' },",
      "assessmentProjection: { match_count: 1, primary_api_id: 'M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001' },",
      "evidenceReceipt: {",
      "schema: 'agentloop.toolEvidenceReceipt/v1',",
      "sourceType: 'api_catalog',",
      "receiptId: 'api-receipt-large-candidate',",
      "sourceRefs: [{ url: 'https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT' }],",
      "facts: [{ kind: 'source_summary', primary_api_id: 'M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001' }],",
      "caveats: ['Candidate ranking requires exact API_ID confirmation.'],",
      "evidenceKinds: { satisfied: ['source_summary', 'source_urls'], caveated: ['explicit_caveats'], failed: [] },",
      "},",
      "rawRows: 'x'.repeat(20000),",
      "};",
      "process.stdout.write(JSON.stringify(payload));",
    ].join("\n");
    const prepared = allowed.prepare({
      id: "oversized-structured-candidate",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", script],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
      stdoutRef?: { path: string; sha256: string };
    };

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdoutRef !== undefined);
    const projected = JSON.parse(result.stdout) as {
      schema: string;
      sourceSchema: string;
      deliveryCandidate?: { output: string; format?: string };
      assessmentProjection?: { primary_api_id: string };
      evidenceReceipt?: { receiptId: string };
      contentLocation?: { path: string; sha256: string };
      rawRows?: string;
    };
    assert.equal(projected.schema, "agentloop.commandOutputProjection/v1");
    assert.equal(projected.sourceSchema, "api_catalog_result/v1");
    assert.equal(projected.deliveryCandidate?.output, delivery);
    assert.equal(projected.deliveryCandidate?.format, "markdown");
    assert.equal(projected.assessmentProjection?.primary_api_id, "M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001");
    assert.equal(projected.evidenceReceipt?.receiptId, "api-receipt-large-candidate");
    assert.equal(projected.contentLocation?.path, result.stdoutRef.path);
    assert.equal(projected.contentLocation?.sha256, result.stdoutRef.sha256);
    assert.equal(projected.rawRows, undefined);
    const stored = JSON.parse(await fs.readFile(join(root, result.stdoutRef.path), "utf8")) as { rawRows?: string };
    assert.equal(stored.rawRows?.length, 20_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command promotes structured stdout evidence receipts to the tool result", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-evidence-receipt-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const payload = {
      schema: "source_result/v1",
      deliveryCandidate: { output: "API catalog summary delivered." },
      evidenceReceipt: {
        schema: "agentloop.toolEvidenceReceipt/v1",
        sourceType: "api_catalog",
        receiptId: "api-receipt-small",
        sourceRefs: [{ url: "https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT" }],
        facts: [{ kind: "source_summary", match_count: 1 }],
        caveats: ["Candidate ranking should be confirmed with exact IDs."],
        evidenceKinds: {
          satisfied: ["source_summary", "source_urls"],
          caveated: ["explicit_caveats"],
          failed: [],
        },
      },
    };
    const prepared = allowed.prepare({
      id: "structured-receipt-output",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
      stdoutRef?: { path: string; sha256: string };
      evidenceReceipt?: { schema: string; receiptId: string };
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.evidenceReceipt?.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(result.evidenceReceipt?.receiptId, "api-receipt-small");
    assert.ok(result.stdoutRef !== undefined);
    const projected = JSON.parse(result.stdout) as {
      schema: string;
      sourceSchema: string;
      evidenceReceipt: { receiptId: string };
      contentLocation: { kind: string; path: string; sha256: string; instruction: string };
    };
    assert.equal(projected.schema, "agentloop.commandOutputProjection/v1");
    assert.equal(projected.sourceSchema, "source_result/v1");
    assert.equal(projected.evidenceReceipt.receiptId, "api-receipt-small");
    assert.equal(projected.contentLocation.kind, "content_addressed");
    assert.equal(projected.contentLocation.path, result.stdoutRef.path);
    assert.equal(projected.contentLocation.sha256, result.stdoutRef.sha256);
    assert.match(projected.contentLocation.instruction, /use evidenceReceipt first/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command reports bounded workspace file changes as structured evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-file-changes-"));
  try {
    await fs.writeFile(join(root, "existing.txt"), "before\n");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_run_command");
    assert.match(definition?.description ?? "", /fileChanges/);
    const prepared = allowed.prepare({
      id: "file-change-command",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "fs.writeFileSync('created.json', '{\"ok\":true}\\n');",
            "fs.writeFileSync('existing.txt', 'after\\n');",
          ].join(" "),
        ],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      fileChanges: Array<{ path: string; changeType: string; bytes?: number }>;
      fileChangesTruncated: boolean;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.fileChangesTruncated, false);
    assert.deepEqual(
      result.fileChanges.map((change) => ({ path: change.path, changeType: change.changeType })),
      [
        { path: "created.json", changeType: "created" },
        { path: "existing.txt", changeType: "modified" },
      ],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command accepts the provider-sized timeout and exposes its bounds", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-timeout-bounds-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_run_command");
    assert.deepEqual((definition?.inputSchema as { properties: { timeoutMs: unknown } }).properties.timeoutMs, {
      type: "integer", minimum: 100, maximum: 300_000,
    });
    const prepared = allowed.prepare({
      id: "long-timeout",
      name: "computer_run_command",
      arguments: { command: "node", args: ["--version"], timeoutMs: 180_000 },
    });
    assert.equal((prepared.input as { timeoutMs: number }).timeoutMs, 180_000);
    assert.throws(
      () => allowed.prepare({
        id: "too-long-timeout",
        name: "computer_run_command",
        arguments: { command: "node", args: ["--version"], timeoutMs: 300_001 },
      }),
      /timeoutMs must be an integer between 100 and 300000/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer command names remain bare executable names", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-name-"));
  try {
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.runCommand({ command: process.execPath, args: [], cwd: ".", timeoutMs: 2_000 }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command can use only Runtime-authorized Skill execution roots as cwd", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-root-"));
  const skillRoot = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-package-"));
  try {
    await fs.mkdir(join(skillRoot, "scripts"), { recursive: true });
    await fs.mkdir(join(root, "scripts"), { recursive: true });
    await fs.writeFile(
      join(skillRoot, "scripts", "probe.mjs"),
      "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync('SKILL.md', 'utf8'));\n",
    );
    await fs.writeFile(join(skillRoot, "SKILL.md"), "PACKAGE-SCRIPT-OK\n");
    await fs.writeFile(
      join(root, "scripts", "read-skill-env.mjs"),
      [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const root = process.env.AGENTLOOP_SKILL_ROOT_DEMO_SKILL;",
        "if (root === undefined) throw new Error('missing Skill root env');",
        "process.stdout.write(readFileSync(join(root, 'SKILL.md'), 'utf8'));",
        "",
      ].join("\n"),
    );
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(skillRootGrant(["computer_run_command"], skillRoot));
    const prepared = allowed.prepare({
      id: "skill-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["scripts/probe.mjs"],
        cwd: "@skills/demo-skill",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute({
      grant: skillRootGrant(["computer_run_command"], skillRoot),
    }, prepared.input) as { exitCode: number | null; stdout: string; fileChanges: unknown[] };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "PACKAGE-SCRIPT-OK\n");
    assert.deepEqual(result.fileChanges, []);

    const envPrepared = allowed.prepare({
      id: "workspace-script-with-skill-env",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["scripts/read-skill-env.mjs"],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const envResult = await envPrepared.tool.execute({
      grant: skillRootGrant(["computer_run_command"], skillRoot),
    }, envPrepared.input) as { exitCode: number | null; stdout: string; fileChanges: unknown[] };

    assert.equal(envResult.exitCode, 0);
    assert.equal(envResult.stdout, "PACKAGE-SCRIPT-OK\n");
    assert.deepEqual(envResult.fileChanges, []);

    const unbound = allowed.prepare({
      id: "unbound-skill-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["scripts/probe.mjs"],
        cwd: "@skills/other-skill",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => unbound.tool.execute({ grant: skillRootGrant(["computer_run_command"], skillRoot) }, unbound.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    const aliasArgument = allowed.prepare({
      id: "skill-alias-argument",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["@skills/demo-skill/SKILL.md"],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => aliasArgument.tool.execute({ grant: skillRootGrant(["computer_run_command"], skillRoot) }, aliasArgument.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});

test("computer read tools share authorized Skill root path semantics with command cwd", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-readable-skill-workspace-"));
  const skillRoot = await fs.mkdtemp(join(tmpdir(), "agentloop-readable-skill-package-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "agentloop-readable-skill-outside-"));
  try {
    await fs.mkdir(join(skillRoot, "references"), { recursive: true });
    await fs.writeFile(join(skillRoot, "SKILL.md"), "# Demo Skill\n");
    await fs.writeFile(join(skillRoot, "references", "outline_schema.md"), "# Outline\nneedle: skill reference\n");
    await fs.writeFile(join(outside, "secret.txt"), "outside\n");
    await fs.symlink(outside, join(skillRoot, "escape"));

    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const tools = [
      "computer_read_file",
      "computer_list_directory",
      "computer_find_files",
      "computer_search_text",
      "computer_write_file",
    ];
    const allowed = registry.materialize(skillRootGrant(tools, skillRoot));

    const read = allowed.prepare({
      id: "read-skill-reference",
      name: "computer_read_file",
      arguments: { path: "@skills/demo-skill/references/outline_schema.md" },
    });
    const readResult = await read.tool.execute(
      { grant: skillRootGrant(tools, skillRoot) },
      read.input,
    ) as { content: string };
    assert.equal(readResult.content, "# Outline\nneedle: skill reference\n");

    const list = allowed.prepare({
      id: "list-skill-reference-directory",
      name: "computer_list_directory",
      arguments: { path: "@skills/demo-skill/references" },
    });
    const listResult = await list.tool.execute(
      { grant: skillRootGrant(tools, skillRoot) },
      list.input,
    ) as Array<{ name: string; type: string }>;
    assert.deepEqual(listResult, [{ name: "outline_schema.md", type: "file" }]);

    const find = allowed.prepare({
      id: "find-skill-reference",
      name: "computer_find_files",
      arguments: { path: "@skills/demo-skill", pattern: "references/*.md" },
    });
    const findResult = await find.tool.execute(
      { grant: skillRootGrant(tools, skillRoot) },
      find.input,
    ) as { matches: string[] };
    assert.deepEqual(findResult.matches, ["@skills/demo-skill/references/outline_schema.md"]);

    const search = allowed.prepare({
      id: "search-skill-reference",
      name: "computer_search_text",
      arguments: { path: "@skills/demo-skill", query: "needle" },
    });
    const searchResult = await search.tool.execute(
      { grant: skillRootGrant(tools, skillRoot) },
      search.input,
    ) as Array<{ path: string; line: number; text: string }>;
    assert.deepEqual(searchResult, [{
      path: "@skills/demo-skill/references/outline_schema.md",
      line: 2,
      text: "needle: skill reference",
    }]);

    const unbound = allowed.prepare({
      id: "read-unbound-skill-reference",
      name: "computer_read_file",
      arguments: { path: "@skills/other-skill/SKILL.md" },
    });
    await assert.rejects(
      () => unbound.tool.execute({ grant: skillRootGrant(tools, skillRoot) }, unbound.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    const escaped = allowed.prepare({
      id: "read-skill-escape",
      name: "computer_read_file",
      arguments: { path: "@skills/demo-skill/escape/secret.txt" },
    });
    await assert.rejects(
      () => escaped.tool.execute({ grant: skillRootGrant(tools, skillRoot) }, escaped.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    const write = allowed.prepare({
      id: "write-skill-reference",
      name: "computer_write_file",
      arguments: { path: "@skills/demo-skill/generated.txt", content: "bad\n" },
    });
    await assert.rejects(
      () => write.tool.execute({ grant: skillRootGrant(tools, skillRoot) }, write.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("computer_run_command can use an authorized visible directory as read-only cwd", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-command-visible-root-"));
  try {
    await fs.mkdir(join(visible, "nested"), { recursive: true });
    await fs.writeFile(join(visible, "nested", "source.txt"), "VISIBLE-SOURCE-OK\n");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(visibleGrant(["computer_run_command"], visible));
    const prepared = allowed.prepare({
      id: "visible-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write(require('node:fs').readFileSync('nested/source.txt', 'utf8'))"],
        cwd: "@visible/visible_dir_1",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute({
      grant: visibleGrant(["computer_run_command"], visible),
    }, prepared.input) as { exitCode: number | null; stdout: string; fileChanges: unknown[] };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "VISIBLE-SOURCE-OK\n");
    assert.deepEqual(result.fileChanges, []);

    const mutation = allowed.prepare({
      id: "visible-mutation",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'bad\\n')"],
        cwd: "@visible/visible_dir_1",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => mutation.tool.execute({ grant: visibleGrant(["computer_run_command"], visible) }, mutation.input),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_MUTATED"),
    );

    const escape = allowed.prepare({
      id: "visible-relative-escape",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write('must not run')", "../secret.txt"],
        cwd: "@visible/visible_dir_1",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => escape.tool.execute({ grant: visibleGrant(["computer_run_command"], visible) }, escape.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    const unbound = allowed.prepare({
      id: "unbound-visible-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write('bad')"],
        cwd: "@visible/missing",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => unbound.tool.execute({ grant: visibleGrant(["computer_run_command"], visible) }, unbound.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("computer_run_command rejects commands that mutate an authorized Skill execution root", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-root-mutation-"));
  const skillRoot = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-package-mutation-"));
  try {
    await fs.mkdir(join(root, "scripts"), { recursive: true });
    await fs.writeFile(join(skillRoot, "SKILL.md"), "PACKAGE-SCRIPT-OK\n");
    await fs.writeFile(
      join(root, "scripts", "mutate-skill-env.mjs"),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const root = process.env.AGENTLOOP_SKILL_ROOT_DEMO_SKILL;",
        "if (root === undefined) throw new Error('missing Skill root env');",
        "writeFileSync(join(root, 'generated.txt'), 'bad\\n');",
        "",
      ].join("\n"),
    );
    const executor = new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    });
    await assert.rejects(
      () => executor.runCommand({
        command: "trusted-node",
        args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'bad\\n')"],
        cwd: "@skills/demo-skill",
        timeoutMs: 2_000,
      }),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    const registry = new ToolRegistry(createComputerTools(executor));
    const allowed = registry.materialize(skillRootGrant(["computer_run_command"], skillRoot));
    const prepared = allowed.prepare({
      id: "mutating-skill-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'bad\\n')"],
        cwd: "@skills/demo-skill",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => prepared.tool.execute({
        grant: skillRootGrant(["computer_run_command"], skillRoot),
      }, prepared.input),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_MUTATED"),
    );

    const envPrepared = allowed.prepare({
      id: "mutating-skill-through-env",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["scripts/mutate-skill-env.mjs"],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => envPrepared.tool.execute({
        grant: skillRootGrant(["computer_run_command"], skillRoot),
      }, envPrepared.input),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_MUTATED"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});

test("computer_search_text walks recursively and skips .git/node_modules", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-"));
  try {
    await fs.writeFile(join(root, "a.txt"), "hello world\nfoo\n");
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "sub", "b.txt"), "hello again\n");
    await fs.mkdir(join(root, "node_modules"));
    await fs.writeFile(join(root, "node_modules", "c.txt"), "hello node\n");
    await fs.mkdir(join(root, ".git"));
    await fs.writeFile(join(root, ".git", "d.txt"), "hello git\n");
    const executor = new ComputerExecutor(root);
    const matches = await executor.searchText(".", "hello");
    assert.deepEqual(matches, [
      { path: "a.txt", line: 1, text: "hello world" },
      { path: "sub/b.txt", line: 1, text: "hello again" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file supports small line windows", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-window-"));
  try {
    await fs.writeFile(join(root, "profile.json"), ["one", "two", "three", "four"].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_read_file"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_read_file");
    assert.deepEqual((definition?.inputSchema as { properties: Record<string, unknown> }).properties.offset, {
      type: "integer", minimum: 1,
    });
    const prepared = allowed.prepare({
      id: "read-window",
      name: "computer_read_file",
      arguments: { path: "profile.json", offset: 2, limit: 2 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_read_file"]), prepared.input) as {
      content: string;
      nextOffset?: number;
      truncated: boolean;
    };
    assert.match(result.content, /^two\nthree/);
    assert.equal(result.nextOffset, 4);
    assert.equal(result.truncated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read_file schemas reject mixed single-window and range-window arguments", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-schema-"));
  try {
    const computerRegistry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const computerAllowed = computerRegistry.materialize(grant(["computer_read_file"]));
    const computerDefinition = computerAllowed.definitions.find((tool) => tool.name === "computer_read_file");
    assertReadFileSchemaForbidsMixedWindows(computerDefinition?.inputSchema);
    assert.throws(
      () => computerAllowed.prepare({
        id: "mixed-computer-read",
        name: "computer_read_file",
        arguments: { path: "profile.json", offset: 1, ranges: [{ offset: 1, limit: 1 }] },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST")
        && error instanceof Error
        && /ranges cannot be combined with offset or limit/.test(error.message),
    );

    const visibleRegistry = new ToolRegistry(createVisibleDirectoryTools());
    const visibleAllowed = visibleRegistry.materialize(visibleGrant(["visible_read_file"], root));
    const visibleDefinition = visibleAllowed.definitions.find((tool) => tool.name === "visible_read_file");
    assertReadFileSchemaForbidsMixedWindows(visibleDefinition?.inputSchema);
    assert.throws(
      () => visibleAllowed.prepare({
        id: "mixed-visible-read",
        name: "visible_read_file",
        arguments: { rootId: "visible_dir_1", path: "profile.json", limit: 1, ranges: [{ offset: 1 }] },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST")
        && error instanceof Error
        && /ranges cannot be combined with offset or limit/.test(error.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file reads line windows beyond the default byte prefix", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-late-window-"));
  try {
    const lines = Array.from({ length: 30_050 }, (_, index) =>
      index === 30_020 ? "target: late evidence" : `filler ${index.toString().padStart(5, "0")} ${"x".repeat(20)}`
    );
    await fs.writeFile(join(root, "large.md"), lines.join("\n"));
    const executor = new ComputerExecutor(root);

    const prefix = await executor.readFile("large.md");
    assert.equal(prefix.truncated, true);
    assert.equal(prefix.content.includes("target: late evidence"), false);

    const window = await executor.readFile("large.md", undefined, { offset: 30_020, limit: 3 });
    assert.match(window.content, /target: late evidence/);
    assert.equal(window.offset, 30_020);
    assert.equal(window.limit, 3);
    assert.equal(window.totalLines, 30_050);
    assert.equal(window.nextOffset, 30_023);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file supports multiple evidence ranges in one call", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-ranges-"));
  try {
    await fs.writeFile(join(root, "brief.md"), ["one", "two", "three", "four", "five"].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_read_file"]));
    const prepared = allowed.prepare({
      id: "read-ranges",
      name: "computer_read_file",
      arguments: {
        path: "brief.md",
        ranges: [
          { offset: 2, limit: 1 },
          { offset: 5, limit: 1 },
        ],
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_read_file"]), prepared.input) as {
      content: string;
      ranges: Array<{ content: string; startLine: number; endLine: number }>;
    };
    assert.match(result.content, /brief\.md lines 2-2/);
    assert.match(result.content, /brief\.md lines 5-5/);
    assert.deepEqual(result.ranges.map((range) => [range.startLine, range.endLine, range.content]), [
      [2, 2, "two"],
      [5, 5, "five"],
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_find_files finds files by glob without dumping directory trees", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-find-files-"));
  try {
    await fs.mkdir(join(root, "reports"), { recursive: true });
    await fs.mkdir(join(root, "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "reports", "scenario.json"), "{}");
    await fs.writeFile(join(root, "reports", "scenario.md"), "# report\n");
    await fs.writeFile(join(root, "node_modules", "ignored.json"), "{}");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_find_files"]));
    const prepared = allowed.prepare({
      id: "find-json",
      name: "computer_find_files",
      arguments: { pattern: "**/*.json", limit: 10 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_find_files"]), prepared.input) as {
      matches: string[];
      truncated: boolean;
    };
    assert.deepEqual(result.matches, ["reports/scenario.json"]);
    assert.equal(result.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_find_files treats an empty path as the workspace root", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-find-files-empty-path-"));
  try {
    await fs.mkdir(join(root, "reports"), { recursive: true });
    await fs.writeFile(join(root, "reports", "scenario.json"), "{}");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_find_files"]));
    const prepared = allowed.prepare({
      id: "find-json-empty-path",
      name: "computer_find_files",
      arguments: { pattern: "**/*.json", path: "", limit: 10 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_find_files"]), prepared.input) as {
      matches: string[];
      truncated: boolean;
    };
    assert.deepEqual(result.matches, ["reports/scenario.json"]);
    assert.equal(result.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visible directory tools read only from explicitly granted local directories", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-root-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-outside-"));
  try {
    await fs.mkdir(join(root, "materials"), { recursive: true });
    await fs.writeFile(join(root, "materials", "brief.md"), "# Brief\nlocal evidence\n");
    await fs.writeFile(join(outside, "secret.md"), "not granted\n");
    const registry = new ToolRegistry(createVisibleDirectoryTools());
    const allowed = registry.materialize(visibleGrant(["visible_list_directory", "visible_find_files", "visible_read_file"], root));

    const listRoot = allowed.prepare({
      id: "list-visible-root",
      name: "visible_list_directory",
      arguments: { rootId: "visible_dir_1", path: "/" },
    });
    const listed = await listRoot.tool.execute(
      { grant: visibleGrant(["visible_list_directory", "visible_find_files", "visible_read_file"], root) },
      listRoot.input,
    ) as { entries: Array<{ name: string; type: string }> };
    assert.ok(listed.entries.some((entry) => entry.name === "materials" && entry.type === "directory"));

    const find = allowed.prepare({
      id: "find-visible",
      name: "visible_find_files",
      arguments: { rootId: "visible_dir_1", pattern: "**/brief.md" },
    });
    const found = await find.tool.execute(
      { grant: visibleGrant(["visible_find_files", "visible_read_file"], root) },
      find.input,
    ) as {
      schema: string;
      rootId: string;
      matches: string[];
      limit: number;
      returned: number;
      totalMatches: number;
      truncated: boolean;
      evidenceReceipt: { schema: string; sourceRefs: Array<{ path: string }> };
    };
    assert.equal(found.schema, "agentloop.visibleFindFiles/v1");
    assert.deepEqual(found.matches, ["materials/brief.md"]);
    assert.deepEqual({
      rootId: found.rootId,
      limit: found.limit,
      returned: found.returned,
      totalMatches: found.totalMatches,
      truncated: found.truncated,
    }, {
      rootId: "visible_dir_1",
      limit: 1000,
      returned: 1,
      totalMatches: 1,
      truncated: false,
    });
    assert.equal(found.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(found.evidenceReceipt.sourceRefs[0]?.path, "materials/brief.md");

    const read = allowed.prepare({
      id: "read-visible",
      name: "visible_read_file",
      arguments: { rootId: "visible_dir_1", path: "materials/brief.md" },
    });
    const content = await read.tool.execute(
      { grant: visibleGrant(["visible_find_files", "visible_read_file"], root) },
      read.input,
    ) as { content: string; path: string; evidenceReceipt: { schema: string; sourceRefs: Array<{ sourceRefId: string; path: string; rootId: string }>; evidenceKinds: { satisfied: string[] } } };
    assert.equal(content.path, "materials/brief.md");
    assert.match(content.content, /local evidence/);
    assert.equal(content.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.deepEqual(content.evidenceReceipt.evidenceKinds.satisfied, ["source_read", "source_summary", "source_refs"]);
    assert.equal(content.evidenceReceipt.sourceRefs[0].path, "materials/brief.md");
    assert.equal(content.evidenceReceipt.sourceRefs[0].rootId, "visible_dir_1");
    assert.match(content.evidenceReceipt.sourceRefs[0].sourceRefId, /^visible-source:/);

    const readByRef = allowed.prepare({
      id: "read-visible-ref",
      name: "visible_read_file",
      arguments: { sourceRef: found.evidenceReceipt.sourceRefs[0] },
    });
    const contentByRef = await readByRef.tool.execute(
      { grant: visibleGrant(["visible_find_files", "visible_read_file"], root) },
      readByRef.input,
    ) as { content: string; path: string };
    assert.equal(contentByRef.path, "materials/brief.md");
    assert.match(contentByRef.content, /local evidence/);

    await assert.rejects(
      () => read.tool.execute(
        { grant: visibleGrant(["visible_list_directory", "visible_find_files", "visible_read_file"], root) },
        { rootId: "missing", path: "materials/brief.md" },
      ),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
    await assert.rejects(
      () => read.tool.execute(
        { grant: visibleGrant(["visible_list_directory", "visible_find_files", "visible_read_file"], root) },
        { rootId: "visible_dir_1", path: "../" + join(outside, "secret.md") },
      ),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("visible directory indexing creates source summary evidence for large directory analysis", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-index-"));
  try {
    await fs.mkdir(join(root, "kb"), { recursive: true });
    for (let index = 1; index <= 5; index += 1) {
      const category = index <= 3 ? "财税业务 > 报账平台" : "行政业务 > 商旅";
      await fs.writeFile(join(root, "kb", `KB-${String(index).padStart(4, "0")} topic ${index}.md`), `# Topic ${index}\n分类：${category}\n问题：如何处理 ${index}\n`);
    }
    await fs.writeFile(join(root, "notes.txt"), "plain note\n");
    const registry = new ToolRegistry(createVisibleDirectoryTools());
    const allowed = registry.materialize(visibleGrant(["visible_index_directory"], root));
    const prepared = allowed.prepare({
      id: "index-visible",
      name: "visible_index_directory",
      arguments: { rootId: "visible_dir_1", path: ".", sampleLimit: 3, groupPrefixLength: 7 },
    });
    const result = await prepared.tool.execute(
      { grant: visibleGrant(["visible_index_directory"], root) },
      prepared.input,
    ) as {
      schema: string;
      rootId: string;
      totalFiles: number;
      indexRef: string;
      extensions: Record<string, number>;
      samplePaths: string[];
      fieldProfiles: Array<{
        field: string;
        observed: number;
        uniqueValues: number;
        topValues: Array<{ value: string; count: number; samplePaths: string[] }>;
        hierarchy?: { nodes: Array<{ path: string[]; count: number }> };
      }>;
      evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      caveats: string[];
      evidenceReceipt: {
        schema: string;
        sourceType: string;
        facts: Array<{ kind: string; indexRef: string }>;
      };
    };

    assert.equal(result.schema, "agentloop.sourceSummary/v1");
    assert.equal(result.rootId, "visible_dir_1");
    assert.equal(result.totalFiles, 6);
    assert.equal(result.extensions[".md"], 5);
    assert.equal(result.extensions[".txt"], 1);
    assert.equal(result.samplePaths.length, 3);
    const categoryProfile = result.fieldProfiles.find((profile) => profile.field === "分类");
    assert.equal(categoryProfile?.observed, 5);
    assert.equal(categoryProfile?.uniqueValues, 2);
    assert.equal(categoryProfile?.topValues[0]?.value, "财税业务 > 报账平台");
    assert.equal(categoryProfile?.topValues[0]?.count, 3);
    assert.equal(categoryProfile?.topValues[0]?.samplePaths.length, 2);
    assert.ok(categoryProfile?.topValues[0]?.samplePaths.every((path) => /^kb\/KB-000[123] topic [123]\.md$/.test(path)));
    assert.ok(categoryProfile?.hierarchy?.nodes.some((node) => node.path.join(" > ") === "财税业务" && node.count === 3));
    assert.ok(result.evidenceKinds.satisfied.includes("source_summary"));
    assert.ok(result.evidenceKinds.caveated.includes("explicit_caveats"));
    assert.equal(result.evidenceKinds.failed.length, 0);
    assert.ok(result.caveats.some((item) => /does not read every file body/.test(item)));
    assert.equal(result.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(result.evidenceReceipt.sourceType, "visible_directory");
    assert.equal(result.evidenceReceipt.facts[0]?.kind, "source_summary");
    assert.equal(result.evidenceReceipt.facts[0]?.indexRef, result.indexRef);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visible_find_files reports total matches when returned paths are truncated", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-find-total-"));
  try {
    for (let index = 1; index <= 4; index += 1) {
      await fs.writeFile(join(root, `doc-${index}.md`), `# ${index}\n`);
    }
    const registry = new ToolRegistry(createVisibleDirectoryTools());
    const allowed = registry.materialize(visibleGrant(["visible_find_files"], root));
    const prepared = allowed.prepare({
      id: "find-visible",
      name: "visible_find_files",
      arguments: { rootId: "visible_dir_1", pattern: "*.md", limit: 2 },
    });
    const result = await prepared.tool.execute(
      { grant: visibleGrant(["visible_find_files"], root) },
      prepared.input,
    ) as { matches: string[]; returned: number; totalMatches: number; truncated: boolean };

    assert.equal(result.returned, 2);
    assert.equal(result.totalMatches, 4);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.matches, ["doc-1.md", "doc-2.md"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visible_search_text normalizes empty path and caps broad maxMatches", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-search-normalize-"));
  try {
    for (let index = 1; index <= 3; index += 1) {
      await fs.writeFile(join(root, `KB-${index}.md`), `# ${index}\n分类：财税业务 > 报账平台\n`);
    }
    const registry = new ToolRegistry(createVisibleDirectoryTools());
    const allowed = registry.materialize(visibleGrant(["visible_search_text"], root));
    const prepared = allowed.prepare({
      id: "search-visible",
      name: "visible_search_text",
      arguments: {
        rootId: "visible_dir_1",
        path: "",
        query: "分类：财税业务 > 报账平台",
        maxMatches: 500,
      },
    });
    const result = await prepared.tool.execute(
      { grant: visibleGrant(["visible_search_text"], root) },
      prepared.input,
    ) as { schema: string; matches: Array<{ path: string; text: string }>; evidenceReceipt: { schema: string; facts: Array<{ kind: string; returnedMatches: number }> } };

    assert.equal(result.schema, "agentloop.visibleSearchText/v1");
    assert.equal(result.matches.length, 3);
    assert.match(result.matches[0].text, /报账平台/);
    assert.equal(result.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(result.evidenceReceipt.facts[0]?.kind, "text_search");
    assert.equal(result.evidenceReceipt.facts[0]?.returnedMatches, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visible_search_text auto-compacts broad results unless full matches are requested", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-search-compact-"));
  try {
    for (let index = 1; index <= 80; index += 1) {
      const category = index <= 60 ? "财税业务 > 标财系统" : "行政业务 > 商旅";
      await fs.writeFile(join(root, `KB-${String(index).padStart(4, "0")}.md`), `# ${index}\n分类：${category}\n`);
    }
    const registry = new ToolRegistry(createVisibleDirectoryTools());
    const allowed = registry.materialize(visibleGrant(["visible_search_text"], root));
    const compact = allowed.prepare({
      id: "search-visible-compact",
      name: "visible_search_text",
      arguments: {
        rootId: "visible_dir_1",
        query: "分类：",
      },
    });
    const compactResult = await compact.tool.execute(
      { grant: visibleGrant(["visible_search_text"], root) },
      compact.input,
    ) as {
      schema: string;
      resultMode: string;
      returnedMatches: number;
      truncated: boolean;
      matches?: unknown;
      sampleMatches: Array<{ path: string; text: string }>;
      textGroups: Array<{ text: string; count: number }>;
      caveats: string[];
      evidenceReceipt: { schema: string; sourceType: string };
    };

    assert.equal(compactResult.schema, "agentloop.visibleSearchSummary/v1");
    assert.equal(compactResult.resultMode, "compact");
    assert.equal(compactResult.returnedMatches, 80);
    assert.equal(compactResult.truncated, false);
    assert.equal(compactResult.matches, undefined);
    assert.equal(compactResult.sampleMatches.length, 12);
    assert.equal(compactResult.textGroups[0]?.text, "分类：财税业务 > 标财系统");
    assert.equal(compactResult.textGroups[0]?.count, 60);
    assert.ok(compactResult.caveats.some((item) => /compacted/.test(item)));
    assert.equal(compactResult.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(compactResult.evidenceReceipt.sourceType, "visible_search_text");

    const full = allowed.prepare({
      id: "search-visible-full",
      name: "visible_search_text",
      arguments: {
        rootId: "visible_dir_1",
        query: "分类：",
        resultMode: "matches",
      },
    });
    const fullResult = await full.tool.execute(
      { grant: visibleGrant(["visible_search_text"], root) },
      full.input,
    ) as { matches: Array<{ path: string; text: string }> };

    assert.equal(fullResult.matches.length, 80);
    assert.match(fullResult.matches[0].text, /分类：/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visible_read_files reads bounded windows from multiple discovered files", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-read-files-"));
  try {
    await fs.writeFile(join(root, "a.md"), "# A\nfirst\nsecond\n");
    await fs.writeFile(join(root, "b.md"), "# B\nthird\nfourth\n");
    const registry = new ToolRegistry(createVisibleDirectoryTools());
    const allowed = registry.materialize(visibleGrant(["visible_read_files"], root));
    const prepared = allowed.prepare({
      id: "read-visible-batch",
      name: "visible_read_files",
      arguments: {
        rootId: "visible_dir_1",
        files: [
          { path: "a.md", offset: 1, limit: 2 },
          { path: "b.md", ranges: [{ offset: 2, limit: 1 }] },
        ],
        maxTotalCharacters: 10_000,
      },
    });
    const result = await prepared.tool.execute(
      { grant: visibleGrant(["visible_read_files"], root) },
      prepared.input,
    ) as {
      schema: string;
      requested: number;
      returned: number;
      files: Array<{ path: string; content: string; sha256: string }>;
      evidenceReceipt: {
        schema: string;
        sourceRefs: Array<{ path: string; sha256: string }>;
        facts: Array<{ path: string; title?: string; outline: Array<{ line: number; text: string }> }>;
      };
    };

    assert.equal(result.schema, "agentloop.visibleReadFiles/v1");
    assert.equal(result.requested, 2);
    assert.equal(result.returned, 2);
    assert.match(result.files[0].content, /# A/);
    assert.match(result.files[1].content, /third/);
    assert.equal(result.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(result.evidenceReceipt.sourceRefs[0].sha256, result.files[0].sha256);
    assert.equal(result.evidenceReceipt.facts[0].title, "A");
    assert.equal(result.evidenceReceipt.sourceRefs[1].path, "b.md");
    assert.deepEqual(result.evidenceReceipt.facts[0].outline, [{ line: 1, text: "# A" }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_search_text searches a single file path", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-file-"));
  try {
    await fs.writeFile(join(root, "only.txt"), "line one\nhello there\nline three\n");
    const executor = new ComputerExecutor(root);
    assert.deepEqual(await executor.searchText("only.txt", "hello"), [
      { path: "only.txt", line: 2, text: "hello there" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_search_text returns bounded context windows and read ranges", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-context-"));
  try {
    await fs.writeFile(join(root, "plan.md"), [
      "# Plan",
      "before",
      "target decision",
      "after",
      "tail",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_search_text"]));
    const prepared = allowed.prepare({
      id: "search-context",
      name: "computer_search_text",
      arguments: { path: ".", query: "target", contextBefore: 1, contextAfter: 1, maxMatches: 5 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_search_text"]), prepared.input) as Array<{
      path: string;
      line: number;
      context?: { startLine: number; endLine: number; content: string };
      readRange?: { offset: number; limit?: number };
    }>;
    assert.deepEqual(result, [{
      path: "plan.md",
      line: 3,
      text: "target decision",
      context: { startLine: 2, endLine: 4, content: "before\ntarget decision\nafter" },
      readRange: { offset: 2, limit: 3 },
    }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_search_text delegates to a trusted grep and matches the JS walk", async () => {
  const grep = await findGrep();
  if (grep === undefined) return;
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-grep-"));
  try {
    await fs.writeFile(join(root, "a.txt"), "hello world\nfoo bar\n");
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "sub", "b.txt"), "say hello\n");
    await fs.mkdir(join(root, "node_modules"));
    await fs.writeFile(join(root, "node_modules", "c.txt"), "hello node\n");
    const plain = new ComputerExecutor(root);
    const fast = new ComputerExecutor(root, { executableAliases: { grep } });
    const expected = await plain.searchText(".", "hello");
    const actual = await fast.searchText(".", "hello");
    assert.deepEqual(actual, expected);
    assert.ok(actual.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parseRgJsonLine extracts fields without colon ambiguity", () => {
  const workspaceRoot = "/tmp/ws:root";
  const match = parseRgJsonLine(JSON.stringify({
    type: "match",
    data: {
      path: { text: "/tmp/ws:root/a.txt" },
      lines: { text: "hello: world\n" },
      line_number: 2,
      absolute_offset: 0,
      submatches: [],
    },
  }), workspaceRoot);
  assert.deepEqual(match, { path: "a.txt", line: 2, text: "hello: world" });
});

test("parseGrepLine strips a search root containing ':' before splitting fields", () => {
  const workspaceRoot = "/tmp";
  const searchRoot = "/tmp/ws:root";
  const match = parseGrepLine("/tmp/ws:root/a.txt:3:hello", searchRoot, workspaceRoot);
  assert.deepEqual(match, { path: "ws:root/a.txt", line: 3, text: "hello" });
});

test("buildCommandEnvironment is platform-aware and lets server env override", () => {
  const env = buildCommandEnvironment({});
  assert.equal(typeof env.PATH, "string");
  assert.equal(env.LANG, process.env.LANG ?? "C.UTF-8");
  assert.equal(env.LC_ALL, process.env.LC_ALL ?? "C.UTF-8");
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  assert.ok(env.TMPDIR);
  assert.equal("TEMP" in env, false);
  assert.equal("SystemRoot" in env, false);
  const overridden = buildCommandEnvironment({ DEMO_FLAG: "x", PATH: "/custom" });
  assert.equal(overridden.DEMO_FLAG, "x");
  assert.equal(overridden.PATH, "/custom");
});

async function findGrep(): Promise<string | undefined> {
  for (const candidate of ["/usr/bin/grep", "/bin/grep", "/usr/local/bin/grep"]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

function grant(toolNames: readonly string[]) {
  return createCapabilityGrant({
    actorUserId: "user", runId: "run", depth: 0,
    allowedToolNames: toolNames, allowedSkillIds: [],
  });
}

function visibleGrant(toolNames: readonly string[], path: string) {
  return createCapabilityGrant({
    actorUserId: "user",
    runId: "run",
    depth: 0,
    visibleDirectories: [{ id: "visible_dir_1", name: "visible", path }],
    allowedToolNames: toolNames,
    allowedSkillIds: [],
  });
}

function skillRootGrant(toolNames: readonly string[], path: string) {
  return createCapabilityGrant({
    actorUserId: "user",
    runId: "run",
    depth: 0,
    skillExecutionRoots: [{
      id: "skill-root:demo",
      skillId: "demo-skill",
      name: "demo-skill",
      cwd: "@skills/demo-skill",
      path,
    }],
    allowedToolNames: toolNames,
    allowedSkillIds: ["demo-skill"],
  });
}

function grantContext(toolNames: readonly string[]) {
  return { grant: grant(toolNames) };
}

function check(
  result: { checks: Array<{ id: string; status: string; evidence: Record<string, unknown>; diagnostics?: string }> },
  id: string,
) {
  return result.checks.find((item) => item.id === id);
}

function storedZip(entries: readonly (readonly [string, string])[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentBuffer = Buffer.from(content, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(contentBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, contentBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + contentBuffer.length;
  }
  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function renderedState(navigated: boolean) {
  return {
    url: navigated ? "file:///deck.html#2" : "file:///deck.html",
    hash: navigated ? "#2" : "",
    title: "Deck",
    scrollX: 0,
    scrollY: 0,
    bodyWidth: 1280,
    bodyHeight: 720,
    visible: [{
      index: navigated ? 1 : 0,
      id: navigated ? "slide-2" : "slide-1",
      className: "slide",
      text: navigated ? "Two" : "One",
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    }],
  };
}

function assertReadFileSchemaForbidsMixedWindows(schema: unknown) {
  assert.equal(schema !== null && typeof schema === "object", true);
  const allOf = (schema as { allOf?: unknown }).allOf;
  assert.deepEqual(allOf, [
    { not: { required: ["ranges", "offset"] } },
    { not: { required: ["ranges", "limit"] } },
  ]);
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}

import { extname } from "node:path";
import type { ComputerExecutor } from "../computer/computer-executor.ts";
import type {
  ArtifactAcceptanceProvider,
  ArtifactAcceptanceProviderQuery,
  ArtifactAcceptanceProviderResult,
} from "./artifact-acceptance-provider.ts";

const MAX_ARTIFACT_BYTES_FOR_PROFILE_INSPECTION = 20_000_000;

export type ArtifactAcceptanceKind =
  | "auto"
  | "generic_file"
  | "html"
  | "html_ppt"
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "markdown"
  | "image"
  | "json";

export type ArtifactAcceptanceStatus = "passed" | "failed" | "skipped_unavailable";
export type ArtifactAcceptanceVerdict = "accepted" | "caveated" | "rejected";

export interface ArtifactAcceptanceInput {
  readonly artifactPath: string;
  readonly artifactKind?: ArtifactAcceptanceKind;
  readonly profileId?: ArtifactAcceptanceKind;
  readonly checks?: readonly string[];
}

export interface ArtifactAcceptanceCheck {
  readonly id: string;
  readonly status: ArtifactAcceptanceStatus;
  readonly evidence: Record<string, unknown>;
  readonly diagnostics?: string;
}

export interface ArtifactAcceptanceEvidence {
  readonly schema: "agentloop.artifactAcceptance/v1";
  readonly artifact: {
    readonly path: string;
    readonly requestedPath: string;
    readonly resolvedPath?: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly kind: Exclude<ArtifactAcceptanceKind, "auto">;
    readonly profileId: Exclude<ArtifactAcceptanceKind, "auto">;
    readonly inspectionTruncated: boolean;
  };
  readonly verdict: ArtifactAcceptanceVerdict;
  readonly checks: readonly ArtifactAcceptanceCheck[];
  readonly evidenceKinds: {
    readonly satisfied: readonly string[];
    readonly caveated: readonly string[];
    readonly failed: readonly string[];
  };
  readonly caveats: readonly string[];
  readonly requestedChecks?: readonly string[];
}

export interface ArtifactAcceptanceServiceOptions {
  readonly providers?: readonly ArtifactAcceptanceProvider[];
}

export class ArtifactAcceptanceService {
  private readonly providers: readonly ArtifactAcceptanceProvider[];

  constructor(options: ArtifactAcceptanceServiceOptions = {}) {
    this.providers = Object.freeze([...(options.providers ?? [])]);
  }

  async verify(
    executor: ComputerExecutor,
    input: ArtifactAcceptanceInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ArtifactAcceptanceEvidence> {
    const requestedPath = input.artifactPath;
    const inspection = await executor.inspectFile(requestedPath);
    const bytes = await executor.readFileBytes(requestedPath, MAX_ARTIFACT_BYTES_FOR_PROFILE_INSPECTION);
    const kind = resolveArtifactKind(requestedPath, bytes.content, input.artifactKind ?? "auto", input.profileId);
    const profileId = resolveProfileId(kind, input.profileId);
    const artifact: ArtifactAcceptanceEvidence["artifact"] = {
      path: inspection.path,
      requestedPath,
      ...(inspection.resolvedPath === undefined ? {} : { resolvedPath: inspection.resolvedPath }),
      bytes: inspection.bytes,
      sha256: inspection.sha256,
      kind,
      profileId,
      inspectionTruncated: bytes.truncated,
    };
    const requestedChecks = input.checks ?? [];
    const staticChecks: ArtifactAcceptanceCheck[] = [
      passed("artifact_path", {
        requestedPath,
        path: inspection.path,
        ...(inspection.resolvedPath === undefined ? {} : { resolvedPath: inspection.resolvedPath }),
      }),
      checkStatus("artifact_non_empty", inspection.bytes > 0, { bytes: inspection.bytes }),
      passed("artifact_integrity", { sha256: inspection.sha256, bytes: inspection.bytes }),
      ...verifyByProfile(profileId, requestedPath, bytes.content, bytes.truncated, requestedChecks),
    ];
    const localChecks = profileId === "pdf"
      ? [await verifyPdfTextLayer(executor, inspection.path, { signal: options.signal })]
      : [];
    const providerResults = await this.verifyWithProviders({
      artifact,
      profileId,
      requestedChecks,
      workspaceRoot: executor.workspaceRoot,
      staticChecks,
      signal: options.signal,
    });
    const checks = mergeProviderChecks(
      [...staticChecks, ...localChecks],
      providerResults.flatMap((result) => annotateProviderChecks(result)),
    );
    const verdict = verdictForChecks(checks);

    return {
      schema: "agentloop.artifactAcceptance/v1",
      artifact,
      verdict,
      checks,
      evidenceKinds: evidenceKindsForChecks(checks, verdict),
      caveats: caveatsForChecks(checks),
      ...(input.checks === undefined ? {} : { requestedChecks: input.checks }),
    };
  }

  private async verifyWithProviders(
    request: ArtifactAcceptanceProviderQuery & {
      readonly workspaceRoot: string;
      readonly staticChecks: readonly ArtifactAcceptanceCheck[];
      readonly signal?: AbortSignal;
    },
  ): Promise<ArtifactAcceptanceProviderResult[]> {
    const matching = this.providers.filter((provider) => provider.supports(request));
    const results: ArtifactAcceptanceProviderResult[] = [];
    for (const provider of matching) {
      try {
        results.push(await provider.verify({
          artifact: request.artifact,
          profileId: request.profileId,
          requestedChecks: request.requestedChecks,
          workspaceRoot: request.workspaceRoot,
          staticChecks: request.staticChecks,
          signal: request.signal,
        }));
      } catch (error) {
        results.push({
          providerId: provider.id,
          checks: [{
            id: `provider:${provider.id}`,
            status: "failed",
            evidence: { providerId: provider.id },
            diagnostics: error instanceof Error ? error.message : "Artifact acceptance provider failed",
          }],
        });
      }
    }
    return results;
  }
}

function annotateProviderChecks(result: ArtifactAcceptanceProviderResult): ArtifactAcceptanceCheck[] {
  return result.checks.map((check) => ({
    ...check,
    evidence: {
      providerId: result.providerId,
      ...check.evidence,
      ...(result.artifacts === undefined || result.artifacts.length === 0 ? {} : { artifacts: result.artifacts }),
      ...(result.diagnostics === undefined || result.diagnostics.length === 0 ? {} : { providerDiagnostics: result.diagnostics }),
    },
  }));
}

function mergeProviderChecks(
  staticChecks: readonly ArtifactAcceptanceCheck[],
  providerChecks: readonly ArtifactAcceptanceCheck[],
): ArtifactAcceptanceCheck[] {
  const providerResolvedIds = new Set(
    providerChecks
      .filter((check) => check.status !== "skipped_unavailable")
      .map((check) => check.id),
  );
  return [
    ...staticChecks.filter((check) => !(check.status === "skipped_unavailable" && providerResolvedIds.has(check.id))),
    ...providerChecks,
  ];
}

function verdictForChecks(checks: readonly ArtifactAcceptanceCheck[]): ArtifactAcceptanceVerdict {
  if (checks.some((check) => check.status === "failed")) return "rejected";
  if (checks.some((check) => check.status === "skipped_unavailable")) return "caveated";
  return "accepted";
}

function caveatsForChecks(checks: readonly ArtifactAcceptanceCheck[]): string[] {
  return checks
    .filter((check) => check.status === "skipped_unavailable")
    .map((check) => check.diagnostics ?? `${check.id} unavailable`);
}

function verifyByProfile(
  profileId: Exclude<ArtifactAcceptanceKind, "auto">,
  path: string,
  content: Buffer,
  truncated: boolean,
  requestedChecks: readonly string[],
): ArtifactAcceptanceCheck[] {
  switch (profileId) {
    case "html":
      return verifyHtmlProfile(path, content, truncated, false, requestedChecks);
    case "html_ppt":
      return verifyHtmlProfile(path, content, truncated, true, requestedChecks);
    case "docx":
      return verifyOfficePackageProfile(path, content, truncated, "docx", ["[Content_Types].xml", "word/document.xml"]);
    case "xlsx":
      return verifyOfficePackageProfile(path, content, truncated, "xlsx", ["[Content_Types].xml", "xl/workbook.xml"]);
    case "pptx":
      return verifyOfficePackageProfile(path, content, truncated, "pptx", ["[Content_Types].xml", "ppt/presentation.xml"]);
    case "pdf":
      return verifyPdfProfile(path, content, truncated);
    case "image":
      return verifyImageProfile(path, content);
    case "json":
      return verifyJsonProfile(path, content, truncated);
    case "markdown":
      return verifyMarkdownProfile(path, content, truncated);
    case "generic_file":
      return [passed("artifact_openable", { mode: "workspace_read", note: "File bytes were read through the workspace-contained executor." })];
  }
}

function verifyHtmlProfile(
  path: string,
  content: Buffer,
  truncated: boolean,
  presentationMode: boolean,
  requestedChecks: readonly string[],
): ArtifactAcceptanceCheck[] {
  const text = content.toString("utf8");
  const extensionMatches = /\.(?:html|htm)$/i.test(path);
  const hasHtmlShape = /<!doctype\s+html\b/i.test(text)
    || /<html\b/i.test(text)
    || (/<body\b/i.test(text) && /<\/body>/i.test(text));
  const slideCount = countHtmlSlides(text);
  const navigationSignals = htmlNavigationSignals(text);
  const checks: ArtifactAcceptanceCheck[] = [
    checkStatus("format_matches_request", extensionMatches && hasHtmlShape, {
      expected: presentationMode ? "html_ppt" : "html",
      extensionMatches,
      hasHtmlShape,
      contentTruncated: truncated,
    }),
    checkStatus("artifact_openable", hasHtmlShape, {
      mode: "static_html_parse",
      hasHtmlShape,
      contentTruncated: truncated,
    }),
  ];
  if (presentationMode) {
    checks.push(
      checkStatus("slide_structure", slideCount > 0, { slideCount }),
      checkStatus("static_navigation_signals", navigationSignals.length > 0, { signals: navigationSignals }),
      skipped("basic_navigation", {
        staticSignals: navigationSignals,
        reason: "No browser renderer is configured for this runtime.",
      }, "Browser-rendered navigation was not executed."),
      skipped("rendered_interaction", {
        requiredCapability: "browser_or_renderer_driver",
      }, "Rendered visual and interaction acceptance is unavailable in this runtime."),
    );
  } else {
    if (htmlBasicNavigationRequested(requestedChecks)) {
      checks.push(checkStatus("basic_navigation", navigationSignals.length > 0, {
        mode: "static_html_navigation_signals",
        signals: navigationSignals,
      }));
    }
    checks.push(skipped("rendered_open", {
      requiredCapability: "browser_or_renderer_driver",
    }, "Browser-rendered openability is unavailable in this runtime."));
  }
  return checks;
}

function htmlBasicNavigationRequested(checks: readonly string[]): boolean {
  return checks.some((check) =>
    /(?:basic[_\s-]?navigation|page\s+navigation|pagination|paginated|next|previous|prev|导航|翻页|分页|上一页|下一页)/iu
      .test(check)
  );
}

function verifyOfficePackageProfile(
  path: string,
  content: Buffer,
  truncated: boolean,
  kind: "docx" | "xlsx" | "pptx",
  requiredEntries: readonly string[],
): ArtifactAcceptanceCheck[] {
  const extensionMatches = new RegExp(`\\.${kind}$`, "i").test(path);
  const zipEntries = truncated ? [] : parseZipEntries(content);
  const requiredEntrySet = new Set(requiredEntries);
  const presentEntries = new Set(zipEntries);
  const missingEntries = requiredEntries.filter((entry) => !presentEntries.has(entry));
  const packageLooksValid = !truncated && zipEntries.length > 0 && missingEntries.length === 0;
  const structuralCounts = officeStructuralCounts(kind, zipEntries);
  const checks: ArtifactAcceptanceCheck[] = [
    checkStatus("format_matches_request", extensionMatches && packageLooksValid, {
      expected: kind,
      extensionMatches,
      requiredEntries,
      missingEntries,
      entryCount: zipEntries.length,
      contentTruncated: truncated,
    }),
    checkStatus("artifact_openable", packageLooksValid, {
      mode: "openxml_package_structure",
      requiredEntries: [...requiredEntrySet],
      missingEntries,
      ...structuralCounts,
    }),
  ];
  if (kind === "pptx") {
    checks.push(checkStatus("basic_navigation", packageLooksValid && structuralCounts.slideCount > 0, {
      mode: "openxml_slide_sequence",
      slideCount: structuralCounts.slideCount,
    }));
  }
  checks.push(skipped("rendered_open", {
    requiredCapability: `${kind}_renderer`,
  }, `${kind.toUpperCase()} visual/application render acceptance is unavailable in this runtime.`));
  return checks;
}

function verifyPdfProfile(path: string, content: Buffer, truncated: boolean): ArtifactAcceptanceCheck[] {
  const text = content.toString("latin1");
  const extensionMatches = /\.pdf$/i.test(path);
  const hasHeader = text.startsWith("%PDF-");
  const hasEof = /%%EOF\s*$/m.test(text);
  const rawMarkupLeak = pdfTextLayerProblems(text).rawMarkupLeak;
  return [
    checkStatus("format_matches_request", extensionMatches && hasHeader, {
      expected: "pdf",
      extensionMatches,
      hasHeader,
      hasEof,
      contentTruncated: truncated,
    }),
    checkStatus("artifact_openable", hasHeader, { mode: "pdf_signature", hasHeader, hasEof }),
    checkStatus("pdf_static_text_sanity", !rawMarkupLeak, {
      mode: "raw_pdf_byte_scan",
      rawMarkupLeak,
      contentTruncated: truncated,
    }),
    skipped("rendered_open", {
      requiredCapability: "pdf_renderer",
    }, "PDF page rendering acceptance is unavailable in this runtime."),
  ];
}

async function verifyPdfTextLayer(
  executor: ComputerExecutor,
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<ArtifactAcceptanceCheck> {
  try {
    const result = await executor.runCommand({
      command: "pdftotext",
      args: ["-layout", path, "-"],
      cwd: ".",
      timeoutMs: 30_000,
      signal: options.signal,
    });
    if (result.exitCode !== 0) {
      return skipped("pdf_text_sanity", {
        mode: "pdftotext",
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 2_000),
      }, "PDF text-layer extraction was unavailable.");
    }
    const text = result.stdout;
    const problems = pdfTextLayerProblems(text);
    return checkStatus("pdf_text_sanity", !problems.rawMarkupLeak && !problems.replacementGlyphLeak, {
      mode: "pdftotext",
      characters: text.length,
      rawMarkupLeak: problems.rawMarkupLeak,
      replacementGlyphLeak: problems.replacementGlyphLeak,
      matchedMarkers: problems.matchedMarkers,
    });
  } catch (error) {
    return skipped("pdf_text_sanity", {
      mode: "pdftotext",
      error: error instanceof Error ? error.message : "PDF text-layer extraction failed",
    }, "PDF text-layer extraction was unavailable.");
  }
}

function pdfTextLayerProblems(text: string): {
  rawMarkupLeak: boolean;
  replacementGlyphLeak: boolean;
  matchedMarkers: readonly string[];
} {
  const markers = new Set<string>();
  const markupMatches = text.match(/<\/?(?:super|sub)(?:\b[^>\r\n]{0,80}>)?/giu) ?? [];
  for (const marker of markupMatches.slice(0, 12)) markers.add(marker);
  const replacementMatches = text.match(/[\uFFFD\u25A0\u25A1]{2,}/gu) ?? [];
  for (const marker of replacementMatches.slice(0, 12)) markers.add(marker);
  return {
    rawMarkupLeak: markupMatches.length > 0,
    replacementGlyphLeak: replacementMatches.length > 0,
    matchedMarkers: [...markers],
  };
}

function verifyImageProfile(path: string, content: Buffer): ArtifactAcceptanceCheck[] {
  const imageType = imageSignature(content);
  const extensionMatches = /\.(?:png|jpe?g|gif|webp)$/i.test(path);
  return [
    checkStatus("format_matches_request", imageType !== undefined && extensionMatches, {
      expected: "image",
      extensionMatches,
      detectedType: imageType,
    }),
    checkStatus("artifact_openable", imageType !== undefined, { mode: "image_signature", detectedType: imageType }),
    skipped("rendered_open", {
      requiredCapability: "image_decoder",
    }, "Image dimension/render acceptance is unavailable in this runtime."),
  ];
}

function verifyJsonProfile(path: string, content: Buffer, truncated: boolean): ArtifactAcceptanceCheck[] {
  const extensionMatches = /\.json$/i.test(path);
  let parseOk = false;
  let parsedType = "unknown";
  if (!truncated) {
    try {
      const parsed = JSON.parse(content.toString("utf8")) as unknown;
      parseOk = true;
      parsedType = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
    } catch {
      parseOk = false;
    }
  }
  return [
    checkStatus("format_matches_request", extensionMatches && parseOk, {
      expected: "json",
      extensionMatches,
      parseOk,
      parsedType,
      contentTruncated: truncated,
    }),
    checkStatus("artifact_openable", parseOk, { mode: "json_parse", parsedType }),
  ];
}

function verifyMarkdownProfile(path: string, content: Buffer, truncated: boolean): ArtifactAcceptanceCheck[] {
  const extensionMatches = /\.(?:md|markdown)$/i.test(path);
  const text = content.toString("utf8");
  const hasMarkdownSignals = /^#{1,6}\s+\S/m.test(text) || /^\s*[-*+]\s+\S/m.test(text) || text.trim().length > 0;
  return [
    checkStatus("format_matches_request", extensionMatches && hasMarkdownSignals, {
      expected: "markdown",
      extensionMatches,
      hasMarkdownSignals,
      contentTruncated: truncated,
    }),
    checkStatus("artifact_openable", hasMarkdownSignals, { mode: "utf8_markdown_read", hasMarkdownSignals }),
  ];
}

function resolveArtifactKind(
  path: string,
  content: Buffer,
  artifactKind: ArtifactAcceptanceKind,
  profileId: ArtifactAcceptanceKind | undefined,
): Exclude<ArtifactAcceptanceKind, "auto"> {
  if (profileId !== undefined && profileId !== "auto") return profileId;
  if (artifactKind !== "auto") return artifactKind;
  const extension = extname(path).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".docx") return "docx";
  if (extension === ".xlsx") return "xlsx";
  if (extension === ".pptx") return "pptx";
  if (extension === ".pdf") return "pdf";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".json") return "json";
  if (imageSignature(content) !== undefined) return "image";
  return "generic_file";
}

function resolveProfileId(
  kind: Exclude<ArtifactAcceptanceKind, "auto">,
  profileId: ArtifactAcceptanceKind | undefined,
): Exclude<ArtifactAcceptanceKind, "auto"> {
  if (profileId !== undefined && profileId !== "auto") return profileId;
  return kind;
}

function evidenceKindsForChecks(
  checks: readonly ArtifactAcceptanceCheck[],
  verdict: ArtifactAcceptanceVerdict,
): ArtifactAcceptanceEvidence["evidenceKinds"] {
  const statusById = new Map(checks.map((check) => [check.id, check.status]));
  const satisfied = new Set<string>();
  const caveated = new Set<string>();
  const failed = new Set<string>();
  if (statusById.get("artifact_path") === "passed") satisfied.add("artifact_path");
  if (statusById.get("artifact_non_empty") === "passed") satisfied.add("artifact_non_empty");
  if (statusById.get("artifact_openable") === "passed") satisfied.add("artifact_openable");
  if (statusById.get("format_matches_request") === "passed") satisfied.add("format_matches_request");
  if (statusById.get("basic_navigation") === "passed") satisfied.add("basic_navigation");
  if (statusById.get("basic_navigation") === "skipped_unavailable") caveated.add("basic_navigation");
  if (statusById.get("basic_navigation") === "failed") failed.add("basic_navigation");
  if (checks.some((check) => check.status === "skipped_unavailable")) caveated.add("explicit_caveats");
  if (verdict === "rejected") failed.add("artifact_acceptance");
  else satisfied.add("artifact_acceptance");
  if (verdict === "caveated") caveated.add("artifact_acceptance");
  for (const check of checks) {
    if (check.status !== "failed") continue;
    if (check.id === "artifact_non_empty") failed.add("artifact_non_empty");
    if (check.id === "artifact_openable") failed.add("artifact_openable");
    if (check.id === "format_matches_request") failed.add("format_matches_request");
  }
  return {
    satisfied: [...satisfied].sort(),
    caveated: [...caveated].sort(),
    failed: [...failed].sort(),
  };
}

function countHtmlSlides(text: string): number {
  const tags = text.match(/<(?:section|article|div)\b[^>]*>/giu) ?? [];
  const matches = tags.filter((tag) => /\sdata-slide(?:\s|=|>)/iu.test(tag) || htmlTagHasClass(tag, "slide"));
  if (matches.length > 0) return matches.length;
  const ids = text.match(/\bid\s*=\s*["']slide[-_][^"']+["']/giu);
  return ids?.length ?? 0;
}

function htmlTagHasClass(tag: string, className: string): boolean {
  const match = /\sclass\s*=\s*(["'])(.*?)\1/isu.exec(tag);
  if (match?.[2] === undefined) return false;
  return match[2].split(/\s+/u).includes(className);
}

function htmlNavigationSignals(text: string): string[] {
  const signals: string[] = [];
  if (/<button\b[^>]*(?:next|prev|previous|上一页|下一页)/iu.test(text)) signals.push("button_controls");
  if (/(?:addEventListener\s*\(\s*["']keydown|event\.key|KeyboardEvent)/iu.test(text)) signals.push("keyboard_handler");
  if (/(?:location\.hash|hashchange|history\.pushState)/iu.test(text)) signals.push("location_or_history_navigation");
  if (/(?:data-(?:action|nav|slide)|aria-label\s*=\s*["'][^"']*(?:next|previous|prev|上一页|下一页))/iu.test(text)) {
    signals.push("semantic_navigation_attributes");
  }
  if (/(?:goToSlide|nextSlide|prevSlide|showSlide|currentSlide)/u.test(text)) signals.push("slide_navigation_functions");
  return [...new Set(signals)].sort();
}

function parseZipEntries(content: Buffer): string[] {
  const eocdOffset = findEndOfCentralDirectory(content);
  if (eocdOffset === -1 || eocdOffset + 22 > content.length) return [];
  const entryCount = content.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = content.readUInt32LE(eocdOffset + 12);
  let cursor = content.readUInt32LE(eocdOffset + 16);
  const end = Math.min(cursor + centralDirectorySize, content.length);
  const entries: string[] = [];
  for (let index = 0; index < entryCount && cursor + 46 <= end; index += 1) {
    if (content.readUInt32LE(cursor) !== 0x02014b50) break;
    const nameLength = content.readUInt16LE(cursor + 28);
    const extraLength = content.readUInt16LE(cursor + 30);
    const commentLength = content.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > content.length) break;
    entries.push(content.subarray(nameStart, nameEnd).toString("utf8"));
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries.sort();
}

function findEndOfCentralDirectory(content: Buffer): number {
  const minimumOffset = Math.max(0, content.length - 65_557);
  for (let offset = content.length - 22; offset >= minimumOffset; offset -= 1) {
    if (content.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function officeStructuralCounts(kind: "docx" | "xlsx" | "pptx", entries: readonly string[]): Record<string, number> {
  if (kind === "docx") {
    return {
      documentPartCount: entries.filter((entry) => entry === "word/document.xml").length,
      mediaCount: entries.filter((entry) => entry.startsWith("word/media/")).length,
    };
  }
  if (kind === "xlsx") {
    return {
      worksheetCount: entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry)).length,
      sharedStringPartCount: entries.filter((entry) => entry === "xl/sharedStrings.xml").length,
    };
  }
  return {
    slideCount: entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry)).length,
    mediaCount: entries.filter((entry) => entry.startsWith("ppt/media/")).length,
  };
}

function imageSignature(content: Buffer): string | undefined {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "jpeg";
  if (content.length >= 6 && (content.subarray(0, 6).toString("ascii") === "GIF87a" || content.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "gif";
  }
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  return undefined;
}

function passed(id: string, evidence: Record<string, unknown>): ArtifactAcceptanceCheck {
  return { id, status: "passed", evidence };
}

function skipped(id: string, evidence: Record<string, unknown>, diagnostics: string): ArtifactAcceptanceCheck {
  return { id, status: "skipped_unavailable", evidence, diagnostics };
}

function checkStatus(id: string, condition: boolean, evidence: Record<string, unknown>): ArtifactAcceptanceCheck {
  return { id, status: condition ? "passed" : "failed", evidence };
}

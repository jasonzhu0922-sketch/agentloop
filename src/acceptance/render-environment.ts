import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { delimiter, resolve } from "node:path";

export interface BinaryProbe {
  readonly command: string;
  readonly executablePath?: string;
  readonly version?: string;
  readonly error?: string;
}

export interface FontResolutionEvidence {
  readonly requestedFamily: string;
  readonly resolver: "fontconfig" | "unavailable";
  readonly resolved: boolean;
  readonly exactFamilyMatch: boolean;
  readonly matchedFamilies: readonly string[];
  readonly matchedFile?: string;
  readonly error?: string;
}

export interface RenderCredibility {
  readonly level: "reproducible" | "environment-limited" | "unknown";
  readonly reasons: readonly string[];
  readonly rendererIdentityRecorded: boolean;
  readonly declaredFontCount: number;
  readonly exactFontMatchCount: number;
  readonly substitutedFontCount: number;
  readonly unresolvedFontCount: number;
  readonly glyphCoverage: "not-measured";
  readonly targetViewerParity: "not-established";
  readonly automatedVisualEvidenceScope: "render-completion-and-geometry-only";
  readonly humanVisualInspection: "not-established";
}

export interface RenderEnvironmentEvidence {
  readonly schema: "agentloop.renderEnvironment/v1";
  readonly capturedAt: string;
  readonly platform: {
    readonly os: NodeJS.Platform;
    readonly arch: string;
    readonly nodeVersion: string;
    readonly lang?: string;
    readonly lcAll?: string;
  };
  readonly qaRenderTrace: string;
  readonly renderer: BinaryProbe & {
    readonly engine: "soffice" | "unoserver" | "unknown";
    readonly mode: "automated-headless";
  };
  readonly rasterizer: BinaryProbe;
  readonly fontResolver: BinaryProbe;
  readonly declaredFonts: readonly FontResolutionEvidence[];
  readonly qaManualReviewStatus: "passed" | "not-passed" | "not-reported";
  readonly credibility: RenderCredibility;
}

export async function collectRenderEnvironmentEvidence(input: {
  readonly qa: Readonly<Record<string, unknown>>;
  readonly searchPath?: string;
  readonly runtimeBinDirectory?: string;
}): Promise<RenderEnvironmentEvidence> {
  const searchPath = input.searchPath ?? process.env.PATH ?? "/usr/bin:/bin";
  const qaRenderTrace = typeof input.qa.render_stdout_tail === "string" ? input.qa.render_stdout_tail : "";
  const engine = detectRendererEngine(qaRenderTrace);
  const rendererCommand = engine === "unoserver" ? "unoconvert" : engine === "soffice" ? "soffice" : "";
  const renderer = rendererCommand.length === 0
    ? { command: "unknown", error: "QA render trace did not identify the conversion engine" }
    : await probeNamedBinary(rendererCommand, ["--version"], searchPath, input.runtimeBinDirectory);
  const rasterizer = await probeNamedBinary("pdftoppm", ["-v"], searchPath, input.runtimeBinDirectory);
  const fontResolver = await probeNamedBinary("fc-match", ["--version"], searchPath);
  const declaredFontFamilies = Array.isArray(input.qa.font_families)
    ? [...new Set(input.qa.font_families.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
    : [];
  const fontResolverPath = fontResolver.executablePath;
  const declaredFonts = await Promise.all(declaredFontFamilies.map((family) =>
    resolveFontFamily(family, fontResolverPath)
  ));
  const rendererEvidence = {
    ...renderer,
    engine,
    mode: "automated-headless" as const,
  };
  const credibility = classifyRenderEnvironmentCredibility({
    renderer: rendererEvidence,
    declaredFonts,
  });
  return {
    schema: "agentloop.renderEnvironment/v1",
    capturedAt: new Date().toISOString(),
    platform: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      ...(process.env.LANG === undefined ? {} : { lang: process.env.LANG }),
      ...(process.env.LC_ALL === undefined ? {} : { lcAll: process.env.LC_ALL }),
    },
    qaRenderTrace,
    renderer: rendererEvidence,
    rasterizer,
    fontResolver,
    declaredFonts,
    qaManualReviewStatus: input.qa.manual_review_passed === true
      ? "passed"
      : input.qa.manual_review_passed === false
        ? "not-passed"
        : "not-reported",
    credibility,
  };
}

export function classifyRenderEnvironmentCredibility(input: {
  readonly renderer: Pick<RenderEnvironmentEvidence["renderer"], "engine" | "version">;
  readonly declaredFonts: readonly FontResolutionEvidence[];
}): RenderCredibility {
  const rendererIdentityRecorded = input.renderer.engine !== "unknown"
    && typeof input.renderer.version === "string"
    && input.renderer.version.length > 0;
  const exactFontMatchCount = input.declaredFonts.filter((font) => font.exactFamilyMatch).length;
  const substitutedFontCount = input.declaredFonts.filter((font) => font.resolved && !font.exactFamilyMatch).length;
  const unresolvedFontCount = input.declaredFonts.filter((font) => !font.resolved).length;
  const reasons: string[] = [];
  if (!rendererIdentityRecorded) reasons.push("renderer-version-not-recorded");
  if (input.declaredFonts.length === 0) reasons.push("declared-fonts-not-reported");
  for (const font of input.declaredFonts) {
    if (!font.resolved) {
      reasons.push(`font-unresolved:${font.requestedFamily}`);
    } else if (!font.exactFamilyMatch) {
      reasons.push(`font-substituted:${font.requestedFamily}->${font.matchedFamilies.join(",") || "unknown"}`);
    }
  }
  reasons.push("glyph-coverage-not-measured");
  reasons.push("target-viewer-parity-not-established");
  const level = !rendererIdentityRecorded || input.declaredFonts.length === 0 || unresolvedFontCount > 0
    ? "unknown"
    : substitutedFontCount > 0
      ? "environment-limited"
      : "reproducible";
  return {
    level,
    reasons,
    rendererIdentityRecorded,
    declaredFontCount: input.declaredFonts.length,
    exactFontMatchCount,
    substitutedFontCount,
    unresolvedFontCount,
    glyphCoverage: "not-measured",
    targetViewerParity: "not-established",
    automatedVisualEvidenceScope: "render-completion-and-geometry-only",
    humanVisualInspection: "not-established",
  };
}

function detectRendererEngine(trace: string): RenderEnvironmentEvidence["renderer"]["engine"] {
  if (/via\s+soffice/i.test(trace)) return "soffice";
  if (/via\s+unoserver/i.test(trace)) return "unoserver";
  return "unknown";
}

async function resolveFontFamily(
  requestedFamily: string,
  resolverPath: string | undefined,
): Promise<FontResolutionEvidence> {
  if (resolverPath === undefined) {
    return {
      requestedFamily,
      resolver: "unavailable",
      resolved: false,
      exactFamilyMatch: false,
      matchedFamilies: [],
      error: "fc-match is unavailable",
    };
  }
  const probe = await execute(resolverPath, ["-f", "%{family}\t%{file}\n", requestedFamily]);
  if (probe.exitCode !== 0) {
    return {
      requestedFamily,
      resolver: "fontconfig",
      resolved: false,
      exactFamilyMatch: false,
      matchedFamilies: [],
      error: probe.error ?? `fc-match exited with ${probe.exitCode}`,
    };
  }
  const [familiesRaw = "", matchedFile = ""] = probe.output.split(/\r?\n/, 1)[0].split("\t", 2);
  const matchedFamilies = familiesRaw.split(",").map((item) => item.trim()).filter(Boolean);
  const requested = normalizeFamily(requestedFamily);
  return {
    requestedFamily,
    resolver: "fontconfig",
    resolved: matchedFile.length > 0,
    exactFamilyMatch: matchedFamilies.some((family) => normalizeFamily(family) === requested),
    matchedFamilies,
    ...(matchedFile.length === 0 ? {} : { matchedFile }),
    ...(matchedFile.length > 0 ? {} : { error: "fc-match returned no font file" }),
  };
}

async function probeNamedBinary(
  command: string,
  versionArguments: readonly string[],
  searchPath: string,
  preferredDirectory?: string,
): Promise<BinaryProbe> {
  const executablePath = await findExecutable(command, searchPath, preferredDirectory);
  if (executablePath === undefined) return { command, error: `${command} is unavailable` };
  const probe = await execute(executablePath, versionArguments);
  if (probe.exitCode !== 0) {
    return { command, executablePath, error: probe.error ?? `${command} version probe failed` };
  }
  return {
    command,
    executablePath,
    version: probe.output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "",
  };
}

async function findExecutable(
  command: string,
  searchPath: string,
  preferredDirectory?: string,
): Promise<string | undefined> {
  const directories = [preferredDirectory, ...searchPath.split(delimiter)].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  for (const directory of directories) {
    const candidate = resolve(directory, command);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return await fs.realpath(candidate);
    } catch {
      // Continue through the explicit search path without invoking a shell.
    }
  }
  return undefined;
}

async function execute(
  executablePath: string,
  args: readonly string[],
): Promise<{ exitCode: number; output: string; error?: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      executablePath,
      [...args],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        if (error === null) {
          resolvePromise({ exitCode: 0, output });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : 1;
        resolvePromise({ exitCode, output, error: error.message });
      },
    );
  });
}

function normalizeFamily(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replaceAll(/\s+/g, " ");
}

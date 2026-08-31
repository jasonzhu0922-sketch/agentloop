import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArtifactAcceptanceCheck } from "./artifact-acceptance.ts";
import type {
  ArtifactAcceptanceProvider,
  ArtifactAcceptanceProviderQuery,
  ArtifactAcceptanceProviderRequest,
  ArtifactAcceptanceProviderResult,
} from "./artifact-acceptance-provider.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
const HTML_PROFILE_IDS = new Set(["html", "html_ppt"]);
const PLAYWRIGHT_CHECK_IDS = new Set(["rendered_open", "basic_navigation", "rendered_interaction"]);

export interface PlaywrightArtifactAcceptanceProviderOptions {
  readonly id?: string;
  readonly timeoutMs?: number;
  readonly executablePath?: string;
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
  };
  readonly outputDirectory?: string;
  readonly moduleLoader?: () => Promise<PlaywrightLikeModule>;
}

export function createPlaywrightArtifactAcceptanceProvider(
  options: PlaywrightArtifactAcceptanceProviderOptions = {},
): ArtifactAcceptanceProvider {
  return new PlaywrightArtifactAcceptanceProvider(options);
}

class PlaywrightArtifactAcceptanceProvider implements ArtifactAcceptanceProvider {
  readonly id: string;
  private readonly timeoutMs: number;
  private readonly executablePath: string | undefined;
  private readonly viewport: { readonly width: number; readonly height: number };
  private readonly outputDirectory: string;
  private readonly moduleLoader: () => Promise<PlaywrightLikeModule>;

  constructor(options: PlaywrightArtifactAcceptanceProviderOptions) {
    this.id = options.id ?? "playwright";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.executablePath = options.executablePath;
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.outputDirectory = options.outputDirectory ?? ".agentloop/acceptance-artifacts";
    this.moduleLoader = options.moduleLoader ?? loadPlaywright;
  }

  supports(query: ArtifactAcceptanceProviderQuery): boolean {
    if (!HTML_PROFILE_IDS.has(query.profileId)) return false;
    if (query.requestedChecks.length === 0) return true;
    return query.requestedChecks.some((check) => PLAYWRIGHT_CHECK_IDS.has(check));
  }

  async verify(request: ArtifactAcceptanceProviderRequest): Promise<ArtifactAcceptanceProviderResult> {
    throwIfAborted(request.signal);
    const playwright = await this.loadRuntime(request);
    if ("checks" in playwright) return playwright;
    if (playwright.chromium === undefined) {
      return {
        providerId: this.id,
        checks: [],
        diagnostics: ["Playwright runtime does not expose chromium"],
      };
    }
    const browser = await playwright.chromium.launch({
      headless: true,
      timeout: this.timeoutMs,
      ...(this.executablePath === undefined ? {} : { executablePath: this.executablePath }),
    });
    try {
      const page = await browser.newPage({ viewport: this.viewport });
      const diagnostics: string[] = [];
      page.on?.("pageerror", (error: Error) => diagnostics.push(`pageerror: ${error.message}`));
      page.on?.("console", (message: { type: () => string; text: () => string }) => {
        if (message.type() === "error") diagnostics.push(`console.error: ${message.text()}`);
      });

      const artifactFile = resolve(request.workspaceRoot, request.artifact.path);
      await page.goto(pathToFileURL(artifactFile).href, { waitUntil: "load", timeout: this.timeoutMs });
      await page.waitForLoadState?.("networkidle", { timeout: Math.min(this.timeoutMs, 1_000) }).catch(() => undefined);
      throwIfAborted(request.signal);

      const before = await captureRenderedState(page);
      const screenshot = await this.writeScreenshot(request, page);
      const checks: ArtifactAcceptanceCheck[] = [];
      const renderedOpen = before.bodyWidth > 0 && before.bodyHeight > 0;

      if (request.profileId === "html") {
        checks.push(checkStatus("rendered_open", renderedOpen, {
          mode: "playwright_chromium",
          viewport: this.viewport,
          state: before,
          screenshotPath: screenshot.path,
          screenshotSha256: screenshot.sha256,
          diagnostics,
        }));
      } else {
        const navigation = await verifyBasicNavigation(page, request.signal);
        checks.push(
          checkStatus("basic_navigation", navigation.changed, {
            mode: "playwright_chromium",
            viewport: this.viewport,
            method: navigation.method,
            before: navigation.before,
            after: navigation.after,
            diagnostics,
          }),
          checkStatus("rendered_interaction", renderedOpen && navigation.changed, {
            mode: "playwright_chromium",
            viewport: this.viewport,
            renderedOpen,
            navigationChanged: navigation.changed,
            screenshotPath: screenshot.path,
            screenshotSha256: screenshot.sha256,
            diagnostics,
          }),
        );
      }

      return {
        providerId: this.id,
        checks,
        diagnostics,
        artifacts: [{
          kind: "screenshot",
          path: screenshot.path,
          sha256: screenshot.sha256,
          bytes: screenshot.bytes,
        }],
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async loadRuntime(request: ArtifactAcceptanceProviderRequest): Promise<PlaywrightLikeModule | ArtifactAcceptanceProviderResult> {
    try {
      const playwright = await this.moduleLoader();
      if (playwright.chromium === undefined) {
        return unavailableResult(this.id, request.profileId, "Playwright chromium launcher is unavailable.");
      }
      return playwright;
    } catch (error) {
      return unavailableResult(this.id, request.profileId, error instanceof Error ? error.message : "Playwright is unavailable.");
    }
  }

  private async writeScreenshot(
    request: ArtifactAcceptanceProviderRequest,
    page: PlaywrightLikePage,
  ): Promise<{ path: string; sha256: string; bytes: number }> {
    const directory = resolve(request.workspaceRoot, this.outputDirectory);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${request.profileId}-${request.artifact.sha256.slice(0, 16)}.png`);
    const screenshot = await page.screenshot({ path, fullPage: true });
    const buffer = Buffer.isBuffer(screenshot) ? screenshot : await readScreenshotFromPath(path);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const relativePath = toWorkspaceRelativePath(request.workspaceRoot, path);
    return { path: relativePath, sha256, bytes: buffer.length };
  }
}

async function loadPlaywright(): Promise<PlaywrightLikeModule> {
  // Playwright is an optional runtime peer; the indirect specifier keeps the
  // kernel build free of a hard dependency while resolving it at run time.
  const specifier = "play" + "wright";
  return await import(specifier) as PlaywrightLikeModule;
}

async function verifyBasicNavigation(
  page: PlaywrightLikePage,
  signal: AbortSignal | undefined,
): Promise<{
  readonly changed: boolean;
  readonly method: string;
  readonly before: RenderedPageState;
  readonly after: RenderedPageState;
}> {
  const before = await captureRenderedState(page);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  throwIfAborted(signal);
  let after = await captureRenderedState(page);
  if (renderedStateChanged(before, after)) return { changed: true, method: "keyboard:ArrowRight", before, after };

  const clicked = await page.evaluate(clickNextControl);
  if (clicked !== undefined) {
    await page.waitForTimeout(150);
    throwIfAborted(signal);
    after = await captureRenderedState(page);
    if (renderedStateChanged(before, after)) return { changed: true, method: `click:${clicked}`, before, after };
  }
  return { changed: false, method: clicked === undefined ? "keyboard:ArrowRight,no-next-control" : `keyboard:ArrowRight,click:${clicked}`, before, after };
}

async function captureRenderedState(page: PlaywrightLikePage): Promise<RenderedPageState> {
  return await page.evaluate(() => {
    function visibleSignature(element: Element, index: number): RenderedVisibleElement | undefined {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      const visible = style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0
        && htmlElement.getAttribute("aria-hidden") !== "true";
      if (!visible) return undefined;
      return {
        index,
        id: htmlElement.id,
        className: String(htmlElement.className || ""),
        text: (htmlElement.innerText || htmlElement.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }
    const candidates = [...document.querySelectorAll("[data-slide], .slide, section, article")];
    return {
      url: location.href,
      hash: location.hash,
      title: document.title,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      bodyWidth: Math.round(document.body?.getBoundingClientRect().width ?? 0),
      bodyHeight: Math.round(document.body?.getBoundingClientRect().height ?? 0),
      visible: candidates.map(visibleSignature).filter((item): item is RenderedVisibleElement => item !== undefined).slice(0, 20),
    };
  });
}

function clickNextControl(): string | undefined {
  const controls = [...document.querySelectorAll("button,a,[role='button'],[data-action],[data-nav],[aria-label]")];
  for (const element of controls) {
    const htmlElement = element as HTMLElement;
    const descriptor = [
      htmlElement.innerText,
      htmlElement.textContent,
      htmlElement.id,
      htmlElement.className,
      htmlElement.getAttribute("aria-label"),
      htmlElement.getAttribute("title"),
      htmlElement.getAttribute("data-action"),
      htmlElement.getAttribute("data-nav"),
    ].filter(Boolean).join(" ");
    if (!/(?:next|forward|right|arrow|下一|后一页|后页)/iu.test(descriptor)) continue;
    htmlElement.click();
    return descriptor.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return undefined;
}

function renderedStateChanged(before: RenderedPageState, after: RenderedPageState): boolean {
  if (before.hash !== after.hash) return true;
  if (before.scrollX !== after.scrollX || before.scrollY !== after.scrollY) return true;
  return visibleStateSignature(before) !== visibleStateSignature(after);
}

function visibleStateSignature(state: RenderedPageState): string {
  return state.visible.map((item) => [
    item.index,
    item.id,
    item.className,
    item.text,
    item.x,
    item.y,
    item.width,
    item.height,
  ].join(":")).join("|");
}

function unavailableResult(
  providerId: string,
  profileId: ArtifactAcceptanceProviderRequest["profileId"],
  diagnostics: string,
): ArtifactAcceptanceProviderResult {
  const ids = profileId === "html" ? ["rendered_open"] : ["basic_navigation", "rendered_interaction"];
  return {
    providerId,
    checks: ids.map((id) => ({
      id,
      status: "skipped_unavailable",
      evidence: {
        providerId,
        requiredCapability: "playwright_chromium",
      },
      diagnostics,
    })),
    diagnostics: [diagnostics],
  };
}

function checkStatus(id: string, condition: boolean, evidence: Record<string, unknown>): ArtifactAcceptanceCheck {
  return {
    id,
    status: condition ? "passed" : "failed",
    evidence,
    ...(condition ? {} : { diagnostics: `${id} failed during Playwright-rendered artifact acceptance.` }),
  };
}

async function readScreenshotFromPath(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (info.size === 0) return Buffer.alloc(0);
  const { readFile } = await import("node:fs/promises");
  return await readFile(path);
}

function toWorkspaceRelativePath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).split(sep).join("/");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Artifact acceptance was aborted.");
}

interface PlaywrightLikeModule {
  readonly chromium?: PlaywrightLikeChromium;
}

interface PlaywrightLikeChromium {
  launch(options: { readonly headless: true; readonly timeout: number }): Promise<PlaywrightLikeBrowser>;
}

interface PlaywrightLikeBrowser {
  newPage(options: { readonly viewport: { readonly width: number; readonly height: number } }): Promise<PlaywrightLikePage>;
  close(): Promise<void>;
}

interface PlaywrightLikePage {
  goto(url: string, options: { readonly waitUntil: "load"; readonly timeout: number }): Promise<unknown>;
  waitForLoadState?(state: "networkidle", options: { readonly timeout: number }): Promise<unknown>;
  waitForTimeout(timeoutMs: number): Promise<void>;
  screenshot(options: { readonly path: string; readonly fullPage: true }): Promise<Buffer | Uint8Array>;
  evaluate<T>(fn: () => T): Promise<T>;
  on?(event: "pageerror", listener: (error: Error) => void): void;
  on?(event: "console", listener: (message: { type: () => string; text: () => string }) => void): void;
  readonly keyboard: {
    press(key: string): Promise<void>;
  };
}

interface RenderedPageState {
  readonly url: string;
  readonly hash: string;
  readonly title: string;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  readonly visible: readonly RenderedVisibleElement[];
}

interface RenderedVisibleElement {
  readonly index: number;
  readonly id: string;
  readonly className: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

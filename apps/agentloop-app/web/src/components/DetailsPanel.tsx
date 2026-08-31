import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { artifactPreviewMode, prioritizedArtifacts, usesBlobPreview } from "../lib/artifact-preview";
import {
  commandActivities,
  commandLine,
  commandStatusLabel,
  commandSummary,
  formatDuration,
  fullCommandLine,
  type CommandActivity,
} from "../lib/command-activity";
import { executionCapabilities, type ExecutedToolStatus } from "../lib/execution-capabilities";
import { fmtBytes, fmtTime, statusLabel } from "../lib/format";
import { useAgentLoop } from "../state/context";
import type {
  ArtifactPreview,
  CommandOutputContent,
  ProcessArtifact,
  PptxPreviewElement,
  PptxPreviewTextRun,
  ToolArgumentsContent,
} from "../lib/types";
import { Markdown } from "./Markdown";

interface PreviewState {
  readonly artifact: ProcessArtifact;
  readonly runId: string;
  readonly url?: string;
  readonly preview?: ArtifactPreview;
  readonly loading: boolean;
  readonly error?: string;
}

interface ArtifactPreviewRequest {
  readonly runId: string;
  readonly artifactId: string;
  readonly requestId?: number;
}

async function artifactBlobUrl(
  token: string,
  runId: string,
  artifact: ProcessArtifact,
): Promise<string> {
  const blob = await api.runArtifactBytes(token, runId, artifact.id);
  return URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: artifact.mimeType }));
}

async function downloadArtifact(token: string, runId: string, artifact: ProcessArtifact): Promise<void> {
  const url = await artifactBlobUrl(token, runId, artifact);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function PreviewDialog({
  state,
  onClose,
}: {
  readonly state: PreviewState | null;
  readonly onClose: () => void;
}): React.ReactNode {
  const { state: appState, actions } = useAgentLoop();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (state === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  useEffect(() => {
    setMaximized(false);
  }, [state?.artifact.id]);

  if (state === null) return null;
  const { artifact, runId, loading, preview, url, error } = state;
  const canDownload = !loading;
  const mode = artifactPreviewMode(artifact);
  const bodyClass = mode === "html" || mode === "pdf" ? "preview-body frame-body" : "preview-body";
  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="产物预览">
      <div className={maximized ? "preview-dialog maximized" : "preview-dialog"}>
        <div className="preview-head">
          <div className="preview-title">
            <strong>{artifact.name}</strong>
            <span>{fmtBytes(artifact.bytes)} · {artifact.mimeType}</span>
          </div>
          <div className="preview-actions">
            <button
              type="button"
              className="artifact-open"
              disabled={!canDownload}
              onClick={() => {
                void downloadArtifact(appState.token, runId, artifact).catch((downloadError) => {
                  actions.note(downloadError instanceof Error ? downloadError.message : "无法下载产物");
                });
              }}
            >
              下载
            </button>
            <button
              type="button"
              className="preview-maximize"
              onClick={() => setMaximized((value) => !value)}
              aria-label={maximized ? "还原预览" : "最大化预览"}
              aria-pressed={maximized}
              title={maximized ? "还原" : "最大化"}
            >
              {maximized ? "↙" : "⛶"}
            </button>
            <button type="button" className="preview-close" onClick={onClose} aria-label="关闭预览">
              ×
            </button>
          </div>
        </div>
        <div className={bodyClass}>
          {loading ? <div className="preview-empty">正在载入预览…</div> : null}
          {!loading && error ? <div className="preview-empty error">{error}</div> : null}
          {!loading && !error ? <PreviewContent artifact={artifact} preview={preview} url={url} /> : null}
        </div>
      </div>
    </div>
  );
}

function artifactRunId(artifact: ProcessArtifact, fallbackRunId: string): string {
  return artifact.runId ?? fallbackRunId;
}

function PreviewContent({
  artifact,
  preview,
  url,
}: {
  readonly artifact: ProcessArtifact;
  readonly preview?: ArtifactPreview;
  readonly url?: string;
}): React.ReactNode {
  const mode = artifactPreviewMode(artifact);
  if (url && mode === "html") {
    return (
      <iframe
        className="preview-frame preview-html"
        src={url}
        title={artifact.name}
        sandbox="allow-scripts allow-forms allow-popups"
      />
    );
  }
  if (url && mode === "image") return <img className="preview-image" src={url} alt={artifact.name} />;
  if (url && mode === "pdf") return <object className="preview-frame" data={url} type="application/pdf" />;
  if (preview?.kind === "text") {
    const isMarkdown = /markdown/.test(preview.mimeType) || /\.md$/i.test(preview.name);
    return (
      <div className="preview-text md">
        {isMarkdown ? <Markdown text={preview.text} /> : <pre>{preview.text}</pre>}
        {preview.truncated ? <p className="muted">预览已截断，请下载查看完整文件。</p> : null}
      </div>
    );
  }
  if (preview?.kind === "docx") {
    return (
      <div className="preview-doc">
        {preview.paragraphs.length > 0
          ? preview.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
          : <p className="muted">该 DOCX 没有可抽取的正文段落。</p>}
        {preview.truncated ? <p className="muted">预览已截断，请下载查看完整文件。</p> : null}
      </div>
    );
  }
  if (preview?.kind === "xlsx") {
    return (
      <div className="preview-sheets">
        {preview.sheets.length > 0
          ? preview.sheets.map((sheet) => (
            <section className="preview-sheet" key={sheet.name}>
              <h4>{sheet.name}</h4>
              <div className="preview-table-wrap">
                <table className="preview-table">
                  <tbody>
                    {sheet.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sheet.truncated ? <p className="muted">该工作表只显示前 80 行。</p> : null}
            </section>
          ))
          : <p className="muted">该 XLSX 没有可抽取的工作表内容。</p>}
      </div>
    );
  }
  if (preview?.kind === "pptx") {
    return <PptxGraphicPreview preview={preview} />;
  }
  return <div className="preview-empty">该文件类型暂不能内嵌展示，请下载查看完整文件。</div>;
}

type PptxPreview = Extract<ArtifactPreview, { kind: "pptx" }>;

const EMU_PER_POINT = 12_700;

export function PptxGraphicPreview({ preview }: { readonly preview: PptxPreview }): React.ReactNode {
  const viewWidth = preview.width / EMU_PER_POINT;
  const viewHeight = preview.height / EMU_PER_POINT;
  return (
    <div className="preview-slides">
      {preview.slides.length > 0
        ? preview.slides.map((slide) => {
          const elements = slide.elements.length > 0
            ? slide.elements
            : fallbackPptxElements(slide.paragraphs, preview.width, preview.height);
          return (
            <section className="preview-slide" key={slide.index}>
              <div className="preview-slide-number">Slide {slide.index}</div>
              <svg
                className="preview-slide-canvas"
                viewBox={`0 0 ${viewWidth} ${viewHeight}`}
                role="img"
                aria-label={`Slide ${slide.index}`}
              >
                <rect x="0" y="0" width={viewWidth} height={viewHeight} rx="0" fill={slide.background ?? "#fff"} />
                {elements.map((element, index) => (
                  <PptxElement key={index} element={element} />
                ))}
              </svg>
            </section>
          );
        })
        : <p className="muted">该 PPTX 没有可抽取的幻灯片文本。</p>}
      {preview.truncated ? <p className="muted">预览已截断，请下载查看完整文件。</p> : null}
    </div>
  );
}

function fallbackPptxElements(
  paragraphs: readonly string[],
  width: number,
  height: number,
): readonly PptxPreviewElement[] {
  if (paragraphs.length === 0) return [];
  return [{
    kind: "text",
    x: width * 0.08,
    y: height * 0.1,
    width: width * 0.84,
    height: height * 0.8,
    text: paragraphs.join("\n"),
    fontSize: 20,
    color: "#1f2937",
  }];
}

function pptxToSvgUnits(value: number): number {
  return value / EMU_PER_POINT;
}

function PptxElement({ element }: { readonly element: PptxPreviewElement }): React.ReactNode {
  const x = pptxToSvgUnits(element.x);
  const y = pptxToSvgUnits(element.y);
  const width = pptxToSvgUnits(element.width);
  const height = pptxToSvgUnits(element.height);
  if (element.kind === "shape") {
    const shapeProps = {
      fill: element.fill,
      opacity: element.opacity,
      stroke: element.stroke,
      strokeWidth: element.strokeWidth === undefined ? undefined : pptxToSvgUnits(element.strokeWidth),
    };
    if (element.preset === "ellipse") {
      return (
        <ellipse
          cx={x + width / 2}
          cy={y + height / 2}
          rx={width / 2}
          ry={height / 2}
          {...shapeProps}
        />
      );
    }
    if (element.preset === "chevron") {
      return <polygon points={chevronPoints(x, y, width, height)} {...shapeProps} />;
    }
    if (element.preset === "parallelogram") {
      return <polygon points={parallelogramPoints(x, y, width, height)} {...shapeProps} />;
    }
    return <rect x={x} y={y} width={width} height={height} {...shapeProps} />;
  }
  const fontSize = Math.max(8, element.fontSize ?? 18);
  const lineHeight = fontSize * 1.22;
  const padding = Math.max(fontSize * 0.12, 1.5);
  const maxLines = Math.max(1, Math.floor((height - padding * 2) / lineHeight));
  const lines = textRunsForElement(element);
  const visibleLines = lines.slice(0, maxLines);
  return (
    <g>
      {element.fill === undefined ? null : (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          fill={element.fill}
        />
      )}
      <text
        x={x + padding}
        y={y + padding + fontSize}
        fill={element.color ?? "#1f2937"}
        fontFamily="Inter, system-ui, sans-serif"
        fontSize={fontSize}
        xmlSpace="preserve"
      >
        {visibleLines.flatMap((line, lineIndex) =>
          line.map((run, runIndex) => {
            const firstRunInLine = runIndex === 0;
            return (
              <tspan
                key={`${lineIndex}-${runIndex}`}
                {...(firstRunInLine ? { x: x + padding, dy: lineIndex === 0 ? 0 : lineHeight } : {})}
                fill={run.color ?? element.color ?? "#1f2937"}
                fontSize={Math.max(8, run.fontSize ?? fontSize)}
              >
                {run.text}
              </tspan>
            );
          })
        )}
      </text>
    </g>
  );
}

function textRunsForElement(element: Extract<PptxPreviewElement, { kind: "text" }>): readonly (readonly PptxPreviewTextRun[])[] {
  if (element.lines !== undefined && element.lines.length > 0) return element.lines;
  return element.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => [{ text: line, fontSize: element.fontSize, color: element.color }]);
}

function chevronPoints(x: number, y: number, width: number, height: number): string {
  const notch = width * 0.22;
  const point = width * 0.82;
  return [
    [x, y],
    [x + point, y],
    [x + width, y + height / 2],
    [x + point, y + height],
    [x, y + height],
    [x + notch, y + height / 2],
  ].map(([px, py]) => `${px},${py}`).join(" ");
}

function parallelogramPoints(x: number, y: number, width: number, height: number): string {
  const skew = width * 0.16;
  return [
    [x + skew, y],
    [x + width, y],
    [x + width - skew, y + height],
    [x, y + height],
  ].map(([px, py]) => `${px},${py}`).join(" ");
}

export function ArtifactList({
  artifacts,
  runId,
  previewRequest,
}: {
  readonly artifacts: readonly ProcessArtifact[];
  readonly runId: string;
  readonly previewRequest?: ArtifactPreviewRequest | null;
}): React.ReactNode {
  const { state } = useAgentLoop();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const openPreview = useCallback((artifact: ProcessArtifact): void => {
    const owningRunId = artifactRunId(artifact, runId);
    setPreview((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return { artifact, runId: owningRunId, loading: true };
    });
    void (async () => {
      if (usesBlobPreview(artifact)) {
        const url = await artifactBlobUrl(state.token, owningRunId, artifact);
        setPreview({ artifact, runId: owningRunId, url, loading: false });
        return;
      }
      const body = await api.runArtifactPreview(state.token, owningRunId, artifact.id);
      setPreview({ artifact, runId: owningRunId, preview: body.preview, loading: false });
    })().catch((error) => {
      setPreview({
        artifact,
        runId: owningRunId,
        loading: false,
        error: error instanceof Error ? error.message : "无法生成预览",
      });
    });
  }, [runId, state.token]);
  const closePreview = (): void => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };
  useEffect(() => {
    if (previewRequest === undefined || previewRequest === null) return;
    const artifact = artifacts.find((item) =>
      item.id === previewRequest.artifactId && artifactRunId(item, runId) === previewRequest.runId
    );
    if (artifact) openPreview(artifact);
  }, [artifacts, openPreview, previewRequest, runId]);
  if (artifacts.length === 0) return <p className="muted">暂无可展示的产物。</p>;
  return (
    <>
      <div className="artifact-list">
        {artifacts.map((artifact, index) => (
          <div className="artifact-row" key={`${artifact.id}-${index}`}>
            <div className="artifact-main">
              <span className="artifact-name" title={artifact.path}>
                {artifact.name}
              </span>
              <span className="artifact-meta">
                {fmtBytes(artifact.bytes)} · {artifactSourceLabel(artifact.sourceTool)}
              </span>
            </div>
            <button type="button" className="artifact-open" onClick={() => openPreview(artifact)}>
              预览
            </button>
          </div>
        ))}
      </div>
      <PreviewDialog state={preview} onClose={closePreview} />
    </>
  );
}

export function ArtifactLinks({
  artifacts,
  runId,
  output,
}: {
  readonly artifacts: readonly ProcessArtifact[];
  readonly runId: string;
  readonly output?: string;
}): React.ReactNode {
  if (artifacts.length === 0) return null;
  const ordered = prioritizedArtifacts(artifacts, output ?? "");
  return (
    <div className="artifact-links" aria-label="本轮产物">
      {ordered.slice(0, 4).map((artifact, index) => (
        <button
          type="button"
          className="artifact-chip"
          title={artifact.path}
          key={`${artifact.id}-${index}`}
          onClick={() => window.dispatchEvent(new CustomEvent("agentloop:preview-artifact", {
            detail: { runId: artifactRunId(artifact, runId), artifactId: artifact.id },
          }))}
        >
          预览 {artifact.name}
        </button>
      ))}
      {ordered.length > 4 ? <span className="artifact-more">+{ordered.length - 4}</span> : null}
    </div>
  );
}

function artifactSourceLabel(sourceTool: ProcessArtifact["sourceTool"]): string {
  if (sourceTool === "computer_write_file") return "文件写入";
  if (sourceTool === "materialize_paginated_html") return "页面生成";
  return "命令输出";
}

function CommandActivityList({
  commands,
  onOpenDetails,
  compact,
}: {
  readonly commands: readonly CommandActivity[];
  readonly onOpenDetails: (command: CommandActivity) => void;
  readonly compact: boolean;
}): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [commands.length, compact]);
  if (commands.length === 0) return <p className="muted">本轮尚未执行命令。</p>;
  const collapsed = compact && !expanded && commands.length > 1;
  const shown = collapsed ? commands.slice(-1) : commands.slice(-8).reverse();
  const hidden = commands.length - shown.length;
  return (
    <div className="command-list">
      {hidden > 0 ? (
        <div className="command-more">
          {collapsed ? `已收起 ${hidden} 次命令调用` : `更早还有 ${hidden} 次命令调用`}
          {compact ? (
            <button type="button" className="command-toggle" onClick={() => setExpanded((value) => !value)}>
              {collapsed ? "展开" : "收起"}
            </button>
          ) : null}
        </div>
      ) : compact && expanded ? (
        <div className="command-more">
          <button type="button" className="command-toggle" onClick={() => setExpanded(false)}>
            收起
          </button>
        </div>
      ) : null}
      {shown.map((command) => (
        <details className={"command-card " + command.status} key={command.toolCallId} open={command.status === "running"}>
          <summary>
            <span className={"command-state " + command.status}>{commandStatusLabel(command.status)}</span>
            <span className="command-title">{commandLine(command)}</span>
          </summary>
          <dl className="command-meta">
            <dt>step</dt>
            <dd>{command.step ?? "-"}</dd>
            <dt>cwd</dt>
            <dd>{command.cwd ?? "."}</dd>
            <dt>timeout</dt>
            <dd>{command.timeoutMs === undefined ? "-" : formatDuration(command.timeoutMs)}</dd>
            <dt>duration</dt>
            <dd>{formatDuration(command.durationMs) || "-"}</dd>
            <dt>call</dt>
            <dd>{command.toolCallId}</dd>
          </dl>
          <div className="command-summary">{commandSummary(command)}</div>
          <button type="button" className="command-detail-button" onClick={() => onOpenDetails(command)}>
            查看完整详情
          </button>
          {command.stdout ? <pre className="command-output">{command.stdout}</pre> : null}
          {command.stderr ? <pre className="command-output error">{command.stderr}</pre> : null}
        </details>
      ))}
    </div>
  );
}

interface LoadedCommandOutput {
  readonly loading: boolean;
  readonly output?: CommandOutputContent;
  readonly error?: string;
}

interface LoadedToolArguments {
  readonly loading: boolean;
  readonly value?: ToolArgumentsContent;
  readonly error?: string;
}

function CommandDetailDialog({
  runId,
  command,
  onClose,
}: {
  readonly runId: string;
  readonly command: CommandActivity | null;
  readonly onClose: () => void;
}): React.ReactNode {
  const { state, actions } = useAgentLoop();
  const [stdout, setStdout] = useState<LoadedCommandOutput>({ loading: false });
  const [stderr, setStderr] = useState<LoadedCommandOutput>({ loading: false });
  const [toolArguments, setToolArguments] = useState<LoadedToolArguments>({ loading: false });

  useEffect(() => {
    if (command === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [command, onClose]);

  useEffect(() => {
    if (command === null) {
      setStdout({ loading: false });
      setStderr({ loading: false });
      setToolArguments({ loading: false });
      return;
    }
    let cancelled = false;
    if (command.argumentsRef !== undefined) {
      setToolArguments({ loading: true });
      void api.runToolArguments(state.token, runId, command.toolCallId)
        .then(({ arguments: value }) => {
          if (!cancelled) setToolArguments({ loading: false, value });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "无法读取完整调用参数";
          if (!cancelled) setToolArguments({ loading: false, error: message });
          actions.note(message);
        });
    } else {
      setToolArguments({ loading: false });
    }
    const load = (stream: "stdout" | "stderr", setter: (value: LoadedCommandOutput) => void) => {
      const ref = stream === "stdout" ? command.stdoutRef : command.stderrRef;
      const inline = stream === "stdout" ? command.stdout : command.stderr;
      if (ref === undefined && inline === undefined) {
        setter({ loading: false });
        return;
      }
      setter({ loading: true });
      void api.runCommandOutput(state.token, runId, command.toolCallId, stream)
        .then(({ output }) => {
          if (!cancelled) setter({ loading: false, output });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "无法读取完整命令输出";
          if (!cancelled) setter({ loading: false, error: message });
          actions.note(message);
        });
    };
    load("stdout", setStdout);
    load("stderr", setStderr);
    return () => {
      cancelled = true;
    };
  }, [actions, command, runId, state.token]);

  if (command === null) return null;
  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="命令完整详情">
      <div className="preview-dialog maximized command-detail-dialog">
        <div className="preview-head">
          <div className="preview-title">
            <strong>命令详情</strong>
            <span>{command.toolCallId}</span>
          </div>
          <button type="button" className="preview-close" onClick={onClose} aria-label="关闭命令详情">
            ×
          </button>
        </div>
        <div className="preview-body command-detail-body">
          <section className="command-detail-section">
            <h4>完整命令</h4>
            <pre className="command-full-output">{fullCommandLineFromArguments(command, toolArguments.value) ?? fullCommandLine(command)}</pre>
          </section>
          <section className="command-detail-section">
            <h4>调用参数</h4>
            {toolArguments.loading ? <div className="preview-empty">正在读取完整调用参数…</div> : null}
            {!toolArguments.loading && toolArguments.error ? <div className="preview-empty error">{toolArguments.error}</div> : null}
            {toolArguments.value ? <p className="command-detail-meta">{toolArgumentsMeta(toolArguments.value)}</p> : null}
            {!toolArguments.loading && !toolArguments.error ? (
              <pre className="command-full-output">
                {toolArguments.value?.content ?? JSON.stringify(commandDetails(command), null, 2)}
              </pre>
            ) : null}
          </section>
          <CommandOutputBlock title="stdout" state={stdout} inline={command.stdout} />
          <CommandOutputBlock title="stderr" state={stderr} inline={command.stderr} />
        </div>
      </div>
    </div>
  );
}

function CommandOutputBlock({
  title,
  state,
  inline,
}: {
  readonly title: "stdout" | "stderr";
  readonly state: LoadedCommandOutput;
  readonly inline?: string;
}): React.ReactNode {
  const content = state.output?.content ?? inline;
  const meta = state.output === undefined
    ? ""
    : [
        state.output.path,
        state.output.bytes === undefined ? undefined : fmtBytes(state.output.bytes),
        state.output.characters === undefined ? undefined : `${state.output.characters} chars`,
        state.output.sha256,
      ].filter(Boolean).join(" · ");
  return (
    <section className="command-detail-section">
      <h4>{title}</h4>
      {meta ? <p className="command-detail-meta">{meta}</p> : null}
      {state.loading ? <div className="preview-empty">正在读取完整 {title}…</div> : null}
      {!state.loading && state.error ? <div className="preview-empty error">{state.error}</div> : null}
      {!state.loading && !state.error ? (
        <pre className={title === "stderr" ? "command-full-output error" : "command-full-output"}>
          {content === undefined || content === "" ? "(empty)" : content}
        </pre>
      ) : null}
    </section>
  );
}

function commandDetails(command: CommandActivity): Record<string, unknown> {
  return {
    toolCallId: command.toolCallId,
    step: command.step,
    status: command.status,
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    submittedAt: command.submittedAt,
    dispatchedAt: command.dispatchedAt,
    completedAt: command.completedAt,
    durationMs: command.durationMs,
    exitCode: command.exitCode,
    signal: command.signal,
    argumentsRef: command.argumentsRef,
    stdoutRef: command.stdoutRef,
    stderrRef: command.stderrRef,
    error: command.error,
  };
}

function toolArgumentsMeta(value: ToolArgumentsContent): string {
  return [
    value.path,
    value.bytes === undefined ? undefined : fmtBytes(value.bytes),
    value.characters === undefined ? undefined : `${value.characters} chars`,
    value.sha256,
  ].filter(Boolean).join(" · ");
}

function fullCommandLineFromArguments(command: CommandActivity, value: ToolArgumentsContent | undefined): string | undefined {
  const args = value?.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const commandName = typeof record.command === "string" ? record.command : command.command;
  const commandArgs = Array.isArray(record.args) ? record.args.map((item) => String(item)) : command.args;
  return [commandName || "?", ...commandArgs.map(shellQuote)].join(" ").trim();
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function executionToolStatusLabel(status: ExecutedToolStatus): string {
  return {
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    rejected: "被拒绝",
  }[status];
}

function ExecutionCapabilitiesList({ events }: { readonly events: Parameters<typeof executionCapabilities>[0] }): React.ReactNode {
  const capabilities = executionCapabilities(events);
  return (
    <div className="execution-capabilities">
      <div className="execution-capability-row">
        <span className="execution-capability-label">Skill</span>
        <div className="execution-capability-items">
          {capabilities.skills.length === 0 ? (
            <span className="execution-capability-empty">暂无已激活的 Skill</span>
          ) : capabilities.skills.map((name) => (
            <span className="execution-capability-chip skill" key={name}>{name}</span>
          ))}
        </div>
      </div>
      <div className="execution-capability-row">
        <span className="execution-capability-label">Tool</span>
        <div className="execution-capability-items">
          {capabilities.tools.length === 0 ? (
            <span className="execution-capability-empty">暂无已执行的 Tool</span>
          ) : capabilities.tools.map((tool) => (
            <span className="execution-capability-chip tool" key={tool.name}>
              <span>{tool.name}</span>
              <span className={"execution-tool-status " + tool.status}>{executionToolStatusLabel(tool.status)}</span>
              {tool.calls > 1 ? <span className="execution-tool-count">x{tool.calls}</span> : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ArtifactsPanel(): React.ReactNode {
  const { state, actions } = useAgentLoop();
  const [selectedCommand, setSelectedCommand] = useState<CommandActivity | null>(null);
  const [previewRequest, setPreviewRequest] = useState<ArtifactPreviewRequest | null>(null);
  const currentRunId = state.currentRun?.run.id;
  useEffect(() => {
    setSelectedCommand(null);
    setPreviewRequest((request) => request?.runId === currentRunId ? request : null);
  }, [currentRunId]);
  useEffect(() => {
    setPreviewRequest(null);
  }, [state.conversation?.conversation.id]);
  useEffect(() => {
    let requestId = 0;
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<ArtifactPreviewRequest>).detail;
      if (!detail || typeof detail.runId !== "string" || typeof detail.artifactId !== "string") return;
      const request = { runId: detail.runId, artifactId: detail.artifactId, requestId: ++requestId };
      setPreviewRequest(request);
      if (state.currentRun?.run.id !== detail.runId) {
        void actions.selectRun(detail.runId);
      }
    };
    window.addEventListener("agentloop:preview-artifact", handler);
    return () => window.removeEventListener("agentloop:preview-artifact", handler);
  }, [actions, state.currentRun?.run.id]);
  if (state.currentRun === null) {
    return (
      <aside className="details artifacts-panel">
        <div className="details-head">
          <h3>产物</h3>
        </div>
        <div className="details-empty">选择或启动一个对话后，这里会展示本轮可预览或下载的产物。</div>
      </aside>
    );
  }

  const run = state.currentRun.run;
  const artifacts = state.currentRun.artifacts;
  const commands = commandActivities(state.currentRun.events);

  return (
    <aside className="details artifacts-panel">
      <div className="details-head">
        <h3>产物</h3>
        <span className={"pill status-" + run.status}>{statusLabel(run.status)}</span>
      </div>
      <div className="details-section">
        <h4>当前任务</h4>
        <p className="muted">{run.input}</p>
        <p className="run-time">
          {fmtTime(run.createdAt)}
          {run.finishedAt ? " - " + fmtTime(run.finishedAt) : ""}
        </p>
      </div>
      <div className="details-section">
        <h4>实际使用</h4>
        <ExecutionCapabilitiesList events={state.currentRun.events} />
      </div>
      {run.output ? (
        <div className="details-section">
          <h4>最终回复</h4>
          <div className="artifact-output-preview md">
            <Markdown text={run.output} />
          </div>
        </div>
      ) : null}
      <div className="details-section">
        <h4>命令调用</h4>
        <CommandActivityList commands={commands} onOpenDetails={setSelectedCommand} compact={run.status !== "running"} />
      </div>
      <div className="details-section">
        <h4>文件产物</h4>
        <ArtifactList artifacts={artifacts} runId={run.id} previewRequest={previewRequest} />
      </div>
      <CommandDetailDialog runId={run.id} command={selectedCommand} onClose={() => setSelectedCommand(null)} />
    </aside>
  );
}

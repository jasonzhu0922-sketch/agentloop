import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtBytes, fmtTime, statusLabel, truncate } from "../lib/format";
import { useAgentLoop } from "../state/context";
import type { ArtifactPreview, ProcessArtifact } from "../lib/types";
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
}

function isBinaryPreview(artifact: ProcessArtifact): boolean {
  return /^(?:image\/|application\/pdf$)/.test(artifact.mimeType);
}

function isTextLike(artifact: ProcessArtifact): boolean {
  return /text\/(?:markdown|plain|csv|json|html)|application\/json/.test(artifact.mimeType);
}

async function artifactBlobUrl(
  token: string,
  runId: string,
  artifact: ProcessArtifact,
): Promise<string> {
  const blob = await api.runArtifactBytes(token, runId, artifact.id);
  if (isTextLike(artifact)) return URL.createObjectURL(new Blob([await blob.text()], { type: "text/plain;charset=utf-8" }));
  return URL.createObjectURL(blob);
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

  useEffect(() => {
    if (state === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  if (state === null) return null;
  const { artifact, runId, loading, preview, url, error } = state;
  const canDownload = !loading;
  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="产物预览">
      <div className="preview-dialog">
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
            <button type="button" className="preview-close" onClick={onClose} aria-label="关闭预览">
              ×
            </button>
          </div>
        </div>
        <div className="preview-body">
          {loading ? <div className="preview-empty">正在载入预览…</div> : null}
          {!loading && error ? <div className="preview-empty error">{error}</div> : null}
          {!loading && !error ? <PreviewContent artifact={artifact} preview={preview} url={url} /> : null}
        </div>
      </div>
    </div>
  );
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
  if (url && artifact.mimeType.startsWith("image/")) return <img className="preview-image" src={url} alt={artifact.name} />;
  if (url && artifact.mimeType === "application/pdf") return <object className="preview-frame" data={url} type="application/pdf" />;
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
  return <div className="preview-empty">该文件类型暂不能内嵌展示，请下载查看完整文件。</div>;
}

export function ArtifactList({
  artifacts,
  runId,
}: {
  readonly artifacts: readonly ProcessArtifact[];
  readonly runId: string;
}): React.ReactNode {
  const { state } = useAgentLoop();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const openPreview = useCallback((artifact: ProcessArtifact): void => {
    setPreview((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return { artifact, runId, loading: true };
    });
    void (async () => {
      if (isBinaryPreview(artifact)) {
        const url = await artifactBlobUrl(state.token, runId, artifact);
        setPreview({ artifact, runId, url, loading: false });
        return;
      }
      const body = await api.runArtifactPreview(state.token, runId, artifact.id);
      setPreview({ artifact, runId, preview: body.preview, loading: false });
    })().catch((error) => {
      setPreview({
        artifact,
        runId,
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
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<ArtifactPreviewRequest>).detail;
      if (!detail || detail.runId !== runId) return;
      const artifact = artifacts.find((item) => item.id === detail.artifactId);
      if (artifact) openPreview(artifact);
    };
    window.addEventListener("agentloop:preview-artifact", handler);
    return () => window.removeEventListener("agentloop:preview-artifact", handler);
  }, [artifacts, openPreview, runId]);
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
                {fmtBytes(artifact.bytes)} · {artifact.sourceTool === "computer_write_file" ? "文件写入" : "命令输出"}
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
}: {
  readonly artifacts: readonly ProcessArtifact[];
  readonly runId: string;
}): React.ReactNode {
  if (artifacts.length === 0) return null;
  return (
    <div className="artifact-links" aria-label="本轮产物">
      {artifacts.slice(0, 4).map((artifact, index) => (
        <button
          type="button"
          className="artifact-chip"
          title={artifact.path}
          key={`${artifact.id}-${index}`}
          onClick={() => window.dispatchEvent(new CustomEvent("agentloop:preview-artifact", { detail: { runId, artifactId: artifact.id } }))}
        >
          预览 {artifact.name}
        </button>
      ))}
      {artifacts.length > 4 ? <span className="artifact-more">+{artifacts.length - 4}</span> : null}
    </div>
  );
}

export function ArtifactsPanel(): React.ReactNode {
  const { state } = useAgentLoop();
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
  const outputPreview = run.output ? truncate(run.output, 220) : "";

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
      {outputPreview ? (
        <div className="details-section">
          <h4>最终回复</h4>
          <p className="artifact-output-preview">{outputPreview}</p>
        </div>
      ) : null}
      <div className="details-section">
        <h4>文件产物</h4>
        <ArtifactList artifacts={artifacts} runId={run.id} />
      </div>
    </aside>
  );
}

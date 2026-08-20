import { fmtBytes, fmtTime, stepClass, stepLabel, statusLabel } from "../lib/format";
import { api } from "../lib/api";
import { eventLabel, eventTone } from "../lib/format";
import { useAgentLoop } from "../state/context";
import type { PlanDetail, ProcessArtifact, RunEvent } from "../lib/types";

function isOpenableInline(artifact: ProcessArtifact): boolean {
  if (artifact.previewable) return true;
  return /text\/(?:markdown|plain|csv|json)|application\/json/.test(artifact.mimeType);
}

function ArtifactList({
  artifacts,
  runId,
}: {
  readonly artifacts: readonly ProcessArtifact[];
  readonly runId: string;
}): React.ReactNode {
  const { state, actions } = useAgentLoop();
  if (artifacts.length === 0) return <p className="muted">暂无可展示的过程产物。</p>;
  return (
    <div className="artifact-list">
      {artifacts.map((a) => (
        <div className="artifact-row" key={a.id}>
          <div className="artifact-main">
            <span className="artifact-name" title={a.path}>
              {a.name}
            </span>
            <span className="artifact-meta">
              {fmtBytes(a.bytes)} · {a.sourceTool === "computer_write_file" ? "写入工具" : "命令工具"}
            </span>
          </div>
          <button
            type="button"
            className="artifact-open"
            onClick={() => {
              void (async () => {
                try {
                  const blob = await api.runArtifactBytes(state.token, runId, a.id);
                  const needsUtf8 = /text\/(?:markdown|plain|csv)|application\/json/.test(a.mimeType);
                  const url = URL.createObjectURL(
                    needsUtf8 ? new Blob([await blob.text()], { type: "text/plain;charset=utf-8" }) : blob,
                  );
                  if (isOpenableInline(a)) {
                    window.open(url, "_blank", "noopener");
                    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
                  } else {
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = a.name;
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
                  }
                } catch (error) {
                  actions.note(error instanceof Error ? error.message : "无法打开过程产物");
                }
              })();
            }}
          >
            {isOpenableInline(a) ? "打开" : "下载"}
          </button>
        </div>
      ))}
    </div>
  );
}

function EventList({ events }: { readonly events: readonly RunEvent[] }): React.ReactNode {
  if (events.length === 0) return <p className="muted">暂无事件。</p>;
  return (
    <div className="event-list">
      {events.slice(-60).map((e) => (
        <div className="event" key={e.seq}>
          <span className="event-seq">{e.seq}</span>
          <span className={"event-type " + eventTone(e.type)}>{eventLabel(e)}</span>
        </div>
      ))}
    </div>
  );
}

export function DetailsPanel(): React.ReactNode {
  const { state } = useAgentLoop();
  if (state.currentRun === null) {
    return (
      <aside className="details">
        <div className="details-empty">选择一个对话后，这里会展示执行计划、评估与事件。</div>
      </aside>
    );
  }
  const r = state.currentRun.run;
  const detail: PlanDetail = state.currentRun.detail;
  const events = state.currentRun.events;
  const artifacts = state.currentRun.artifacts;
  const steps = detail.plan?.steps ?? [];

  return (
    <aside className="details">
      <div className="details-head">
        <h3>详情</h3>
        <span className={"pill status-" + r.status}>{statusLabel(r.status)}</span>
      </div>
      <div className="details-section">
        <h4>本轮任务</h4>
        <p className="muted">{r.input}</p>
      </div>
      <div className="details-section">
        <h4>元信息</h4>
        <dl className="kv">
          <dt>助手</dt>
          <dd>AgentLoop</dd>
          <dt>创建时间</dt>
          <dd>{fmtTime(r.createdAt)}</dd>
          {r.finishedAt ? (
            <>
              <dt>完成时间</dt>
              <dd>{fmtTime(r.finishedAt)}</dd>
            </>
          ) : null}
          {r.errorCode ? (
            <>
              <dt>错误码</dt>
              <dd>{r.errorCode}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="details-section">
        <h4>过程产物</h4>
        <p className="muted">这些文件来自本轮已执行工具，仅表示中间产物，不代表本轮已完成或已交付。</p>
        <ArtifactList artifacts={artifacts} runId={r.id} />
      </div>
      <div className="details-section">
        <h4>计划</h4>
        {steps.length > 0 ? (
          steps.map((s) => (
            <div className="dstep" key={s.id}>
              <span className={"step-dot " + stepClass(s.status)} />
              <b>{s.objective || s.id}</b>
              <span className="dstep-state">{stepLabel(s.status)}</span>
              {s.output ? <pre className="dstep-output">{s.output}</pre> : null}
            </div>
          ))
        ) : (
          <p className="muted">暂无计划。</p>
        )}
      </div>
      <div className="details-section">
        <h4>评估</h4>
        {detail.assessments && detail.assessments.length > 0 ? (
          detail.assessments.map((a, index) => (
            <div className={"dassess " + (a.approved ? "good" : "bad")} key={index}>
              <span>步骤 {a.stepId}</span>
              <b>{a.approved ? "通过" : "未通过"}</b>
              {a.feedback ? <p>{a.feedback}</p> : null}
            </div>
          ))
        ) : (
          <p className="muted">暂无评估记录。</p>
        )}
      </div>
      <div className="details-section">
        <h4>事件</h4>
        <EventList events={events} />
      </div>
    </aside>
  );
}
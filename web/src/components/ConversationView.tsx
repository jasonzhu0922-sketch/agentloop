import { useEffect, useId, useRef, useState } from "react";
import { useAgentLoop } from "../state/context";
import { projectConversationRun } from "../state/run-state";
import { Markdown } from "./Markdown";
import {
  failureDetails,
  failureSummary,
  latestProgressEvent,
  latestStreaming,
  livePlan,
  modelWaitText,
  progressText,
  retryText,
  streamingToolProgress,
} from "../lib/live";
import { clip, previewText, stepClass, stepLabel } from "../lib/format";
import { translatedTimeline } from "../lib/event-translator";
import type { PlanStep, ProcessArtifact, RunEvent, RunRecord } from "../lib/types";
import { ArtifactLinks } from "./DetailsPanel";

function Thinking(): React.ReactNode {
  return (
    <span className="thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

function UserMessage({ text }: { readonly text: string }): React.ReactNode {
  return (
    <article className="msg user">
      <div className="msg-body">
        <div className="msg-bubble">
          <div className="msg-role">你</div>
          <div className="msg-text">{text}</div>
        </div>
      </div>
    </article>
  );
}

function PlanStepsPanel({ id, steps }: { readonly id: string; readonly steps: readonly PlanStep[] }): React.ReactNode {
  if (steps.length === 0) return null;
  return (
    <div className="live-plan-panel" id={id} aria-label="全部规划步骤">
      <ol className="live-plan-steps">
        {steps.map((step, index) => (
          <li className="live-plan-step" key={step.id || index}>
            <span className={"step-dot " + stepClass(step.status)} />
            <div className="live-plan-step-body">
              <div className="live-plan-step-head">
                <span className="live-plan-index">{String(index + 1).padStart(2, "0")}</span>
                <strong>{step.objective || step.id}</strong>
                <span className={"live-plan-state " + stepClass(step.status)}>{stepLabel(step.status)}</span>
              </div>
              {step.dependencies?.length ? (
                <div className="live-plan-meta">依赖：{step.dependencies.join("、")}</div>
              ) : null}
              {step.requiredToolNames?.length ? (
                <div className="live-plan-meta">工具：{step.requiredToolNames.join("、")}</div>
              ) : null}
              {step.successCriteria?.length ? (
                <ul className="live-plan-criteria">
                  {step.successCriteria.map((criterion) => (
                    <li key={criterion.id || criterion.description}>{criterion.description}</li>
                  ))}
                </ul>
              ) : null}
              {step.output ? <div className="live-plan-output">{step.output}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function LiveCard({ events, steps }: { readonly events: readonly RunEvent[]; readonly steps: readonly PlanStep[] }): React.ReactNode {
  const [planOpen, setPlanOpen] = useState(false);
  const planPanelId = useId();
  const stream = latestStreaming(events);
  const content = stream?.data?.content ? String(stream.data.content) : "";
  const streamTool = streamingToolProgress(stream);
  const progressEvent = latestProgressEvent(events);
  const phaseEvent = stream?.data?.phase ? stream.data.phase : (progressEvent?.data?.phase ?? "处理中");
  const total = steps.length;
  const done = steps.filter((s) => s.status === "completed").length;
  const current = steps.find((s) => s.status === "running") ?? null;
  const plan = livePlan(events);
  const retry = retryText(events);
  const idle = streamTool || modelWaitText(events) || progressText(events, plan);
  const timeline = translatedTimeline(events, 1);
  const preview = content ? (
    <div className="live-preview">{previewText(content)}</div>
  ) : (
    <div className="live-preview idle">{idle}</div>
  );
  return (
    <article className="msg assistant live">
      <div className="msg-avatar">A</div>
      <div className="msg-body">
        <div className="live-card">
          <div className="live-head">
            <Thinking /> <span>正在{phase(phaseEvent)}</span>
            {total > 0 ? (
              <button
                type="button"
                className="live-step-toggle"
                aria-expanded={planOpen}
                aria-controls={planPanelId}
                onClick={() => setPlanOpen((open) => !open)}
              >
                步骤 {done}/{total}
                <span className="live-step-caret" aria-hidden="true">⌄</span>
              </button>
            ) : null}
          </div>
          {planOpen ? <PlanStepsPanel id={planPanelId} steps={steps} /> : null}
          {current ? <div className="live-current">{clip(current.objective || current.id, 120)}</div> : null}
          {retry ? <div className="live-retry">{retry}</div> : null}
          {preview}
          {timeline.length ? (
            <ol className="run-timeline">
              {timeline.map((event) => (
                <li className={event.tone} key={event.key}>
                  <span className="timeline-dot" />
                  <span className="timeline-copy">
                    <strong>{event.title}</strong>
                    {event.detail ? <span>{event.detail}</span> : null}
                    <code>{event.rawType}</code>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function phase(value: unknown): string {
  return (
    {
      planning: "规划中",
      execution: "执行中",
      assessment: "评估中",
      compaction: "压缩上下文",
    }[String(value)] || "处理中"
  );
}

function TurnArtifacts({
  run,
  artifacts,
  loaded,
}: {
  readonly run: RunRecord;
  readonly artifacts: readonly ProcessArtifact[];
  readonly loaded: boolean;
}): React.ReactNode {
  const { actions } = useAgentLoop();
  if (loaded) return <ArtifactLinks artifacts={artifacts} runId={run.id} />;
  return (
    <div className="turn-footer">
      <button type="button" className="text-btn" onClick={() => void actions.selectRun(run.id)}>
        查看本轮产物
      </button>
    </div>
  );
}

function FinalAnswer({
  run,
  artifacts,
  loaded,
}: {
  readonly run: RunRecord;
  readonly artifacts: readonly ProcessArtifact[];
  readonly loaded: boolean;
}): React.ReactNode {
  return (
    <article className="msg assistant">
      <div className="msg-avatar">A</div>
      <div className="msg-body">
        <div className="msg-heading done">✓ 已完成</div>
        <div className="msg-text md">
          {run.output ? <Markdown text={run.output} /> : <span className="muted">（没有产生文本输出）</span>}
        </div>
        <TurnArtifacts run={run} artifacts={artifacts} loaded={loaded} />
      </div>
    </article>
  );
}

function ErrorMessage({
  run,
  events,
  steps,
  artifacts,
  loaded,
}: {
  readonly run: RunRecord;
  readonly events: readonly RunEvent[];
  readonly steps: readonly PlanStep[];
  readonly artifacts: readonly ProcessArtifact[];
  readonly loaded: boolean;
}): React.ReactNode {
  const summary = failureSummary({
    errorCode: run.errorCode,
    status: run.status,
    events,
    steps,
    artifactCount: artifacts.length,
  });
  const diag = failureDetails(events);
  return (
    <article className="msg assistant">
      <div className="msg-avatar">A</div>
      <div className="msg-body">
        <div className="failure-card">
          <div className="msg-heading error">任务未完成</div>
          <strong className="failure-title">{summary.title}</strong>
          <p>{summary.reason}</p>
          <div className="failure-grid">
            <div>
              <span>当前进度</span>
              <p>{summary.progress}</p>
            </div>
            <div>
              <span>建议下一步</span>
              <p>{summary.nextAction}</p>
            </div>
          </div>
          <details className="failure-technical">
            <summary>技术细节</summary>
            {run.errorCode ? <div className="mono">{run.errorCode}</div> : null}
            {summary.rawMessage ? <div className="muted">{summary.rawMessage}</div> : null}
            {diag ? <div className="muted mono">{diag}</div> : null}
          </details>
        </div>
        <TurnArtifacts run={run} artifacts={artifacts} loaded={loaded} />
      </div>
    </article>
  );
}

function RunningPlaceholder(): React.ReactNode {
  return (
    <article className="msg assistant">
      <div className="msg-avatar">A</div>
      <div className="msg-body">
        <div className="msg-heading">
          <Thinking /> 运行中
        </div>
        <div className="msg-text placeholder">正在处理…</div>
      </div>
    </article>
  );
}

function EmptyConversation(): React.ReactNode {
  const { state } = useAgentLoop();
  const skill = state.skills.find((s) => s.id === state.selectedSkillId) ?? state.skills[0] ?? null;
  if (!state.skills.length) {
    return (
      <div className="empty-state">
        <div className="empty-logo">A</div>
        <h2>欢迎使用 AgentLoop</h2>
        <p className="empty-sub">服务器还没有可用的能力（Skill）。请联系管理员配置 Skill 目录后再开始。</p>
      </div>
    );
  }
  const tips = ["帮我写一份清晰的项目周报", "把这段内容整理成要点", "检查并修复这段代码的问题"];
  return (
    <div className="empty-state">
      <div className="empty-logo">A</div>
      <h2>我能帮你做什么？</h2>
      <p className="empty-sub">{skill?.description ?? ""}</p>
      <p className="empty-hint">在下方输入任务，我会先制定计划、执行，并在完成后给出可核验的结果。你可以在同一个对话里继续提出后续要求。</p>
      <div className="suggestions">
        {tips.map((t) => (
          <button
            key={t}
            type="button"
            className="suggestion"
            onClick={() => {
              // fill composer via draft: expose through a small custom event
              window.dispatchEvent(new CustomEvent("agentloop:suggest", { detail: t }));
            }}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ConversationView(): React.ReactNode {
  const { state } = useAgentLoop();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.conversation?.runs.length, state.running]);

  if (state.conversation === null) {
    return (
      <div className="messages" ref={scrollRef}>
        <EmptyConversation />
      </div>
    );
  }

  const runs = state.conversation.runs;
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < runs.length; i++) {
    const detail = state.runDetailsById[runs[i].id]
      ?? (state.currentRun?.run.id === runs[i].id ? state.currentRun : undefined);
    const projection = projectConversationRun(
      runs[i],
      detail?.run,
      state.activeRunIds,
    );
    const r = projection.run;
    const isLoaded = projection.isLoaded;
    parts.push(<UserMessage key={"u" + r.id} text={r.input} />);
    if (projection.isLive) {
      const events = isLoaded ? (detail?.events ?? []) : [];
      const plan = livePlan(events);
      const steps = plan?.steps ?? [];
      parts.push(<LiveCard key={"l" + r.id} events={events} steps={steps} />);
    } else if (r.status === "completed") {
      const artifacts = isLoaded ? (detail?.artifacts ?? []) : [];
      parts.push(<FinalAnswer key={"f" + r.id} run={r} artifacts={artifacts} loaded={isLoaded} />);
    } else if (r.status === "failed" || r.status === "cancelled") {
      const failEvents = isLoaded ? (detail?.events ?? []) : [];
      const artifacts = isLoaded ? (detail?.artifacts ?? []) : [];
      const plan = isLoaded ? livePlan(failEvents) : null;
      const steps = plan?.steps ?? (isLoaded ? (detail?.detail.plan.steps ?? []) : []);
      parts.push(<ErrorMessage key={"e" + r.id} run={r} events={failEvents} steps={steps} artifacts={artifacts} loaded={isLoaded} />);
    } else if (r.status === "running") {
      parts.push(<RunningPlaceholder key={"r" + r.id} />);
    }
  }

  return (
    <div className="messages" ref={scrollRef}>
      {parts}
    </div>
  );
}

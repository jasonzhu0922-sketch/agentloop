import { useEffect, useRef } from "react";
import { useAgentLoop } from "../state/context";
import { Markdown } from "./Markdown";
import {
  currentStep,
  currentStepWhy,
  executionInsights,
  failureDetails,
  latestProgressEvent,
  latestStreaming,
  latestTool,
  livePlan,
  modelWaitText,
  plannedMap,
  progressText,
  retryText,
  streamingToolProgress,
  stepToolPurposes,
  toolActivityItems,
  toolRowLabel,
} from "../lib/live";
import { clip, eventLabel, eventTone, previewText, stepClass, stepLabel } from "../lib/format";
import type { PlanStep, RunEvent, RunRecord } from "../lib/types";
import { ToolActivity } from "./ToolActivity";

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

function PlanCard({ steps, goal }: { readonly steps: readonly PlanStep[]; readonly goal: string }): React.ReactNode {
  return (
    <article className="msg assistant">
      <div className="msg-avatar">A</div>
      <div className="msg-body">
        <div className="plan-card">
          <div className="plan-head">
            <span className="plan-title">执行计划</span>
            <span className="plan-goal">{goal}</span>
          </div>
          <ul className="plan-steps">
            {steps.map((s) => (
              <li className="plan-step" key={s.id}>
                <span className={"step-dot " + stepClass(s.status)} />
                <span className="step-main">
                  <span className="step-obj">{s.objective || s.id}</span>
                  <span className="step-meta">
                    {(s.requiredToolNames ?? []).slice(0, 3).join(" · ")}
                    {(s.successCriteria ?? []).length ? " · " + (s.successCriteria ?? []).length + " 条验收标准" : ""}
                  </span>
                </span>
                <span className="step-state">{stepLabel(s.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

function LiveCard({ events, steps }: { readonly events: readonly RunEvent[]; readonly steps: readonly PlanStep[] }): React.ReactNode {
  const stream = latestStreaming(events);
  const content = stream?.data?.content ? String(stream.data.content) : "";
  const streamTool = streamingToolProgress(stream);
  const progressEvent = latestProgressEvent(events);
  const phaseEvent = stream?.data?.phase ? stream.data.phase : (progressEvent?.data?.phase ?? "处理中");
  const tool = latestTool(events);
  const total = steps.length;
  const done = steps.filter((s) => s.status === "completed").length;
  const current = steps.find((s) => s.status === "running") ?? null;
  const plan = livePlan(events);
  const focusStep = currentStep(plan);
  const insights = executionInsights(events);
  const toolPurposes = stepToolPurposes(focusStep);
  const stepLine = total > 0 ? (
    <span className="live-step">
      步骤 {done}/{total}
      {current ? " · " + clip(current.objective || current.id, 24) : ""}
    </span>
  ) : null;
  const toolLine = tool ? (
    <div className="live-tools">
      <span className="live-tool">⚙ {eventLabel(tool)}</span>
    </div>
  ) : null;
  const retry = retryText(events);
  const idle = streamTool || modelWaitText(events) || progressText(events, plan);
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
            {stepLine}
          </div>
          <div className="live-focus">
            <div>
              <span className="live-label">当前步骤</span>
              <strong>{focusStep ? clip(focusStep.objective || focusStep.id, 120) : "等待计划进入执行"}</strong>
            </div>
            <div>
              <span className="live-label">为什么做</span>
              <p>{currentStepWhy(focusStep)}</p>
            </div>
            {toolPurposes.length ? (
              <div className="live-purpose-list">
                {toolPurposes.map((item) => <span key={item}>{item}</span>)}
              </div>
            ) : null}
          </div>
          {retry ? <div className="live-retry">{retry}</div> : null}
          {toolLine}
          {preview}
          {insights.length ? (
            <ol className="live-insights">
              {insights.map((item) => (
                <li className={item.tone} key={item.key}>
                  <span className="live-insight-dot" />
                  <span className="live-insight-body">
                    <b>{item.title}</b>
                    {item.detail ? <span>{item.detail}</span> : null}
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

function FinalAnswer({ run }: { readonly run: RunRecord }): React.ReactNode {
  return (
    <article className="msg assistant">
      <div className="msg-avatar">A</div>
      <div className="msg-body">
        <div className="msg-heading done">✓ 已完成</div>
        <div className="msg-text md">
          {run.output ? <Markdown text={run.output} /> : <span className="muted">（没有产生文本输出）</span>}
        </div>
      </div>
    </article>
  );
}

function ErrorMessage({ run, events }: { readonly run: RunRecord; readonly events: readonly RunEvent[] }): React.ReactNode {
  let msg = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "run.failed" || e.type === "run.cancelled") {
      msg = e.data && typeof e.data.message === "string" ? e.data.message : "";
      break;
    }
  }
  const diag = failureDetails(events);
  return (
    <article className="msg assistant">
      <div className="msg-avatar">A</div>
      <div className="msg-body">
        <div className="msg-heading error">✕ 任务未完成</div>
        <div className="msg-text">
          {run.errorCode ? <span className="mono">{run.errorCode}</span> : null}
          {msg ? <div className="muted">{msg}</div> : <span className="muted">任务在完成前被终止。</span>}
          {diag ? <div className="muted mono">{diag}</div> : null}
        </div>
      </div>
    </article>
  );
}

function AssessmentSummary({ assessments }: { readonly assessments: readonly { approved: boolean }[] }): React.ReactNode {
  if (!assessments.length) return null;
  const ok = assessments.filter((a) => a.approved).length;
  const total = assessments.length;
  const cls = ok === total ? "good" : ok === 0 ? "bad" : "warn";
  const text = ok === total ? "质量评估：" + ok + "/" + total + " 步通过，已通过合规检查。" : "质量评估：" + ok + "/" + total + " 步通过，部分步骤未通过。";
  return (
    <article className="msg harness note-line">
      <span className={"note-dot " + cls} /> {text}
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
    const r = runs[i];
    const isActive = r.id === state.activeRunId && state.running;
    const isLoaded = state.currentRun?.run.id === r.id;
    parts.push(<UserMessage key={"u" + r.id} text={r.input} />);
    if (isActive) {
      const events = state.currentRun?.events ?? [];
      const plan = livePlan(events);
      const steps = plan?.steps ?? [];
      if (plan) parts.push(<PlanCard key={"p" + r.id} steps={steps} goal={plan.goal} />);
      parts.push(<LiveCard key={"l" + r.id} events={events} steps={steps} />);
      const assessments = state.currentRun?.detail.assessments ?? [];
      parts.push(<AssessmentSummary key={"a" + r.id} assessments={assessments} />);
      parts.push(<ToolActivity key={"t" + r.id} events={events} />);
    } else if (r.status === "completed") {
      parts.push(<FinalAnswer key={"f" + r.id} run={r} />);
      const doneEvents = isLoaded ? (state.currentRun?.events ?? []) : [];
      parts.push(<ToolActivity key={"t" + r.id} events={doneEvents} />);
    } else if (r.status === "failed" || r.status === "cancelled") {
      const failEvents = isLoaded ? (state.currentRun?.events ?? []) : [];
      parts.push(<ErrorMessage key={"e" + r.id} run={r} events={failEvents} />);
      parts.push(<ToolActivity key={"t" + r.id} events={failEvents} />);
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

export { eventLabel, eventTone, plannedMap, toolActivityItems, toolRowLabel };

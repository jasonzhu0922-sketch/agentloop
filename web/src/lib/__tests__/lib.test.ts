import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../md";
import { eventLabel, fmtBytes, toolAction, truncate } from "../format";
import { plannedEventMap, translateRunEvent, translatedTimeline } from "../event-translator";
import { executionInsights, livePlan, currentStepWhy, failureSummary, stepToolPurposes, toolActivityItems } from "../live";
import { mergeRunIntoConversation } from "../../state/run-state";
import type { ConversationDetail, RunEvent, RunRecord } from "../types";

describe("renderMarkdown", () => {
  it("renders headings, lists and inline emphasis", () => {
    const html = renderMarkdown("# 标题\n\n- 项目 A\n- 项目 B\n\n**重点** 与 `code`");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>项目 A</li>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain('<code class="md-inline">code</code>');
  });

  it("escapes HTML and renders blockquote", () => {
    const html = renderMarkdown("> 引用\n\n<script>alert(1)</script>");
    expect(html).toContain("<blockquote>引用</blockquote>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```\nconst x = 1;\n```");
    expect(html).toContain('<pre class="md-code"><code>');
    expect(html).toContain("const x = 1;");
  });

  it("renders markdown tables", () => {
    const html = renderMarkdown([
      "| API_ID | 中文名 | 状态 |",
      "|---|---|---|",
      "| `M_ADS_FACT` | 客商画像-客商代码 | 已发布 |",
    ].join("\n"));
    expect(html).toContain("<table>");
    expect(html).toContain("<th>API_ID</th>");
    expect(html).toContain('<code class="md-inline">M_ADS_FACT</code>');
    expect(html).toContain("<td>已发布</td>");
  });
});

describe("format", () => {
  it("truncates long text", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("formats bytes", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
  });

  it("labels tool events", () => {
    const event: RunEvent = {
      seq: 1,
      type: "tool.completed",
      createdAt: 0,
      data: { toolName: "computer_write_file", result: JSON.stringify({ path: "a.md", bytes: 10 }) },
    };
    expect(eventLabel(event)).toContain("完成");
  });

  it("summarizes inline command scripts without exposing the script body", () => {
    const event: RunEvent = {
      seq: 1,
      type: "tool.planned",
      createdAt: 0,
      data: {
        toolName: "computer_run_command",
        arguments: { command: "python", args: ["-c", "print('very long generated script')"] },
      },
    };
    expect(toolAction(event)).toContain("[inline script]");
    expect(toolAction(event)).not.toContain("very long generated script");
  });
});

describe("live projection", () => {
  it("translates raw run events into user-readable timeline copy", () => {
    const events: RunEvent[] = [
      { seq: 1, type: "planning.started", createdAt: 0, data: { availableSkillCount: 2, availableToolCount: 4 } },
      { seq: 2, type: "planning.turn.started", createdAt: 0, data: { turn: 1, hasRuntimeDirective: false } },
      {
        seq: 3,
        type: "tool.planned",
        createdAt: 0,
        data: { toolCallId: "call-1", toolName: "computer_read_file", arguments: { path: "design.md" } },
      },
      {
        seq: 4,
        type: "tool.completed",
        createdAt: 0,
        data: { toolCallId: "call-1", toolName: "computer_read_file", result: "ok" },
      },
    ];
    const planned = plannedEventMap(events);
    const translated = events.map((event) => translateRunEvent(event, planned));
    const timeline = translatedTimeline(events, 4);

    expect(translated[0].title).toBe("开始规划任务");
    expect(translated[1].detail).toContain("第 1 轮规划");
    expect(translated[3].title).toBe("工具完成");
    expect(translated[3].detail).toContain("读取文件 design.md");
    expect(timeline.map((event) => event.rawType)).toEqual(events.map((event) => event.type));
  });

  it("builds user-readable execution insights from SSE events", () => {
    const events: RunEvent[] = [
      { seq: 1, type: "planning.started", createdAt: 0, data: { availableSkillCount: 2, availableToolCount: 4 } },
      {
        seq: 2,
        type: "plan.admitted",
        createdAt: 0,
        data: {
          goal: "分析数据并写报告",
          steps: [{
            id: "profile-data",
            objective: "识别工作表、字段和记录范围。",
            status: "pending",
            requiredToolNames: ["computer_list_directory", "computer_run_command"],
            successCriteria: [{ id: "scope", description: "确认源文件、工作表、字段和有效记录数。" }],
          }],
        },
      },
      { seq: 3, type: "plan.step.started", createdAt: 0, data: { stepId: "profile-data", toolNames: ["computer_list_directory", "computer_run_command"] } },
      { seq: 4, type: "context.assembled", createdAt: 0, data: { estimatedInputTokens: 1234 } },
      {
        seq: 5,
        type: "tool.planned",
        createdAt: 0,
        data: { toolCallId: "call-1", toolName: "computer_list_directory", arguments: { path: "." } },
      },
    ];
    const plan = livePlan(events);
    const insights = executionInsights(events);

    expect(plan?.steps[0].status).toBe("running");
    expect(currentStepWhy(plan?.steps[0] ?? null)).toContain("为了满足");
    expect(stepToolPurposes(plan?.steps[0] ?? null)).toContain("确认输入文件或工作区结构");
    expect(insights.map((item) => item.title)).toContain("整理模型上下文");
    expect(insights.map((item) => item.title)).toContain("工具已准备");
    expect(toolActivityItems(events).map((item) => item.type)).toContain("context.assembled");
  });

  it("projects run-limit failures into a friendly stopped summary", () => {
    const events: RunEvent[] = [
      {
        seq: 1,
        type: "plan.admitted",
        createdAt: 0,
        data: {
          goal: "生成报告",
          steps: [
            { id: "extract", objective: "提取数据", status: "completed" },
            { id: "write", objective: "生成分析报告", status: "pending" },
          ],
        },
      },
      { seq: 2, type: "loop.limit_exceeded", createdAt: 0, data: { hardLimit: 12, stalled: false } },
      {
        seq: 3,
        type: "run.failed",
        createdAt: 0,
        data: { code: "RUN_LIMIT_EXCEEDED", message: "Run exceeded its 12-step limit" },
      },
    ];

    const summary = failureSummary({
      errorCode: "RUN_LIMIT_EXCEEDED",
      events,
      steps: livePlan(events)?.steps,
      artifactCount: 1,
    });

    expect(summary.title).toContain("未完成");
    expect(summary.reason).toContain("步数上限");
    expect(summary.progress).toContain("1/2");
    expect(summary.nextAction).toContain("预览");
  });
});

describe("run state", () => {
  it("replaces a started running run with the persisted terminal run", () => {
    const running: RunRecord = {
      id: "run-1",
      ownerUserId: "user-1",
      conversationId: "conversation-1",
      depth: 0,
      allowDangerousTools: true,
      status: "running",
      input: "分析脚本",
      createdAt: 100,
    };
    const completed: RunRecord = {
      ...running,
      status: "completed",
      output: "脚本分析完成",
      finishedAt: 200,
    };
    const previous: ConversationDetail = {
      conversation: {
        id: "conversation-1",
        title: "分析脚本",
        visibleDirectories: [],
        createdAt: 100,
        updatedAt: 100,
        runCount: 1,
        lastStatus: "running",
      },
      runs: [running],
    };

    const next = mergeRunIntoConversation(previous, completed);

    expect(next?.conversation.lastStatus).toBe("completed");
    expect(next?.conversation.updatedAt).toBe(200);
    expect(next?.runs).toEqual([completed]);
  });
});

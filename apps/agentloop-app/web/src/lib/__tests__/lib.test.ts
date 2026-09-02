import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../md";
import { artifactPreviewMode, prioritizedArtifacts, usesBlobPreview } from "../artifact-preview";
import { commandActivities, commandLine, commandSummary, fullCommandLine } from "../command-activity";
import { executionCapabilities } from "../execution-capabilities";
import { eventLabel, fmtBytes, toolAction, truncate } from "../format";
import { plannedEventMap, translateRunEvent, translatedTimeline } from "../event-translator";
import { executionInsights, liveEventFeed, livePlan, currentStepWhy, failureSummary, stepToolPurposes, streamingStatus, streamingToolProgress, toolActivityItems } from "../live";
import { mergeRunIntoConversation, projectConversationRun } from "../../state/run-state";
import type { ConversationDetail, RunEvent, RunRecord } from "../types";
import type { ProcessArtifact } from "../types";

describe("executionCapabilities", () => {
  it("reports only activated Skills and executed Tools with terminal statuses", () => {
    const capabilities = executionCapabilities([
      { seq: 1, type: "planning.skills.selected", createdAt: 0, data: { skills: ["html"] } },
      { seq: 2, type: "tool.planned", createdAt: 0, data: { toolCallId: "planned", toolName: "websearch" } },
      { seq: 3, type: "skill.activated", createdAt: 0, data: { name: "html" } },
      { seq: 4, type: "skill.activated", createdAt: 0, data: { name: "html" } },
      { seq: 5, type: "tool.dispatched", createdAt: 0, data: { toolCallId: "search-1", toolName: "websearch" } },
      { seq: 6, type: "tool.completed", createdAt: 0, data: { toolCallId: "search-1", toolName: "websearch" } },
      { seq: 7, type: "tool.dispatched", createdAt: 0, data: { toolCallId: "search-2", toolName: "websearch" } },
      { seq: 8, type: "tool.failed", createdAt: 0, data: { toolCallId: "search-2", toolName: "websearch" } },
      { seq: 9, type: "tool.rejected", createdAt: 0, data: { toolCallId: "write-1", toolName: "computer_write_file" } },
    ]);

    expect(capabilities.skills).toEqual(["html"]);
    expect(capabilities.tools).toEqual([
      { name: "computer_write_file", calls: 1, status: "rejected" },
      { name: "websearch", calls: 2, status: "failed" },
    ]);
  });
});

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

describe("artifact preview routing", () => {
  const artifact = (name: string, mimeType: string, role?: ProcessArtifact["role"]): ProcessArtifact => ({
    id: "artifact-id",
    path: `artifacts/${name}`,
    name,
    bytes: 128,
    mimeType,
    ...(role === undefined ? {} : { role }),
    sourceTool: "computer_write_file",
    previewable: true,
  });

  it("renders HTML through a blob preview instead of the text preview API", () => {
    const html = artifact("deck.html", "text/html; charset=utf-8");

    expect(artifactPreviewMode(html)).toBe("html");
    expect(usesBlobPreview(html)).toBe(true);
  });

  it("keeps native browser formats on blob preview and document formats on structured preview", () => {
    expect(artifactPreviewMode(artifact("poster.png", "image/png"))).toBe("image");
    expect(artifactPreviewMode(artifact("report.pdf", "application/pdf"))).toBe("pdf");
    expect(artifactPreviewMode(artifact("notes.md", "text/markdown; charset=utf-8"))).toBe("structured");
    expect(artifactPreviewMode(artifact("weekly.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe("structured");
    expect(artifactPreviewMode(artifact("plan.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))).toBe("structured");
    expect(artifactPreviewMode(artifact("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"))).toBe("structured");
    expect(usesBlobPreview(artifact("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"))).toBe(false);
  });

  it("prioritizes artifacts named in the final answer before auxiliary stdout and json files", () => {
    const artifacts: ProcessArtifact[] = [
      artifact("17b037675b3180a8140771641d55d6cb22455dbceb334354cc82dfe5fa452a3a.stdout.txt", "text/plain; charset=utf-8"),
      artifact("api_query_result.json", "application/json; charset=utf-8"),
      artifact("build_report.py", "text/plain; charset=utf-8"),
      artifact("宝武数据中台_差旅API参数信息报告.md", "text/markdown; charset=utf-8"),
      artifact("inspect_details.py", "text/plain; charset=utf-8"),
    ];

    const ordered = prioritizedArtifacts(
      artifacts,
      "随 后生成 Markdown 报告：宝武数据中台_差旅API参数信息报告.md",
    ).map((item) => item.name);
    expect(ordered[0]).toBe("宝武数据中台_差旅API参数信息报告.md");
    expect(ordered.slice(0, 4)).toContain("宝武数据中台_差旅API参数信息报告.md");
  });

  it("prioritizes accepted final artifacts ahead of process candidates when the answer does not name one", () => {
    const artifacts: ProcessArtifact[] = [
      artifact("analysis-notes.md", "text/markdown; charset=utf-8", "process"),
      artifact("accepted-report.html", "text/html; charset=utf-8", "final"),
      artifact("command-log.txt", "text/plain; charset=utf-8", "process"),
    ];

    const ordered = prioritizedArtifacts(artifacts, "报告已生成并通过验收。").map((item) => item.name);

    expect(ordered[0]).toBe("accepted-report.html");
  });
});

describe("live projection", () => {
  it("aggregates command calls with status, duration and output refs", () => {
    const events: RunEvent[] = [
      {
        seq: 1,
        type: "assistant.tool_call.committed",
        createdAt: 1000,
        data: {
          step: 3,
          toolCallId: "call-command",
          name: "computer_run_command",
          arguments: {
            command: "python3",
            args: ["-c", "print('secret inline body')"],
            cwd: "@skills/api-query",
            timeoutMs: 300000,
          },
        },
      },
      {
        seq: 2,
        type: "tool.dispatched",
        createdAt: 1200,
        data: { step: 3, toolCallId: "call-command", toolName: "computer_run_command" },
      },
      {
        seq: 3,
        type: "tool.completed",
        createdAt: 4200,
        data: {
          step: 3,
          toolCallId: "call-command",
          toolName: "computer_run_command",
          result: JSON.stringify({
            exitCode: 0,
            signal: null,
            stdout: "stored as content-addressed evidence",
            stderr: "",
            stdoutRef: { path: ".agentloop/tool-results/aa/stdout.txt", bytes: 99839, characters: 99839 },
          }),
        },
      },
    ];

    const commands = commandActivities(events);

    expect(commands).toHaveLength(1);
    expect(commands[0].status).toBe("completed");
    expect(commands[0].durationMs).toBe(3000);
    expect(commands[0].cwd).toBe("@skills/api-query");
    expect(commands[0].timeoutMs).toBe(300000);
    expect(commands[0].stdoutRef?.path).toContain(".agentloop/tool-results");
    expect(commandLine(commands[0])).toContain("[inline script]");
    expect(commandLine(commands[0])).not.toContain("secret inline body");
    expect(fullCommandLine(commands[0])).toContain("secret inline body");
    expect(commandSummary(commands[0])).toContain("stdout");
  });

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
            recommendedToolNames: ["computer_list_directory", "computer_run_command"],
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

  it("projects public assistant streaming drafts and tool argument progress", () => {
    const stream: RunEvent = {
      seq: 10,
      type: "assistant.streaming",
      createdAt: 0,
      data: {
        phase: "execution",
        content: "数据已完整获取。现在我来生成 HTML 报告。",
        reasoningContent: "provider-private-continuation",
        toolCalls: [{
          index: 0,
          id: "call-write",
          name: "computer_write_file",
          arguments: {
            schema: "agentloop.toolArgumentTextProjection/v1",
            projected: true,
            originalCharacters: 17715,
            preview: "{\"path\":\"report.html\",\"content\":\"<!doctype html>",
          },
        }],
      },
    };

    expect(streamingStatus(stream)).toEqual({
      content: "数据已完整获取。现在我来生成 HTML 报告。",
      toolName: "computer_write_file",
      toolArgumentCharacters: 17715,
      toolArguments: {
        schema: "agentloop.toolArgumentTextProjection/v1",
        projected: true,
        originalCharacters: 17715,
        preview: "{\"path\":\"report.html\",\"content\":\"<!doctype html>",
      },
    });
    expect(streamingToolProgress(stream)).toBe("把当前内容写成可打开检查的文件。");
    expect(eventLabel(stream)).toContain("实时草稿");
    expect(translateRunEvent(stream).title).toBe("收到实时草稿");

    const feed = liveEventFeed([
      { seq: 8, type: "context.assembled", createdAt: 0, data: { estimatedInputTokens: 2048 } },
      {
        ...stream,
        seq: 9,
        data: {
          ...stream.data,
          content: "数据已完整获取。",
        },
      },
      stream,
      {
        seq: 11,
        type: "assistant.committed",
        createdAt: 0,
        data: {
          content: "我会生成 HTML 报告。",
          finishReason: "stop",
          privateReasoning: {
            schema: "agentloop.privateReasoningProjection/v1",
            redacted: true,
            characters: 31,
          },
        },
      },
      {
        seq: 12,
        type: "tool.planned",
        createdAt: 0,
        data: { toolCallId: "call-write", toolName: "computer_write_file", arguments: { path: "report.html" } },
      },
    ]);
    expect(feed.map((item) => item.kind)).toEqual(["thinking", "reply", "tool", "thinking", "reply", "tool"]);
    expect(feed.map((item) => item.title)).toEqual(["整理上下文", "回复草稿", "正在生成交付文件", "推理状态已保留", "回复已提交", "准备工具"]);
    expect(feed.map((item) => item.detail).join("\n")).not.toContain("provider-private-continuation");
    expect(feed.map((item) => item.detail).join("\n")).not.toContain("computer_write_file");
    expect(feed.map((item) => item.detail).join("\n")).not.toContain("参数 17715 字符");
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

    expect(summary.title).toContain("没有生成最终结果");
    expect(summary.reason).toContain("最终提交前先停下");
    expect(summary.progress).toContain("已完成 1 个阶段");
    expect(summary.nextAction).toContain("下方已有本轮产生的文件");
  });
});

describe("run state", () => {
  it("keeps a loaded running run live even if the active flag was dropped", () => {
    const running: RunRecord = {
      id: "run-1",
      ownerUserId: "user-1",
      conversationId: "conversation-1",
      depth: 0,
      allowDangerousTools: true,
      status: "running",
      input: "制作长卷",
      createdAt: 100,
    };

    const projection = projectConversationRun(running, running, []);

    expect(projection.isLoaded).toBe(true);
    expect(projection.isLive).toBe(true);
    expect(projection.run.status).toBe("running");
  });

  it("keeps a non-selected active run live in multi-run views", () => {
    const running: RunRecord = {
      id: "run-1",
      ownerUserId: "user-1",
      conversationId: "conversation-1",
      depth: 0,
      allowDangerousTools: true,
      status: "running",
      input: "并行任务 A",
      createdAt: 100,
    };

    const projection = projectConversationRun(running, undefined, ["run-1", "run-2"]);

    expect(projection.isLoaded).toBe(false);
    expect(projection.isLive).toBe(true);
  });

  it("uses loaded terminal details when the conversation run is stale", () => {
    const running: RunRecord = {
      id: "run-1",
      ownerUserId: "user-1",
      conversationId: "conversation-1",
      depth: 0,
      allowDangerousTools: true,
      status: "running",
      input: "制作长卷",
      createdAt: 100,
    };
    const completed: RunRecord = {
      ...running,
      status: "completed",
      output: "长卷制作完成",
      finishedAt: 200,
    };

    const projection = projectConversationRun(running, completed, ["run-1"]);

    expect(projection.isLoaded).toBe(true);
    expect(projection.isLive).toBe(false);
    expect(projection.run.status).toBe("completed");
    expect(projection.run.output).toBe("长卷制作完成");
  });

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

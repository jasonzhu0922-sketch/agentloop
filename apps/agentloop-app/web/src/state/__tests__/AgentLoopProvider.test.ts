import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeleteConversationDialog } from "../AgentLoopProvider";

describe("DeleteConversationDialog", () => {
  it("renders deletion scope, status, and disabled progress state", () => {
    const markup = renderToStaticMarkup(createElement(DeleteConversationDialog, {
      conversation: {
        id: "conversation-1",
        title: "把这个 excel 的场景清单生成一份 html 格式的报告",
        runCount: 3,
        lastStatus: "running",
      },
      deleting: true,
      error: "Cannot delete a conversation while one of its runs is active",
      onCancel: () => undefined,
      onConfirm: () => undefined,
    }));

    expect(markup).toContain("删除这个会话？");
    expect(markup).toContain("3 轮运行、计划、评估、事件和已上传来源");
    expect(markup).toContain("仍有运行记录显示为进行中");
    expect(markup).toContain("Cannot delete a conversation while one of its runs is active");
    expect(markup).toContain("删除中...");
    expect(markup).toContain("disabled=\"\"");
  });
});

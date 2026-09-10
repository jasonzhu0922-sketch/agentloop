import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { isNearBottom, scrollReasoningToBottom } from "../ConversationView";

describe("live reasoning scroll", () => {
  it("keeps following streamed reasoning while the reader is at the bottom", () => {
    const container = { clientHeight: 240, scrollHeight: 640, scrollTop: 400 };

    expect(isNearBottom(container)).toBe(true);

    container.scrollHeight = 720;
    scrollReasoningToBottom(container);

    expect(container.scrollTop).toBe(720);
  });

  it("stops following when the reader scrolls up to inspect earlier reasoning", () => {
    expect(isNearBottom({ clientHeight: 240, scrollHeight: 960, scrollTop: 420 })).toBe(false);
  });
});

describe("terminal conversation view", () => {
  it("does not render a Planner or reasoning panel after a Run has finished", async () => {
    const source = await readFile(new URL("../ConversationView.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("function TurnPlanner");
    expect(source).toContain("function LiveCard");
    expect(source).toContain("function FinalAnswer");
  });
});

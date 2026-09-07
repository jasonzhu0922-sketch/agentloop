import { describe, expect, it } from "vitest";
import { activeRunEventVersion, scrollToBottom } from "../App";

describe("conversation streaming scroll", () => {
  it("changes the scroll dependency when an active Run receives an SSE event", () => {
    const before = activeRunEventVersion(["run_1"], { run_1: { events: [{ seq: 4 }] } });
    const after = activeRunEventVersion(["run_1"], { run_1: { events: [{ seq: 4 }, { seq: 5 }] } });

    expect(after).not.toBe(before);
  });

  it("moves the actual conversation scroll container to its newest content", () => {
    const container = { scrollTop: 0, scrollHeight: 640 };

    scrollToBottom(container);

    expect(container.scrollTop).toBe(640);
  });
});

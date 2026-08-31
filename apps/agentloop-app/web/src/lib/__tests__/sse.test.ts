import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeRunEvents } from "../sse";
import type { RunEvent } from "../types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscribeRunEvents", () => {
  it("reconnects after a non-terminal stream closes and consumes catch-up events", async () => {
    vi.useFakeTimers();
    const started = runEvent(1, "run.started");
    const completed = runEvent(2, "run.completed");
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? sseResponse([started]) : sseResponse([started, completed]);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const abort = new AbortController();
    const received: string[] = [];
    const errors: string[] = [];
    let done = "";
    subscribeRunEvents(
      "token",
      "run-1",
      (event) => received.push(event.type),
      (finalType) => {
        done = finalType;
      },
      (message) => errors.push(message),
      abort.signal,
    );

    await vi.waitFor(() => expect(received).toEqual(["run.started"]));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(done).toBe("run.completed"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received).toEqual(["run.started", "run.completed"]);
    expect(errors).toEqual([]);
    abort.abort();
  });
});

function runEvent(seq: number, type: string): RunEvent {
  return { seq, type, data: {}, createdAt: 100 + seq };
}

function sseResponse(events: readonly RunEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

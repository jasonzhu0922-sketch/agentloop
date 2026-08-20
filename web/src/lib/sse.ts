import type { RunEvent } from "./types";

/**
 * Subscribes to the run's SSE event stream. Events are delivered in order and
 * deduplicated by seq. Returns an unsubscribe function.
 */
export function subscribeRunEvents(
  token: string,
  runId: string,
  onEvent: (event: RunEvent) => void,
  onDone: (finalType: string) => void,
  onError: (message: string) => void,
  signal: AbortSignal,
): () => void {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort);

  void (async () => {
    try {
      const response = await fetch(`/v1/runs/${encodeURIComponent(runId)}/events/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        onError(`无法订阅任务流：HTTP ${response.status}`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let event: RunEvent;
          try {
            event = JSON.parse(line.slice(6)) as RunEvent;
          } catch {
            continue;
          }
          onEvent(event);
          if (
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.cancelled"
          ) {
            onDone(event.type);
            return;
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      onError(error instanceof Error ? error.message : "任务流订阅中断");
    } finally {
      signal.removeEventListener("abort", abort);
    }
  })();

  return abort;
}

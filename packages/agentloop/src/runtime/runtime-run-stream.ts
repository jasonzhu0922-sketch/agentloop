import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunService, StoredRunEvent } from "./run-service.ts";
import type { LiveRunEvent, LiveRunProgress } from "./run-event-hub.ts";
const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled"]);
const REFRESH = new Set(["human_loop.requested", "run.waiting_user", "human_loop.answered", ...TERMINAL]);

export async function streamRuntimeRun(input: {
  runs: RunService; actorUserId: string; runId: string; after: number; request: IncomingMessage; response: ServerResponse;
  project: (event: LiveRunEvent) => unknown;
}) {
  const { runs, actorUserId, runId, request, response, project } = input;
  // Authorization precedes subscribing; backfill after subscribing closes the race.
  await runs.get(actorUserId, runId);
  let cursor = input.after, ready = false, closed = false, terminal = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let refresh: Promise<void> | undefined;
  let refreshAgain = false;
  const buffered: Array<{ event: LiveRunEvent } | { progress: LiveRunProgress }> = [];
  let unsubscribe = () => {}, unsubscribeProgress = () => {};
  function cleanup() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe(); unsubscribeProgress();
  }
  response.once("close", cleanup);
  function send(name: string, value: unknown, id?: number) {
    if (closed || response.destroyed || response.writableEnded) return;
    if (response.writableLength > 1_000_000) { response.destroy(); cleanup(); return; }
    response.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  function failure() {
    send("stream_error", { error: "进度连接中断，正在重新连接" });
    response.end(); cleanup();
  }
  async function snapshot(backfill: boolean) {
    const [run, events, humanLoop, artifacts] = await Promise.all([
      runs.get(actorUserId, runId), backfill ? runs.eventsAfter(actorUserId, runId, cursor) : Promise.resolve([] as StoredRunEvent[]),
      runs.currentHumanLoop(actorUserId, runId), runs.processArtifacts(actorUserId, runId),
    ]);
    if (closed) return;
    const delta = events.filter(event => event.seq > cursor).sort((a, b) => a.seq - b.seq);
    if (delta.length) cursor = delta.at(-1)!.seq;
    send("snapshot", { run, events: delta.map(project), humanLoop: humanLoop ?? null, artifacts }, cursor);
    // Completed before connection, or completion arrived during initial reads.
    if (run.status !== "running") terminal = true;
  }
  function refreshSnapshot() {
    refreshAgain = true;
    if (refresh || closed) return;
    refresh = (async () => {
      while (refreshAgain && !closed) { refreshAgain = false; await snapshot(false); }
      if (terminal && !closed) { send("end", {}); response.end(); cleanup(); }
    })().catch(failure).finally(() => { refresh = undefined; });
  }
  function live(event: LiveRunEvent) {
    if (closed) return;
    if (!ready) { buffered.push({ event }); if (buffered.length > 2000) { response.destroy(); cleanup(); } return; }
    if (event.seq <= cursor) return;
    cursor = event.seq;
    send("run_event", project(event), cursor);
    if (TERMINAL.has(event.type)) terminal = true;
    if (REFRESH.has(event.type)) refreshSnapshot();
  }
  function progress(event: LiveRunProgress) {
    if (closed) return;
    if (!ready) { buffered.push({ progress: event }); if (buffered.length > 2000) { response.destroy(); cleanup(); } return; }
    // Deliberately no SSE id: uncommitted observations cannot advance replay.
    send("progress", project({ ...event, seq: 0 }));
  }
  try {
    unsubscribe = runs.subscribeRunEvents(runId, live, input.after);
    unsubscribeProgress = runs.subscribeRunProgress(runId, progress);
    if (closed || response.destroyed) { unsubscribe(); unsubscribeProgress(); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    await snapshot(true);
    ready = true;
    for (const item of buffered.splice(0)) { if ("event" in item) live(item.event); else progress(item.progress); }
    if (terminal) refreshSnapshot();
    heartbeat = setInterval(() => { if (!closed) response.write(": keepalive\n\n"); }, 15_000);
    heartbeat.unref();
  } catch (error) {
    cleanup();
    if (response.headersSent) { response.end(); return; }
    throw error;
  }
}

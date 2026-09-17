const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Observe an accepted assignment. Transport failure never creates a Run outcome. */
export async function observeAssignment({ baseUrl, headers, signal, afterSeq = 0, onEvent, onRun, onConnection,
  fetchImpl = fetch, wait = retryDelay, idleTimeoutMs = 30_000 }) {
  let cursor = afterSeq;
  let retries = 0;
  const accept = (event) => {
    if (!Number.isSafeInteger(event?.seq) || event.seq <= cursor || typeof event.type !== "string") return false;
    const terminal = onEvent(event);
    cursor = event.seq; // Advance only after the UI has applied the event.
    retries = 0;
    return terminal;
  };
  while (!signal.aborted) {
    const connection = new AbortController();
    const abort = () => connection.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let timer;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => connection.abort(new Error("事件流长时间无响应")), idleTimeoutMs); };
    let reader;
    try {
      touch();
      const response = await fetchImpl(`${baseUrl}/events/stream?afterSeq=${cursor}`, { headers, signal: connection.signal });
      if (!response.ok || !response.body) throw new Error(`SSE 连接失败：HTTP ${response.status}`);
      onConnection("connected");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE 在收到 Run 终态前关闭");
        touch();
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const packet = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const lines = packet.split(/\r?\n/);
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue; // Heartbeats keep the connection alive, not the Run.
          const payload = JSON.parse(data);
          const type = payload.type ?? lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (type === "error" || type === "stream.error") throw new Error(payload.data?.error ?? payload.error ?? "事件流暂时不可用");
          if (type === "run.snapshot" && TERMINAL.has(payload.run?.status)) { onRun(payload.run); return; }
          if (accept({ ...payload, type })) return;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      onConnection("reconnecting", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      connection.abort();
      try { await reader?.cancel(); } catch {}
      reader?.releaseLock();
    }
    if (signal.aborted) return;
    // A lost final packet must not leave the UI waiting forever. This is a
    // Host-backed status read, not a synthetic terminal event/sequence number.
    try {
      const statusSignal = AbortSignal.any([signal, AbortSignal.timeout(idleTimeoutMs)]);
      const response = await fetchImpl(baseUrl, { headers, signal: statusSignal });
      if (response.ok) {
        const { run } = await response.json();
        if (run && TERMINAL.has(run.status)) {
          try {
            const replay = await fetchImpl(`${baseUrl}/events?afterSeq=${cursor}`, { headers, signal: statusSignal });
            if (replay.ok) for (const event of (await replay.json()).events ?? []) { if (accept(event)) return; }
          } catch { /* A confirmed terminal snapshot remains authoritative when replay is unavailable. */ }
          if (!signal.aborted) onRun(run);
          return;
        }
      }
    } catch { /* Status is unknown; keep observing without failing or resubmitting the Run. */ }
    if (!signal.aborted) await wait(Math.min(10_000, 500 * 2 ** Math.min(retries++, 5)), signal);
  }
}

function retryDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

const terminalEvent = event => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type);

// Read a complete update before the caller checks its conversation generation
// and applies it. Artifacts are available while running, not only at delivery.
export async function readRunUpdate(api, turn) {
  const path = `/api/runs/${encodeURIComponent(turn.id)}`;
  const { events } = await api(`${path}/events?afterSeq=${turn.lastSeq}`);
  const { run } = await api(path);
  // The terminal commit can land between the two reads. Preserve the final
  // Plan/tool events before the watcher stops.
  if (run.status !== 'running' && !turn.events.some(terminalEvent) && !events.some(terminalEvent)) {
    const lastSeq = events.reduce((seq, event) => Math.max(seq, event.seq), turn.lastSeq);
    const tail = await api(`${path}/events?afterSeq=${lastSeq}`);
    events.push(...tail.events);
  }
  const { artifacts } = await api(`${path}/artifacts`);
  const { rounds } = await api(`${path}/rounds`);
  const humanLoop = run.status === 'running' ? await api(`${path}/human-loop/current`) : {};
  return { run, events, artifacts, rounds, humanLoop };
}

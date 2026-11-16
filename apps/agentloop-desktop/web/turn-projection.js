import { projectAssistantEvent } from './reference/projections/assistant-event-projection.js';

export const artifactsVisible = turn => ['completed', 'failed', 'cancelled'].includes(turn?.status);

// Adapt public local Run/event records, never Router Assignments. Every durable
// event is projected before display limits are applied; cursors are per Run.
export function createTurn(run) {
  return { id: run.id, run, revision: 0, text: '', reasoning: '', plan: [], rounds: [], events: [], artifacts: [], lastSeq: 0, status: run.status };
}
export function updateTurn(turn, run, incoming = [], artifacts, humanLoop, rounds, messages) {
  let changed = ['status', 'output', 'finishedAt', 'errorCode', 'modelKey'].some(key => turn.run[key] !== run[key]);
  // Keep stable cards/previews on unchanged polls, but also render artifact-only
  // changes (including an updated file or a process-to-final transition).
  if (artifacts !== undefined && JSON.stringify(turn.artifacts) !== JSON.stringify(artifacts)) {
    turn.artifacts = artifacts; changed = true;
  }
  if (rounds !== undefined && JSON.stringify(turn.rounds) !== JSON.stringify(rounds)) { turn.rounds = rounds; changed = true; }
  for (const event of [...incoming].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= turn.lastSeq) continue;
    changed = true;
    turn.lastSeq = event.seq; turn.events.push(event);
    if (['run.input.accepted', 'run.input.decided'].includes(event.type) && event.data?.message) {
      const message = event.data.message;
      turn.inputMessages = [...(turn.inputMessages || []).filter(item => item.id !== message.id), message].sort((a, b) => a.seq - b.seq);
    }
    // Never expose internal assessment/planning response bodies as a reply.
    if (event.data?.responseVisibility !== 'internal') projectAssistantEvent(turn, event);
  }
  if (messages !== undefined && JSON.stringify(turn.inputMessages) !== JSON.stringify(messages)) { turn.inputMessages = messages; changed = true; }
  turn.run = run; turn.status = run.status;
  // Current persisted request is authoritative over a replayed waiting event.
  if (humanLoop !== undefined && JSON.stringify(turn.humanLoop) !== JSON.stringify(humanLoop.request)) {
    turn.humanLoop = humanLoop.request; changed = true;
  }
  if (run.status !== 'running') {
    turn.reasoning = ''; turn.progress = undefined; turn.humanLoop = undefined; turn.recovery = undefined;
    if (run.status === 'failed') { turn.partialText = run.output || turn.partialText; turn.text = ''; }
    else turn.text = run.output || (run.status === 'completed' ? '' : turn.text);
  }
  if (changed) turn.revision++;
  return turn;
}
export function hasTerminalEvent(turn) {
  return turn.events.some(event => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type));
}
export { visibleToolCalls } from '../../../packages/agentloop-conversation-ui/process.js';

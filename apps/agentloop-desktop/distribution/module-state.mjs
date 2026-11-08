import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const validSequence = value => Number.isSafeInteger(value) && value >= 1;
function validate(state) {
  if (!state || state.schema !== 'agentloop.desktop.update-state/v1' || !validSequence(state.highest) || !state.active || !validSequence(state.active.sequence) || !['baseline', 'module'].includes(state.active.kind) || state.highest < state.active.sequence || (state.pending !== null && (!state.pending || !validSequence(state.pending.sequence) || state.pending.sequence <= state.active.sequence || state.pending.sequence > state.highest))) throw new Error('desktop_update_state_invalid');
  return state;
}
export async function openModuleState(directory, baseline) {
  if (!validSequence(baseline)) throw new Error('desktop_update_state_invalid');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json'); let state;
  async function save(next) {
    validate(next);
    const temp = join(directory, `.state-${randomUUID()}`); let file;
    try {
      file = await open(temp, 'wx', 0o600); await file.writeFile(JSON.stringify(next)); await file.sync(); await file.close(); file = undefined;
      await rename(temp, path);
      const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      state = next;
    } finally { await file?.close().catch(() => {}); await rm(temp, { force: true }); }
  }
  try { state = validate(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { schema: 'agentloop.desktop.update-state/v1', active: { kind: 'baseline', sequence: baseline }, highest: baseline, pending: null }; await save(state); }
  // A crash before commit never changes the active release.
  if (state.pending !== null) await save({ ...state, pending: null });
  // A newly installed PKG is the baseline authority for its own sequence.
  // Retain a newer already-activated payload; reject a baseline downgrade.
  if (state.active.kind === 'baseline' && state.active.sequence > baseline) throw new Error('desktop_update_baseline_downgrade');
  if (state.active.sequence <= baseline && (state.active.kind !== 'baseline' || state.active.sequence !== baseline)) await save({ ...state, active: { kind: 'baseline', sequence: baseline }, highest: Math.max(state.highest, baseline) });
  return {
    get value() { return structuredClone(state); },
    async observe(sequence) {
      if (!validSequence(sequence) || sequence < state.highest) throw new Error('desktop_module_replay');
      if (sequence > state.highest) await save({ ...state, highest: sequence });
    },
    async begin(sequence) {
      if (state.pending || !validSequence(sequence) || sequence <= state.active.sequence || sequence !== state.highest) throw new Error('desktop_update_transition_invalid');
      await save({ ...state, pending: { sequence } });
    },
    async commit(sequence) {
      if (state.pending?.sequence !== sequence) throw new Error('desktop_update_transition_invalid');
      await save({ ...state, active: { kind: 'module', sequence }, pending: null });
    },
    async abort(sequence) {
      if (state.pending?.sequence !== sequence) throw new Error('desktop_update_transition_invalid');
      await save({ ...state, pending: null });
    },
  };
}

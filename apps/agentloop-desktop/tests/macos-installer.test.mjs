import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { macInstallerScripts } from '../scripts/package-macos-installer.mjs';

const macTest = process.platform === 'darwin' ? test : test.skip;
const localApp = '/Applications/AgentLoop Desktop Local.app';
const localBackend = `${localApp}/Contents/Resources/runtime/bin/node ${localApp}/Contents/Resources/backend.mjs`;
const localTray = `${localApp}/Contents/MacOS/AgentLoop Desktop`;
const otherProcesses = [
  { pid: 21, command: '/Applications/AgentLoop Desktop.app/Contents/Resources/runtime/bin/node backend.mjs' },
  { pid: 22, command: '/Applications/AgentLoop Local Runtime.app/Contents/Resources/agentloop-local-runtime-node' },
  { pid: 23, command: '/repo/AgentLoop Desktop Local.app/Contents/Resources/runtime/bin/node backend.mjs' },
  { pid: 24, command: '/Applications/AgentLoop Desktop LocalXapp/Contents/Resources/runtime/bin/node backend.mjs' },
];
async function fixture(initial) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-installer-'));
  const state = join(root, 'state.json'); await writeFile(state, JSON.stringify({ processes: [], events: [], user: 'desktop-user', uid: '501', ...initial }));
  const binaries = {};
  for (const command of ['pgrep', 'kill', 'sleep', 'stat', 'id', 'launchctl', 'sudo', 'open']) {
    binaries[command] = join(root, command);
    await writeFile(binaries[command], `#!${process.execPath}\nconst fs=require('node:fs');const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));const args=process.argv.slice(2);const command=${JSON.stringify(command)};let code=0;
s.events.push([command,...args]);
if(command==='pgrep') { if(s.inspectError)code=2;else {const matches=s.processes.filter(p=>new RegExp(args.at(-1)).test(p.command));if(matches.length)console.log(matches.map(p=>p.pid).join('\\n'));else code=1;} }
if(command==='kill') {const pid=Number(args.at(-1));if(!s.refuseStop)s.processes=s.processes.filter(p=>p.pid!==pid);}
if(command==='stat')console.log(s.user);
if(command==='id')console.log(s.uid);
if(command==='launchctl'){if(s.launchError)code=1;else s.processes.push({pid:31,command:${JSON.stringify(localTray)}},{pid:32,command:${JSON.stringify(localBackend)}});}
fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s));process.exit(code);\n`, { mode: 0o755 });
  }
  const generated = macInstallerScripts({ channel: 'local', productName: 'AgentLoop Desktop Local' }, binaries);
  for (const name of ['preinstall', 'postinstall']) await writeFile(join(root, name), generated[name]);
  return { root, async run(name, volume = '/') {
    const result = spawnSync('/bin/sh', [join(root, name), 'package.pkg', '/', volume], { encoding: 'utf8' });
    return { ...result, state: JSON.parse(await readFile(state, 'utf8')) };
  }, close: () => rm(root, { recursive: true, force: true }) };
}

macTest('upgrade stops only this installed channel, backend before tray, preserving other copies', async () => {
  const f = await fixture({ processes: [{ pid: 11, command: localBackend }, { pid: 12, command: localTray }, ...otherProcesses] });
  try {
    const r = await f.run('preinstall'); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.state.processes, otherProcesses);
    assert.deepEqual(r.state.events.filter(e => e[0] === 'kill'), [['kill', '-TERM', '11'], ['kill', '-TERM', '12']]);
  } finally { await f.close(); }
});

macTest('busy backend aborts upgrade without killing tray or forcing task termination', async () => {
  const processes = [{ pid: 11, command: localBackend }, { pid: 12, command: localTray }];
  const f = await fixture({ processes, refuseStop: true });
  try {
    const r = await f.run('preinstall'); assert.equal(r.status, 1); assert.match(r.stderr, /still busy/);
    assert.deepEqual(r.state.processes, processes);
    assert.deepEqual(r.state.events.filter(e => e[0] === 'kill'), [['kill', '-TERM', '11']]);
  } finally { await f.close(); }
});

macTest('process inspection failure aborts upgrade rather than treating it as an empty process list', async () => {
  const f = await fixture({ inspectError: true });
  try { const r = await f.run('preinstall'); assert.equal(r.status, 1); assert.match(r.stderr, /Unable to inspect/); }
  finally { await f.close(); }
});

macTest('installation to another volume does not stop or launch local processes', async () => {
  const f = await fixture({});
  try {
    for (const script of ['preinstall', 'postinstall']) { const r = await f.run(script, '/Volumes/Other'); assert.equal(r.status, 0); assert.deepEqual(r.state.events, []); }
  } finally { await f.close(); }
});

macTest('postinstall launches only in the logged-in user session and confirms installed processes', async () => {
  const f = await fixture({});
  try {
    const r = await f.run('postinstall'); assert.equal(r.status, 0, r.stderr);
    const launch = r.state.events.find(e => e[0] === 'launchctl');
    assert.deepEqual(launch.slice(1,3), ['asuser', '501']);
    assert.deepEqual(launch.slice(4,7), ['-H', '-u', 'desktop-user']);
    assert.equal(launch.at(-1), localApp);
  } finally { await f.close(); }
});

macTest('no login session skips startup, launch errors fail postinstall', async () => {
  for (const initial of [{user:'root'}, {user:'loginwindow'}, {launchError:true}]) {
    const f = await fixture(initial);
    try { const r = await f.run('postinstall'); assert.equal(r.status, initial.launchError ? 1 : 0); if (!initial.launchError) assert.equal(r.state.events.some(e=>e[0]==='launchctl'),false); }
    finally { await f.close(); }
  }
});

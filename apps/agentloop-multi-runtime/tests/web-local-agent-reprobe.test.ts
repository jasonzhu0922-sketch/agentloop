import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../web/client/app.js', import.meta.url), 'utf8')
const reprobeSource = source.slice(source.indexOf('async function loadDevices()'), source.indexOf('async function connectRegisteredLocalAgent()'))

test('web retries an initially unreachable local Agent and recovers when it starts', async () => {
  const timers = new Map<number, () => void>()
  let nextTimerId = 0
  let probeCount = 0
  let connectedCount = 0
  const localRuntimeState = {
    agentStatus: 'checking',
    agentHealth: undefined as { deviceId: string } | undefined,
    device: undefined as { id: string; status: string } | undefined,
    agentReprobe: undefined as number | undefined,
  }
  const loadDevices = vm.runInNewContext(`${reprobeSource}\nloadDevices`, {
    localRuntimeState,
    localSkillPackages: [],
    localSkillPackagesLoaded: false,
    probeLocalAgent: async () => {
      probeCount++
      localRuntimeState.agentStatus = probeCount === 1 ? 'unreachable' : 'online'
      if (probeCount > 1) localRuntimeState.agentHealth = { deviceId: 'device-1' }
    },
    routerClient: { request: async () => Response.json({ devices: [{ id: 'device-1', status: 'active' }] }) },
    connectRegisteredLocalAgent: async () => { connectedCount++ },
    renderLocalAgentState: () => undefined,
    updateLocalControls: () => undefined,
    setTimeout: (callback: () => void) => { const id = ++nextTimerId; timers.set(id, callback); return id },
  }) as () => Promise<void>

  await loadDevices()
  assert.equal(localRuntimeState.agentStatus, 'unreachable')
  assert.equal(timers.size, 1)
  timers.values().next().value!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(localRuntimeState.agentStatus, 'online')
  assert.equal(localRuntimeState.device?.id, 'device-1')
  assert.equal(connectedCount, 1)
})

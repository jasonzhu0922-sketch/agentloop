import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createWebServer } from '../web/server.mjs'
import { safeInstallerUrl } from '../web/client/local-runtime/release-selection.js'

test('Web assets and API stay under a configured path prefix', async () => {
  const server = createWebServer({ webBasePath: '/agentloop' })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const config = await (await fetch(`${origin}/runtime-config.js`)).text()
    assert.match(config, /AGENTLOOP_BASE_PATH = "\/agentloop"/)
    assert.match(config, /AGENTLOOP_ROUTER_URL = "\/agentloop\/api"/)

    for (const route of ['/', '/login', '/downloads', '/cloud-models', '/cloud-skills']) {
      const response = await fetch(`${origin}${route}`)
      assert.equal(response.status, 200)
      const html = await response.text()
      assert.doesNotMatch(html, /(?:href|src)="\//, route)
    }

    for (const route of ['/client/app.js', '/pages/downloads.js']) {
      const script = await (await fetch(`${origin}${route}`)).text()
      assert.doesNotMatch(script, /from "\//, route)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('installer downloads use the same path prefix', () => {
  assert.equal(
    safeInstallerUrl('/downloads/local-agent/v1/agent.pkg', 'http://localhost:3000', '/agentloop'),
    'http://localhost:3000/agentloop/downloads/local-agent/v1/agent.pkg',
  )
})

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ALLOW_REMOTE_ENV, FLEET_ERROR_MESSAGE, handleFleetRequest, isLoopbackHost } from './fleet-api'

const req = (headers: Record<string, string>) => new Request('http://localhost/api/fleet', { headers })
const okDeps = (extra: Record<string, unknown> = {}) => ({
  readKanban: () => ({ nodes: [] }),
  readSupermemory: () => ({ nodes: [] }),
  now: () => 42,
  env: {},
  ...extra,
})

test('loopback host detection handles ports, IPv6 and look-alikes', () => {
  for (const h of ['localhost', 'localhost:3000', '127.0.0.1:3301', '127.1.2.3', '[::1]:3000', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(h), true, h)
  }
  for (const h of [null, '', '100.98.128.110:3301', '0.0.0.0:3000', 'example.com', 'localhost.evil.com', '127.0.0.1.evil.com']) {
    assert.equal(isLoopbackHost(h), false, String(h))
  }
})

test('/api/fleet answers loopback requests', async () => {
  const res = handleFleetRequest(req({ host: '127.0.0.1:3000' }), okDeps())
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { readAt: 42, kanban: [], supermemory: [] })
})

test('/api/fleet accepts the forwarded headers Next adds itself for a direct loopback request', () => {
  const headers = { host: '127.0.0.1:3000', 'x-forwarded-host': '127.0.0.1:3000', 'x-forwarded-for': '::1', 'x-forwarded-proto': 'http' }
  assert.equal(handleFleetRequest(req(headers), okDeps()).status, 200)
  assert.equal(handleFleetRequest(req({ ...headers, 'x-forwarded-for': '::ffff:127.0.0.1' }), okDeps()).status, 200)
})

test('/api/fleet rejects non-loopback hosts and proxied requests by default', async () => {
  let reads = 0
  const deps = okDeps({ readKanban: () => { reads++; return { nodes: [] } } })
  const rejected: Record<string, string>[] = [
    { host: '100.98.128.110:3301' },
    { host: 'localhost:3000', 'x-forwarded-for': '100.64.0.9' },
    { host: 'localhost:3000', forwarded: 'for=100.64.0.9' },
    { host: 'localhost:3000', 'x-real-ip': '100.64.0.9' },
    { host: 'localhost:3000', 'x-forwarded-host': 'fleet.tailnet.example' },
    { host: 'localhost:3000', 'x-forwarded-for': '127.0.0.1, 100.64.0.9' },
    {},
  ]
  for (const headers of rejected) {
    const res = handleFleetRequest(req(headers), deps)
    assert.equal(res.status, 403, JSON.stringify(headers))
    assert.deepEqual(await res.json(), { error: 'forbidden' })
  }
  assert.equal(reads, 0, 'nothing is read for a rejected request')
})

test('/api/fleet serves a non-loopback host only with the explicit opt-in', () => {
  const headers = { host: '100.98.128.110:3301', 'x-forwarded-for': '100.64.0.9' }
  assert.equal(handleFleetRequest(req(headers), okDeps({ env: { [ALLOW_REMOTE_ENV]: '0' } })).status, 403)
  assert.equal(handleFleetRequest(req(headers), okDeps({ env: { [ALLOW_REMOTE_ENV]: 'true' } })).status, 403)
  assert.equal(handleFleetRequest(req(headers), okDeps({ env: { [ALLOW_REMOTE_ENV]: '1' } })).status, 200)
})

test('/api/fleet returns a generic error and logs the detail server-side', async () => {
  const logged: unknown[][] = []
  const secretPath = '/home/someone/.hermes/kanban/boards/x/kanban.db'
  const res = handleFleetRequest(req({ host: 'localhost:3000' }), okDeps({
    readKanban: () => { throw new Error(`unable to open database file ${secretPath}`) },
    logError: (...args: unknown[]) => { logged.push(args) },
  }))
  assert.equal(res.status, 500)
  const text = await res.text()
  assert.deepEqual(JSON.parse(text), { error: FLEET_ERROR_MESSAGE })
  assert.ok(!text.includes(secretPath) && !text.includes('unable to open'), 'client body has no detail')
  assert.equal(logged.length, 1)
  assert.match(String((logged[0][1] as Error).message), /unable to open database file/)
})

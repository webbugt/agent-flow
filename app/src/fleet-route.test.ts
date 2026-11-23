import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { handleFleetHttp, isFleetPath, type FleetReaders, type FleetRouteOptions } from './fleet-route'

const okReaders: FleetReaders = {
  readKanban: () => ({ nodes: [{ id: 'kanban:main', label: 'main' } as never] }),
  readSupermemory: () => ({ nodes: [{ id: 'sm:omh_family', label: 'omh_family' } as never] }),
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Run the real route on a throwaway loopback server and issue one request. */
async function call(
  options: FleetRouteOptions,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Reply> {
  const server = http.createServer((req, res) => { void handleFleetHttp(req, res, options) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<Reply>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/api/fleet', method, headers }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      r.on('error', reject)
      r.end()
    })
  } finally {
    server.close()
  }
}

const quiet = { logError: () => {} }

test('isFleetPath matches only /api/fleet, with or without a query', () => {
  assert.equal(isFleetPath('/api/fleet'), true)
  assert.equal(isFleetPath('/api/fleet?x=1'), true)
  for (const u of [undefined, '/', '/api/fleet/', '/api/fleets', '/events', '/x/api/fleet']) {
    assert.equal(isFleetPath(u), false, String(u))
  }
})

test('allowed: loopback request gets kanban and supermemory arrays', async () => {
  const r = await call({ loadReaders: async () => okReaders, env: {}, ...quiet })
  assert.equal(r.status, 200)
  assert.match(String(r.headers['content-type']), /application\/json/)
  assert.equal(r.headers['cache-control'], 'no-store')
  const data = JSON.parse(r.body)
  assert.equal(typeof data.readAt, 'number')
  assert.equal(data.kanban.length, 1)
  assert.equal(data.supermemory.length, 1)
})

test('denied: foreign Host and proxy headers get 403 and no data by default', async () => {
  let reads = 0
  const loadReaders = async () => ({
    readKanban: () => { reads++; return { nodes: [] } },
    readSupermemory: () => { reads++; return { nodes: [] } },
  })
  const denied: Record<string, string>[] = [
    { host: '100.98.128.110:3301' },
    { host: '127.0.0.1:3001', 'x-forwarded-for': '100.64.0.9' },
    { host: '127.0.0.1:3001', 'x-real-ip': '100.64.0.9' },
    { host: '127.0.0.1:3001', forwarded: 'for=100.64.0.9' },
    { host: '127.0.0.1:3001', 'x-forwarded-host': 'fleet.tailnet.example' },
  ]
  for (const headers of denied) {
    const r = await call({ loadReaders, env: {}, ...quiet }, headers)
    assert.equal(r.status, 403, JSON.stringify(headers))
    assert.deepEqual(JSON.parse(r.body), { error: 'forbidden' })
  }
  assert.equal(reads, 0)
})

test('opt-in: AGENT_FLOW_FLEET_ALLOW_REMOTE=1 allows a non-loopback request; other values do not', async () => {
  const headers = { host: '100.98.128.110:3301', 'x-forwarded-for': '100.64.0.9' }
  const on = await call({ loadReaders: async () => okReaders, env: { AGENT_FLOW_FLEET_ALLOW_REMOTE: '1' }, ...quiet }, headers)
  assert.equal(on.status, 200)
  for (const v of ['0', 'true', '']) {
    const off = await call({ loadReaders: async () => okReaders, env: { AGENT_FLOW_FLEET_ALLOW_REMOTE: v }, ...quiet }, headers)
    assert.equal(off.status, 403, `value ${JSON.stringify(v)}`)
  }
})

test('error body is generic and the detail only goes to the server log', async () => {
  const secret = "unable to open database file '/home/idv/.hermes/kanban.db'"
  const logged: unknown[] = []
  const r = await call({
    loadReaders: async () => ({ ...okReaders, readKanban: () => { throw new Error(secret) } }),
    env: {},
    logError: (_m, e) => { logged.push(e) },
  })
  assert.equal(r.status, 500)
  assert.deepEqual(JSON.parse(r.body), { error: 'fleet read failed' })
  assert.ok(!r.body.includes('/home/'))
  assert.equal(logged.length, 1)
  assert.match(String((logged[0] as Error).message), /kanban\.db/)
})

test('error body is generic when the readers cannot be loaded (e.g. no node:sqlite)', async () => {
  const logged: unknown[] = []
  const r = await call({
    loadReaders: async () => { throw new Error('No such built-in module: node:sqlite') },
    env: {},
    logError: (_m, e) => { logged.push(e) },
  })
  assert.equal(r.status, 500)
  assert.deepEqual(JSON.parse(r.body), { error: 'fleet read failed' })
  assert.equal(logged.length, 1)
})

test('non-GET methods are rejected with 405', async () => {
  const r = await call({ loadReaders: async () => okReaders, env: {}, ...quiet }, {}, 'POST')
  assert.equal(r.status, 405)
  assert.equal(r.headers.allow, 'GET')
})

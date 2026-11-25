import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { createRequestListener } from './router'
import { isCostsPath, isSameSiteRequest, MAX_BODY } from './costs-route'

interface Reply { status: number; body: string; json: { ok?: boolean; error?: string; path?: string } | null }
interface Write { layer: string; doc: unknown }

/** The real listener with a recording writer; `fail` makes the writer throw. */
async function post(body: string | Buffer, headers: Record<string, string> = {}, opts: { method?: string; path?: string; writer?: 'none' | 'ok' | 'fail' } = {}): Promise<Reply & { writes: Write[] }> {
  const writes: Write[] = []
  const writer = opts.writer ?? 'ok'
  const server = http.createServer(createRequestListener({
    handleSSE: (_req, res) => { res.writeHead(200); res.end() },
    costs: writer === 'none' ? undefined : {
      writeConfig: (layer, doc) => {
        if (writer === 'fail') throw new Error('refused: bad shape')
        writes.push({ layer, doc })
        return { path: '/home/u/.agent-flow/costs.json' }
      },
    },
  }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/costs-config', method: opts.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''
        res.on('data', c => { text += c })
        res.on('end', () => {
          let json = null
          try { json = JSON.parse(text) } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: text, json, writes })
        })
      })
      r.on('error', reject)
      r.end(body)
    })
  } finally {
    server.close()
  }
}

const OK = JSON.stringify({ layer: 'user', doc: { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.92 } } } })

test('isCostsPath matches /costs-config with or without a query, nothing else', () => {
  assert.equal(isCostsPath('/costs-config'), true)
  assert.equal(isCostsPath('/costs-config?x=1'), true)
  for (const u of [undefined, '/', '/costs-config/', '/costs', '/x/costs-config']) assert.equal(isCostsPath(u), false, String(u))
})

test('a same-origin JSON POST reaches the writer with the layer and the document', async () => {
  const r = await post(OK)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, path: '/home/u/.agent-flow/costs.json' })
  assert.equal(r.writes.length, 1)
  assert.equal(r.writes[0].layer, 'user')
  assert.deepEqual(r.writes[0].doc, { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.92 } } })
})

test('the project layer is accepted too; any other layer is refused', async () => {
  assert.equal((await post(JSON.stringify({ layer: 'project', doc: {} }))).status, 200)
  const r = await post(JSON.stringify({ layer: 'settings', doc: {} }))
  assert.equal(r.status, 400)
  assert.equal(r.writes.length, 0)
})

test('only POST: GET is 405 with an Allow header', async () => {
  const r = await post('', {}, { method: 'GET' })
  assert.equal(r.status, 405)
  assert.equal(r.json?.ok, false)
})

test('a cross-site request is refused before anything is read or written', async () => {
  const attempts: Record<string, string>[] = [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://evil.example' }]
  for (const h of attempts) {
    const r = await post(OK, h)
    assert.equal(r.status, 403, JSON.stringify(h))
    assert.equal(r.writes.length, 0)
  }
})

test('a same-origin Origin header and Sec-Fetch-Site: same-origin are accepted', async () => {
  const server = http.createServer(createRequestListener({ handleSSE: () => {}, costs: { writeConfig: () => ({ path: 'p' }) } }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/costs-config', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      r.on('error', reject)
      r.end(OK)
    })
    assert.equal(status, 200)
  } finally { server.close() }
})

test('isSameSiteRequest: no browser headers (curl, tests) is allowed; a malformed Origin is not', () => {
  assert.equal(isSameSiteRequest({ host: 'localhost:3000' }), true)
  assert.equal(isSameSiteRequest({ host: 'localhost:3000', origin: 'not a url' }), false)
  assert.equal(isSameSiteRequest({ host: 'localhost:3000', origin: 'http://localhost:3000' }), true)
  assert.equal(isSameSiteRequest({ host: 'localhost:3000', origin: 'http://localhost:3001' }), false)
})

test('dev mode: a page origin the caller trusts passes even though it is a different port (same-site, not same-origin)', () => {
  const dev = (o: string) => /^http:\/\/localhost:\d+$/.test(o)
  assert.equal(isSameSiteRequest({ host: '127.0.0.1:3001', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }, dev), true)
  assert.equal(isSameSiteRequest({ host: '127.0.0.1:3001', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, dev), false)
  assert.equal(isSameSiteRequest({ host: '127.0.0.1:3001', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }), false)
})

test('a non-JSON content type is 415 (a cross-site form post cannot be JSON without a preflight)', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await post(OK, { 'Content-Type': ct })
    assert.equal(r.status, 415, ct)
    assert.equal(r.writes.length, 0)
  }
})

test('invalid or oversized bodies are 400 / 413 and never reach the writer', async () => {
  assert.equal((await post('{not json')).status, 400)
  assert.equal((await post('[1,2]')).status, 400)
  assert.equal((await post('"str"')).status, 400)
  assert.equal((await post(JSON.stringify({ doc: {} }))).status, 400)
  const big = await post(JSON.stringify({ layer: 'user', doc: { pad: 'x'.repeat(MAX_BODY) } }))
  assert.equal(big.status, 413)
  assert.equal(big.writes.length, 0)
})

test('a refusal by the writer comes back as 400 with its message, not as a crash', async () => {
  const r = await post(OK, {}, { writer: 'fail' })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, { ok: false, error: 'refused: bad shape' })
})

test('without a writer the route answers 503', async () => {
  assert.equal((await post(OK, {}, { writer: 'none' })).status, 503)
})

test('responses are never cached', async () => {
  const server = http.createServer(createRequestListener({ handleSSE: () => {}, costs: { writeConfig: () => ({ path: 'p' }) } }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    const cc = await new Promise<string | undefined>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/costs-config', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.headers['cache-control']) })
      r.on('error', reject)
      r.end(OK)
    })
    assert.equal(cc, 'no-store')
  } finally { server.close() }
})

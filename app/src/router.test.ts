import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { createRequestListener, isHealthPath } from './router'
import { renderHtmlShell } from './static'

const INFO = { branch: 'feature/fleet-polish', commit: '0568094abcdef0123456789abcdef0123456789a' }

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Run the real listener on a throwaway loopback server and issue one request. */
async function call(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply & { sse: number }> {
  let sse = 0
  const server = http.createServer(createRequestListener({
    handleSSE: (_req, res) => { sse++; res.writeHead(200); res.end('sse') },
    buildInfo: INFO,
  }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, sse }))
      })
      r.on('error', reject)
      r.end()
    })
  } finally {
    server.close()
  }
}

test('isHealthPath matches only /health, with or without a query', () => {
  assert.equal(isHealthPath('/health'), true)
  assert.equal(isHealthPath('/health?x=1'), true)
  for (const u of [undefined, '/', '/health/', '/healthz', '/x/health', '/api/health']) {
    assert.equal(isHealthPath(u), false, String(u))
  }
})

test('GET /health returns status, branch and commit as JSON', async () => {
  const r = await call('/health')
  assert.equal(r.status, 200)
  assert.match(String(r.headers['content-type']), /application\/json/)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(r.body), { status: 'ok', ...INFO })
})

test('/health works under localhost and the tunnel-style Host (port ignored)', async () => {
  for (const host of ['localhost:3001', '127.0.0.1:8080', '[::1]:3001']) {
    assert.equal((await call('/health', { host })).status, 200, host)
  }
})

test('/health keeps the Host guard: a foreign Host gets 403 and no build info', async () => {
  for (const host of ['100.98.128.110:3301', 'evil.example', 'evil.example:3001']) {
    const r = await call('/health', { host })
    assert.equal(r.status, 403, host)
    assert.doesNotMatch(r.body, /feature\/fleet-polish|0568094/)
  }
})

test('/health rejects non-GET methods with 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await call('/health', {}, method)
    assert.equal(r.status, 405, method)
    assert.equal(r.headers.allow, 'GET')
  }
})

test('other routes are unchanged: /events reaches the relay, unknown POST is 404', async () => {
  const sse = await call('/events')
  assert.equal(sse.status, 200)
  assert.equal(sse.sse, 1)
  assert.equal((await call('/nope', {}, 'POST')).status, 404)
  assert.equal((await call('/events', { host: 'evil.example' })).status, 403)
})

test('the HTML shell carries the build-branch and build-commit meta tags', () => {
  const html = renderHtmlShell(INFO)
  assert.match(html, /<meta name="build-branch" content="feature\/fleet-polish">/)
  assert.match(html, /<meta name="build-commit" content="0568094abcdef0123456789abcdef0123456789a">/)
  // inside <head>
  assert.ok(html.indexOf('build-branch') < html.indexOf('</head>'))
})

test('the HTML shell escapes attribute values', () => {
  const html = renderHtmlShell({ branch: 'a"><script>x</script>', commit: '&' })
  assert.doesNotMatch(html, /<script>x/)
  assert.match(html, /content="a&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/)
  assert.match(html, /content="&amp;"/)
})

test('unbundled (tests, tsx) the default build info is "unknown"', () => {
  const html = renderHtmlShell()
  assert.match(html, /<meta name="build-branch" content="unknown">/)
})

/**
 * Host-side costs config loader (extension/src/costs-config.ts): load, project override rules, invalid
 * files keep the last good copy, hot reload, atomic write. Real files in temp directories; no vscode.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CostsConfigLoader, CostsConflictError, MAX_COSTS_FILE_BYTES, MISSING_FINGERPRINT, fileFingerprint, fingerprintBytes, defaultUserConfigPath, describeJsonError, displayPath, expandHome, isInside,
  projectConfigPath, readLayerFile, resolveUserConfigPath, resolveUserWriteTarget, settingsLayer, writeFileAtomic,
} from '../src/costs-config'
import type { CostsConfigPayload } from '../src/protocol'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(what: string, fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(15) }
  throw new Error(`timed out waiting for ${what}`)
}

let root: string
let home: string
let ws: string
const loaders: CostsConfigLoader[] = []

function mk(opts: ConstructorParameters<typeof CostsConfigLoader>[0] = {}): CostsConfigLoader {
  const l = new CostsConfigLoader({ homeDir: () => home, workspaceDirs: () => [ws], pollMs: 0, debounceMs: 25, env: {}, ...opts })
  loaders.push(l)
  return l
}
const userFile = () => defaultUserConfigPath(home)
const projFile = () => projectConfigPath(ws)
function put(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const layer = (p: CostsConfigPayload, id: string) => p.layers.find(l => l.id === id)

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-costs-')))
  home = path.join(root, 'home'); ws = path.join(root, 'work')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(ws, { recursive: true })
})
afterEach(() => {
  for (const l of loaders.splice(0)) l.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('paths', () => {
  it('defaults to ~/.agent-flow/costs.json and expands ~', () => {
    assert.equal(defaultUserConfigPath('/h'), path.join('/h', '.agent-flow', 'costs.json'))
    assert.equal(expandHome('~/x/y.json', '/h'), path.join('/h', 'x', 'y.json'))
    assert.equal(expandHome('~', '/h'), '/h')
    assert.equal(expandHome('/abs', '/h'), '/abs')
    assert.equal(displayPath(path.join('/h', '.agent-flow', 'costs.json'), '/h'), `~${path.sep}.agent-flow${path.sep}costs.json`)
    assert.equal(displayPath('/etc/x', '/h'), '/etc/x')
  })

  it('setting beats env beats default; relative or NUL overrides are errors', () => {
    const base = { home: '/h' }
    assert.deepEqual(resolveUserConfigPath({ ...base }), { path: path.join('/h', '.agent-flow', 'costs.json') })
    assert.deepEqual(resolveUserConfigPath({ ...base, env: { AGENT_FLOW_COSTS: '/env/c.json' } }), { path: '/env/c.json' })
    assert.deepEqual(resolveUserConfigPath({ ...base, env: { AGENT_FLOW_COSTS: '/env/c.json' }, configPath: '~/set.json' }), { path: path.join('/h', 'set.json') })
    assert.ok('error' in resolveUserConfigPath({ ...base, configPath: 'relative/c.json' }))
    assert.ok('error' in resolveUserConfigPath({ ...base, configPath: '/a\0b' }))
    assert.ok('error' in resolveUserConfigPath({ ...base, env: { AGENT_FLOW_COSTS: 'nope.json' } }))
  })

  it('isInside is a path-segment check, not a string prefix', () => {
    assert.equal(isInside('/a/b', '/a/b/c'), true)
    assert.equal(isInside('/a/b', '/a/b'), true)
    assert.equal(isInside('/a/b', '/a/bc'), false)
    assert.equal(isInside('/a/b', '/a/b/../x'), false)
  })

  it('honours $HOME (os.homedir) when no homeDir is injected', () => {
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      put(userFile(), '{"currency":{"display":"EUR"}}')
      const l = new CostsConfigLoader({ workspaceDirs: () => [], pollMs: 0, env: {} })
      loaders.push(l)
      const u = layer(l.snapshot(), 'user')
      assert.equal(u?.status, 'ok')
      assert.deepEqual(u?.raw, { currency: { display: 'EUR' } })
    } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved
    }
  })
})

describe('load', () => {
  it('no files: settings and user layers are missing, project absent without a workspace', () => {
    const l = mk({ workspaceDirs: () => [] })
    const p = l.snapshot()
    assert.equal(p.version, 1)
    assert.equal(p.enabled, true)
    assert.deepEqual(p.layers.map(x => [x.id, x.status]), [['settings', 'missing'], ['user', 'missing']])
  })

  it('reads user and project files as separate layers, display path uses ~', () => {
    put(userFile(), '{"pricing":{"multiplier":1.1}}')
    put(projFile(), '{"currency":{"display":"EUR","fx":{"EUR":0.9}}}')
    const p = mk().snapshot()
    assert.deepEqual(p.layers.map(x => x.id), ['settings', 'user', 'project'])
    const u = layer(p, 'user')!
    assert.equal(u.status, 'ok')
    assert.deepEqual(u.raw, { pricing: { multiplier: 1.1 } })
    assert.equal(u.path, `~${path.sep}.agent-flow${path.sep}costs.json`)
    assert.deepEqual(layer(p, 'project')!.raw, { currency: { display: 'EUR', fx: { EUR: 0.9 } } })
  })

  it('project file is the first workspace folder that has one', () => {
    const ws2 = path.join(root, 'work2')
    put(projectConfigPath(ws2), '{"pricing":{"multiplier":2}}')
    const p = mk({ workspaceDirs: () => [ws, ws2] }).snapshot()
    assert.deepEqual(layer(p, 'project')!.raw, { pricing: { multiplier: 2 } })
  })

  it('scalar settings become the lowest layer; `enabled: false` is carried', () => {
    const l = mk({ scalars: () => ({ enabled: false, displayCurrency: ' eur ', unit: 'money', unknownModelPolicy: 'unpriced' }) })
    const p = l.snapshot()
    assert.equal(p.enabled, false)
    assert.deepEqual(layer(p, 'settings')!.raw, { currency: { display: 'EUR' }, display: { unit: 'money' }, pricing: { unknownModel: { policy: 'unpriced' } } })
    assert.equal(settingsLayer({}).status, 'missing')
    assert.equal(settingsLayer({ displayCurrency: '' , unit: 5 as unknown as string }).status, 'missing')
  })

  it('configPath setting redirects the user file', () => {
    const elsewhere = path.join(root, 'elsewhere', 'my-costs.json')
    put(elsewhere, '{"display":{"unit":"tokens"}}')
    put(userFile(), '{"display":{"unit":"money"}}')
    const p = mk({ scalars: () => ({ configPath: elsewhere }) }).snapshot()
    assert.deepEqual(layer(p, 'user')!.raw, { display: { unit: 'tokens' } })
  })

  it('a malformed configPath override surfaces as a user-layer error', () => {
    const u = layer(mk({ scalars: () => ({ configPath: 'relative.json' }) }).snapshot(), 'user')!
    assert.equal(u.status, 'error')
    assert.match(u.error!, /absolute/)
  })
})

describe('invalid files', () => {
  it('invalid JSON, a non-object root, an array and an oversize file are errors with a message and no raw', () => {
    const cases: [string, RegExp][] = [
      ['{ nope', /invalid JSON/],
      ['[1,2]', /JSON object/],
      ['42', /JSON object/],
      [' '.repeat(MAX_COSTS_FILE_BYTES + 10), /limit/],
    ]
    for (const [text, re] of cases) {
      put(userFile(), text)
      const u = readLayerFile(userFile(), 'user', { home })
      assert.equal(u.status, 'error', text.slice(0, 20))
      assert.match(u.error!, re)
      assert.equal(u.raw, undefined)
    }
  })

  it('an empty file or a BOM is fine', () => {
    put(userFile(), '')
    assert.deepEqual(readLayerFile(userFile(), 'user', { home }).raw, {})
    put(userFile(), '\ufeff{"a":1}')
    assert.deepEqual(readLayerFile(userFile(), 'user', { home }).raw, { a: 1 })
  })

  it('a directory in place of the file is an error, not a crash', () => {
    fs.mkdirSync(userFile(), { recursive: true })
    assert.equal(readLayerFile(userFile(), 'user', { home }).status, 'error')
  })

  it('a good file that turns invalid keeps serving the last good content, marked stale', () => {
    put(userFile(), '{"pricing":{"multiplier":1.5}}')
    const l = mk()
    assert.equal(layer(l.snapshot(), 'user')!.status, 'ok')
    put(userFile(), '{ broken')
    assert.equal(l.reload(), true)
    const u = layer(l.snapshot(), 'user')!
    assert.equal(u.status, 'error')
    assert.equal(u.stale, true)
    assert.deepEqual(u.raw, { pricing: { multiplier: 1.5 } })
    assert.match(u.error!, /invalid JSON/)
    // and recovers
    put(userFile(), '{"pricing":{"multiplier":2}}')
    l.reload()
    const back = layer(l.snapshot(), 'user')!
    assert.equal(back.status, 'ok')
    assert.equal(back.stale, undefined)
    assert.deepEqual(back.raw, { pricing: { multiplier: 2 } })
  })

  it('a deleted file is missing, not "last good"', () => {
    put(userFile(), '{"pricing":{"multiplier":1.5}}')
    const l = mk()
    l.snapshot()
    fs.rmSync(userFile())
    l.reload()
    const u = layer(l.snapshot(), 'user')!
    assert.equal(u.status, 'missing')
    assert.equal(u.raw, undefined)
  })

  it('never puts file content in the logged status line', () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try {
      put(userFile(), '{"secret-looking":"sk-test-0123456789", bad')
      mk().snapshot()
    } finally { console.log = orig }
    assert.ok(lines.some(x => x.includes('user=error')))
    assert.ok(!lines.join('\n').includes('sk-test'))
  })
})

describe('project override cannot escape its directory (P3-A4)', () => {
  it('drops `configPath` from the project file with a warning and does not use it', () => {
    const decoy = path.join(root, 'decoy.json')
    put(decoy, '{"display":{"unit":"tokens"}}')
    put(userFile(), '{"display":{"unit":"money"}}')
    put(projFile(), JSON.stringify({ configPath: decoy, pricing: { multiplier: 1.2 } }))
    const p = mk().snapshot()
    const proj = layer(p, 'project')!
    assert.deepEqual(proj.raw, { pricing: { multiplier: 1.2 } })
    assert.equal(proj.warnings?.length, 1)
    assert.match(proj.warnings![0], /configPath/)
    assert.deepEqual(layer(p, 'user')!.raw, { display: { unit: 'money' } })
  })

  it('refuses a project costs.json that is a symlink to a file outside .agent-flow, without reading it', () => {
    const outside = path.join(root, 'outside.json')
    put(outside, '{"pricing":{"multiplier":9}}')
    fs.mkdirSync(path.dirname(projFile()), { recursive: true })
    fs.symlinkSync(outside, projFile())
    const proj = layer(mk().snapshot(), 'project')!
    assert.equal(proj.status, 'error')
    assert.match(proj.error!, /outside/)
    assert.equal(proj.raw, undefined)
  })

  it('refuses when .agent-flow itself is a symlink to another directory', () => {
    const other = path.join(root, 'other-dir')
    put(path.join(other, 'costs.json'), '{"pricing":{"multiplier":9}}')
    fs.symlinkSync(other, path.join(ws, '.agent-flow'))
    const proj = layer(mk().snapshot(), 'project')!
    assert.equal(proj.status, 'error')
    assert.match(proj.error!, /outside/)
    assert.equal(proj.raw, undefined)
  })

  it('a symlink that stays inside .agent-flow is fine', () => {
    put(path.join(ws, '.agent-flow', 'real.json'), '{"pricing":{"multiplier":3}}')
    fs.symlinkSync('real.json', projFile())
    assert.deepEqual(layer(mk().snapshot(), 'project')!.raw, { pricing: { multiplier: 3 } })
  })

  it('writeConfig(project) refuses configPath, forbidden keys and a .agent-flow that leaves the workspace', () => {
    const l = mk()
    assert.throws(() => l.writeConfig('project', { configPath: '/etc/x' }), /configPath/)
    assert.throws(() => l.writeConfig('project', JSON.parse('{"__proto__":{"x":1}}')), /forbidden/)
    assert.throws(() => l.writeConfig('project', { a: { constructor: 1 } }), /forbidden/)
    assert.throws(() => l.writeConfig('project', [1] as unknown as object), /JSON object/)

    const outside = path.join(root, 'victim')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(ws, '.agent-flow'))
    assert.throws(() => l.writeConfig('project', { pricing: { multiplier: 2 } }), /outside the workspace/)
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the workspace')
  })

  it('writeConfig(project) writes only inside <workspace>/.agent-flow', () => {
    const l = mk()
    const r = l.writeConfig('project', { pricing: { multiplier: 2 } })
    assert.equal(r.path, projFile())
    assert.deepEqual(JSON.parse(fs.readFileSync(projFile(), 'utf8')), { pricing: { multiplier: 2 } })
    assert.equal(fs.statSync(projFile()).mode & 0o777, 0o600)
    assert.deepEqual(layer(l.snapshot(), 'project')!.raw, { pricing: { multiplier: 2 } })
  })

  it('writeConfig(project) without a workspace is refused', () => {
    assert.throws(() => mk({ workspaceDirs: () => [] }).writeConfig('project', {}), /no workspace/)
  })
})

describe('atomic write', () => {
  it('creates the directory 0700 and the file 0600, replaces content by rename, leaves no temp files', () => {
    const f = path.join(home, '.agent-flow', 'costs.json')
    writeFileAtomic(f, '{"a":1}\n')
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    const ino1 = fs.statSync(f).ino
    writeFileAtomic(f, '{"a":2}\n')
    assert.equal(fs.readFileSync(f, 'utf8'), '{"a":2}\n')
    assert.notEqual(fs.statSync(f).ino, ino1, 'replaced by rename (new inode), not truncated in place')
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['costs.json'])
  })

  it('tightens a file that used to be world-readable', () => {
    const f = path.join(home, 'c.json')
    fs.writeFileSync(f, 'old', { mode: 0o644 })
    writeFileAtomic(f, 'new')
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  })

  it('a failed write leaves the target untouched and removes its temp file', () => {
    const dir = path.join(home, 'd')
    fs.mkdirSync(dir)
    const target = path.join(dir, 'costs.json')
    fs.mkdirSync(target) // rename over a directory fails
    fs.writeFileSync(path.join(target, 'keep'), 'x')
    assert.throws(() => writeFileAtomic(target, 'data'))
    assert.deepEqual(fs.readdirSync(dir), ['costs.json'], 'no leftover temp file')
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'x')
  })

  it('writeConfig(user) writes pretty JSON with a trailing newline, 0600, and refreshes the snapshot', () => {
    const l = mk()
    l.snapshot()
    l.writeConfig('user', { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.92 } } })
    const text = fs.readFileSync(userFile(), 'utf8')
    assert.equal(text, JSON.stringify({ schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.92 } } }, null, 2) + '\n')
    assert.equal(fs.statSync(userFile()).mode & 0o777, 0o600)
    assert.equal(layer(l.snapshot(), 'user')!.status, 'ok')
  })

  it('writeConfig refuses oversize documents and keeps the existing file', () => {
    put(userFile(), '{"keep":true}')
    const l = mk()
    assert.throws(() => l.writeConfig('user', { blob: 'x'.repeat(MAX_COSTS_FILE_BYTES) }), /larger than/)
    assert.equal(fs.readFileSync(userFile(), 'utf8'), '{"keep":true}')
  })

  it('ensureUserFile creates a minimal template once and never overwrites', () => {
    const l = mk()
    const p = l.ensureUserFile()
    assert.equal(p, userFile())
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { schemaVersion: 1 })
    fs.writeFileSync(p, '{"mine":1}')
    l.ensureUserFile()
    assert.equal(fs.readFileSync(p, 'utf8'), '{"mine":1}')
  })
})

describe('hot reload', () => {
  it('emits when the file is rewritten, with a higher seq, without restarting', async () => {
    put(userFile(), '{"currency":{"display":"USD"}}')
    const l = mk()
    const seen: CostsConfigPayload[] = []
    l.onChange(p => seen.push(p))
    l.start()
    const first = l.snapshot().seq
    writeFileAtomic(userFile(), '{"currency":{"display":"EUR","fx":{"EUR":0.92}}}')
    await until('reload after atomic rewrite', () => seen.length >= 1)
    assert.ok(seen[0].seq > first)
    assert.deepEqual(layer(seen[0], 'user')!.raw, { currency: { display: 'EUR', fx: { EUR: 0.92 } } })
  })

  it('also sees a plain in-place edit (editors that truncate and write)', async () => {
    put(userFile(), '{"a":1}')
    const l = mk()
    const seen: CostsConfigPayload[] = []
    l.onChange(p => seen.push(p))
    l.start()
    fs.writeFileSync(userFile(), '{"a":2}')
    await until('reload after in-place edit', () => seen.length >= 1)
    assert.deepEqual(layer(seen[seen.length - 1], 'user')!.raw, { a: 2 })
  })

  it('coalesces a burst of writes into few reloads', async () => {
    put(userFile(), '{"a":0}')
    const l = mk({ debounceMs: 80 })
    const seen: CostsConfigPayload[] = []
    l.onChange(p => seen.push(p))
    l.start()
    for (let i = 1; i <= 8; i++) { writeFileAtomic(userFile(), `{"a":${i}}`); await sleep(5) }
    await until('burst reload', () => seen.length >= 1)
    await sleep(250)
    assert.ok(seen.length <= 2, `expected <= 2 reloads, got ${seen.length}`)
    assert.deepEqual(layer(seen[seen.length - 1], 'user')!.raw, { a: 8 })
  })

  it('does not emit when nothing changed (touch, same content)', async () => {
    put(userFile(), '{"a":1}')
    const l = mk()
    let n = 0
    l.onChange(() => { n++ })
    l.start()
    fs.writeFileSync(userFile(), '{"a":1}')
    await sleep(200)
    assert.equal(n, 0)
    assert.equal(l.reload(), false)
  })

  it('invalid edit while running: emits an error layer that still carries the last good raw', async () => {
    put(userFile(), '{"pricing":{"multiplier":1.5}}')
    const l = mk()
    const seen: CostsConfigPayload[] = []
    l.onChange(p => seen.push(p))
    l.start()
    writeFileAtomic(userFile(), '{ not json')
    await until('error emit', () => seen.length >= 1)
    const u = layer(seen[0], 'user')!
    assert.equal(u.status, 'error')
    assert.equal(u.stale, true)
    assert.deepEqual(u.raw, { pricing: { multiplier: 1.5 } })
  })

  it('picks up a file created after start in a directory that did not exist (slow poll)', async () => {
    const l = mk({ pollMs: 40 })
    const seen: CostsConfigPayload[] = []
    l.onChange(p => seen.push(p))
    l.start()
    assert.equal(layer(l.snapshot(), 'user')!.status, 'missing')
    put(userFile(), '{"a":1}')
    await until('poll sees the new file', () => seen.length >= 1)
    assert.equal(layer(seen[0], 'user')!.status, 'ok')
  })

  it('a project file appearing later is picked up and a settings change is picked up on reload()', async () => {
    const l = mk()
    l.start()
    put(projFile(), '{"pricing":{"multiplier":2}}')
    // the directory did not exist when watching started; reload() (what a workspace-folder change calls) rewatches
    assert.equal(l.reload(), true)
    assert.equal(layer(l.snapshot(), 'project')!.status, 'ok')
    const seen: CostsConfigPayload[] = []
    l.onChange(p => seen.push(p))
    writeFileAtomic(projFile(), '{"pricing":{"multiplier":3}}')
    await until('project reload via directory watch', () => seen.length >= 1)
    assert.deepEqual(layer(seen[0], 'project')!.raw, { pricing: { multiplier: 3 } })
  })

  it('dispose stops watching: no more emits', async () => {
    put(userFile(), '{"a":1}')
    const l = mk()
    let n = 0
    l.onChange(() => { n++ })
    l.start()
    l.dispose()
    writeFileAtomic(userFile(), '{"a":2}')
    await sleep(200)
    assert.equal(n, 0)
  })

  it('the payload is plain JSON (it is posted to webviews and sent over SSE)', () => {
    put(userFile(), '{"a":{"b":[1,2,{"c":null}]}}')
    const p = mk().snapshot()
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
  })
})

describe('invalid JSON messages carry no file content (R1 finding 3)', () => {
  const SECRET = 'sk-ant-SECRET-DO-NOT-LEAK'
  const cases: [string, string][] = [
    ['unquoted value (V8 quotes an excerpt)', `{\n  "apiKey": ${SECRET}\n}`],
    ['same on one line', `{"apiKey": ${SECRET}}`],
    ['trailing comma', `{"apiKey": "${SECRET}",}`],
    ['trailing garbage', `{"apiKey": "${SECRET}"} ${SECRET}`],
    ['unterminated string', `{"apiKey": "${SECRET}`],
    ['missing colon', `{"apiKey" "${SECRET}"}`],
    ['bad literal in an array', `["${SECRET}", tru]`],
  ]

  for (const [name, text] of cases) {
    it(`${name}: the error has position, line and column and none of the text`, () => {
      put(userFile(), text)
      const u = readLayerFile(userFile(), 'user', { home })
      assert.equal(u.status, 'error')
      const msg = u.error!
      assert.match(msg, /^invalid JSON: /)
      assert.doesNotMatch(msg, /sk-ant|SECRET|apiKey|LEAK/, msg)
      assert.match(msg, /line \d+ column \d+, position \d+/, msg)
      // What goes out in the payload (banner + SSE) is clean too.
      const l = mk()
      assert.doesNotMatch(JSON.stringify(l.snapshot()), /sk-ant|SECRET|LEAK/)
    })
  }

  it('reports the real position, line and column of the first bad character', () => {
    put(userFile(), '{\n  "a": 1,\n  "b": nope\n}')
    const msg = readLayerFile(userFile(), 'user', { home }).error!
    // "nope" starts on line 3, column 8 (offset 8 + 11 = 19)
    assert.match(msg, /line 3 column 8, position 19$/, msg)
  })

  it('describeJsonError copes with older engines and unknown errors', () => {
    assert.equal(describeJsonError(new SyntaxError('Unexpected token } in JSON at position 7')), 'Unexpected token at position 7')
    assert.equal(describeJsonError(new SyntaxError('Unexpected token } in JSON at position 7'), 'abc\n{"a":}'), 'Unexpected token at line 2 column 4, position 7')
    assert.equal(describeJsonError(new SyntaxError(`Unexpected token 'x', "${SECRET}" is not valid JSON`)), 'Unexpected token')
    assert.equal(describeJsonError(new SyntaxError('Unexpected end of JSON input')), 'Unexpected end of input')
    assert.equal(describeJsonError('not an error'), 'Syntax error')
    // a file that embeds the parser's own wording cannot smuggle text through the numbers
    const msg = describeJsonError(new SyntaxError(`Unexpected token 'x', "${SECRET} in JSON at position 5 (line 1 column 6)" is not valid JSON`))
    assert.doesNotMatch(msg, /SECRET/)
  })
})

describe('writeConfig(user) and symlinks (R1 finding 4)', () => {
  it('a symlinked user file stays a symlink; the dotfile target gets the new content (0600, no temp files)', () => {
    const dot = path.join(root, 'dotfiles'); const target = path.join(dot, 'costs.json')
    put(target, '{"schemaVersion":1}\n')
    fs.chmodSync(target, 0o644)
    fs.mkdirSync(path.dirname(userFile()), { recursive: true })
    fs.symlinkSync(target, userFile())
    const l = mk()
    const r = l.writeConfig('user', { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.92 } } })
    assert.equal(fs.lstatSync(userFile()).isSymbolicLink(), true, 'the link was not replaced by a regular file')
    assert.equal(fs.readlinkSync(userFile()), target)
    assert.equal(r.path, target)
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.92 } } })
    assert.equal(fs.statSync(target).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(dot), ['costs.json'], 'the temp file lived in the real directory and is gone')
    assert.deepEqual(fs.readdirSync(path.dirname(userFile())), ['costs.json'], 'nothing was written next to the link')
    assert.equal(layer(l.snapshot(), 'user')!.status, 'ok')
    assert.deepEqual((layer(l.snapshot(), 'user')!.raw as { currency: unknown }).currency, { display: 'EUR', fx: { EUR: 0.92 } })
  })

  it('a chain of links is followed to the real file', () => {
    const real = path.join(root, 'repo', 'costs.json'); const mid = path.join(root, 'mid.json')
    put(real, '{}')
    fs.symlinkSync(real, mid)
    fs.mkdirSync(path.dirname(userFile()), { recursive: true })
    fs.symlinkSync(mid, userFile())
    mk().writeConfig('user', { schemaVersion: 1 })
    assert.equal(fs.lstatSync(userFile()).isSymbolicLink(), true)
    assert.equal(fs.lstatSync(mid).isSymbolicLink(), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { schemaVersion: 1 })
  })

  it('a dangling symlink is refused with a clear error and left as it was', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true })
    fs.symlinkSync(path.join(root, 'gone', 'costs.json'), userFile())
    const l = mk()
    assert.throws(() => l.writeConfig('user', { schemaVersion: 1 }), /symlink whose target cannot be resolved/)
    assert.throws(() => l.ensureUserFile(), /symlink whose target cannot be resolved/)
    assert.equal(fs.lstatSync(userFile()).isSymbolicLink(), true)
    assert.equal(fs.existsSync(path.join(root, 'gone')), false)
  })

  it('a symlink to a directory is refused', () => {
    const d = path.join(root, 'adir'); fs.mkdirSync(d)
    fs.mkdirSync(path.dirname(userFile()), { recursive: true })
    fs.symlinkSync(d, userFile())
    assert.throws(() => mk().writeConfig('user', { schemaVersion: 1 }), /not a regular file/)
    assert.deepEqual(fs.readdirSync(d), [])
  })

  it('ensureUserFile does not touch an existing symlinked file', () => {
    const target = path.join(root, 'dot', 'costs.json')
    put(target, '{"mine":1}')
    fs.mkdirSync(path.dirname(userFile()), { recursive: true })
    fs.symlinkSync(target, userFile())
    mk().ensureUserFile()
    assert.equal(fs.lstatSync(userFile()).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(target, 'utf8'), '{"mine":1}')
  })

  it('a regular or missing user file is written where it is (resolveUserWriteTarget is the identity)', () => {
    assert.equal(resolveUserWriteTarget(userFile(), home), userFile())
    put(userFile(), '{}')
    assert.equal(resolveUserWriteTarget(userFile(), home), userFile())
    mk().writeConfig('user', { schemaVersion: 1 })
    assert.equal(fs.lstatSync(userFile()).isFile(), true)
  })

  it('the project layer keeps its behaviour: a symlinked costs.json inside .agent-flow is replaced by a regular file', () => {
    fs.mkdirSync(path.dirname(projFile()), { recursive: true })
    put(path.join(path.dirname(projFile()), 'real.json'), '{"keep":1}')
    fs.symlinkSync('real.json', projFile())
    mk().writeConfig('project', { pricing: { multiplier: 2 } })
    assert.equal(fs.lstatSync(projFile()).isSymbolicLink(), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(projFile(), 'utf8')), { pricing: { multiplier: 2 } })
    assert.equal(fs.readFileSync(path.join(path.dirname(projFile()), 'real.json'), 'utf8'), '{"keep":1}', 'the old target is untouched')
  })
})

describe('file fingerprints and the base-version check on write (P4 review: the drawer must not wipe or roll back the file)', () => {
  it('a layer carries the fingerprint of the bytes read; it changes with the content and is stable otherwise', () => {
    put(userFile(), '{"schemaVersion":1}')
    const a = layer(mk().snapshot(), 'user')!
    assert.equal(a.status, 'ok')
    assert.equal(a.fingerprint, fingerprintBytes(Buffer.from('{"schemaVersion":1}')))
    assert.equal(layer(mk().snapshot(), 'user')!.fingerprint, a.fingerprint)
    put(userFile(), '{"schemaVersion":1,"display":{"unit":"tokens"}}')
    assert.notEqual(layer(mk().snapshot(), 'user')!.fingerprint, a.fingerprint)
  })

  it('a file that does not parse still reports its fingerprint; a missing file has none (the version is "missing")', () => {
    put(userFile(), '{ broken')
    const bad = layer(mk().snapshot(), 'user')!
    assert.equal(bad.status, 'error')
    assert.equal(bad.fingerprint, fingerprintBytes(Buffer.from('{ broken')))
    fs.rmSync(userFile())
    const gone = layer(mk().snapshot(), 'user')!
    assert.equal(gone.status, 'missing')
    assert.equal(gone.fingerprint, undefined)
    assert.equal(fileFingerprint(userFile()), MISSING_FINGERPRINT)
  })

  it('fileFingerprint equals the layer fingerprint for the same bytes, and follows a symlink like the reader does', () => {
    put(userFile(), '{"schemaVersion":1}\n')
    assert.equal(fileFingerprint(userFile()), layer(mk().snapshot(), 'user')!.fingerprint)
    const real = path.join(root, 'dotfiles', 'costs.json')
    put(real, '{"schemaVersion":1,"x":1}')
    fs.rmSync(userFile()); fs.symlinkSync(real, userFile())
    assert.equal(fileFingerprint(userFile()), fingerprintBytes(Buffer.from('{"schemaVersion":1,"x":1}')))
  })

  it('writeConfig with the current fingerprint writes and returns the new one', () => {
    put(userFile(), '{"schemaVersion":1}')
    const l = mk()
    const base = layer(l.snapshot(), 'user')!.fingerprint!
    const r = l.writeConfig('user', { schemaVersion: 1, display: { unit: 'tokens' } }, base)
    assert.equal(r.fingerprint, fileFingerprint(userFile()))
    assert.equal(layer(l.snapshot(), 'user')!.fingerprint, r.fingerprint)
    // the next save, based on what the first one returned, goes through too
    l.writeConfig('user', { schemaVersion: 1 }, r.fingerprint)
  })

  it('CHANGED ON DISK: the file was edited after the page loaded it, so the write is refused and the edit survives', () => {
    put(userFile(), '{"schemaVersion":1}')
    const l = mk()
    const base = layer(l.snapshot(), 'user')!.fingerprint!
    const edited = '{"schemaVersion":1,"pricing":{"models":[{"match":"x","input":1,"output":2}]}}\n'
    put(userFile(), edited)
    assert.throws(() => l.writeConfig('user', { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.9 } } }, base), (e: unknown) => e instanceof CostsConflictError && /changed since/.test(e.message))
    assert.equal(fs.readFileSync(userFile(), 'utf8'), edited, 'the hand edit is untouched')
    assert.deepEqual(fs.readdirSync(path.dirname(userFile())), ['costs.json'], 'no temp file left')
  })

  it('BROKEN FILE: a base taken from a broken file cannot be used to replace it with a minimal document', () => {
    put(userFile(), '{ "pricing": { oops')
    const l = mk()
    const broken = layer(l.snapshot(), 'user')!
    assert.equal(broken.status, 'error')
    // A stale client that kept the previous good fingerprint is refused...
    assert.throws(() => l.writeConfig('user', { schemaVersion: 1 }, fingerprintBytes(Buffer.from('{"schemaVersion":1}'))), CostsConflictError)
    // ...and so is one that thinks the file is missing.
    assert.throws(() => l.writeConfig('user', { schemaVersion: 1 }, MISSING_FINGERPRINT), CostsConflictError)
    assert.equal(fs.readFileSync(userFile(), 'utf8'), '{ "pricing": { oops')
  })

  it('MISSING then created: a writer that saw no file refuses once one appears, and writes when it is still absent', () => {
    const l = mk()
    assert.equal(layer(l.snapshot(), 'user')!.status, 'missing')
    put(userFile(), '{"schemaVersion":1,"currency":{"display":"EUR","fx":{"EUR":0.9}}}')
    assert.throws(() => l.writeConfig('user', { schemaVersion: 1 }, MISSING_FINGERPRINT), CostsConflictError)
    fs.rmSync(userFile())
    const r = l.writeConfig('user', { schemaVersion: 1 }, MISSING_FINGERPRINT)
    assert.equal(r.fingerprint, fileFingerprint(userFile()))
  })

  it('the project layer is checked the same way', () => {
    const l = mk()
    l.writeConfig('project', { pricing: { multiplier: 2 } }, MISSING_FINGERPRINT)
    const base = layer(l.snapshot(), 'project')!.fingerprint!
    put(projFile(), '{"pricing":{"multiplier":3}}')
    assert.throws(() => l.writeConfig('project', { pricing: { multiplier: 4 } }, base), CostsConflictError)
    assert.equal(fs.readFileSync(projFile(), 'utf8'), '{"pricing":{"multiplier":3}}')
  })

  it('without a base the old unconditional behaviour is kept for in-process callers', () => {
    put(userFile(), '{"keep":1}')
    mk().writeConfig('user', { schemaVersion: 1 })
    assert.equal(JSON.parse(fs.readFileSync(userFile(), 'utf8')).schemaVersion, 1)
  })
})

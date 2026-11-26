/**
 * P6a: limits-observer. Parsing, staleness ("as of"), expiry, unknown windows and the limits-update payload.
 * Temp HOME only.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildLimitsUpdate, classifyWindows, readNodeMissing, LimitsObserver, LIMITS_STALE_MS, limitsUpdateMessage, parseLimitsFile, readLimitsFile } from '../src/limits-observer'
import { installStatusLine, paths, type InstallerEnv } from '../src/statusline-installer'

const temps: string[] = []
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-lim-'))
  temps.push(root)
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: InstallerEnv = { home, nodePath: process.execPath, managedSettingsPaths: [path.join(root, 'none.json')], claudeConfigDir: path.join(home, '.claude') }
  return { env, p: paths(home) }
}
function writeLimits(p: ReturnType<typeof paths>, rec: unknown) {
  fs.mkdirSync(p.limitsDir, { recursive: true })
  fs.writeFileSync(p.limits, typeof rec === 'string' ? rec : JSON.stringify(rec))
}

const NOW = 1_900_000_000_000
const rec = (over: Record<string, unknown> = {}) => ({
  v: 1, at: NOW - 60_000, session_id: 's', model: { id: 'claude-opus-4-7' },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: (NOW + 3_600_000) / 1000 }, seven_day: { used_percentage: 41.2, resets_at: (NOW + 86_400_000) / 1000 } }, ...over,
})

describe('parseLimitsFile', () => {
  it('parses the shim format; resets_at seconds become ms; windows sorted five_hour, seven_day, others', () => {
    const r = parseLimitsFile(JSON.stringify(rec({ rate_limits: { zzz: { used_percentage: 1 }, seven_day: { used_percentage: 2, resets_at: 2000 }, five_hour: { used_percentage: 3, resets_at: 1000 } } })))
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.windows.map(w => [w.key, w.kind, w.usedPct, w.resetsAt]), [['five_hour', 'five_hour', 3, 1_000_000], ['seven_day', 'seven_day', 2, 2_000_000], ['zzz', 'other', 1, null]])
    assert.equal(r.modelId, 'claude-opus-4-7')
  })
  it('a resets_at that is already in ms is kept', () => {
    const r = parseLimitsFile(JSON.stringify(rec({ rate_limits: { five_hour: { used_percentage: 3, resets_at: 1_900_000_000_000 } } })))
    assert.equal(r.ok && r.windows[0].resetsAt, 1_900_000_000_000)
  })
  it('absent values stay unknown (null), never 0; windows with nothing are dropped', () => {
    const r = parseLimitsFile(JSON.stringify(rec({ rate_limits: { five_hour: { resets_at: 10 }, seven_day: {}, x: { used_percentage: -4 } } })))
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.windows.map(w => [w.key, w.usedPct]), [['five_hour', null]])
  })
  for (const [name, text, msg] of [
    ['not JSON', 'oops', /not valid JSON/], ['array', '[]', /not a JSON object/], ['null', 'null', /not a JSON object/],
    ['wrong version', JSON.stringify({ ...rec(), v: 2 }), /unknown version/], ['no timestamp', JSON.stringify({ ...rec(), at: 'x' }), /timestamp/],
    ['zero timestamp', JSON.stringify({ ...rec(), at: 0 }), /timestamp/], ['no rate_limits', JSON.stringify({ v: 1, at: 5 }), /no rate_limits/],
  ] as [string, string, RegExp][]) {
    it(`malformed (${name}): ok=false, message does not quote content`, () => {
      const r = parseLimitsFile(text)
      assert.equal(r.ok, false)
      if (!r.ok) { assert.match(r.error, msg); assert.equal(r.error.includes('oops'), false) }
    })
  }
  it('ignores a hostile model id', () => {
    const r = parseLimitsFile(JSON.stringify(rec({ model: { id: 'x y; rm' } })))
    assert.equal(r.ok && r.modelId, undefined)
  })
})

describe('readLimitsFile', () => {
  it('null when missing, error when unusable, parsed when fine', () => {
    const t = mk()
    assert.equal(readLimitsFile(t.p.limits), null)
    writeLimits(t.p, 'junk')
    assert.equal(readLimitsFile(t.p.limits)?.ok, false)
    writeLimits(t.p, rec())
    assert.equal(readLimitsFile(t.p.limits)?.ok, true)
  })
  it('refuses an oversized file without parsing it', () => {
    const t = mk()
    writeLimits(t.p, 'x'.repeat(70_000))
    const r = readLimitsFile(t.p.limits)
    assert.equal(r && !r.ok && r.error, 'the limits file is too large')
  })
  it('a directory in place of the file is an error, not a crash', () => {
    const t = mk()
    fs.mkdirSync(t.p.limits, { recursive: true })
    assert.equal(readLimitsFile(t.p.limits)?.ok, false)
  })
})

describe('classifyWindows: stale and expired', () => {
  const parsed = () => { const r = parseLimitsFile(JSON.stringify(rec())); assert.ok(r.ok); return r as Extract<typeof r, { ok: true }> }
  it('fresh within the limit', () => {
    const c = classifyWindows(parsed(), NOW)
    assert.equal(c.stale, false)
    assert.deepEqual(c.windows.map(w => w.state), ['fresh', 'fresh'])
  })
  it('stale just past the limit, with the percentages kept (shown with "as of")', () => {
    const c = classifyWindows(parsed(), NOW - 60_000 + LIMITS_STALE_MS + 1)
    assert.equal(c.stale, true)
    assert.deepEqual(c.windows.map(w => [w.state, w.usedPct]), [['stale', 23.5], ['stale', 41.2]])
  })
  it('exactly at the limit is still fresh', () => {
    assert.equal(classifyWindows(parsed(), NOW - 60_000 + LIMITS_STALE_MS).stale, false)
  })
  it('a window whose reset time has passed is expired: no value, even when the reading is fresh', () => {
    const c = classifyWindows(parsed(), NOW + 3_600_001)
    assert.deepEqual(c.windows.map(w => [w.key, w.state, w.usedPct]), [['five_hour', 'expired', null], ['seven_day', 'stale', 41.2]])
  })
  it('a clock set far into the past makes a reading look fresh but never negative-age crashes', () => {
    const c = classifyWindows(parsed(), NOW - 10 * 86_400_000)
    assert.equal(c.stale, false)
  })
})

describe('buildLimitsUpdate', () => {
  it('not installed, no file: observed null, canInstall true, no error', () => {
    const t = mk()
    const u = buildLimitsUpdate({ env: t.env, now: NOW, seq: 1, canConfigure: true })
    assert.equal(u.observed, null)
    assert.equal(u.install.state, 'not-installed')
    assert.equal(u.install.canInstall, true)
    assert.equal(u.fileError, undefined)
    assert.equal(u.canConfigure, true)
    assert.equal(u.source, 'statusline')
  })
  it('refusal is reported with its reason and keeps observed null (fall back to estimates)', () => {
    const t = mk()
    fs.mkdirSync(path.dirname(t.p.settings), { recursive: true })
    fs.writeFileSync(t.p.settings, JSON.stringify({ statusLine: { type: 'static', text: 'x' } }))
    const u = buildLimitsUpdate({ env: t.env, now: NOW, seq: 1, canConfigure: true })
    assert.equal(u.install.state, 'refused')
    assert.equal(u.install.canInstall, false)
    assert.equal(u.install.code, 'statusline-not-command')
    assert.equal(u.observed, null)
  })
  it('installed with a fresh reading', () => {
    const t = mk()
    installStatusLine(t.env)
    writeLimits(t.p, rec())
    const u = buildLimitsUpdate({ env: t.env, now: NOW, seq: 3, canConfigure: true })
    assert.equal(u.install.state, 'installed')
    assert.equal(u.observed?.stale, false)
    assert.equal(u.observed?.at, NOW - 60_000)
    assert.deepEqual(u.observed?.windows.map(w => [w.kind, w.usedPct, w.state]), [['five_hour', 23.5, 'fresh'], ['seven_day', 41.2, 'fresh']])
    assert.equal(u.seq, 3)
  })
  it('a leftover file without the wrapper is still shown (the person can uninstall later and see the old reading as stale)', () => {
    const t = mk()
    writeLimits(t.p, rec())
    const u = buildLimitsUpdate({ env: t.env, now: NOW + 3_600_000, seq: 1, canConfigure: false })
    assert.equal(u.install.state, 'not-installed')
    assert.equal(u.observed?.stale, true)
    assert.equal(u.canConfigure, false)
  })
  it('N1: a node-missing marker is reported while the wrapper is installed; legacy command is flagged', () => {
    const t = mk()
    installStatusLine(t.env)
    assert.equal(buildLimitsUpdate({ env: t.env, now: NOW, seq: 1, canConfigure: true }).nodeMissing, undefined)
    fs.mkdirSync(t.p.limitsDir, { recursive: true })
    fs.writeFileSync(t.p.nodeMissing, JSON.stringify({ v: 1, at: NOW - 5000 }))
    const u = buildLimitsUpdate({ env: t.env, now: NOW, seq: 1, canConfigure: true })
    assert.deepEqual(u.nodeMissing, { at: NOW - 5000 })
    assert.equal(u.install.legacy, undefined)
    assert.equal(JSON.stringify(u).includes(t.env.home), false, 'no absolute home path in the payload')
    // a marker without the wrapper is stale leftovers: ignored
    const n = mk()
    fs.mkdirSync(n.p.limitsDir, { recursive: true }); fs.writeFileSync(n.p.nodeMissing, JSON.stringify({ v: 1, at: NOW }))
    assert.equal(buildLimitsUpdate({ env: n.env, now: NOW, seq: 1, canConfigure: true }).nodeMissing, undefined)
    // legacy command
    const l = mk()
    installStatusLine({ ...l.env, platform: 'win32' })
    const li = buildLimitsUpdate({ env: l.env, now: NOW, seq: 1, canConfigure: true }).install
    assert.equal(li.state, 'installed'); assert.equal(li.legacy, true); assert.equal(li.canUpgrade, true)
  })
  it('readNodeMissing: json at, damaged file falls back to mtime, directory / missing = null, huge value rejected', () => {
    const t = mk()
    fs.mkdirSync(t.p.limitsDir, { recursive: true })
    assert.equal(readNodeMissing(t.p.nodeMissing), null)
    fs.writeFileSync(t.p.nodeMissing, '{"v":1,"at":1234567890123}')
    assert.deepEqual(readNodeMissing(t.p.nodeMissing), { at: 1234567890123 })
    fs.writeFileSync(t.p.nodeMissing, 'garbage')
    const m = readNodeMissing(t.p.nodeMissing)
    assert.ok(m && Math.abs(m.at - Date.now()) < 60_000)
    fs.writeFileSync(t.p.nodeMissing, '{"v":1,"at":9e99}')
    assert.ok(readNodeMissing(t.p.nodeMissing)!.at < 1e14)
    fs.rmSync(t.p.nodeMissing); fs.mkdirSync(t.p.nodeMissing)
    assert.equal(readNodeMissing(t.p.nodeMissing), null)
  })
  it('a malformed file gives fileError and no numbers', () => {
    const t = mk()
    writeLimits(t.p, '{ SECRET garbage')
    const u = buildLimitsUpdate({ env: t.env, now: NOW, seq: 1, canConfigure: true })
    assert.equal(u.observed, null)
    assert.equal(u.fileError, 'the limits file is not valid JSON')
    assert.equal(JSON.stringify(u).includes('SECRET'), false)
  })
  it('the payload contains no secrets, no settings content and shows home as ~ in shadow paths', () => {
    const t = mk()
    const ws = path.join(t.env.home, 'proj')
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'TOKEN=abc123 run' } }))
    const u = buildLimitsUpdate({ env: { ...t.env, workspaceDirs: [ws] }, now: NOW, seq: 1, canConfigure: true })
    assert.deepEqual(u.install.shadowedBy, [`~${path.sep}proj${path.sep}.claude${path.sep}settings.json`])
    assert.equal(JSON.stringify(u).includes('abc123'), false)
    assert.equal(limitsUpdateMessage(u).type, 'limits-update')
  })
})

describe('LimitsObserver', () => {
  it('publishes the first state, then only real changes (a reading, a stale transition), with increasing seq', () => {
    const t = mk()
    let now = NOW
    const obs = new LimitsObserver({ env: () => t.env, canConfigure: true, now: () => now })
    const seen: { seq: number; stale?: boolean; at?: number }[] = []
    obs.onChange(p => seen.push({ seq: p.seq, stale: p.observed?.stale, at: p.observed?.at }))
    obs.refresh()
    obs.refresh()
    assert.equal(seen.length, 1, 'no change, no publish')
    writeLimits(t.p, rec())
    obs.refresh()
    obs.refresh()
    assert.equal(seen.length, 2)
    now = NOW + LIMITS_STALE_MS + 100_000
    obs.refresh()
    assert.equal(seen.length, 3)
    assert.equal(seen[2].stale, true)
    assert.deepEqual(seen.map(s => s.seq), [1, 2, 3])
    assert.equal(obs.snapshot().seq, 3)
    obs.dispose()
  })
  it('a throwing listener does not stop the others', () => {
    const t = mk()
    const obs = new LimitsObserver({ env: () => t.env, canConfigure: true, now: () => NOW })
    let got = 0
    obs.onChange(() => { throw new Error('boom') })
    obs.onChange(() => { got++ })
    obs.refresh()
    assert.equal(got, 1)
  })
  it('start() is idempotent and dispose() stops the timer', () => {
    const t = mk()
    const obs = new LimitsObserver({ env: () => t.env, canConfigure: true, pollMs: 20 })
    obs.start(); obs.start()
    obs.dispose()
    assert.ok(obs.snapshot())
  })
})

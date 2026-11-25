import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyLimitsPayload, getLimits, parseLimitsPayload, resetLimitsRuntime, subscribeLimits } from './limits-runtime'

const good = () => ({
  version: 1, seq: 4, provider: 'claude', source: 'statusline', canConfigure: true,
  install: { state: 'installed', canInstall: false, shadowedBy: ['~/p/.claude/settings.json'] },
  observed: { at: 1_900_000_000_000, stale: false, modelId: 'claude-opus-4-7', windows: [{ key: 'five_hour', kind: 'five_hour', usedPct: 12.5, resetsAt: 1_900_003_600_000, state: 'fresh' }] },
})

beforeEach(() => resetLimitsRuntime())

test('a valid message is stored and subscribers are told', () => {
  let n = 0
  const off = subscribeLimits(() => { n++ })
  assert.equal(applyLimitsPayload(good()), true)
  assert.equal(getLimits()?.observed?.windows[0].usedPct, 12.5)
  assert.equal(n, 1)
  off()
})

test('the newest valid message wins, even with a lower seq (restarted host)', () => {
  applyLimitsPayload(good())
  applyLimitsPayload({ ...good(), seq: 1, observed: null })
  assert.equal(getLimits()?.seq, 1)
  assert.equal(getLimits()?.observed, null)
})

for (const [name, mutate] of [
  ['wrong version', (p: any) => { p.version = 2 }],
  ['no seq', (p: any) => { delete p.seq }],
  ['wrong provider', (p: any) => { p.provider = 'codex' }],
  ['install missing', (p: any) => { delete p.install }],
  ['install state unknown', (p: any) => { p.install.state = 'maybe' }],
  ['window kind unknown', (p: any) => { p.observed.windows[0].kind = 'x' }],
  ['window state unknown', (p: any) => { p.observed.windows[0].state = 'x' }],
  ['percentage not a number', (p: any) => { p.observed.windows[0].usedPct = '12' }],
  ['percentage negative', (p: any) => { p.observed.windows[0].usedPct = -1 }],
  ['percentage NaN', (p: any) => { p.observed.windows[0].usedPct = NaN }],
  ['resetsAt zero', (p: any) => { p.observed.windows[0].resetsAt = 0 }],
  ['at missing', (p: any) => { delete p.observed.at }],
  ['windows not an array', (p: any) => { p.observed.windows = {} }],
] as [string, (p: any) => void][]) {
  test(`malformed (${name}) is ignored and the previous state stays`, () => {
    applyLimitsPayload(good())
    const bad: any = good(); mutate(bad)
    assert.equal(applyLimitsPayload(bad), false)
    assert.equal(getLimits()?.seq, 4)
  })
}

test('non-objects are rejected', () => {
  for (const v of [null, undefined, 1, 'x', [], true]) assert.equal(parseLimitsPayload(v), null)
})

test('unknown extra fields are dropped and long strings are cut', () => {
  const p: any = good()
  p.secret = 'nope'; p.install.reason = 'r'.repeat(5000); p.observed.extra = 1; p.observed.windows[0].extra = 2
  const out = parseLimitsPayload(p)!
  assert.equal(JSON.stringify(out).includes('nope'), false)
  assert.equal('extra' in out.observed!, false)
  assert.equal('extra' in out.observed!.windows[0], false)
  assert.equal(out.install.reason!.length, 600)
})

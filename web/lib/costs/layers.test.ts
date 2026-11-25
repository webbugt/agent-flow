import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeIssue, emptyResolution, mergeRaw, resolveCostsLayers } from './layers'
import type { CostsConfigPayload, CostsLayer } from './layers'
import { activeCostsVersion, displayCurrency, formatDisplayMoney, getActiveCosts, setActiveCosts, subscribeActiveCosts, usdToDisplay } from './active'

const ok = (id: CostsLayer['id'], raw: Record<string, unknown>, path: string | null = id === 'settings' ? null : `~/.agent-flow/${id}.json`): CostsLayer => ({ id, path, status: 'ok', raw })
const missing = (id: CostsLayer['id']): CostsLayer => ({ id, path: null, status: 'missing' })
const payload = (layers: CostsLayer[], extra: Partial<CostsConfigPayload> = {}): CostsConfigPayload => ({ version: 1, seq: 1, enabled: true, layers, ...extra })

test('no content in any layer: defaults (null config), no errors', () => {
  const r = resolveCostsLayers(payload([missing('settings'), missing('user')]))
  assert.equal(r.config, null)
  assert.equal(r.source, 'defaults')
  assert.deepEqual(r.errors, [])
})

test('enabled=false ignores every layer', () => {
  const r = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 2 } })], { enabled: false, seq: 7 }))
  assert.equal(r.config, null)
  assert.equal(r.seq, 7)
})

test('a user file alone resolves through the P1 validator', () => {
  const r = resolveCostsLayers(payload([missing('settings'), ok('user', { pricing: { multiplier: 1.25 } })]))
  assert.equal(r.source, 'config')
  assert.equal(r.config!.pricing.multiplier, 1.25)
  assert.deepEqual(r.errors, [])
})

test('precedence: project > user > settings; objects deep-merge, scalars replace', () => {
  const r = resolveCostsLayers(payload([
    ok('settings', { currency: { display: 'EUR', fx: { EUR: 0.9 } }, display: { unit: 'money' } }),
    ok('user', { currency: { fx: { EUR: 0.92, CHF: 0.88 } }, pricing: { multiplier: 1.1 } }),
    ok('project', { pricing: { multiplier: 1.3 } }),
  ]))
  const c = r.config!
  assert.equal(c.pricing.multiplier, 1.3, 'project wins')
  assert.equal(c.currency.fx.EUR, 0.92, 'user beats settings')
  assert.equal(c.currency.fx.CHF, 0.88, 'sibling keys survive the merge')
  assert.equal(c.currency.display, 'EUR', 'untouched lower-layer value stays')
  assert.equal(c.display.unit, 'money')
  assert.deepEqual(r.errors, [])
})

test('pricing.models concatenate, highest layer first, so a project rule wins a tie', () => {
  const m = (n: number, model = 'claude-sonnet-4-*') => ({ match: { provider: 'anthropic', model }, rate: { input: n, output: n * 5 } })
  const r = resolveCostsLayers(payload([
    ok('user', { pricing: { models: [m(2), m(7, 'other-*')] } }),
    ok('project', { pricing: { models: [m(1)] } }),
  ]))
  const models = r.config!.pricing.models
  assert.equal(models.length, 3)
  assert.equal((models[0] as { rate: { input: number } }).rate.input, 1, 'project rule first')
})

test('arrays elsewhere are replaced, not merged (mergeRaw)', () => {
  const out = mergeRaw([{ a: { list: [1, 2] } }, { a: { list: [3] } }])
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { a: { list: [3] } })
})

test('mergeRaw does not modify its inputs and cannot be polluted through __proto__', () => {
  const lo = { x: { y: 1 } }
  const hi = JSON.parse('{"x":{"z":2},"__proto__":{"polluted":true}}')
  const out = mergeRaw([lo, hi])
  assert.deepEqual(lo, { x: { y: 1 } })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(Object.getPrototypeOf(out), null)
  assert.deepEqual({ ...(out.x as object) }, { y: 1, z: 2 })
})

test('a layer that fails validation is reported with its file and pointer and dropped', () => {
  const r = resolveCostsLayers(payload([
    ok('user', { pricing: { multiplier: 1.5 } }),
    ok('project', { pricing: { multiplier: -3 } }),
  ]))
  assert.equal(r.config!.pricing.multiplier, 1.5, 'the good layer still applies')
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].layer, 'project')
  assert.equal(r.errors[0].path, '/pricing/multiplier')
  assert.match(describeIssue(r.errors[0]), /\.agent-flow\/project\.json \/pricing\/multiplier:/)
})

test('invalid layer with a previous good copy: last good is used and flagged', () => {
  const first = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 1.5 } })], { seq: 1 }))
  const second = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 'x' } })], { seq: 2 }), first)
  assert.equal(second.config!.pricing.multiplier, 1.5)
  assert.equal(second.usingLastGood, true)
  assert.equal(second.errors.length > 0, true)
  assert.equal(second.seq, 2)
})

test('host-reported read error with a stale copy: the stale copy applies, the error is surfaced', () => {
  const stale: CostsLayer = { id: 'user', path: '~/.agent-flow/costs.json', status: 'error', error: 'invalid JSON: Unexpected token', stale: true, raw: { pricing: { multiplier: 1.5 } } }
  const r = resolveCostsLayers(payload([stale]))
  assert.equal(r.config!.pricing.multiplier, 1.5)
  assert.equal(r.usingLastGood, true)
  assert.deepEqual(r.errors.map(e => [e.layer, e.file, e.message]), [['user', '~/.agent-flow/costs.json', 'invalid JSON: Unexpected token']])
})

test('host-reported read error with no copy and no previous: defaults plus the error', () => {
  const r = resolveCostsLayers(payload([{ id: 'user', path: '~/x.json', status: 'error', error: 'invalid JSON: x' }]))
  assert.equal(r.config, null)
  assert.equal(r.errors.length, 1)
})

test('a deleted file (missing) drops the layer; it is not "last good"', () => {
  const first = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 1.5 } })]))
  const second = resolveCostsLayers(payload([missing('user')]), first)
  assert.equal(second.config, null)
  assert.equal(second.usingLastGood, false)
  assert.deepEqual(second.goodLayers, {})
})

const rules = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ match: { model: `${tag}-${i}` }, rate: { input: 1, output: 2 } }))

test('a layer-level currency without fx is a layer error; the other layers still apply', () => {
  const r = resolveCostsLayers(payload([ok('settings', { currency: { display: 'CHF' } }), ok('user', { pricing: { multiplier: 1.5 } })]))
  assert.equal(r.errors.length > 0, true)
  assert.equal(r.errors[0].layer, 'settings')
  assert.equal(r.config!.pricing.multiplier, 1.5)
})

test('cross-layer failure (each layer ok alone, 600 rules merged) keeps the previous merged config', () => {
  const first = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 1.5 } })]))
  const second = resolveCostsLayers(payload([
    ok('user', { pricing: { models: rules(300, 'a') } }),
    ok('project', { pricing: { models: rules(300, 'b') } }),
  ], { seq: 2 }), first)
  assert.equal(second.errors.length > 0, true)
  assert.equal(second.errors.every(e => e.layer === 'merged'), true, JSON.stringify(second.errors))
  assert.equal(second.config, first.config, 'previous merged config kept')
  assert.equal(second.usingLastGood, true)
  assert.equal(second.seq, 2)
})

test('cross-layer failure with nothing to keep falls back to defaults', () => {
  const r = resolveCostsLayers(payload([
    ok('user', { pricing: { models: rules(300, 'a') } }),
    ok('project', { pricing: { models: rules(300, 'b') } }),
  ]))
  assert.equal(r.config, null)
  assert.equal(r.source, 'defaults')
  assert.equal(r.errors[0].layer, 'merged')
})

test('validator warnings come through with their layer and are not errors', () => {
  const r = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 1 }, surprise: 1 })]))
  assert.equal(r.config !== null, true)
  assert.equal(r.errors.length, 0)
  assert.equal(r.warnings.length > 0, true)
  assert.equal(r.warnings[0].layer, 'user')
})

test('host warnings (ignored key) are carried', () => {
  const l = ok('project', { pricing: { multiplier: 1 } }); l.warnings = ['"configPath" is not allowed in a project file and was ignored']
  const r = resolveCostsLayers(payload([l]))
  assert.equal(r.warnings.some(w => /configPath/.test(w.message)), true)
})

test('poisoned keys never reach Object.prototype', () => {
  resolveCostsLayers(payload([ok('user', JSON.parse('{"pricing":{"__proto__":{"multiplier":9}}}'))]))
  assert.equal(({} as Record<string, unknown>).multiplier, undefined)
})

test('a fresh resolution does not alias the previous goodLayers map', () => {
  const a = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 2 } })]))
  const b = resolveCostsLayers(payload([ok('user', { pricing: { multiplier: 3 } })]), a)
  assert.equal(b.config!.pricing.multiplier, 3)
  assert.deepEqual(a.goodLayers.user, { pricing: { multiplier: 2 } })
  assert.equal(emptyResolution().config, null)
})

test('describeIssue names settings and document-level problems', () => {
  assert.match(describeIssue({ layer: 'settings', file: null, path: '', message: 'bad' }), /^VS Code settings \(document\): bad$/)
  assert.match(describeIssue({ layer: 'merged', file: null, path: '/currency/display', message: 'no fx' }), /^merged config \/currency\/display: no fx$/)
})

// ── active store ──

test('the active store: set, version, subscribe, USD conversion and money formatting', () => {
  const calls: number[] = []
  const off = subscribeActiveCosts(() => calls.push(activeCostsVersion()))
  setActiveCosts(null)
  assert.deepEqual(calls, [], 'no change, no notification')
  assert.equal(displayCurrency(), 'USD')
  assert.equal(usdToDisplay(2), 2)
  assert.equal(formatDisplayMoney(0.1234), '$0.123')
  assert.equal(formatDisplayMoney(0.0042), '$0.0042')
  assert.equal(formatDisplayMoney(0.5, true), '~$0.500')

  const r = resolveCostsLayers(payload([ok('user', { currency: { display: 'EUR', fx: { EUR: 0.5 } } })]))
  setActiveCosts(r.config)
  assert.equal(calls.length, 1)
  assert.equal(getActiveCosts(), r.config)
  assert.equal(displayCurrency(), 'EUR')
  assert.equal(usdToDisplay(2), 1)
  assert.match(formatDisplayMoney(0.1234), /€|EUR/)
  off()
  setActiveCosts(null)
  assert.equal(calls.length, 1, 'unsubscribed')
})

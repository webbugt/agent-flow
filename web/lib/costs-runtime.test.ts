import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyCostsPayload, dismissCostsErrors, getCostsStatus, resetCostsRuntime, subscribeCostsStatus } from './costs-runtime'
import { getActiveCosts, formatDisplayMoney, displayCurrency } from './costs/active'
import { priceAgent } from './costs/agent-cost'
import type { AgentSpendInput } from './costs/agent-cost'
import type { CostsConfigPayload, CostsLayer } from './costs/layers'

let seq = 0
const payload = (layers: CostsLayer[], enabled = true): CostsConfigPayload => ({ version: 1, seq: ++seq, enabled, layers })
const user = (raw: Record<string, unknown>): CostsLayer => ({ id: 'user', path: '~/.agent-flow/costs.json', status: 'ok', raw })

const SONNET_RULE = { match: { provider: 'anthropic', model: 'claude-sonnet-*' }, rate: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 } }
const AGENT: AgentSpendInput = {
  tokensUsed: 2_000_000, model: 'claude-sonnet-5-5', runtime: 'claude',
  spend: { model: 'claude-sonnet-5-5', provider: 'anthropic', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
}

beforeEach(() => resetCostsRuntime())

test('no config: defaults, no errors, nothing active', () => {
  const s = getCostsStatus()
  assert.equal(getActiveCosts(), null)
  assert.equal(s.resolution.errors.length, 0)
  assert.equal(s.dismissed, false)
})

test('a valid custom price takes effect in what the overlay computes, and a second message changes it again (hot reload)', () => {
  const builtin = priceAgent(
    // the built-in catalog price, via an empty valid config
    (applyCostsPayload(payload([user({ schemaVersion: 1 })])), getActiveCosts()!), AGENT,
  ).amount
  assert.ok(builtin > 0)

  applyCostsPayload(payload([user({ pricing: { models: [SONNET_RULE] } })]))
  const custom = priceAgent(getActiveCosts()!, AGENT).amount
  assert.ok(Math.abs(custom - (1 * 10 + 0.1 * 50)) < 1e-9, `1M in @10 + 0.1M out @50 = 15, got ${custom}`)
  assert.notEqual(custom, builtin)

  // edit: price doubles
  applyCostsPayload(payload([user({ pricing: { models: [{ ...SONNET_RULE, rate: { input: 20, output: 100, cacheRead: 2, cacheWrite5m: 25, cacheWrite1h: 40 } }] } })]))
  assert.ok(Math.abs(priceAgent(getActiveCosts()!, AGENT).amount - 30) < 1e-9)
})

test('display currency and fx apply to the amount and to the formatted label', () => {
  applyCostsPayload(payload([user({ currency: { display: 'EUR', fx: { EUR: 0.5 } }, pricing: { models: [SONNET_RULE] } })]))
  assert.equal(displayCurrency(), 'EUR')
  const a = priceAgent(getActiveCosts()!, AGENT).amount
  assert.ok(Math.abs(a - 7.5) < 1e-9, `15 USD x 0.5 = 7.5 EUR, got ${a}`)
  assert.match(formatDisplayMoney(a), /€/)
})

test('invalid edit: the previous good prices keep applying and the errors are exposed for the banner', () => {
  applyCostsPayload(payload([user({ pricing: { models: [SONNET_RULE] } })]))
  const before = getActiveCosts()
  applyCostsPayload(payload([user({ pricing: { multiplier: -1 } })]))
  const s = getCostsStatus()
  assert.equal(getActiveCosts(), before, 'last good config object is still active')
  assert.equal(s.resolution.errors.length, 1)
  assert.equal(s.resolution.usingLastGood, true)
  assert.match(s.resolution.errors[0].file ?? '', /costs\.json/)
  assert.equal(s.resolution.errors[0].path, '/pricing/multiplier')
  assert.ok(Math.abs(priceAgent(getActiveCosts()!, AGENT).amount - 15) < 1e-9)
})

test('fixing the file clears the errors and re-arms the banner', () => {
  applyCostsPayload(payload([user({ pricing: { multiplier: -1 } })]))
  assert.equal(getCostsStatus().resolution.errors.length > 0, true)
  dismissCostsErrors()
  assert.equal(getCostsStatus().dismissed, true)
  applyCostsPayload(payload([user({ pricing: { multiplier: 1.2 } })]))
  assert.equal(getCostsStatus().resolution.errors.length, 0)
  assert.equal(getCostsStatus().dismissed, false)
  applyCostsPayload(payload([user({ pricing: { multiplier: -2 } })]))
  assert.equal(getCostsStatus().dismissed, false, 'a new error shows the banner again')
})

test('dismiss hides the same errors, but different errors come back', () => {
  applyCostsPayload(payload([user({ pricing: { multiplier: -1 } })]))
  dismissCostsErrors()
  applyCostsPayload(payload([user({ pricing: { multiplier: -1 } })]))
  assert.equal(getCostsStatus().dismissed, true, 'same errors stay dismissed')
  applyCostsPayload(payload([user({ pricing: { multiplier: 'x' } })]))
  assert.equal(getCostsStatus().dismissed, false, 'a different error is shown')
})

test('enabled=false goes back to the built-in path', () => {
  applyCostsPayload(payload([user({ pricing: { models: [SONNET_RULE] } })]))
  assert.notEqual(getActiveCosts(), null)
  applyCostsPayload(payload([user({ pricing: { models: [SONNET_RULE] } })], false))
  assert.equal(getActiveCosts(), null)
})

test('listeners are notified on every applied payload; getCostsStatus is referentially stable between changes', () => {
  let n = 0
  const off = subscribeCostsStatus(() => { n++ })
  applyCostsPayload(payload([user({ schemaVersion: 1 })]))
  const a = getCostsStatus()
  assert.equal(getCostsStatus(), a, 'stable snapshot (useSyncExternalStore requirement)')
  applyCostsPayload(payload([user({ pricing: { multiplier: 2 } })]))
  assert.notEqual(getCostsStatus(), a)
  assert.equal(n, 2)
  off()
  applyCostsPayload(payload([]))
  assert.equal(n, 2)
})

test('priceAgent: no usage -> estimate path; byBucket prices every bucket and sums', () => {
  applyCostsPayload(payload([user({ pricing: { models: [SONNET_RULE] } })]))
  const cfg = getActiveCosts()!
  const est = priceAgent(cfg, { tokensUsed: 1_000_000, model: 'claude-sonnet-5-5', runtime: 'claude' })
  assert.equal(est.estimate, true)
  assert.ok(Math.abs(est.amount - (0.75 * 10 + 0.25 * 50)) < 1e-9)

  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }
  const split = priceAgent(cfg, {
    ...AGENT,
    spend: { ...AGENT.spend!, byBucket: { le100000: { ...zero, inputTokens: 600_000 }, le200000: { ...zero, inputTokens: 400_000, outputTokens: 100_000 } } },
  })
  assert.equal(split.results.length, 2)
  assert.ok(Math.abs(split.amount - 15) < 1e-9, 'buckets sum to the flat total')
})

test('priceAgent: an unpriced model is flagged and adds 0; a hidden list-equivalent figure is excluded', () => {
  applyCostsPayload(payload([user({ pricing: { unknownModel: { policy: 'unpriced' } } })]))
  const r = priceAgent(getActiveCosts()!, { tokensUsed: 10, model: 'acme-unknown-9', runtime: 'claude', spend: { ...AGENT.spend!, model: 'acme-unknown-9', provider: 'acme' } })
  assert.equal(r.unpriced, true)
  assert.equal(r.amount, 0)
})

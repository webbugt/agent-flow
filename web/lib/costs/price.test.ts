import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from './validate'
import {
  classifyBilling, costOfTokens, fxFactor, implicitCacheWrite, priceUsage, promptTokensOf, totalsByKind, unitsPerUsd,
} from './price'
import { buildCostTooltip } from './tooltip'
import type { ResolvedConfig, UsageTokens } from './types'

function cfg(raw: unknown): ResolvedConfig {
  const r = validateConfig(raw)
  assert.deepEqual(r.errors, [])
  return r.config as ResolvedConfig
}
const near = (a: number, b: number, msg = '') => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`)
const U = (p: Partial<UsageTokens> = {}): UsageTokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, ...p })

/** Hand-checkable rate: $10 in / $50 out / $1 read / $12.5 w5m / $20 w1h per MTok. */
const RULE = { match: { provider: 'acme', model: 'm' }, rate: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 } }
const BASE = { pricing: { providers: { acme: { billing: 'api' } }, models: [RULE] } }

test('costOfTokens: each bucket at its own rate, by hand', () => {
  const r = { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 }
  // 100k*10 + 20k*50 + 400k*1 + 10k*12.5 + 5k*20 = 1,000,000 + 1,000,000 + 400,000 + 125,000 + 100,000 = 2,625,000 / 1e6
  near(costOfTokens(r, U({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 400_000, cacheWrite5mTokens: 10_000, cacheWrite1hTokens: 5_000 })), 2.625)
  near(costOfTokens(r, U()), 0)
  // Missing write rates fall back to the input rate, and 1h falls back to 5m.
  near(costOfTokens({ input: 2, output: 4, cacheRead: 0.2, cacheWrite5m: null, cacheWrite1h: null }, U({ cacheWrite5mTokens: 1e6, cacheWrite1hTokens: 1e6 })), 4)
  near(costOfTokens({ input: 2, output: 4, cacheRead: 0.2, cacheWrite5m: 3, cacheWrite1h: null }, U({ cacheWrite1hTokens: 1e6 })), 3)
  assert.equal(promptTokensOf(U({ inputTokens: 1, cacheReadTokens: 2, cacheWrite5mTokens: 3, cacheWrite1hTokens: 4, outputTokens: 99 })), 10)
})

test('priceUsage with a user rule: billed, exact amount, components and formula', () => {
  const r = priceUsage(cfg(BASE), { provider: 'acme', model: 'm', usage: U({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 400_000, cacheWrite5mTokens: 10_000 }) })
  assert.equal(r.kind, 'billed'); assert.equal(r.source, 'user-rule'); assert.equal(r.currency, 'USD')
  near(r.amount, 2.525); near(r.nativeAmount, 2.525)
  near(r.components!.input, 1); near(r.components!.output, 1); near(r.components!.cacheRead, 0.4); near(r.components!.cacheWrite5m, 0.125)
  assert.equal(r.fx, null); assert.equal(r.hadReportedUsage, true); assert.equal(r.reason, null)
  assert.match(r.formula, /^\(100000\*10\.00 \+ 20000\*50\.00 \+ 400000\*1\.00 \+ 10000\*12\.50\) \/ 1e6 = \$2\.525$/)
})

test('pricing.multiplier and rule modifiers scale the displayed amount, not the native amount', () => {
  const c = cfg({ pricing: { multiplier: 1.5, providers: { acme: { billing: 'api' } }, models: [{ ...RULE, modifiers: { fast: 2 } }] } })
  const r = priceUsage(c, { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) })
  near(r.nativeAmount, 10); near(r.amount, 30); near(r.multiplier, 3)
  assert.match(r.formula, /x 3\.00 = \$30\.00/)
})

test('currency: native USD -> EUR display via manual fx; user EUR rate -> USD display needs fx too', () => {
  const eur = cfg({ currency: { display: 'EUR', fx: { EUR: 0.92 }, fxAsOf: '2026-11-23' }, ...BASE })
  const r = priceUsage(eur, { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) })
  assert.equal(r.currency, 'EUR'); assert.equal(r.nativeCurrency, 'USD'); near(r.nativeAmount, 10); near(r.amount, 9.2)
  assert.deepEqual(r.fx, { from: 'USD', to: 'EUR', factor: 0.92, asOf: '2026-11-23' })
  assert.match(r.formula, /x 0\.92 fx = €9\.20$/)
  // A rate written in CHF, shown in EUR: 1 USD = 0.88 CHF = 0.92 EUR -> 1 CHF = 0.92/0.88 EUR
  const chf = cfg({ currency: { display: 'EUR', fx: { EUR: 0.92, CHF: 0.88 } }, pricing: { providers: { acme: { billing: 'api' } }, models: [{ ...RULE, currency: 'CHF' }] } })
  const c = priceUsage(chf, { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) })
  assert.equal(c.nativeCurrency, 'CHF'); near(c.nativeAmount, 10); near(c.amount, 10 * 0.92 / 0.88)
  near(unitsPerUsd(chf, 'USD')!, 1); assert.equal(unitsPerUsd(chf, 'JPY'), null); assert.equal(unitsPerUsd(chf, 'toString'), null)
  near(fxFactor(chf, 'CHF', 'USD')!, 1 / 0.88); near(fxFactor(chf, 'USD', 'EUR')!, 0.92); assert.equal(fxFactor(chf, 'JPY'), null)
  // The validator blocks a missing fx, but a hand-built config must still not produce a wrong number.
  const broken = { ...eur, currency: { ...eur.currency, fx: Object.create(null) as Record<string, number> } }
  const b = priceUsage(broken, { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) })
  assert.equal(b.kind, 'unpriced'); assert.equal(b.amount, 0); assert.match(b.reason!, /no exchange rate for USD|no exchange rate for EUR/)
})

test('tiered pricing is selected by one request\'s prompt tokens (user tiers and the Haiku 5.5 catalog tier)', () => {
  const c = cfg({ pricing: { providers: { acme: { billing: 'api' } }, models: [{ match: { model: 'm' }, tiers: [{ maxPromptTokens: 100_000, rate: { input: 1, output: 2 } }, { rate: { input: 4, output: 8 } }] }] } })
  const small = priceUsage(c, { provider: 'acme', model: 'm', promptTokens: 100_000, usage: U({ inputTokens: 100_000, outputTokens: 1e6 }) })
  near(small.amount, 0.1 + 2)
  const big = priceUsage(c, { provider: 'acme', model: 'm', promptTokens: 100_001, usage: U({ inputTokens: 100_001, outputTokens: 1e6 }) })
  near(big.amount, 0.400004 + 8)
  assert.equal(big.pricing.tierIndex, 1)
  // Catalog: Claude Haiku 5.5 has a >100K tier (the amounts are the sheet's, see catalog.test).
  const cat = cfg({})
  const lo = priceUsage(cat, { provider: 'copilot', model: 'claude-haiku-5-5', promptTokens: 1000, usage: U({ inputTokens: 1e6 }) })
  const hi = priceUsage(cat, { provider: 'copilot', model: 'claude-haiku-5-5', promptTokens: 120_000, usage: U({ inputTokens: 1e6 }) })
  assert.ok(hi.amount > lo.amount, `${lo.amount} vs ${hi.amount}`)
  assert.equal(lo.pricing.tierIndex, 0); assert.equal(hi.pricing.tierIndex, 1)
  assert.equal(hi.pricing.tierMaxPromptTokens, null)
  // Without promptTokens the lowest tier applies (documented limit for cumulative totals).
  near(priceUsage(cat, { provider: 'copilot', model: 'claude-haiku-5-5', usage: U({ inputTokens: 1e6 }) }).amount, lo.amount)
})

test('billing kinds: api = billed, subscription / credits = list-equivalent, local = estimated, no usage = estimated', () => {
  const c = cfg({ pricing: { providers: { acme: { billing: 'api' }, sub: { billing: 'subscription' }, cred: { billing: 'credits' }, loc: { billing: 'local' }, mystery: {}, gratis: { billing: 'free' } }, models: ['acme', 'sub', 'cred', 'mystery', 'gratis'].map(p => ({ match: { provider: p, model: 'm' }, rate: { input: 10, output: 50 } })) } })
  const usage = U({ inputTokens: 1e6 })
  const kind = (provider: string, extra: object = {}) => priceUsage(c, { provider, model: 'm', usage, ...extra }).kind
  assert.equal(kind('acme'), 'billed')
  assert.equal(kind('sub'), 'list-equivalent')
  assert.equal(kind('cred'), 'list-equivalent')
  assert.equal(kind('mystery'), 'estimated')
  assert.equal(kind('loc'), 'estimated')
  assert.equal(priceUsage(c, { provider: 'gratis', model: 'm', usage }).amount, 0)
  assert.equal(kind('gratis'), 'billed')
  assert.equal(kind('acme', { usage: undefined, tokensUsed: 1e6 }), 'estimated', 'no reported usage -> estimate')
  assert.equal(classifyBilling('api', true, 'catalog'), 'billed')
  assert.equal(classifyBilling('api', true, 'fallback'), 'estimated', 'a guessed rate is never billed')
  assert.equal(classifyBilling('api', true, 'none'), 'unpriced')
  assert.equal(classifyBilling('local', true, 'none'), 'estimated')
  assert.equal(classifyBilling('subscription', false, 'catalog'), 'estimated')
  const local = priceUsage(c, { provider: 'loc', model: 'q', usage })
  assert.equal(local.amount, 0); assert.equal(local.pricing.rate, null)
})

test('estimate path: tokensUsed x blended (0.75 in + 0.25 out) rate', () => {
  const r = priceUsage(cfg(BASE), { provider: 'acme', model: 'm', tokensUsed: 2_000_000 })
  assert.equal(r.kind, 'estimated'); assert.equal(r.usage, null); assert.equal(r.tokensUsed, 2_000_000)
  near(r.blended!, 0.75 * 10 + 0.25 * 50); near(r.amount, 40)
  assert.equal(priceUsage(cfg(BASE), { provider: 'acme', model: 'm' }).amount, 0)
})

test('unpriced: policy unpriced is excluded from totals and says why; subscriptionValue=hide hides list-equivalent', () => {
  const c = cfg({ pricing: { unknownModel: { policy: 'unpriced' }, providers: { acme: { billing: 'api' }, sub: { billing: 'subscription' } }, models: [{ match: { provider: 'sub', model: 'm' }, rate: { input: 10, output: 50 } }] }, display: { subscriptionValue: 'hide' } })
  const un = priceUsage(c, { provider: 'acme', model: 'nope', usage: U({ inputTokens: 1e6 }) })
  assert.equal(un.kind, 'unpriced'); assert.equal(un.amount, 0); assert.equal(un.reason, 'no rate configured')
  const sub = priceUsage(c, { provider: 'sub', model: 'm', usage: U({ inputTokens: 1e6 }) })
  assert.equal(sub.kind, 'list-equivalent'); assert.equal(sub.hidden, true); near(sub.amount, 10)
  const billed = priceUsage(cfg(BASE), { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) })
  const t = totalsByKind([un, sub, billed])
  near(t.byKind.billed, 10); assert.equal(t.byKind['list-equivalent'], 0); assert.equal(t.hiddenSubscription, 1); assert.equal(t.unpriced, 1)
  assert.deepEqual(t.counts, { billed: 1, 'list-equivalent': 0, estimated: 0, unpriced: 1 })
})

test('totals never mix kinds', () => {
  const c = cfg({ pricing: { providers: { acme: { billing: 'api' }, sub: { billing: 'subscription' } }, models: [RULE, { ...RULE, match: { provider: 'sub', model: 'm' } }] } })
  const rs = [
    priceUsage(c, { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) }),
    priceUsage(c, { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) }),
    priceUsage(c, { provider: 'sub', model: 'm', usage: U({ inputTokens: 1e6 }) }),
    priceUsage(c, { provider: 'acme', model: 'm', tokensUsed: 1e6 }),
  ]
  const t = totalsByKind(rs)
  near(t.byKind.billed, 20); near(t.byKind['list-equivalent'], 10); near(t.byKind.estimated, 20)   // 1M tokens x (0.75*10 + 0.25*50) = $20
})

test('Copilot implicit cache write: >= 1024 uncached input, no reported write, Claude family, provider copilot', () => {
  assert.equal(implicitCacheWrite('copilot', 'sonnet', 5000, 0), 5000)
  assert.equal(implicitCacheWrite('copilot', 'sonnet', 1024, 0), 1024)
  assert.equal(implicitCacheWrite('copilot', 'sonnet', 1023, 0), 0)
  assert.equal(implicitCacheWrite('copilot', 'sonnet', 5000, 10), 0, 'a reported write wins')
  assert.equal(implicitCacheWrite('copilot', undefined, 5000, 0), 0, 'non-Claude models')
  assert.equal(implicitCacheWrite('anthropic', 'sonnet', 5000, 0), 0)
  assert.equal(implicitCacheWrite('copilot', 'sonnet', 5000, 0, false), 0, 'switched off')
  const on = cfg({}); const off = cfg({ pricing: { providers: { copilot: { implicitCacheWrite: false } } } })
  const usage = U({ inputTokens: 100_000, outputTokens: 1000 })
  const a = priceUsage(on, { provider: 'copilot', model: 'claude-sonnet-5-5', usage })
  const b = priceUsage(off, { provider: 'copilot', model: 'claude-sonnet-5-5', usage })
  assert.equal(a.inferredCacheWriteTokens, 100_000); assert.equal(a.usage!.inputTokens, 0); assert.equal(a.usage!.cacheWrite5mTokens, 100_000)
  assert.equal(b.inferredCacheWriteTokens, 0)
  assert.ok(a.amount > b.amount, 'the cache-write rate is above the input rate')
  assert.ok(buildCostTooltip(a, on).rows.find(r => r.id === 'inference')!.value.includes('inferred cache-write on 100,000 tokens'))
})

test('Claude via Copilot prices the 1h write at the 5m write rate (the Copilot sheet has no 1h rate)', () => {
  const r = priceUsage(cfg({}), { provider: 'copilot', model: 'claude-haiku-5-5', usage: U({ cacheWrite1hTokens: 1e6, cacheWrite5mTokens: 1 }) })
  near(r.components!.cacheWrite1h, r.pricing.rate!.cacheWrite5m!)
})

test('tooltip: provider, billing kind, model, rate source, rate, tokens, formula, result for a billed figure', () => {
  const c = cfg(BASE)
  const r = priceUsage(c, { provider: 'acme', model: 'm', usage: U({ inputTokens: 100_000, outputTokens: 20_000 }) })
  const t = buildCostTooltip(r, c)
  assert.deepEqual(t.rows.map(x => x.id), ['provider', 'billing-kind', 'model', 'rate-source', 'rate', 'tokens', 'formula', 'result'])
  const row = (id: string) => t.rows.find(x => x.id === id)!.value
  assert.equal(row('provider'), 'acme')
  assert.match(row('billing-kind'), /^billed:/)
  assert.equal(row('rate-source'), 'user rule #1')
  assert.match(row('rate'), /in 10\.00 · out 50\.00 · cache-read 1\.00/)
  assert.equal(row('tokens'), 'in 100,000 · out 20,000 · cr 0 · cw5 0 · cw1 0')
  assert.equal(row('result'), '$2.000')
  assert.equal(t.kind, 'billed'); assert.ok(t.footnotes[0].includes('verify against your invoice'))
})

test('tooltip states provider and kind for every billing mode (Webbugt decision 5)', () => {
  const c = cfg({})
  const u = U({ inputTokens: 1000, outputTokens: 100 })
  const sub = buildCostTooltip(priceUsage(c, { provider: 'claude-subscription-directsdk-experimental', model: 'claude-opus-5-5', usage: u }), c)
  assert.match(sub.rows[0].value, /claude-subscription-directsdk-experimental \(Claude subscription via Hermes\)/)
  assert.match(sub.rows[1].value, /^list-equivalent: subscription plan; value at list price, not what you were charged/)
  assert.match(sub.rows[3].value, /^catalog anthropic, asOf \d{4}-\d{2}-\d{2}/)
  const cp = buildCostTooltip(priceUsage(c, { provider: 'copilot', model: 'claude-haiku-5-5', usage: u }), c)
  assert.match(cp.rows[1].value, /^list-equivalent: AI-credits plan; allowance not subtracted; 1 credit = \$0\.01/)
  assert.ok(cp.footnotes.some(f => /code review and completions/.test(f)))
  const api = buildCostTooltip(priceUsage(c, { provider: 'anthropic', model: 'claude-opus-5-5', usage: u }), c)
  assert.match(api.rows[1].value, /^billed:/)
  const est = buildCostTooltip(priceUsage(c, { provider: 'anthropic', model: 'claude-opus-5-5', tokensUsed: 5000 }), c)
  assert.match(est.rows[1].value, /^estimated: no usage reported/)
  assert.ok(est.rows.find(x => x.id === 'result')!.value.startsWith('~'))
  const unk = buildCostTooltip(priceUsage(c, { provider: 'acme', model: 'zzz-9', usage: u }), c)
  assert.match(unk.rows[1].value, /^estimated: model not in the catalog/)
  assert.match(unk.rows[2].value, /unknown model/)
  assert.match(unk.rows.find(x => x.id === 'inference')!.value, /fallback rate/)
})

test('tooltip for a local model has the energy rows, marked pending until P5', () => {
  const c = cfg({ pricing: { providers: { ollama: { billing: 'local', energyProfile: 'box' } } }, energy: { profiles: { box: { powerW: { idle: 40, load: 200 }, pue: 1.2 } }, tariff: { currency: 'USD', flatPerKWh: 0.3 } } })
  const r = priceUsage(c, { provider: 'ollama', model: 'qwen3:32b', usage: U({ inputTokens: 1000, outputTokens: 100 }) })
  const t = buildCostTooltip(r, c)
  assert.deepEqual(t.rows.map(x => x.id), ['provider', 'billing-kind', 'model', 'rate-source', 'busy-time', 'power', 'attribution', 'tokens', 'kwh-formula', 'tariff', 'result'])
  const row = (id: string) => t.rows.find(x => x.id === id)!
  assert.match(row('billing-kind').value, /^estimated: configured power, not measured/)
  assert.match(row('power').value, /P_load 200 W · P_idle 40 W/)
  assert.equal(row('busy-time').pending, true)
  assert.match(row('attribution').value, /marginal · pue 1\.20/)
  assert.equal(t.footnotes[0], 'estimated from configured power, not measured')
})

test('tooltip shows fx and multiplier modifiers', () => {
  const c = cfg({ currency: { display: 'EUR', fx: { EUR: 0.92 }, fxAsOf: '2026-11-23' }, pricing: { multiplier: 1.2, providers: { acme: { billing: 'api' } }, models: [RULE] } })
  const t = buildCostTooltip(priceUsage(c, { provider: 'acme', model: 'm', usage: U({ inputTokens: 1e6 }) }), c)
  assert.equal(t.rows.find(x => x.id === 'modifiers')!.value, 'x1.20 · FX USD->EUR 0.92 (2026-11-23, manual)')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig, validateConfig, validateConfigText, parseHHMM, pointer, MAX_CONFIG_BYTES } from './validate'

const paths = (issues: { path: string }[]) => issues.map(i => i.path)
const errs = (raw: unknown) => validateConfig(raw).errors
const hasErr = (raw: unknown, path: string) => assert.ok(paths(errs(raw)).includes(path), `expected error at ${path}, got ${JSON.stringify(errs(raw))}`)

/** The v1 plan example, adapted to the v2 schema (EUR display, tiers, energy, limits). */
const FULL = {
  schemaVersion: 1,
  currency: { display: 'EUR', fx: { USD: 1, EUR: 0.92, CHF: 0.88 }, fxAsOf: '2026-11-23' },
  display: { unit: 'auto', decimals: 'auto', subscriptionValue: 'show' },
  pricing: {
    multiplier: 1.0,
    unknownModel: { policy: 'global-rate', globalRate: { input: 3, output: 15 } },
    providers: {
      anthropic: { billing: 'api', currency: 'USD' },
      'claude-subscription-directsdk-experimental': { billing: 'subscription', priceLike: 'anthropic', plan: 'max5x' },
      copilot: { billing: 'credits', implicitCacheWrite: true },
      ollama: { billing: 'local', energyProfile: 'rtx-box' },
      'llama.cpp': { billing: 'local' },
    },
    models: [
      { match: { provider: 'anthropic', model: 'claude-sonnet-4-*' }, rate: { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite5m: 3, cacheWrite1h: 4.8 }, currency: 'USD' },
      { match: { model: 'qwen3-*' }, billing: 'local', energyProfile: 'rtx-box' },
      { match: { model: 'claude-haiku-5-5' }, tiers: [{ maxPromptTokens: 100000, rate: { input: 0.1, output: 0.5 } }, { rate: { input: 0.5, output: 2.5 } }] },
      { match: { model: 'swiss-*' }, rate: { input: 1, output: 2 }, currency: 'CHF', modifiers: { fast: 1.5, dataResidency: 1.1 } },
    ],
  },
  energy: {
    profiles: { 'rtx-box': { powerW: { idle: 45, load: 320 }, throughput: { genTokPerSec: 60, prefillTokPerSec: 1500 }, pue: 1.0, attribution: 'marginal', measured: null } },
    tariff: { currency: 'EUR', flatPerKWh: 0.3, timeOfDay: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '22:00', to: '06:00', perKWh: 0.18 }], tz: 'Europe/Zagreb' },
  },
  limits: {
    claude: {
      plan: 'max5x', planMultiplierOfPro: 5,
      fiveHour: { enabled: true, budgetUsdEquiv: null },
      weekly: { enabled: true, budgetUsdEquiv: null, resetsAt: { dow: 'thu', time: '09:00', tz: 'Europe/Zagreb' } },
      fable: { enabled: true, shareOfWeekly: { lo: 0.5, point: 0.5, hi: 0.5 }, relativeWeight: { lo: 0.5, hi: 2 }, anchors: [{ at: '2026-11-20T10:00:00Z', observedPct: 0.4 }] },
      weights: { fable: 1, mythos: 1, opus: 1, sonnet: 1, haiku: 1 },
      sources: ['statusline', 'estimate'],
    },
  },
}

test('the full example config validates with no errors and no warnings; defaults are filled in', () => {
  const r = validateConfig(FULL)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(r.ok, true)
  const c = r.config!
  assert.equal(c.currency.display, 'EUR')
  assert.equal(c.currency.fx.EUR, 0.92)
  assert.equal(c.pricing.models.length, 4)
  assert.equal(c.pricing.providers.copilot.implicitCacheWrite, true)
  assert.equal(c.energy.profiles['rtx-box'].powerW.load, 320)
  assert.equal(c.limits.claude.plan, 'max5x')
  assert.deepEqual(c.limits.claude.countProviders, ['claude-subscription-directsdk-experimental', 'anthropic'])
})

test('no file (null / undefined / empty text) yields the built-in defaults', () => {
  for (const raw of [null, undefined]) {
    const r = validateConfig(raw)
    assert.equal(r.ok, true)
    assert.deepEqual(JSON.parse(JSON.stringify(r.config)), JSON.parse(JSON.stringify(defaultConfig())))
  }
  const t = validateConfigText('  \n')
  assert.equal(t.ok, true)
  assert.equal(t.warnings.length, 1)
  const d = defaultConfig()
  assert.equal(d.currency.display, 'USD')
  assert.equal(d.pricing.unknownModel.policy, 'provider-default')
  assert.equal(d.display.subscriptionValue, 'show')
})

test('H0 config fixtures: C-default and C-eur are valid, C-invalid has two JSON-pointer errors', () => {
  assert.equal(validateConfig(null).ok, true)
  assert.equal(validateConfig({ currency: { display: 'EUR', fx: { EUR: 0.92 }, fxAsOf: '2026-11-25' } }).ok, true)
  const bad = validateConfig({ currency: { display: 3 }, pricing: { unknownModel: { policy: 'nonsense' } } })
  assert.equal(bad.ok, false)
  assert.equal(bad.config, null)
  assert.deepEqual(paths(bad.errors).sort(), ['/currency/display', '/pricing/unknownModel/policy'])
})

test('numeric bounds: negative, NaN, Infinity, > 10000, non-number; multiplier 0 and 11', () => {
  const rate = (r: unknown) => ({ pricing: { providers: { anthropic: { rate: r } } } })
  hasErr(rate({ input: -1, output: 1 }), '/pricing/providers/anthropic/rate/input')
  hasErr(rate({ input: Number.NaN, output: 1 }), '/pricing/providers/anthropic/rate/input')
  hasErr(rate({ input: 1, output: Number.POSITIVE_INFINITY }), '/pricing/providers/anthropic/rate/output')
  hasErr(rate({ input: 1, output: 10_001 }), '/pricing/providers/anthropic/rate/output')
  hasErr(rate({ input: '3', output: 1 }), '/pricing/providers/anthropic/rate/input')
  hasErr(rate({ input: 1, output: 1, cacheRead: -0.1 }), '/pricing/providers/anthropic/rate/cacheRead')
  hasErr(rate({ output: 1 }), '/pricing/providers/anthropic/rate/input')
  assert.equal(validateConfig(rate({ input: 0, output: 10_000 })).ok, true, '0 and 10000 are inclusive bounds')
  hasErr({ pricing: { multiplier: 0 } }, '/pricing/multiplier')
  hasErr({ pricing: { multiplier: 11 } }, '/pricing/multiplier')
  hasErr({ pricing: { multiplier: -1 } }, '/pricing/multiplier')
  assert.equal(validateConfig({ pricing: { multiplier: 10 } }).ok, true)
  assert.equal(validateConfig({ pricing: { multiplier: 0.01 } }).ok, true)
})

test('currency codes, fx and fxAsOf', () => {
  hasErr({ currency: { display: 'eur' } }, '/currency/display')
  hasErr({ currency: { display: 'EURO' } }, '/currency/display')
  hasErr({ currency: { fx: { eur: 1 } } }, '/currency/fx/eur')
  hasErr({ currency: { fx: { EUR: 0 } } }, '/currency/fx/EUR')
  hasErr({ currency: { fx: { USD: 2 } } }, '/currency/fx/USD')
  hasErr({ currency: { fxAsOf: '2026-13-01' } }, '/currency/fxAsOf')
  hasErr({ currency: { fxAsOf: '23/11/2026' } }, '/currency/fxAsOf')
  // Missing fx is a validation error (display and rule currencies).
  hasErr({ currency: { display: 'EUR' } }, '/currency/display')
  hasErr({ pricing: { models: [{ match: { model: 'x' }, rate: { input: 1, output: 1 }, currency: 'CHF' }] } }, '/pricing/models/0/currency')
  hasErr({ pricing: { providers: { acme: { currency: 'CHF' } } } }, '/pricing/providers/acme/currency')
  hasErr({ energy: { tariff: { currency: 'GBP', flatPerKWh: 0.3 } } }, '/energy/tariff/currency')
  assert.equal(validateConfig({ currency: { display: 'USD' } }).ok, true, 'USD needs no fx')
})

test('tiers: boundary membership, ascending, exactly one open-ended last tier, rate xor tiers', () => {
  const tiers = (t: unknown) => ({ pricing: { models: [{ match: { model: 'm' }, tiers: t }] } })
  const R = { input: 1, output: 2 }
  assert.equal(validateConfig(tiers([{ maxPromptTokens: 100_000, rate: R }, { rate: R }])).ok, true)
  assert.equal(validateConfig(tiers([{ maxPromptTokens: 100_000, rate: R }, { maxPromptTokens: 272_000, rate: R }, { rate: R }])).ok, true)
  assert.equal(validateConfig(tiers([{ rate: R }])).ok, true, 'a single open tier is flat pricing')
  hasErr(tiers([{ maxPromptTokens: 150_000, rate: R }, { rate: R }]), '/pricing/models/0/tiers/0/maxPromptTokens')
  assert.match(errs(tiers([{ maxPromptTokens: 150_000, rate: R }, { rate: R }]))[0].message, /100000, 200000, 272000/)
  hasErr(tiers([{ maxPromptTokens: 200_000, rate: R }, { maxPromptTokens: 100_000, rate: R }, { rate: R }]), '/pricing/models/0/tiers/1/maxPromptTokens')
  hasErr(tiers([{ maxPromptTokens: 100_000, rate: R }, { maxPromptTokens: 100_000, rate: R }, { rate: R }]), '/pricing/models/0/tiers/1/maxPromptTokens')
  hasErr(tiers([{ maxPromptTokens: 100_000, rate: R }, { maxPromptTokens: 200_000, rate: R }]), '/pricing/models/0/tiers/1/maxPromptTokens')
  hasErr(tiers([{ rate: R }, { maxPromptTokens: 100_000, rate: R }]), '/pricing/models/0/tiers/0/maxPromptTokens')
  hasErr(tiers([]), '/pricing/models/0/tiers')
  hasErr(tiers([{ maxPromptTokens: 100_000, rate: { input: -1, output: 1 } }, { rate: R }]), '/pricing/models/0/tiers/0/rate/input')
  hasErr({ pricing: { models: [{ match: { model: 'm' }, rate: R, tiers: [{ rate: R }] }] } }, '/pricing/models/0')
})

test('model rules: match is required and needs provider and/or model; an empty rule is rejected', () => {
  hasErr({ pricing: { models: [{ rate: { input: 1, output: 1 } }] } }, '/pricing/models/0/match')
  hasErr({ pricing: { models: [{ match: {}, rate: { input: 1, output: 1 } }] } }, '/pricing/models/0/match')
  hasErr({ pricing: { models: [{ match: { model: 'x' } }] } }, '/pricing/models/0')
  hasErr({ pricing: { models: [{ match: { model: 'x' }, billing: 'barter' }] } }, '/pricing/models/0/billing')
  hasErr({ pricing: { models: [{ match: { model: 'x' }, rate: { input: 1, output: 1 }, modifiers: { fast: 0 } }] } }, '/pricing/models/0/modifiers/fast')
  hasErr({ pricing: { models: 'nope' } }, '/pricing/models')
  hasErr({ pricing: { models: new Array(501).fill({ match: { model: 'x' }, billing: 'api' }) } }, '/pricing/models')
  hasErr({ pricing: { unknownModel: { policy: 'global-rate' } } }, '/pricing/unknownModel/globalRate')
})

test('prototype pollution: __proto__, constructor and prototype keys are rejected at any depth, from JSON text', () => {
  const texts = [
    '{"__proto__":{"polluted":true}}',
    '{"pricing":{"providers":{"__proto__":{"billing":"api"}}}}',
    '{"pricing":{"models":[{"match":{"model":"x"},"rate":{"input":1,"output":1,"__proto__":{"x":1}}}]}}',
    '{"pricing":{"providers":{"constructor":{"billing":"api"}}}}',
    '{"energy":{"profiles":{"prototype":{}}}}',
    '{"limits":{"claude":{"weights":{"__proto__":{"fable":9}}}}}',
  ]
  for (const t of texts) {
    const r = validateConfigText(t)
    assert.equal(r.ok, false, t)
    assert.equal(r.config, null, t)
    assert.ok(r.errors.some(e => /forbidden key/.test(e.message)), t)
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(({} as Record<string, unknown>).x, undefined)
  const r = validateConfigText(texts[1])
  assert.deepEqual(paths(r.errors), ['/pricing/providers/__proto__'])
})

test('validated dictionaries are null-prototype objects and a JSON pointer escapes ~ and /', () => {
  const c = validateConfig(FULL).config!
  for (const d of [c.currency.fx, c.pricing.providers, c.energy.profiles]) assert.equal(Object.getPrototypeOf(d), null)
  assert.equal(pointer(['a/b', 'c~d', 0]), '/a~1b/c~0d/0')
  hasErr({ pricing: { providers: { 'a/b': { billing: 'api' } } } }, '/pricing/providers/a~1b')
  // A lookup of an inherited name on a null-prototype dictionary finds nothing.
  assert.equal((c.pricing.providers as Record<string, unknown>)['toString'], undefined)
})

test('size cap, invalid JSON, non-object documents, deep nesting', () => {
  const big = JSON.stringify({ pricing: { providers: { anthropic: { plan: 'x'.repeat(MAX_CONFIG_BYTES) } } } })
  const r = validateConfigText(big)
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /bytes; the limit is 262144/)
  assert.equal(validateConfigText('{not json').ok, false)
  assert.equal(validateConfigText('{not json').errors[0].path, '')
  assert.equal(validateConfig([]).ok, false)
  assert.equal(validateConfig('x').ok, false)
  assert.equal(validateConfig(5).ok, false)
  let deep: unknown = {}
  for (let i = 0; i < 40; i++) deep = { a: deep }
  assert.equal(validateConfig(deep).ok, false)
  // Multi-byte text is measured in bytes, not characters.
  assert.equal(validateConfigText(`{"$schema":"${'é'.repeat(MAX_CONFIG_BYTES / 2 + 1)}"}`).ok, false)
})

test('unknown keys are warnings, not failures; schemaVersion must be 1', () => {
  const r = validateConfig({ schemaVersion: 1, mystery: 1, pricing: { multiplier: 2, extra: true, providers: { anthropic: { billing: 'api', colour: 'red' } } } })
  assert.equal(r.ok, true)
  assert.deepEqual(paths(r.warnings).sort(), ['/mystery', '/pricing/extra', '/pricing/providers/anthropic/colour'])
  assert.equal(r.config!.pricing.multiplier, 2)
  hasErr({ schemaVersion: 2 }, '/schemaVersion')
  hasErr({ schemaVersion: '1' }, '/schemaVersion')
  // Codex is out of scope: its limits block is a warning, not an error.
  const codex = validateConfig({ limits: { codex: { plan: 'plus' } } })
  assert.equal(codex.ok, true)
  assert.deepEqual(paths(codex.warnings), ['/limits/codex'])
})

test('providers: id shape, billing enum, priceLike', () => {
  hasErr({ pricing: { providers: { 'bad id': { billing: 'api' } } } }, '/pricing/providers/bad id')
  hasErr({ pricing: { providers: { x: { billing: 'free-ish' } } } }, '/pricing/providers/x/billing')
  hasErr({ pricing: { providers: { x: { priceLike: 'openai' } } } }, '/pricing/providers/x/priceLike')
  hasErr({ pricing: { providers: { x: { implicitCacheWrite: 'yes' } } } }, '/pricing/providers/x/implicitCacheWrite')
  for (const b of ['api', 'subscription', 'credits', 'local', 'free', 'unknown']) {
    assert.equal(validateConfig({ pricing: { providers: { x: { billing: b } } } }).ok, true, b)
  }
  assert.equal(validateConfig({ pricing: { providers: { 'llama.cpp': { billing: 'local' } } } }).ok, true)
})

test('energy: powerW, throughput, pue, attribution, unknown profile reference is a warning', () => {
  const prof = (p: unknown) => ({ energy: { profiles: { box: p } } })
  hasErr(prof({ powerW: { idle: 100, load: 50 } }), '/energy/profiles/box/powerW/load')
  hasErr(prof({ powerW: { idle: -1, load: 50 } }), '/energy/profiles/box/powerW/idle')
  hasErr(prof({}), '/energy/profiles/box/powerW')
  hasErr(prof({ powerW: { idle: 1, load: 2 }, pue: 0.5 }), '/energy/profiles/box/pue')
  hasErr(prof({ powerW: { idle: 1, load: 2 }, attribution: 'half' }), '/energy/profiles/box/attribution')
  hasErr(prof({ powerW: { idle: 1, load: 2 }, throughput: { genTokPerSec: 0, prefillTokPerSec: 5 } }), '/energy/profiles/box/throughput/genTokPerSec')
  const w = validateConfig({ ...prof({ powerW: { idle: 1, load: 2 }, measured: { source: 'nvml' } }), pricing: { providers: { ollama: { billing: 'local', energyProfile: 'missing' } } } })
  assert.equal(w.ok, true)
  assert.deepEqual(paths(w.warnings).sort(), ['/energy/profiles/box/measured', '/pricing/providers/ollama/energyProfile'])
})

test('tariff windows: HH:MM, from != to, midnight wrap, overlap detection, time zone', () => {
  const tariff = (w: unknown[], extra: object = {}) => ({ energy: { tariff: { flatPerKWh: 0.3, timeOfDay: w, ...extra } } })
  const win = (days: string[], from: string, to: string) => ({ days, from, to, perKWh: 0.1 })
  assert.equal(validateConfig(tariff([win(['mon'], '22:00', '06:00')])).ok, true, 'midnight wrap is allowed')
  assert.equal(validateConfig(tariff([win(['mon'], '22:00', '24:00'), win(['tue'], '00:00', '06:00')])).ok, true)
  hasErr(tariff([win(['mon'], '25:00', '06:00')]), '/energy/tariff/timeOfDay/0/from')
  hasErr(tariff([win(['mon'], '9:00', '06:00')]), '/energy/tariff/timeOfDay/0/from')
  hasErr(tariff([win(['mon'], '10:00', '10:00')]), '/energy/tariff/timeOfDay/0/to')
  hasErr(tariff([win(['monday'], '10:00', '11:00')]), '/energy/tariff/timeOfDay/0/days/0')
  hasErr(tariff([win([], '10:00', '11:00')]), '/energy/tariff/timeOfDay/0/days')
  hasErr(tariff([win(['mon'], '08:00', '12:00'), win(['mon'], '11:00', '14:00')]), '/energy/tariff/timeOfDay/1')
  // A wrapping window spills onto the next day: mon 22:00-06:00 overlaps tue 05:00-07:00.
  hasErr(tariff([win(['mon'], '22:00', '06:00'), win(['tue'], '05:00', '07:00')]), '/energy/tariff/timeOfDay/1')
  assert.equal(validateConfig(tariff([win(['mon'], '08:00', '12:00'), win(['mon'], '12:00', '14:00')])).ok, true, 'adjacent is not overlapping')
  assert.equal(validateConfig(tariff([win(['mon'], '08:00', '12:00'), win(['tue'], '08:00', '12:00')])).ok, true)
  hasErr(tariff([], { tz: 'Mars/Olympus' }), '/energy/tariff/tz')
  assert.equal(validateConfig(tariff([], { tz: 'Europe/Zagreb' })).ok, true)
  hasErr({ energy: { tariff: { timeOfDay: [] } } }, '/energy/tariff/flatPerKWh')
  assert.equal(parseHHMM('23:59'), 1439)
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM('24:00', true), 1440)
  assert.equal(parseHHMM('ab:cd'), null)
})

test('limits: plan enum, fable share scalar or band, anchors, weights, sources, reset schedule', () => {
  const claude = (c: unknown) => ({ limits: { claude: c } })
  hasErr(claude({ plan: 'platinum' }), '/limits/claude/plan')
  hasErr(claude({ fiveHour: { budgetUsdEquiv: -3 } }), '/limits/claude/fiveHour/budgetUsdEquiv')
  hasErr(claude({ fable: { shareOfWeekly: 1.5 } }), '/limits/claude/fable/shareOfWeekly')
  hasErr(claude({ fable: { shareOfWeekly: { lo: 0.6, point: 0.5, hi: 0.7 } } }), '/limits/claude/fable/shareOfWeekly')
  hasErr(claude({ fable: { relativeWeight: { lo: 3, hi: 2 } } }), '/limits/claude/fable/relativeWeight')
  hasErr(claude({ fable: { anchors: [{ at: 'yesterday', observedPct: 1 }] } }), '/limits/claude/fable/anchors/0/at')
  hasErr(claude({ fable: { anchors: [{ at: '2026-11-20T10:00:00Z', observedPct: 120 }] } }), '/limits/claude/fable/anchors/0/observedPct')
  hasErr(claude({ weights: { fable: -1 } }), '/limits/claude/weights/fable')
  hasErr(claude({ sources: ['oracle'] }), '/limits/claude/sources/0')
  hasErr(claude({ weekly: { resetsAt: { dow: 'thu', time: '9am', tz: 'Europe/Zagreb' } } }), '/limits/claude/weekly/resetsAt/time')
  const scalar = validateConfig(claude({ plan: 'api', fable: { shareOfWeekly: 0.4 } })).config!
  assert.deepEqual(scalar.limits.claude.fable.shareOfWeekly, { lo: 0.4, point: 0.4, hi: 0.4 })
  assert.equal(scalar.limits.claude.plan, 'api')
  assert.deepEqual(scalar.limits.claude.fable.relativeWeight, { lo: 0.5, hi: 2 })
})

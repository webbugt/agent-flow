import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_ROWS, ANTHROPIC_ROWS, COPILOT_ROWS, FAMILY_CURRENT, lookupModel, normalizeModelId, resolveRate,
  cacheReadMultiplier, blendedRateForModel, blendedRateForFamily,
} from './catalog'
import { TIER_BOUNDARIES, promptBucket } from './tiers'
import type { CatalogRow } from './types'

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`)
const get = (rows: readonly CatalogRow[], id: string): CatalogRow => {
  const row = rows.find(r => r.id === id)
  assert.ok(row, `missing row ${id}`)
  return row
}

test('every catalog row has a source URL, a verification date and a normalised, unique id', () => {
  const seen = new Set<string>()
  for (const row of ALL_ROWS) {
    assert.match(row.source, /^https:\/\/\S+$/, `${row.id} source`)
    assert.match(row.asOf, /^\d{4}-\d{2}-\d{2}$/, `${row.id} asOf`)
    assert.ok(Number.isFinite(Date.parse(row.asOf)), `${row.id} asOf is a date`)
    assert.equal(normalizeModelId(row.id), row.id, `${row.id} is normalised`)
    const key = `${row.section}/${row.id}`
    assert.ok(!seen.has(key), `duplicate ${key}`)
    seen.add(key)
    assert.ok(row.tiers.length >= 1)
    assert.equal(row.tiers[row.tiers.length - 1].maxPromptTokens, null, `${row.id} last tier is unbounded`)
    if (row.validUntil) assert.match(row.validUntil, /^\d{4}-\d{2}-\d{2}$/)
    if (row.afterRate) assert.ok(row.validUntil, `${row.id} afterRate needs validUntil`)
  }
  assert.ok(ANTHROPIC_ROWS.every(r => r.source.startsWith('https://platform.claude.com/')))
  assert.ok(COPILOT_ROWS.every(r => r.source.startsWith('https://docs.github.com/')))
})

test('tier thresholds are members of TIER_BOUNDARIES and ascend', () => {
  for (const row of ALL_ROWS) {
    let prev = 0
    for (const t of row.tiers) {
      if (t.maxPromptTokens === null) continue
      assert.ok(TIER_BOUNDARIES.includes(t.maxPromptTokens), `${row.section}/${row.id} threshold ${t.maxPromptTokens}`)
      assert.ok(t.maxPromptTokens > prev, `${row.id} tiers ascend`)
      prev = t.maxPromptTokens
    }
  }
  assert.equal(promptBucket(100_000), 'le100000')
  assert.equal(promptBucket(100_001), 'le200000')
  assert.equal(promptBucket(272_000), 'le272000')
  assert.equal(promptBucket(272_001), 'gt272000')
})

test('Anthropic sheet covers every model on the vendor page (2026-11-25)', () => {
  const expected = [
    'fable-5-2', 'mythos-5-2', 'fable-5-1', 'mythos-5-1', 'fable-5', 'mythos-5',
    'opus-5-5', 'opus-5', 'opus-4-8', 'opus-4-7', 'opus-4-6', 'opus-4-5', 'opus-4-1', 'opus-4',
    'sonnet-5-5', 'sonnet-5', 'sonnet-4-6', 'sonnet-4-5', 'sonnet-4', 'haiku-5-5', 'haiku-4-5',
  ].map(s => `claude-${s}`)
  for (const id of expected) get(ANTHROPIC_ROWS, id)
  assert.equal(ANTHROPIC_ROWS.filter(r => !r.id.endsWith('-fast')).length, expected.length)
})

test('Anthropic per-model cache multipliers: read 0.1 / 0.05 / 0.025, 5m write 1.25x, 1h write 2x', () => {
  const readMult: Record<string, number> = {
    'claude-fable-5-2': 0.025, 'claude-mythos-5-2': 0.025, 'claude-fable-5-1': 0.025, 'claude-mythos-5-1': 0.025,
    'claude-opus-5-5': 0.05, 'claude-sonnet-5-5': 0.05,
  }
  for (const row of ANTHROPIC_ROWS) {
    for (const tier of row.tiers) {
      const r = tier.rate
      near(cacheReadMultiplier(r), readMult[row.id.replace(/-fast$/, '')] ?? 0.1, `${row.id} read`)
      near(r.cacheWrite5m ?? NaN, r.input * 1.25, `${row.id} 5m write`)
      near(r.cacheWrite1h ?? NaN, r.input * 2, `${row.id} 1h write`)
    }
  }
})

test('Anthropic spot checks against the vendor table', () => {
  const r = (id: string, tier = 0) => get(ANTHROPIC_ROWS, id).tiers[tier].rate
  assert.deepEqual(r('claude-fable-5-2'), { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 })
  assert.deepEqual(r('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 })
  assert.deepEqual(r('claude-opus-5'), { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 })
  assert.deepEqual(r('claude-sonnet-5-5'), { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 })
  assert.deepEqual(r('claude-sonnet-5'), { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 })
  assert.deepEqual(r('claude-haiku-4-5'), { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 })
  assert.deepEqual(r('claude-haiku-5-5', 0), { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 })
  assert.deepEqual(r('claude-haiku-5-5', 1), { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 })
  assert.equal(get(ANTHROPIC_ROWS, 'claude-haiku-5-5').tiers[0].maxPromptTokens, 100_000)
})

test('Copilot sheet covers every token-priced model on the vendor page (2026-11-25)', () => {
  const expected = [
    'gpt-5-3-codex', 'gpt-5-4-nano', 'gpt-5-6-luna', 'gpt-5-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol',
    'gpt-6-1-sol', 'gpt-6-1-terra', 'gpt-6-2-astra', 'gpt-6-2-sol',
    'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-4', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-5-5',
    'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-4-8-fast', 'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2',
    'gemini-3-8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon',
    'mai-code-1-1-flash', 'mai-code-2', 'mai-code-2-flash', 'grok-4-5', 'grok-4-6', 'grok-4-7', 'kimi-k3',
  ]
  for (const id of expected) get(COPILOT_ROWS, id)
  assert.equal(COPILOT_ROWS.length, expected.length)
})

test('Copilot spot checks, tiers and the seed rows of the plan', () => {
  const rows = COPILOT_ROWS
  assert.deepEqual(get(rows, 'claude-haiku-5-5').tiers.map(t => [t.maxPromptTokens, t.rate.input, t.rate.cacheRead, t.rate.cacheWrite5m, t.rate.output]),
    [[100_000, 0.1, 0.01, 0.125, 0.5], [null, 0.5, 0.05, 0.625, 2.5]])
  assert.deepEqual(get(rows, 'gpt-6-1-sol').tiers.map(t => [t.maxPromptTokens, t.rate.input, t.rate.cacheRead, t.rate.cacheWrite5m, t.rate.output]),
    [[272_000, 2, 0.1, 2.5, 10], [null, 4, 0.2, 5, 15]])
  assert.deepEqual(get(rows, 'gpt-6-1-terra').tiers.map(t => [t.rate.input, t.rate.output]), [[1, 5], [2, 7.5]])
  assert.deepEqual(get(rows, 'gpt-5-6-luna').tiers.map(t => t.maxPromptTokens), [200_000, null])
  assert.deepEqual(get(rows, 'grok-4-7').tiers.map(t => t.maxPromptTokens), [200_000, null])
  assert.equal(get(rows, 'gpt-5-3-codex').tiers[0].rate.cacheWrite5m, null)
  assert.equal(get(rows, 'gemini-3-8-flash').tiers[0].rate.cacheWrite5m, null)
  assert.equal(get(rows, 'kimi-k3').tiers[0].rate.output, 15)
  // Tiered Copilot rows say the threshold basis (cache included?) is not confirmed.
  for (const row of rows.filter(r => r.tiers.length > 1)) {
    assert.ok(row.unverified?.includes('thresholdCountsCache'), `${row.id} flags the threshold basis`)
  }
})

test('Copilot Claude rows agree with the Anthropic sheet (cross-check of both transcriptions)', () => {
  for (const c of COPILOT_ROWS.filter(r => r.family)) {
    const a = ANTHROPIC_ROWS.find(r => r.id === c.id)
    assert.ok(a, `${c.id} exists in the Anthropic sheet`)
    assert.equal(c.tiers.length, a.tiers.length, c.id)
    c.tiers.forEach((t, i) => {
      const o = a.tiers[i]
      assert.equal(t.maxPromptTokens, o.maxPromptTokens, `${c.id} tier ${i} threshold`)
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m'] as const) near(t.rate[k] ?? NaN, o.rate[k] ?? NaN, `${c.id} tier ${i} ${k}`)
    })
  }
})

test('rows with a derived or unpublished field say so', () => {
  assert.deepEqual([...(get(ANTHROPIC_ROWS, 'claude-opus-5-5-fast').unverified ?? [])].sort(), ['cacheRead', 'cacheWrite1h', 'cacheWrite5m'])
  assert.ok(get(COPILOT_ROWS, 'gemini-3-8-flash').unverified?.includes('afterPromoRate'))
  assert.ok(get(COPILOT_ROWS, 'gemini-4-argon').unverified?.includes('afterPromoRate'))
  assert.equal(get(COPILOT_ROWS, 'gemini-4-carbon').unverified, undefined)
  assert.equal(get(ANTHROPIC_ROWS, 'claude-sonnet-5-5').unverified, undefined)
})

test('Gemini 4 Carbon switches price at 2026-12-01 UTC, by event time', () => {
  const carbon = get(COPILOT_ROWS, 'gemini-4-carbon')
  const before = resolveRate(carbon, { at: '2026-11-30T23:59:59Z' })
  assert.equal(before.afterPromo, false)
  assert.deepEqual([before.rate.input, before.rate.cacheRead, before.rate.output], [2, 0.1, 10])
  const after = resolveRate(carbon, { at: '2026-12-01T00:00:00Z' })
  assert.equal(after.afterPromo, true)
  assert.deepEqual([after.rate.input, after.rate.cacheRead, after.rate.output], [4, 0.2, 20])
  // Day-granular checks from the plan.
  assert.equal(resolveRate(carbon, { at: Date.parse('2026-11-30T12:00:00Z') }).rate.input, 2)
  assert.equal(resolveRate(carbon, { at: Date.parse('2026-12-01T12:00:00Z') }).rate.input, 4)
  // Event time wins over the wall clock: an old event stays at the old price.
  assert.equal(resolveRate(carbon, { at: 0 }).rate.input, 2)
})

test('promos with no published later price keep the promo rate and say so; MAI Code doubles on 2027-05-17', () => {
  const argon = get(COPILOT_ROWS, 'gemini-4-argon')
  const late = resolveRate(argon, { at: '2026-12-02T00:00:00Z' })
  assert.equal(late.rate.input, 2)
  assert.equal(late.afterPromo, false)
  assert.equal(late.promoExpiredNoRate, true)
  assert.equal(resolveRate(argon, { at: '2026-11-30T00:00:00Z' }).promoExpiredNoRate, false)
  const flash = get(COPILOT_ROWS, 'gemini-3-8-flash')
  assert.equal(resolveRate(flash, { at: '2026-12-31T23:59:59Z' }).promoExpiredNoRate, false)
  assert.equal(resolveRate(flash, { at: '2027-01-01T00:00:00Z' }).promoExpiredNoRate, true)
  const mai = get(COPILOT_ROWS, 'mai-code-2')
  assert.deepEqual([resolveRate(mai, { at: '2027-05-16T23:59:59Z' }).rate.input, resolveRate(mai, { at: '2027-05-17T00:00:00Z' }).rate.input], [0.5, 1])
  const maiFlash = get(COPILOT_ROWS, 'mai-code-2-flash')
  assert.deepEqual([resolveRate(maiFlash, { at: '2027-05-16T00:00:00Z' }).rate.output, resolveRate(maiFlash, { at: '2027-05-18T00:00:00Z' }).rate.output], [0.25, 0.5])
})

test('resolveRate tiers: the threshold itself is the lower tier; no promptTokens means the lowest tier', () => {
  const haiku = get(ANTHROPIC_ROWS, 'claude-haiku-5-5')
  assert.equal(resolveRate(haiku).tierIndex, 0)
  assert.equal(resolveRate(haiku, { promptTokens: 100_000 }).tierIndex, 0)
  assert.equal(resolveRate(haiku, { promptTokens: 100_001 }).tierIndex, 1)
  const sol = get(COPILOT_ROWS, 'gpt-6-1-sol')
  assert.equal(resolveRate(sol, { promptTokens: 272_000 }).tierIndex, 0)
  assert.equal(resolveRate(sol, { promptTokens: 272_001 }).tierIndex, 1)
})

test('lookupModel: exact, family and fallback matches; Copilot ids with dots', () => {
  assert.equal(lookupModel('claude-haiku-5.5').match, 'exact')
  assert.equal(lookupModel('claude-haiku-5.5').row.id, 'claude-haiku-5-5')
  assert.equal(lookupModel('gemini-3.8-flash').row.section, 'copilot')
  assert.equal(lookupModel('gpt-6.1-sol').row.id, 'gpt-6-1-sol')
  assert.equal(lookupModel('claude-opus-9').match, 'family')
  assert.equal(lookupModel('claude-opus-9').row.id, FAMILY_CURRENT.opus)
  assert.equal(lookupModel('qwen3.5:32b').match, 'fallback')
  assert.equal(lookupModel(undefined).match, 'fallback')
  assert.equal(lookupModel('claude-opus-5-5', { section: 'copilot' }).row.section, 'copilot')
  assert.equal(lookupModel('claude-opus-5-5').row.section, 'anthropic')
  // Opus 5 must not be mistaken for Opus 5.5 (and vice versa).
  assert.equal(lookupModel('claude-opus-5').row.id, 'claude-opus-5')
  assert.equal(lookupModel('claude-opus-5-5').row.id, 'claude-opus-5-5')
})

test('every FAMILY_CURRENT id exists and blended estimate rates follow the catalog', () => {
  for (const id of Object.values(FAMILY_CURRENT)) get(ANTHROPIC_ROWS, id)
  near(blendedRateForFamily('sonnet'), 0.75 * 2 + 0.25 * 10)
  near(blendedRateForFamily('fable'), 0.75 * 8 + 0.25 * 40)
  near(blendedRateForFamily('haiku'), 0.75 * 0.1 + 0.25 * 0.5)
  near(blendedRateForModel('claude-opus-4-7'), 0.75 * 5 + 0.25 * 25)
  near(blendedRateForModel('claude-opus-5-5'), 0.75 * 4 + 0.25 * 20)
  near(blendedRateForModel('acme-xyz-9'), 4)
})

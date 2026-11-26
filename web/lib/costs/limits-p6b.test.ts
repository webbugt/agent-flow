/**
 * P6b: Fable estimator (PLAN v2 6.3 golden example), calibration from reading history, window tracking (observed,
 * configured weekly reset with a time zone, rollover), counted-provider filter and the panel's view model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DELTA_U, budgetBand, estimateFable, type FableEstimateInput } from './fable-estimate'
import { FIVE_HOURS_MS, SEVEN_DAYS_MS, calibrate, currentFiveHourWindow, nearestRank, nextWeeklyReset, weeklyWindow } from './limits'
import { buildLimitCalls, countsTowardClaudeLimits } from './limits-calls'
import { anchorBudgets, buildLimitsPanel, formatBound, pairsFromHistory } from './limits-model'
import { describePlan, PLAN_INFO } from './limits-plans'
import { formatLimitPct } from './format'
import type { LocalClock } from './observed-limits'
import type { LimitsUpdatePayload, ObservedReading } from './observed-types'
import { validateConfig } from './validate'
import type { ResolvedConfig, UsageTokens } from './types'

const H = 3_600_000
const D = 24 * H
const NOW = Date.UTC(2026, 10, 25, 14, 30)
const utc: LocalClock = {
  hm: ms => new Date(ms).toISOString().slice(11, 16),
  dayHm: ms => `${new Date(ms).toISOString().slice(5, 10)} ${new Date(ms).toISOString().slice(11, 16)}`,
  sameDay: (a, b) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10),
}

const base = (over: Partial<FableEstimateInput> = {}): FableEstimateInput => ({
  usedUnits: 0.34, pairsH1: [], pairsH2: [], anchors: [], share: { lo: 0.5, point: 0.5, hi: 0.5 }, relativeWeight: { lo: 0.5, hi: 2 },
  deltaU: 0, typedWeeklyBudget: null, typedFableBudget: null, ...over,
})

// ── Fable estimator ──────────────────────────────────────────────────────────

test('nearest rank: the PLAN golden list', () => {
  const xs = [180, 190, 195, 200, 205, 210]
  assert.equal(nearestRank(xs, 0.1), 180)
  assert.equal(nearestRank(xs, 0.9), 210)
  assert.equal(nearestRank([5], 0.9), 5)
  assert.ok(Number.isNaN(nearestRank([], 0.5)))
})

test('golden example (PLAN 6.3): pairs 180..210, u 0.34, share 0.5, rho [0.5, 2] -> 3.4‰ / 1.6‰ / 7.6‰, confidence low, n = 6', () => {
  const e = estimateFable(base({ pairsH1: [180, 190, 195, 200, 205, 210] }))
  assert.equal(e.basis, 2)
  assert.equal(e.n, 6)
  assert.equal(e.confidence, 'low')
  assert.deepEqual(e.budget && { lo: e.budget.lo, hi: e.budget.hi }, { lo: 90, hi: 105 })
  assert.ok(Math.abs((e.point as number) - 0.34 / (0.5 * 197.5)) < 1e-12)
  assert.ok(Math.abs((e.lower as number) - (0.34 * 0.5) / (0.5 * 210)) < 1e-12)
  assert.ok(Math.abs((e.upper as number) - (0.34 * 2) / (0.5 * 180)) < 1e-12)
  assert.equal(formatBound(e.point as number), '3.4‰')
  assert.equal(formatBound(e.lower as number), '1.6‰')
  assert.equal(formatBound(e.upper as number), '7.6‰')
})

test('budgetBand: nearest-rank P10/median/P90 from 5 pairs, min/median/max below', () => {
  assert.deepEqual(budgetBand([180, 190, 195, 200, 205, 210], 6), { lo: 180, pt: 197.5, hi: 210 })
  assert.deepEqual(budgetBand([10, 30, 20, 50], 4), { lo: 10, pt: 25, hi: 50 })
  assert.equal(budgetBand([], 0), null)
})

test('H1 / H2: the bounds use the union of both hypotheses', () => {
  const h1 = [200, 210]
  const h2 = [150, 160]   // the weekly meter without Fable: smaller usage per % -> smaller budgets
  const e = estimateFable(base({ pairsH1: h1, pairsH2: h2 }))
  assert.equal(e.n, 2)
  assert.deepEqual(e.budget && { lo: e.budget.lo, hi: e.budget.hi }, { lo: 0.5 * 150, hi: 0.5 * 210 })
  // upper bound uses the smallest budget of the union, lower the largest
  assert.ok(Math.abs((e.upper as number) - (0.34 * 2) / (0.5 * 150)) < 1e-12)
  assert.ok(Math.abs((e.lower as number) - (0.34 * 0.5) / (0.5 * 210)) < 1e-12)
})

test('basis 1: manual anchors replace share and relative weight; confidence follows the anchors', () => {
  const anchors = [{ b: 100, bLo: 95, bHi: 106 }, { b: 104, bLo: 100, bHi: 110 }]
  const e = estimateFable(base({ anchors, pairsH1: [1, 2, 3], share: { lo: 0.1, point: 0.5, hi: 0.9 } }))
  assert.equal(e.basis, 1)
  assert.equal(e.basisKey, 'anchors')
  assert.equal(e.confidence, 'medium')
  assert.ok(Math.abs((e.point as number) - 0.34 / 102) < 1e-12)
  assert.ok(Math.abs((e.lower as number) - 0.34 / 110) < 1e-12)
  assert.ok(Math.abs((e.upper as number) - 0.34 / 95) < 1e-12)
  assert.equal(estimateFable(base({ anchors: [anchors[0]] })).confidence, 'low')
})

test('basis 3: a typed budget applies the unseen-usage allowance to the upper bound only; confidence low', () => {
  const e = estimateFable(base({ typedWeeklyBudget: 200, deltaU: DEFAULT_DELTA_U }))
  assert.equal(e.basis, 3)
  assert.equal(e.confidence, 'low')
  assert.ok(Math.abs((e.point as number) - 0.34 / 100) < 1e-12)
  assert.ok(Math.abs((e.upper as number) - (0.34 * 1.25 * 2) / 100) < 1e-12)
  assert.ok(Math.abs((e.lower as number) - (0.34 * 0.5) / 100) < 1e-12)
  const f = estimateFable(base({ typedFableBudget: 50, deltaU: 0 }))
  assert.ok(Math.abs((f.point as number) - 0.34 / 50) < 1e-12)
})

test('basis 4: nothing to calibrate on gives no number', () => {
  const e = estimateFable(base())
  assert.equal(e.basis, 4)
  assert.equal(e.point, null); assert.equal(e.lower, null); assert.equal(e.upper, null)
  assert.equal(e.confidence, 'none')
})

test('strongest basis wins: anchors over meter over typed budget', () => {
  assert.equal(estimateFable(base({ anchors: [{ b: 100, bLo: 90, bHi: 110 }], pairsH1: [200], typedWeeklyBudget: 300 })).basis, 1)
  assert.equal(estimateFable(base({ pairsH1: [200], typedWeeklyBudget: 300 })).basis, 2)
  assert.equal(estimateFable(base({ typedWeeklyBudget: 300 })).basis, 3)
})

test('bounds ordering: lower <= point <= upper for every basis, over a grid of inputs (also with odd user bands)', () => {
  const shares = [{ lo: 0.5, point: 0.5, hi: 0.5 }, { lo: 0.3, point: 0.5, hi: 0.7 }, { lo: 0.45, point: 0.5, hi: 0.9 }]
  const rhos = [{ lo: 0.5, hi: 2 }, { lo: 1, hi: 1 }, { lo: 1.5, hi: 3 }, { lo: 0.1, hi: 0.4 }]   // the last two exclude 1 on purpose
  let n = 0
  for (const share of shares) for (const relativeWeight of rhos) for (const u of [0, 0.0004, 0.34, 12]) {
    const inputs: Partial<FableEstimateInput>[] = [
      { pairsH1: [180, 190, 195, 200, 205, 210] }, { pairsH1: [90], pairsH2: [60, 70] }, { pairsH1: [40, 400, 41, 399, 42] },
      { typedWeeklyBudget: 150, deltaU: 0.25 }, { typedFableBudget: 33 },
      { anchors: [{ b: 80, bLo: 70, bHi: 95 }, { b: 110, bLo: 100, bHi: 120 }] },
    ]
    for (const i of inputs) {
      const e = estimateFable(base({ usedUnits: u, share, relativeWeight, ...i }))
      assert.ok(e.point !== null && e.lower !== null && e.upper !== null)
      assert.ok(e.lower <= e.point && e.point <= e.upper, `u=${u} ${JSON.stringify([share, relativeWeight, i])}: ${e.lower} <= ${e.point} <= ${e.upper}`)
      assert.ok(e.lower >= 0)
      n++
    }
  }
  assert.ok(n > 100)
})

// ── formatting ───────────────────────────────────────────────────────────────

test('formatLimitPct pins from PLAN 6.4 (percent vs per-mille); bounds format independently and may cross units', () => {
  const pins: [number, string][] = [[0.00005, '<0.1‰'], [0.0001, '0.1‰'], [0.0034, '3.4‰'], [0.00999, '1.0%'], [0.01, '1.0%'], [0.042, '4.2%'], [0.0999, '10%'], [0.1, '10%'], [0, '0%']]
  for (const [f, text] of pins) assert.equal(formatLimitPct(f), text, String(f))
  assert.equal(`${formatBound(0.0091)} - ${formatBound(0.012)}`, '9.1‰ - 1.2%')
  assert.equal(formatBound(1.4), '>=100%')
})

// ── windows ──────────────────────────────────────────────────────────────────

test('weekly window: observed reset > configured schedule > trailing', () => {
  const r = NOW + 3 * D
  assert.deepEqual(weeklyWindow(NOW, r), { start: r - SEVEN_DAYS_MS, end: r, source: 'observed' })
  const sched = weeklyWindow(NOW, null, { dow: 'thu', time: '09:00', tz: 'UTC' })
  assert.equal(sched.source, 'schedule')
  assert.equal(sched.end, Date.UTC(2026, 10, 26, 9, 0))
  assert.equal(sched.end - sched.start, SEVEN_DAYS_MS)
  assert.deepEqual(weeklyWindow(NOW, null, null), { start: NOW - SEVEN_DAYS_MS, end: NOW, source: 'trailing' })
  // an observed reset that already passed is ignored
  assert.equal(weeklyWindow(NOW, NOW - 1000).source, 'trailing')
})

test('weekly reset: rolls over exactly at the reset instant and honours the time zone and DST', () => {
  const sched = { dow: 'thu' as const, time: '09:00', tz: 'Europe/Zagreb' }
  const t1 = nextWeeklyReset(Date.UTC(2026, 10, 25, 14, 30), sched) as number
  assert.equal(t1, Date.UTC(2026, 10, 26, 8, 0))             // CET = UTC+1 in November
  assert.equal(nextWeeklyReset(t1 - 1, sched), t1)
  assert.equal(nextWeeklyReset(t1, sched), t1 + SEVEN_DAYS_MS, 'a call exactly at the reset belongs to the next window')
  const summer = nextWeeklyReset(Date.UTC(2026, 6, 1), sched) as number   // CEST = UTC+2
  assert.equal(new Date(summer).toISOString(), '2026-07-02T07:00:00.000Z')
  // across the autumn change (CEST -> CET on 2026-10-25): a 09:00 reset stays 09:00 local, so the gap is not 7 x 24h
  const before = nextWeeklyReset(Date.UTC(2026, 9, 20), sched) as number
  const after = nextWeeklyReset(before, sched) as number
  assert.equal(new Date(before).toISOString(), '2026-10-22T07:00:00.000Z')
  assert.equal(new Date(after).toISOString(), '2026-10-29T08:00:00.000Z')
  assert.equal(nextWeeklyReset(NOW, { dow: 'thu', time: '09:00', tz: 'Not/AZone' }), null)
  assert.equal(nextWeeklyReset(NOW, { dow: 'thu', time: '25:00', tz: 'UTC' }), null)
})

test('5h window rollover: a call after start + 5h starts a new window; observed reset overrides', () => {
  const t0 = NOW - 6 * H
  const w1 = currentFiveHourWindow([t0, NOW - 30 * 60_000], { now: NOW })!
  assert.equal(w1.start, NOW - 30 * 60_000)                   // the call 6 h ago opened a window that ended 1 h ago
  assert.equal(w1.end, w1.start + FIVE_HOURS_MS)
  const obs = currentFiveHourWindow([t0], { now: NOW, observedResetsAt: NOW + 2 * H })!
  assert.deepEqual(obs, { start: NOW + 2 * H - FIVE_HOURS_MS, end: NOW + 2 * H, source: 'observed' })
})

// ── calibration from the reading history ─────────────────────────────────────

const slot = (ms: number) => Math.floor(ms / 600_000)
const usage = (n: number): UsageTokens => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 })
const key = (ms: number, model: string, provider = 'claude-subscription-directsdk-experimental', bucket = 'le100000') => `${slot(ms)}|${provider}|${model}|${bucket}`

function config(limits: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ResolvedConfig {
  const r = validateConfig({ schemaVersion: 1, limits: { claude: { plan: 'max5x', ...limits } }, ...extra })
  assert.ok(r.ok, JSON.stringify(r.errors))
  return r.config as ResolvedConfig
}

test('calibration pairs: B = dC / (dp / 100) between readings of one window; a new window restarts; small moves fold into the next', () => {
  const cfg = config()
  // opus-5-5 input is priced per MTok; 1M input tokens = list price of one MTok. Use the calls' own units as the truth.
  const t = NOW - 2 * D
  const byTime = {
    [key(t, 'claude-opus-5-5')]: usage(1_000_000),
    [key(t + 6 * H, 'claude-opus-5-5')]: usage(1_000_000),
    [key(t + 12 * H, 'claude-opus-5-5')]: usage(1_000_000),
  }
  const calls = buildLimitCalls(cfg, [byTime])
  assert.equal(calls.length, 3)
  const per = calls[0].units
  assert.ok(per > 0)
  const reset = t + 5 * D
  const hist: ObservedReading[] = [
    { at: t + 1 * H, sevenDay: { usedPct: 10, resetsAt: reset } },       // C = per
    { at: t + 8 * H, sevenDay: { usedPct: 12, resetsAt: reset } },       // +2 points: folded into the next pair
    { at: t + 13 * H, sevenDay: { usedPct: 30, resetsAt: reset } },      // C = 3 per, p +20 vs the anchor at 10%
    { at: t + 14 * H, sevenDay: { usedPct: 3, resetsAt: reset + SEVEN_DAYS_MS } },   // another window: no pair
  ]
  const set = pairsFromHistory(hist, 'sevenDay', calls, false)
  assert.equal(set.pairs.length, 1)
  assert.ok(Math.abs(set.pairs[0].b - (2 * per) / 0.2) < 1e-9, `${set.pairs[0].b} vs ${(2 * per) / 0.2}`)
  assert.equal(calibrate(set.pairs.map(x => x.b)).confidence, 'low')
  assert.equal(calibrate([100, 101, 99, 100, 102]).confidence, 'high')
})

// ── counted providers ────────────────────────────────────────────────────────

test('counted providers: Copilot never counts; anthropic only when it is a subscription; the Hermes Claude provider counts', () => {
  const plain = config()
  assert.equal(countsTowardClaudeLimits(plain, 'claude-subscription-directsdk-experimental'), true)
  assert.equal(countsTowardClaudeLimits(plain, 'copilot'), false)
  assert.equal(countsTowardClaudeLimits(plain, 'ollama'), false)
  assert.equal(countsTowardClaudeLimits(plain, 'anthropic'), false, 'anthropic defaults to api billing')
  const sub = config({}, { pricing: { providers: { anthropic: { billing: 'subscription' } } } })
  assert.equal(countsTowardClaudeLimits(sub, 'anthropic'), true)
  // even when the user lists copilot, it still does not count
  const listed = config({ countProviders: ['copilot', 'claude-subscription-directsdk-experimental'] })
  assert.equal(countsTowardClaudeLimits(listed, 'copilot'), false)
})

test('Copilot Fable calls do not create a Fable row', () => {
  const cfg = config()
  const byTime = {
    [key(NOW - H, 'claude-fable-5-2', 'copilot')]: usage(2_000_000),
    [key(NOW - H, 'claude-opus-5-5')]: usage(1_000_000),
  }
  const calls = buildLimitCalls(cfg, [byTime])
  assert.equal(calls.length, 1)
  const m = buildLimitsPanel({ config: cfg, payload: null, spends: [byTime], now: NOW, clock: utc })
  assert.ok(!m.rows.some(r => r.id === 'fable'))
})

// ── the panel ────────────────────────────────────────────────────────────────

const payload = (over: Partial<LimitsUpdatePayload> = {}): LimitsUpdatePayload => ({
  version: 1, seq: 1, provider: 'claude', source: 'statusline', canConfigure: true, install: { state: 'installed', canInstall: false },
  observed: { at: NOW - 30_000, stale: false, windows: [
    { key: 'five_hour', kind: 'five_hour', usedPct: 37, resetsAt: NOW + 95 * 60_000, state: 'fresh' },
    { key: 'seven_day', kind: 'seven_day', usedPct: 4.2, resetsAt: NOW + 3 * D + 4 * H, state: 'fresh' },
  ] },
  ...over,
})

const opusOnly = { [key(NOW - 2 * H, 'claude-opus-5-5')]: usage(1_000_000) }
const withFable = { ...opusOnly, [key(NOW - 2 * H, 'claude-fable-5-2')]: usage(500_000) }

test('observed 5h / weekly rows carry obs and no icon; no Fable row without Fable calls (both fixtures)', () => {
  const m = buildLimitsPanel({ config: config(), payload: payload(), spends: [opusOnly], now: NOW, clock: utc })
  assert.equal(m.visible, true)
  assert.deepEqual(m.rows.map(r => [r.id, r.valueText, r.tag, r.estimate]), [['5h', '37%', 'obs', false], ['7d', '4.2%', 'obs', false]])
  assert.equal(m.planText, 'Claude Max 5x · 5x Pro')
  assert.match(m.rows[0].title, /Claude Code · 5-hour usage limit · observed/)
  const none = buildLimitsPanel({ config: config(), payload: payload(), spends: [], now: NOW, clock: utc })
  assert.ok(!none.rows.some(r => r.id === 'fable'))
})

test('a Fable call in the weekly window adds the Fable row: estimate icon, `est` tag, hover with bounds, confidence, basis', () => {
  const cfg = config({ weekly: { budgetUsdEquiv: 200 } })
  const m = buildLimitsPanel({ config: cfg, payload: payload(), spends: [withFable], now: NOW, clock: utc })
  const f = m.rows.find(r => r.id === 'fable')!
  assert.ok(f, 'Fable row present')
  assert.equal(f.estimate, true)
  assert.equal(f.tag, 'est')
  assert.match(f.valueText, /^~/)
  assert.ok(f.fable)
  assert.match(f.fable!.valueLine, /^estimate .+ {4}lower bound .+ {4}upper bound .+$/)
  assert.match(f.fable!.confidence, /confidence: low/)
  assert.match(f.fable!.basis, /calibration basis: typed budget/)
  assert.match(f.fable!.title, /ESTIMATE \(Claude Code does not report this\)/)
  assert.match(f.fable!.scope, /this machine's sessions only/)
  assert.equal(f.hint?.includes('list-equiv'), true)
  // the plan table has no Fable limit on Pro, and `api` has no panel at all
  const pro = buildLimitsPanel({ config: config({ plan: 'pro', weekly: { budgetUsdEquiv: 200 } }), payload: payload(), spends: [withFable], now: NOW, clock: utc })
  assert.ok(!pro.rows.some(r => r.id === 'fable'))
  const api = buildLimitsPanel({ config: config({ plan: 'api' }), payload: payload(), spends: [withFable], now: NOW, clock: utc })
  assert.equal(api.visible, false)
})

test('Fable weekly-meter basis from the reading history: pairs, bounds in order, basis text names the pairs', () => {
  const t = NOW - 3 * D
  const reset = NOW + 3 * D + 4 * H
  // ledger: one opus MTok every 12 h, plus Fable now
  const spend: Record<string, UsageTokens> = {}
  for (let i = 0; i < 6; i++) spend[key(t + i * 12 * H, 'claude-opus-5-5')] = usage(1_000_000)
  spend[key(NOW - H, 'claude-fable-5-2')] = usage(200_000)
  const cfg = config()
  const per = buildLimitCalls(cfg, [{ [key(t, 'claude-opus-5-5')]: usage(1_000_000) }])[0].units
  // meter: 10% per 'per' of usage -> B = 10 x per; readings every 12 h
  const history: ObservedReading[] = []
  for (let i = 0; i < 6; i++) history.push({ at: t + i * 12 * H + 1000, sevenDay: { usedPct: 10 * (i + 1) - 5, resetsAt: reset } })
  const m = buildLimitsPanel({ config: cfg, payload: payload({ history }), spends: [spend], now: NOW, clock: utc })
  const f = m.rows.find(r => r.id === 'fable')!
  assert.ok(f.fable)
  assert.match(f.fable!.basis, /weekly meter x 50% share \(\d+ pairs?/)
  const pt = f.fraction as number
  assert.ok(pt > 0)
  assert.match(f.fable!.confidence, /low/)
})

test('estimate rows: calibrated budget gives `cal` with ~, a typed budget gives `est` with >=, no budget says set your limit', () => {
  // no observed reading: estimates only
  const noObs = payload({ observed: null })
  const spend = { [key(NOW - H, 'claude-opus-5-5')]: usage(1_000_000) }
  const unit = buildLimitCalls(config(), [spend])[0].units

  const typed = buildLimitsPanel({ config: config({ fiveHour: { budgetUsdEquiv: unit * 10 } }), payload: noObs, spends: [spend], now: NOW, clock: utc })
  const r5 = typed.rows.find(r => r.id === '5h')!
  assert.equal(r5.tag, 'est'); assert.equal(r5.lowerBound, true); assert.equal(r5.valueText, '>=10%'); assert.equal(r5.estimate, true)
  assert.match(r5.title, /ESTIMATE from this machine's sessions/)

  const none = buildLimitsPanel({ config: config(), payload: noObs, spends: [spend], now: NOW, clock: utc })
  const n5 = none.rows.find(r => r.id === '5h')!
  assert.equal(n5.valueText, '–'); assert.equal(n5.tag, null); assert.match(n5.hint ?? '', /set your 5-hour limit to see %/)

  // calibrated: history of two readings in the same 5h window, 20 points apart
  const reset = NOW + 2 * H   // the window is [NOW - 3h, NOW + 2h)
  const hist: ObservedReading[] = [
    { at: NOW - 3 * H + 10 * 60_000, fiveHour: { usedPct: 10, resetsAt: reset } },
    { at: NOW - 30 * 60_000, fiveHour: { usedPct: 30, resetsAt: reset } },
  ]
  const spend2 = { [key(NOW - 3 * H + 5 * 60_000, 'claude-opus-5-5')]: usage(1_000_000), [key(NOW - 2 * H, 'claude-opus-5-5')]: usage(1_000_000) }
  const cal = buildLimitsPanel({ config: config(), payload: payload({ observed: null, history: hist }), spends: [spend2], now: NOW, clock: utc })
  const c5 = cal.rows.find(r => r.id === '5h')!
  assert.equal(c5.tag, 'cal')
  assert.match(c5.valueText, /^(~|>=)\d/)
  assert.match(c5.title, /calibrated budget .*\(median of 1 observed pair,/)
  // 2 units used of a budget of 5 units per 100% (1 unit moved the meter 20 points) -> 40%
  assert.ok(Math.abs((c5.fraction as number) - 0.4) < 1e-9, String(c5.fraction))
})

test('tiny Fable value renders in per-mille / below-range text', () => {
  const cfg = config({ weekly: { budgetUsdEquiv: 1_000_000 } })
  const tiny = { [key(NOW - H, 'claude-fable-5-2')]: usage(1_000) }
  const m = buildLimitsPanel({ config: cfg, payload: payload(), spends: [tiny], now: NOW, clock: utc })
  const f = m.rows.find(r => r.id === 'fable')!
  assert.match(f.valueText, /‰$/)
})

test('plan text is data: a user label and multiplier replace the built-in ones; nothing branches on them', () => {
  assert.equal(describePlan(config({ plan: 'max5x', planLabel: 'Max (team seat)', planMultiplierOfPro: 7.5 }).limits.claude)?.text, 'Max (team seat) · 7.5x Pro')
  assert.equal(describePlan(config({ plan: 'custom' }).limits.claude)?.text, 'Custom plan')
  assert.equal(describePlan(config({ plan: null }).limits.claude), null)
  assert.equal(PLAN_INFO.api.traits.limits, false)
  assert.equal(PLAN_INFO.pro.traits.fableLimit, false)
})

test('anchors become budgets of Fable itself, with the rounding interval of the typed percentage', () => {
  const cfg = config({ fable: { anchors: [{ at: new Date(NOW - H).toISOString(), observedPct: 4 }] } })
  const spend = { [key(NOW - 3 * H, 'claude-fable-5-2')]: usage(1_000_000) }
  const calls = buildLimitCalls(cfg, [spend])
  const [a] = anchorBudgets(cfg, calls, [])
  assert.ok(a)
  assert.ok(Math.abs(a.b - calls[0].units / 0.04) < 1e-9)
  assert.ok(a.bLo < a.b && a.b < a.bHi)
})

// ── reset times from the history, all-session ledger, wording ────────────────

import { lastResetAfter } from './limits-model'
import { basisText } from './fable-estimate'
import { collectByTime } from '../limits-ledger'

test('lastResetAfter: the newest reading whose reset is still ahead; none when every reset has passed', () => {
  const h: ObservedReading[] = [
    { at: NOW - 6 * H, fiveHour: { usedPct: 10, resetsAt: NOW - H } },
    { at: NOW - 2 * H, fiveHour: { usedPct: 20, resetsAt: NOW + 3 * H }, sevenDay: { usedPct: 3, resetsAt: NOW + 2 * D } },
    { at: NOW - H, sevenDay: { usedPct: 4, resetsAt: NOW + 2 * D } },
  ]
  assert.equal(lastResetAfter(h, 'fiveHour', NOW), NOW + 3 * H)
  assert.equal(lastResetAfter(h, 'sevenDay', NOW), NOW + 2 * D)
  assert.equal(lastResetAfter(h, 'fiveHour', NOW + 4 * H), null)
  assert.equal(lastResetAfter([], 'sevenDay', NOW), null)
})

test('without a live reading the window comes from the history reset (not "trailing 7d")', () => {
  const reset = NOW + 3 * D
  const history: ObservedReading[] = [{ at: NOW - 6 * H, sevenDay: { usedPct: 2, resetsAt: reset } }]
  const m = buildLimitsPanel({ config: config({ weekly: { budgetUsdEquiv: 500 } }), payload: payload({ observed: null, history }), spends: [opusOnly], now: NOW, clock: utc })
  const r7 = m.rows.find(r => r.id === '7d')!
  assert.match(r7.resetText, /^resets /)
  assert.doesNotMatch(r7.resetText, /trailing/)
  assert.match(r7.title, /observed reset time/)
  const none = buildLimitsPanel({ config: config({ weekly: { budgetUsdEquiv: 500 } }), payload: payload({ observed: null }), spends: [opusOnly], now: NOW, clock: utc })
  assert.equal(none.rows.find(r => r.id === '7d')!.resetText, 'trailing 7d')
})

test('collectByTime: the newest context_update of each (session, agent) is that agent\'s whole ledger; other events and bad shapes are ignored', () => {
  const k = key(NOW - H, 'claude-opus-5-5')
  const ev = (agent: string, n: number) => ({ type: 'context_update', payload: { agent, spend: { byTime: { [k]: usage(n) } } } })
  const events: Record<string, { type: string; payload?: unknown }[]> = {
    s1: [ev('a', 100), ev('a', 300), ev('b', 50), { type: 'tool_call_start', payload: {} }, { type: 'context_update', payload: { agent: 'c' } }, { type: 'context_update', payload: 5 }],
    s2: [ev('a', 7)],
    s3: [],
  }
  const out = collectByTime(['s1', 's2', 's3'], id => events[id] ?? [])
  assert.deepEqual(out.map(o => o[k].inputTokens).sort((a, b) => a - b), [7, 50, 300])
})

test('basis text names one day when all pairs fall on it, a range otherwise', () => {
  const est = estimateFable(base({ pairsH1: [200] }))
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  assert.match(basisText(est, { lo: 0.5, point: 0.5, hi: 0.5 }, day, { from: NOW, to: NOW + H }, 0), /\(1 pair, 2026-11-25\);/)
  assert.match(basisText(est, { lo: 0.5, point: 0.5, hi: 0.5 }, day, { from: NOW - D, to: NOW }, 0), /2026-11-24\.\.2026-11-25/)
})

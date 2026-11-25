import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from './validate'
import {
  EnergyLedger, HOUR_MS, computeEnergy, hourPriceShares, mergeEnergyUsage, parseClock, sweepIntervals, tzOffsetMs,
} from './energy'
import type { EnergyUsage, ResolvedConfig, Tariff } from './types'
import { priceAgent } from './agent-cost'
import { buildAgentTooltip, buildCostSummary, buildPillLabel, localFigure, tooltipPlainText } from './overlay'

function cfg(raw: Record<string, unknown> = {}): ResolvedConfig {
  const r = validateConfig({ schemaVersion: 1, ...raw })
  assert.deepEqual(r.errors, [])
  return r.config as ResolvedConfig
}
const near = (a: number, b: number, msg = '', eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} != ${b}`)

/** 40 W idle / 200 W load: marginal 160 W, total 200 W. */
const BOX = { powerW: { idle: 40, load: 200 } }
const hours = (h: Record<number, Partial<EnergyUsage['byHour'][string]>>): EnergyUsage => ({
  v: 1,
  byHour: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { busySec: 0, callSec: 0, calls: 0, untimedCalls: 0, untimedInTok: 0, untimedOutTok: 0, ...v }])),
})
/** UTC hour index of an ISO instant. */
const H = (iso: string): number => Math.floor(Date.parse(iso) / HOUR_MS)

// ── kWh formula ─────────────────────────────────────────────────────────────

test('kWh = (load - idle) x pue x busy seconds / 3.6e6, by hand: 160 W x 3600 s = 0.16 kWh', () => {
  const c = cfg({ energy: { profiles: { box: BOX } } })
  const r = computeEnergy(c, 'box', hours({ 100: { busySec: 3600, calls: 1 } }))!
  near(r.kwh, 0.16)
  assert.equal(r.attributedW, 160)
  assert.equal(r.cost, null, 'no tariff, no cost')
  // 100 s: 160 x 100 / 3.6e6
  near(computeEnergy(c, 'box', hours({ 100: { busySec: 100, calls: 1 } }))!.kwh, 16000 / 3.6e6)
})

test('pue multiplies and total attribution charges the full load power', () => {
  const c = cfg({ energy: { profiles: { box: { ...BOX, pue: 1.2 }, wall: { ...BOX, attribution: 'total' } } } })
  const u = hours({ 100: { busySec: 3600, calls: 1 } })
  near(computeEnergy(c, 'box', u)!.kwh, 0.16 * 1.2)
  const t = computeEnergy(c, 'wall', u)!
  near(t.kwh, 0.2)
  assert.equal(t.attributedW, 200)
})

test('a missing or undefined profile gives null, never a made-up number', () => {
  const c = cfg({ energy: { profiles: { box: BOX } } })
  assert.equal(computeEnergy(c, null, undefined), null)
  assert.equal(computeEnergy(c, 'nope', undefined), null)
  const none = computeEnergy(c, 'box', undefined)!
  assert.equal(none.kwh, 0)
  assert.equal(none.hours, 0)
})

test('calls without a latency are modelled from throughput; without throughput they add nothing and are counted', () => {
  // 600 out tokens at 30 tok/s = 20 s, 3000 new input tokens at 300 tok/s = 10 s -> 30 s
  const c = cfg({ energy: { profiles: { box: { ...BOX, throughput: { genTokPerSec: 30, prefillTokPerSec: 300 } }, bare: BOX } } })
  const u = hours({ 5: { untimedCalls: 2, untimedOutTok: 600, untimedInTok: 3000 } })
  const r = computeEnergy(c, 'box', u)!
  near(r.modelledSec, 30)
  near(r.busySec, 30)
  near(r.kwh, 160 * 30 / 3.6e6)
  const b = computeEnergy(c, 'bare', u)!
  assert.equal(b.busySec, 0)
  assert.equal(b.unmodelledCalls, 2)
  assert.equal(b.kwh, 0)
})

test('busy time from latency wins and modelled time is added only for the calls that have none', () => {
  const c = cfg({ energy: { profiles: { box: { ...BOX, throughput: { genTokPerSec: 50, prefillTokPerSec: 500 } } } } })
  const r = computeEnergy(c, 'box', hours({ 7: { busySec: 10, callSec: 10, calls: 1, untimedCalls: 1, untimedOutTok: 100 } }))!
  near(r.latencySec, 10); near(r.modelledSec, 2); near(r.busySec, 12)
})

// ── overlap ─────────────────────────────────────────────────────────────────

test('overlapping calls on one device split the load: A 0-10 s, B 5-15 s -> 7.5 s each, 15 s total (the union)', () => {
  const out = sweepIntervals([
    { owner: 'a', startMs: 0, endMs: 10_000 },
    { owner: 'b', startMs: 5_000, endMs: 15_000 },
  ])
  const a = out.get('a')!.get(0)!
  const b = out.get('b')!.get(0)!
  near(a.busyMs, 7_500); near(b.busyMs, 7_500)
  near(a.callMs, 10_000); near(b.callMs, 10_000)
  near(a.busyMs + b.busyMs, 15_000, 'conserved: device was busy 15 s')
})

test('fully overlapping calls get half each; non-overlapping calls get all of their own time', () => {
  const full = sweepIntervals([{ owner: 'a', startMs: 0, endMs: 8_000 }, { owner: 'b', startMs: 0, endMs: 8_000 }])
  near(full.get('a')!.get(0)!.busyMs, 4_000); near(full.get('b')!.get(0)!.busyMs, 4_000)
  const apart = sweepIntervals([{ owner: 'a', startMs: 0, endMs: 3_000 }, { owner: 'b', startMs: 3_000, endMs: 7_000 }])
  near(apart.get('a')!.get(0)!.busyMs, 3_000); near(apart.get('b')!.get(0)!.busyMs, 4_000)
})

test('three-way overlap: a 0-9, b 3-9, c 6-9 -> 3 + 1.5 + 1 | 1.5 + 1 | 1 (s)', () => {
  const out = sweepIntervals([
    { owner: 'a', startMs: 0, endMs: 9_000 }, { owner: 'b', startMs: 3_000, endMs: 9_000 }, { owner: 'c', startMs: 6_000, endMs: 9_000 },
  ])
  const t = (o: string) => out.get(o)!.get(0)!.busyMs
  near(t('a'), 3_000 + 1_500 + 1_000)
  near(t('b'), 1_500 + 1_000)
  near(t('c'), 1_000)
  near(t('a') + t('b') + t('c'), 9_000, 'conserved')
})

test('two calls of the SAME owner that overlap count once: 2 x 5 s halves, total 10 s, own latencies 20 s', () => {
  const out = sweepIntervals([{ owner: 'a', startMs: 0, endMs: 10_000 }, { owner: 'a', startMs: 0, endMs: 10_000 }])
  const a = out.get('a')!.get(0)!
  near(a.busyMs, 10_000); near(a.callMs, 20_000); assert.equal(a.calls, 2)
})

test('an interval that crosses an hour boundary is split between the two hour buckets', () => {
  const edge = Date.parse('2026-11-25T10:00:00Z')
  const out = sweepIntervals([{ owner: 'a', startMs: edge - 10_000, endMs: edge + 30_000 }])
  const h = out.get('a')!
  near(h.get(H('2026-11-25T09:00:00Z'))!.busyMs, 10_000)
  near(h.get(H('2026-11-25T10:00:00Z'))!.busyMs, 30_000)
  assert.equal(h.get(H('2026-11-25T10:00:00Z'))!.calls, 1, 'the call is counted in the hour it ended')
})

test('the ledger: calls on different devices do not split; republishing is reported for the owners that changed', () => {
  const l = new EnergyLedger()
  assert.deepEqual(l.recordTimed('ollama', 'a', 0, 10_000), ['a'])
  assert.deepEqual(l.recordTimed('vllm', 'b', 0, 10_000), ['b'])
  near(l.usage('a')!.byHour['0'].busySec, 10)
  near(l.usage('b')!.byHour['0'].busySec, 10)
  // same device as a: both shrink
  const changed = l.recordTimed('ollama', 'c', 5_000, 15_000)
  assert.deepEqual([...changed].sort(), ['a', 'c'])
  near(l.usage('a')!.byHour['0'].busySec, 7.5)
  near(l.usage('c')!.byHour['0'].busySec, 7.5)
  near(l.usage('a')!.byHour['0'].callSec, 10)
  assert.equal(l.usage('nobody'), undefined)
})

test('the ledger ignores empty and invalid intervals and keeps untimed calls per hour', () => {
  const l = new EnergyLedger()
  assert.deepEqual(l.recordTimed('d', 'a', 5, 5), [])
  assert.deepEqual(l.recordTimed('d', 'a', Number.NaN, 5), [])
  assert.deepEqual(l.recordTimed('d', 'a', 9, 3), [])
  assert.equal(l.usage('a'), undefined)
  l.recordUntimed('a', Date.parse('2026-11-25T10:30:00Z'), 100, 20)
  l.recordUntimed('a', Date.parse('2026-11-25T10:45:00Z'), 50, 5)
  l.recordUntimed('a', Date.parse('2026-11-25T11:05:00Z'), 10, 1)
  const u = l.usage('a')!
  const h10 = u.byHour[String(H('2026-11-25T10:00:00Z'))]
  assert.deepEqual([h10.untimedCalls, h10.untimedInTok, h10.untimedOutTok], [2, 150, 25])
  assert.equal(u.byHour[String(H('2026-11-25T11:00:00Z'))].untimedCalls, 1)
})

test('the ledger folds old intervals into fixed totals without changing the sums', () => {
  const l = new EnergyLedger()
  for (let i = 0; i < 4_100; i++) l.recordTimed('d', 'a', i * 10_000, i * 10_000 + 4_000)
  const u = l.usage('a')!
  const total = Object.values(u.byHour).reduce((s, e) => s + e.busySec, 0)
  near(total, 4_100 * 4, 'every call counted once', 0.01)
})

test('mergeEnergyUsage adds hour by hour', () => {
  const m = mergeEnergyUsage(hours({ 1: { busySec: 2, calls: 1 } }), hours({ 1: { busySec: 3, calls: 2 }, 2: { busySec: 1, calls: 1 } }))!
  assert.equal(m.byHour['1'].busySec, 5); assert.equal(m.byHour['1'].calls, 3); assert.equal(m.byHour['2'].busySec, 1)
  assert.equal(mergeEnergyUsage(undefined, undefined), undefined)
})

// ── tariff ──────────────────────────────────────────────────────────────────

const NIGHT: Tariff = {
  currency: 'EUR', flatPerKWh: 0.30, tz: 'UTC',
  timeOfDay: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '22:00', to: '06:00', perKWh: 0.10 }],
}

test('tariff: a window that wraps midnight, boundaries on the hour (UTC)', () => {
  const at = (iso: string) => hourPriceShares(NIGHT, H(iso))
  assert.deepEqual(at('2026-11-25T21:00:00Z'), [{ window: -1, minutes: 60 }], '21:00-22:00 is flat')
  assert.deepEqual(at('2026-11-25T22:00:00Z'), [{ window: 0, minutes: 60 }], '22:00 is the first night hour')
  assert.deepEqual(at('2026-11-26T05:00:00Z'), [{ window: 0, minutes: 60 }], '05:00-06:00 is still night')
  assert.deepEqual(at('2026-11-26T06:00:00Z'), [{ window: -1, minutes: 60 }], '06:00 is back to flat')
})

test('tariff: a window edge inside an hour splits that hour by minutes', () => {
  const t: Tariff = { ...NIGHT, timeOfDay: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '22:30', to: '06:15', perKWh: 0.10 }] }
  assert.deepEqual(hourPriceShares(t, H('2026-11-25T22:00:00Z')), [{ window: -1, minutes: 30 }, { window: 0, minutes: 30 }])
  assert.deepEqual(hourPriceShares(t, H('2026-11-26T06:00:00Z')), [{ window: -1, minutes: 45 }, { window: 0, minutes: 15 }])
})

test('tariff: weekdays. A mon 22:00-06:00 window runs into Tuesday morning, but Tuesday evening is flat', () => {
  const t: Tariff = { ...NIGHT, timeOfDay: [{ days: ['mon'], from: '22:00', to: '06:00', perKWh: 0.10 }] }
  // 2026-11-23 is a Monday
  assert.deepEqual(hourPriceShares(t, H('2026-11-23T23:00:00Z')), [{ window: 0, minutes: 60 }], 'Mon 23:00')
  assert.deepEqual(hourPriceShares(t, H('2026-11-24T03:00:00Z')), [{ window: 0, minutes: 60 }], 'Tue 03:00 belongs to the Monday window')
  assert.deepEqual(hourPriceShares(t, H('2026-11-24T23:00:00Z')), [{ window: -1, minutes: 60 }], 'Tue 23:00 is flat')
  assert.deepEqual(hourPriceShares(t, H('2026-11-23T03:00:00Z')), [{ window: -1, minutes: 60 }], 'Mon 03:00 is before the window')
})

test('tariff: "24:00" ends a window at midnight and a same-day window does not wrap', () => {
  const t: Tariff = { ...NIGHT, timeOfDay: [{ days: ['wed'], from: '18:00', to: '24:00', perKWh: 0.5 }] }
  assert.deepEqual(hourPriceShares(t, H('2026-11-25T23:00:00Z')), [{ window: 0, minutes: 60 }])
  assert.deepEqual(hourPriceShares(t, H('2026-11-26T00:00:00Z')), [{ window: -1, minutes: 60 }])
})

test('tariff: the time zone decides. Zagreb is UTC+1 in winter: 21:00 UTC is 22:00 local, the first night hour', () => {
  const z: Tariff = { ...NIGHT, tz: 'Europe/Zagreb' }
  assert.deepEqual(hourPriceShares(z, H('2026-11-25T20:00:00Z')), [{ window: -1, minutes: 60 }])
  assert.deepEqual(hourPriceShares(z, H('2026-11-25T21:00:00Z')), [{ window: 0, minutes: 60 }])
  assert.deepEqual(hourPriceShares(z, H('2026-11-26T04:00:00Z')), [{ window: 0, minutes: 60 }], '05:00 local')
  assert.deepEqual(hourPriceShares(z, H('2026-11-26T05:00:00Z')), [{ window: -1, minutes: 60 }], '06:00 local')
})

test('tariff: spring-forward day (Zagreb 2026-03-29, 01:00 UTC): the UTC hour buckets stay 60 minutes and local lookups follow the jump', () => {
  assert.equal(tzOffsetMs(Date.parse('2026-03-29T00:30:00Z'), 'Europe/Zagreb'), 3_600_000)
  assert.equal(tzOffsetMs(Date.parse('2026-03-29T01:30:00Z'), 'Europe/Zagreb'), 7_200_000)
  const z: Tariff = { currency: 'EUR', flatPerKWh: 0.3, tz: 'Europe/Zagreb', timeOfDay: [{ days: ['sun'], from: '03:00', to: '04:00', perKWh: 0.9 }] }
  assert.deepEqual(hourPriceShares(z, H('2026-03-29T00:00:00Z')), [{ window: -1, minutes: 60 }], '01:00-02:00 local')
  assert.deepEqual(hourPriceShares(z, H('2026-03-29T01:00:00Z')), [{ window: 0, minutes: 60 }], 'the first hour after the jump is 03:00-04:00 local')
  assert.deepEqual(hourPriceShares(z, H('2026-03-29T02:00:00Z')), [{ window: -1, minutes: 60 }], '04:00-05:00 local')
})

test('tariff: fall-back day (Zagreb 2026-10-25, 01:00 UTC): both UTC hours that are local 02:xx fall in a 02:00-03:00 window, 60 minutes each', () => {
  const z: Tariff = { currency: 'EUR', flatPerKWh: 0.3, tz: 'Europe/Zagreb', timeOfDay: [{ days: ['sun'], from: '02:00', to: '03:00', perKWh: 0.9 }] }
  assert.deepEqual(hourPriceShares(z, H('2026-10-24T23:00:00Z')), [{ window: -1, minutes: 60 }], '01:00 local (CEST)')
  assert.deepEqual(hourPriceShares(z, H('2026-10-25T00:00:00Z')), [{ window: 0, minutes: 60 }], '02:00 local (CEST)')
  assert.deepEqual(hourPriceShares(z, H('2026-10-25T01:00:00Z')), [{ window: 0, minutes: 60 }], '02:00 local again (CET)')
  assert.deepEqual(hourPriceShares(z, H('2026-10-25T02:00:00Z')), [{ window: -1, minutes: 60 }], '03:00 local')
})

test('parseClock', () => {
  assert.equal(parseClock('00:00'), 0); assert.equal(parseClock('22:30'), 1350); assert.equal(parseClock('24:00'), 1440)
  assert.equal(parseClock('7:05'), 425); assert.equal(parseClock('25:00'), null); assert.equal(parseClock('12:60'), null); assert.equal(parseClock('noon'), null)
})

// ── cost ────────────────────────────────────────────────────────────────────

test('flat tariff: cost = kWh x price, in the tariff currency, and in the display currency through the manual rate', () => {
  const c = cfg({ currency: { display: 'USD', fx: { EUR: 0.92 } }, energy: { profiles: { box: BOX }, tariff: { currency: 'EUR', flatPerKWh: 0.25 } } })
  const r = computeEnergy(c, 'box', hours({ 100: { busySec: 3600, calls: 1 } }))!
  near(r.cost!, 0.16 * 0.25)
  near(r.costDisplay!, 0.16 * 0.25 / 0.92)
  assert.equal(r.tariff!.slices.length, 1)
  assert.equal(r.tariff!.slices[0].label, 'flat')
})

test('time-of-day tariff: busy hours at night cost the night price, the rest the flat price (hand-checked)', () => {
  const c = cfg({ currency: { fx: { EUR: 0.92 } }, energy: { profiles: { box: BOX }, tariff: NIGHT } })
  // 1 h busy at 23:00 UTC (night, 0.10) and 1 h at 12:00 UTC (flat, 0.30): 0.16 kWh each
  const u = hours({ [H('2026-11-25T23:00:00Z')]: { busySec: 3600, calls: 1 }, [H('2026-11-25T12:00:00Z')]: { busySec: 3600, calls: 1 } })
  const r = computeEnergy(c, 'box', u)!
  near(r.kwh, 0.32)
  near(r.cost!, 0.16 * 0.10 + 0.16 * 0.30)
  assert.deepEqual(r.tariff!.slices.map(s => [s.window, s.perKWh]), [[-1, 0.30], [0, 0.10]])
  // the same usage under a flat-only tariff costs more: the tariff effect
  const flat = computeEnergy(cfg({ currency: { fx: { EUR: 0.92 } }, energy: { profiles: { box: BOX }, tariff: { currency: 'EUR', flatPerKWh: 0.30 } } }), 'box', u)!
  near(flat.cost!, 0.32 * 0.30)
  assert.ok(flat.cost! > r.cost!)
})

test('a window edge inside the busy hour splits the cost by the minutes of the hour', () => {
  const t = { currency: 'EUR', flatPerKWh: 0.30, tz: 'UTC', timeOfDay: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '22:30', to: '06:00', perKWh: 0.10 }] }
  const c = cfg({ currency: { fx: { EUR: 0.92 } }, energy: { profiles: { box: BOX }, tariff: t } })
  const r = computeEnergy(c, 'box', hours({ [H('2026-11-25T22:00:00Z')]: { busySec: 3600, calls: 1 } }))!
  near(r.cost!, 0.08 * 0.30 + 0.08 * 0.10)
})

test('editing the profile or the tariff re-prices the SAME stored usage (history is not baked in)', () => {
  const u = hours({ [H('2026-11-25T23:00:00Z')]: { busySec: 1800, calls: 3 } })
  const a = cfg({ currency: { fx: { EUR: 0.92 } }, energy: { profiles: { box: BOX }, tariff: { currency: 'EUR', flatPerKWh: 0.30 } } })
  const b = cfg({ currency: { fx: { EUR: 0.92 } }, energy: { profiles: { box: { powerW: { idle: 40, load: 360 } } }, tariff: NIGHT } })
  const ra = computeEnergy(a, 'box', u)!
  const rb = computeEnergy(b, 'box', u)!
  near(ra.kwh, 160 * 1800 / 3.6e6); near(ra.cost!, ra.kwh * 0.30)
  near(rb.kwh, 320 * 1800 / 3.6e6); near(rb.cost!, rb.kwh * 0.10)
  assert.equal(computeEnergy(a, 'box', u), ra, 'same inputs: memoised')
})

test('the formula line has the numbers in it', () => {
  const c = cfg({ energy: { profiles: { box: { ...BOX, pue: 1.5 } } } })
  const r = computeEnergy(c, 'box', hours({ 1: { busySec: 90, calls: 1 } }))!
  assert.match(r.formula, /^160 W \(200 - 40\) x 90\.00 s x pue 1\.50 \/ 3\.6e6 = 0\.0060 kWh$/)
})

// ── in the overlay ──────────────────────────────────────────────────────────

const OLL = (energy?: EnergyUsage) => ({
  tokensUsed: 20_000, model: 'qwen3:32b', runtime: 'hermes',
  spend: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, model: 'qwen3:32b', provider: 'ollama', ...(energy ? { energy } : {}) },
})
const LOCAL_CFG = (extra: Record<string, unknown> = {}) => cfg({
  currency: { display: 'EUR', fx: { EUR: 0.92 } },
  pricing: { providers: { ollama: { billing: 'local', energyProfile: 'box' } } },
  energy: { profiles: { box: BOX }, tariff: { currency: 'EUR', flatPerKWh: 0.25 } }, ...extra,
})

test('overlay: a local agent shows kWh and cost; the money unit shows the electricity cost, the kWh unit both', () => {
  const c = LOCAL_CFG()
  const cost = priceAgent(c, OLL(hours({ 100: { busySec: 3600, calls: 4 } })))
  assert.ok(cost.energy)
  near(cost.energy!.kwh, 0.16)
  assert.equal(localFigure(cost, 'money', c), '~€0.040')
  assert.equal(localFigure(cost, 'kwh', c), '0.160 kWh · ~€0.040')
  const pill = buildPillLabel(cost, 20_000, 'kwh', c)!
  assert.equal(pill.flavor, 'local'); assert.equal(pill.text, '0.160 kWh · ~€0.040'); assert.equal(pill.badge, 'est')
  assert.equal(buildPillLabel(cost, 20_000, 'money', c)!.text, '~€0.040')
  assert.equal(buildPillLabel(cost, 20_000, 'tokens', c)!.text, '20k tok')
})

test('overlay: without a tariff the pill shows kWh only; with no profile or no busy time it says the figure is not computed', () => {
  const c = cfg({ pricing: { providers: { ollama: { billing: 'local', energyProfile: 'box' } } }, energy: { profiles: { box: BOX } } })
  const cost = priceAgent(c, OLL(hours({ 100: { busySec: 3600, calls: 1 } })))
  assert.equal(buildPillLabel(cost, 20_000, 'money', c)!.text, '0.160 kWh')
  const none = priceAgent(c, OLL())
  assert.equal(buildPillLabel(none, 20_000, 'kwh', c)!.text, '– kWh')
  const noProfile = priceAgent(cfg(), OLL(hours({ 100: { busySec: 3600, calls: 1 } })))
  assert.equal(noProfile.energy, null)
  assert.equal(buildPillLabel(noProfile, 20_000, 'kwh', cfg())!.text, '– kWh')
})

test('overlay: the summary sums kWh and cost over local agents and keeps them apart from API money', () => {
  const c = LOCAL_CFG()
  const a = priceAgent(c, OLL(hours({ 100: { busySec: 3600, calls: 1 } })))
  const b = priceAgent(c, OLL(hours({ 100: { busySec: 1800, calls: 1 } })))
  const s = buildCostSummary([{ name: 'a', cost: a, tokens: 1 }, { name: 'b', cost: b, tokens: 1 }], 'kwh', c)
  assert.deepEqual(s.lines, [{ flavor: 'local', text: '0.240 kWh · ~€0.060', label: 'local (est.)' }])
  assert.deepEqual(s.rows.map(r => r.name), ['a', 'b'])
  assert.equal(s.rows[0].ratio, 1)
})

test('overlay: summary without a profile says why there is no kWh', () => {
  const c = cfg()
  const s = buildCostSummary([{ name: 'a', cost: priceAgent(c, OLL()), tokens: 1 }], 'kwh', c)
  assert.equal(s.lines[0].text, '– kWh')
  assert.match(s.notes.join(' '), /without an energy profile/)
})

test('tooltip: provider, formula, inputs and the tariff window of a local agent', () => {
  const night = cfg({
    currency: { display: 'EUR', fx: { EUR: 0.92 } }, pricing: { providers: { ollama: { billing: 'local', energyProfile: 'box' } } },
    energy: { profiles: { box: { ...BOX, pue: 1.2, throughput: { genTokPerSec: 40, prefillTokPerSec: 400 } } }, tariff: NIGHT },
  })
  const u = hours({ [H('2026-11-25T23:00:00Z')]: { busySec: 600, callSec: 800, calls: 5, untimedCalls: 1, untimedOutTok: 400, untimedInTok: 4000 } })
  const cost = priceAgent(night, OLL(u))
  const t = buildAgentTooltip(cost, night)
  const row = (id: string) => t.rows.find(r => r.id === id)!.value
  assert.match(row('provider'), /^ollama \(Ollama \(local\)\)$/)
  assert.match(row('billing-kind'), /estimated: configured power, not measured/)
  assert.match(row('busy-time'), /^620\.00 s busy/)
  assert.match(row('busy-time'), /600\.00 s from call latency \(5 calls; overlapping calls split load: their latencies add up to 800\.00 s, 200\.00 s was shared\)/)
  assert.match(row('busy-time'), /20\.00 s modelled from configured throughput \(1 call without latency/)
  assert.match(row('attribution'), /marginal · pue 1\.20 · charged 160 W \(load - idle\)/)
  assert.match(row('kwh-formula'), /160 W \(200 - 40\) x 620\.00 s x pue 1\.20 \/ 3\.6e6 = 0\.033 kWh/)
  assert.match(row('tariff'), /22:00-06:00 mon,tue,wed,thu,fri,sat,sun @ 0\.10 EUR\/kWh: 0\.033 kWh = €0\.003307/)
  assert.equal(row('result'), '0.033 kWh · €0.003307')
  assert.ok(!tooltipPlainText(t).includes('P5'), 'no placeholder text left')
})

test('tooltip: a profile that is not defined says so', () => {
  const c = cfg({ pricing: { providers: { ollama: { billing: 'local', energyProfile: 'ghost' } } } })
  const t = buildAgentTooltip(priceAgent(c, OLL()), c)
  assert.match(t.rows.find(r => r.id === 'busy-time')!.value, /energy profile "ghost" is not defined/)
})

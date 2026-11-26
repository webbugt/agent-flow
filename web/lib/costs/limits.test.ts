import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIVE_HOURS_MS, SEVEN_DAYS_MS, calibrate, calibrationPairs, callUnits, currentFiveHourWindow, fableComposition, fableMode,
  median, unitsInWindow, usedFraction, weeklyWindow,
} from './limits'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 25, 8, 0, 0)

test('5h window: first call starts it; a call at exactly start+5h starts the next', () => {
  const calls = [T0, T0 + 1 * H, T0 + 4.9 * H]
  const w = currentFiveHourWindow(calls, { now: T0 + 4.95 * H })!
  assert.equal(w.start, T0); assert.equal(w.end, T0 + 5 * H); assert.equal(w.source, 'inferred')
  const next = currentFiveHourWindow([...calls, T0 + 5 * H], { now: T0 + 5 * H })!
  assert.equal(next.start, T0 + 5 * H)
  assert.equal(currentFiveHourWindow(calls, { now: T0 + 5 * H }), null, 'the old window is over and nothing started a new one')
  assert.equal(currentFiveHourWindow([], { now: T0 }), null)
  assert.equal(currentFiveHourWindow([T0 + H], { now: T0 }), null, 'calls from the future are ignored')
})

test('5h window: unsorted and non-finite input, and chained windows', () => {
  const calls = [T0 + 6 * H, Number.NaN, T0, T0 + 11.5 * H]
  const w = currentFiveHourWindow(calls, { now: T0 + 12 * H })!
  assert.equal(w.start, T0 + 11.5 * H)   // [0,5) -> call at 6 starts [6,11) -> call at 11.5 starts [11.5,16.5)
  assert.equal(currentFiveHourWindow(calls, { now: T0 + 7 * H })!.start, T0 + 6 * H)
})

test('5h window: an observed resets_at wins; a stale or implausible one is ignored', () => {
  const now = T0 + 2 * H
  const w = currentFiveHourWindow([T0], { now, observedResetsAt: T0 + 5.5 * H })!
  assert.deepEqual([w.start, w.end, w.source], [T0 + 0.5 * H, T0 + 5.5 * H, 'observed'])
  assert.equal(currentFiveHourWindow([T0], { now, observedResetsAt: now - 1 })!.source, 'inferred', 'a past resets_at is stale')
  assert.equal(currentFiveHourWindow([T0], { now, observedResetsAt: now + 6 * H })!.source, 'inferred', 'resets more than 5h away cannot be the 5h window')
  assert.equal(currentFiveHourWindow([], { now, observedResetsAt: now + H })!.source, 'observed')
})

test('weekly window: observed [resets-7d, resets) or the trailing 7 days', () => {
  const now = T0
  const o = weeklyWindow(now, now + 2 * 24 * H)
  assert.deepEqual([o.start, o.end, o.source], [now + 2 * 24 * H - SEVEN_DAYS_MS, now + 2 * 24 * H, 'observed'])
  const t = weeklyWindow(now)
  assert.deepEqual([t.start, t.end, t.source], [now - SEVEN_DAYS_MS, now, 'trailing'])
  assert.equal(weeklyWindow(now, now - 1).source, 'trailing')
  assert.equal(FIVE_HOURS_MS, 5 * H)
})

test('unitsInWindow: start inclusive, end exclusive', () => {
  const w = { start: 100, end: 200, source: 'inferred' as const }
  assert.equal(unitsInWindow([{ at: 99, units: 1 }, { at: 100, units: 2 }, { at: 199, units: 4 }, { at: 200, units: 8 }], w), 6)
  assert.equal(callUnits({ fable: 3, mythos: 3, opus: 2, sonnet: 1, haiku: 0.5 }, 'opus', 10), 20)
  assert.equal(callUnits({ fable: 3, mythos: 3, opus: 2, sonnet: 1, haiku: 0.5 }, undefined, 10), 10)
})

test('calibration pairs: B = dC / (dp/100), >= 5 points apart, same window only, small moves fold into the next', () => {
  const obs = [
    { windowId: 'w1', at: 1, pct: 10, units: 10 },
    { windowId: 'w1', at: 2, pct: 12, units: 12 },   // +2 points: folded, not a pair
    { windowId: 'w1', at: 3, pct: 20, units: 30 },   // vs anchor (10, 10): dp 10, dC 20 -> B 200
    { windowId: 'w2', at: 4, pct: 5, units: 0 },
    { windowId: 'w2', at: 5, pct: 15, units: 30 },   // dp 10, dC 30 -> B 300
    { windowId: 'w2', at: 6, pct: 25, units: 30 },   // dC 0: skipped (no usage moved the meter locally), anchor still advances
  ]
  assert.deepEqual(calibrationPairs(obs), [200, 300])
  assert.deepEqual(calibrationPairs([{ windowId: 'a', at: 1, pct: 10, units: 5 }]), [])
  assert.deepEqual(calibrationPairs([{ windowId: 'a', at: 1, pct: Number.NaN, units: 5 }, { windowId: 'a', at: 2, pct: 40, units: 9 }]), [])
})

test('calibrate: median of the last 10, confidence tiers', () => {
  assert.deepEqual(calibrate([]), { budget: null, n: 0, confidence: 'none', relativeSpread: null })
  assert.deepEqual(calibrate([100]), { budget: 100, n: 1, confidence: 'low', relativeSpread: null })
  assert.equal(calibrate([100, 200]).confidence, 'medium')
  assert.equal(calibrate([100, 200]).budget, 150)
  const tight = calibrate([100, 101, 99, 100, 102])
  assert.equal(tight.confidence, 'high'); assert.equal(tight.budget, 100); assert.ok(tight.relativeSpread! < 0.15)
  const loose = calibrate([100, 200, 50, 400, 100])
  assert.equal(loose.confidence, 'medium')
  const many = calibrate([1000, 1000, ...Array.from({ length: 10 }, () => 100)])
  assert.equal(many.n, 10); assert.equal(many.budget, 100, 'only the last 10 pairs count')
  assert.equal(calibrate([-5, Number.NaN, 0]).confidence, 'none')
  assert.equal(median([3, 1, 2]), 2); assert.ok(Number.isNaN(median([])))
})

test('usedFraction: null until a budget is known', () => {
  assert.equal(usedFraction(50, null), null)
  assert.equal(usedFraction(50, 0), null)
  assert.equal(usedFraction(50, 200), 0.25)
})

test('Fable composition of the 5h session: share of window units from Fable (and Mythos)', () => {
  const w = { start: 0, end: 100, source: 'inferred' as const }
  const calls = [
    { at: 1, units: 6, family: 'fable' as const }, { at: 2, units: 2, family: 'sonnet' as const },
    { at: 3, units: 2, family: 'haiku' as const }, { at: 100, units: 99, family: 'fable' as const },
  ]
  assert.equal(fableComposition(calls, w), 0.6)
  assert.equal(fableComposition([{ at: 1, units: 1, family: 'sonnet' }], w), 0)
  assert.equal(fableComposition([], w), null)
  assert.equal(fableComposition([{ at: 500, units: 3, family: 'fable' }], w), null)
})

test('Fable is estimate-only unless the meter itself carries a Fable bucket', () => {
  assert.equal(fableMode(undefined), 'estimate-only')
  assert.equal(fableMode(['five_hour', 'seven_day']), 'estimate-only')
  assert.equal(fableMode(['five_hour', 'seven_day_fable']), 'observed')
})

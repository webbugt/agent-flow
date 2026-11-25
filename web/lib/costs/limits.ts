/**
 * Subscription-limit primitives (PLAN v1 3.3, v2 6.5): 5-hour window tracking, calibration of a
 * budget from observed (percentage, usage) pairs, and the Fable composition ratio. Pure.
 *
 * Out of scope here (task P6b): the Fable estimator with bounds, the weekly schedule with time
 * zones, counted-provider filtering, the observer that reads ~/.agent-flow/limits/claude.json.
 *
 * Every estimate is a LOWER BOUND: the local ledger sees only this machine's sessions.
 */
import type { ClaudeFamilyName } from './types'

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface LimitWindow {
  /** Inclusive start (ms epoch). */
  start: number
  /** Exclusive end (ms epoch): a call exactly at `end` belongs to the NEXT window. */
  end: number
  source: 'observed' | 'inferred' | 'trailing'
}

export interface WindowOptions {
  /** Observed `resets_at` (ms epoch). Overrides the inferred start: window = [resets_at - 5h, resets_at). */
  observedResetsAt?: number | null
  /** Evaluation time (ms epoch). Default: now. */
  now?: number
}

/**
 * The 5-hour window containing `now`. The first call starts a window; a call at or after start+5h
 * starts the next one. Returns null when there is no call and no observation, or when the inferred
 * window already ended (no active window). An observed `resets_at` in the future wins.
 */
export function currentFiveHourWindow(callTimes: readonly number[], opts: WindowOptions = {}): LimitWindow | null {
  const now = opts.now ?? Date.now()
  const r = opts.observedResetsAt
  if (r !== undefined && r !== null && Number.isFinite(r) && r > now && r - FIVE_HOURS_MS <= now) {
    return { start: r - FIVE_HOURS_MS, end: r, source: 'observed' }
  }
  let start: number | null = null
  for (const t of [...callTimes].filter(Number.isFinite).sort((a, b) => a - b)) {
    if (t > now) break
    if (start === null || t >= start + FIVE_HOURS_MS) start = t
  }
  if (start === null || now >= start + FIVE_HOURS_MS) return null
  return { start, end: start + FIVE_HOURS_MS, source: 'inferred' }
}

/** Weekly window: `[resets_at - 7d, resets_at)` when observed, else the trailing 7 days (labelled as such). */
export function weeklyWindow(now: number, observedResetsAt?: number | null): LimitWindow {
  if (observedResetsAt !== undefined && observedResetsAt !== null && Number.isFinite(observedResetsAt) && observedResetsAt > now) {
    return { start: observedResetsAt - SEVEN_DAYS_MS, end: observedResetsAt, source: 'observed' }
  }
  return { start: now - SEVEN_DAYS_MS, end: now, source: 'trailing' }
}

/** Sum of `units` of calls inside `w` (start inclusive, end exclusive). */
export function unitsInWindow(calls: readonly { at: number; units: number }[], w: LimitWindow): number {
  let s = 0
  for (const c of calls) if (c.at >= w.start && c.at < w.end) s += c.units
  return s
}

/** Limit units of one call: the family weight x list-equivalent USD. Default weight 1 [UNVERIFIED: limit use is proportional to list price]. */
export function callUnits(weights: Readonly<Record<ClaudeFamilyName, number>>, family: ClaudeFamilyName | undefined, listEquivUsd: number): number {
  return (family ? weights[family] : 1) * listEquivUsd
}

// ── calibration ─────────────────────────────────────────────────────────────

/** One reading of the observed meter next to the local units counted in the same window. */
export interface Observation {
  /** Same value = same limit window (e.g. the observed `resets_at`). */
  windowId: string
  at: number
  /** Observed used percentage, 0-100. */
  pct: number
  /** Local cumulative units within the window at `at`. */
  units: number
}

export const MIN_DELTA_PCT = 5
export const KEEP_PAIRS = 10

/**
 * Budget estimates B = dC / (dp / 100) from consecutive readings of the SAME window that moved at
 * least 5 points. Pairs restart at each window id; readings that moved less are folded into the next.
 */
export function calibrationPairs(observations: readonly Observation[]): number[] {
  const byWindow = new Map<string, Observation[]>()
  for (const o of observations) {
    if (![o.at, o.pct, o.units].every(Number.isFinite)) continue
    const list = byWindow.get(o.windowId) ?? []
    list.push(o); byWindow.set(o.windowId, list)
  }
  const out: { at: number; b: number }[] = []
  for (const list of byWindow.values()) {
    list.sort((a, b) => a.at - b.at)
    let anchor = list[0]
    for (const o of list.slice(1)) {
      const dp = o.pct - anchor.pct
      const dc = o.units - anchor.units
      if (dp >= MIN_DELTA_PCT) {
        if (dc > 0) out.push({ at: o.at, b: dc / (dp / 100) })
        anchor = o
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).map(x => x.b)
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export type Confidence = 'high' | 'medium' | 'low' | 'none'

export interface Calibration {
  /** Median of the last 10 pair estimates; null with no pairs. */
  budget: number | null
  n: number
  confidence: Confidence
  /** MAD / median of the pairs used (null with < 2 pairs). */
  relativeSpread: number | null
}

/** high: n >= 5 and MAD/median < 0.15; medium: n >= 2; low: n = 1; none: no pairs. */
export function calibrate(pairs: readonly number[]): Calibration {
  const used = pairs.filter(b => Number.isFinite(b) && b > 0).slice(-KEEP_PAIRS)
  const n = used.length
  if (n === 0) return { budget: null, n: 0, confidence: 'none', relativeSpread: null }
  const budget = median(used)
  const mad = n >= 2 ? median(used.map(b => Math.abs(b - budget))) : null
  const rel = mad === null ? null : mad / budget
  const confidence: Confidence = n >= 5 && rel !== null && rel < 0.15 ? 'high' : n >= 2 ? 'medium' : 'low'
  return { budget, n, confidence, relativeSpread: rel }
}

/** Used fraction (0-1+) of a budget; null while the budget is unknown ("set your limit to see %"). */
export function usedFraction(units: number, budget: number | null): number | null {
  return budget !== null && budget > 0 ? units / budget : null
}

// ── Fable ───────────────────────────────────────────────────────────────────

/**
 * "Fable share of this 5h session": units of Fable calls over units of all calls in the window.
 * A composition ratio that needs no budget. null when the window holds no usage.
 */
export function fableComposition(calls: readonly { at: number; units: number; family?: ClaudeFamilyName }[], w: LimitWindow): number | null {
  let total = 0; let fable = 0
  for (const c of calls) {
    if (c.at < w.start || c.at >= w.end) continue
    total += c.units
    if (c.family === 'fable' || c.family === 'mythos') fable += c.units
  }
  return total > 0 ? fable / total : null
}

/** `observed` only if the meter itself carries a Fable / per-model bucket; today none does, so Fable is estimate-only. */
export function fableMode(observedBuckets: readonly string[] | undefined): 'observed' | 'estimate-only' {
  return observedBuckets?.some(k => /fable|mythos/i.test(k)) ? 'observed' : 'estimate-only'
}

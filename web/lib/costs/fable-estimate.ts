/**
 * Fable weekly-limit estimator (PLAN v2 6.3). Pure.
 *
 * Claude Code does not report a Fable meter, so the percentage is ALWAYS an estimate and always comes with bounds,
 * a confidence label and the basis it was calibrated on. With `u` the list-equivalent value of the Fable calls in
 * the weekly window (counted providers, this machine only), `s` Fable's share of the weekly limit and `rho` the
 * unverified relative weight of Fable against other models:
 *
 *   basis 1  manual anchors        p = u / B_F             bounds: min / max of the anchor intervals (s, rho drop out)
 *   basis 2  weekly meter x share  B_F = s * B_7d          p_pt = u / (s_pt B_pt)
 *                                                          p_lo = u rho_lo / (s_hi B_hi)
 *                                                          p_hi = u (1 + 0) rho_hi / (s_lo B_lo)
 *   basis 3  typed budget          B_F = s * B_7d (or B_F) with the unseen-usage allowance delta_u in the upper bound
 *   basis 4  nothing               no number
 *
 * B_lo / B_pt / B_hi are the nearest-rank P10 / median / P90 of the calibration pairs (min / median / max below 5
 * pairs) over BOTH hypotheses about whether the observed weekly meter includes Fable (H1) or not (H2).
 * Invariant: `lower <= point <= upper`. If the user's own bands exclude the point (e.g. rho_lo > 1) the bound is
 * widened to include it, so the order can never be violated.
 */
import { calibrate, nearestRank, median } from './limits'
import type { Band } from './types'
import type { Confidence } from './limits'

export type FableBasis = 1 | 2 | 3 | 4
export type FableBasisKey = 'anchors' | 'weekly-meter' | 'typed-budget' | 'none'

/** A manual anchor turned into a budget estimate for Fable (units per 100%), with the interval the rounding of the typed % allows. */
export interface AnchorBudget { b: number; bLo: number; bHi: number }

export interface FableEstimateInput {
  /** `u`: list-equivalent units of the Fable calls in the weekly window. */
  usedUnits: number
  /** Weekly budgets B_j (units per 100%) from observed pairs, hypothesis H1 (the weekly meter includes Fable). */
  pairsH1: readonly number[]
  /** The same pairs under H2 (the weekly meter excludes Fable): the pair's units minus its Fable units. */
  pairsH2: readonly number[]
  /** Budgets of Fable itself from the user's anchors. */
  anchors: readonly AnchorBudget[]
  share: Band
  relativeWeight: { lo: number; hi: number }
  /** Unseen-usage allowance (basis 3 only). */
  deltaU: number
  /** The user's typed weekly budget (units), no observed meter. */
  typedWeeklyBudget: number | null
  /** The user's typed Fable budget (units): used as B_F directly. */
  typedFableBudget: number | null
}

export interface FableEstimate {
  basis: FableBasis
  basisKey: FableBasisKey
  /** Fractions (0.0034 = 0.34%). All null for basis 4. */
  point: number | null
  lower: number | null
  upper: number | null
  confidence: Confidence
  /** Number of pairs the budget comes from (anchors for basis 1); 0 for typed budgets. */
  n: number
  /** Budgets (units per 100% of the Fable limit) behind the bounds; null for basis 4. */
  budget: { lo: number; pt: number; hi: number } | null
  usedUnits: number
}

export const DEFAULT_DELTA_U = 0.25

const finitePos = (x: number): boolean => Number.isFinite(x) && x > 0

/** Percentile triple of a list of budgets: nearest-rank P10 / median / P90 from 5 values on, else min / median / max. */
export function budgetBand(values: readonly number[], n: number): { lo: number; pt: number; hi: number } | null {
  const xs = values.filter(finitePos).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const pt = median(xs)
  return n >= 5 ? { lo: nearestRank(xs, 0.1), pt, hi: nearestRank(xs, 0.9) } : { lo: xs[0], pt, hi: xs[xs.length - 1] }
}

/** Order the three values (lower <= point <= upper) by widening the bounds; clamp at 0 below. */
function ordered(lo: number, pt: number, hi: number): { lower: number; point: number; upper: number } {
  const point = Math.max(0, pt)
  return { lower: Math.max(0, Math.min(lo, point)), point, upper: Math.max(hi, point) }
}

function none(usedUnits: number): FableEstimate {
  return { basis: 4, basisKey: 'none', point: null, lower: null, upper: null, confidence: 'none', n: 0, budget: null, usedUnits }
}

export function estimateFable(input: FableEstimateInput): FableEstimate {
  const u = Math.max(0, Number.isFinite(input.usedUnits) ? input.usedUnits : 0)
  const { share: s, relativeWeight: rho } = input

  // 1. manual anchors: the user typed Fable's own %, so share and relative weight drop out.
  const anchors = input.anchors.filter(a => finitePos(a.b) && finitePos(a.bLo) && finitePos(a.bHi))
  if (anchors.length > 0) {
    const cal = calibrate(anchors.map(a => a.b))
    const n = anchors.length
    const pt = cal.budget as number
    // Bounds: the widest interval any anchor allows (min of the low ends, max of the high ends), widened to hold the median.
    const bLo = Math.min(pt, ...anchors.map(a => a.bLo))
    const bHi = Math.max(pt, ...anchors.map(a => a.bHi))
    const o = ordered(u / bHi, u / pt, u / bLo)
    return { basis: 1, basisKey: 'anchors', point: o.point, lower: o.lower, upper: o.upper, confidence: cal.confidence, n, budget: { lo: bLo, pt, hi: bHi }, usedUnits: u }
  }

  // 2. weekly meter x share
  const nPairs = input.pairsH1.length
  const union = [...input.pairsH1, ...input.pairsH2]
  const band = budgetBand(union, nPairs)
  if (band) {
    const o = ordered(
      (u * rho.lo) / (s.hi * band.hi),
      u / (s.point * band.pt),
      (u * rho.hi) / (s.lo * band.lo),
    )
    // Capped at `low`: the relative weight is unverified. (Anchors that would corroborate it are basis 1 above.)
    return { basis: 2, basisKey: 'weekly-meter', point: o.point, lower: o.lower, upper: o.upper, confidence: 'low', n: nPairs, budget: { lo: s.lo * band.lo, pt: s.point * band.pt, hi: s.hi * band.hi }, usedUnits: u }
  }

  // 3. typed budget: no meter. The unseen-usage allowance applies because the budget is not tied to this machine's ledger.
  const typedF = input.typedFableBudget !== null && finitePos(input.typedFableBudget)
  const typedW = input.typedWeeklyBudget !== null && finitePos(input.typedWeeklyBudget)
  if (typedF || typedW) {
    const bPt = typedF ? (input.typedFableBudget as number) : s.point * (input.typedWeeklyBudget as number)
    const bHi = typedF ? bPt : s.hi * (input.typedWeeklyBudget as number)
    const bLo = typedF ? bPt : s.lo * (input.typedWeeklyBudget as number)
    const delta = Math.max(0, input.deltaU)
    const o = ordered((u * rho.lo) / bHi, u / bPt, (u * (1 + delta) * rho.hi) / bLo)
    return { basis: 3, basisKey: 'typed-budget', point: o.point, lower: o.lower, upper: o.upper, confidence: 'low', n: 0, budget: { lo: bLo, pt: bPt, hi: bHi }, usedUnits: u }
  }

  // 4. nothing to calibrate on
  return none(u)
}

/** Basis names as shown on the hover. */
export function basisText(e: FableEstimate, share: Band, fmtDay: (ms: number) => string, pairSpan: { from: number; to: number } | null, anchorCount: number): string {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`
  switch (e.basisKey) {
    case 'anchors': return `manual anchors (${e.n} from claude.ai usage page); weekly meter not used`
    case 'weekly-meter': {
      const d0 = pairSpan ? fmtDay(pairSpan.from) : ''
      const d1 = pairSpan ? fmtDay(pairSpan.to) : ''
      const span = pairSpan ? `, ${d0 === d1 ? d0 : `${d0}..${d1}`}` : ''
      return `weekly meter x ${pct(share.point)} share (${e.n} pair${e.n === 1 ? '' : 's'}${span}); manual anchors: ${anchorCount}`
    }
    case 'typed-budget': return `typed budget x ${pct(share.point)} share (no weekly-meter calibration pairs yet); manual anchors: ${anchorCount}`
    case 'none': return 'none: no weekly meter pairs, no typed budget, no anchors'
  }
}

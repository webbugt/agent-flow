/**
 * View model of the LIMITS panel (PLAN v2 6.3-6.5, 7.2; task P6b). Pure: config, the host's `limits-update` payload
 * (observed readings + their history) and the ledger's time buckets go in, plain text and numbers come out; the clock
 * is injected so tests do not depend on the machine's time zone.
 *
 * Rows: `5h`, `7d` and `Fable` (only when Fable calls were counted in the weekly window).
 *  - 5h / 7d: the observed percentage when Claude Code reported one (tag `obs`, or `stale` with "as of"), else an estimate:
 *    `cal`  budget calibrated from observed (percentage, local usage) pairs   -> `~12%`
 *    `est`  budget typed by the user (not tied to this machine's ledger)       -> `>=12%` (a lower bound)
 *    none   no budget: no number, "set your limit to see %".
 *    A calibrated number is also a lower bound (`>=`) when the ledger does not reach back to the window start.
 *  - Fable: ESTIMATE ONLY (Claude Code reports no Fable meter): the point value with the estimate icon; the hover
 *    carries lower / upper bound, confidence, calibration basis and assumptions (fable-estimate.ts).
 * Every figure says which provider it comes from and whether it is observed or estimated (never billed money: limits
 * are not prices; the list-equivalent value is shown as such).
 */
import { buildObservedLimitsView, formatUntil, type LocalClock } from './observed-limits'
import type { LimitsUpdatePayload, ObservedReading } from './observed-types'
import {
  FIVE_HOURS_MS, SEVEN_DAYS_MS, calibrate, calibrationPairsAt, currentFiveHourWindow, fableComposition, nextWeeklyReset, unitsInWindow, weeklyWindow,
  type Calibration, type LimitWindow, type Observation,
} from './limits'
import { DEFAULT_DELTA_U, basisText, estimateFable, type AnchorBudget, type FableEstimate } from './fable-estimate'
import { buildLimitCalls, isFableFamily, TIME_SLOT_MS, type LimitCall } from './limits-calls'
import { describePlan, type PlanDescription } from './limits-plans'
import { formatLimitPct, formatMoney } from './format'
import type { ResolvedConfig, UsageTokens } from './types'

export type RowId = '5h' | '7d' | 'fable'
export type RowTag = 'obs' | 'stale' | 'cal' | 'est'

export interface FableTooltip {
  title: string
  /** `estimate 3.4‰    lower bound 1.6‰    upper bound 7.6‰`, or the no-number text. */
  valueLine: string
  point: string | null
  lower: string | null
  upper: string | null
  confidence: string
  basis: string
  assumptions: string
  used: string
  scope: string
  composition: string | null
}

export interface LimitRow {
  id: RowId
  label: string
  /** 0..1 for the bar; null without a number. */
  fraction: number | null
  /** `37%`, `~3.4‰`, `>=12%`, or `–`. */
  valueText: string
  tag: RowTag | null
  /** Estimate icon (≈): every number that is not observed. */
  estimate: boolean
  lowerBound: boolean
  resetText: string
  asOfText: string | null
  /** Short line under the row: what the figure is made of, or what is missing. */
  hint: string | null
  /** Native hover text (rows other than Fable; Fable has `fable`). */
  title: string
  fable?: FableTooltip
}

export interface LimitsPanelModel {
  visible: boolean
  plan: PlanDescription | null
  /** `Claude Max 5x · 5x Pro` or `plan not set`. */
  planText: string
  rows: LimitRow[]
  notes: string[]
}

export interface LimitsModelInput {
  config: ResolvedConfig
  payload: LimitsUpdatePayload | null
  /** `byTime` of every agent (SpendTotals.byTime). */
  spends: readonly (Readonly<Record<string, UsageTokens>> | undefined)[]
  now: number
  clock: LocalClock
}

const PROVIDER = 'Claude Code'
const HIDDEN: LimitsPanelModel = { visible: false, plan: null, planText: '', rows: [], notes: [] }

const atText = (clock: LocalClock, ms: number, now: number): string => (clock.sameDay(ms, now) ? clock.hm(ms) : clock.dayHm(ms))
const usd = (x: number): string => formatMoney(x, 'USD')

/** A bound or point in a Fable hover: formatted on its own (so a range may cross units), `>=100%` when it passes the limit. */
export function formatBound(f: number): string { return f >= 1 ? '>=100%' : formatLimitPct(f, 'observed') }

// ── calibration pairs from the reading history ───────────────────────────────

/** Same limit window = same reset time (rounded to 5 minutes: a reset reported a few seconds apart is one window). */
const windowIdOf = (resetsAt: number): string => String(Math.round(resetsAt / 300_000))

export interface PairSet { pairs: { at: number; b: number }[]; from: number | null; to: number | null }

/** Budget estimates from the readings of one meter: local units (all calls, or all but Fable) inside the window up to each reading. */
export function pairsFromHistory(
  history: readonly ObservedReading[], key: 'fiveHour' | 'sevenDay', calls: readonly LimitCall[], excludeFable: boolean,
): PairSet {
  const span = key === 'fiveHour' ? FIVE_HOURS_MS : SEVEN_DAYS_MS
  const pool = excludeFable ? calls.filter(c => !isFableFamily(c.family)) : calls
  const obs: Observation[] = []
  for (const r of history) {
    const w = r[key]
    if (!w) continue
    const win: LimitWindow = { start: w.resetsAt - span, end: Math.min(w.resetsAt, r.at + 1), source: 'observed' }
    obs.push({ windowId: windowIdOf(w.resetsAt), at: r.at, pct: w.usedPct, units: unitsInWindow(pool, win) })
  }
  const pairs = calibrationPairsAt(obs)
  return { pairs, from: pairs.length ? pairs[0].at : null, to: pairs.length ? pairs[pairs.length - 1].at : null }
}

/** The weekly window that contained `t`: from a reading's reset time, else the configured schedule, else the 7 days before. */
function weeklyWindowAt(t: number, history: readonly ObservedReading[], config: ResolvedConfig): LimitWindow {
  let best: number | null = null
  for (const r of history) {
    const e = r.sevenDay?.resetsAt
    if (e !== undefined && e > t && e - SEVEN_DAYS_MS <= t && (best === null || e < best)) best = e
  }
  if (best !== null) return { start: best - SEVEN_DAYS_MS, end: best, source: 'observed' }
  const sched = config.limits.claude.weekly.resetsAt
  if (sched) {
    const end = nextWeeklyReset(t, sched)
    if (end !== null) return { start: end - SEVEN_DAYS_MS, end, source: 'schedule' }
  }
  return { start: t - SEVEN_DAYS_MS, end: t + 1, source: 'trailing' }
}

/** Manual Fable anchors (`at`, the % read on claude.ai) as budgets of Fable itself: B = Fable units up to `at` / (p / 100). */
export function anchorBudgets(config: ResolvedConfig, calls: readonly LimitCall[], history: readonly ObservedReading[]): AnchorBudget[] {
  const out: AnchorBudget[] = []
  for (const a of config.limits.claude.fable.anchors) {
    const t = Date.parse(a.at)
    if (!Number.isFinite(t) || !(a.observedPct > 0)) continue
    const w = weeklyWindowAt(t, history, config)
    const fable = calls.filter(c => isFableFamily(c.family))
    const c = unitsInWindow(fable, { ...w, end: Math.min(w.end, t + 1) })
    if (!(c > 0)) continue
    // The % was typed rounded: allow half a point (a tiny value, less).
    const h = Math.min(0.5, a.observedPct / 2)
    out.push({ b: c / (a.observedPct / 100), bLo: c / ((a.observedPct + h) / 100), bHi: c / ((a.observedPct - h) / 100) })
  }
  return out
}

// ── row construction ─────────────────────────────────────────────────────────

interface Common { config: ResolvedConfig; payload: LimitsUpdatePayload | null; calls: readonly LimitCall[]; now: number; clock: LocalClock }

function resetTextOf(w: LimitWindow, now: number, clock: LocalClock): string {
  const left = w.end - now
  if (w.source === 'trailing') return 'trailing 7d'
  if (left <= 0) return ''
  return left < 24 * 3_600_000 ? `resets in ${formatUntil(left)}` : `resets ${atText(clock, w.end, now)}`
}

function sourceText(w: LimitWindow): string {
  return w.source === 'observed' ? 'observed reset time' : w.source === 'schedule' ? 'configured weekly reset' : w.source === 'inferred' ? 'first call of the window' : 'trailing 7 days (no reset time known)'
}

function unitsHint(listUsd: number, weighted: number): string {
  return weighted !== listUsd ? `${usd(listUsd)} list-equiv (weighted ${usd(weighted)})` : `${usd(listUsd)} list-equiv`
}

function ledgerCovers(calls: readonly LimitCall[], w: LimitWindow): boolean {
  if (calls.length === 0) return false
  return calls[0].at <= w.start + TIME_SLOT_MS
}

interface EstimateBasis { budget: number; tag: 'cal' | 'est'; cal: Calibration | null }

function budgetFor(typed: number | null, enabled: boolean, cal: Calibration): EstimateBasis | null {
  if (cal.budget !== null) return { budget: cal.budget, tag: 'cal', cal }
  if (enabled && typed !== null && typed > 0) return { budget: typed, tag: 'est', cal: null }
  return null
}

function meterRow(id: '5h' | '7d', c: Common, w: LimitWindow | null, cal: Calibration, typed: number | null, enabled: boolean, observedKey: 'five_hour' | 'seven_day'): LimitRow | null {
  const label = id === '5h' ? '5-hour' : 'Weekly'
  const view = buildObservedLimitsView(c.payload, c.now, c.clock)
  const o = view.rows.find(r => r.key === observedKey)
  const stale = view.asOfText
  // 1. observed
  if (o && o.tag !== 'ended' && o.fraction !== null) {
    return {
      id, label, fraction: o.fraction, valueText: o.valueText, tag: o.tag, estimate: false, lowerBound: false,
      resetText: o.resetText, asOfText: o.tag === 'stale' ? stale : null, hint: null, title: o.title,
    }
  }
  const ended = o?.tag === 'ended'
  if (!enabled && !ended) return null
  if (!w) {
    // No active 5-hour window (nothing counted in the last 5 hours): a number would describe nothing.
    return {
      id, label, fraction: null, valueText: '–', tag: null, estimate: false, lowerBound: false, resetText: '', asOfText: null,
      hint: 'no counted usage in the last 5 hours',
      title: `${PROVIDER} ${label} usage limit: no counted usage on this machine in the current window.${ended ? ' The last observed window has ended.' : ''}`,
    }
  }
  const windowCalls = c.calls.filter(x => x.at >= w.start && x.at < w.end)
  const units = windowCalls.reduce((s, x) => s + x.units, 0)
  const listUsd = windowCalls.reduce((s, x) => s + x.listUsd, 0)
  const basis = budgetFor(typed, enabled, cal)
  const used = unitsHint(listUsd, units)
  const resetText = resetTextOf(w, c.now, c.clock)
  if (!basis) {
    return {
      id, label, fraction: null, valueText: '–', tag: null, estimate: true, lowerBound: false, resetText, asOfText: null,
      hint: `set your ${id === '5h' ? '5-hour' : 'weekly'} limit to see %  ·  ${used}`,
      title: [
        `${PROVIDER} ${label} usage limit · no number: nothing to calibrate on yet.`,
        `Used on this machine in the window: ${used}.`,
        `Set a budget (limits.claude.${id === '5h' ? 'fiveHour' : 'weekly'}.budgetUsdEquiv) or install the statusLine wrapper so Agent Flow can calibrate against the real meter.`,
      ].join('\n'),
    }
  }
  const fraction = units / basis.budget
  const lowerBound = basis.tag === 'est' || !ledgerCovers(c.calls, w)
  const valueText = formatLimitPct(fraction, lowerBound ? 'lower-bound' : 'estimate')
  const how = basis.tag === 'cal'
    ? `calibrated budget ${usd(basis.budget)} per 100% (median of ${basis.cal!.n} observed pair${basis.cal!.n === 1 ? '' : 's'}, confidence ${basis.cal!.confidence})`
    : `budget typed in the config (${usd(basis.budget)} list-equiv per 100%)`
  const lines = [
    `${PROVIDER} ${label} usage limit · ESTIMATE from this machine's sessions (not reported by Claude Code, not a price)`,
    `Used: ${valueText} = ${used} / ${how}.`,
    ...(lowerBound ? [lowerBoundReason(basis.tag, c.calls, w)] : []),
    `Window: ${sourceText(w)}${w.source === 'trailing' ? '' : `, ends ${atText(c.clock, w.end, c.now)}`}.`,
    ended ? 'The last observed window has ended; its percentage no longer applies.' : 'No fresh observed reading for this window.',
  ]
  return {
    id, label, fraction, valueText, tag: basis.tag, estimate: true, lowerBound, resetText, asOfText: null,
    hint: used, title: lines.join('\n'),
  }
}

function lowerBoundReason(tag: 'cal' | 'est', calls: readonly LimitCall[], w: LimitWindow): string {
  if (tag === 'est') return 'Lower bound: other devices and claude.ai are not counted, and a typed budget is not tied to this ledger.'
  return calls.length === 0 || !ledgerCovers(calls, w)
    ? 'Lower bound: this machine\'s history starts after the window began, and other devices are not counted.'
    : 'Lower bound: other devices and claude.ai are not counted.'
}

function fableRow(c: Common, weekly: LimitWindow, plan: PlanDescription | null, fiveWindow: LimitWindow | null): { row: LimitRow | null; est: FableEstimate | null } {
  const cfg = c.config.limits.claude
  if (!cfg.fable.enabled) return { row: null, est: null }
  if (plan && !plan.traits.fableLimit) return { row: null, est: null }
  const fable = c.calls.filter(x => isFableFamily(x.family) && x.at >= weekly.start && x.at < weekly.end)
  if (fable.length === 0) return { row: null, est: null }   // decision 1: Fable is shown only when it was used in the window

  const history = c.payload?.history ?? []
  const p1 = pairsFromHistory(history, 'sevenDay', c.calls, false)
  const p2 = pairsFromHistory(history, 'sevenDay', c.calls, true)
  const anchors = anchorBudgets(c.config, c.calls, history)
  const usedUnits = fable.reduce((s, x) => s + x.units, 0)
  const listUsd = fable.reduce((s, x) => s + x.listUsd, 0)
  const typedWeekly = cfg.weekly.enabled ? cfg.weekly.budgetUsdEquiv : null
  const est = estimateFable({
    usedUnits, pairsH1: p1.pairs.map(x => x.b), pairsH2: p2.pairs.map(x => x.b), anchors,
    share: cfg.fable.shareOfWeekly, relativeWeight: cfg.fable.relativeWeight, deltaU: DEFAULT_DELTA_U,
    typedWeeklyBudget: typedWeekly, typedFableBudget: cfg.fable.budgetUsdEquiv,
  })
  // Anchors that agree with the weekly-meter estimate lift its confidence cap from low to medium (PLAN 6.3, basis 2).
  const confidence = est.basis === 2 && anchors.length >= 2 ? 'medium' : est.confidence

  const sharePct = (x: number) => `${Math.round(x * 1000) / 10}%`
  const shareText = sharePct(cfg.fable.shareOfWeekly.lo) === sharePct(cfg.fable.shareOfWeekly.hi)
    ? sharePct(cfg.fable.shareOfWeekly.point)
    : `${sharePct(cfg.fable.shareOfWeekly.lo)}..${sharePct(cfg.fable.shareOfWeekly.hi)}`
  const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const span = p1.from !== null && p1.to !== null ? { from: p1.from, to: p1.to } : null
  const basisLine = basisText(est, cfg.fable.shareOfWeekly, fmtDay, span, anchors.length)
  const comp = fiveWindow ? fableComposition(c.calls, fiveWindow) : null
  const hasNumber = est.point !== null
  const rho = cfg.fable.relativeWeight
  const hypotheses = est.basis === 2 ? 'Fable counted in weekly: both hypotheses applied' : est.basis === 1 ? 'share and relative weight not needed (manual anchors)' : est.basis === 3 ? `unseen-usage allowance +${Math.round(DEFAULT_DELTA_U * 100)}% in the upper bound` : 'none'
  const resetLine = weekly.source === 'trailing' ? 'trailing 7 days (no reset time known)' : `window resets ${atText(c.clock, weekly.end, c.now)} (${weekly.source})`
  const tooltip: FableTooltip = {
    title: 'Fable weekly limit - ESTIMATE (Claude Code does not report this)',
    point: hasNumber ? formatBound(est.point as number) : null,
    lower: hasNumber ? formatBound(est.lower as number) : null,
    upper: hasNumber ? formatBound(est.upper as number) : null,
    valueLine: hasNumber
      ? `estimate ${formatBound(est.point as number)}    lower bound ${formatBound(est.lower as number)}    upper bound ${formatBound(est.upper as number)}`
      : 'no estimate: set a limit to estimate',
    confidence: `confidence: ${confidence}`,
    basis: `calibration basis: ${basisLine}`,
    assumptions: `assumptions: relative weight [${rho.lo}, ${rho.hi}] (unverified); ${hypotheses}; share of weekly ${shareText} (prior)`,
    used: `used: ${usd(listUsd)} list-equiv of Fable this window; ${resetLine}`,
    scope: 'this machine\'s sessions only; other devices and claude.ai are not counted',
    composition: comp === null ? null : `Fable share of this 5h session: ${Math.round(comp * 100)}% (composition, no budget needed)`,
  }
  const title = [tooltip.title, tooltip.valueLine, tooltip.confidence, tooltip.basis, tooltip.assumptions, tooltip.used, tooltip.scope, ...(tooltip.composition ? [tooltip.composition] : [])].join('\n')
  const row: LimitRow = {
    id: 'fable', label: 'Fable', fraction: hasNumber ? Math.min(1, est.point as number) : null,
    valueText: hasNumber ? formatLimitPct(est.point as number, 'estimate') : '–', tag: hasNumber ? 'est' : null, estimate: true, lowerBound: false,
    resetText: resetTextOf(weekly, c.now, c.clock), asOfText: null,
    hint: hasNumber ? `${usd(listUsd)} list-equiv this window` : `set limit to estimate  ·  ${usd(listUsd)} list-equiv this window`,
    title, fable: tooltip,
  }
  return { row, est: { ...est, confidence } }
}

/** Reset time of the newest reading of a meter whose reset is still ahead, else null. */
export function lastResetAfter(history: readonly ObservedReading[], key: 'fiveHour' | 'sevenDay', now: number): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const w = history[i][key]
    if (w && w.resetsAt > now) return w.resetsAt
  }
  return null
}

// ── the panel ────────────────────────────────────────────────────────────────

export function buildLimitsPanel(input: LimitsModelInput): LimitsPanelModel {
  const { config, payload, now, clock } = input
  const cfg = config.limits.claude
  const plan = describePlan(cfg)
  if (plan && !plan.traits.limits) return HIDDEN                       // plan `api`: no limits UI
  const observed = payload?.observed ?? null
  if (!plan && !observed && !(payload?.history?.length)) return HIDDEN // nothing configured, nothing observed

  const calls = buildLimitCalls(config, input.spends)
  const history = payload?.history ?? []
  const c: Common = { config, payload, calls, now, clock }

  const obs5 = observed?.windows.find(w => w.kind === 'five_hour' && w.state !== 'expired')
  const obs7 = observed?.windows.find(w => w.kind === 'seven_day' && w.state !== 'expired')
  // Without a live reading the reset time of the newest earlier reading still holds until it passes (a reset is a fixed instant)
  const five = currentFiveHourWindow(calls.map(x => x.at), { now, observedResetsAt: obs5?.resetsAt ?? lastResetAfter(history, 'fiveHour', now) })
  const weekly = weeklyWindow(now, obs7?.resetsAt ?? lastResetAfter(history, 'sevenDay', now), cfg.weekly.resetsAt)

  const cal5 = calibrate(pairsFromHistory(history, 'fiveHour', calls, false).pairs.map(x => x.b))
  const cal7 = calibrate(pairsFromHistory(history, 'sevenDay', calls, false).pairs.map(x => x.b))

  const rows: LimitRow[] = []
  if (!plan || plan.traits.fiveHour || obs5) {
    const r = meterRow('5h', c, five, cal5, cfg.fiveHour.budgetUsdEquiv, cfg.fiveHour.enabled, 'five_hour')
    if (r) rows.push(r)
  }
  const r7 = meterRow('7d', c, weekly, cal7, cfg.weekly.budgetUsdEquiv, cfg.weekly.enabled, 'seven_day')
  if (r7) rows.push(r7)
  const f = fableRow(c, weekly, plan, five)
  if (f.row) rows.push(f.row)

  const notes: string[] = []
  if (calls.some(x => !x.priced)) notes.push('Some counted calls have no price, so they count as 0 toward the limits.')
  if (rows.some(r => r.estimate)) notes.push('Estimates use this machine\'s sessions only (Claude Code provider; Copilot never counts). Real meters cover the whole account.')
  return { visible: rows.length > 0, plan, planText: plan ? plan.text : 'plan not set', rows, notes }
}


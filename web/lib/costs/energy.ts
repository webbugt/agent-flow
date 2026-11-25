/**
 * Energy of local models (PLAN v1 3.2 + v2 P5). Pure, no I/O. Two halves:
 *
 *  1. INGESTION (host, once per call): `EnergyLedger` turns each call's wall-clock interval into per-session,
 *     per-UTC-hour busy seconds. Calls that overlap on the same device split the device's load time
 *     (`dt / k` for k active calls), so the device total is conserved. Nothing here knows watts or prices.
 *  2. PRICING (page, every render): `computeEnergy` applies the CURRENT config to the stored hours:
 *
 *        P_attr   = P_load - P_idle (marginal, default)  |  P_load (total)
 *        kWh      = P_attr x pue x busy_s / 3.6e6                         (W x s = J, 1 kWh = 3.6e6 J)
 *        cost     = sum over hour buckets of kWh_hour x price_hour        (price from the tariff, host time zone)
 *
 *     Because the stored data holds no watts and no prices, editing the profile or the tariff re-prices history.
 *
 * Busy time per call: the call's own latency when the log has one (tool-execution time is never added: only
 * API-call intervals are recorded), else `out / genTokPerSec + in_new / prefillTokPerSec` from the profile's
 * throughput. Calls without a latency have no interval, so they cannot take part in the overlap split; they count
 * their full modelled time (documented limit).
 *
 * The tariff is applied per UTC hour bucket, pro rata by the minutes of that hour inside each price window, in
 * the tariff's time zone (default: this device's). A window edge that falls inside an hour therefore splits the
 * hour's busy time evenly across the edge; edges on the hour (the common case) are exact. 23 h and 25 h DST days
 * need no special case: the buckets are UTC hours and each is looked up in local time.
 */
import type { EnergyHour, EnergyProfile, EnergyUsage, ResolvedConfig, Tariff, TariffWindow, Weekday } from './types'
import { WEEKDAYS } from './types'
import { fxFactor } from './price'
import { formatKwh, formatMoneyExact, formatRate } from './format'
import { resolveModelPricing } from './resolve'

export const HOUR_MS = 3_600_000
const JOULES_PER_KWH = 3.6e6

const hourIndexOf = (ms: number): number => Math.floor(ms / HOUR_MS)
const round3 = (n: number): number => Math.round(n * 1000) / 1000

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ingestion
// ─────────────────────────────────────────────────────────────────────────────

/** One call's wall-clock interval on a device. `owner` = the session (or agent) the call belongs to. */
export interface BusyInterval { owner: string; startMs: number; endMs: number }

interface Agg { busyMs: number; callMs: number; calls: number }
type OwnerHours = Map<string, Map<number, Agg>>

function aggAt(m: OwnerHours, owner: string, hour: number): Agg {
  let h = m.get(owner)
  if (!h) { h = new Map(); m.set(owner, h) }
  let a = h.get(hour)
  if (!a) { a = { busyMs: 0, callMs: 0, calls: 0 }; h.set(hour, a) }
  return a
}

/** Add `ms` between [a, b) to the hour buckets it crosses; `fn` gets (hour, ms inside it). */
function splitByHour(a: number, b: number, fn: (hour: number, ms: number) => void): void {
  let t = a
  while (t < b) {
    const hour = hourIndexOf(t)
    const end = Math.min(b, (hour + 1) * HOUR_MS)
    fn(hour, end - t)
    t = end
  }
}

/**
 * Interval sweep. Between two consecutive interval edges the active calls share the device: each gets
 * `dt / k`. Returns, per owner and UTC hour, the attributed load time, the owner's own (unsplit) call time and the
 * number of calls (counted in the hour in which the call ended). Intervals that are empty or not finite are ignored.
 */
export function sweepIntervals(intervals: readonly BusyInterval[]): OwnerHours {
  const out: OwnerHours = new Map()
  const valid = intervals.filter(i => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs)
  if (valid.length === 0) return out

  for (const i of valid) {
    splitByHour(i.startMs, i.endMs, (hour, ms) => { aggAt(out, i.owner, hour).callMs += ms })
    aggAt(out, i.owner, hourIndexOf(i.endMs - 1)).calls += 1
  }

  const starts = valid.map(i => i.startMs).sort((a, b) => a - b)
  const ends = valid.map(i => i.endMs).sort((a, b) => a - b)
  // Active calls per owner. Rebuilt at every edge from the sorted lists: walk the edges in order.
  const edges = [...new Set([...starts, ...ends])].sort((a, b) => a - b)
  const order = [...valid].sort((a, b) => a.startMs - b.startMs)
  const active = new Map<string, number>()
  let k = 0
  let next = 0
  const live: BusyInterval[] = []
  for (let e = 0; e < edges.length - 1; e++) {
    const t = edges[e]
    // calls ending at t leave, calls starting at t enter
    for (let j = live.length - 1; j >= 0; j--) {
      if (live[j].endMs <= t) {
        const o = live[j].owner
        const c = (active.get(o) ?? 0) - 1
        if (c <= 0) active.delete(o); else active.set(o, c)
        k--
        live.splice(j, 1)
      }
    }
    while (next < order.length && order[next].startMs <= t) {
      const iv = order[next++]
      if (iv.endMs > t) { live.push(iv); active.set(iv.owner, (active.get(iv.owner) ?? 0) + 1); k++ }
    }
    if (k === 0) continue
    const t2 = edges[e + 1]
    for (const [owner, count] of active) {
      splitByHour(t, t2, (hour, ms) => { aggAt(out, owner, hour).busyMs += (ms * count) / k })
    }
  }
  return out
}

interface DeviceState {
  intervals: BusyInterval[]
  result: OwnerHours
  frozen: OwnerHours
}

/** Intervals kept live per device; older ones are folded into fixed totals (a late call that overlaps them is then not split against them). */
const MAX_LIVE_INTERVALS = 4000
const FREEZE_COUNT = 1000

interface Untimed { calls: number; inTok: number; outTok: number }

/**
 * Per-session hour-bucketed busy time for a host that sees calls from several sessions. `device` groups calls that
 * share hardware (the relay uses the provider id: calls to one runtime share its GPU; different runtimes are
 * assumed to be different devices). Pure state, no I/O, no clock: every call brings its own times.
 */
export class EnergyLedger {
  private readonly devices = new Map<string, DeviceState>()
  private readonly untimed = new Map<string, Map<number, Untimed>>()

  /**
   * Record a call that has a known interval. Returns the owners whose attributed time changed (the caller's own
   * and the owners of calls it overlapped), so their totals can be republished.
   */
  recordTimed(device: string, owner: string, startMs: number, endMs: number): string[] {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return []
    let d = this.devices.get(device)
    if (!d) { d = { intervals: [], result: new Map(), frozen: new Map() }; this.devices.set(device, d) }
    const before = totalsOf(d.result)
    d.intervals.push({ owner, startMs, endMs })
    if (d.intervals.length > MAX_LIVE_INTERVALS) this.freeze(d)
    d.result = sweepIntervals(d.intervals)
    const after = totalsOf(d.result)
    const changed: string[] = []
    for (const [o, v] of after) if (Math.abs(v - (before.get(o) ?? 0)) > 1e-6 || o === owner) changed.push(o)
    return changed
  }

  /** Record a call without a latency: its tokens are kept per hour; the page models the busy time from the profile's throughput. */
  recordUntimed(owner: string, atMs: number, inputTokens: number, outputTokens: number): void {
    if (!Number.isFinite(atMs)) return
    let m = this.untimed.get(owner)
    if (!m) { m = new Map(); this.untimed.set(owner, m) }
    const hour = hourIndexOf(atMs)
    const u = m.get(hour) ?? { calls: 0, inTok: 0, outTok: 0 }
    u.calls += 1
    u.inTok += Math.max(0, inputTokens)
    u.outTok += Math.max(0, outputTokens)
    m.set(hour, u)
  }

  /** The stored busy time of one owner, or undefined when it has none. */
  usage(owner: string): EnergyUsage | undefined {
    const hours = new Map<number, EnergyHour>()
    const at = (h: number): EnergyHour => {
      let e = hours.get(h)
      if (!e) { e = { busySec: 0, callSec: 0, calls: 0, untimedCalls: 0, untimedInTok: 0, untimedOutTok: 0 }; hours.set(h, e) }
      return e
    }
    for (const d of this.devices.values()) {
      for (const src of [d.frozen, d.result]) {
        for (const [h, a] of src.get(owner) ?? []) {
          const e = at(h)
          e.busySec += a.busyMs / 1000; e.callSec += a.callMs / 1000; e.calls += a.calls
        }
      }
    }
    for (const [h, u] of this.untimed.get(owner) ?? []) {
      const e = at(h)
      e.untimedCalls += u.calls; e.untimedInTok += u.inTok; e.untimedOutTok += u.outTok
    }
    if (hours.size === 0) return undefined
    const byHour: Record<string, EnergyHour> = {}
    for (const h of [...hours.keys()].sort((a, b) => a - b)) {
      const e = hours.get(h) as EnergyHour
      byHour[String(h)] = { ...e, busySec: round3(e.busySec), callSec: round3(e.callSec) }
    }
    return { v: 1, byHour }
  }

  private freeze(d: DeviceState): void {
    const sorted = [...d.intervals].sort((a, b) => a.endMs - b.endMs)
    const old = sorted.slice(0, FREEZE_COUNT)
    const keep = sorted.slice(FREEZE_COUNT)
    const swept = sweepIntervals(old)
    for (const [owner, hours] of swept) {
      for (const [h, a] of hours) {
        const f = aggAt(d.frozen, owner, h)
        f.busyMs += a.busyMs; f.callMs += a.callMs; f.calls += a.calls
      }
    }
    d.intervals = keep
  }
}

function totalsOf(m: OwnerHours): Map<string, number> {
  const t = new Map<string, number>()
  for (const [o, hours] of m) { let s = 0; for (const a of hours.values()) s += a.busyMs; t.set(o, s / 1000) }
  return t
}

/** Merge two usages (same session seen twice, or a test helper). */
export function mergeEnergyUsage(a: EnergyUsage | undefined, b: EnergyUsage | undefined): EnergyUsage | undefined {
  if (!a) return b
  if (!b) return a
  const byHour: Record<string, EnergyHour> = {}
  for (const src of [a, b]) {
    for (const [h, e] of Object.entries(src.byHour)) {
      const t = byHour[h] ?? (byHour[h] = { busySec: 0, callSec: 0, calls: 0, untimedCalls: 0, untimedInTok: 0, untimedOutTok: 0 })
      t.busySec += e.busySec; t.callSec += e.callSec; t.calls += e.calls
      t.untimedCalls += e.untimedCalls; t.untimedInTok += e.untimedInTok; t.untimedOutTok += e.untimedOutTok
    }
  }
  return { v: 1, byHour }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tariff: which price applies in which minute
// ─────────────────────────────────────────────────────────────────────────────

/** `HH:MM` -> minutes since midnight (`24:00` allowed for an end), or null. */
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const v = Number(m[1]) * 60 + Number(m[2])
  return v >= 0 && v <= 1440 && Number(m[2]) < 60 ? v : null
}

/** minute-of-week (Monday 00:00 = 0) -> index of the tariff window that covers it, or -1. Built once per tariff. */
const tableCache = new WeakMap<Tariff, Int8Array>()

function windowTable(t: Tariff): Int8Array {
  const hit = tableCache.get(t)
  if (hit) return hit
  const table = new Int8Array(7 * 1440).fill(-1)
  const fill = (day: number, from: number, to: number, idx: number): void => {
    for (let m = from; m < to; m++) table[day * 1440 + m] = idx
  }
  t.timeOfDay.slice(0, 120).forEach((w: TariffWindow, idx) => {
    const a = parseClock(w.from)
    const b = parseClock(w.to)
    if (a === null || b === null || a === b) return
    for (const d of w.days) {
      const di = WEEKDAYS.indexOf(d as Weekday)
      if (di < 0) continue
      if (a < b) fill(di, a, b, idx)
      else { fill(di, a, 1440, idx); fill((di + 1) % 7, 0, b, idx) } // a window past midnight belongs to the day it starts
    }
  })
  tableCache.set(t, table)
  return table
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()

/** Offset of local time from UTC in ms at `utcMs`, for an IANA zone (null = this device's zone). */
export function tzOffsetMs(utcMs: number, tz: string | null): number {
  if (tz === null) return -new Date(utcMs).getTimezoneOffset() * 60_000
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    dtfCache.set(tz, f)
  }
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** Weekday of a local timestamp, Monday = 0. */
function weekdayOf(localMs: number): number {
  const day = Math.floor(localMs / 86_400_000)
  return (((day + 3) % 7) + 7) % 7 // 1970-01-01 was a Thursday
}

export interface PriceShare { window: number; minutes: number }

/**
 * Minutes of one UTC hour bucket that fall in each price window of `tariff` (`window` -1 = the flat price), in the
 * tariff's time zone. The 60 minutes always add up, also on DST days (the buckets are UTC hours).
 */
export function hourPriceShares(tariff: Tariff, hour: number): PriceShare[] {
  if (tariff.timeOfDay.length === 0) return [{ window: -1, minutes: 60 }]
  const table = windowTable(tariff)
  const start = hour * HOUR_MS
  const o0 = tzOffsetMs(start, tariff.tz)
  const o1 = tzOffsetMs(start + HOUR_MS - 1, tariff.tz)
  const counts = new Map<number, number>()
  for (let m = 0; m < 60; m++) {
    const t = start + m * 60_000
    const off = o0 === o1 ? o0 : tzOffsetMs(t, tariff.tz)
    const local = t + off
    const dow = weekdayOf(local)
    const minuteOfDay = Math.floor((((local % 86_400_000) + 86_400_000) % 86_400_000) / 60_000)
    const w = table[dow * 1440 + minuteOfDay]
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return [...counts].map(([window, minutes]) => ({ window, minutes })).sort((a, b) => a.window - b.window)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Pricing of stored busy time
// ─────────────────────────────────────────────────────────────────────────────

export interface TariffSlice {
  /** Index into `tariff.timeOfDay`, or -1 for the flat price. */
  window: number
  label: string
  perKWh: number
  kwh: number
  /** In the tariff currency. */
  cost: number
}

export interface EnergyResult {
  profileName: string
  profile: EnergyProfile
  /** Watts charged during busy time: load - idle (marginal) or load (total). */
  attributedW: number
  kwh: number
  /** Busy seconds priced: modelled + from latency. */
  busySec: number
  /** Overlap-split load seconds of calls with a latency (source: call latency). */
  latencySec: number
  /** Their own latencies added up, without the overlap split. */
  callSec: number
  /** callSec - latencySec: time that was shared with other calls and charged to them as well. */
  sharedSec: number
  timedCalls: number
  /** Seconds modelled from the profile's throughput for calls without a latency. */
  modelledSec: number
  untimedCalls: number
  /** Calls without a latency that could not be modelled (the profile has no throughput): they add no energy. */
  unmodelledCalls: number
  hours: number
  /** Tariff currency and per-price breakdown; null when there is no tariff. */
  tariff: { currency: string; slices: TariffSlice[] } | null
  /** In the tariff currency; null without a tariff. */
  cost: number | null
  /** In the display currency; null without a tariff or without an exchange rate for its currency. */
  costDisplay: number | null
  /** The kWh line with the numbers substituted. */
  formula: string
  /** First and last hour bucket with busy time (UTC ms), or null. */
  firstHourMs: number | null
  lastHourMs: number | null
}

const EMPTY_USAGE: EnergyUsage = Object.freeze({ v: 1, byHour: Object.freeze({}) }) as EnergyUsage

const cache = new WeakMap<EnergyUsage, WeakMap<ResolvedConfig, Map<string, EnergyResult>>>()

function sliceLabel(tariff: Tariff, window: number): string {
  if (window < 0) return 'flat'
  const w = tariff.timeOfDay[window]
  return `${w.from}-${w.to} ${w.days.join(',')}`
}

/**
 * Price stored busy time under `config` with the named profile. `null` when the profile does not exist (no energy can
 * be computed). Memoised per (usage object, config object, profile): the canvas calls this every frame.
 */
export function computeEnergy(config: ResolvedConfig, profileName: string | null, usage: EnergyUsage | undefined): EnergyResult | null {
  if (profileName === null || !Object.hasOwn(config.energy.profiles, profileName)) return null
  const profile = config.energy.profiles[profileName]
  const u = usage ?? EMPTY_USAGE
  let byConfig = cache.get(u)
  if (!byConfig) { byConfig = new WeakMap(); cache.set(u, byConfig) }
  let byProfile = byConfig.get(config)
  if (!byProfile) { byProfile = new Map(); byConfig.set(config, byProfile) }
  const hit = byProfile.get(profileName)
  if (hit) return hit
  const r = compute(config, profileName, profile, u)
  byProfile.set(profileName, r)
  return r
}

function compute(config: ResolvedConfig, profileName: string, profile: EnergyProfile, usage: EnergyUsage): EnergyResult {
  const attributedW = profile.attribution === 'marginal' ? profile.powerW.load - profile.powerW.idle : profile.powerW.load
  const tariff = config.energy.tariff
  const sliceMap = new Map<number, TariffSlice>()
  let kwh = 0, busySec = 0, latencySec = 0, callSec = 0, modelledSec = 0
  let timedCalls = 0, untimedCalls = 0, unmodelledCalls = 0
  let first: number | null = null, last: number | null = null
  const hourKeys = Object.keys(usage.byHour).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b)

  for (const h of hourKeys) {
    const e = usage.byHour[String(h)]
    let modelled = 0
    if (e.untimedCalls > 0) {
      untimedCalls += e.untimedCalls
      if (profile.throughput) modelled = e.untimedOutTok / profile.throughput.genTokPerSec + e.untimedInTok / profile.throughput.prefillTokPerSec
      else unmodelledCalls += e.untimedCalls
    }
    const sec = e.busySec + modelled
    latencySec += e.busySec; callSec += e.callSec; timedCalls += e.calls; modelledSec += modelled; busySec += sec
    if (sec <= 0) continue
    first ??= h * HOUR_MS
    last = h * HOUR_MS
    const hourKwh = (attributedW * profile.pue * sec) / JOULES_PER_KWH
    kwh += hourKwh
    if (tariff) {
      for (const share of hourPriceShares(tariff, h)) {
        const part = hourKwh * (share.minutes / 60)
        const perKWh = share.window < 0 ? tariff.flatPerKWh : tariff.timeOfDay[share.window].perKWh
        const s = sliceMap.get(share.window) ?? { window: share.window, label: sliceLabel(tariff, share.window), perKWh, kwh: 0, cost: 0 }
        s.kwh += part; s.cost += part * perKWh
        sliceMap.set(share.window, s)
      }
    }
  }

  const slices = [...sliceMap.values()].sort((a, b) => a.window - b.window)
  const cost = tariff ? slices.reduce((s, x) => s + x.cost, 0) : null
  const fx = tariff ? fxFactor(config, tariff.currency) : null
  const costDisplay = cost !== null && fx !== null ? cost * fx : null
  const watts = `${attributedW} W${profile.attribution === 'marginal' ? ` (${profile.powerW.load} - ${profile.powerW.idle})` : ''}`
  const formula = `${watts} x ${formatRate(busySec)} s${profile.pue !== 1 ? ` x pue ${formatRate(profile.pue)}` : ''} / 3.6e6 = ${formatKwh(kwh)}`

  return {
    profileName, profile, attributedW, kwh, busySec, latencySec, callSec, sharedSec: Math.max(0, callSec - latencySec), timedCalls,
    modelledSec, untimedCalls, unmodelledCalls, hours: hourKeys.length,
    tariff: tariff ? { currency: tariff.currency, slices } : null,
    cost, costDisplay, formula, firstHourMs: first, lastHourMs: last,
  }
}

/** Tooltip line for one price slice: `22:00-06:00 mon,tue @ 0.18 EUR: 0.0012 kWh = EUR 0.000216`. */
export function sliceText(s: TariffSlice, currency: string): string {
  return `${s.label} @ ${formatRate(s.perKWh)} ${currency}/kWh: ${formatKwh(s.kwh)} = ${formatMoneyExact(s.cost, currency)}`
}

/**
 * The energy profile name an agent's calls use, for a (provider, model) pair under `config`: the matching model rule's,
 * else the provider's. Null when no profile is assigned or the pair is not a local model.
 */
export function energyProfileOf(config: ResolvedConfig, provider: string | undefined, model: string | undefined): string | null {
  const p = resolveModelPricing(config, { provider, model })
  return p.billing === 'local' ? p.energyProfile : null
}

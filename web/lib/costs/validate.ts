/**
 * Hand-written validation of costs.json (zero dependencies, no I/O).
 *
 * Contract (PLAN v1 section 2 "Validation", v2 section 5):
 *  - Collects EVERY problem (errors block the config, warnings do not) with RFC 6901 JSON pointers.
 *  - Rejects `__proto__` / `constructor` / `prototype` keys at any depth BEFORE reading anything else.
 *    Output dictionaries are null-prototype objects built from whitelisted keys only.
 *  - Numeric bounds: rates 0..10000 per MTok, multiplier (0, 10], finite numbers only.
 *  - Tier thresholds must be members of TIER_BOUNDARIES (a boundary the ledger cannot bucket would
 *    silently mis-price), strictly increasing, with exactly one open-ended LAST tier.
 *  - Unknown keys are warnings, never failures. File size is capped (256 KB) for text input.
 *  - Currency codes are ISO-4217-shaped; every non-USD currency in use needs `currency.fx`.
 *    fx[X] = units of X per 1 USD (so `fx.EUR = 0.92` means 1 USD = 0.92 EUR).
 */
import { TIER_BOUNDARIES } from './tiers'
import type {
  BillingMode, ClaudeLimitsConfig, ClaudePlan, ClaudeFamilyName, DisplayUnit, EnergyProfile, ModelRule,
  Modifiers, ProviderConfig, ResetSchedule, ResolvedConfig, Tariff, TariffWindow, UnknownModelPolicy,
  UserRate, UserTier, ValidationIssue, ValidationResult, Weekday,
} from './types'
import { BILLING_MODES, CLAUDE_PLANS, UNKNOWN_MODEL_POLICIES, WEEKDAYS } from './types'

export const MAX_CONFIG_BYTES = 256 * 1024
export const RATE_MAX = 10_000
export const MULTIPLIER_MAX = 10
const MAX_DEPTH = 12
const MAX_NODES = 20_000
const MAX_PROVIDERS = 100
const MAX_RULES = 500
const MAX_PROFILES = 50
const MAX_WINDOWS = 50
const MAX_ANCHORS = 200
const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype']
const FAMILIES: readonly ClaudeFamilyName[] = ['fable', 'mythos', 'opus', 'sonnet', 'haiku']

type Obj = Record<string, unknown>

/** Escape one path segment per RFC 6901. */
export function pointer(path: readonly (string | number)[]): string {
  return path.map(s => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

function isObj(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function dict<T>(): Record<string, T> { return Object.create(null) as Record<string, T> }

class Issues {
  errors: ValidationIssue[] = []
  warnings: ValidationIssue[] = []
  err(path: readonly (string | number)[], message: string) { this.errors.push({ path: pointer(path), message }) }
  warn(path: readonly (string | number)[], message: string) { this.warnings.push({ path: pointer(path), message }) }
}

type Path = readonly (string | number)[]

/** Reject poisoned keys, absurd depth and node counts. Returns false when the document must not be read further. */
function scan(root: unknown, I: Issues): boolean {
  let nodes = 0
  let ok = true
  const walk = (v: unknown, path: (string | number)[], depth: number) => {
    if (typeof v !== 'object' || v === null) return
    if (++nodes > MAX_NODES) { if (ok) I.err([], `document has more than ${MAX_NODES} values`); ok = false; return }
    if (depth > MAX_DEPTH) { I.err(path, `nesting deeper than ${MAX_DEPTH} levels`); ok = false; return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path, i], depth + 1)); return }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) { I.err(path, 'only plain JSON objects are allowed'); ok = false; return }
    for (const k of Object.getOwnPropertyNames(v)) {
      if (FORBIDDEN_KEYS.includes(k)) { I.err([...path, k], `forbidden key "${k}"`); ok = false; continue }
      walk((v as Obj)[k], [...path, k], depth + 1)
    }
  }
  walk(root, [], 0)
  return ok
}

function warnUnknown(o: Obj, known: readonly string[], path: Path, I: Issues) {
  for (const k of Object.keys(o)) if (!known.includes(k)) I.warn([...path, k], `unknown key "${k}" is ignored`)
}

interface NumOpts { min?: number; max?: number; minExclusive?: boolean; int?: boolean }

function num(v: unknown, path: Path, I: Issues, o: NumOpts = {}): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) { I.err(path, 'must be a finite number'); return undefined }
  if (o.int && !Number.isInteger(v)) { I.err(path, 'must be an integer'); return undefined }
  if (o.min !== undefined && (o.minExclusive ? v <= o.min : v < o.min)) {
    I.err(path, `must be ${o.minExclusive ? '>' : '>='} ${o.min}`); return undefined
  }
  if (o.max !== undefined && v > o.max) { I.err(path, `must be <= ${o.max}`); return undefined }
  return v
}

function bool(v: unknown, path: Path, I: Issues): boolean | undefined {
  if (typeof v !== 'boolean') { I.err(path, 'must be true or false'); return undefined }
  return v
}

function str(v: unknown, path: Path, I: Issues, max = 200): string | undefined {
  if (typeof v !== 'string' || v.length === 0) { I.err(path, 'must be a non-empty string'); return undefined }
  if (v.length > max) { I.err(path, `must be at most ${max} characters`); return undefined }
  return v
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: Path, I: Issues): T | undefined {
  if (typeof v !== 'string' || !allowed.includes(v as T)) { I.err(path, `must be one of: ${allowed.join(', ')}`); return undefined }
  return v as T
}

function isoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
}

const CURRENCY_RE = /^[A-Z]{3}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** Minutes after midnight of "HH:MM" (or 1440 for "24:00" when allowed); null when malformed. */
export function parseHHMM(s: string, allow24 = false): number | null {
  if (s.length !== 5 || s[2] !== ':') return null
  const h = Number(s.slice(0, 2)); const m = Number(s.slice(3))
  if (!/^\d{2}$/.test(s.slice(0, 2)) || !/^\d{2}$/.test(s.slice(3))) return null
  if (allow24 && h === 24 && m === 0) return 1440
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// ── rates ───────────────────────────────────────────────────────────────────

const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const

function parseRate(v: unknown, path: Path, I: Issues): UserRate | undefined {
  if (!isObj(v)) { I.err(path, 'must be an object {input, output, ...}'); return undefined }
  warnUnknown(v, RATE_KEYS, path, I)
  const bounds: NumOpts = { min: 0, max: RATE_MAX }
  const input = v.input === undefined ? (I.err([...path, 'input'], 'is required'), undefined) : num(v.input, [...path, 'input'], I, bounds)
  const output = v.output === undefined ? (I.err([...path, 'output'], 'is required'), undefined) : num(v.output, [...path, 'output'], I, bounds)
  const out: Partial<UserRate> = {}
  for (const k of ['cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) {
    if (v[k] !== undefined) { const n = num(v[k], [...path, k], I, bounds); if (n !== undefined) out[k] = n }
  }
  if (input === undefined || output === undefined) return undefined
  return { input, output, ...out }
}

function parseTiers(v: unknown, path: Path, I: Issues): UserTier[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > 8) { I.err(path, 'must be an array of 1 to 8 tiers'); return undefined }
  const tiers: UserTier[] = []
  let ok = true
  let prev = 0
  v.forEach((t, i) => {
    const tp = [...path, i]
    if (!isObj(t)) { I.err(tp, 'must be an object {maxPromptTokens?, rate}'); ok = false; return }
    warnUnknown(t, ['maxPromptTokens', 'rate'], tp, I)
    const last = i === v.length - 1
    let max: number | null = null
    if (t.maxPromptTokens !== undefined && t.maxPromptTokens !== null) {
      const n = num(t.maxPromptTokens, [...tp, 'maxPromptTokens'], I, { int: true, min: 1 })
      if (n === undefined) ok = false
      else if (!TIER_BOUNDARIES.includes(n)) {
        I.err([...tp, 'maxPromptTokens'], `must be one of ${TIER_BOUNDARIES.join(', ')} (the supported prompt-size boundaries)`); ok = false
      } else if (n <= prev) { I.err([...tp, 'maxPromptTokens'], 'must be strictly greater than the previous tier'); ok = false }
      else { max = n; prev = n }
      if (last && n !== undefined) { I.err([...tp, 'maxPromptTokens'], 'the last tier must be open-ended (omit maxPromptTokens)'); ok = false }
    } else if (!last) { I.err([...tp, 'maxPromptTokens'], 'only the last tier may be open-ended'); ok = false }
    const rate = parseRate(t.rate, [...tp, 'rate'], I)
    if (!rate) ok = false
    else tiers.push({ maxPromptTokens: max, rate })
  })
  return ok ? tiers : undefined
}

function parseRateSpec(o: Obj, path: Path, I: Issues, into: { rate?: UserRate; tiers?: UserTier[]; currency?: string }) {
  if (o.rate !== undefined && o.tiers !== undefined) I.err(path, 'set either "rate" or "tiers", not both')
  if (o.rate !== undefined) { const r = parseRate(o.rate, [...path, 'rate'], I); if (r) into.rate = r }
  if (o.tiers !== undefined) { const t = parseTiers(o.tiers, [...path, 'tiers'], I); if (t) into.tiers = t }
  if (o.currency !== undefined) {
    if (typeof o.currency === 'string' && CURRENCY_RE.test(o.currency)) into.currency = o.currency
    else I.err([...path, 'currency'], 'must be a 3-letter upper-case ISO 4217 code, e.g. "EUR"')
  }
}

// ── pricing ─────────────────────────────────────────────────────────────────

function parseModifiers(v: unknown, path: Path, I: Issues): Modifiers | undefined {
  if (!isObj(v)) { I.err(path, 'must be an object'); return undefined }
  warnUnknown(v, ['fast', 'dataResidency', 'batch'], path, I)
  const m: Modifiers = {}
  for (const k of ['fast', 'dataResidency', 'batch'] as const) {
    if (v[k] !== undefined) { const n = num(v[k], [...path, k], I, { min: 0, minExclusive: true, max: MULTIPLIER_MAX }); if (n !== undefined) m[k] = n }
  }
  return m
}

function parseRule(v: unknown, path: Path, I: Issues): ModelRule | undefined {
  if (!isObj(v)) { I.err(path, 'must be an object {match, rate|tiers, ...}'); return undefined }
  warnUnknown(v, ['match', 'rate', 'tiers', 'currency', 'billing', 'energyProfile', 'modifiers'], path, I)
  const rule: ModelRule = { match: {} }
  if (!isObj(v.match)) I.err([...path, 'match'], 'is required: {provider?, model?} globs')
  else {
    warnUnknown(v.match, ['provider', 'model'], [...path, 'match'], I)
    for (const k of ['provider', 'model'] as const) {
      if (v.match[k] !== undefined) { const s = str(v.match[k], [...path, 'match', k], I, 200); if (s !== undefined) rule.match[k] = s }
    }
    if (rule.match.provider === undefined && rule.match.model === undefined && v.match.provider === undefined && v.match.model === undefined) {
      I.err([...path, 'match'], 'needs "provider" and/or "model"')
    }
  }
  parseRateSpec(v, path, I, rule)
  if (v.billing !== undefined) { const b = oneOf<BillingMode>(v.billing, BILLING_MODES, [...path, 'billing'], I); if (b) rule.billing = b }
  if (v.energyProfile !== undefined) { const e = str(v.energyProfile, [...path, 'energyProfile'], I, 64); if (e) rule.energyProfile = e }
  if (v.modifiers !== undefined) { const m = parseModifiers(v.modifiers, [...path, 'modifiers'], I); if (m) rule.modifiers = m }
  if (!rule.rate && !rule.tiers && !rule.billing && !rule.energyProfile && !rule.modifiers && v.rate === undefined && v.tiers === undefined) {
    I.err(path, 'has no effect: set rate, tiers, billing, energyProfile or modifiers')
  }
  return rule
}

function parseProvider(v: unknown, path: Path, I: Issues): ProviderConfig | undefined {
  if (!isObj(v)) { I.err(path, 'must be an object'); return undefined }
  warnUnknown(v, ['billing', 'priceLike', 'plan', 'energyProfile', 'implicitCacheWrite', 'rate', 'tiers', 'currency'], path, I)
  const p: ProviderConfig = {}
  if (v.billing !== undefined) { const b = oneOf<BillingMode>(v.billing, BILLING_MODES, [...path, 'billing'], I); if (b) p.billing = b }
  if (v.priceLike !== undefined) {
    const s = oneOf(v.priceLike, ['anthropic', 'copilot'] as const, [...path, 'priceLike'], I)
    if (s) p.priceLike = s
  }
  if (v.plan !== undefined) { const s = str(v.plan, [...path, 'plan'], I, 64); if (s) p.plan = s }
  if (v.energyProfile !== undefined) { const s = str(v.energyProfile, [...path, 'energyProfile'], I, 64); if (s) p.energyProfile = s }
  if (v.implicitCacheWrite !== undefined) { const b = bool(v.implicitCacheWrite, [...path, 'implicitCacheWrite'], I); if (b !== undefined) p.implicitCacheWrite = b }
  parseRateSpec(v, path, I, p)
  return p
}

// ── energy ──────────────────────────────────────────────────────────────────

function parseProfile(v: unknown, path: Path, I: Issues): EnergyProfile | undefined {
  if (!isObj(v)) { I.err(path, 'must be an object'); return undefined }
  warnUnknown(v, ['powerW', 'throughput', 'pue', 'attribution', 'measured'], path, I)
  let idle: number | undefined; let load: number | undefined
  if (!isObj(v.powerW)) I.err([...path, 'powerW'], 'is required: {idle, load} in watts')
  else {
    warnUnknown(v.powerW, ['idle', 'load'], [...path, 'powerW'], I)
    idle = v.powerW.idle === undefined ? (I.err([...path, 'powerW', 'idle'], 'is required'), undefined) : num(v.powerW.idle, [...path, 'powerW', 'idle'], I, { min: 0, max: 100_000 })
    load = v.powerW.load === undefined ? (I.err([...path, 'powerW', 'load'], 'is required'), undefined) : num(v.powerW.load, [...path, 'powerW', 'load'], I, { min: 0, max: 100_000 })
    if (idle !== undefined && load !== undefined && load < idle) I.err([...path, 'powerW', 'load'], 'must be >= idle')
  }
  let throughput: EnergyProfile['throughput'] = null
  if (v.throughput !== undefined && v.throughput !== null) {
    if (!isObj(v.throughput)) I.err([...path, 'throughput'], 'must be an object {genTokPerSec, prefillTokPerSec}')
    else {
      warnUnknown(v.throughput, ['genTokPerSec', 'prefillTokPerSec'], [...path, 'throughput'], I)
      const g = v.throughput.genTokPerSec === undefined ? (I.err([...path, 'throughput', 'genTokPerSec'], 'is required'), undefined) : num(v.throughput.genTokPerSec, [...path, 'throughput', 'genTokPerSec'], I, { min: 0, minExclusive: true, max: 1e7 })
      const p = v.throughput.prefillTokPerSec === undefined ? (I.err([...path, 'throughput', 'prefillTokPerSec'], 'is required'), undefined) : num(v.throughput.prefillTokPerSec, [...path, 'throughput', 'prefillTokPerSec'], I, { min: 0, minExclusive: true, max: 1e7 })
      if (g !== undefined && p !== undefined) throughput = { genTokPerSec: g, prefillTokPerSec: p }
    }
  }
  let pue = 1
  if (v.pue !== undefined) { const n = num(v.pue, [...path, 'pue'], I, { min: 1, max: 5 }); if (n !== undefined) pue = n }
  let attribution: EnergyProfile['attribution'] = 'marginal'
  if (v.attribution !== undefined) { const a = oneOf(v.attribution, ['marginal', 'total'] as const, [...path, 'attribution'], I); if (a) attribution = a }
  if (v.measured !== undefined && v.measured !== null) I.warn([...path, 'measured'], 'measured power is not supported yet and is ignored')
  if (idle === undefined || load === undefined) return undefined
  return { powerW: { idle, load }, throughput, pue, attribution, measured: null }
}

function parseTariff(v: unknown, path: Path, I: Issues): Tariff | undefined {
  if (!isObj(v)) { I.err(path, 'must be an object'); return undefined }
  warnUnknown(v, ['currency', 'flatPerKWh', 'timeOfDay', 'tz'], path, I)
  let currency = 'USD'
  if (v.currency !== undefined) {
    if (typeof v.currency === 'string' && CURRENCY_RE.test(v.currency)) currency = v.currency
    else I.err([...path, 'currency'], 'must be a 3-letter upper-case ISO 4217 code, e.g. "EUR"')
  }
  const flat = v.flatPerKWh === undefined ? (I.err([...path, 'flatPerKWh'], 'is required'), undefined) : num(v.flatPerKWh, [...path, 'flatPerKWh'], I, { min: 0, max: 1000 })
  let tz: string | null = null
  if (v.tz !== undefined && v.tz !== null) {
    if (typeof v.tz === 'string' && validTimeZone(v.tz)) tz = v.tz
    else I.err([...path, 'tz'], 'must be an IANA time zone such as "Europe/Zagreb"')
  }
  const windows: TariffWindow[] = []
  if (v.timeOfDay !== undefined) {
    if (!Array.isArray(v.timeOfDay) || v.timeOfDay.length > MAX_WINDOWS) I.err([...path, 'timeOfDay'], `must be an array of at most ${MAX_WINDOWS} windows`)
    else v.timeOfDay.forEach((w, i) => {
      const wp = [...path, 'timeOfDay', i]
      if (!isObj(w)) { I.err(wp, 'must be an object {days, from, to, perKWh}'); return }
      warnUnknown(w, ['days', 'from', 'to', 'perKWh'], wp, I)
      let days: Weekday[] | undefined
      if (!Array.isArray(w.days) || w.days.length === 0) I.err([...wp, 'days'], `must be a non-empty array of: ${WEEKDAYS.join(', ')}`)
      else {
        const ds: Weekday[] = []
        w.days.forEach((d, j) => { const x = oneOf<Weekday>(d, WEEKDAYS, [...wp, 'days', j], I); if (x && !ds.includes(x)) ds.push(x) })
        if (ds.length === w.days.length) days = ds
      }
      const from = typeof w.from === 'string' ? parseHHMM(w.from) : null
      const to = typeof w.to === 'string' ? parseHHMM(w.to, true) : null
      if (from === null) I.err([...wp, 'from'], 'must be "HH:MM" (00:00-23:59)')
      if (to === null) I.err([...wp, 'to'], 'must be "HH:MM" (00:00-24:00)')
      if (from !== null && to !== null && from === to) I.err([...wp, 'to'], 'must differ from "from" (a window cannot be empty or 24 h)')
      const price = w.perKWh === undefined ? (I.err([...wp, 'perKWh'], 'is required'), undefined) : num(w.perKWh, [...wp, 'perKWh'], I, { min: 0, max: 1000 })
      if (days && from !== null && to !== null && from !== to && price !== undefined) {
        windows.push({ days, from: w.from as string, to: w.to as string, perKWh: price })
      }
    })
  }
  // Overlap check. Midnight-wrapping windows continue on the next weekday.
  const spans: { day: number; start: number; end: number; idx: number }[] = []
  windows.forEach((w, idx) => {
    const a = parseHHMM(w.from) as number; const b = parseHHMM(w.to, true) as number
    for (const d of w.days) {
      const di = WEEKDAYS.indexOf(d)
      if (a < b) spans.push({ day: di, start: a, end: b, idx })
      else { spans.push({ day: di, start: a, end: 1440, idx }); spans.push({ day: (di + 1) % 7, start: 0, end: b, idx }) }
    }
  })
  const reported = new Set<string>()
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const s = spans[i]; const t = spans[j]
      if (s.idx === t.idx || s.day !== t.day || s.start >= t.end || t.start >= s.end) continue
      const key = `${Math.min(s.idx, t.idx)}-${Math.max(s.idx, t.idx)}`
      if (reported.has(key)) continue
      reported.add(key)
      I.err([...path, 'timeOfDay', Math.max(s.idx, t.idx)], `overlaps window ${Math.min(s.idx, t.idx)} on ${WEEKDAYS[s.day]}`)
    }
  }
  if (flat === undefined) return undefined
  return { currency, flatPerKWh: flat, timeOfDay: windows, tz }
}

// ── limits ──────────────────────────────────────────────────────────────────

function parseBudget(v: unknown, path: Path, I: Issues, known: readonly string[]): { enabled: boolean; budgetUsdEquiv: number | null } {
  const out = { enabled: true, budgetUsdEquiv: null as number | null }
  if (v === undefined) return out
  if (!isObj(v)) { I.err(path, 'must be an object'); return out }
  warnUnknown(v, known, path, I)
  if (v.enabled !== undefined) { const b = bool(v.enabled, [...path, 'enabled'], I); if (b !== undefined) out.enabled = b }
  if (v.budgetUsdEquiv !== undefined && v.budgetUsdEquiv !== null) {
    const n = num(v.budgetUsdEquiv, [...path, 'budgetUsdEquiv'], I, { min: 0, minExclusive: true, max: 1e9 })
    if (n !== undefined) out.budgetUsdEquiv = n
  }
  return out
}

function parseBand(v: unknown, path: Path, I: Issues, def: { lo: number; point: number; hi: number }): { lo: number; point: number; hi: number } {
  if (v === undefined) return def
  const opts: NumOpts = { min: 0, minExclusive: true, max: 1 }
  if (typeof v === 'number') {
    const n = num(v, path, I, opts)
    return n === undefined ? def : { lo: n, point: n, hi: n }
  }
  if (!isObj(v)) { I.err(path, 'must be a number in (0, 1] or {lo, point, hi}'); return def }
  warnUnknown(v, ['lo', 'point', 'hi'], path, I)
  const lo = num(v.lo ?? def.lo, [...path, 'lo'], I, opts); const point = num(v.point ?? def.point, [...path, 'point'], I, opts); const hi = num(v.hi ?? def.hi, [...path, 'hi'], I, opts)
  if (lo === undefined || point === undefined || hi === undefined) return def
  if (!(lo <= point && point <= hi)) { I.err(path, 'must satisfy lo <= point <= hi'); return def }
  return { lo, point, hi }
}

function parseResetSchedule(v: unknown, path: Path, I: Issues): ResetSchedule | null {
  if (v === undefined || v === null) return null
  if (!isObj(v)) { I.err(path, 'must be null or {dow, time, tz}'); return null }
  warnUnknown(v, ['dow', 'time', 'tz'], path, I)
  const dow = oneOf<Weekday>(v.dow, WEEKDAYS, [...path, 'dow'], I)
  const time = typeof v.time === 'string' && parseHHMM(v.time) !== null ? v.time : (I.err([...path, 'time'], 'must be "HH:MM"'), undefined)
  const tz = typeof v.tz === 'string' && validTimeZone(v.tz) ? v.tz : (I.err([...path, 'tz'], 'must be an IANA time zone'), undefined)
  return dow && time && tz ? { dow, time, tz } : null
}

export function defaultLimits(): ClaudeLimitsConfig {
  return {
    plan: null,
    planLabel: null,
    planMultiplierOfPro: null,
    fiveHour: { enabled: true, budgetUsdEquiv: null },
    weekly: { enabled: true, budgetUsdEquiv: null, resetsAt: null },
    fable: {
      enabled: true, budgetUsdEquiv: null,
      shareOfWeekly: { lo: 0.5, point: 0.5, hi: 0.5 },
      relativeWeight: { lo: 0.5, hi: 2 },
      anchors: [],
    },
    weights: { fable: 1, mythos: 1, opus: 1, sonnet: 1, haiku: 1 },
    sources: ['statusline', 'estimate'],
    countProviders: ['claude-subscription-directsdk-experimental', 'anthropic'],
  }
}

function parseClaudeLimits(v: unknown, path: Path, I: Issues): ClaudeLimitsConfig {
  const out = defaultLimits()
  if (v === undefined) return out
  if (!isObj(v)) { I.err(path, 'must be an object'); return out }
  warnUnknown(v, ['plan', 'planLabel', 'planMultiplierOfPro', 'fiveHour', 'weekly', 'fable', 'weights', 'sources', 'countProviders'], path, I)
  if (v.plan !== undefined && v.plan !== null) { const p = oneOf<ClaudePlan>(v.plan, CLAUDE_PLANS, [...path, 'plan'], I); if (p) out.plan = p }
  if (v.planLabel !== undefined && v.planLabel !== null) {
    if (typeof v.planLabel === 'string' && v.planLabel.trim().length > 0 && v.planLabel.length <= 60) out.planLabel = v.planLabel.trim()
    else I.err([...path, 'planLabel'], 'must be a non-empty text of at most 60 characters')
  }
  if (v.planMultiplierOfPro !== undefined && v.planMultiplierOfPro !== null) {
    const n = num(v.planMultiplierOfPro, [...path, 'planMultiplierOfPro'], I, { min: 0, minExclusive: true, max: 1000 })
    if (n !== undefined) out.planMultiplierOfPro = n
  }
  out.fiveHour = parseBudget(v.fiveHour, [...path, 'fiveHour'], I, ['enabled', 'budgetUsdEquiv'])
  const weekly = parseBudget(v.weekly, [...path, 'weekly'], I, ['enabled', 'budgetUsdEquiv', 'resetsAt'])
  out.weekly = { ...weekly, resetsAt: isObj(v.weekly) ? parseResetSchedule(v.weekly.resetsAt, [...path, 'weekly', 'resetsAt'], I) : null }
  if (v.fable !== undefined) {
    if (!isObj(v.fable)) I.err([...path, 'fable'], 'must be an object')
    else {
      const fp = [...path, 'fable']
      warnUnknown(v.fable, ['enabled', 'budgetUsdEquiv', 'shareOfWeekly', 'relativeWeight', 'anchors'], fp, I)
      const b = parseBudget({ enabled: v.fable.enabled, budgetUsdEquiv: v.fable.budgetUsdEquiv }, fp, I, ['enabled', 'budgetUsdEquiv'])
      out.fable.enabled = b.enabled; out.fable.budgetUsdEquiv = b.budgetUsdEquiv
      out.fable.shareOfWeekly = parseBand(v.fable.shareOfWeekly, [...fp, 'shareOfWeekly'], I, out.fable.shareOfWeekly)
      if (v.fable.relativeWeight !== undefined) {
        const rw = v.fable.relativeWeight
        if (!isObj(rw)) I.err([...fp, 'relativeWeight'], 'must be {lo, hi}')
        else {
          warnUnknown(rw, ['lo', 'hi'], [...fp, 'relativeWeight'], I)
          const lo = num(rw.lo ?? out.fable.relativeWeight.lo, [...fp, 'relativeWeight', 'lo'], I, { min: 0, minExclusive: true, max: 100 })
          const hi = num(rw.hi ?? out.fable.relativeWeight.hi, [...fp, 'relativeWeight', 'hi'], I, { min: 0, minExclusive: true, max: 100 })
          if (lo !== undefined && hi !== undefined) {
            if (lo <= hi) out.fable.relativeWeight = { lo, hi }
            else I.err([...fp, 'relativeWeight'], 'must satisfy lo <= hi')
          }
        }
      }
      if (v.fable.anchors !== undefined) {
        if (!Array.isArray(v.fable.anchors) || v.fable.anchors.length > MAX_ANCHORS) I.err([...fp, 'anchors'], `must be an array of at most ${MAX_ANCHORS} anchors`)
        else v.fable.anchors.forEach((a, i) => {
          const ap = [...fp, 'anchors', i]
          if (!isObj(a)) { I.err(ap, 'must be {at, observedPct}'); return }
          warnUnknown(a, ['at', 'observedPct'], ap, I)
          const at = typeof a.at === 'string' && Number.isFinite(Date.parse(a.at)) ? a.at : (I.err([...ap, 'at'], 'must be an ISO 8601 timestamp'), undefined)
          const pct = num(a.observedPct, [...ap, 'observedPct'], I, { min: 0, max: 100 })
          if (at !== undefined && pct !== undefined) out.fable.anchors.push({ at, observedPct: pct })
        })
      }
    }
  }
  if (v.weights !== undefined) {
    if (!isObj(v.weights)) I.err([...path, 'weights'], 'must be an object')
    else {
      warnUnknown(v.weights, FAMILIES, [...path, 'weights'], I)
      for (const f of FAMILIES) {
        if (v.weights[f] !== undefined) { const n = num(v.weights[f], [...path, 'weights', f], I, { min: 0, max: 100 }); if (n !== undefined) out.weights[f] = n }
      }
    }
  }
  if (v.sources !== undefined) {
    if (!Array.isArray(v.sources) || v.sources.length === 0) I.err([...path, 'sources'], 'must be a non-empty array of: statusline, estimate')
    else {
      const s: ('statusline' | 'estimate')[] = []
      v.sources.forEach((x, i) => { const o = oneOf(x, ['statusline', 'estimate'] as const, [...path, 'sources', i], I); if (o && !s.includes(o)) s.push(o) })
      if (s.length) out.sources = s
    }
  }
  if (v.countProviders !== undefined) {
    if (!Array.isArray(v.countProviders) || v.countProviders.length > MAX_PROVIDERS) I.err([...path, 'countProviders'], 'must be an array of provider ids')
    else {
      const ids: string[] = []
      v.countProviders.forEach((x, i) => {
        if (typeof x === 'string' && ID_RE.test(x)) ids.push(x)
        else I.err([...path, 'countProviders', i], 'must be a provider id')
      })
      out.countProviders = ids
    }
  }
  return out
}

// ── document ────────────────────────────────────────────────────────────────

export function defaultConfig(): ResolvedConfig {
  return {
    schemaVersion: 1,
    currency: { display: 'USD', fx: dict<number>(), fxAsOf: null },
    display: { unit: 'auto', decimals: 'auto', subscriptionValue: 'show' },
    pricing: {
      multiplier: 1,
      unknownModel: { policy: 'provider-default', globalRate: null },
      providers: dict<ProviderConfig>(),
      models: [],
    },
    energy: { profiles: dict<EnergyProfile>(), tariff: null },
    limits: { claude: defaultLimits() },
  }
}

/** Validate an already-parsed document. `null`/`undefined` mean "no file" and yield the defaults. */
export function validateConfig(raw: unknown): ValidationResult {
  const I = new Issues()
  const finish = (config: ResolvedConfig | null): ValidationResult =>
    ({ ok: I.errors.length === 0, config: I.errors.length === 0 ? config : null, errors: I.errors, warnings: I.warnings })
  if (raw === undefined || raw === null) return finish(defaultConfig())
  if (!scan(raw, I)) return finish(null)
  if (!isObj(raw)) { I.err([], 'config must be a JSON object'); return finish(null) }

  const cfg = defaultConfig()
  warnUnknown(raw, ['$schema', 'schemaVersion', 'currency', 'display', 'pricing', 'energy', 'limits'], [], I)
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    I.err(['schemaVersion'], `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (this build reads 1)`)
  }
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') I.err(['$schema'], 'must be a string')

  // Currencies that need an fx entry: [pointer path, code].
  const needsFx: { path: Path; code: string }[] = []

  if (raw.currency !== undefined) {
    const c = raw.currency
    if (!isObj(c)) I.err(['currency'], 'must be an object')
    else {
      warnUnknown(c, ['display', 'fx', 'fxAsOf'], ['currency'], I)
      if (c.display !== undefined) {
        if (typeof c.display === 'string' && CURRENCY_RE.test(c.display)) { cfg.currency.display = c.display; needsFx.push({ path: ['currency', 'display'], code: c.display }) }
        else I.err(['currency', 'display'], 'must be a 3-letter upper-case ISO 4217 code, e.g. "EUR"')
      }
      if (c.fx !== undefined) {
        if (!isObj(c.fx)) I.err(['currency', 'fx'], 'must be an object {CODE: unitsPerUsd}')
        else for (const [k, val] of Object.entries(c.fx)) {
          if (!CURRENCY_RE.test(k)) { I.err(['currency', 'fx', k], 'key must be a 3-letter upper-case ISO 4217 code'); continue }
          const n = num(val, ['currency', 'fx', k], I, { min: 0, minExclusive: true, max: 1e6 })
          if (n === undefined) continue
          if (k === 'USD' && n !== 1) { I.err(['currency', 'fx', 'USD'], 'must be 1 (fx is units per 1 USD)'); continue }
          cfg.currency.fx[k] = n
        }
      }
      if (c.fxAsOf !== undefined && c.fxAsOf !== null) {
        if (typeof c.fxAsOf === 'string' && isoDate(c.fxAsOf)) cfg.currency.fxAsOf = c.fxAsOf
        else I.err(['currency', 'fxAsOf'], 'must be a date "YYYY-MM-DD"')
      }
    }
  }

  if (raw.display !== undefined) {
    const d = raw.display
    if (!isObj(d)) I.err(['display'], 'must be an object')
    else {
      warnUnknown(d, ['unit', 'decimals', 'subscriptionValue'], ['display'], I)
      if (d.unit !== undefined) { const u = oneOf<DisplayUnit>(d.unit, ['auto', 'money', 'kwh', 'tokens'], ['display', 'unit'], I); if (u) cfg.display.unit = u }
      if (d.decimals !== undefined) {
        if (d.decimals === 'auto') cfg.display.decimals = 'auto'
        else { const n = num(d.decimals, ['display', 'decimals'], I, { int: true, min: 0, max: 8 }); if (n !== undefined) cfg.display.decimals = n }
      }
      if (d.subscriptionValue !== undefined) { const s = oneOf(d.subscriptionValue, ['show', 'hide'] as const, ['display', 'subscriptionValue'], I); if (s) cfg.display.subscriptionValue = s }
    }
  }

  if (raw.pricing !== undefined) {
    const p = raw.pricing
    if (!isObj(p)) I.err(['pricing'], 'must be an object')
    else {
      warnUnknown(p, ['multiplier', 'unknownModel', 'providers', 'models'], ['pricing'], I)
      if (p.multiplier !== undefined) { const m = num(p.multiplier, ['pricing', 'multiplier'], I, { min: 0, minExclusive: true, max: MULTIPLIER_MAX }); if (m !== undefined) cfg.pricing.multiplier = m }
      if (p.unknownModel !== undefined) {
        const u = p.unknownModel
        if (!isObj(u)) I.err(['pricing', 'unknownModel'], 'must be an object')
        else {
          warnUnknown(u, ['policy', 'globalRate'], ['pricing', 'unknownModel'], I)
          if (u.policy !== undefined) { const o = oneOf<UnknownModelPolicy>(u.policy, UNKNOWN_MODEL_POLICIES, ['pricing', 'unknownModel', 'policy'], I); if (o) cfg.pricing.unknownModel.policy = o }
          if (u.globalRate !== undefined && u.globalRate !== null) {
            if (!isObj(u.globalRate)) I.err(['pricing', 'unknownModel', 'globalRate'], 'must be {input, output}')
            else {
              warnUnknown(u.globalRate, ['input', 'output'], ['pricing', 'unknownModel', 'globalRate'], I)
              const gp = ['pricing', 'unknownModel', 'globalRate']
              const i = u.globalRate.input === undefined ? (I.err([...gp, 'input'], 'is required'), undefined) : num(u.globalRate.input, [...gp, 'input'], I, { min: 0, max: RATE_MAX })
              const o = u.globalRate.output === undefined ? (I.err([...gp, 'output'], 'is required'), undefined) : num(u.globalRate.output, [...gp, 'output'], I, { min: 0, max: RATE_MAX })
              if (i !== undefined && o !== undefined) cfg.pricing.unknownModel.globalRate = { input: i, output: o }
            }
          }
          if (cfg.pricing.unknownModel.policy === 'global-rate' && cfg.pricing.unknownModel.globalRate === null && u.globalRate === undefined) {
            I.err(['pricing', 'unknownModel', 'globalRate'], 'is required when policy is "global-rate"')
          }
        }
      }
      if (p.providers !== undefined) {
        if (!isObj(p.providers)) I.err(['pricing', 'providers'], 'must be an object keyed by provider id')
        else {
          const keys = Object.keys(p.providers)
          if (keys.length > MAX_PROVIDERS) I.err(['pricing', 'providers'], `at most ${MAX_PROVIDERS} providers`)
          else for (const k of keys) {
            if (!ID_RE.test(k)) { I.err(['pricing', 'providers', k], 'provider id must be 1-64 characters of letters, digits, . _ : -'); continue }
            const pc = parseProvider(p.providers[k], ['pricing', 'providers', k], I)
            if (pc) {
              cfg.pricing.providers[k] = pc
              if (pc.currency) needsFx.push({ path: ['pricing', 'providers', k, 'currency'], code: pc.currency })
            }
          }
        }
      }
      if (p.models !== undefined) {
        if (!Array.isArray(p.models) || p.models.length > MAX_RULES) I.err(['pricing', 'models'], `must be an array of at most ${MAX_RULES} rules`)
        else p.models.forEach((r, i) => {
          const rule = parseRule(r, ['pricing', 'models', i], I)
          if (rule) {
            cfg.pricing.models.push(rule)
            if (rule.currency) needsFx.push({ path: ['pricing', 'models', i, 'currency'], code: rule.currency })
          }
        })
      }
    }
  }

  if (raw.energy !== undefined) {
    const e = raw.energy
    if (!isObj(e)) I.err(['energy'], 'must be an object')
    else {
      warnUnknown(e, ['profiles', 'tariff'], ['energy'], I)
      if (e.profiles !== undefined) {
        if (!isObj(e.profiles)) I.err(['energy', 'profiles'], 'must be an object keyed by profile name')
        else {
          const keys = Object.keys(e.profiles)
          if (keys.length > MAX_PROFILES) I.err(['energy', 'profiles'], `at most ${MAX_PROFILES} profiles`)
          else for (const k of keys) {
            if (!ID_RE.test(k)) { I.err(['energy', 'profiles', k], 'profile name must be 1-64 characters of letters, digits, . _ : -'); continue }
            const pr = parseProfile(e.profiles[k], ['energy', 'profiles', k], I)
            if (pr) cfg.energy.profiles[k] = pr
          }
        }
      }
      if (e.tariff !== undefined && e.tariff !== null) {
        const t = parseTariff(e.tariff, ['energy', 'tariff'], I)
        if (t) { cfg.energy.tariff = t; needsFx.push({ path: ['energy', 'tariff', 'currency'], code: t.currency }) }
      }
    }
  }

  if (raw.limits !== undefined) {
    const l = raw.limits
    if (!isObj(l)) I.err(['limits'], 'must be an object')
    else {
      warnUnknown(l, ['claude', 'codex'], ['limits'], I)
      if (l.codex !== undefined) I.warn(['limits', 'codex'], 'Codex limits are not supported and are ignored')
      cfg.limits.claude = parseClaudeLimits(l.claude, ['limits', 'claude'], I)
    }
  }

  // Cross references.
  for (const [code, path] of needsFx.map(n => [n.code, n.path] as const)) {
    if (code !== 'USD' && cfg.currency.fx[code] === undefined) {
      I.err(path, `no exchange rate for ${code}: add currency.fx.${code} (units of ${code} per 1 USD)`)
    }
  }
  const profileRefs: { path: Path; name: string }[] = []
  for (const [k, pc] of Object.entries(cfg.pricing.providers)) if (pc.energyProfile) profileRefs.push({ path: ['pricing', 'providers', k, 'energyProfile'], name: pc.energyProfile })
  cfg.pricing.models.forEach((r, i) => { if (r.energyProfile) profileRefs.push({ path: ['pricing', 'models', i, 'energyProfile'], name: r.energyProfile }) })
  for (const ref of profileRefs) {
    if (cfg.energy.profiles[ref.name] === undefined) I.warn(ref.path, `energy profile "${ref.name}" is not defined; no energy will be computed`)
  }

  return finish(cfg)
}

/** Validate raw file text: enforces the size cap, then parses JSON. Empty text = no file. */
export function validateConfigText(text: string, maxBytes = MAX_CONFIG_BYTES): ValidationResult {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > maxBytes) {
    return { ok: false, config: null, warnings: [], errors: [{ path: '', message: `file is ${bytes} bytes; the limit is ${maxBytes}` }] }
  }
  if (text.trim() === '') return { ok: true, config: defaultConfig(), errors: [], warnings: [{ path: '', message: 'file is empty; built-in defaults are used' }] }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (e) {
    return { ok: false, config: null, warnings: [], errors: [{ path: '', message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }] }
  }
  return validateConfig(parsed)
}

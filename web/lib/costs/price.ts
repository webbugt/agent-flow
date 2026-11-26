/**
 * Money computation: tiered, cache-aware, currency-converting. Pure, no I/O.
 *
 *   cost_native  = (in_new*r.input + out*r.output + cr*r.cacheRead + cw5*r.cacheWrite5m + cw1*r.cacheWrite1h) / 1e6
 *   cost_display = cost_native * fx(native -> display) * pricing.multiplier * rule modifiers
 *
 * `in_new` is the UNCACHED input. The tier is selected per request by `promptTokens`
 * (in_new + cr + cw5 + cw1). A caller holding only cumulative totals must NOT pass cumulative
 * prompt tokens: it gets the lowest tier (documented limit until per-request buckets land in P2).
 *
 * Every figure carries a billing kind (billed / list-equivalent / estimated / unpriced) and a
 * rate source, so the UI can state what a number means and totals can be split by kind.
 */
import type {
  BillingKind, BillingMode, ClaudeFamilyName, Rate, RateSource, ResolvedConfig, UsageTokens,
} from './types'
import { blendedRate } from './catalog'
import { resolveModelPricing, type ModelPricing, type PricingQuery } from './resolve'
import { formatMoneyExact, formatRate } from './format'

// ── pure helpers ────────────────────────────────────────────────────────────

export const IMPLICIT_CACHE_WRITE_MIN_TOKENS = 1024

/** Prompt size of one request: uncached input + cache reads + cache writes. */
export function promptTokensOf(u: UsageTokens): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens
}

/** Native-currency cost of `u` at rate `r` (USD per 1M tokens unless the rate is in another currency). */
export function costOfTokens(r: Rate, u: UsageTokens): number {
  const write5m = r.cacheWrite5m ?? r.input
  const write1h = r.cacheWrite1h ?? write5m
  return (
    u.inputTokens * r.input +
    u.outputTokens * r.output +
    u.cacheReadTokens * r.cacheRead +
    u.cacheWrite5mTokens * write5m +
    u.cacheWrite1hTokens * write1h
  ) / 1_000_000
}

/**
 * Copilot Claude models: uncached input >= 1,024 tokens with no reported cache write is billed at
 * the cache-write rate (as in Hermes core agent/usage_pricing.py). Returns how many input tokens to
 * re-price as a cache write; 0 when it does not apply. A reported write always wins. [UNVERIFIED
 * against GitHub's bill: PLAN v2 section 3.3, U-3.]
 */
export function implicitCacheWrite(
  provider: string, family: ClaudeFamilyName | undefined, newInputTokens: number, reportedWrite: number, enabled = true,
): number {
  if (!enabled || provider !== 'copilot' || !family) return 0
  if (reportedWrite > 0) return 0
  return newInputTokens >= IMPLICIT_CACHE_WRITE_MIN_TOKENS ? newInputTokens : 0
}

/**
 * The word shown with a figure (PLAN v2 section 2). Precedence:
 *  1. local billing, or no reported usage, or a fallback (guessed) rate, or unknown billing -> `estimated`
 *  2. no rate at all (policy unpriced)                                                      -> `unpriced`
 *  3. api / free                                                                            -> `billed`
 *  4. subscription / credits                                                                -> `list-equivalent`
 */
export function classifyBilling(billing: BillingMode, hadReportedUsage: boolean, rateSource: RateSource): BillingKind {
  if (billing === 'local') return 'estimated'
  if (rateSource === 'none') return 'unpriced'
  if (!hadReportedUsage || rateSource === 'fallback' || billing === 'unknown') return 'estimated'
  if (billing === 'subscription' || billing === 'credits') return 'list-equivalent'
  return 'billed'
}

/** Units of `code` per 1 USD (USD = 1), or null when no exchange rate is configured. */
export function unitsPerUsd(config: ResolvedConfig, code: string): number | null {
  if (code === 'USD') return 1
  const v = Object.hasOwn(config.currency.fx, code) ? config.currency.fx[code] : undefined
  return v !== undefined && v > 0 ? v : null
}

/** Multiply a `from` amount by this to get display-currency units; null when an exchange rate is missing. */
export function fxFactor(config: ResolvedConfig, from: string, to: string = config.currency.display): number | null {
  const a = unitsPerUsd(config, from); const b = unitsPerUsd(config, to)
  return a === null || b === null ? null : b / a
}

// ── result type ─────────────────────────────────────────────────────────────

export interface PriceInput extends PricingQuery {
  /** Reported usage (billed API usage). Absent = the context-size estimate path. */
  usage?: UsageTokens
  /** Context-size token count for the estimate path (no reported usage). */
  tokensUsed?: number
}

export interface CostComponents { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

export interface FxInfo { from: string; to: string; factor: number; asOf: string | null }

export interface PriceResult {
  provider: string
  model: string
  billing: BillingMode
  kind: BillingKind
  source: RateSource
  /** Display-currency amount after fx, multiplier and modifiers. 0 for unpriced / local / free. */
  amount: number
  /** Display currency (ISO 4217). */
  currency: string
  /** Amount in the rate's own currency before fx and multipliers. */
  nativeAmount: number
  nativeCurrency: string
  /** pricing.multiplier x rule modifiers. */
  multiplier: number
  fx: FxInfo | null
  hadReportedUsage: boolean
  /** Tokens as priced (after the implicit cache-write move). null on the estimate path. */
  usage: UsageTokens | null
  /** Context-size tokens, estimate path only. */
  tokensUsed: number | null
  inferredCacheWriteTokens: number
  /** 0.75 x input + 0.25 x output of the resolved rate (estimate path). */
  blended: number | null
  components: CostComponents | null
  /** One line with the numbers substituted (tooltip row "Formula"). */
  formula: string
  /** Set when the figure could not be computed: `unpriced` and why. */
  reason: string | null
  /** list-equivalent figure the user asked to hide (display.subscriptionValue = hide). Excluded from totals. */
  hidden: boolean
  pricing: ModelPricing
}

const ZERO_COMPONENTS: CostComponents = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

/** Price one agent / request. Never throws. */
export function priceUsage(config: ResolvedConfig, input: PriceInput): PriceResult {
  const pricing = resolveModelPricing(config, input)
  const hadReportedUsage = input.usage !== undefined
  const kind0 = classifyBilling(pricing.billing, hadReportedUsage, pricing.source)
  const fx = pricing.rate ? fxFactor(config, pricing.currency) : 1
  const display = config.currency.display
  const multiplier = config.pricing.multiplier * pricing.modifiers

  const base = {
    provider: pricing.provider, model: pricing.model, billing: pricing.billing, source: pricing.source, currency: display,
    nativeCurrency: pricing.currency, multiplier, hadReportedUsage, pricing, hidden: false,
    inferredCacheWriteTokens: 0, usage: null as UsageTokens | null, tokensUsed: null as number | null, blended: null as number | null,
    components: null as CostComponents | null, fx: null as FxInfo | null,
  }
  const done = (kind: BillingKind, amount: number, nativeAmount: number, formula: string, extra: Partial<PriceResult> = {}): PriceResult => {
    const hidden = kind === 'list-equivalent' && config.display.subscriptionValue === 'hide'
    return { ...base, kind, amount, nativeAmount, formula, reason: null, ...extra, hidden }
  }

  if (pricing.billing === 'free') return done('billed', 0, 0, 'free provider: $0', { usage: input.usage ?? null })
  if (pricing.billing === 'local') {
    return done('estimated', 0, 0, 'local model: cost is electricity, computed from configured power (energy module)', { usage: input.usage ?? null })
  }
  if (!pricing.rate || kind0 === 'unpriced') {
    return done('unpriced', 0, 0, 'no rate configured for this model', { reason: 'no rate configured', usage: input.usage ?? null })
  }
  if (fx === null) {
    return done('unpriced', 0, 0, `no exchange rate for ${pricing.currency}`, { reason: `no exchange rate for ${pricing.currency}` })
  }
  const fxInfo: FxInfo | null = pricing.currency === display ? null
    : { from: pricing.currency, to: display, factor: fx, asOf: config.currency.fxAsOf }
  const rate = pricing.rate
  const scale = fx * multiplier
  const money = (n: number) => formatMoneyExact(n, display)
  const tail = (native: number): string => {
    const parts: string[] = []
    if (fxInfo) parts.push(`x ${formatRate(fx)} fx`)
    if (multiplier !== 1) parts.push(`x ${formatRate(multiplier)}`)
    return parts.length ? ` ${parts.join(' ')} = ${money(native * scale)}` : ''
  }
  const nativeMoney = (n: number) => formatMoneyExact(n, pricing.currency)

  // Estimate path: no usage reported, price the context size at the blended rate.
  if (!input.usage) {
    const tokens = Math.max(0, input.tokensUsed ?? 0)
    const blended = blendedRate(rate)
    const native = (tokens / 1_000_000) * blended
    return done(kind0, native * scale, native,
      `${tokens} tokens x (0.75*${formatRate(rate.input)} + 0.25*${formatRate(rate.output)}) / 1e6 = ${nativeMoney(native)}${tail(native)}`,
      { tokensUsed: tokens, blended, fx: fxInfo })
  }

  // Reported usage: apply the implicit cache-write inference first.
  const u0 = input.usage
  const inferred = implicitCacheWrite(pricing.provider, pricing.catalogRow?.family, u0.inputTokens, u0.cacheWrite5mTokens + u0.cacheWrite1hTokens,
    pricing.providerSettings.implicitCacheWrite === true)
  const u: UsageTokens = inferred > 0
    ? { ...u0, inputTokens: u0.inputTokens - inferred, cacheWrite5mTokens: u0.cacheWrite5mTokens + inferred }
    : u0
  const write5m = rate.cacheWrite5m ?? rate.input
  const write1h = rate.cacheWrite1h ?? write5m
  const components: CostComponents = {
    input: (u.inputTokens * rate.input) / 1e6, output: (u.outputTokens * rate.output) / 1e6,
    cacheRead: (u.cacheReadTokens * rate.cacheRead) / 1e6, cacheWrite5m: (u.cacheWrite5mTokens * write5m) / 1e6,
    cacheWrite1h: (u.cacheWrite1hTokens * write1h) / 1e6,
  }
  const native = costOfTokens(rate, u)
  const terms: string[] = [`${u.inputTokens}*${formatRate(rate.input)}`, `${u.outputTokens}*${formatRate(rate.output)}`]
  if (u.cacheReadTokens) terms.push(`${u.cacheReadTokens}*${formatRate(rate.cacheRead)}`)
  if (u.cacheWrite5mTokens) terms.push(`${u.cacheWrite5mTokens}*${formatRate(write5m)}`)
  if (u.cacheWrite1hTokens) terms.push(`${u.cacheWrite1hTokens}*${formatRate(write1h)}`)
  const formula = `(${terms.join(' + ')}) / 1e6 = ${nativeMoney(native)}${tail(native)}`
  return done(kind0, native * scale, native, formula, { usage: u, inferredCacheWriteTokens: inferred, components, fx: fxInfo })
}

export interface KindTotals {
  /** Display-currency totals by kind, hidden items excluded. */
  byKind: Record<BillingKind, number>
  counts: Record<BillingKind, number>
  /** list-equivalent agents left out because display.subscriptionValue = hide. */
  hiddenSubscription: number
  unpriced: number
}

/** Totals split by kind. A figure is never summed across kinds. */
export function totalsByKind(results: readonly PriceResult[]): KindTotals {
  const zero = (): Record<BillingKind, number> => ({ billed: 0, 'list-equivalent': 0, estimated: 0, unpriced: 0 })
  const t: KindTotals = { byKind: zero(), counts: zero(), hiddenSubscription: 0, unpriced: 0 }
  for (const r of results) {
    if (r.hidden) { t.hiddenSubscription++; continue }
    t.counts[r.kind]++
    if (r.kind === 'unpriced') { t.unpriced++; continue }
    t.byKind[r.kind] += r.amount
  }
  return t
}

export { ZERO_COMPONENTS }

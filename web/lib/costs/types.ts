/**
 * Price catalog types. Pure data, no I/O. All prices are USD per 1M tokens.
 * (P1 adds the config/resolution types next to these.)
 */

/** One complete rate card for one prompt-size tier. `null` = the vendor lists no such charge. */
export interface Rate {
  input: number
  output: number
  /** Cache hit / cached input. */
  cacheRead: number
  /** 5-minute cache write. null = not listed (Copilot: Gemini, xAI, Kimi, Microsoft, pre-5.6 OpenAI): written tokens bill as plain input. */
  cacheWrite5m: number | null
  /** 1-hour cache write. null = not listed (every Copilot row): falls back to the 5m write rate. */
  cacheWrite1h: number | null
}

/** A prompt-size tier. `maxPromptTokens` is the INCLUSIVE upper bound (vendor "<= 100K"); null = unbounded. */
export interface CatalogTier {
  maxPromptTokens: number | null
  rate: Rate
}

export type CatalogSection = 'anthropic' | 'copilot'
export type ClaudeFamilyName = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku'

/** Field names a row can flag as not confirmed from the live vendor page. */
export type UnverifiedField =
  | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h'   // derived from a stated rule, not listed
  | 'afterPromoRate'                                 // price after promo end not published
  | 'thresholdCountsCache'                           // does "input tokens" include cached tokens?

export interface CatalogRow {
  /** Normalised id (lower-case, "." and spaces -> "-"), e.g. `claude-haiku-5-5`. */
  id: string
  /** Name as printed on the vendor page. */
  name: string
  section: CatalogSection
  /** Vendor heading on the source page (OpenAI, Anthropic, Google, ...). */
  vendor: string
  /** Claude family, Claude rows only. */
  family?: ClaudeFamilyName
  /** Live vendor page this row was read from. */
  source: string
  /** Date (YYYY-MM-DD) the row was verified against the live page. */
  asOf: string
  /** Ascending by maxPromptTokens; the last tier is unbounded. One tier = flat pricing. */
  tiers: readonly CatalogTier[]
  /** Promo end, UTC midnight, exclusive: the promo rate applies to events strictly before this instant. */
  validUntil?: string
  /** Rate from `validUntil` on. Absent while the vendor has not published it. */
  afterRate?: Rate
  /** Fields not confirmed on the live page. Empty/absent = everything confirmed. */
  unverified?: readonly UnverifiedField[]
  note?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Config, resolution and pricing types (P1). Pure data; no I/O.
// Source of truth for the schema: PLAN v1 section 2, amended by v2 section 5.
// ─────────────────────────────────────────────────────────────────────────────

/** How a provider charges. `credits` = Copilot AI credits; `local` = money only from electricity. */
export type BillingMode = 'api' | 'subscription' | 'credits' | 'local' | 'free' | 'unknown'
export const BILLING_MODES: readonly BillingMode[] = ['api', 'subscription', 'credits', 'local', 'free', 'unknown']

/** The word shown next to a figure (PLAN v2 section 2). A figure is never summed across kinds without a split. */
export type BillingKind = 'billed' | 'list-equivalent' | 'estimated' | 'unpriced'

/**
 * Where the rate came from. `none` = no money rate (unpriced policy, or a local model).
 * `fallback` = the model is unknown to every level, so the rate is a policy guess (forces kind `estimated`).
 */
export type RateSource = 'user-rule' | 'user-provider' | 'catalog' | 'provider-default' | 'fallback' | 'none'

export type UnknownModelPolicy = 'provider-default' | 'global-rate' | 'unpriced' | 'zero'
export const UNKNOWN_MODEL_POLICIES: readonly UnknownModelPolicy[] = ['provider-default', 'global-rate', 'unpriced', 'zero']
export type DisplayUnit = 'auto' | 'money' | 'kwh' | 'tokens'
export type SubscriptionValue = 'show' | 'hide'

/** Per-request token counts. `inputTokens` is the UNCACHED input (Hermes `in` minus cache read and write). */
export interface UsageTokens {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
}

/** A rate as typed by the user (USD or the rule's currency per 1M tokens). Omitted cache fields are derived from `input`. */
export interface UserRate {
  input: number
  output: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

/** `maxPromptTokens` is an inclusive bound that must be a TIER_BOUNDARIES member; null = open-ended (the last tier). */
export interface UserTier { maxPromptTokens: number | null; rate: UserRate }

export interface RateSpec {
  rate?: UserRate
  tiers?: UserTier[]
  /** ISO 4217 code of the rate. Default USD. Needs `currency.fx` when not USD. */
  currency?: string
}

/** Glob only (`*`, `?`), case-insensitive, `.` == `-`. No regex. */
export interface ModelMatch { provider?: string; model?: string }

/** Optional multipliers on a rule (v1 section 2 "Modifiers"). Not auto-detected. Each in (0, 10]. */
export interface Modifiers { fast?: number; dataResidency?: number; batch?: number }

export interface ModelRule extends RateSpec {
  match: ModelMatch
  billing?: BillingMode
  energyProfile?: string
  modifiers?: Modifiers
}

export interface ProviderConfig extends RateSpec {
  billing?: BillingMode
  /** Catalog sheet that prices this provider's models. */
  priceLike?: CatalogSection
  plan?: string
  energyProfile?: string
  /** Copilot + Claude models: uncached input >= 1,024 tokens with no reported cache write is billed as a cache write. */
  implicitCacheWrite?: boolean
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export interface EnergyProfile {
  powerW: { idle: number; load: number }
  /** Used only when per-call latency is unknown. */
  throughput: { genTokPerSec: number; prefillTokPerSec: number } | null
  pue: number
  attribution: 'marginal' | 'total'
  /** Reserved for measured power (phase 2). Always null here. */
  measured: null
}

export interface TariffWindow { days: Weekday[]; from: string; to: string; perKWh: number }
export interface Tariff { currency: string; flatPerKWh: number; timeOfDay: TariffWindow[]; tz: string | null }

export type ClaudePlan = 'pro' | 'max5x' | 'ultra' | 'custom' | 'api'
export const CLAUDE_PLANS: readonly ClaudePlan[] = ['pro', 'max5x', 'ultra', 'custom', 'api']

export interface Band { lo: number; point: number; hi: number }
export interface ResetSchedule { dow: Weekday; time: string; tz: string }
export interface BudgetSpec { enabled: boolean; budgetUsdEquiv: number | null }
export interface FableLimitConfig {
  enabled: boolean
  budgetUsdEquiv: number | null
  /** Fable's share of the weekly limit. Documented point 0.5; the band is a prior, tests pin arithmetic not defaults. */
  shareOfWeekly: Band
  relativeWeight: { lo: number; hi: number }
  /** Manual calibration: the Fable % the user read on claude.ai at a time. */
  anchors: { at: string; observedPct: number }[]
}
export interface ClaudeLimitsConfig {
  /** null = not configured: no limit UI. */
  plan: ClaudePlan | null
  /** User-visible plan name; null = the built-in label of `plan` (limits-plans.ts). */
  planLabel: string | null
  planMultiplierOfPro: number | null
  fiveHour: BudgetSpec
  weekly: BudgetSpec & { resetsAt: ResetSchedule | null }
  fable: FableLimitConfig
  weights: Record<ClaudeFamilyName, number>
  sources: ('statusline' | 'estimate')[]
  countProviders: string[]
}

/** A validated config with every default filled in. Dictionary members are null-prototype objects. */
export interface ResolvedConfig {
  schemaVersion: 1
  currency: { display: string; fx: Record<string, number>; fxAsOf: string | null }
  display: { unit: DisplayUnit; decimals: 'auto' | number; subscriptionValue: SubscriptionValue }
  pricing: {
    multiplier: number
    unknownModel: { policy: UnknownModelPolicy; globalRate: { input: number; output: number } | null }
    providers: Record<string, ProviderConfig>
    models: ModelRule[]
  }
  energy: { profiles: Record<string, EnergyProfile>; tariff: Tariff | null }
  limits: { claude: ClaudeLimitsConfig }
}

/** `path` is an RFC 6901 JSON pointer into the config (`''` = the document). */
export interface ValidationIssue { path: string; message: string }

export interface ValidationResult {
  ok: boolean
  /** null when there are errors: the host keeps the last-good config (or the built-in defaults). */
  config: ResolvedConfig | null
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Energy ingestion data (P5). What the host stores per local-model session so the page can price it with
// whatever watts, throughput and tariff the config has NOW (editing the config re-prices history).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busy time of one session in one UTC hour (`byHour` key = hours since the epoch, as text: `Math.floor(ms / 3.6e6)`).
 * `busySec` is the device's load time attributed to this session: every call gets `dt / k` of each stretch it shared
 * with k-1 other calls on the same device, so two fully overlapping calls get half each and the total is conserved.
 */
export interface EnergyHour {
  /** Overlap-split load seconds of calls that reported a latency (the busy-time source "call latency"). */
  busySec: number
  /** The same calls' own latencies added up, without the split (busySec <= callSec; the gap is time shared with other calls). */
  callSec: number
  /** Calls that reported a latency and ended in this hour. */
  calls: number
  /** Calls without a latency (busy time is modelled from the configured throughput when the profile has one). */
  untimedCalls: number
  /** Uncached input tokens of the calls without a latency. */
  untimedInTok: number
  /** Output tokens of the calls without a latency. */
  untimedOutTok: number
}

export interface EnergyUsage {
  v: 1
  byHour: Record<string, EnergyHour>
}

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

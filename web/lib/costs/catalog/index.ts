/**
 * Catalog lookup and rate resolution. Pure functions over the two sheets; no I/O.
 * Local models have no rows by design (they cost energy, not tokens).
 */
import type { CatalogRow, CatalogSection, ClaudeFamilyName, Rate } from '../types'
import { ANTHROPIC_ROWS, FAMILY_CURRENT } from './anthropic'
import { COPILOT_ROWS } from './copilot'

export { ANTHROPIC_ROWS, COPILOT_ROWS, FAMILY_CURRENT }
export { ANTHROPIC_SOURCE, ANTHROPIC_AS_OF } from './anthropic'
export { COPILOT_SOURCE, COPILOT_AS_OF } from './copilot'

export const ALL_ROWS: readonly CatalogRow[] = [...ANTHROPIC_ROWS, ...COPILOT_ROWS]

const BY_SECTION: Record<CatalogSection, ReadonlyMap<string, CatalogRow>> = {
  anthropic: new Map(ANTHROPIC_ROWS.map(r => [r.id, r])),
  copilot: new Map(COPILOT_ROWS.map(r => [r.id, r])),
}

/** Id of the row used for models the catalog does not know (newest Sonnet-class list price). */
export const FALLBACK_MODEL_ID = 'claude-sonnet-5-5'

const FAMILY_RE = /(fable|mythos|opus|sonnet|haiku)-\d/

/**
 * Canonical catalog id: lower-case, "." and whitespace -> "-" (so `claude-haiku-5.5` ==
 * `claude-haiku-5-5`), no `[1m]` context suffix, no `provider/` prefix, no trailing date stamp
 * (`-20250929`) or `-latest`.
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]\s*$/, '')
    .replace(/^[a-z0-9_-]+\//, '')
    .replace(/[.\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-(?:\d{8}|latest)$/, '')
    .replace(/^anthropic-(?=claude-)/, '')
}

export type MatchKind =
  /** Normalised id is a catalog row. */
  | 'exact'
  /** Unlisted id of a known Claude family: priced like the family's newest row. */
  | 'family'
  /** Unknown model: priced like FALLBACK_MODEL_ID. Callers must show it as an estimate. */
  | 'fallback'

export interface ModelLookup {
  row: CatalogRow
  match: MatchKind
  /** Normalised id that was looked up ('' when no model was given). */
  id: string
}

export interface LookupOptions {
  /** Sheet to try first. Default: anthropic, then copilot. */
  section?: CatalogSection
}

function rowById(id: string): CatalogRow {
  const found = BY_SECTION.anthropic.get(id)
  if (!found) throw new Error(`catalog: missing row ${id}`)
  return found
}

export function lookupModel(model: string | undefined, opts: LookupOptions = {}): ModelLookup {
  const id = model ? normalizeModelId(model) : ''
  if (id) {
    const order: CatalogSection[] = opts.section === 'copilot' ? ['copilot', 'anthropic'] : ['anthropic', 'copilot']
    for (const section of order) {
      const hit = BY_SECTION[section].get(id)
      if (hit) return { row: hit, match: 'exact', id }
    }
    const fam = FAMILY_RE.exec(id)
    if (fam) return { row: rowById(FAMILY_CURRENT[fam[1] as ClaudeFamilyName]), match: 'family', id }
  }
  return { row: rowById(FALLBACK_MODEL_ID), match: 'fallback', id }
}

export interface ResolveOptions {
  /** One request's prompt size (input + cache reads + cache writes). Default: lowest tier. */
  promptTokens?: number
  /** Event time (ms epoch or ISO string) for dated price changes. Default: now. */
  at?: number | string | Date
}

export interface ResolvedRate {
  rate: Rate
  /** Index into row.tiers (always 0 after a dated price change: afterRate is flat). */
  tierIndex: number
  /** The event is at or after `validUntil` and the row has an `afterRate`: that rate is returned. */
  afterPromo: boolean
  /** The event is at or after `validUntil` but the vendor published no later rate: the promo rate is returned as best known. */
  promoExpiredNoRate: boolean
}

/** Rate that applies to one request. Promo end is UTC midnight, exclusive. */
export function resolveRate(row: CatalogRow, opts: ResolveOptions = {}): ResolvedRate {
  const atMs = opts.at === undefined ? Date.now() : new Date(opts.at).getTime()
  const expired = row.validUntil !== undefined && atMs >= Date.parse(`${row.validUntil}T00:00:00Z`)
  if (expired && row.afterRate) {
    return { rate: row.afterRate, tierIndex: 0, afterPromo: true, promoExpiredNoRate: false }
  }
  const prompt = opts.promptTokens ?? 0
  let tierIndex = row.tiers.findIndex(t => t.maxPromptTokens === null || prompt <= t.maxPromptTokens)
  if (tierIndex < 0) tierIndex = row.tiers.length - 1
  return { rate: row.tiers[tierIndex].rate, tierIndex, afterPromo: false, promoExpiredNoRate: expired }
}

/** Cache-read price as a multiple of the input price (0.1, 0.05, 0.025 ...). */
export function cacheReadMultiplier(rate: Rate): number {
  return rate.input === 0 ? 0 : rate.cacheRead / rate.input
}

/** Blended $/MTok (0.75 x input + 0.25 x output) used by the context-size estimate path. */
export function blendedRate(rate: Rate): number {
  return 0.75 * rate.input + 0.25 * rate.output
}

/** Blended estimate rate of a model id (lowest prompt tier, current price). */
export function blendedRateForModel(model: string | undefined): number {
  return blendedRate(resolveRate(lookupModel(model).row).rate)
}

/** Blended rate of a family's newest model. */
export function blendedRateForFamily(family: ClaudeFamilyName): number {
  return blendedRate(resolveRate(rowById(FAMILY_CURRENT[family])).rate)
}

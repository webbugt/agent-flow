/**
 * Provider detection, glob matching and rate resolution. Pure, no I/O, no regular expressions on
 * user input (rules use a hand-written `*` / `?` matcher, so patterns cannot cause ReDoS and
 * regex metacharacters are literal).
 *
 * Resolution order for (provider, model), PLAN v1 section 2, first hit wins:
 *   1. user model rule      (`pricing.models[]`, most specific match, ties: earlier rule)  -> rateSource user-rule
 *   2. user provider rate   (`pricing.providers[id].rate|tiers`)                           -> user-provider
 *   3. catalog model        (exact id, or the newest model of a known Claude family)       -> catalog
 *   4. catalog provider default (the provider's sheet default model; policy provider-default) -> provider-default
 *   5. `unknownModel.policy` (global-rate | unpriced | zero | no sheet at all)             -> fallback / none
 *
 * A rule that carries no rate (only billing / energyProfile / modifiers) still applies those
 * overrides; the rate then comes from the next level down.
 */
import type {
  BillingMode, CatalogRow, CatalogSection, ProviderConfig, Rate, RateSource, RateSpec, ResolvedConfig,
  UserRate, UserTier, ModelRule,
} from './types'
import {
  FALLBACK_MODEL_ID, lookupModel, normalizeModelId, resolveRate as resolveCatalogRate, type MatchKind,
} from './catalog'

export { normalizeModelId }

// ── glob ────────────────────────────────────────────────────────────────────

/** Lower-case, `.` and whitespace -> `-`. Keeps `*` and `?` so it can be applied to patterns too. */
export function normalizeGlobText(s: string): string {
  return s.trim().toLowerCase().replace(/[.\s]+/g, '-')
}

/**
 * Case-insensitive glob match (`*` = any run, `?` = any one character; everything else literal),
 * after normalising `.` to `-` on both sides. Linear-time two-pointer algorithm.
 */
export function globMatch(pattern: string, text: string): boolean {
  const p = normalizeGlobText(pattern)
  const t = normalizeGlobText(text)
  let pi = 0; let ti = 0; let star = -1; let mark = 0
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti]) && p[pi] !== '*') { pi++; ti++ }
    else if (pi < p.length && p[pi] === '*') { star = pi++; mark = ti }
    else if (star >= 0) { pi = star + 1; ti = ++mark }
    else return false
  }
  while (pi < p.length && p[pi] === '*') pi++
  return pi === p.length
}

/** Specificity of a pattern: no wildcard = exact (highest); else the literal prefix length, then the literal count. */
export function globSpecificity(pattern: string): number {
  const p = normalizeGlobText(pattern)
  const firstWild = p.search(/[*?]/)
  if (firstWild < 0) return 1_000_000 + p.length
  let literals = 0
  for (const c of p) if (c !== '*' && c !== '?') literals++
  return firstWild * 1000 + literals
}

/** Ids a model rule is tested against: the id as written and the catalog-normalised id (no `provider/`, date stamp or `[1m]`). */
function modelKeys(model: string): string[] {
  const raw = normalizeGlobText(model)
  const norm = normalizeModelId(model)
  return raw === norm ? [raw] : [raw, norm]
}

// ── providers ───────────────────────────────────────────────────────────────

/** Built-in provider knowledge (PLAN v2 section 2). User config overrides field by field. */
export const BUILTIN_PROVIDERS: Readonly<Record<string, ProviderConfig>> = {
  anthropic: { billing: 'api', priceLike: 'anthropic' },
  'claude-subscription-directsdk-experimental': { billing: 'subscription', priceLike: 'anthropic' },
  copilot: { billing: 'credits', priceLike: 'copilot', implicitCacheWrite: true },
  ollama: { billing: 'local' },
  'llama.cpp': { billing: 'local' },
  vllm: { billing: 'local' },
  lmstudio: { billing: 'local' },
  custom: { billing: 'local' },
}

export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Claude Code (Anthropic)',
  'claude-subscription-directsdk-experimental': 'Claude subscription via Hermes',
  copilot: 'GitHub Copilot via Hermes',
  ollama: 'Ollama (local)',
  'llama.cpp': 'llama.cpp (local)',
  vllm: 'vLLM (local)',
  lmstudio: 'LM Studio (local)',
  custom: 'custom OpenAI-compatible endpoint (local)',
}

export const UNKNOWN_PROVIDER = 'unknown'

export interface ProviderHints {
  /** Explicit `provider=` value (Hermes) or per-event provider. Wins. */
  provider?: string
  /** Agent runtime: `claude` -> anthropic, `codex` -> openai. */
  runtime?: string
  model?: string
}

/** `detectProvider`: explicit value, else runtime default, else model-id heuristic, else `unknown`. */
export function detectProvider(h: ProviderHints): string {
  const explicit = h.provider?.trim()
  if (explicit) return explicit
  const rt = h.runtime?.trim().toLowerCase()
  if (rt === 'claude') return 'anthropic'
  if (rt === 'codex') return 'openai'
  const m = h.model ? normalizeModelId(h.model) : ''
  if (m.startsWith('claude-')) return 'anthropic'
  if (m.startsWith('gpt-') || (m.length > 1 && m[0] === 'o' && m[1] >= '0' && m[1] <= '9')) return 'openai'
  if (m.startsWith('gemini-')) return 'google'
  return UNKNOWN_PROVIDER
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

/** Built-in provider settings overlaid with the user's (field by field). Never mutates either. */
export function providerSettings(config: ResolvedConfig, provider: string): ProviderConfig {
  const builtin = Object.hasOwn(BUILTIN_PROVIDERS, provider) ? BUILTIN_PROVIDERS[provider] : undefined
  const user = Object.hasOwn(config.pricing.providers, provider) ? config.pricing.providers[provider] : undefined
  return { ...(builtin ?? {}), ...(user ?? {}) }
}

// ── rules ───────────────────────────────────────────────────────────────────

/** The user model rule that applies, or -1. Most specific wins (model glob, then provider glob); ties: earlier rule. */
export function findRule(config: ResolvedConfig, provider: string, model: string | undefined): number {
  const keys = model ? modelKeys(model) : []
  let best = -1
  let bestScore = -1
  config.pricing.models.forEach((rule, i) => {
    const m = rule.match
    if (m.provider !== undefined && !globMatch(m.provider, provider)) return
    let modelScore = 0
    if (m.model !== undefined) {
      if (!keys.some(k => globMatch(m.model as string, k))) return
      modelScore = globSpecificity(m.model)
    }
    const providerScore = m.provider === undefined ? 0 : globSpecificity(m.provider) + 1
    // Model specificity dominates; provider specificity breaks ties; rule order breaks the rest.
    const score = modelScore * 10_000_000 + providerScore
    if (score > bestScore) { best = i; bestScore = score }
  })
  return best
}

// ── rates ───────────────────────────────────────────────────────────────────

export const CACHE_WRITE_5M_MULT = 1.25
export const CACHE_WRITE_1H_MULT = 2
export const DEFAULT_CACHE_READ_MULT = 0.1

/** Fill the fields a user left out: read = readMult x input, 5m write 1.25x, 1h write 2x. */
export function completeUserRate(r: UserRate, readMult = DEFAULT_CACHE_READ_MULT): Rate {
  return {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead ?? r.input * readMult,
    cacheWrite5m: r.cacheWrite5m ?? r.input * CACHE_WRITE_5M_MULT,
    cacheWrite1h: r.cacheWrite1h ?? r.input * CACHE_WRITE_1H_MULT,
  }
}

function pickUserRate(spec: RateSpec, promptTokens: number, readMult: number): { rate: Rate; tierIndex: number; tierCount: number } | null {
  if (spec.tiers && spec.tiers.length > 0) {
    const tiers: readonly UserTier[] = spec.tiers
    let idx = tiers.findIndex(t => t.maxPromptTokens === null || promptTokens <= t.maxPromptTokens)
    if (idx < 0) idx = tiers.length - 1
    return { rate: completeUserRate(tiers[idx].rate, readMult), tierIndex: idx, tierCount: tiers.length }
  }
  if (spec.rate) return { rate: completeUserRate(spec.rate, readMult), tierIndex: 0, tierCount: 1 }
  return null
}

export interface PricingQuery {
  provider?: string
  runtime?: string
  model?: string
  /** One request's prompt size (input + cache reads + cache writes); selects the tier. Default: lowest tier. */
  promptTokens?: number
  /** Event time for dated price changes (ms epoch or ISO). Default: now. */
  at?: number | string | Date
}

export interface ModelPricing {
  provider: string
  /** Normalised model id ('' when none was given). */
  model: string
  billing: BillingMode
  providerSettings: ProviderConfig
  source: RateSource
  /** Resolution level 1-5 (see the header). 0 for local models / no money rate. */
  level: 0 | 1 | 2 | 3 | 4 | 5
  /** 0-based index into `pricing.models` when a rule matched (even if the rate came from a lower level). */
  ruleIndex: number | null
  /** The rate card in `currency`, or null when there is no money rate (local model, unpriced policy). */
  rate: Rate | null
  /** ISO 4217 code of `rate` (user rates may be non-USD; catalog rates are USD). */
  currency: string
  tierIndex: number
  tierCount: number
  /** Upper bound of the tier in effect (null = open-ended / flat). */
  tierMaxPromptTokens: number | null
  catalogRow: CatalogRow | null
  catalogMatch: MatchKind | null
  catalogSection: CatalogSection | null
  afterPromo: boolean
  promoExpiredNoRate: boolean
  /** Set when source is `fallback`: which policy produced the rate. */
  policy: ResolvedConfig['pricing']['unknownModel']['policy'] | null
  /** Product of the rule's fast / dataResidency / batch multipliers (1 when none). */
  modifiers: number
  energyProfile: string | null
  /** The user's catalog-section preference for this provider. */
  section: CatalogSection | undefined
}

function sectionRow(section: CatalogSection | undefined, id: string): CatalogRow | null {
  const hit = lookupModel(id, { section })
  return hit.match === 'exact' && (section === undefined || hit.row.section === section) ? hit.row : null
}

/**
 * Resolve the rate card for (provider, model). Never throws; an unknown model ends in the policy
 * (default: the provider default, else a flagged fallback), see the header for the five levels.
 */
export function resolveModelPricing(config: ResolvedConfig, q: PricingQuery): ModelPricing {
  const provider = detectProvider({ provider: q.provider, runtime: q.runtime, model: q.model })
  const settings = providerSettings(config, provider)
  const ruleIndex = findRule(config, provider, q.model)
  const rule: ModelRule | null = ruleIndex >= 0 ? config.pricing.models[ruleIndex] : null
  const billing: BillingMode = rule?.billing ?? settings.billing ?? 'unknown'
  const prompt = q.promptTokens ?? 0
  const policy = config.pricing.unknownModel.policy
  const section = settings.priceLike
  const modifiers = rule?.modifiers ? Object.values(rule.modifiers).reduce<number>((a, b) => a * (b ?? 1), 1) : 1
  const energyProfile = rule?.energyProfile ?? settings.energyProfile ?? null
  const lookup = lookupModel(q.model, { section })

  const base: ModelPricing = {
    provider, model: lookup.id, billing, providerSettings: settings, source: 'none', level: 0, ruleIndex: ruleIndex >= 0 ? ruleIndex : null,
    rate: null, currency: 'USD', tierIndex: 0, tierCount: 1, tierMaxPromptTokens: null, catalogRow: null, catalogMatch: null,
    catalogSection: null, afterPromo: false, promoExpiredNoRate: false, policy: null, modifiers, energyProfile, section,
  }
  const readMult = lookup.match !== 'fallback' ? cacheReadMult(lookup.row, prompt, q.at) : DEFAULT_CACHE_READ_MULT

  // 1. user model rule
  if (rule) {
    const picked = pickUserRate(rule, prompt, readMult)
    if (picked) {
      return {
        ...base, source: 'user-rule', level: 1, rate: picked.rate, currency: rule.currency ?? settings.currency ?? 'USD',
        tierIndex: picked.tierIndex, tierCount: picked.tierCount, tierMaxPromptTokens: userTierMax(rule, picked.tierIndex),
        catalogRow: lookup.match !== 'fallback' ? lookup.row : null, catalogMatch: lookup.match !== 'fallback' ? lookup.match : null,
        catalogSection: lookup.match !== 'fallback' ? lookup.row.section : null,
      }
    }
  }
  // A local model has no money rate: its cost is electricity (energy module).
  if (billing === 'local') return base

  // 2. user provider rate
  const pr = pickUserRate(settings, prompt, readMult)
  if (pr) {
    return {
      ...base, source: 'user-provider', level: 2, rate: pr.rate, currency: settings.currency ?? 'USD',
      tierIndex: pr.tierIndex, tierCount: pr.tierCount, tierMaxPromptTokens: userTierMax(settings, pr.tierIndex),
      catalogRow: lookup.match !== 'fallback' ? lookup.row : null, catalogMatch: lookup.match !== 'fallback' ? lookup.match : null,
      catalogSection: lookup.match !== 'fallback' ? lookup.row.section : null,
    }
  }

  // 3. catalog model
  if (lookup.match !== 'fallback') return fromCatalog(base, lookup.row, lookup.match, 'catalog', 3, prompt, q.at)

  // 4. catalog provider default (the sheet's default model), when the policy asks for it
  const defaultSection = section
  if (policy === 'provider-default' && defaultSection && q.model) {
    const row = sectionRow(defaultSection, FALLBACK_MODEL_ID)
    if (row) return fromCatalog(base, row, 'exact', 'provider-default', 4, prompt, q.at)
  }

  // 5. policy
  const ug = config.pricing.unknownModel.globalRate
  const withPolicy = { ...base, level: 5 as const, policy }
  if (policy === 'unpriced') return { ...withPolicy, source: 'none' }
  if (policy === 'zero') {
    return { ...withPolicy, source: 'fallback', rate: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }
  }
  if (ug && (policy === 'global-rate' || policy === 'provider-default')) {
    return { ...withPolicy, source: 'fallback', rate: completeUserRate(ug) }
  }
  // No usable policy input: price like the newest Sonnet-class model, flagged as a guess.
  const row = sectionRow(undefined, FALLBACK_MODEL_ID) as CatalogRow
  const r = resolveCatalogRate(row, { promptTokens: prompt, at: q.at })
  return {
    ...withPolicy, source: 'fallback', rate: r.rate, tierIndex: r.tierIndex, tierCount: row.tiers.length,
    tierMaxPromptTokens: row.tiers[r.tierIndex].maxPromptTokens, catalogRow: row, catalogMatch: 'fallback', catalogSection: row.section,
    afterPromo: r.afterPromo, promoExpiredNoRate: r.promoExpiredNoRate,
  }
}

function userTierMax(spec: RateSpec, idx: number): number | null {
  return spec.tiers ? spec.tiers[idx].maxPromptTokens : null
}

function cacheReadMult(row: CatalogRow, prompt: number, at: PricingQuery['at']): number {
  const r = resolveCatalogRate(row, { promptTokens: prompt, at }).rate
  return r.input === 0 ? DEFAULT_CACHE_READ_MULT : r.cacheRead / r.input
}

function fromCatalog(
  base: ModelPricing, row: CatalogRow, match: MatchKind, source: RateSource, level: 3 | 4, prompt: number, at: PricingQuery['at'],
): ModelPricing {
  const r = resolveCatalogRate(row, { promptTokens: prompt, at })
  return {
    ...base, source, level, rate: r.rate, currency: 'USD', tierIndex: r.tierIndex, tierCount: row.tiers.length,
    tierMaxPromptTokens: row.tiers[r.tierIndex].maxPromptTokens, catalogRow: row, catalogMatch: match, catalogSection: row.section,
    afterPromo: r.afterPromo, promoExpiredNoRate: r.promoExpiredNoRate,
  }
}

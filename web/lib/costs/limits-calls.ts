/**
 * Plan-limit usage from the ledger (P6b). Pure.
 *
 * The host records each agent's usage in 10-minute buckets (`SpendTotals.byTime`, key
 * `<slot>|<provider>|<model>|<prompt bucket>`). Here those become `LimitCall`s: only the providers that draw on the
 * Claude plan, each priced at LIST rates in USD (a limit is not money, so no multiplier and no FX) times the family
 * weight of the config. Time resolution is the bucket (10 minutes), which is exact enough for 5-hour and weekly windows.
 *
 * Counted providers (PLAN v2 section 5): `limits.claude.countProviders`; `anthropic` (Claude Code transcripts) counts only
 * when the user said that provider is a subscription; Copilot NEVER counts (a Copilot-routed Fable call does not draw on
 * the Claude Fable limit), whatever the list says.
 */
import type { ClaudeFamilyName, ResolvedConfig, UsageTokens } from './types'
import { costOfTokens } from './price'
import { providerSettings, resolveModelPricing } from './resolve'
import { unitsPerUsd } from './price'
import { callUnits } from './limits'
import type { PromptBucket } from './tiers'

export const TIME_SLOT_MS = 10 * 60 * 1000

/** A prompt size inside each bucket (the tier is chosen by which side of a boundary the prompt is on). */
const BUCKET_PROMPT: Record<PromptBucket, number> = { le100000: 100_000, le200000: 200_000, le272000: 272_000, gt272000: 272_001 }
const BUCKETS = Object.keys(BUCKET_PROMPT) as PromptBucket[]

export interface LimitCall {
  /** Start of the 10-minute bucket (ms epoch). */
  at: number
  provider: string
  model: string
  family?: ClaudeFamilyName
  /** family weight x list-equivalent USD. */
  units: number
  /** List-equivalent USD alone (what the hover calls "list-equiv"). */
  listUsd: number
  /** False when no rate was found for the model: it counts as 0 units, and the panel says so. */
  priced: boolean
}

/** Whether calls of `provider` draw on the Claude plan limits under this config. */
export function countsTowardClaudeLimits(config: ResolvedConfig, provider: string): boolean {
  if (provider === 'copilot') return false
  if (!config.limits.claude.countProviders.includes(provider)) return false
  if (provider === 'anthropic') return providerSettings(config, 'anthropic').billing === 'subscription'
  return true
}

export function isFableFamily(f: ClaudeFamilyName | undefined): boolean { return f === 'fable' || f === 'mythos' }

const FAMILY_RE = /(fable|mythos|opus|sonnet|haiku)/i
function familyOfId(model: string): ClaudeFamilyName | undefined {
  const m = FAMILY_RE.exec(model)
  return m ? (m[1].toLowerCase() as ClaudeFamilyName) : undefined
}

export interface ParsedTimeKey { slot: number; provider: string; model: string; bucket: PromptBucket }

export function parseTimeKey(key: string): ParsedTimeKey | null {
  const parts = key.split('|')
  if (parts.length !== 4) return null
  const slot = Number(parts[0])
  const bucket = parts[3] as PromptBucket
  if (!Number.isInteger(slot) || slot < 0 || !BUCKETS.includes(bucket) || !parts[1] || !parts[2]) return null
  return { slot, provider: parts[1], model: parts[2], bucket }
}

/** The ledger entries of all agents as limit calls (counted providers only). `spends` are the `byTime` maps. */
export function buildLimitCalls(config: ResolvedConfig, spends: readonly (Readonly<Record<string, UsageTokens>> | undefined)[]): LimitCall[] {
  const weights = config.limits.claude.weights
  const merged = new Map<string, UsageTokens>()
  for (const byTime of spends) {
    if (!byTime) continue
    for (const [key, u] of Object.entries(byTime)) {
      const prev = merged.get(key)
      merged.set(key, prev ? {
        inputTokens: prev.inputTokens + u.inputTokens, outputTokens: prev.outputTokens + u.outputTokens, cacheReadTokens: prev.cacheReadTokens + u.cacheReadTokens,
        cacheWrite5mTokens: prev.cacheWrite5mTokens + u.cacheWrite5mTokens, cacheWrite1hTokens: prev.cacheWrite1hTokens + u.cacheWrite1hTokens,
      } : u)
    }
  }
  const priced = new Map<string, { usdPerUnit: ((u: UsageTokens) => number) | null; family: ClaudeFamilyName | undefined }>()
  const out: LimitCall[] = []
  for (const [key, u] of merged) {
    const k = parseTimeKey(key)
    if (!k || !countsTowardClaudeLimits(config, k.provider)) continue
    const ck = `${k.provider}|${k.model}|${k.bucket}`
    let p = priced.get(ck)
    if (!p) {
      const pricing = resolveModelPricing(config, { provider: k.provider, model: k.model, promptTokens: BUCKET_PROMPT[k.bucket], at: k.slot * TIME_SLOT_MS })
      const perUsd = pricing.rate ? unitsPerUsd(config, pricing.currency) : null
      const rate = pricing.rate
      p = {
        family: pricing.catalogRow?.family ?? familyOfId(k.model),
        usdPerUnit: rate && perUsd !== null && pricing.billing !== 'local' ? (x: UsageTokens) => costOfTokens(rate, x) / perUsd : null,
      }
      priced.set(ck, p)
    }
    const listUsd = p.usdPerUnit ? p.usdPerUnit(u) : 0
    out.push({
      at: k.slot * TIME_SLOT_MS, provider: k.provider, model: k.model, ...(p.family ? { family: p.family } : {}),
      listUsd, units: callUnits(weights, p.family, listUsd), priced: p.usdPerUnit !== null,
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

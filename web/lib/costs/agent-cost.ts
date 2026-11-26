/**
 * One agent's cost under a resolved config: the bridge between the overlay (which holds `Agent` objects) and
 * priceUsage (which prices one request-size bucket at a time). Pure. Structural input types, so this file
 * does not import from agent-types (which imports from costs/).
 *
 * Billed usage is priced per prompt-size bucket (`byBucket`, which sums to the flat totals) so tiered models
 * get the right tier; without buckets the flat totals are priced at the lowest tier. With no reported usage
 * the context size is priced at the blended rate (estimate).
 */
import { priceUsage } from './price'
import type { PriceResult } from './price'
import type { PromptBucket } from './tiers'
import { computeEnergy } from './energy'
import type { EnergyResult } from './energy'
import type { EnergyUsage, ResolvedConfig, UsageTokens } from './types'

export interface AgentSpendInput {
  /** Billed usage, as reported by the runtime. */
  spend?: (UsageTokens & { model?: string; provider?: string; byBucket?: Partial<Record<PromptBucket, UsageTokens>>; energy?: EnergyUsage }) | undefined
  tokensUsed: number
  model?: string
  runtime?: string
}

export interface AgentCost {
  /** Display-currency amount, 0 for unpriced / local / hidden. */
  amount: number
  /** True when the figure comes from the context-size estimate, not billed usage. */
  estimate: boolean
  /** The pricing results this figure is the sum of (one per bucket), for tooltips. */
  results: PriceResult[]
  /** Billing kind of the first result: billed | list-equivalent | estimated | unpriced. */
  kind: PriceResult['kind']
  /** Any result could not be priced. */
  unpriced: boolean
  /**
   * Local models: kWh and electricity cost of the stored busy time under the current energy profile and tariff.
   * null for every other agent, and for a local agent whose model has no (defined) energy profile.
   */
  energy: EnergyResult | null
}

/** A prompt size that falls inside each bucket (tier selection only looks at which side of a boundary it is on). */
const BUCKET_PROMPT: Record<PromptBucket, number> = { le100000: 100_000, le200000: 200_000, le272000: 272_000, gt272000: 272_001 }

function counts(u: UsageTokens): UsageTokens {
  return {
    inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens,
    cacheWrite5mTokens: u.cacheWrite5mTokens, cacheWrite1hTokens: u.cacheWrite1hTokens,
  }
}

export function priceAgent(config: ResolvedConfig, agent: AgentSpendInput): AgentCost {
  const model = agent.spend?.model ?? agent.model
  const q = { provider: agent.spend?.provider, runtime: agent.runtime, model }
  let results: PriceResult[]
  let estimate = false
  if (agent.spend) {
    const buckets = agent.spend.byBucket ? (Object.entries(agent.spend.byBucket) as [PromptBucket, UsageTokens][]) : []
    results = buckets.length > 0
      ? buckets.map(([b, u]) => priceUsage(config, { ...q, promptTokens: BUCKET_PROMPT[b], usage: counts(u) }))
      : [priceUsage(config, { ...q, usage: counts(agent.spend) })]
  } else {
    estimate = true
    results = [priceUsage(config, { ...q, tokensUsed: agent.tokensUsed })]
  }
  let amount = 0
  let unpriced = false
  for (const r of results) {
    if (r.kind === 'unpriced') unpriced = true
    if (!r.hidden) amount += r.amount
  }
  const pricing = results[0].pricing
  const energy = pricing.billing === 'local' ? computeEnergy(config, pricing.energyProfile, agent.spend?.energy) : null
  return { amount, estimate, results, kind: results[0].kind, unpriced, energy }
}

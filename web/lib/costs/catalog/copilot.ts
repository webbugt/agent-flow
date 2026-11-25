/**
 * GitHub Copilot per-token price sheet (USD per 1M tokens, 1 AI credit = $0.01).
 *
 * Source:   https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 * Verified: 2026-11-25, live page fetched in full (every table, all footnotes). Full log:
 *           docs/price-catalog-sources.md.
 *
 * What the figure means: these are list-equivalent rates. Plans include an AI-credits allowance
 * that agent-flow does not subtract; usage beyond it bills at these same rates. Only Hermes-routed
 * `provider=copilot` calls are observable (PLAN v2 section 3.1).
 *
 * "Threshold (input tokens)": whether cached tokens count toward the threshold is not stated on the
 * page, so every tiered row carries `unverified: ['thresholdCountsCache']`. Anthropic's own page
 * says its Haiku 5.5 threshold counts cache reads and writes; the same convention is assumed.
 *
 * Not modelled (documented, not priced):
 *  - GPT Image 2.5 Flare: image generation, billed in text/image units, no token chat usage.
 *  - Code completions / next-edit suggestions: not billed in AI credits.
 *  - Copilot code review: billed per review with an undisclosed model (estimates on the page only).
 *  - "Fine-tuned (GitHub)" table: empty on the page.
 *  - Request-based legacy multipliers for annual Pro/Pro+ plans.
 */
import type { CatalogRow, CatalogTier, Rate, UnverifiedField } from '../types'

export const COPILOT_SOURCE = 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing'
export const COPILOT_AS_OF = '2026-11-25'

/** (input, cached input, cache write | null, output). Copilot lists no 1h write. */
const r = (input: number, cacheRead: number, cacheWrite5m: number | null, output: number): Rate =>
  ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h: null })

const flat = (rate: Rate): CatalogTier[] => [{ maxPromptTokens: null, rate }]
const split = (threshold: number, low: Rate, high: Rate): CatalogTier[] => [
  { maxPromptTokens: threshold, rate: low },
  { maxPromptTokens: null, rate: high },
]
const TIER_UNVERIFIED: readonly UnverifiedField[] = ['thresholdCountsCache']

function row(
  id: string, name: string, vendor: string, tiers: CatalogTier[], extra: Partial<CatalogRow> = {},
): CatalogRow {
  const tiered = tiers.length > 1
  return {
    id, name, vendor, section: 'copilot', source: COPILOT_SOURCE, asOf: COPILOT_AS_OF, tiers,
    ...(tiered ? { unverified: TIER_UNVERIFIED } : {}),
    ...extra,
  }
}

export const COPILOT_ROWS: readonly CatalogRow[] = [
  // ── OpenAI ── (GPT-5.6 and later include a cache write cost; earlier models have none)
  row('gpt-5-3-codex', 'GPT-5.3-Codex', 'OpenAI', flat(r(1.75, 0.175, null, 14))),
  row('gpt-5-4-nano', 'GPT-5.4 nano', 'OpenAI', flat(r(0.2, 0.02, null, 1.25))),
  row('gpt-5-6-luna', 'GPT-5.6 Luna', 'OpenAI', split(200_000, r(0.2, 0.02, 0.25, 1.2), r(0.4, 0.04, 0.5, 1.8))),
  row('gpt-5-6-sol', 'GPT-5.6 Sol', 'OpenAI', split(272_000, r(4, 0.4, 5, 20), r(8, 0.8, 10, 30))),
  row('gpt-6-astra', 'GPT-6 Astra', 'OpenAI', split(272_000, r(10, 1, 12.5, 50), r(20, 2, 25, 75))),
  row('gpt-6-luna', 'GPT-6 Luna', 'OpenAI', split(272_000, r(0.1, 0.01, 0.125, 0.5), r(0.2, 0.02, 0.25, 0.75))),
  row('gpt-6-sol', 'GPT-6 Sol', 'OpenAI', split(272_000, r(2, 0.2, 2.5, 10), r(4, 0.4, 5, 15))),
  row('gpt-6-1-sol', 'GPT-6.1 Sol', 'OpenAI', split(272_000, r(2, 0.1, 2.5, 10), r(4, 0.2, 5, 15))),
  row('gpt-6-1-terra', 'GPT-6.1 Terra', 'OpenAI', split(272_000, r(1, 0.05, 1.25, 5), r(2, 0.1, 2.5, 7.5))),
  row('gpt-6-2-astra', 'GPT-6.2 Astra', 'OpenAI', split(272_000, r(8, 0.4, 10, 40), r(16, 0.8, 20, 60))),
  row('gpt-6-2-sol', 'GPT-6.2 Sol', 'OpenAI', split(272_000, r(2, 0.1, 2.5, 10), r(4, 0.2, 5, 15))),

  // ── Anthropic (all include a cache write) ──
  row('claude-haiku-4-5', 'Claude Haiku 4.5', 'Anthropic', flat(r(1, 0.1, 1.25, 5)), { family: 'haiku' }),
  row('claude-haiku-5-5', 'Claude Haiku 5.5', 'Anthropic', split(100_000, r(0.1, 0.01, 0.125, 0.5), r(0.5, 0.05, 0.625, 2.5)), { family: 'haiku' }),
  row('claude-sonnet-4', 'Claude Sonnet 4', 'Anthropic', flat(r(3, 0.3, 3.75, 15)), { family: 'sonnet' }),
  row('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Anthropic', flat(r(3, 0.3, 3.75, 15)), { family: 'sonnet' }),
  row('claude-opus-4-8', 'Claude Opus 4.8', 'Anthropic', flat(r(5, 0.5, 6.25, 25)), { family: 'opus' }),
  row('claude-opus-5-5', 'Claude Opus 5.5', 'Anthropic', flat(r(4, 0.2, 5, 20)), { family: 'opus' }),
  row('claude-sonnet-5', 'Claude Sonnet 5', 'Anthropic', flat(r(2, 0.2, 2.5, 10)), { family: 'sonnet' }),
  row('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Anthropic', flat(r(2, 0.1, 2.5, 10)), { family: 'sonnet' }),
  row('claude-opus-4-8-fast', 'Claude Opus 4.8 (fast mode) (preview)', 'Anthropic', flat(r(10, 1, 12.5, 50)), { family: 'opus' }),
  row('claude-fable-5', 'Claude Fable 5', 'Anthropic', flat(r(10, 1, 12.5, 50)), { family: 'fable' }),
  row('claude-fable-5-1', 'Claude Fable 5.1', 'Anthropic', flat(r(10, 0.25, 12.5, 50)), { family: 'fable' }),
  row('claude-fable-5-2', 'Claude Fable 5.2', 'Anthropic', flat(r(8, 0.2, 10, 40)), { family: 'fable' }),

  // ── Google ── (no cache write column; promo footnotes 1-3)
  row('gemini-3-8-flash', 'Gemini 3.8 Flash', 'Google', flat(r(0.75, 0.075, null, 3.75)), {
    validUntil: '2027-01-01', unverified: ['afterPromoRate'],
    note: 'Footnote 1: promotional price "through December 31, 2026" (inclusive), so validUntil is the first instant after it, 2027-01-01 UTC. The price after is not published on the page.',
  }),
  row('gemini-4-argon', 'Gemini 4 Argon', 'Google', flat(r(2, 0.1, null, 10)), {
    validUntil: '2026-12-01', unverified: ['afterPromoRate'],
    note: 'Promotional price until 2026-12-01; the price after is not published on the page.',
  }),
  row('gemini-4-carbon', 'Gemini 4 Carbon', 'Google', flat(r(2, 0.1, null, 10)), {
    validUntil: '2026-12-01', afterRate: r(4, 0.2, null, 20),
    note: 'Promotional price until 2026-12-01; from 2026-12-01 $4.00 / $0.20 / $20.00 (footnote 3).',
  }),
  row('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 'Google', flat(r(1.5, 0.075, null, 7.5))),
  row('gemini-4-neon', 'Gemini 4 Neon', 'Google', flat(r(3, 0.15, null, 15))),

  // ── Microsoft ──
  row('mai-code-1-1-flash', 'MAI-Code-1.1-Flash', 'Microsoft', flat(r(0.2, 0.02, null, 1.2))),
  row('mai-code-2', 'MAI Code 2', 'Microsoft', flat(r(0.5, 0.025, null, 2.5)), {
    validUntil: '2027-05-17', afterRate: r(1, 0.05, null, 5),
    note: 'Promotional price until 2027-05-17, then $1.00 / $0.05 / $5.00 (footnote 4).',
  }),
  row('mai-code-2-flash', 'MAI Code 2 Flash', 'Microsoft', flat(r(0.05, 0.005, null, 0.25)), {
    validUntil: '2027-05-17', afterRate: r(0.1, 0.01, null, 0.5),
    note: 'Promotional price until 2027-05-17, then $0.10 / $0.01 / $0.50 (footnote 5).',
  }),

  // ── xAI ──
  row('grok-4-5', 'Grok 4.5', 'xAI', split(200_000, r(2, 0.5, null, 6), r(4, 1, null, 12))),
  row('grok-4-6', 'Grok 4.6', 'xAI', split(200_000, r(2, 0.5, null, 6), r(4, 1, null, 12))),
  row('grok-4-7', 'Grok 4.7', 'xAI', split(200_000, r(2, 0.5, null, 6), r(4, 1, null, 12))),

  // ── Moonshot AI ──
  row('kimi-k3', 'Kimi K3', 'Moonshot AI', flat(r(3, 0.3, null, 15))),
]

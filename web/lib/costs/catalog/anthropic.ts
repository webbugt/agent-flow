/**
 * Anthropic API list prices (USD per 1M tokens).
 *
 * Source:   https://platform.claude.com/docs/en/about-claude/pricing
 * Verified: 2026-11-25, LIVE page read in a real browser (full text, "Model pricing",
 *           "Prompt caching", "Long context pricing", "Fast mode pricing" sections), cross-checked
 *           with a second fetch (web_extract). Full log: docs/price-catalog-sources.md.
 *
 * Every figure below is transcribed from the page, not computed. Cache multipliers are
 * PER MODEL on this page (a flat 0.1x is wrong for the newest models):
 *   cache read   0.1x   most models (Fable 5, Mythos 5, Opus 5 and older, Sonnet, Haiku)
 *                0.05x  Opus 5.5, Sonnet 5.5
 *                0.025x Fable 5.2/5.1, Mythos 5.2/5.1
 *   5m write     1.25x   1h write 2x   (every model)
 * catalog.test.ts pins these ratios against the transcribed numbers.
 *
 * Not modelled here (stackable modifiers, handled by config in P1+): Batch API -50%, US data
 * residency x1.1 (inference_geo), Bedrock/Vertex regional premium, web search $10/1k searches,
 * code execution hours, Managed Agents session-hour. Haiku 5.5 is the only Anthropic model with
 * prompt-size tiers; the prompt length counts input + cache reads + cache writes of ONE request.
 */
import type { CatalogRow, ClaudeFamilyName, Rate } from '../types'

export const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'
export const ANTHROPIC_AS_OF = '2026-11-25'

const rate = (input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number): Rate =>
  ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h })

function row(
  id: string, name: string, family: ClaudeFamilyName, r: Rate, extra: Partial<CatalogRow> = {},
): CatalogRow {
  return {
    id, name, family, section: 'anthropic', vendor: 'Anthropic',
    source: ANTHROPIC_SOURCE, asOf: ANTHROPIC_AS_OF,
    tiers: [{ maxPromptTokens: null, rate: r }],
    ...extra,
  }
}

// rate(input, output, 5m write, 1h write, cache hit)
const FABLE_5_2 = rate(8, 40, 10, 16, 0.2)       // cache hit 0.025x
const FABLE_5_1 = rate(10, 50, 12.5, 20, 0.25)   // cache hit 0.025x
const FABLE_5 = rate(10, 50, 12.5, 20, 1)        // cache hit 0.1x
const OPUS_5_5 = rate(4, 20, 5, 8, 0.2)          // cache hit 0.05x
const OPUS_5 = rate(5, 25, 6.25, 10, 0.5)        // Opus 5 .. 4.5 share one card
const OPUS_4 = rate(15, 75, 18.75, 30, 1.5)      // Opus 4.1, 4 (retired outside Bedrock/Vertex)
const SONNET_5_5 = rate(2, 10, 2.5, 4, 0.1)      // cache hit 0.05x
const SONNET_5 = rate(2, 10, 2.5, 4, 0.2)        // cache hit 0.1x
const SONNET_4 = rate(3, 15, 3.75, 6, 0.3)       // Sonnet 4.6, 4.5, 4
const HAIKU_4_5 = rate(1, 5, 1.25, 2, 0.1)

const LIMITED = 'limited availability on the vendor page'
/** Fast mode: input/output are listed; the cache rates apply the stated multipliers on top ("Prompt caching multipliers apply on top of fast mode pricing"), so they are derived. */
const FAST_DERIVED = ['cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const
const fast = (input: number, output: number, readMult: number): Rate =>
  rate(input, output, input * 1.25, input * 2, input * readMult)

export const ANTHROPIC_ROWS: readonly CatalogRow[] = [
  row('claude-fable-5-2', 'Claude Fable 5.2', 'fable', FABLE_5_2),
  row('claude-mythos-5-2', 'Claude Mythos 5.2', 'mythos', FABLE_5_2, { note: LIMITED }),
  row('claude-fable-5-1', 'Claude Fable 5.1', 'fable', FABLE_5_1),
  row('claude-mythos-5-1', 'Claude Mythos 5.1', 'mythos', FABLE_5_1, { note: LIMITED }),
  row('claude-fable-5', 'Claude Fable 5', 'fable', FABLE_5),
  row('claude-mythos-5', 'Claude Mythos 5', 'mythos', FABLE_5, { note: LIMITED }),

  row('claude-opus-5-5', 'Claude Opus 5.5', 'opus', OPUS_5_5),
  row('claude-opus-5', 'Claude Opus 5', 'opus', OPUS_5),
  row('claude-opus-4-8', 'Claude Opus 4.8', 'opus', OPUS_5),
  row('claude-opus-4-7', 'Claude Opus 4.7', 'opus', OPUS_5),
  row('claude-opus-4-6', 'Claude Opus 4.6', 'opus', OPUS_5),
  row('claude-opus-4-5', 'Claude Opus 4.5', 'opus', OPUS_5),
  row('claude-opus-4-1', 'Claude Opus 4.1', 'opus', OPUS_4, { note: 'retired except on Google Cloud (Google managed) and Bedrock' }),
  row('claude-opus-4', 'Claude Opus 4', 'opus', OPUS_4, { note: 'retired except on Google Cloud (Google managed)' }),

  row('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'sonnet', SONNET_5_5),
  row('claude-sonnet-5', 'Claude Sonnet 5', 'sonnet', SONNET_5),
  row('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'sonnet', SONNET_4),
  row('claude-sonnet-4-5', 'Claude Sonnet 4.5', 'sonnet', SONNET_4),
  row('claude-sonnet-4', 'Claude Sonnet 4', 'sonnet', SONNET_4, { note: 'retired except on Google Cloud (Google managed) and Bedrock' }),

  {
    ...row('claude-haiku-5-5', 'Claude Haiku 5.5', 'haiku', rate(0.1, 0.5, 0.125, 0.2, 0.01)),
    // Prompt length counts input + cache reads + cache writes of ONE request; each request is priced on its own.
    tiers: [
      { maxPromptTokens: 100_000, rate: rate(0.1, 0.5, 0.125, 0.2, 0.01) },
      { maxPromptTokens: null, rate: rate(0.5, 2.5, 0.625, 1, 0.05) },
    ],
  },
  row('claude-haiku-4-5', 'Claude Haiku 4.5', 'haiku', HAIKU_4_5),

  // Fast mode (premium speed). Flat across the full context window. Model ids do not change
  // in usage logs, so these rows are only reachable by an explicit `-fast` id.
  row('claude-fable-5-2-fast', 'Claude Fable 5.2 (fast mode)', 'fable', fast(16, 80, 0.025), { unverified: FAST_DERIVED }),
  row('claude-mythos-5-2-fast', 'Claude Mythos 5.2 (fast mode)', 'mythos', fast(16, 80, 0.025), { unverified: FAST_DERIVED, note: LIMITED }),
  row('claude-opus-5-5-fast', 'Claude Opus 5.5 (fast mode)', 'opus', fast(8, 40, 0.05), { unverified: FAST_DERIVED }),
  row('claude-opus-5-fast', 'Claude Opus 5 (fast mode)', 'opus', fast(10, 50, 0.1), { unverified: FAST_DERIVED }),
  row('claude-opus-4-8-fast', 'Claude Opus 4.8 (fast mode)', 'opus', fast(10, 50, 0.1), { unverified: FAST_DERIVED, note: 'fast mode deprecated for Opus 4.8 on the vendor page' }),
]

/**
 * Newest listed non-fast model of each family. Used for unlisted ids of a known family
 * (e.g. a future `claude-opus-6`): the match is reported as `family`, never `exact`.
 */
export const FAMILY_CURRENT: Readonly<Record<ClaudeFamilyName, string>> = {
  fable: 'claude-fable-5-2',
  mythos: 'claude-mythos-5-2',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

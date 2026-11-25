/**
 * Real spend from billed API usage. Prices come from the price catalog
 * (lib/costs/catalog), which holds the full vendor tables with source URL and
 * verification date per row; see docs/price-catalog-sources.md.
 *
 * Verified against the LIVE vendor pages on 2026-11-25:
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 *
 * Cache pricing is per model, not a flat multiplier. Cache reads bill at 0.1x input on most
 * models, 0.05x on Opus 5.5 / Sonnet 5.5 and 0.025x on Fable 5.1/5.2 and Mythos 5.1/5.2.
 * 5-minute cache writes are 1.25x and 1-hour writes 2x input (Anthropic). Models whose
 * vendor sheet lists no cache write (Gemini, xAI, Kimi, Microsoft, pre-5.6 OpenAI) bill
 * written tokens as plain input.
 *
 * Model resolution: exact catalog id (`.` == `-`; date stamps and `[1m]` ignored), else the
 * newest model of the same Claude family, else the Sonnet 5.5 rate (the fallback).
 *
 * This file is the backwards-compatible shim over the pure costs/ modules (P1): the signatures of
 * priceForModel / spendUsd are unchanged and results are identical. Configurable pricing, billing
 * kinds and tooltips live in costs/resolve.ts, costs/price.ts and costs/tooltip.ts.
 *
 * Known limits (both are fixed by later plan tasks, not here):
 *  - Haiku 5.5 and the Copilot GPT/Grok models price by the prompt size of ONE request.
 *    SpendTotals are cumulative per agent, so without `promptTokens` the lowest tier is used
 *    and long-prompt calls are under-priced until per-request buckets land (P2).
 *  - SpendTotals carries one `model` (the latest). An agent that switched models is priced
 *    entirely at the latest model's rates.
 *
 * Before/after of this refresh (USD, token counts of the H0 fixtures in scripts/shot-fixtures).
 * Spend path = billed usage priced by spendUsd; the Hermes rows are what the overlay pill showed
 * (screenshots in docs/screenshots/t_00f2f4ac). Estimate path = context-size estimate (~$), the
 * blended 0.75 x input + 0.25 x output rate; the relay sends no usage for Claude Code transcripts
 * (only the extension ledger does), so the F-A/F-C/F-D pills use it.
 *
 *   fixture (priced model)                    old      new     reason
 *   F-B Hermes sub, 2 calls (opus-5-5)        0.2037   0.1431  5/25 -> 4/20; cache read 0.1x -> 0.05x
 *   F-E Hermes copilot, 3 calls (last model   0.1350   0.0876  unknown-model fallback 3/15 -> gpt-6.1-sol row 2/10;
 *       gpt-6.1-sol prices the whole agent)                    cache read 0.30 -> 0.20
 *   F-A transcript, 3 turns (sonnet-5-5)      0.1558   0.1000  3/15 -> 2/10; cache read 0.1x -> 0.05x
 *   F-D transcript, 2 turns (fable-5-2)       0.8000   0.6220  10/50 -> 8/40; cache read 0.1x -> 0.025x
 *   F-C haiku-5-5, 90K prompt                 0.0940   0.0094  1/5 -> 0.10/0.50
 *   F-C haiku-5-5, 120K prompt                0.1255   0.0126  same; 0.0628 once the >100K tier gets per-request data (P2)
 *   F-G unknown model acme-xyz-9              0.0435   0.0290  fallback 3/15 -> 2/10
 *   estimate path, overlay pill: F-A ~$0.030 -> ~$0.020 · F-D ~$0.101 -> ~$0.081 · F-C ~$0.010 -> ~$0.0010
 */
import type { SpendTotals } from './agent-types'
import { lookupModel, resolveRate, type ResolveOptions } from './costs/catalog'
import { costOfTokens } from './costs/price'
import type { CatalogSection, Rate } from './costs/types'

interface Price { input: number; output: number }

export interface PriceOptions extends ResolveOptions {
  /** Sheet to prefer for ids that exist in both (default: Anthropic first). */
  section?: CatalogSection
}

function rateForModel(model: string | undefined, opts: PriceOptions): Rate {
  return resolveRate(lookupModel(model, { section: opts.section }).row, opts).rate
}

/** USD per 1M input/output tokens of a model. Unknown models use the Sonnet 5.5 fallback. */
export function priceForModel(model?: string, opts: PriceOptions = {}): Price {
  const r = rateForModel(model, opts)
  return { input: r.input, output: r.output }
}

/** Billed cost in USD for one agent's cumulative usage. */
export function spendUsd(spend: SpendTotals, model?: string, opts: PriceOptions = {}): number {
  return costOfTokens(rateForModel(spend.model ?? model, opts), spend)
}

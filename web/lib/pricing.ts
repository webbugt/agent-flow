/**
 * Real spend from billed API usage. Prices are USD per million tokens and
 * follow the list prices noted in canvas-constants (input / output):
 *   fable, mythos 10 / 50 · opus 5 / 25 · sonnet 3 / 15 · haiku 1 / 5
 * Cache reads bill at 0.1x input, 5-minute cache writes at 1.25x input and
 * 1-hour cache writes at 2x input. Unknown models use the Sonnet rate.
 * Verify these against current pricing when models change.
 */
import type { SpendTotals } from './agent-types'

interface Price { input: number; output: number }

const FAMILY_PRICES: ReadonlyArray<{ pattern: RegExp; price: Price }> = [
  { pattern: /fable-\d/, price: { input: 10, output: 50 } },
  { pattern: /mythos-\d/, price: { input: 10, output: 50 } },
  { pattern: /opus-\d/, price: { input: 5, output: 25 } },
  { pattern: /sonnet-\d/, price: { input: 3, output: 15 } },
  { pattern: /haiku-\d/, price: { input: 1, output: 5 } },
]

const FALLBACK_PRICE: Price = { input: 3, output: 15 }

export function priceForModel(model?: string): Price {
  if (model) {
    const id = model.toLowerCase()
    for (const { pattern, price } of FAMILY_PRICES) {
      if (pattern.test(id)) return price
    }
  }
  return FALLBACK_PRICE
}

/** Billed cost in USD for one agent's cumulative usage. */
export function spendUsd(spend: SpendTotals, model?: string): number {
  const p = priceForModel(spend.model ?? model)
  const perToken = (ratePerMTok: number, tokens: number) => (tokens / 1_000_000) * ratePerMTok
  return (
    perToken(p.input, spend.inputTokens) +
    perToken(p.output, spend.outputTokens) +
    perToken(p.input * 0.1, spend.cacheReadTokens) +
    perToken(p.input * 1.25, spend.cacheWrite5mTokens) +
    perToken(p.input * 2, spend.cacheWrite1hTokens)
  )
}

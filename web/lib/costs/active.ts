/**
 * The config the UI prices with right now. A tiny store so the canvas draw code (which is not a React
 * component and runs every frame) and the DOM panels read one value. Pure, no I/O.
 *
 * `null` = no custom config: the overlay keeps its built-in pricing path (unchanged from before P3).
 * Plan task P4 replaces the legacy path; until then a loaded config switches the overlay to costs/price.ts.
 */
import { fxFactor } from './price'
import { formatMoney } from './format'
import type { ResolvedConfig } from './types'

let active: ResolvedConfig | null = null
let version = 0
const listeners = new Set<() => void>()

export function getActiveCosts(): ResolvedConfig | null { return active }

/** Bumps on every `setActiveCosts` that changed the config. Cheap to compare for memo keys. */
export function activeCostsVersion(): number { return version }

export function setActiveCosts(config: ResolvedConfig | null): void {
  if (config === active) return
  active = config
  version++
  for (const l of listeners) l()
}

export function subscribeActiveCosts(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** ISO code of the display currency (USD without a config). */
export function displayCurrency(): string { return active?.currency.display ?? 'USD' }

/** USD to display currency (identity without a config or without an exchange rate). */
export function usdToDisplay(usd: number): number {
  if (!active) return usd
  const f = fxFactor(active, 'USD')
  return f === null ? usd : usd * f
}

/**
 * A display-currency amount in the pill/panel style: `$0.123`, `$0.0042`, `~€0.092`.
 * `decimals` forces a fixed count (the top bar total uses 2); default is the pill rule, or the config's `display.decimals`.
 */
export function formatDisplayMoney(amount: number, estimate = false, decimals?: number): string {
  if (!active) {
    const d = decimals ?? (amount < 0.01 ? 4 : 3)
    return `${estimate ? '~' : ''}$${amount.toFixed(d)}`
  }
  return formatMoney(amount, active.currency.display, { estimate, decimals: decimals ?? active.display.decimals })
}

/**
 * The config the UI prices with right now. A tiny store so the canvas draw code (which is not a React
 * component and runs every frame) and the DOM panels read one value. Pure, no I/O.
 *
 * `null` = no custom config (no file, or config disabled). Pricing then runs on `defaultConfig()` (the built-in
 * catalog, USD): there is ONE pricing path, costs/price.ts, with or without a file. `effectiveCosts()` is that config.
 */
import { fxFactor } from './price'
import { formatMoney } from './format'
import { defaultConfig } from './validate'
import type { ResolvedConfig } from './types'

let active: ResolvedConfig | null = null
let version = 0
let builtin: ResolvedConfig | null = null
const listeners = new Set<() => void>()

export function getActiveCosts(): ResolvedConfig | null { return active }

/** The config to price with: the loaded one, else the built-in defaults (USD, catalog prices). Never null. */
export function effectiveCosts(): ResolvedConfig {
  if (active) return active
  if (!builtin) builtin = defaultConfig()
  return builtin
}

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
export function displayCurrency(): string { return effectiveCosts().currency.display }

/** USD to display currency (identity without a config or without an exchange rate). */
export function usdToDisplay(usd: number): number {
  const f = fxFactor(effectiveCosts(), 'USD')
  return f === null ? usd : usd * f
}

/**
 * A display-currency amount in the pill/panel style: `$0.123`, `$0.0042`, `~€0.092`.
 * `decimals` forces a fixed count (the top bar total uses 2); default is the pill rule, or the config's `display.decimals`.
 */
export function formatDisplayMoney(amount: number, estimate = false, decimals?: number): string {
  const cfg = effectiveCosts()
  return formatMoney(amount, cfg.currency.display, { estimate, decimals: decimals ?? cfg.display.decimals })
}

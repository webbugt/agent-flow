/**
 * Number formatting for costs: currency, kWh, tokens, rates and limit percentages. Pure.
 * Money uses Intl.NumberFormat with a fixed 'en-US' locale so output is deterministic across hosts.
 */
import type { BillingKind } from './types'

const LOCALE = 'en-US'

function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch { return 2 }
}

function money(n: number, currency: string, min: number, max: number): string {
  try {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency, minimumFractionDigits: min, maximumFractionDigits: max }).format(n)
  } catch {
    return `${currency} ${n.toFixed(max)}`
  }
}

export interface MoneyFormatOptions {
  /** 'auto' (default) or a fixed number of decimals. */
  decimals?: 'auto' | number
  /** Prefix `~` (context-size estimate). */
  estimate?: boolean
}

/**
 * Display money. `auto` keeps the existing pill rule generalised to the currency's minor unit:
 * minor+2 decimals below 0.01 (`$0.0042`), else minor+1 (`$0.123`). Non-finite -> `?`.
 */
export function formatMoney(amount: number, currency = 'USD', opts: MoneyFormatOptions = {}): string {
  if (!Number.isFinite(amount)) return '?'
  const minor = minorDigits(currency)
  const auto = Math.abs(amount) < 0.01 ? minor + 2 : minor + 1
  const d = opts.decimals === undefined || opts.decimals === 'auto' ? auto : opts.decimals
  return `${opts.estimate ? '~' : ''}${money(amount, currency, d, d)}`
}

/** Money with up to 6 decimals and no trailing noise: `$0.001675`, `$1.50`. For formulas and tooltips. */
export function formatMoneyExact(amount: number, currency = 'USD'): string {
  if (!Number.isFinite(amount)) return '?'
  return money(amount, currency, minorDigits(currency), 6)
}

/** A per-MTok rate or multiplier: at least 2 decimals, up to 6 significant digits (`0.10`, `0.125`, `15`, `3.75`). */
export function formatRate(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const s = String(Number(n.toPrecision(6)))
  if (s.includes('e')) return s
  const [int, frac = ''] = s.split('.')
  return `${int}.${frac.padEnd(2, '0')}`
}

/** Token counts with thousands separators: `15,317`. */
export function formatTokensExact(n: number): string {
  if (!Number.isFinite(n)) return '?'
  return Math.round(n).toLocaleString(LOCALE)
}

/**
 * Energy: `0.014 kWh`. Decimals shrink with magnitude so small calls stay readable:
 * >= 1 kWh 2 decimals; >= 0.01 3; >= 0.0001 4; > 0 below that `<0.0001 kWh`; 0 `0 kWh`.
 */
export function formatKwh(kwh: number): string {
  if (!Number.isFinite(kwh) || kwh < 0) return '?'
  if (kwh === 0) return '0 kWh'
  if (kwh >= 1) return `${kwh.toFixed(2)} kWh`
  if (kwh >= 0.01) return `${kwh.toFixed(3)} kWh`
  if (kwh >= 0.0001) return `${kwh.toFixed(4)} kWh`
  return '<0.0001 kWh'
}

export type LimitKind = 'observed' | 'estimate' | 'lower-bound'

const EPS = 1e-9

/**
 * Limit percentage with per-mille for small values (PLAN v2 section 6.4). `fraction` is 0-1.
 *
 *   v = 0            -> 0%
 *   0 < v < 0.01     -> <0.1‰            (0.01% = 0.1‰)
 *   0.01 <= v < 1    -> x.y‰             (rounded 10.0‰ becomes 1.0%)
 *   1 <= v < 10      -> x.y%             (rounded 10.0% becomes 10%)
 *   10 <= v < 100    -> N%
 *   v >= 100         -> 100% observed, >=100% estimate
 *
 * The band is chosen from the ROUNDED value, so 9.99% never prints as `10.0%`.
 * Prefix: `~` estimate, `>=` lower bound (this machine's usage only), none for observed.
 */
export function formatLimitPct(fraction: number, kind: LimitKind = 'observed'): string {
  if (!Number.isFinite(fraction) || fraction < 0) return '–'
  const v = fraction * 100
  const prefix = kind === 'estimate' ? '~' : kind === 'lower-bound' ? '>=' : ''
  if (v === 0) return `${prefix}0%`
  if (v < 0.01 - EPS) return `${prefix}<0.1‰`
  if (v < 1 - EPS) {
    const m = (v * 10).toFixed(1)
    return m === '10.0' ? `${prefix}1.0%` : `${prefix}${m}‰`
  }
  if (v < 10 - EPS) {
    const p = v.toFixed(1)
    return p === '10.0' ? `${prefix}10%` : `${prefix}${p}%`
  }
  const r = Math.round(v)
  if (r >= 100) return kind === 'observed' ? '100%' : '>=100%'
  return `${prefix}${r}%`
}

/** Short label of a billing kind, as shown on pills and badges. */
export function kindLabel(kind: BillingKind): string {
  switch (kind) {
    case 'billed': return 'billed'
    case 'list-equivalent': return 'list-equiv'
    case 'estimated': return 'estimated'
    case 'unpriced': return 'unpriced'
  }
}

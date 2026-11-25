/**
 * Cost tooltip content (PLAN v2 section 6.1). A pure builder: no DOM, so it is testable as data and
 * rendered by a DOM component later (P4). Every figure states its provider and whether it is
 * billed, list-equivalent or estimated.
 */
import type { BillingKind, ResolvedConfig } from './types'
import type { PriceResult } from './price'
import { formatKwh, formatMoney, formatRate, formatTokensExact, kindLabel } from './format'
import { providerLabel } from './resolve'

export type TooltipRowId =
  | 'provider' | 'billing-kind' | 'model' | 'rate-source' | 'rate' | 'tokens' | 'formula' | 'result'
  | 'modifiers' | 'inference'
  | 'busy-time' | 'power' | 'attribution' | 'kwh-formula' | 'tariff'

export interface TooltipRow {
  id: TooltipRowId
  label: string
  value: string
  /** Filled by a later task (energy accounting lands in P5); the value says so. */
  pending?: boolean
}

export interface CostTooltip {
  title: string
  kind: BillingKind
  rows: TooltipRow[]
  footnotes: string[]
}

function host(url: string | undefined): string {
  if (!url) return ''
  const m = /^https?:\/\/([^/]+)/.exec(url)
  return m ? m[1] : url
}

function modelDisplay(r: PriceResult): string {
  const row = r.pricing.catalogRow
  if (!row || r.pricing.catalogMatch === 'fallback') return r.model ? `${r.model} (unknown model)` : 'no model reported'
  const name = row.name.replace(/^Claude /, '')
  return r.pricing.catalogMatch === 'family' ? `${r.model} (not listed; priced like ${name})` : `${r.model} (${name})`
}

function rateSourceText(r: PriceResult): string {
  const p = r.pricing
  switch (r.source) {
    case 'user-rule': return `user rule #${(p.ruleIndex ?? 0) + 1}`
    case 'user-provider': return `user provider rate (${p.provider})`
    case 'catalog': {
      const row = p.catalogRow
      return row ? `catalog ${row.section}, asOf ${row.asOf} (${host(row.source)})` : 'catalog'
    }
    case 'provider-default': {
      const row = p.catalogRow
      return row ? `provider default (${row.section} sheet, ${row.id}, asOf ${row.asOf})` : 'provider default'
    }
    case 'fallback': {
      if (p.policy === 'zero') return 'fallback (unknown model, policy zero)'
      if (p.policy === 'global-rate' || (p.catalogRow === null && p.rate)) return 'fallback (unknown model, user global rate)'
      return `fallback (unknown model, priced like ${p.catalogRow?.id ?? 'the default model'})`
    }
    case 'none': return r.pricing.billing === 'local' ? 'no money rate (local model)' : 'none (no rate configured)'
  }
}

function kindText(r: PriceResult): string {
  const p = r.pricing
  switch (r.kind) {
    case 'billed':
      return p.billing === 'free' ? 'billed: free provider, $0' : 'billed: reported API usage x configured rate'
    case 'list-equivalent':
      return p.billing === 'credits'
        ? 'list-equivalent: AI-credits plan; allowance not subtracted; 1 credit = $0.01'
        : 'list-equivalent: subscription plan; value at list price, not what you were charged'
    case 'unpriced': return 'unpriced: no rate configured for this model'
    case 'estimated':
      if (p.billing === 'local') return 'estimated: configured power, not measured'
      if (!r.hadReportedUsage) return 'estimated: no usage reported, context size at a blended rate'
      if (r.source === 'fallback') return 'estimated: model not in the catalog, guessed rate'
      return 'estimated: billing mode of this provider is not configured'
  }
}

function tierText(r: PriceResult): string {
  const p = r.pricing
  if (p.tierCount < 2) return ''
  const bound = p.tierMaxPromptTokens
  if (bound !== null) return ` (tier <=${Math.round(bound / 1000)}K)`
  const prev = p.tierIndex > 0 ? (p.catalogRow?.tiers[p.tierIndex - 1]?.maxPromptTokens ?? null) : null
  return prev !== null ? ` (tier >${Math.round(prev / 1000)}K)` : ' (top tier)'
}

function rateText(r: PriceResult): string {
  const rate = r.pricing.rate
  if (!rate) return 'n/a'
  const w5 = rate.cacheWrite5m ?? rate.input
  const w1 = rate.cacheWrite1h ?? w5
  const write = w1 === w5 ? `cache-write ${formatRate(w5)}` : `cache-write 5m ${formatRate(w5)} · 1h ${formatRate(w1)}`
  return `in ${formatRate(rate.input)} · out ${formatRate(rate.output)} · cache-read ${formatRate(rate.cacheRead)} · ${write}${tierText(r)} per MTok ${r.pricing.currency}`
}

function tokensText(r: PriceResult): string {
  if (r.usage) {
    const u = r.usage
    return `in ${formatTokensExact(u.inputTokens)} · out ${formatTokensExact(u.outputTokens)} · cr ${formatTokensExact(u.cacheReadTokens)} · cw5 ${formatTokensExact(u.cacheWrite5mTokens)} · cw1 ${formatTokensExact(u.cacheWrite1hTokens)}`
  }
  return r.tokensUsed !== null ? `${formatTokensExact(r.tokensUsed)} tokens (context size; no usage reported)` : 'none'
}

function inferenceText(r: PriceResult): string[] {
  const p = r.pricing
  const out: string[] = []
  if (r.inferredCacheWriteTokens > 0) out.push(`includes inferred cache-write on ${formatTokensExact(r.inferredCacheWriteTokens)} tokens`)
  if (r.source === 'fallback') out.push('model not in the catalog: fallback rate')
  if (r.source === 'provider-default') out.push(`model not in the catalog: priced at the provider default ${p.catalogRow?.id ?? ''}`.trim())
  if (p.catalogMatch === 'family') out.push('model not listed: priced like the newest model of its family')
  if (!r.hadReportedUsage && p.billing !== 'local') out.push('no usage reported: context-size estimate')
  if (p.promoExpiredNoRate) out.push('promotional price ended; the vendor has not published the later price')
  if (p.afterPromo) out.push('post-promotion price applied')
  if (p.catalogRow?.unverified?.length) out.push(`unverified in catalog: ${p.catalogRow.unverified.join(', ')}`)
  return out
}

const FOOTNOTES: Record<BillingKind, string> = {
  billed: 'computed from reported usage x configured rate; verify against your invoice',
  'list-equivalent': 'value at list price; not what you were charged',
  estimated: 'no reported usage / configured power / fallback rate; order-of-magnitude only',
  unpriced: 'no rate configured; excluded from totals',
}

/** Build the tooltip rows for one priced figure. All rows of PLAN v2 6.1 are present, in order. */
export function buildCostTooltip(r: PriceResult, config: ResolvedConfig): CostTooltip {
  const p = r.pricing
  const label = providerLabel(r.provider)
  const rows: TooltipRow[] = [
    { id: 'provider', label: 'Provider', value: label === r.provider ? r.provider : `${r.provider} (${label})` },
    { id: 'billing-kind', label: 'Billing kind', value: kindText(r) },
    { id: 'model', label: 'Model', value: modelDisplay(r) },
    { id: 'rate-source', label: 'Rate source', value: p.billing === 'local' && p.energyProfile ? `energy profile "${p.energyProfile}" (configured power)` : rateSourceText(r) },
  ]

  if (p.billing === 'local') {
    const prof = p.energyProfile !== null && Object.hasOwn(config.energy.profiles, p.energyProfile) ? config.energy.profiles[p.energyProfile] : null
    const pending = 'not computed yet (energy accounting lands in task P5)'
    rows.push(
      { id: 'busy-time', label: 'Busy time', value: `${pending}; source: call latency, else configured throughput`, pending: true },
      { id: 'power', label: 'Power', value: prof ? `P_load ${prof.powerW.load} W · P_idle ${prof.powerW.idle} W` : 'no energy profile set for this provider or model' },
      { id: 'attribution', label: 'Attribution', value: prof ? `${prof.attribution} · pue ${formatRate(prof.pue)}` : 'n/a' },
      { id: 'tokens', label: 'Tokens', value: tokensText(r) },
      { id: 'kwh-formula', label: 'kWh formula', value: `kWh = (P_attr x pue x busy seconds) / 3.6e6; ${pending}`, pending: true },
      { id: 'tariff', label: 'Tariff window', value: config.energy.tariff ? `${config.energy.tariff.currency} ${formatRate(config.energy.tariff.flatPerKWh)} per kWh flat${config.energy.tariff.timeOfDay.length ? ' + time-of-day windows' : ''}` : 'no tariff configured', pending: true },
      { id: 'result', label: 'Result', value: `${formatKwh(0)} so far (${pending})`, pending: true },
    )
  } else {
    rows.push(
      { id: 'rate', label: 'Rate used', value: rateText(r) },
      { id: 'tokens', label: 'Tokens', value: tokensText(r) },
      { id: 'formula', label: 'Formula', value: r.formula },
      { id: 'result', label: 'Result', value: r.kind === 'unpriced' ? '? (excluded from totals)' : formatMoney(r.amount, r.currency, { estimate: r.kind === 'estimated', decimals: config.display.decimals }) },
    )
  }

  const mods: string[] = []
  if (r.multiplier !== 1) mods.push(`x${formatRate(r.multiplier)}`)
  if (r.fx) mods.push(`FX ${r.fx.from}->${r.fx.to} ${formatRate(r.fx.factor)} (${r.fx.asOf ?? 'undated'}, manual)`)
  if (mods.length) rows.push({ id: 'modifiers', label: 'Modifiers', value: mods.join(' · ') })
  const inf = inferenceText(r)
  if (inf.length) rows.push({ id: 'inference', label: 'Notes', value: inf.join('; ') })

  const footnotes = [FOOTNOTES[r.kind]]
  if (p.billing === 'local') footnotes[0] = 'estimated from configured power, not measured'
  if (r.provider === 'copilot') footnotes.push('Copilot code review and completions are not included')
  if (r.hidden) footnotes.push('hidden from totals (display.subscriptionValue = hide)')

  return { title: `${r.model || 'no model'} · ${kindLabel(r.kind)}`, kind: r.kind, rows, footnotes }
}

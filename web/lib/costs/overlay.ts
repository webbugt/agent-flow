/**
 * Cost overlay label builders (PLAN v2 section 7.1): everything the canvas and the DOM controls SHOW, as
 * strings and numbers. The canvas code (canvas/draw-cost.ts) only paints what these functions return, so the
 * wording, units, billing badges and totals are testable without a canvas. Pure, no I/O.
 *
 * Pill text per kind:  `~$0.012` estimated · `$0.012` billed · `$0.012 sub` list-equivalent (badge `list-equiv`)
 *                      `– kWh` local model · `?` unpriced · `5.3k tok` in the tokens unit.
 * A figure is never summed across kinds: the summary and the top bar split totals by kind.
 */
import type { AgentCost } from './agent-cost'
import { priceUsage, type PriceResult } from './price'
import { buildCostTooltip, type CostTooltip, type TooltipRow } from './tooltip'
import { currencySymbol, formatMoney, formatMoneyExact, formatTokensCompact, formatTokensExact } from './format'
import type { BillingKind, DisplayUnit, ResolvedConfig } from './types'

// ── units ───────────────────────────────────────────────────────────────────

/** What the overlay shows. `display.unit = auto` means money. */
export type OverlayUnit = 'money' | 'kwh' | 'tokens'
export const OVERLAY_UNITS: readonly OverlayUnit[] = ['money', 'kwh', 'tokens']

export function resolveUnit(cfg: ResolvedConfig, override: OverlayUnit | null): OverlayUnit {
  if (override) return override
  const u: DisplayUnit = cfg.display.unit
  return u === 'auto' ? 'money' : u
}

/** The header toggle cycles money -> kWh -> tokens -> money. */
export function nextUnit(u: OverlayUnit): OverlayUnit {
  return OVERLAY_UNITS[(OVERLAY_UNITS.indexOf(u) + 1) % OVERLAY_UNITS.length]
}

export function unitName(u: OverlayUnit): string {
  return u === 'kwh' ? 'kWh' : u
}

/** Text of the header toggle: `$Cost`, `€Cost`, `kWh Cost`, `tok Cost`. */
export function costToggleLabel(unit: OverlayUnit, cfg: ResolvedConfig): string {
  if (unit === 'kwh') return 'kWh Cost'
  if (unit === 'tokens') return 'tok Cost'
  return `${currencySymbol(cfg.currency.display)}Cost`
}

// ── what an agent's figure is ───────────────────────────────────────────────

/** The look of a figure: a billing kind, or `local` (electricity, not money) or `hidden` (display.subscriptionValue = hide). */
export type Flavor = BillingKind | 'local' | 'hidden'

export function flavorOf(c: AgentCost): Flavor {
  if (c.results.length > 0 && c.results[0].pricing.billing === 'local') return 'local'
  if (c.results.length > 0 && c.results.every(r => r.hidden)) return 'hidden'
  if (c.results.length > 0 && c.results.every(r => r.kind === 'unpriced')) return 'unpriced'
  return c.kind
}

/** Badge text per flavor. */
export const BADGE_LABEL: Readonly<Record<Flavor, string>> = {
  billed: 'billed', 'list-equivalent': 'list-equiv', estimated: 'est', unpriced: 'unpriced', local: 'est', hidden: 'hidden',
}

/** Word for totals and tooltips. */
export const FLAVOR_WORD: Readonly<Record<Flavor, string>> = {
  billed: 'billed', 'list-equivalent': 'list-equiv', estimated: 'estimated', unpriced: 'unpriced', local: 'local (est.)', hidden: 'hidden',
}

/** One colour per flavor, shared by the canvas pills, the panel and the DOM tooltip. */
export const FLAVOR_COLOR: Readonly<Record<Flavor, string>> = {
  billed: '#66ffaa', 'list-equivalent': '#ffcc66', estimated: '#66ccff', unpriced: '#ff9966', local: '#c9a0ff', hidden: '#8899aa',
}

const KWH_PENDING = '– kWh'

function moneyText(cfg: ResolvedConfig, amount: number, estimate: boolean): string {
  return formatMoney(amount, cfg.currency.display, { estimate, decimals: cfg.display.decimals })
}

/** The figure of one agent in money, in pill style (no badge): `~$0.012`, `$0.012`, `$0.012 sub`, `?`. */
export function moneyFigure(cost: AgentCost, cfg: ResolvedConfig): string {
  const f = flavorOf(cost)
  if (f === 'unpriced') return '?'
  if (f === 'estimated') return moneyText(cfg, cost.amount, true)
  if (f === 'list-equivalent') return `${moneyText(cfg, cost.amount, false)} sub`
  return moneyText(cfg, cost.amount, false)
}

export interface PillLabel {
  text: string
  /** Small chip next to the text, or null. */
  badge: string | null
  flavor: Flavor
}

/** Below this the money pill is not drawn (as before P4). In display currency, so it is a rough threshold. */
export const MIN_DISPLAY_COST = 0.0001

/**
 * The cost pill of one agent in `unit`, or null when nothing should be drawn (no cost yet, or the unit does
 * not apply: kWh is for local models only).
 */
export function buildPillLabel(cost: AgentCost, tokensUsed: number, unit: OverlayUnit, cfg: ResolvedConfig): PillLabel | null {
  const flavor = flavorOf(cost)
  if (unit === 'kwh') return flavor === 'local' ? { text: KWH_PENDING, badge: BADGE_LABEL.local, flavor } : null
  if (flavor === 'local') return { text: KWH_PENDING, badge: BADGE_LABEL.local, flavor }
  if (unit === 'tokens' || flavor === 'hidden') {
    if (tokensUsed <= 0) return null
    return { text: `${formatTokensCompact(tokensUsed)} tok`, badge: flavor === 'hidden' ? BADGE_LABEL.hidden : null, flavor }
  }
  if (flavor === 'unpriced') return { text: '?', badge: BADGE_LABEL.unpriced, flavor }
  if (cost.amount < MIN_DISPLAY_COST) return null
  return { text: moneyFigure(cost, cfg), badge: BADGE_LABEL[flavor], flavor }
}

// ── hit test ────────────────────────────────────────────────────────────────

export interface CostPillRect { id: string; x: number; y: number; w: number; h: number }

/** The agent whose pill contains (x, y) in canvas space; the last drawn (topmost) wins. `slop` widens the target for touch. */
export function findCostPillAt(x: number, y: number, rects: readonly CostPillRect[], slop = 3): string | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    if (x >= r.x - slop && x <= r.x + r.w + slop && y >= r.y - slop && y <= r.y + r.h + slop) return r.id
  }
  return null
}

// ── summary panel ───────────────────────────────────────────────────────────

export interface SummaryItem { name: string; cost: AgentCost; tokens: number }
export interface SummaryLine { flavor: Flavor | 'neutral'; text: string; label: string }
export interface SummaryRow { name: string; text: string; flavor: Flavor; ratio: number }

export interface CostSummary {
  unit: OverlayUnit
  /** Totals, one line per kind present. Never one number across kinds. */
  lines: SummaryLine[]
  /** `12k tokens`; empty in the tokens unit, whose total is the headline. */
  tokensText: string
  rows: SummaryRow[]
  notes: string[]
}

const KIND_ORDER: readonly BillingKind[] = ['billed', 'list-equivalent', 'estimated']

/** Money of an agent by result kind (hidden results excluded), for per-kind totals. */
function amountsByKind(c: AgentCost): Partial<Record<BillingKind, number>> {
  const out: Partial<Record<BillingKind, number>> = {}
  for (const r of c.results) {
    if (r.hidden || r.kind === 'unpriced') continue
    out[r.kind] = (out[r.kind] ?? 0) + r.amount
  }
  return out
}

export function buildCostSummary(items: readonly SummaryItem[], unit: OverlayUnit, cfg: ResolvedConfig): CostSummary {
  const flavors = items.map(i => flavorOf(i.cost))
  const totalTokens = items.reduce((s, i) => s + i.tokens, 0)
  const count = (f: Flavor) => flavors.filter(x => x === f).length
  const notes: string[] = []
  const lines: SummaryLine[] = []

  const money: Record<BillingKind, number> = { billed: 0, 'list-equivalent': 0, estimated: 0, unpriced: 0 }
  items.forEach((it, i) => {
    if (flavors[i] === 'local') return
    const a = amountsByKind(it.cost)
    for (const k of KIND_ORDER) money[k] += a[k] ?? 0
  })

  if (unit === 'tokens') {
    lines.push({ flavor: 'neutral', text: formatTokensCompact(totalTokens), label: 'tokens' })
  } else if (unit === 'kwh') {
    if (count('local') > 0) lines.push({ flavor: 'local', text: KWH_PENDING, label: FLAVOR_WORD.local })
    else notes.push('kWh applies to local models only; none in this session')
  } else {
    // list-equivalent agents that are hidden contribute nothing; billed/estimated/list-equivalent each get a line when present
    const present: Record<BillingKind, boolean> = {
      billed: items.some((_, i) => flavors[i] === 'billed'),
      'list-equivalent': items.some((_, i) => flavors[i] === 'list-equivalent'),
      estimated: items.some((_, i) => flavors[i] === 'estimated'),
      unpriced: false,
    }
    if (present.billed) lines.push({ flavor: 'billed', text: moneyText(cfg, money.billed, false), label: FLAVOR_WORD.billed })
    if (present['list-equivalent']) lines.push({ flavor: 'list-equivalent', text: `${moneyText(cfg, money['list-equivalent'], false)} sub`, label: FLAVOR_WORD['list-equivalent'] })
    if (present.estimated) lines.push({ flavor: 'estimated', text: moneyText(cfg, money.estimated, true), label: FLAVOR_WORD.estimated })
    if (count('local') > 0) lines.push({ flavor: 'local', text: KWH_PENDING, label: FLAVOR_WORD.local })
  }

  const hidden = count('hidden')
  if (hidden > 0) notes.push(`${hidden} subscription agent${hidden === 1 ? '' : 's'} hidden`)
  const unpriced = count('unpriced')
  if (unpriced > 0) notes.push(`${unpriced} agent${unpriced === 1 ? '' : 's'} unpriced (no rate configured)`)

  // Rows: one per agent in the current unit, biggest first.
  const rows: SummaryRow[] = []
  items.forEach((it, i) => {
    const f = flavors[i]
    if (unit === 'kwh') { if (f === 'local') rows.push({ name: it.name, text: KWH_PENDING, flavor: f, ratio: 0 }); return }
    if (unit === 'tokens' || f === 'hidden') { rows.push({ name: it.name, text: `${formatTokensCompact(it.tokens)} tok`, flavor: f, ratio: it.tokens }); return }
    if (f === 'local') { rows.push({ name: it.name, text: KWH_PENDING, flavor: f, ratio: 0 }); return }
    rows.push({ name: it.name, text: moneyFigure(it.cost, cfg), flavor: f, ratio: it.cost.amount })
  })
  rows.sort((a, b) => b.ratio - a.ratio)
  const max = rows.reduce((m, r) => Math.max(m, r.ratio), 0)
  for (const r of rows) r.ratio = max > 0 ? r.ratio / max : 0

  return { unit, lines, tokensText: unit === 'tokens' ? '' : `${formatTokensCompact(totalTokens)} tokens`, rows, notes }
}

// ── tool breakdown ──────────────────────────────────────────────────────────

export interface ToolTokens { agentId: string; toolName: string; tokens: number }
export interface ToolRow { name: string; tokens: number; amount: number; text: string }

/**
 * Display-currency price of one million context tokens of this agent at the blended rate of ITS model and
 * provider under the active config (so a custom rate, FX or multiplier applies). 0 for hidden, local or unpriced.
 */
export function blendedPerMillion(cfg: ResolvedConfig, agent: { spend?: { model?: string; provider?: string } | undefined; model?: string; runtime?: string }): number {
  const r = priceUsage(cfg, { provider: agent.spend?.provider, runtime: agent.runtime, model: agent.spend?.model ?? agent.model, tokensUsed: 1_000_000 })
  return r.hidden || r.kind === 'unpriced' || r.billing === 'local' ? 0 : r.amount
}

/**
 * Per-tool-type totals for the panel. Tool tokens are context tokens (no usage report), so money is always an
 * estimate (`~`). `perMillion(agentId)` is the owning agent's blended price per 1M tokens. kWh: no rows.
 */
export function buildToolBreakdown(tools: readonly ToolTokens[], perMillion: (agentId: string) => number, unit: OverlayUnit, cfg: ResolvedConfig): ToolRow[] {
  if (unit === 'kwh') return []
  const byName = new Map<string, { tokens: number; amount: number }>()
  for (const t of tools) {
    const e = byName.get(t.toolName) ?? { tokens: 0, amount: 0 }
    e.tokens += t.tokens
    e.amount += (t.tokens / 1_000_000) * perMillion(t.agentId)
    byName.set(t.toolName, e)
  }
  const rows = [...byName.entries()].map(([name, e]): ToolRow => ({
    name, tokens: e.tokens, amount: e.amount,
    text: unit === 'tokens' ? `${formatTokensCompact(e.tokens)} tok` : moneyText(cfg, e.amount, true),
  }))
  rows.sort((a, b) => (unit === 'tokens' ? b.tokens - a.tokens : b.amount - a.amount))
  return rows
}

// ── top bar ─────────────────────────────────────────────────────────────────

/** The cost part of the top bar: per-kind figures in pill style, joined by ` · `; empty when there is nothing to say. */
export function buildTopBarCost(items: readonly SummaryItem[], unit: OverlayUnit, cfg: ResolvedConfig): string {
  const s = buildCostSummary(items, unit, cfg)
  if (unit === 'tokens') return ''
  return s.lines.map(l => l.text).join(' · ')
}

// ── config sources ──────────────────────────────────────────────────────────

export interface SourceInfo { id: 'settings' | 'user' | 'project'; path: string | null; status: 'ok' | 'missing' | 'error'; inUse: boolean }

/** Which config files the prices come from, and whether a project file overrides the user's. */
export function describeSources(sources: readonly SourceInfo[]): { text: string; projectOverrides: boolean; files: string[] } {
  const files = sources.filter(s => s.id !== 'settings' && s.status !== 'missing' && s.path !== null).map(s => `${s.id} ${s.path}`)
  const user = sources.find(s => s.id === 'user')
  const project = sources.find(s => s.id === 'project')
  const projectOverrides = !!project && project.status !== 'missing' && project.inUse
  if (files.length === 0) return { text: 'built-in prices (no costs.json)', projectOverrides: false, files }
  const parts: string[] = []
  if (user && user.status !== 'missing') parts.push(`user ${user.path}`)
  if (project && project.status !== 'missing') parts.push(`project ${project.path}${projectOverrides && user && user.status !== 'missing' ? ' (overrides user)' : ''}`)
  return { text: parts.join(' · '), projectOverrides, files }
}

// ── tooltip for an agent (all its price buckets) ────────────────────────────

function sumUsage(rs: readonly PriceResult[]): string {
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }
  for (const r of rs) {
    if (!r.usage) continue
    t.inputTokens += r.usage.inputTokens; t.outputTokens += r.usage.outputTokens; t.cacheReadTokens += r.usage.cacheReadTokens
    t.cacheWrite5mTokens += r.usage.cacheWrite5mTokens; t.cacheWrite1hTokens += r.usage.cacheWrite1hTokens
  }
  return `in ${formatTokensExact(t.inputTokens)} · out ${formatTokensExact(t.outputTokens)} · cr ${formatTokensExact(t.cacheReadTokens)} · cw5 ${formatTokensExact(t.cacheWrite5mTokens)} · cw1 ${formatTokensExact(t.cacheWrite1hTokens)}`
}

/**
 * Tooltip of an agent (PLAN v2 6.1). One priced bucket: exactly `buildCostTooltip`. Several prompt-size buckets
 * (tiered models): the same rows, with tokens summed, one formula line per bucket and the summed result.
 */
export function buildAgentTooltip(cost: AgentCost, cfg: ResolvedConfig): CostTooltip {
  const first = buildCostTooltip(cost.results[0], cfg)
  if (cost.results.length < 2) return first
  const total = cost.results.reduce((s, r) => s + (r.hidden || r.kind === 'unpriced' ? 0 : r.amount), 0)
  const estimate = flavorOf(cost) === 'estimated'
  const rows: TooltipRow[] = first.rows.map(row => {
    switch (row.id) {
      case 'rate': return { ...row, value: 'varies with the prompt size of each request (one line per tier under Formula)' }
      case 'tokens': return { ...row, value: sumUsage(cost.results) }
      case 'formula': return { ...row, value: cost.results.map(r => r.formula).join('\n+ ') }
      case 'result': return { ...row, value: `${formatMoney(total, cfg.currency.display, { estimate, decimals: cfg.display.decimals })} (${formatMoneyExact(total, cfg.currency.display)})` }
      default: return row
    }
  })
  return { ...first, rows, footnotes: [...first.footnotes, `${cost.results.length} prompt-size tiers priced separately`] }
}

/** Plain text of a tooltip, one `Label: value` per row, then the footnotes. For tests and clipboard. */
export function tooltipPlainText(t: CostTooltip): string {
  return [t.title, ...t.rows.map(r => `${r.label}: ${r.value}`), ...t.footnotes].join('\n')
}

// ── geometry (pure: the caller passes the text measurer) ────────────────────

export interface PillGeometry { w: number; h: number; textW: number; badgeW: number }

export const PILL_FONT = 'bold 9px monospace'
export const BADGE_FONT = '7px monospace'
const PILL_PADDING = 12
const PILL_HEIGHT = 16
const BADGE_GAP = 4
const BADGE_PAD = 5

/** Width of a pill: the figure, then (when there is one) a small badge chip, plus the padding. */
export function pillGeometry(label: PillLabel, measure: (text: string, font: string) => number): PillGeometry {
  const textW = measure(label.text, PILL_FONT)
  const badgeW = label.badge ? measure(label.badge, BADGE_FONT) + BADGE_PAD * 2 : 0
  return { w: textW + (badgeW ? BADGE_GAP + badgeW : 0) + PILL_PADDING, h: PILL_HEIGHT, textW, badgeW }
}

export interface PanelPlacement { x: number; y: number; maxRows: number; compact: boolean }

/** Narrow screens (phone): the panel sits bottom-right above the control bar instead of under the wrapped top bar. */
export const NARROW_CANVAS_PX = 640

export function placeSummaryPanel(canvasW: number, canvasH: number, panelW: number, panelH: number, xMargin: number, yStart: number): PanelPlacement {
  const x = canvasW - panelW - xMargin
  if (canvasW >= NARROW_CANVAS_PX) return { x, y: yStart, maxRows: 5, compact: false }
  const bottomReserve = 92 // the control bar and its margin
  return { x, y: Math.max(yStart, canvasH - panelH - bottomReserve), maxRows: 3, compact: true }
}

import { Agent, ToolCallNode, NODE } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { COST_DRAW, COST_PANEL, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { effectiveCosts } from '@/lib/costs/active'
import { priceAgent, type AgentCost } from '@/lib/costs/agent-cost'
import {
  BADGE_FONT, FLAVOR_COLOR, PILL_FONT, blendedPerMillion, buildCostSummary, buildPillLabel, buildToolBreakdown,
  NARROW_CANVAS_PX, pillGeometry, placeSummaryPanel,
  type CostPillRect, type OverlayUnit, type PillLabel, type SummaryItem,
} from '@/lib/costs/overlay'
import { getOverlayUnit, setCostPillRects } from '@/lib/cost-overlay-store'
import { truncateText } from './draw-misc'

/**
 * Cost of one agent under the active config (the loaded costs.json, else the built-in catalog). The ONE pricing
 * path of the overlay: every figure, pill, panel row and tooltip comes from costs/price.ts through this.
 */
export function agentCostOf(agent: Agent): AgentCost {
  return priceAgent(effectiveCosts(), agent)
}

/**
 * Amount in the DISPLAY currency and whether it is an estimate (kind `estimated`). Used by the top bar total
 * and the session panel, which format it themselves.
 */
export function agentSpend(agent: Agent): { amount: number; estimate: boolean } {
  const c = agentCostOf(agent)
  return { amount: c.amount, estimate: c.kind === 'estimated' }
}

/** Tool name -> color for mini cost bar */
export function toolTypeColor(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('read') || n.includes('glob') || n.includes('grep')) return COLORS.contextUser
  if (n.includes('edit') || n.includes('write')) return COLORS.contextReasoning
  if (n.includes('bash')) return COLORS.tool
  return COLORS.contextSubagent
}

/** Pre-group tool calls by agentId to avoid O(agents * toolCalls) per frame */
function groupToolsByAgent(toolCalls: Map<string, ToolCallNode>): Map<string, ToolCallNode[]> {
  const grouped = new Map<string, ToolCallNode[]>()
  for (const tc of toolCalls.values()) {
    if (!tc.tokenCost) continue
    let list = grouped.get(tc.agentId)
    if (!list) { list = []; grouped.set(tc.agentId, list) }
    list.push(tc)
  }
  return grouped
}

function pillLabelOf(agent: Agent, unit: OverlayUnit): PillLabel | null {
  return buildPillLabel(agentCostOf(agent), agent.tokensUsed, unit, effectiveCosts())
}

/** The text of an agent's cost pill (without drawing it): figure and badge, e.g. `$0.012 sub list-equiv`. */
export function costPillLabel(agent: Agent): string | null {
  const l = pillLabelOf(agent, getOverlayUnit())
  return l === null ? null : l.badge ? `${l.text} ${l.badge}` : l.text
}

function measureWith(ctx: CanvasRenderingContext2D): (text: string, font: string) => number {
  return (text, font) => {
    ctx.save()
    ctx.font = font
    const w = ctx.measureText(text).width
    ctx.restore()
    return w
  }
}

function pillRectOf(ctx: CanvasRenderingContext2D, agent: Agent, label: PillLabel): CostPillRect {
  const g = pillGeometry(label, measureWith(ctx))
  const r = agent.isMain ? NODE.radiusMain : NODE.radiusSub
  return { id: agent.id, x: agent.x - g.w / 2, y: agent.y - r - COST_DRAW.pillYOffset, w: g.w, h: g.h }
}

/**
 * Canvas-space rectangle of an agent's cost pill, the same geometry drawCostLabels uses.
 * Used by the screenshot harness (lib/shot-mode.ts) to hover a pill; null when the agent has no pill.
 */
export function costPillRect(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
): { x: number; y: number; w: number; h: number } | null {
  if (agent.opacity < MIN_VISIBLE_OPACITY) return null
  const label = pillLabelOf(agent, getOverlayUnit())
  if (label === null) return null
  const { x, y, w, h } = pillRectOf(ctx, agent, label)
  return { x, y, w, h }
}

export function drawCostLabels(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
) {
  const toolsByAgent = groupToolsByAgent(toolCalls)
  const unit = getOverlayUnit()
  const rects: CostPillRect[] = []

  for (const [, agent] of agents) {
    if (agent.opacity < MIN_VISIBLE_OPACITY) continue
    const label = pillLabelOf(agent, unit)
    if (label === null) continue

    const rect = pillRectOf(ctx, agent, label)
    rects.push(rect)
    const color = FLAVOR_COLOR[label.flavor]
    const pillX = rect.x, pillY = rect.y, pillW = rect.w, pillH = rect.h

    ctx.save()
    ctx.globalAlpha = agent.opacity * 0.9

    // Pill background; the stroke carries the flavor colour (list-equiv amber, billed green, ...)
    ctx.fillStyle = COLORS.costPillBg
    ctx.strokeStyle = label.flavor === 'billed' ? COLORS.costPillStroke : color + '66'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(pillX, pillY, pillW, pillH, COST_DRAW.pillRadius)
    ctx.fill()
    ctx.stroke()

    // Figure (left part), badge chip (right part)
    const g = pillGeometry(label, measureWith(ctx))
    const innerX = pillX + (COST_DRAW.pillPadding / 2)
    ctx.font = PILL_FONT
    ctx.fillStyle = label.flavor === 'unpriced' || label.flavor === 'hidden' ? color : COLORS.costText
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label.text, innerX, pillY + pillH / 2)

    if (label.badge) {
      const bx = innerX + g.textW + 4
      const bw = g.badgeW
      ctx.fillStyle = color + '26'
      ctx.beginPath()
      ctx.roundRect(bx, pillY + 3, bw, pillH - 6, 3)
      ctx.fill()
      ctx.font = BADGE_FONT
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.fillText(label.badge, bx + bw / 2, pillY + pillH / 2 + 0.5)
    }

    // Mini tool-type cost bar below the pill
    const agentTools = toolsByAgent.get(agent.id)
    if (agentTools && agentTools.length > 0) {
      const byType = new Map<string, number>()
      let totalToolTokens = 0
      for (const tc of agentTools) {
        const tokens = tc.tokenCost || 0
        byType.set(tc.toolName, (byType.get(tc.toolName) || 0) + tokens)
        totalToolTokens += tokens
      }
      if (totalToolTokens > 0) {
        const barW = Math.min(pillW + COST_DRAW.miniBarMaxExtra, COST_DRAW.miniBarMax)
        const barH = COST_DRAW.miniBarHeight
        const barX = agent.x - barW / 2
        const barY = pillY + pillH + COST_DRAW.miniBarGap

        ctx.fillStyle = COLORS.holoBorder06
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, COST_DRAW.miniBarRadius)
        ctx.fill()

        let segX = barX
        for (const [toolName, tokens] of byType) {
          const segW = (tokens / totalToolTokens) * barW
          if (segW < 1) continue
          ctx.fillStyle = toolTypeColor(toolName)
          ctx.globalAlpha = agent.opacity * 0.7
          ctx.beginPath()
          ctx.roundRect(segX, barY, segW, barH, COST_DRAW.miniBarRadius)
          ctx.fill()
          segX += segW
        }
      }
    }

    ctx.restore()
  }

  // The pointer code reads these (world coordinates) to find the pill under the cursor.
  setCostPillRects(rects)
}

export function drawCostSummaryPanel(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
) {
  const agentList = Array.from(agents.values()).filter(a => a.tokensUsed > 0 || a.spend)
  if (agentList.length === 0) return

  const cfg = effectiveCosts()
  const unit = getOverlayUnit()
  const items: SummaryItem[] = agentList.map(a => ({ name: a.name, cost: agentCostOf(a), tokens: a.tokensUsed }))
  const summary = buildCostSummary(items, unit, cfg)

  // Per-tool breakdown at the owning agent's own model, provider and the active config
  const perMillion = new Map<string, number>()
  const rateOf = (id: string): number => {
    let r = perMillion.get(id)
    if (r === undefined) { const a = agents.get(id); r = a ? blendedPerMillion(cfg, a) : 0; perMillion.set(id, r) }
    return r
  }
  const toolTokens: { agentId: string; toolName: string; tokens: number }[] = []
  for (const tc of toolCalls.values()) if (tc.tokenCost) toolTokens.push({ agentId: tc.agentId, toolName: tc.toolName, tokens: tc.tokenCost })
  const toolList = buildToolBreakdown(toolTokens, rateOf, unit, cfg)
  const toolMax = toolList.reduce((m, t) => Math.max(m, unit === 'tokens' ? t.tokens : t.amount), 0)

  const dpr = ctx.canvas.width / ctx.canvas.offsetWidth
  const canvasW = ctx.canvas.width / dpr
  const canvasH = ctx.canvas.height / dpr
  const compact = canvasW < NARROW_CANVAS_PX
  const maxRows = compact ? 3 : COST_PANEL.maxRows
  const panelW = COST_PANEL.width
  const lineH = COST_PANEL.lineHeight
  const pad = COST_PANEL.contentPadding
  const agentRows = Math.min(summary.rows.length, maxRows)
  const toolRows = Math.min(toolList.length, maxRows)
  const noteLines = summary.notes.length

  const headLines = Math.max(1, summary.lines.length)
  const headerH = 10 + headLines * 14 + (summary.tokensText ? 12 : 0) + 4
  const panelH = headerH + (agentRows * lineH) + COST_PANEL.sectionGap + (toolRows > 0 ? 14 + toolRows * lineH : 0) + (noteLines > 0 ? 4 + noteLines * 11 : 0) + 12
  const place = placeSummaryPanel(canvasW, canvasH, panelW, panelH, COST_PANEL.xMargin, COST_PANEL.yStart)
  const panelX = place.x
  const panelY = place.y

  ctx.save()

  ctx.fillStyle = COLORS.panelBg
  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(panelX, panelY, panelW, panelH, COST_PANEL.borderRadius)
  ctx.fill()
  ctx.stroke()

  let y = panelY + 8

  // Header: one line per billing kind (never one number across kinds)
  ctx.textBaseline = 'top'
  summary.lines.forEach((l, i) => {
    const color = l.flavor === 'neutral' ? COLORS.costText : FLAVOR_COLOR[l.flavor]
    ctx.font = i === 0 ? 'bold 11px monospace' : 'bold 10px monospace'
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(l.text, panelX + pad, y)
    const tw = ctx.measureText(l.text).width
    ctx.font = '8px monospace'
    ctx.fillStyle = color + 'b0'
    ctx.fillText(l.label, panelX + pad + tw + 8, y + 2)
    y += 14
  })
  if (summary.lines.length === 0) {
    ctx.font = '9px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.fillText('no cost in this unit', panelX + pad, y)
    y += 14
  }
  if (summary.tokensText) {
    ctx.font = '9px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.fillText(summary.tokensText, panelX + pad, y)
    y += 12
  }
  y += 4

  // Per-agent breakdown
  const barW = panelW - pad * 2
  for (let i = 0; i < agentRows; i++) {
    const a = summary.rows[i]

    ctx.fillStyle = COLORS.holoBorder06
    ctx.beginPath()
    ctx.roundRect(panelX + pad, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    ctx.fillStyle = a.name.includes('main') || summary.rows.length === 1 ? COLORS.barFillMain : COLORS.barFillSub
    ctx.beginPath()
    ctx.roundRect(panelX + pad, y + 1, barW * a.ratio, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    ctx.font = '8px monospace'
    ctx.fillStyle = COLORS.textPrimary
    ctx.textAlign = 'left'
    ctx.fillText(truncateText(ctx, a.name, barW - 58), panelX + pad + COST_PANEL.barInset, y + 3)

    ctx.textAlign = 'right'
    ctx.fillStyle = FLAVOR_COLOR[a.flavor]
    ctx.fillText(a.text, panelX + pad + barW - COST_PANEL.barInset, y + 3)

    y += lineH
  }

  // Per-tool-type breakdown
  if (toolRows > 0) {
    y += COST_PANEL.sectionGap

    ctx.font = '8px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.fillText('BY TOOL', panelX + pad, y)
    y += 14

    for (let i = 0; i < toolRows; i++) {
      const t = toolList[i]
      const ratio = toolMax > 0 ? (unit === 'tokens' ? t.tokens : t.amount) / toolMax : 0

      ctx.fillStyle = COLORS.panelSeparator
      ctx.beginPath()
      ctx.roundRect(panelX + pad, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()

      ctx.fillStyle = toolTypeColor(t.name)
      ctx.globalAlpha = 0.2
      ctx.beginPath()
      ctx.roundRect(panelX + pad, y + 1, barW * ratio, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.font = '8px monospace'
      ctx.fillStyle = toolTypeColor(t.name)
      ctx.textAlign = 'left'
      ctx.fillText(truncateText(ctx, t.name, barW - 58), panelX + pad + COST_PANEL.barInset, y + 3)

      ctx.textAlign = 'right'
      ctx.fillStyle = COLORS.costTextDim
      ctx.fillText(t.text, panelX + pad + barW - COST_PANEL.barInset, y + 3)

      y += lineH
    }
  }

  // Notes (hidden / unpriced agents, kWh not applicable)
  if (noteLines > 0) {
    y += 4
    ctx.font = '7.5px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    for (const n of summary.notes) {
      ctx.fillText(truncateText(ctx, n, barW), panelX + pad, y)
      y += 11
    }
  }

  ctx.restore()
}

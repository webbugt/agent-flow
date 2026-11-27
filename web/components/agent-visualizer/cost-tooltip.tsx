'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { effectiveCosts } from '@/lib/costs/active'
import { BADGE_LABEL, FLAVOR_COLOR, FLAVOR_WORD, buildAgentTooltip, flavorOf } from '@/lib/costs/overlay'
import type { AgentCost } from '@/lib/costs/agent-cost'
import type { CostTooltip as CostTooltipModel } from '@/lib/costs/tooltip'
import type { ResolvedConfig } from '@/lib/costs/types'

const WIDTH = 340
const MARGIN = 8

/** The words under each figure, in plain DOM text (also what the tests and screen readers read). */
export function CostTooltipView({ cost, cfg, onClose }: { cost: AgentCost; cfg: ResolvedConfig; onClose?: () => void }) {
  const model: CostTooltipModel = buildAgentTooltip(cost, cfg)
  const flavor = flavorOf(cost)
  const color = FLAVOR_COLOR[flavor]
  return (
    <div data-testid="cost-tooltip" data-kind={model.kind} data-flavor={flavor}>
      <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
        <span style={{ color: COLORS.textPrimary, fontWeight: 700 }}>{model.title}</span>
        <span
          data-testid="cost-tooltip-badge"
          style={{ color, background: color + '26', border: `1px solid ${color}66`, borderRadius: 4, padding: '0 5px', fontSize: 11 }}
        >
          {BADGE_LABEL[flavor]}
        </span>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close cost details" className="ml-auto" style={{ color: COLORS.textMuted }}>✕</button>
        )}
      </div>
      <dl style={{ margin: 0 }}>
        {model.rows.map(row => (
          <div key={row.id} data-row={row.id} style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 6, marginBottom: 3 }}>
            <dt style={{ color: COLORS.textMuted }}>{row.label}</dt>
            <dd
              style={{
                margin: 0, color: row.id === 'billing-kind' ? color : COLORS.textPrimary, wordBreak: 'break-word',
                whiteSpace: row.id === 'formula' || row.id === 'tokens' ? 'pre-wrap' : 'normal',
                fontStyle: row.pending ? 'italic' : 'normal',
              }}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {model.footnotes.length > 0 && (
        <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', color: COLORS.textMuted, fontSize: 11 }}>
          {model.footnotes.map((f, i) => <li key={i} style={{ marginBottom: 2 }}>{f}</li>)}
        </ul>
      )}
      <span className="sr-only">{FLAVOR_WORD[flavor]}</span>
    </div>
  )
}

export interface CostTooltipAnchor { left: number; top: number; width: number; height: number }

/**
 * The tooltip of one cost pill, positioned next to it (above when there is room, else below) and kept inside the
 * viewport. Hover shows it; a tap pins it (`pinned`, with a close button) so it can be read on a touch screen.
 */
export function CostTooltip({ cost, anchor, pinned, onClose }: { cost: AgentCost; anchor: CostTooltipAnchor; pinned: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const cfg = effectiveCosts()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = Math.min(WIDTH, vw - MARGIN * 2)
    const h = el.offsetHeight
    const left = Math.min(Math.max(MARGIN, anchor.left + anchor.width / 2 - w / 2), Math.max(MARGIN, vw - w - MARGIN))
    const above = anchor.top - h - 6
    const top = above >= MARGIN ? above : Math.min(anchor.top + anchor.height + 6, Math.max(MARGIN, vh - h - MARGIN))
    setPos(prev => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [anchor.left, anchor.top, anchor.width, anchor.height, cost])

  return (
    <div
      ref={ref}
      role="tooltip"
      className="font-mono text-[11px] rounded"
      style={{
        position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: `min(${WIDTH}px, calc(100vw - ${MARGIN * 2}px))`, zIndex: Z.detailCard + 5,
        background: 'rgba(8, 12, 24, 0.96)', border: `1px solid ${COLORS.glassBorder}`, boxShadow: '0 4px 24px rgba(0,0,0,0.5)', padding: '8px 10px',
        backdropFilter: 'blur(8px)', color: COLORS.textPrimary, pointerEvents: pinned ? 'auto' : 'none',
      }}
      // A click inside the pinned tooltip must not reach the canvas underneath.
      onMouseDown={e => e.stopPropagation()}
      onMouseUp={e => e.stopPropagation()}
    >
      <CostTooltipView cost={cost} cfg={cfg} onClose={pinned ? onClose : undefined} />
    </div>
  )
}

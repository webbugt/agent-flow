'use client'

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { effectiveCosts } from '@/lib/costs/active'
import { buildLimitsPanel, type LimitRow, type LimitsPanelModel, type RowTag } from '@/lib/costs/limits-model'
import { useLimits, useMinuteTick } from '@/hooks/use-limits'
import { useActiveCostsVersion } from '@/hooks/use-costs-config'
import { useViewportHeight, useViewportWidth } from '@/hooks/use-viewport-width'
import { collectByTime, type LedgerEvent } from '@/lib/limits-ledger'
import { LOCAL_CLOCK } from './claude-limits'
import { STACK_GAP_PX, DEFAULT_BAR_TOP_PX, VAR_BAR_TOP, VAR_LIMITS_TOP, limitsAutoFolded, limitsStacked } from '@/lib/bottom-stack'
import { usePublishInset } from '@/hooks/use-publish-inset'

const AMBER = '#ffcc66'
const TAG: Record<RowTag, { text: string; color: string }> = {
  obs: { text: 'obs', color: COLORS.complete },
  stale: { text: 'stale', color: AMBER },
  cal: { text: 'cal', color: '#9ad7ff' },
  est: { text: 'est', color: '#c9a7ff' },
}
const PHONE_PX = 640
const TIP_WIDTH = 380
const MARGIN = 8

/** Panel model for the current config, observed readings and the ledger of every session; re-evaluated every minute. */
export function useLimitsPanelModel(sessionIds: readonly string[], eventsOf: (id: string) => readonly LedgerEvent[], now?: number): LimitsPanelModel {
  const payload = useLimits()
  const tick = useMinuteTick()
  const costsVersion = useActiveCostsVersion()
  const key = sessionIds.join('|')
  // The ledger changes with every reply; reading it once per tick (15 s) is exact enough for a 5-hour / weekly figure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spends = useMemo(() => collectByTime(sessionIds, eventsOf), [key, tick, eventsOf])
  return useMemo(
    () => buildLimitsPanel({ config: effectiveCosts(), payload, spends, now: now ?? Date.now(), clock: LOCAL_CLOCK }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payload, spends, tick, costsVersion, now],
  )
}

/** The estimate icon: every number that is not observed carries it. */
function EstIcon() {
  return (
    <span data-testid="est-icon" role="img" aria-label="estimate" title="estimate" style={{ color: '#c9a7ff', fontSize: 12, lineHeight: 1, marginLeft: 2 }}>≈</span>
  )
}

function Tag({ tag, id }: { tag: RowTag; id: string }) {
  const t = TAG[tag]
  return (
    <span data-testid={`limits-row-${id}-tag`} style={{ color: t.color, border: `1px solid ${t.color}66`, borderRadius: 4, padding: '0 4px', fontSize: 11 }}>{t.text}</span>
  )
}

/** Hover / tap text of one row. Fable's has its own structure and test id. */
function RowTooltip({ row, anchor, narrow, onClose, pinned }: { row: LimitRow; anchor: DOMRect; narrow: boolean; onClose: () => void; pinned: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = Math.min(TIP_WIDTH, vw - MARGIN * 2)
    const h = el.offsetHeight
    let left: number
    let top: number
    if (narrow) {
      left = Math.min(Math.max(MARGIN, anchor.left), Math.max(MARGIN, vw - w - MARGIN))
      const above = anchor.top - h - 6
      top = above >= MARGIN ? above : Math.min(anchor.bottom + 6, Math.max(MARGIN, vh - h - MARGIN))
    } else {
      // desktop: to the left of the panel, level with the row
      left = Math.max(MARGIN, anchor.left - w - 8)
      top = Math.min(Math.max(MARGIN, anchor.top + anchor.height / 2 - h / 2), Math.max(MARGIN, vh - h - MARGIN))
    }
    setPos(prev => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [anchor, narrow, row])

  const f = row.fable
  // A portal: the panel has `backdrop-filter`, which would make it the containing block of a `position: fixed` child
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-testid={f ? 'fable-estimate-tooltip' : 'limits-row-tooltip'}
      className="font-mono text-[11px] rounded"
      style={{
        position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: `min(${TIP_WIDTH}px, calc(100vw - ${MARGIN * 2}px))`, zIndex: Z.detailCard + 5,
        background: 'rgba(8, 12, 24, 0.97)', border: `1px solid ${COLORS.glassBorder}`, boxShadow: '0 4px 24px rgba(0,0,0,0.5)', padding: '8px 10px',
        backdropFilter: 'blur(8px)', color: COLORS.textPrimary, pointerEvents: pinned ? 'auto' : 'none', lineHeight: 1.45,
      }}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onMouseUp={e => e.stopPropagation()}
    >
      {pinned && <button type="button" onClick={onClose} aria-label="Close limit details" className="af-tap af-focus" style={{ position: 'absolute', right: 8, top: 6, color: COLORS.textMuted }}>✕</button>}
      {f ? (
        <>
          <div style={{ fontWeight: 700, marginBottom: 4, paddingRight: 14 }}>{f.title}</div>
          <div data-testid="fable-values" style={{ marginBottom: 4, color: '#c9a7ff', whiteSpace: 'pre-wrap' }}>
            {f.point !== null
              ? <>estimate <b data-testid="fable-point">{f.point}</b>{'    '}lower bound <b data-testid="fable-lower">{f.lower}</b>{'    '}upper bound <b data-testid="fable-upper">{f.upper}</b></>
              : f.valueLine}
          </div>
          <div data-testid="fable-confidence">{f.confidence}</div>
          <div data-testid="fable-basis">{f.basis}</div>
          <div data-testid="fable-assumptions">{f.assumptions}</div>
          <div data-testid="fable-used">{f.used}</div>
          <div style={{ color: COLORS.textMuted }}>{f.scope}</div>
          {f.composition && <div data-testid="fable-composition">{f.composition}</div>}
        </>
      ) : (
        row.title.split('\n').map((l, i) => <div key={i} style={{ marginBottom: i === 0 ? 4 : 2, fontWeight: i === 0 ? 700 : 400 }}>{l}</div>)
      )}
    </div>,
    document.body,
  )
}

function Row({ row, narrow }: { row: LimitRow; narrow: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const open = hover || pinned
  const show = () => { if (ref.current) setAnchor(ref.current.getBoundingClientRect()); setHover(true) }
  const color = row.tag ? TAG[row.tag].color : COLORS.textMuted
  const bar = row.fraction === null ? 0 : Math.min(1, row.fraction)
  // A bar of 0.3% would be invisible: keep a 2px sliver so "tiny but present" is visible.
  const barPct = row.fraction !== null && row.fraction > 0 ? Math.max(bar * 100, 1.5) : 0

  return (
    <div
      ref={ref}
      data-testid={`limits-row-${row.id}`}
      data-tag={row.tag ?? 'none'}
      data-estimate={row.estimate ? '1' : '0'}
      tabIndex={0}
      role="group"
      aria-label={`${row.label} limit ${row.valueText}`}
      onMouseEnter={show}
      onMouseLeave={() => setHover(false)}
      onFocus={show}
      onBlur={() => setHover(false)}
      onClick={() => { if (ref.current) setAnchor(ref.current.getBoundingClientRect()); setPinned(p => !p) }}
      style={{ marginBottom: 7, cursor: 'help', outline: 'none' }}
    >
      <div className="flex items-baseline gap-2">
        <span style={{ color: COLORS.textMuted, width: 44, flexShrink: 0 }}>{row.id === '5h' ? '5h' : row.id === '7d' ? '7d' : 'Fable'}</span>
        <strong data-testid={`limits-row-${row.id}-value`} style={{ fontSize: 13, color: row.tag ? COLORS.textPrimary : COLORS.textMuted }}>{row.valueText}</strong>
        {row.estimate && <EstIcon />}
        {row.tag && <Tag tag={row.tag} id={row.id} />}
        {row.asOfText && <span data-testid={`limits-row-${row.id}-asof`} style={{ color: AMBER, fontSize: 11 }}>{row.asOfText}</span>}
        <span style={{ color: COLORS.textMuted, fontSize: 11, marginLeft: 'auto', textAlign: 'right' }}>{row.resetText}</span>
      </div>
      <div aria-hidden style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', marginTop: 3, overflow: 'hidden' }}>
        <div style={{ width: `${barPct}%`, height: '100%', background: row.tag === 'stale' ? `${AMBER}99` : row.estimate ? `${color}aa` : color }} />
      </div>
      {row.hint && <div data-testid={`limits-row-${row.id}-hint`} style={{ color: COLORS.textMuted, fontSize: 11, marginTop: 2 }}>{row.hint}</div>}
      {open && anchor && <RowTooltip row={row} anchor={anchor} narrow={narrow} pinned={pinned} onClose={() => { setPinned(false); setHover(false) }} />}
    </div>
  )
}

/**
 * The LIMITS panel (PLAN v2 7.2): 5h, 7d and (only when Fable was used this week) Fable, each with its tag and a
 * hover / tap explanation. DOM, not canvas, so the hover targets are real. Bottom-right on desktop, a sheet above
 * the control bar on a phone. Plan `api` or nothing to show: nothing is rendered.
 */
export function LimitsPanel({ model, collapsed: collapsedProp, onCollapsedChange, otherBottomPanelOpen = false }: {
  model: LimitsPanelModel
  /** Controlled fold state (the app keeps it in its saved state). Without it the panel keeps its own, starting folded. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  /** Another bottom panel (timeline, node card) is open: on a small screen the panel shows its one line only. */
  otherBottomPanelOpen?: boolean
}) {
  const width = useViewportWidth(1280)
  const height = useViewportHeight(900)
  const narrow = width < PHONE_PX
  // Beside the control bar only where the two cannot meet; everywhere else it sits on top of the bar and publishes its
  // own top edge, so the timeline, node card and resource blocks stack above it instead of under it.
  const stacked = limitsStacked(width)
  const [ownCollapsed, setOwnCollapsed] = useState(true)
  const stateCollapsed = collapsedProp ?? ownCollapsed
  // The fold forced by an open bottom panel is a view of the state, not a change to it: closing the panel restores the user's choice.
  const autoFolded = !stateCollapsed && limitsAutoFolded(width, otherBottomPanelOpen, height)
  const collapsed = stateCollapsed || autoFolded
  const setCollapsed = (next: boolean) => { if (onCollapsedChange) onCollapsedChange(next); else setOwnCollapsed(next) }
  const sectionRef = useRef<HTMLElement>(null)
  usePublishInset(sectionRef, VAR_LIMITS_TOP, stacked && model.visible)
  if (!model.visible) return null
  return (
    <section
      ref={sectionRef}
      data-testid="limits-panel"
      data-narrow={narrow ? '1' : '0'}
      data-stacked={stacked ? '1' : '0'}
      data-auto-folded={autoFolded ? '1' : '0'}
      aria-label="Claude usage limits"
      className="font-mono text-[11px] rounded"
      style={{
        position: 'fixed', right: narrow ? 8 : 16, left: narrow ? 8 : 'auto', bottom: stacked ? `calc(var(${VAR_BAR_TOP}, ${DEFAULT_BAR_TOP_PX}px) + ${STACK_GAP_PX}px)` : 16, width: narrow ? 'auto' : 300, zIndex: Z.sidePanel + 5,
        background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}`, padding: '8px 10px', color: COLORS.textPrimary, backdropFilter: 'blur(8px)',
      }}
    >
      <div className="flex items-baseline gap-2" style={{ marginBottom: collapsed ? 0 : 6 }}>
        <h3 style={{ margin: 0, color: COLORS.textMuted, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' }}>Limits</h3>
        <span data-testid="limits-plan" style={{ color: COLORS.textMuted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.planText}</span>
        <button
          type="button" data-testid="limits-panel-toggle" onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed} aria-label={collapsed ? 'Show usage limits' : 'Hide usage limits'} disabled={autoFolded} title={autoFolded ? 'Folded while another panel is open' : undefined}
          className="af-tap af-focus ml-auto px-1" style={{ color: COLORS.textMuted, fontSize: 11, lineHeight: 1 }}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && model.rows.map(r => <Row key={r.id} row={r} narrow={narrow} />)}
      {!collapsed && model.notes.map((n, i) => <p key={i} data-testid="limits-panel-note" style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 11, lineHeight: 1.4 }}>{n}</p>)}
    </section>
  )
}

/** Mounted once near the root: reads every session's ledger, the config and the observed readings. */
export function LimitsPanelHost({ sessionIds, eventsOf, collapsed, onCollapsedChange, otherBottomPanelOpen }: {
  sessionIds: readonly string[]
  eventsOf: (id: string) => readonly LedgerEvent[]
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  otherBottomPanelOpen?: boolean
}) {
  const model = useLimitsPanelModel(sessionIds, eventsOf)
  return <LimitsPanel model={model} collapsed={collapsed} onCollapsedChange={onCollapsedChange} otherBottomPanelOpen={otherBottomPanelOpen} />
}

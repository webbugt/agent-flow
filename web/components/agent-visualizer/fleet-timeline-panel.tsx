'use client'

import { useRef, useEffect, useMemo, useCallback, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import {
  allSelectionIds, buildFleetRows, computeAxis, formatTick, groupInstances,
  type FleetAxis, type FleetMarker, type FleetRow, type FleetInstance,
} from '@/lib/fleet/fleet-model'
import type { useFleetSelection } from '@/hooks/use-fleet-selection'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'
import { PanelHeader, SlidingPanel } from './shared-ui'
import { STACK_BOTTOM, STACK_PANEL_MAX_HEIGHT } from '@/lib/bottom-stack'

interface FleetTimelinePanelProps {
  visible: boolean
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
  /** Selection state from useFleetSelection (hide/show only, never stops anything). */
  selection: ReturnType<typeof useFleetSelection>
  /** Click on a group or copy row: open that session's detail. Omitted = rows are not clickable. */
  onOpenSession?: (sessionId: string) => void
  /** Only rows whose session this accepts are clickable (a closed tab has nothing to open). Default: all. */
  canOpenSession?: (sessionId: string) => boolean
  /** Pixels to keep free on the right (a side panel is open there), so the timeline is not covered. */
  rightInset?: number
  onClose: () => void
}

// ─── Layout constants (same row/header rhythm as timeline-panel.tsx) ────────

const ROW_HEIGHT = 24
const HEADER_HEIGHT = 20
const LABEL_WIDTH = 190
const FONT = '9px monospace'
const MIN_TRACK_WIDTH = 200

const MARKER_COLORS: Record<FleetMarker['kind'], string> = {
  tool_call: COLORS.tool,
  created: COLORS.holoBase,
  started: COLORS.tool,
  blocked: COLORS.error,
  completed: COLORS.complete,
}

const LEGEND_ITEMS = [
  { color: COLORS.holoBase, label: 'created' },
  { color: COLORS.tool, label: 'started / tool call' },
  { color: COLORS.error, label: 'blocked' },
  { color: COLORS.complete, label: 'completed' },
]

// ─── Canvas drawing ─────────────────────────────────────────────────────────

function xFor(t: number, axis: FleetAxis, trackWidth: number): number {
  return ((t - axis.min) / (axis.max - axis.min)) * trackWidth
}

function drawFleet(
  ctx: CanvasRenderingContext2D,
  rows: readonly FleetRow[],
  axis: FleetAxis | null,
  now: number,
  width: number,
  height: number,
  dpr: number,
) {
  ctx.clearRect(0, 0, width * dpr, height * dpr)
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.font = FONT

  if (!axis) {
    ctx.textAlign = 'center'
    ctx.fillStyle = COLORS.textMuted
    ctx.fillText(rows.length ? 'Nothing selected' : 'No fleet data', width / 2, HEADER_HEIGHT + 24)
    ctx.restore()
    return
  }

  // One shared axis: tick labels once, grid lines on every row.
  ctx.textAlign = 'center'
  ctx.fillStyle = COLORS.textMuted
  for (const t of axis.ticks) ctx.fillText(formatTick(t, axis.step), xFor(t, axis, width), HEADER_HEIGHT - 4)

  rows.forEach((row, i) => {
    const y = HEADER_HEIGHT + i * ROW_HEIGHT
    const trackY = y + 4
    const trackH = ROW_HEIGHT - 8
    const sub = row.depth === 1
    // Instance rows are thinner bars under their group.
    const barY = sub ? trackY + 2 : trackY
    const barH = sub ? trackH - 4 : trackH

    ctx.fillStyle = row.kind === 'section' ? COLORS.holoBg05 : COLORS.holoBg03
    ctx.fillRect(0, trackY, width, trackH)
    ctx.fillStyle = COLORS.panelSeparator
    for (const t of axis.ticks) ctx.fillRect(xFor(t, axis, width), trackY, 1, trackH)

    for (const s of row.spans) {
      const x0 = xFor(s.start, axis, width)
      const x1 = xFor(s.end ?? now, axis, width)
      const w = Math.max(x1 - x0, 1)
      const color = s.status === 'error' ? COLORS.error : row.color
      const idle = s.status === 'idle'
      // Idle spans: fainter fill and a dashed outline, so they read as "not running".
      ctx.globalAlpha = s.intensity !== undefined ? 0.15 + 0.6 * s.intensity : idle ? 0.14 : 0.3
      ctx.fillStyle = color
      ctx.fillRect(x0, barY + 1, w, barH - 2)
      ctx.globalAlpha = idle ? 0.6 : 0.45
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      if (idle) ctx.setLineDash([3, 3])
      ctx.strokeRect(x0 + 0.5, barY + 1.5, Math.max(w - 1, 0), barH - 3)
      if (idle) ctx.setLineDash([])
      if (s.end === undefined) {
        // still running: bright leading edge
        ctx.globalAlpha = 0.9
        ctx.fillRect(x1 - 2, barY + 1, 2, barH - 2)
      }
      ctx.globalAlpha = 1
    }

    for (const m of row.markers) {
      const x = xFor(m.at, axis, width)
      ctx.fillStyle = MARKER_COLORS[m.kind]
      if (m.kind === 'tool_call') {
        ctx.fillRect(x - 0.5, barY + 2, 1.5, barH - 4)
      } else {
        // kanban events: diamond
        const cy = trackY + trackH / 2
        ctx.beginPath()
        ctx.moveTo(x, cy - 4); ctx.lineTo(x + 4, cy); ctx.lineTo(x, cy + 4); ctx.lineTo(x - 4, cy)
        ctx.closePath()
        ctx.fill()
      }
    }

    if (row.hidden && row.kind !== 'section') {
      ctx.fillStyle = COLORS.textMuted
      ctx.textAlign = 'left'
      ctx.fillText('hidden', 6, trackY + trackH / 2 + 3)
    }
  })

  // "now" playhead across all rows
  const nowX = xFor(Math.min(now, axis.max), axis, width)
  ctx.fillStyle = COLORS.holoHot
  ctx.globalAlpha = 0.4
  ctx.fillRect(nowX, HEADER_HEIGHT, 1, rows.length * ROW_HEIGHT)
  ctx.globalAlpha = 1

  ctx.restore()
}

function formatClock(t: number): string {
  return new Date(t).toISOString().slice(11, 19) + 'Z'
}

function hoverTitle(row: FleetRow | undefined, axis: FleetAxis | null, x: number, trackWidth: number, now: number): string {
  if (!row || !axis) return ''
  const marker = row.markers.find(m => Math.abs(xFor(m.at, axis, trackWidth) - x) <= 4)
  if (marker) return `${row.label} · ${marker.label}\n${formatClock(marker.at)}`
  const t = axis.min + (x / trackWidth) * (axis.max - axis.min)
  const span = row.spans.find(s => t >= s.start && t <= (s.end ?? now))
  if (span?.label) return `${row.label} · ${span.label}`
  if (span) return `${row.label} · ${formatClock(span.start)} → ${span.end ? formatClock(span.end) : 'running'}`
  return row.label
}

// ─── Row label column (DOM: checkboxes need real inputs) ────────────────────

function LabelCell({ row, onToggle, onExpand, onOpen, canOpen }: { row: FleetRow; onToggle: () => void; onExpand: () => void; onOpen?: (sessionId: string) => void; canOpen?: (sessionId: string) => boolean }) {
  const openId = onOpen && row.openSessionId && (!canOpen || canOpen(row.openSessionId)) ? row.openSessionId : undefined
  const checkboxRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = row.indeterminate
  }, [row.indeterminate])

  return (
    <div
      className="flex items-center gap-1 font-mono text-[11px] overflow-hidden"
      style={{
        height: ROW_HEIGHT, paddingLeft: 6 + row.depth * 14, paddingRight: 4,
        opacity: row.hidden ? 0.45 : 1, color: COLORS.textDim,
        borderLeft: `2px solid ${row.color}`,
      }}
      data-fleet-row={row.key}
    >
      <input
        ref={checkboxRef}
        type="checkbox"
        checked={row.checked}
        onChange={onToggle}
        aria-label={`${row.checked ? 'Hide' : 'Show'} ${row.label}`}
        style={{ accentColor: row.color, margin: 0, flexShrink: 0 }}
      />
      {row.expandable ? (
        <button
          onClick={onExpand}
          aria-expanded={row.expanded}
          aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.label} copies`}
          style={{ color: COLORS.textMuted, width: 10, flexShrink: 0, lineHeight: 1 }}
        >
          {row.expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}
      {openId ? (
        <button
          type="button"
          onClick={() => onOpen?.(openId)}
          className="truncate text-left hover:underline"
          style={{ color: COLORS.textPrimary, fontWeight: 600, cursor: 'pointer' }}
          title={`Open the session detail of ${row.label}`}
          aria-label={`Open session detail of ${row.label}`}
          data-fleet-open={openId}
        >
          {row.label}
        </button>
      ) : (
        <span
          className="truncate"
          style={{ color: row.kind === 'section' ? COLORS.textPrimary : COLORS.textDim, fontWeight: row.kind === 'lane' ? 400 : 600 }}
          title={row.label}
        >
          {row.label}
        </span>
      )}
      {row.badge && (
        <span
          className="px-1 rounded-sm flex-shrink-0"
          style={{ background: row.color + '30', color: row.color, border: `1px solid ${row.color}60` }}
        >
          {row.badge}
        </span>
      )}
      {row.sublabel && (
        <span className="truncate" style={{ color: COLORS.textMuted }}>{row.sublabel}</span>
      )}
    </div>
  )
}

// ─── Component ──────────────────────────────────────────────────────────────

export function FleetTimelinePanel({ visible, instances, kanban, supermemory, selection, onOpenSession, canOpenSession, rightInset = 0, onClose }: FleetTimelinePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  // Groups start OPEN so every agent node has its own row; the user collapses what they don't need.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())
  const [trackWidth, setTrackWidth] = useState(MIN_TRACK_WIDTH)

  // Keep "now" fresh while open so running spans grow.
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible])

  const expanded = useMemo(
    () => new Set(groupInstances(instances).map(g => g.identity).filter(identity => !collapsed.has(identity))),
    [instances, collapsed],
  )
  const rows = useMemo(() => visible
    ? buildFleetRows({ instances, kanban, supermemory, selection: selection.view, expanded, now })
    : [], [visible, instances, kanban, supermemory, selection.view, expanded, now])
  const axis = useMemo(() => computeAxis(rows, now), [rows, now])
  const allIds = useMemo(() => allSelectionIds({ instances, kanban, supermemory }), [instances, kanban, supermemory])

  const toggleExpanded = useCallback((identity: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(identity)) next.delete(identity)
      else next.add(identity)
      return next
    })
  }, [])

  const canvasHeight = HEADER_HEIGHT + Math.max(rows.length, 1) * ROW_HEIGHT

  // Track the track-area width (panel is responsive).
  useEffect(() => {
    if (!visible) return
    const el = trackRef.current
    if (!el) return
    const measure = () => setTrackWidth(Math.max(el.clientWidth, MIN_TRACK_WIDTH))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = trackWidth * dpr
    canvas.height = canvasHeight * dpr
    canvas.style.width = `${trackWidth}px`
    canvas.style.height = `${canvasHeight}px`
    drawFleet(ctx, rows, axis, now, trackWidth, canvasHeight, dpr)
  }, [visible, rows, axis, now, trackWidth, canvasHeight])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const idx = Math.floor((e.nativeEvent.offsetY - HEADER_HEIGHT) / ROW_HEIGHT)
    const title = hoverTitle(idx >= 0 ? rows[idx] : undefined, axis, e.nativeEvent.offsetX, trackWidth, now)
    if (e.currentTarget.title !== title) e.currentTarget.title = title
  }, [rows, axis, trackWidth, now])

  if (!visible) return null

  const noneSelected = allIds.length > 0 && allIds.every(id => !selection.view.isSelected(id))
  const allSelected = allIds.every(id => selection.view.isSelected(id))

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: STACK_BOTTOM, left: 16, right: 16 + rightInset }}
      axis="Y"
      zIndex={Z.sidePanel}
      className="mx-auto"
      style={{ maxWidth: 860 }}
    >
      {/* Capped to the free height (flex column): the title row with the close control stays reachable, only the lanes scroll. */}
      <div className="glass-card relative flex flex-col" data-testid="fleet-timeline-panel" style={{ maxHeight: STACK_PANEL_MAX_HEIGHT }}>
        <PanelHeader
          className="mb-2 flex-shrink-0"
          onClose={onClose}
          actions={
            <div className="flex items-center gap-1 mr-2 font-mono text-[11px]">
              <button
                onClick={selection.selectAll}
                disabled={allSelected}
                className="px-1.5 py-0.5 rounded"
                style={{ border: `1px solid ${COLORS.holoBorder12}`, color: allSelected ? COLORS.textMuted : COLORS.textPrimary }}
              >
                All
              </button>
              <button
                onClick={() => selection.selectNone(allIds)}
                disabled={noneSelected}
                className="px-1.5 py-0.5 rounded"
                style={{ border: `1px solid ${COLORS.holoBorder12}`, color: noneSelected ? COLORS.textMuted : COLORS.textPrimary }}
              >
                None
              </button>
            </div>
          }
        >
          <span className="text-[11px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>FLEET TIMELINE</span>
          <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
            hiding does not stop agents{onOpenSession ? ' · click a name to open its session' : ''}
          </span>
        </PanelHeader>

        {/* Shorter on a phone so the node map above keeps most of the screen: see .af-fleet-lanes (a landscape phone is wider than
            `sm` but only 390 px high, and there the lanes are a few rows so the zoom buttons, the filter and Hide timeline fit above). */}
        <div className="af-fleet-lanes overflow-auto min-h-0 flex-1">
          <div className="flex">
            <div style={{ width: LABEL_WIDTH, flexShrink: 0 }}>
              <div style={{ height: HEADER_HEIGHT }} />
              {rows.map(row => (
                <LabelCell
                  key={row.key}
                  row={row}
                  onToggle={() => selection.toggleIds(row.selectionIds)}
                  onExpand={() => toggleExpanded(row.label)}
                  onOpen={onOpenSession}
                  canOpen={canOpenSession}
                />
              ))}
              {rows.length === 0 && (
                <div className="font-mono text-[11px] px-2" style={{ height: ROW_HEIGHT, color: COLORS.textMuted }}>No fleet data</div>
              )}
            </div>
            <div ref={trackRef} style={{ flex: 1, minWidth: MIN_TRACK_WIDTH }}>
              <canvas ref={canvasRef} style={{ display: 'block' }} onMouseMove={handleMouseMove} />
            </div>
          </div>
        </div>

        <div className="af-fleet-legend flex items-center gap-3 px-3 py-1.5 flex-shrink-0" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
          <div className="flex items-center gap-3 flex-wrap">
            {LEGEND_ITEMS.map(item => (
              <div key={item.label} className="flex items-center gap-1">
                <div className="w-2 h-2 rotate-45" style={{ background: item.color + '90' }} />
                <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SlidingPanel>
  )
}

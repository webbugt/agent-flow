"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { COLORS } from "@/lib/colors"
import { Z } from "@/lib/agent-types"
import type { FleetInstance, FleetSelectionView } from "@/lib/fleet/fleet-model"
import type { PublicKanbanBoardNode } from "@/lib/fleet/kanban-source"
import type { SupermemoryNamespaceNode } from "@/lib/fleet/supermemory-source"
import {
  buildFleetGraph, countByKind, layoutFleetGraph,
  type FleetGraph, type FleetLayout, type PlacedNode,
} from "@/lib/fleet/fleet-graph"

interface FleetMapProps {
  visible: boolean
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
  selection: FleetSelectionView
  /** Open a session (instance id) in the session detail. */
  onOpenSession?: (instanceId: string) => void
  /** Space under the top bar / above the timeline panel / left of the session detail panel. */
  insetTop: number
  insetBottom: number
  insetRight: number
}

const STATUS_ALPHA = { active: 1, idle: 0.55, completed: 0.4, error: 1 } as const
/** Below this drawing scale the map is crowded: sublabels are left out. */
const LABEL_MIN_SCALE = 0.6

function nodeAt(layout: FleetLayout, x: number, y: number): PlacedNode | null {
  let best: PlacedNode | null = null
  let bestDist = Infinity
  for (const n of layout.nodes) {
    const d = Math.hypot(n.x - x, n.y - y)
    // A few pixels of slack so small satellites are easy to hit on touch screens.
    if (d <= Math.max(n.radius + 4, 12) && d < bestDist) { best = n; bestDist = d }
  }
  return best
}

function draw(
  ctx: CanvasRenderingContext2D, width: number, height: number, graph: FleetGraph, layout: FleetLayout,
  hoverId: string | null, t: number,
) {
  ctx.clearRect(0, 0, width, height)
  const byId = new Map(layout.nodes.map(n => [n.id, n]))

  // Links first, nodes on top.
  for (const e of graph.edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    const color = e.kind === 'session' ? a.color : b.color
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = e.kind === 'session' ? (e.active ? 0.6 : 0.25) : e.active ? 0.7 : 0.22
    ctx.lineWidth = e.kind === 'session' ? 1 : Math.min(1 + Math.log2(1 + e.weight) * 0.5, 3)
    if (e.kind !== 'session') ctx.setLineDash(e.active ? [6, 4] : [2, 4])
    if (e.active) ctx.lineDashOffset = -(t / 60) % 20
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.restore()
  }

  const crowded = layout.scale < LABEL_MIN_SCALE
  ctx.textAlign = 'center'
  for (const n of layout.nodes) {
    const hovered = n.id === hoverId
    ctx.save()
    ctx.globalAlpha = STATUS_ALPHA[n.status]
    // Active nodes pulse: a soft halo.
    if (n.status === 'active') {
      const pulse = 0.5 + 0.5 * Math.sin(t / 400 + n.x)
      ctx.fillStyle = n.color
      ctx.globalAlpha = 0.10 + 0.12 * pulse
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.radius * (1.5 + 0.35 * pulse), 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = n.color + (n.kind === 'session' ? '55' : '33')
    ctx.strokeStyle = n.color
    ctx.lineWidth = n.kind === 'profile' ? 2 : 1.2
    if (n.status === 'idle') ctx.setLineDash([3, 3])
    ctx.beginPath()
    if (n.kind === 'kanban') {
      // Boards: rounded squares. Namespaces: diamonds. Agents: circles.
      const r = n.radius
      ctx.roundRect(n.x - r, n.y - r, 2 * r, 2 * r, 3)
    } else if (n.kind === 'supermemory') {
      const r = n.radius * 1.15
      ctx.moveTo(n.x, n.y - r); ctx.lineTo(n.x + r, n.y); ctx.lineTo(n.x, n.y + r); ctx.lineTo(n.x - r, n.y); ctx.closePath()
    } else {
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2)
    }
    ctx.fill()
    ctx.stroke()
    if (hovered) {
      ctx.setLineDash([])
      ctx.strokeStyle = COLORS.textPrimary
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.radius + 4, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()

    // Labels: profiles and resources always; sessions unless the map is crowded (hover shows them).
    // Session labels would overlap on the ring: they show on hover (tooltip) only.
    const showLabel = n.kind !== 'session' || hovered
    if (!showLabel) continue
    const small = n.kind === 'session'
    ctx.font = `${small ? 9 : n.kind === 'profile' ? 11 : 10}px 'SF Mono','Fira Code',monospace`
    ctx.fillStyle = n.kind === 'profile' ? COLORS.textPrimary : COLORS.textDim
    const dy = n.radius + (small ? 11 : 13)
    // Session labels go outwards of their ring; keep them short.
    const maxChars = Math.max(4, Math.min(18, Math.floor((n.labelWidth ?? 200) / 5.6)))
    const label = n.label.length > maxChars ? `${n.label.slice(0, maxChars - 1)}…` : n.label
    ctx.fillText(label, n.x, n.y + dy)
    if (n.sublabel && n.kind !== 'session' && !crowded && (n.labelWidth ?? 200) >= 120) {
      ctx.font = "9px 'SF Mono','Fira Code',monospace"
      ctx.fillStyle = COLORS.textMuted
      ctx.fillText(n.sublabel, n.x, n.y + dy + 11)
    }
  }
}

/**
 * The Fleet node map: every profile (live and idle) with its sessions as nodes,
 * Kanban boards and Supermemory namespaces around them, linked to the profiles that
 * use them. Fills the canvas area while the Fleet view is on; click a profile or
 * session to open its session detail.
 */
export function FleetMap({ visible, instances, kanban, supermemory, selection, onOpenSession, insetTop, insetBottom, insetRight }: FleetMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [visible])

  useEffect(() => {
    const el = wrapRef.current
    if (!visible || !el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [visible])

  const graph = useMemo(
    () => visible ? buildFleetGraph({ instances, kanban, supermemory, selection, now }) : { nodes: [], edges: [] },
    [visible, instances, kanban, supermemory, selection, now],
  )
  // On a phone the top bar wraps to more rows and the timeline panel takes a larger share
  // of the screen: keep the map in what is left (never more than 42% of the height reserved below).
  const narrow = size.width < 720
  // Phone: bar on two rows + the message card under it.
  const top = narrow ? 138 : insetTop
  const bottom = Math.min(insetBottom, Math.round(size.height * 0.42))
  const layout = useMemo(
    () => layoutFleetGraph(graph, { width: size.width, height: size.height, insetTop: top, insetBottom: bottom, insetRight }),
    [graph, size.width, size.height, top, bottom, insetRight],
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const graphRef = useRef(graph)
  graphRef.current = graph
  const hoverRef = useRef<string | null>(null)
  hoverRef.current = hover?.id ?? null

  // Animation loop (halos pulse, active links flow). Stops when the map is hidden.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!visible || !canvas || size.width === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(size.width * dpr)
    canvas.height = Math.floor(size.height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    let raf = 0
    let last = 0
    const frame = (t: number) => {
      if (t - last >= 33) { // ~30 fps is plenty
        last = t
        draw(ctx, size.width, size.height, graphRef.current, layoutRef.current, hoverRef.current, t)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [visible, size.width, size.height])

  if (!visible) return null

  const counts = countByKind(graph)
  const hovered = hover ? layout.nodes.find(n => n.id === hover.id) : undefined

  const pointer = (e: React.MouseEvent | React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  return (
    <div
      ref={wrapRef}
      data-testid="fleet-map"
      data-profiles={counts.profile}
      data-sessions={counts.session}
      data-kanban={counts.kanban}
      data-supermemory={counts.supermemory}
      data-profile-names={graph.nodes.filter(n => n.kind === 'profile').map(n => n.label).join('|')}
      className="absolute inset-0"
      style={{ zIndex: Z.info - 5, background: COLORS.void }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height, display: 'block', cursor: hovered?.openId ? 'pointer' : 'default' }}
        onPointerMove={e => {
          const p = pointer(e)
          const n = nodeAt(layout, p.x, p.y)
          setHover(prev => (n ? (prev?.id === n.id ? prev : { id: n.id, x: p.x, y: p.y }) : prev ? null : prev))
        }}
        onPointerLeave={() => setHover(null)}
        onClick={e => {
          const p = pointer(e)
          const n = nodeAt(layout, p.x, p.y)
          if (n?.openId) onOpenSession?.(n.openId)
        }}
      />
      {graph.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none font-mono text-xs" style={{ color: COLORS.textMuted }}>
          No Hermes profiles with sessions yet
        </div>
      )}
      {hovered && hover && (
        <div
          className="absolute pointer-events-none px-2 py-1 rounded font-mono text-[10px]"
          style={{
            left: Math.min(hover.x + 12, Math.max(size.width - 190, 0)), top: Math.max(hover.y - 34, 0),
            background: COLORS.holoBg05, border: `1px solid ${COLORS.holoBorder12}`, color: COLORS.textPrimary, maxWidth: 180,
          }}
        >
          <div className="truncate">{hovered.kind === 'session' ? `${hovered.label}` : hovered.label}</div>
          <div style={{ color: COLORS.textMuted }}>
            {hovered.kind} · {hovered.status}{hovered.sublabel ? ` · ${hovered.sublabel}` : ''}
            {hovered.hiddenSessions ? ` · +${hovered.hiddenSessions} older` : ''}
          </div>
        </div>
      )}
    </div>
  )
}

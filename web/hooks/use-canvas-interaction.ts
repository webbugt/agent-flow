import { useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM } from '@/lib/agent-types'
import { CAMERA } from '@/lib/canvas-constants'
import { solidAgents, solidToolCalls } from '@/hooks/simulation/fleet-presence-scene'
import {
  findAgentAt as findAgentAtPure,
  findToolCallAt as findToolCallAtPure,
  findBubbleAgentAt as findBubbleAgentAtPure,
  findDiscoveryAt as findDiscoveryAtPure,
} from '@/components/agent-visualizer/canvas/index'
import { findCostPillAt } from '@/lib/costs/overlay'
import { getCostPillRects } from '@/lib/cost-overlay-store'
import { FLEET_WHEEL_STEP, wheelZoomFactor, zoomAt } from '@/lib/fleet/fleet-camera'
import type { CameraInputKind } from '@/lib/fleet/camera-state'
import { exceedsPanThreshold, gestureStep, snapshotOf, type Point, type TouchSnapshot } from '@/lib/touch-gestures'
import type { Transform } from './use-canvas-camera'

/** After a touch moved the map, compatibility mouse events inside this window are not clicks, ms. */
const TOUCH_CLICK_GUARD_MS = 500

/** A cost pill under the pointer: the agent and the pill's rectangle in viewport (client) coordinates. */
export interface CostPillHit {
  agentId: string
  left: number
  top: number
  width: number
  height: number
}

interface InteractionCallbacks {
  onAgentClick: (agentId: string | null) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  onDiscoveryClick?: (discoveryId: string | null) => void
  /** Pointer over a cost pill (`hover`) or a click / tap on one (`tap`); null = left the pill / tapped elsewhere. */
  onCostPill?: (hit: CostPillHit | null, how: 'hover' | 'tap') => void
}

interface InteractionOptions {
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
    /** Fleet map: ids of ghosts (leaving nodes), which are drawn but cannot be hovered, clicked or dragged. */
    ghosts?: ReadonlySet<string>
  } & InteractionCallbacks>
  transformRef: MutableRefObject<Transform>
  /** Any user input tells the camera, which stops a running intro animation at once. */
  interrupt: (kind: CameraInputKind) => void
  panVelocityRef: MutableRefObject<{ vx: number; vy: number; active: boolean }>
  simTimeRef: MutableRefObject<number>
  screenToCanvas: (screenX: number, screenY: number) => { x: number; y: number }
  doZoomToFit: () => void
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  /** Fleet map: the plain scroll wheel zooms (centred on the pointer) instead of panning. */
  wheelZooms?: boolean
}

export function useCanvasInteraction({
  drawPropsRef,
  transformRef,
  interrupt,
  panVelocityRef,
  simTimeRef,
  screenToCanvas,
  doZoomToFit,
  mainCanvasRef,
  wheelZooms = false,
}: InteractionOptions) {
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const dragTargetRef = useRef<{ type: 'canvas' | 'agent'; id?: string; startX: number; startY: number } | null>(null)
  isDraggingRef.current = isDragging

  // Floaty agent drag
  const dragLerpRef = useRef<{ targetX: number; targetY: number; agentId: string } | null>(null)

  // Pan tracking
  const lastPanPosRef = useRef({ x: 0, y: 0, time: 0 })
  const lastHoveredIdRef = useRef<string | null>(null)
  const lastCostPillRef = useRef<string | null>(null)
  /** Time of the last touch that moved the map: the mouse events the browser may still synthesize after it must not click. */
  const lastTouchPanRef = useRef(-Infinity)

  // ─── Hit detection wrappers ─────────────────────────────────────────────

  const findAgentAt = useCallback((x: number, y: number): string | null => {
    const { agents, ghosts } = drawPropsRef.current
    return findAgentAtPure(x, y, ghosts ? solidAgents(agents, ghosts) : agents)
  }, [drawPropsRef])

  const findToolCallAt = useCallback((x: number, y: number): string | null => {
    const { toolCalls, ghosts } = drawPropsRef.current
    return findToolCallAtPure(x, y, ghosts ? solidToolCalls(toolCalls, ghosts) : toolCalls)
  }, [drawPropsRef])

  const findBubbleAgentAt = useCallback((x: number, y: number): string | null => {
    const { agents, ghosts } = drawPropsRef.current
    return findBubbleAgentAtPure(x, y, ghosts ? solidAgents(agents, ghosts) : agents, simTimeRef.current)
  }, [drawPropsRef, simTimeRef])

  const findDiscoveryAt = useCallback((x: number, y: number): string | null => {
    return findDiscoveryAtPure(x, y, drawPropsRef.current.discoveries)
  }, [drawPropsRef])

  /** The cost pill at a canvas point, with its viewport rectangle (pill rects are registered per frame by drawCostLabels). */
  const costPillAt = useCallback((x: number, y: number): CostPillHit | null => {
    const rects = getCostPillRects()
    if (rects.length === 0) return null
    const id = findCostPillAt(x, y, rects)
    if (!id) return null
    const r = rects.find(q => q.id === id)
    const o = mainCanvasRef.current?.getBoundingClientRect()
    if (!r || !o) return null
    const t = transformRef.current
    return { agentId: id, left: o.left + t.x + r.x * t.scale, top: o.top + t.y + r.y * t.scale, width: r.w * t.scale, height: r.h * t.scale }
  }, [mainCanvasRef, transformRef])

  // ─── Mouse Handlers ─────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY)
    const agentId = findAgentAt(pos.x, pos.y)
    if (e.button === 0) {
      interrupt('press')
      panVelocityRef.current = { vx: 0, vy: 0, active: false }
      setIsDragging(true)
      if (agentId) {
        dragTargetRef.current = { type: 'agent', id: agentId, startX: e.clientX, startY: e.clientY }
      } else {
        dragTargetRef.current = { type: 'canvas', startX: e.clientX, startY: e.clientY }
        lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: performance.now() }
      }
    }
  }, [screenToCanvas, findAgentAt, panVelocityRef, interrupt])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY)
    const pill = costPillAt(pos.x, pos.y)
    if ((pill?.agentId ?? null) !== lastCostPillRef.current) {
      lastCostPillRef.current = pill?.agentId ?? null
      drawPropsRef.current.onCostPill?.(pill, 'hover')
    }
    const hoveredId = findAgentAt(pos.x, pos.y)
    if (hoveredId !== lastHoveredIdRef.current) {
      lastHoveredIdRef.current = hoveredId
      drawPropsRef.current.onAgentHover(hoveredId)
    }
    const dragging = isDraggingRef.current
    const dragTarget = dragTargetRef.current
    if (dragging && dragTarget) {
      if (dragTarget.type === 'canvas') {
        interrupt('drag')
        const dx = e.clientX - dragTarget.startX
        const dy = e.clientY - dragTarget.startY
        const t = transformRef.current
        transformRef.current = { ...t, x: t.x + dx, y: t.y + dy }
        const now = performance.now()
        const elapsed = Math.max(now - lastPanPosRef.current.time, 1) / 1000
        panVelocityRef.current = {
          vx: (e.clientX - lastPanPosRef.current.x) / elapsed * CAMERA.velocityScale,
          vy: (e.clientY - lastPanPosRef.current.y) / elapsed * CAMERA.velocityScale,
          active: false,
        }
        lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: now }
        dragTargetRef.current = { ...dragTarget, startX: e.clientX, startY: e.clientY }
      } else if (dragTarget.type === 'agent' && dragTarget.id) {
        const screenDist = Math.abs(e.clientX - dragTarget.startX) + Math.abs(e.clientY - dragTarget.startY)
        if (screenDist > ANIM.dragThresholdPx) {
          dragLerpRef.current = { targetX: pos.x, targetY: pos.y, agentId: dragTarget.id }
        }
      }
    }
  }, [screenToCanvas, findAgentAt, costPillAt, drawPropsRef, interrupt, transformRef, panVelocityRef])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (performance.now() - lastTouchPanRef.current < TOUCH_CLICK_GUARD_MS) {
      setIsDragging(false)
      dragTargetRef.current = null
      return
    }
    if (e.button === 2) {
      setIsDragging(false)
      dragTargetRef.current = null
      return
    }
    const dt_ = dragTargetRef.current
    if (dt_?.type === 'canvas') {
      const v = panVelocityRef.current
      if (Math.abs(v.vx) > ANIM.inertiaThreshold || Math.abs(v.vy) > ANIM.inertiaThreshold) {
        panVelocityRef.current.active = true
      }
    }
    const screenDist = dt_
      ? Math.abs(e.clientX - dt_.startX) + Math.abs(e.clientY - dt_.startY)
      : 0
    if (screenDist < ANIM.dragThresholdPx) {
      const pos = screenToCanvas(e.clientX, e.clientY)
      const agentId = findAgentAt(pos.x, pos.y)
      const p = drawPropsRef.current
      const pill = costPillAt(pos.x, pos.y)
      if (pill) {
        // A click or tap on a cost pill pins its tooltip (the touch way to read it); it does not select the agent.
        p.onCostPill?.(pill, 'tap')
      } else if (agentId) {
        p.onCostPill?.(null, 'tap')
        p.onAgentClick(agentId)
      } else {
        const bubbleAgentId = findBubbleAgentAt(pos.x, pos.y)
        if (bubbleAgentId) {
          p.onAgentClick(bubbleAgentId)
        } else {
          const toolId = findToolCallAt(pos.x, pos.y)
          if (toolId) {
            p.onToolCallClick?.(toolId)
          } else {
            const discId = findDiscoveryAt(pos.x, pos.y)
            if (discId) {
              p.onDiscoveryClick?.(discId)
            } else {
              p.onCostPill?.(null, 'tap')
              p.onAgentClick(null)
              p.onToolCallClick?.(null)
              p.onDiscoveryClick?.(null)
            }
          }
        }
      }
    }
    if (dragLerpRef.current) {
      drawPropsRef.current.onAgentDrag(dragLerpRef.current.agentId, dragLerpRef.current.targetX, dragLerpRef.current.targetY)
      dragLerpRef.current = null
    }
    setIsDragging(false)
    dragTargetRef.current = null
  }, [screenToCanvas, findAgentAt, costPillAt, findBubbleAgentAt, findToolCallAt, findDiscoveryAt, drawPropsRef, panVelocityRef])

  // Wheel handler attached as native event (passive: false) to allow preventDefault
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault()
    interrupt(e.ctrlKey ? 'pinch' : 'wheel')
    if (wheelZooms) {
      // Fleet map: wheel, ctrl+wheel and trackpad pinch (ctrl+wheel) all zoom around the pointer; drag pans.
      const rect = mainCanvasRef.current?.getBoundingClientRect()
      if (!rect) return
      panVelocityRef.current = { vx: 0, vy: 0, active: false }
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode, FLEET_WHEEL_STEP)
      transformRef.current = zoomAt(transformRef.current, e.clientX - rect.left, e.clientY - rect.top, factor, { min: CAMERA.minZoom, max: CAMERA.maxZoom })
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? CAMERA.zoomStepDown : CAMERA.zoomStepUp
      const rect = mainCanvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const prev = transformRef.current
      const newScale = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, prev.scale * delta))
      transformRef.current = { scale: newScale, x: mouseX - (mouseX - prev.x) * (newScale / prev.scale), y: mouseY - (mouseY - prev.y) * (newScale / prev.scale) }
    } else {
      const prev = transformRef.current
      transformRef.current = { ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }
    }
  }
  // ─── Touch: one finger pans, two fingers pinch ──────────────────────────
  // Native touch events (not React's, which are passive): touchmove must be able to preventDefault, or the browser
  // scrolls / zooms the page instead of the map. The canvas also gets `touch-action: none` (see canvas.tsx), which
  // is what stops the browser's own pinch zoom on the page. A tap (no travel past the threshold) is left alone: the
  // browser's compatibility mouse events still arrive and select the node through the mouse handlers above.
  const touchRef = useRef<{ prev: TouchSnapshot | null; start: Point | null; panning: boolean }>({ prev: null, start: null, panning: false })

  useEffect(() => {
    const canvas = mainCanvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => handleWheelRef.current(e)
    const pointsOf = (list: TouchList): Point[] => {
      const rect = canvas.getBoundingClientRect()
      return Array.from({ length: Math.min(list.length, 2) }, (_, i) => ({ x: list[i].clientX - rect.left, y: list[i].clientY - rect.top }))
    }
    const onTouchStart = (e: TouchEvent) => {
      // A touch is user input: it stops a running intro animation at once (mouse events only come after it ends).
      interrupt(e.touches.length > 1 ? 'pinch' : 'press')
      panVelocityRef.current = { vx: 0, vy: 0, active: false }
      const snap = snapshotOf(pointsOf(e.touches))
      const t = touchRef.current
      // A second finger makes it a pinch at once; a lone finger is a tap until it travels.
      t.panning = t.panning || (snap?.count === 2)
      t.prev = snap
      t.start = t.start && e.touches.length > 1 ? t.start : snap ? snap.mid : null
      if (e.touches.length === 1) lastPanPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: performance.now() }
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = touchRef.current
      const snap = snapshotOf(pointsOf(e.touches))
      if (!snap || !t.prev) return
      if (t.prev.count !== snap.count) { t.prev = snap; return }
      if (!t.panning) {
        if (!t.start || !exceedsPanThreshold(t.start, snap.mid)) return
        t.panning = true
      }
      if (e.cancelable) e.preventDefault()
      lastTouchPanRef.current = performance.now()
      interrupt(snap.count === 2 ? 'pinch' : 'drag')
      transformRef.current = gestureStep(transformRef.current, t.prev, snap, { min: CAMERA.minZoom, max: CAMERA.maxZoom })
      t.prev = snap
      if (snap.count === 1) {
        const now = performance.now()
        const cx = e.touches[0].clientX
        const cy = e.touches[0].clientY
        const elapsed = Math.max(now - lastPanPosRef.current.time, 1) / 1000
        panVelocityRef.current = {
          vx: (cx - lastPanPosRef.current.x) / elapsed * CAMERA.velocityScale,
          vy: (cy - lastPanPosRef.current.y) / elapsed * CAMERA.velocityScale,
          active: false,
        }
        lastPanPosRef.current = { x: cx, y: cy, time: now }
      } else {
        panVelocityRef.current = { vx: 0, vy: 0, active: false }
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      const t = touchRef.current
      if (e.touches.length > 0) {
        // One finger of a pinch was lifted: the other keeps panning from where it is (no jump).
        t.prev = snapshotOf(pointsOf(e.touches))
        lastPanPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: performance.now() }
        return
      }
      if (t.panning && performance.now() - lastPanPosRef.current.time < 100) {
        const v = panVelocityRef.current
        if (Math.abs(v.vx) > ANIM.inertiaThreshold || Math.abs(v.vy) > ANIM.inertiaThreshold) panVelocityRef.current.active = true
      }
      t.prev = null
      t.start = null
      t.panning = false
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('touchend', onTouchEnd, { passive: true })
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      canvas.removeEventListener('wheel', handler)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      canvas.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [mainCanvasRef, interrupt, transformRef, panVelocityRef])

  const handleDoubleClick = useCallback(() => {
    doZoomToFit()
  }, [doZoomToFit])

  const handleContextMenuEvent = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const pos = screenToCanvas(e.clientX, e.clientY)
    const agentId = findAgentAt(pos.x, pos.y)
    drawPropsRef.current.onContextMenu(e, agentId ? 'agent' : 'canvas', agentId ?? undefined)
  }, [screenToCanvas, findAgentAt, drawPropsRef])

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false)
    dragTargetRef.current = null
    dragLerpRef.current = null
    if (lastCostPillRef.current !== null) {
      lastCostPillRef.current = null
      drawPropsRef.current.onCostPill?.(null, 'hover')
    }
    if (lastHoveredIdRef.current !== null) {
      lastHoveredIdRef.current = null
      drawPropsRef.current.onAgentHover(null)
    }
  }, [drawPropsRef])

  /** Call from draw loop to update floaty drag lerp */
  const updateDragLerp = useCallback((agents: Map<string, Agent>, onAgentDrag: (id: string, x: number, y: number) => void) => {
    const lerp = dragLerpRef.current
    if (lerp) {
      const agent = agents.get(lerp.agentId)
      if (agent) {
        const lerpFactor = ANIM.dragLerp
        const nx = agent.x + (lerp.targetX - agent.x) * lerpFactor
        const ny = agent.y + (lerp.targetY - agent.y) * lerpFactor
        onAgentDrag(lerp.agentId, nx, ny)
      }
    }
  }, [])

  return {
    isDragging,
    dragLerpRef,
    handlers: {
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp,
      onDoubleClick: handleDoubleClick,
      onContextMenu: handleContextMenuEvent,
      onMouseLeave: handleMouseLeave,
    },
    updateDragLerp,
  }
}

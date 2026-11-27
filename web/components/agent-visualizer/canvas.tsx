'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { Agent, Particle, Edge, Discovery, DepthParticle, NODE } from '@/lib/agent-types'
import type { SimulationState } from '@/hooks/simulation/types'
import { getStateColor } from '@/lib/colors'
import { ANIM_SPEED, PERF_OVERLAY, PERF_OVERLAY_ENABLED } from '@/lib/canvas-constants'
import { cloudGeometries } from '@/lib/fleet/fleet-cloud-geometry'
import { fleetNow } from '@/lib/fleet/fleet-clock'
import { animatedView, ghostIdsOf } from '@/hooks/simulation/fleet-presence-scene'
import { LABEL_MIN_PX } from '@/lib/fleet/fleet-labels'
import { BloomRenderer } from './bloom-renderer'
import { createDepthParticles, updateDepthParticles, drawBackground } from './background-layer'
import {
  type VisualEffect,
  drawTetherLine,
  drawEffects,
  drawAgents,
  drawMessageBubblesWorld,
  drawEdges, getActiveEdgeIds,
  drawClouds, drawFleetLabels, drawFleetLinks, drawPulses,
  drawParticles, buildEdgeMap,
  drawToolCalls,
  drawDiscoveries, drawDiscoveryConnections,
  drawCostLabels, drawCostSummaryPanel,
  detectStateChanges as detectStateChangesPure,
} from './canvas/index'
import { useCanvasCamera } from '@/hooks/use-canvas-camera'
import { useCanvasInteraction, type CostPillHit } from '@/hooks/use-canvas-interaction'
import { useScreensaverCursorHidden } from '@/hooks/use-screensaver-cursor'
import { SHOT_MODE, registerShotHook, type ShotRect } from '@/lib/shot-mode'
import { costPillRect, agentCostOf } from './canvas/draw-cost'
import { CostTooltip } from './cost-tooltip'
import { setCostPillRects } from '@/lib/cost-overlay-store'

function unregisterAll(...fns: Array<() => void>): () => void {
  return () => { for (const f of fns) f() }
}

interface CanvasProps {
  /** Ref to simulation state — read every frame without React re-renders */
  simulationRef: React.RefObject<SimulationState>
  selectedAgentId: string | null
  hoveredAgentId: string | null
  showStats: boolean
  showHexGrid: boolean
  zoomToFitTrigger?: number
  pauseAutoFit?: boolean
  onAgentClick: (agentId: string | null) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  selectedToolCallId?: string | null
  onDiscoveryClick?: (discoveryId: string | null) => void
  selectedDiscoveryId?: string | null
  showCostOverlay?: boolean
  /** Screensaver mode: tool calls are drawn as short chips, no task text, no pointer. The UI around is hidden by the parent. */
  screensaver?: boolean
  /**
   * Fleet map mode: the plain wheel zooms, a click on a node keeps the camera where it is.
   * `controlsRef` is filled with the on-screen button actions.
   */
  fleetView?: boolean
  controlsRef?: React.MutableRefObject<CanvasControls | null>
}

/** Camera actions for on-screen buttons. */
export interface CanvasControls {
  zoomBy: (factor: number) => void
  fit: () => void
  /** True once the user zoomed or panned (auto-fit is off until the next explicit fit). */
  hasNavigated: () => boolean
}

export function AgentCanvas({
  simulationRef,
  selectedAgentId, hoveredAgentId, showStats, showHexGrid, zoomToFitTrigger, pauseAutoFit,
  onAgentClick, onAgentHover, onAgentDrag, onContextMenu, onToolCallClick, selectedToolCallId, onDiscoveryClick, selectedDiscoveryId, showCostOverlay, screensaver = false, fleetView = false, controlsRef,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Screensaver: the cursor is hidden until the pointer moves, and hides again after 500 ms of stillness.
  const cursorHidden = useScreensaverCursorHidden(screensaver)
  const mainCanvasRef = useRef<HTMLCanvasElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  // Cost pill tooltip: hover shows it, a click or tap pins it (touch)
  const [pillHover, setPillHover] = useState<CostPillHit | null>(null)
  const [pillPinned, setPillPinned] = useState<CostPillHit | null>(null)
  const onCostPill = useCallback((hit: CostPillHit | null, how: 'hover' | 'tap') => {
    if (how === 'hover') setPillHover(hit)
    else setPillPinned(prev => (hit === null || prev?.agentId === hit.agentId ? null : hit))
  }, [])
  useEffect(() => {
    if (showCostOverlay) return
    setPillHover(null); setPillPinned(null); setCostPillRects([])
  }, [showCostOverlay])
  const animationRef = useRef<number>(0)
  const timeRef = useRef(0)
  const simTimeRef = useRef(0)
  const bloomRef = useRef<BloomRenderer | null>(null)
  const depthParticlesRef = useRef<DepthParticle[]>([])
  const lastFrameTimeRef = useRef(0)
  const dprRef = useRef(1)

  // Effects system
  const effectsRef = useRef<VisualEffect[]>([])
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())

  // Rate-limited error logging for the draw loop (avoid flooding console)
  const lastDrawErrorRef = useRef(0)

  // Performance overlay state
  const perfRef = useRef({
    frames: 0,
    lastFpsUpdate: 0,
    fps: 0,
    frameTimeMs: 0,
    frameTimes: [] as number[],
    p95: 0,
  })

  // Caches for per-frame lookups — avoid rebuilding Set/Map every ~16ms
  const edgeLookupCacheRef = useRef<{
    particles: Particle[]
    edges: Edge[]
    activeEdgeIds: Set<string>
    edgeMap: Map<string, Edge>
  }>({ particles: [], edges: [], activeEdgeIds: new Set(), edgeMap: new Map() })

  // ─── Stable refs for animation loop & event handlers ────────────────────
  // Simulation data (agents, particles, etc.) is synced from simulationRef
  // at the top of each draw frame, so it's always fresh even without re-renders.
  const sim = simulationRef.current
  // Ghosts (leaving nodes) are drawn but not hit-testable. Recomputed only when the presence stamps are a new map.
  const ghostCacheRef = useRef<{ presence: SimulationState['presence']; ids: ReadonlySet<string> }>({ presence: undefined, ids: new Set() })
  const ghostsOf = (s: SimulationState): ReadonlySet<string> => {
    const c = ghostCacheRef.current
    if (c.presence !== s.presence) ghostCacheRef.current = { presence: s.presence, ids: ghostIdsOf(s) }
    return ghostCacheRef.current.ids
  }
  const makeDrawProps = (prev?: { isDragging: boolean }) => ({
    agents: sim.agents, toolCalls: sim.toolCalls,
    particles: sim.particles, edges: sim.edges, discoveries: sim.discoveries,
    clouds: sim.clouds, ghosts: ghostsOf(sim),
    selectedAgentId, hoveredAgentId, showStats, showHexGrid,
    showCostOverlay, selectedToolCallId, selectedDiscoveryId, screensaver,
    simTime: sim.currentTime, pauseAutoFit, dimensions,
    onAgentDrag, onAgentClick, onAgentHover, onContextMenu,
    onToolCallClick, onDiscoveryClick, onCostPill,
    isDragging: prev?.isDragging ?? false,
  })
  const drawPropsRef = useRef(makeDrawProps())
  drawPropsRef.current = makeDrawProps(drawPropsRef.current)

  // ─── Camera ─────────────────────────────────────────────────────────────
  const {
    transformRef, userHasNavigatedRef, interrupt, panVelocityRef,
    screenToCanvas, doZoomToFit, zoomBy, updateCamera,
  } = useCanvasCamera({
    mainCanvasRef, drawPropsRef, simTimeRef, dimensions,
    agentCount: sim.agents.size, zoomToFitTrigger, selectedAgentId, fleetView, screensaver,
  })

  useEffect(() => {
    if (!controlsRef) return
    controlsRef.current = { zoomBy, fit: doZoomToFit, hasNavigated: () => userHasNavigatedRef.current }
    return () => { controlsRef.current = null }
  }, [controlsRef, zoomBy, doZoomToFit, userHasNavigatedRef])

  // ─── Interaction ────────────────────────────────────────────────────────
  const {
    isDragging, handlers, updateDragLerp,
  } = useCanvasInteraction({
    drawPropsRef, transformRef, interrupt, panVelocityRef,
    simTimeRef, screenToCanvas, doZoomToFit, mainCanvasRef, wheelZooms: fleetView,
  })

  // Keep drawPropsRef in sync with interaction state
  drawPropsRef.current.isDragging = isDragging

  // ─── Setup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    bloomRef.current = new BloomRenderer(0.5)
    depthParticlesRef.current = createDepthParticles(dimensions.width, dimensions.height)
    return () => { bloomRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- particles created once, resized by draw loop
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const dpr = window.devicePixelRatio || 1
    dprRef.current = dpr
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        const h = entry.contentRect.height
        setDimensions({ width: w, height: h })
        bloomRef.current?.resize(w * dpr, h * dpr)
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ─── Detect state changes → spawn effects ──────────────────────────────

  const detectStateChanges = useCallback(() => {
    const { agents, toolCalls } = drawPropsRef.current
    const { effects, newAgentStates, newToolStates } = detectStateChangesPure(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    effectsRef.current.push(...effects)
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates
  }, [])

  // ─── Main draw loop ────────────────────────────────────────────────────

  // Stable ref so the rAF loop always calls the latest draw without
  // re-subscribing when the callback identity changes.
  const drawRef = useRef<(timestamp: number) => void>(() => {})

  const draw = useCallback((timestamp: number) => {
    animationRef.current = requestAnimationFrame((ts) => drawRef.current(ts))

    const canvas = mainCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    try {
      // Sync simulation data from ref — always fresh, independent of React renders
      {
        const s = simulationRef.current
        const p = drawPropsRef.current
        p.agents = s.agents
        p.toolCalls = s.toolCalls
        p.particles = s.particles
        p.edges = s.edges
        p.discoveries = s.discoveries
        p.ghosts = ghostsOf(s)
        p.simTime = s.currentTime
      }

      const {
        agents, toolCalls, particles, edges, discoveries,
        selectedAgentId, hoveredAgentId, showStats, showHexGrid,
        showCostOverlay, selectedToolCallId, selectedDiscoveryId, screensaver,
        simTime, pauseAutoFit, dimensions, onAgentDrag,
        isDragging,
      } = drawPropsRef.current
      const transform = transformRef.current

      // ?shot=1 (screenshot harness): a fixed clock, so the picture does not depend on timing
      const deltaTime = SHOT_MODE ? 0 : lastFrameTimeRef.current ? (timestamp - lastFrameTimeRef.current) / 1000 : ANIM_SPEED.defaultDeltaTime
      lastFrameTimeRef.current = timestamp
      timeRef.current += deltaTime
      if (simTime != null) simTimeRef.current = simTime

      const dpr = dprRef.current
      const w = dimensions.width
      const h = dimensions.height

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
        ctx.scale(dpr, dpr)
      }

      // Camera physics (inertia + auto-fit)
      updateCamera(isDragging, pauseAutoFit)

      // Floaty agent drag
      updateDragLerp(agents, onAgentDrag)

      // Detect state changes → visual effects
      detectStateChanges()
      // Screenshot mode: transient effects would stay at age 0 forever with a fixed clock
      if (SHOT_MODE) effectsRef.current.length = 0

      // Update effects (mutate in place to avoid GC pressure)
      {
        const effects = effectsRef.current
        let writeIdx = 0
        for (let i = 0; i < effects.length; i++) {
          effects[i].age += deltaTime
          if (effects[i].age < effects[i].duration) {
            if (writeIdx !== i) effects[writeIdx] = effects[i]
            writeIdx++
          }
        }
        effects.length = writeIdx
      }

      ctx.clearRect(0, 0, w, h)
      updateDepthParticles(depthParticlesRef.current, deltaTime, w, h)

      let activeAgentPos: { x: number; y: number; color: string } | undefined
      for (const [, agent] of agents) {
        if (agent.state === 'thinking' || agent.state === 'tool_calling' || agent.state === 'waiting_permission') {
          activeAgentPos = { x: agent.x, y: agent.y, color: getStateColor(agent.state) }
          break
        }
      }

      drawBackground(ctx, w, h, depthParticlesRef.current, transform, showHexGrid, timeRef.current, activeAgentPos)

      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.scale, transform.scale)

      // Pre-compute shared lookup structures — cached across frames when inputs are unchanged
      const elCache = edgeLookupCacheRef.current
      let activeEdgeIds: Set<string>
      let edgeMap: Map<string, Edge>
      if (elCache.particles === particles && elCache.edges === edges) {
        activeEdgeIds = elCache.activeEdgeIds
        edgeMap = elCache.edgeMap
      } else {
        activeEdgeIds = getActiveEdgeIds(particles)
        edgeMap = buildEdgeMap(edges)
        edgeLookupCacheRef.current = { particles, edges, activeEdgeIds, edgeMap }
      }

      // Fleet map only: clouds (halo + profile caption) under everything, then the cloud-to-resource links.
      const fleet = simulationRef.current
      // Entry/exit: nodes and clouds in transition are drawn with their own opacity and size for this frame.
      // The scene itself (and so the camera's fit) is not touched by it.
      const view = fleet.presence ? animatedView(fleet, fleetNow()) : null
      const vAgents = view?.agents ?? agents
      const vTools = view?.toolCalls ?? toolCalls
      const vEdges = view?.edges ?? edges
      const vClouds = view?.clouds ?? fleet.clouds
      const fade = view?.fade
      const cloudGeoms = vClouds && vClouds.length > 0 ? cloudGeometries(vClouds, vAgents) : null
      const wallNow = Date.now()
      if (cloudGeoms && vClouds) drawClouds(ctx, vClouds, cloudGeoms, timeRef.current, fade)
      drawDiscoveryConnections(ctx, discoveries, vAgents)
      drawEdges(ctx, vEdges, vAgents, vTools, activeEdgeIds, timeRef.current)
      if (cloudGeoms) drawFleetLinks(ctx, vEdges, vAgents, cloudGeoms, wallNow)
      drawToolCalls(ctx, vTools, timeRef.current, selectedToolCallId, cloudGeoms ? LABEL_MIN_PX - 2 : 0, screensaver)
      drawDiscoveries(ctx, discoveries, vAgents, selectedDiscoveryId)
      drawAgents(ctx, vAgents, selectedAgentId, hoveredAgentId, showStats, timeRef.current, !cloudGeoms, wallNow)
      if (cloudGeoms && vClouds) drawFleetLabels(ctx, vClouds, cloudGeoms, vAgents, selectedAgentId, hoveredAgentId, !screensaver, wallNow, fade)
      drawMessageBubblesWorld(ctx, vAgents, simTimeRef.current)
      if (showCostOverlay) drawCostLabels(ctx, vAgents, vTools)
      drawParticles(ctx, particles, edgeMap, vAgents, vTools, timeRef.current)
      if (cloudGeoms && fleet.pulses) drawPulses(ctx, fleet.pulses, vEdges, vAgents, cloudGeoms, wallNow)
      drawEffects(ctx, effectsRef.current)

      if (selectedAgentId) {
        const agent = agents.get(selectedAgentId)
        if (agent) drawTetherLine(ctx, agent, transform, h)
      }

      ctx.restore()

      if (showCostOverlay) drawCostSummaryPanel(ctx, agents, toolCalls)
      if (bloomRef.current) bloomRef.current.apply(canvas, ctx)

      // ─── Performance overlay (enabled via ?perf or ?stress) ──────────
      if (PERF_OVERLAY_ENABLED) {
        const perf = perfRef.current
        const frameEnd = performance.now()
        const frameMs = frameEnd - (timestamp || frameEnd)
        perf.frameTimes.push(frameMs)
        if (perf.frameTimes.length > PERF_OVERLAY.maxFrameSamples) perf.frameTimes.shift()
        perf.frames++
        perf.frameTimeMs = frameMs
        if (frameEnd - perf.lastFpsUpdate >= PERF_OVERLAY.updateIntervalMs) {
          perf.fps = perf.frames
          perf.frames = 0
          perf.lastFpsUpdate = frameEnd
          const sorted = [...perf.frameTimes].sort((a, b) => a - b)
          perf.p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
        }
        const po = PERF_OVERLAY
        const textX = po.x + po.padding
        let textY = po.y + po.lineHeight + 2
        ctx.save()
        ctx.fillStyle = po.bgColor
        ctx.fillRect(po.x, po.y, po.width, po.height)
        ctx.font = po.font
        ctx.fillStyle = perf.fps < po.fpsWarning ? po.fpsWarningColor : perf.fps < po.fpsCaution ? po.fpsCautionColor : po.fpsGoodColor
        ctx.fillText(`FPS: ${perf.fps}`, textX, textY); textY += po.lineHeight
        ctx.fillStyle = po.textColor
        ctx.fillText(`Frame: ${frameMs.toFixed(1)}ms  P95: ${perf.p95.toFixed(1)}ms`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Agents: ${agents.size}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Tool calls: ${toolCalls.size}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Particles: ${particles.length}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Edges: ${edges.length}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Discoveries: ${discoveries.length}`, textX, textY)
        ctx.restore()
      }

    } catch (err) {
      // Log at most once every 5s to avoid flooding the console
      const now = Date.now()
      if (now - lastDrawErrorRef.current > 5000) {
        lastDrawErrorRef.current = now
        console.warn('[AgentCanvas] draw error:', err)
      }
    }
  }, [detectStateChanges, updateCamera, updateDragLerp, transformRef])

  drawRef.current = draw

  // ─── Screenshot harness hooks (only with ?shot=1, see lib/shot-mode.ts) ───
  const shotCameraRef = useRef({ sig: '', at: 0 })
  useEffect(() => {
    if (!SHOT_MODE) return
    const canvasOrigin = () => mainCanvasRef.current?.getBoundingClientRect() ?? null
    const findAgent = (name: string): Agent | undefined => {
      const agents = drawPropsRef.current.agents
      if (name === 'first') return agents.values().next().value
      return agents.get(name) ?? Array.from(agents.values()).find(a => a.name === name)
    }
    const offs = unregisterAll(
      registerShotHook('agentNames', () => Array.from(drawPropsRef.current.agents.values()).map(a => a.name)),
      registerShotHook('agentRect', (name): ShotRect | null => {
        const a = findAgent(name); const o = canvasOrigin()
        if (!a || !o) return null
        const t = transformRef.current
        const r = (a.isMain ? NODE.radiusMain : NODE.radiusSub) * t.scale
        return { x: o.left + t.x + a.x * t.scale - r, y: o.top + t.y + a.y * t.scale - r, w: 2 * r, h: 2 * r }
      }),
      registerShotHook('pillRect', (name): ShotRect | null => {
        const o = canvasOrigin(); const ctx = mainCanvasRef.current?.getContext('2d')
        if (!o || !ctx) return null
        // 'first' = the first agent that has a cost pill (the main node often has none)
        const a = name === 'first'
          ? Array.from(drawPropsRef.current.agents.values()).find(x => costPillRect(ctx, x) !== null)
          : findAgent(name)
        if (!a) return null
        const p = costPillRect(ctx, a)
        if (!p) return null
        const t = transformRef.current
        return { x: o.left + t.x + p.x * t.scale, y: o.top + t.y + p.y * t.scale, w: p.w * t.scale, h: p.h * t.scale }
      }),
      registerShotHook('settled', () => {
        const t = transformRef.current
        const sig = `${t.x.toFixed(2)},${t.y.toFixed(2)},${t.scale.toFixed(4)}`
        const now = performance.now()
        if (sig !== shotCameraRef.current.sig) { shotCameraRef.current = { sig, at: now }; return false }
        return now - shotCameraRef.current.at >= 400
      }),
    )
    return offs
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only; registered once
  }, [])

  useEffect(() => {
    const loop = (timestamp: number) => drawRef.current(timestamp)
    animationRef.current = requestAnimationFrame(loop)
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- drawRef is stable; rAF loop set up once
  }, [])

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden" style={{ cursor: cursorHidden ? 'none' : isDragging ? 'grabbing' : 'grab' }}>
      <canvas
        ref={mainCanvasRef}
        style={{ width: dimensions.width, height: dimensions.height }}
        {...handlers}
        className="w-full h-full"
      />
      {showCostOverlay && (() => {
        const shown = pillPinned ?? pillHover
        const agent = shown ? simulationRef.current.agents.get(shown.agentId) : undefined
        if (!shown || !agent) return null
        return <CostTooltip cost={agentCostOf(agent)} anchor={shown} pinned={pillPinned !== null} onClose={() => setPillPinned(null)} />
      })()}
    </div>
  )
}

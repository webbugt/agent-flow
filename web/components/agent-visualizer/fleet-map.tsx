"use client"

import { useEffect, useMemo, useState } from "react"
import { COLORS } from "@/lib/colors"
import { Z, type SimulationEvent } from "@/lib/agent-types"
import type { FleetInstance, FleetSelectionView, SessionLike } from "@/lib/fleet/fleet-model"
import type { PublicKanbanBoardNode } from "@/lib/fleet/kanban-source"
import type { SupermemoryNamespaceNode } from "@/lib/fleet/supermemory-source"
import { buildFleetGraph } from "@/lib/fleet/fleet-graph"
import { useFleetScene } from "@/hooks/use-fleet-scene"
import { openTargetOf } from "@/hooks/simulation/fleet-scene"
import { AgentCanvas } from "./canvas"

interface FleetMapProps {
  visible: boolean
  /** Every session (Hermes profile) of the fleet, live, idle and closed tabs. */
  sessions: readonly SessionLike[]
  /** Buffered events of a session. */
  eventsOf: (sessionId: string) => readonly SimulationEvent[]
  /** Changes when the event buffers have grown. */
  tick: number
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
  selection: FleetSelectionView
  /** Open an agent node (instance id `<session>::<node>`) in the session detail. */
  onOpenSession?: (instanceId: string) => void
  /** Space under the top bar / above the timeline panel / left of the session detail panel. */
  insetTop: number
  insetBottom: number
  insetRight: number
}

const NARROW_WIDTH = 720
const noop = () => {}

/**
 * The Fleet node map. It draws with the same canvas as the single-session view: every agent
 * is the same hexagon node (glow, state ring, label), and its tool calls, messages and
 * sub-agents orbit it as satellites. Profiles are clusters, Kanban boards and Supermemory
 * namespaces sit around them, linked to the agents that use them. Click an agent (or one of
 * its satellites) to open its session detail. Deselecting an agent in the fleet only hides it.
 */
export function FleetMap({
  visible, sessions, eventsOf, tick, instances, kanban, supermemory, selection, onOpenSession, insetTop, insetBottom, insetRight,
}: FleetMapProps) {
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [panelTop, setPanelTop] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [visible])

  useEffect(() => {
    if (!visible || !wrap) return
    const measure = () => {
      setSize(prev => (prev.width === wrap.clientWidth && prev.height === wrap.clientHeight ? prev : { width: wrap.clientWidth, height: wrap.clientHeight }))
      // The timeline panel's real top edge: the map uses the space above it, whatever the screen size.
      const panel = document.querySelector('[data-testid="fleet-timeline-panel"]')
      const top = panel ? panel.getBoundingClientRect().top - wrap.getBoundingClientRect().top : null
      setPanelTop(prev => (prev === top || (prev !== null && top !== null && Math.abs(prev - top) < 2) ? prev : top))
    }
    measure()
    const timer = setInterval(measure, 500)
    if (typeof ResizeObserver === 'undefined') return () => clearInterval(timer)
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    return () => { ro.disconnect(); clearInterval(timer) }
  }, [visible, wrap])

  // On a phone the top bar wraps to more rows and the timeline panel takes a larger share
  // of the screen: keep the map in what is left (never more than 42% of the height reserved below).
  const narrow = size.width > 0 && size.width < NARROW_WIDTH
  const top = narrow ? 138 : insetTop
  // Below the map: the timeline panel's measured height (never more than 55% of the screen), else the given inset.
  const measuredBottom = panelTop !== null ? Math.max(size.height - panelTop + 8, 0) : insetBottom
  const bottom = Math.min(measuredBottom, Math.round(size.height * 0.55))
  const freeW = Math.max(size.width - insetRight, 1)
  const freeH = Math.max(size.height - top - bottom, 1)

  // Resources and their links to the agents (which boards/namespaces are shown, who uses them).
  const graph = useMemo(
    () => visible ? buildFleetGraph({ instances, kanban, supermemory, selection, now }) : { nodes: [], edges: [] },
    [visible, instances, kanban, supermemory, selection, now],
  )
  // Clusters per row follow the free area's shape, so a phone gets a tall column, a desktop a wide grid.
  const columns = useMemo(
    () => Math.max(1, Math.min(sessions.length || 1, Math.round(Math.sqrt(Math.max(sessions.length, 1) * (freeW / freeH))))),
    [sessions.length, freeW, freeH],
  )

  const { scene, frameRef, moveNode } = useFleetScene({
    visible, sessions, eventsOf, instances, selection, graph, kanban, narrow, columns, tick,
  })

  // Re-fit the camera when the set of nodes or the free area changes (the user's own pan/zoom is kept otherwise).
  const nodeKey = useMemo(() => [...scene.state.agents.keys()].sort().join('|'), [scene])
  const [fitTrigger, setFitTrigger] = useState(0)
  useEffect(() => { setFitTrigger(n => n + 1) }, [nodeKey, Math.round(freeW / 40), Math.round(freeH / 40)])

  // A node that left the map (deselected) cannot stay selected.
  useEffect(() => {
    if (selectedId && !scene.state.agents.has(selectedId)) setSelectedId(null)
  }, [scene, selectedId])

  if (!visible) return null

  let agentCount = 0
  let kanbanCount = 0
  let memoryCount = 0
  for (const a of scene.state.agents.values()) {
    if (a.resourceKind === 'kanban') kanbanCount++
    else if (a.resourceKind === 'supermemory') memoryCount++
    else agentCount++
  }
  const profileNames = [...scene.clusters.values()].map(c => c.identity)

  const open = (nodeId: string | null) => {
    const target = openTargetOf(scene, nodeId)
    if (!target) return
    setSelectedId(target.instanceId)
    onOpenSession?.(target.instanceId)
  }

  return (
    <div
      ref={setWrap}
      data-testid="fleet-map"
      data-agents={agentCount}
      data-satellites={scene.state.toolCalls.size}
      data-kanban={kanbanCount}
      data-supermemory={memoryCount}
      data-profile-names={profileNames.join('|')}
      className="absolute inset-0"
      style={{ zIndex: Z.info - 5, background: COLORS.void }}
    >
      {/* The canvas lives in the free area, so its camera fits the map between the bars and panels. */}
      <div className="absolute" style={{ left: 0, top, bottom, right: insetRight }}>
        <AgentCanvas
          simulationRef={frameRef}
          selectedAgentId={selectedId}
          hoveredAgentId={hoveredId}
          showStats={false}
          showHexGrid
          zoomToFitTrigger={fitTrigger}
          onAgentClick={id => { if (id) open(id); else setSelectedId(null) }}
          onAgentHover={setHoveredId}
          onAgentDrag={moveNode}
          onContextMenu={noop}
          onToolCallClick={id => { if (id) open(id) }}
        />
      </div>
      {scene.state.agents.size === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none font-mono text-xs" style={{ color: COLORS.textMuted }}>
          No Hermes profiles with sessions yet
        </div>
      )}
    </div>
  )
}

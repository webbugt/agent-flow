"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { COLORS } from "@/lib/colors"
import { Z, type SimulationEvent } from "@/lib/agent-types"
import type { FleetInstance, FleetSelectionView, SessionLike } from "@/lib/fleet/fleet-model"
import type { PublicKanbanBoardNode } from "@/lib/fleet/kanban-source"
import type { SupermemoryNamespaceNode } from "@/lib/fleet/supermemory-source"
import { buildFleetGraph, EMPTY_GRAPH } from "@/lib/fleet/fleet-graph"
import { inspectResource } from "@/lib/fleet/fleet-inspect"
import { EMPTY_PINS, togglePin, type PinSet } from "@/lib/fleet/resource-block"
import { useOptions } from "@/hooks/use-options"
import { useFleetScene } from "@/hooks/use-fleet-scene"
import { openTargetOf, type FleetReplay } from "@/hooks/simulation/fleet-scene"
import { BUTTON_ZOOM_STEP, shouldRefit, type FitBasis } from "@/lib/fleet/fleet-camera"
import {
  ACTIVITY_WINDOWS, DEFAULT_ACTIVITY_WINDOW, isActivityWindowId, type ActivityWindowId, type HiddenSummary,
} from "@/lib/fleet/fleet-activity-filter"
import { AgentCanvas, type CanvasControls } from "./canvas"
import { FleetInspector } from "./fleet-inspector"

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
  /** Replay shared with the session detail panel (it shows finished nodes' history too). */
  replay?: FleetReplay
  /** Space under the top bar / above the timeline panel / left of the session detail panel. */
  insetTop: number
  insetBottom: number
  insetRight: number
  /** Whether the fleet timeline panel is shown. When it is hidden the map takes the full height. */
  timelineVisible?: boolean
  onToggleTimeline?: () => void
  /** Screensaver mode: no zoom buttons, no timeline toggle, no inspector; the map takes the whole screen. */
  screensaver?: boolean
  /** Latest-activity filter (the map already receives the filtered selection). Control hidden when no handler is given. */
  activityWindow?: ActivityWindowId
  onActivityWindowChange?: (id: ActivityWindowId) => void
  /** What the filter hides, for the "N hidden" hint. */
  hiddenSummary?: HiddenSummary
}

const NARROW_WIDTH = 720
const noop = () => {}
/** Touch-friendly: at least 36 px on a phone. */
const ZOOM_BUTTON_PX = 40
/** Top edge of the activity filter: 8 px below the free area, and never above 8 px under the top bar's published bottom edge. */
const ACTIVITY_FILTER_TOP = (mapTop: number): string => `max(${mapTop + 8}px, calc(var(--af-top-bar-bottom, 0px) + 8px))`

/**
 * The Fleet node map. It draws with the same canvas as the single-session view: every agent
 * is the same hexagon node (glow, state ring, label), and its tool calls, messages and
 * sub-agents orbit it as satellites. Profiles are clusters, Kanban boards and Supermemory
 * namespaces sit around them, linked to the agents that use them. Click an agent (or one of
 * its satellites) to open its session detail. Deselecting an agent in the fleet only hides it.
 */
export function FleetMap({
  visible, sessions, eventsOf, tick, instances, kanban, supermemory, selection, onOpenSession, replay, insetTop, insetBottom, insetRight,
  timelineVisible = true, onToggleTimeline, screensaver = false, activityWindow = DEFAULT_ACTIVITY_WINDOW, onActivityWindowChange, hiddenSummary,
}: FleetMapProps) {
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [panelTop, setPanelTop] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [inspectId, setInspectId] = useState<string | null>(null)

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
  // Screensaver: no bar, no panel, no detail panel: the whole screen is the map.
  const top = screensaver ? 0 : narrow ? 138 : insetTop
  // Below the map: the timeline panel's measured height (never more than 55% of the screen), else the given inset.
  // Timeline hidden: only what the playback bar covers is reserved (insetBottom is that then).
  const measuredBottom = !timelineVisible ? insetBottom : panelTop !== null ? Math.max(size.height - panelTop + 8, 0) : insetBottom
  const bottom = screensaver ? 0 : timelineVisible ? Math.min(measuredBottom, Math.round(size.height * 0.55)) : measuredBottom
  const freeW = Math.max(size.width - (screensaver ? 0 : insetRight), 1)
  const freeH = Math.max(size.height - top - bottom, 1)

  // Resources and their links to the agents (which boards/namespaces are shown, who uses them).
  // Kanban boards are resource blocks: they appear on a task event, live for the kanban linger of the options
  // (live: an edit in the options panel applies at once) and fade; a pinned block stays.
  const options = useOptions()
  const [pins, setPins] = useState<PinSet>(EMPTY_PINS)
  const graph = useMemo(
    () => visible ? buildFleetGraph({ instances, kanban, supermemory, selection, now, options, pins }) : EMPTY_GRAPH,
    [visible, instances, kanban, supermemory, selection, now, options, pins],
  )
  // Clusters per row follow the free area's shape, so a phone gets a tall column, a desktop a wide grid.
  const columns = useMemo(
    () => Math.max(1, Math.min(sessions.length || 1, Math.round(Math.sqrt(Math.max(sessions.length, 1) * (freeW / freeH))))),
    [sessions.length, freeW, freeH],
  )

  const { scene, frameRef, moveNode } = useFleetScene({
    visible, sessions, eventsOf, instances, selection, graph, columns, tick, replay,
  })

  // Camera. Fit on first load and on real layout changes only (node count, or the free area changes
  // by more than a threshold); node ids churning on polls and clock ticks never move the camera, and
  // once the user zoomed or panned only the fit button / double click puts the whole map back.
  const controlsRef = useRef<CanvasControls | null>(null)
  const lastFitRef = useRef<FitBasis | null>(null)
  const [fitTrigger, setFitTrigger] = useState(0)
  const nodeCount = scene.state.agents.size
  useEffect(() => {
    const next: FitBasis = { nodeCount, width: freeW, height: freeH }
    const navigated = controlsRef.current?.hasNavigated() ?? false
    if (!shouldRefit(lastFitRef.current, next, navigated)) return
    lastFitRef.current = next
    setFitTrigger(n => n + 1)
  }, [nodeCount, freeW, freeH])
  const zoomIn = () => controlsRef.current?.zoomBy(BUTTON_ZOOM_STEP)
  const zoomOut = () => controlsRef.current?.zoomBy(1 / BUTTON_ZOOM_STEP)
  const fitView = () => {
    lastFitRef.current = { nodeCount, width: freeW, height: freeH }
    controlsRef.current?.fit()
  }

  // Screensaver: no node stays selected or inspected (nothing is highlighted on the bare map).
  useEffect(() => {
    if (screensaver) { setSelectedId(null); setInspectId(null); setHoveredId(null) }
  }, [screensaver])

  // A node that left the map (deselected) cannot stay selected.
  useEffect(() => {
    if (selectedId && !scene.state.agents.has(selectedId)) setSelectedId(null)
    if (inspectId && !scene.state.agents.has(inspectId)) setInspectId(null)
  }, [scene, selectedId, inspectId])

  if (!visible) return null

  let agentCount = 0
  let kanbanCount = 0
  let memoryCount = 0
  for (const a of scene.state.agents.values()) {
    if (a.resourceKind === 'kanban') kanbanCount++
    else if (a.resourceKind === 'supermemory') memoryCount++
    else agentCount++
  }
  const inspection = inspectId ? inspectResource(inspectId, kanban, supermemory) : null
  const profileNames = [...scene.clusters.values()].map(c => c.identity)

  const open = (nodeId: string | null) => {
    // Kanban and memory nodes open the read-only inspector of their latest interactions.
    const picked = nodeId ? scene.state.agents.get(nodeId) : undefined
    if (picked?.resourceKind) {
      setSelectedId(picked.id)
      setInspectId(picked.id)
      return
    }
    setInspectId(null)
    const target = openTargetOf(scene, nodeId)
    if (!target) return
    setSelectedId(target.instanceId)
    onOpenSession?.(target.openId)
  }

  return (
    <div
      ref={setWrap}
      data-testid="fleet-map"
      data-agents={agentCount}
      data-satellites={scene.state.toolCalls.size}
      data-kanban={kanbanCount}
      data-supermemory={memoryCount}
      data-timeline-visible={timelineVisible}
      data-clouds={scene.state.clouds?.length ?? 0}
      data-edges={scene.state.edges.filter(e => e.fromCloud).length}
      data-profile-names={profileNames.join('|')}
      className="absolute inset-0"
      style={{ zIndex: Z.info - 5, background: COLORS.void }}
    >
      {/* The canvas lives in the free area, so its camera fits the map between the bars and panels. */}
      <div className="absolute" style={{ left: 0, top, bottom, right: screensaver ? 0 : insetRight }}>
        <AgentCanvas
          screensaver={screensaver}
          simulationRef={frameRef}
          selectedAgentId={selectedId}
          hoveredAgentId={screensaver ? null : hoveredId}
          showStats={false}
          showHexGrid
          fleetView
          controlsRef={controlsRef}
          zoomToFitTrigger={fitTrigger}
          onAgentClick={id => { if (id) open(id); else { setSelectedId(null); setInspectId(null) } }}
          onAgentHover={setHoveredId}
          onAgentDrag={moveNode}
          onContextMenu={noop}
          onToolCallClick={id => { if (id) open(id) }}
        />
      </div>
      {/* Zoom controls: bottom-left of the map area, clear of the timeline toggle (bottom-right) and the session detail. */}
      {!screensaver && <div
        data-testid="fleet-zoom-controls"
        className="absolute flex flex-col gap-1.5"
        style={{ left: 12, bottom: bottom + 8, zIndex: 6 }}
      >
        {([
          ['fleet-zoom-in', 'Zoom in', '+', zoomIn],
          ['fleet-zoom-out', 'Zoom out', '\u2212', zoomOut],
          ['fleet-zoom-fit', 'Fit to view', '\u2922', fitView],
        ] as const).map(([testid, label, glyph, onClick]) => (
          <button
            key={testid}
            type="button"
            data-testid={testid}
            aria-label={label}
            title={label}
            onClick={onClick}
            className="font-mono rounded flex items-center justify-center select-none"
            style={{
              width: ZOOM_BUTTON_PX, height: ZOOM_BUTTON_PX, fontSize: 20, lineHeight: 1, touchAction: 'manipulation',
              background: 'rgba(8,12,24,0.88)', border: `1px solid ${COLORS.holoBase}66`, color: COLORS.textPrimary,
            }}
          >
            {glyph}
          </button>
        ))}
      </div>}
      {onActivityWindowChange && !screensaver && (
        <div
          data-testid="fleet-activity-filter"
          className="absolute flex flex-col items-end gap-1 font-mono text-xs"
          // Under the top bar, wherever it really ends (the bar publishes --af-top-bar-bottom; it is taller than insetTop and wraps on a phone).
          style={{ right: insetRight + 12, top: ACTIVITY_FILTER_TOP(top), zIndex: 6, maxWidth: 'calc(100% - 24px)' }}
        >
          <select
            data-testid="fleet-activity-select"
            aria-label="Filter by latest activity"
            title="Hides profiles, sessions and resources with no event in the window. Hidden is not stopped."
            value={activityWindow}
            onChange={e => { if (isActivityWindowId(e.target.value)) onActivityWindowChange(e.target.value) }}
            className="font-mono text-xs px-2 py-1 rounded"
            style={{ background: 'rgba(8,12,24,0.88)', border: `1px solid ${COLORS.holoBase}66`, color: COLORS.textPrimary, touchAction: 'manipulation' }}
          >
            {ACTIVITY_WINDOWS.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
          {hiddenSummary && (hiddenSummary.sessions > 0 || hiddenSummary.resources > 0) && (
            <span
              data-testid="fleet-activity-hidden"
              data-hidden-profiles={hiddenSummary.profiles}
              data-hidden-sessions={hiddenSummary.sessions}
              data-hidden-resources={hiddenSummary.resources}
              style={{ color: COLORS.textMuted }}
              title="Hidden by the filter, not stopped"
            >
              {hiddenSummary.profiles > 0 ? `${hiddenSummary.profiles} profile${hiddenSummary.profiles === 1 ? '' : 's'}, ` : ''}
              {`${hiddenSummary.sessions} session${hiddenSummary.sessions === 1 ? '' : 's'}`}
              {hiddenSummary.resources > 0 ? `, ${hiddenSummary.resources} resource${hiddenSummary.resources === 1 ? '' : 's'}` : ''} hidden
            </span>
          )}
        </div>
      )}
      {!screensaver && inspection && (
        <FleetInspector inspection={inspection} now={now} top={top} right={insetRight} narrow={narrow}
          pinned={inspection.kind === 'kanban' && pins.has(inspection.id)}
          onTogglePin={inspection.kind === 'kanban' ? () => setPins(p => togglePin(p, inspection.id)) : undefined}
          onClose={() => { setInspectId(null); setSelectedId(null) }} />
      )}
      {onToggleTimeline && !screensaver && (
        <button
          type="button"
          data-testid="fleet-timeline-toggle"
          aria-pressed={timelineVisible}
          onClick={onToggleTimeline}
          className="absolute font-mono text-xs px-2 py-1 rounded"
          style={{
            right: insetRight + 12, bottom: bottom + 8, zIndex: 6,
            background: 'rgba(8,12,24,0.88)', border: `1px solid ${COLORS.holoBase}66`, color: COLORS.textPrimary,
          }}
        >
          {timelineVisible ? 'Hide timeline' : 'Show timeline'}
        </button>
      )}
      {!screensaver && scene.state.agents.size === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none font-mono text-xs" style={{ color: COLORS.textMuted }}>
          {hiddenSummary && (hiddenSummary.sessions > 0 || hiddenSummary.resources > 0)
            ? 'Nothing active in this window. Choose a longer one to see the rest (hidden is not stopped).'
            : 'No Hermes profiles with sessions yet'}
        </div>
      )}
    </div>
  )
}

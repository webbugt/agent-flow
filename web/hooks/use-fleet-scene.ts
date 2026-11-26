'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SimulationEvent } from '@/lib/agent-types'
import type { FleetInstance, FleetSelectionView, SessionLike } from '@/lib/fleet/fleet-model'
import type { FleetGraph } from '@/lib/fleet/fleet-graph'
import { FleetPulseTracker } from '@/lib/fleet/fleet-pulses'
import { glideAll, startPositions } from '@/lib/fleet/fleet-glide'
import { fleetNow } from '@/lib/fleet/fleet-clock'
import { buildFleetScene, FleetReplay, type FleetScene } from './simulation/fleet-scene'
import { newFleetPresenceTracker, withGhosts } from './simulation/fleet-presence-scene'
import { createEmptyState, type SimulationState } from './simulation/types'

export interface UseFleetSceneOptions {
  visible: boolean
  sessions: readonly SessionLike[]
  /** Buffered events of a session (a ref-backed getter: React does not see new events, `tick` does). */
  eventsOf: (sessionId: string) => readonly SimulationEvent[]
  instances: readonly FleetInstance[]
  selection: FleetSelectionView
  graph: FleetGraph
  columns?: number
  /** Changes when the event buffers have grown. */
  tick: number
  /** Shared replay: the session detail panel reads the same settled states the map draws. */
  replay?: FleetReplay
}

const EMPTY_SCENE: FleetScene = {
  state: createEmptyState({ keepFinished: true }),
  sessionOfAgent: new Map(),
  clusters: new Map(),
  resourceTargets: new Map(),
}

/**
 * The Fleet map's scene: every session replayed through the normal simulation handlers and laid
 * out as agent clouds (see simulation/fleet-scene). Returns the scene (for React: counts, click
 * targets) and `frameRef`, the same kind of ref the single-session canvas draws from.
 */
export function useFleetScene(opts: UseFleetSceneOptions) {
  const { visible, sessions, eventsOf, instances, selection, graph, columns, tick, replay: sharedReplay } = opts
  const ownReplayRef = useRef<FleetReplay | null>(null)
  if (!ownReplayRef.current) ownReplayRef.current = new FleetReplay()
  const replayRef = { current: sharedReplay ?? ownReplayRef.current }
  const movedRef = useRef(new Map<string, { x: number; y: number }>())
  // Remembers which interactions were seen, so a dot runs along a link only for a NEW one.
  const pulsesRef = useRef<FleetPulseTracker | null>(null)
  if (!pulsesRef.current) pulsesRef.current = new FleetPulseTracker()
  const frameRef = useRef<SimulationState>(EMPTY_SCENE.state)
  // Entry and exit: what is on the map now, and the ghosts of what just left. Ghosts live in the frame the
  // canvas draws, not in `scene` (counts and click targets must not see them).
  const presenceRef = useRef<ReturnType<typeof newFleetPresenceTracker> | null>(null)
  if (!presenceRef.current) presenceRef.current = newFleetPresenceTracker()
  // Bumped when the oldest ghost is over, so the scene is rebuilt without it (and the camera fit drops it).
  const [ghostTick, setGhostTick] = useState(0)

  const built = useMemo(() => {
    if (!visible) return { scene: EMPTY_SCENE, frame: EMPTY_SCENE.state }
    const replay = replayRef.current as FleetReplay
    replay.retain(new Set(sessions.map(s => s.id)))
    // Idempotent for the same links: a second call (strict mode, a re-render) starts no dot twice.
    const pulses = (pulsesRef.current as FleetPulseTracker).update(graph.edges, Date.now())
    const fresh = buildFleetScene({
      sessions, stateOf: id => replay.advance(id, eventsOf(id)), instances, selection, graph, columns,
      moved: movedRef.current, pulses,
    })
    const tracker = presenceRef.current as NonNullable<typeof presenceRef.current>
    return { scene: fresh, frame: withGhosts(fresh.state, tracker, fleetNow()) }
    // tick: the event buffers are refs, so React does not see new events by itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessions, eventsOf, instances, selection, graph, columns, tick, ghostTick])
  const scene = built.scene
  // Only when the scene was rebuilt: a re-render must not undo a drag that moved the frame.
  const lastSceneRef = useRef<FleetScene | null>(null)
  if (lastSceneRef.current !== scene) {
    lastSceneRef.current = scene
    // A rebuilt scene places every resource at its (new) weighted target. Showing it there would make the
    // node jump, so a resource that is already on the map starts where it is drawn now and glides (below).
    // A resource that is new on the map has no start: it appears at its target and gets the entry animation
    // (opacity/scale from the presence stamps, applied per frame on top of this frame, see animatedView).
    const prev = frameRef.current
    const here = new Map<string, { x: number; y: number }>()
    for (const id of scene.resourceTargets.keys()) {
      const a = prev.agents.get(id)
      if (a) here.set(id, { x: a.x, y: a.y })
    }
    const starts = startPositions(here, scene.resourceTargets)
    let agents: typeof built.frame.agents | null = null
    for (const [id, p] of starts) {
      const a = built.frame.agents.get(id)
      if (!a || (a.x === p.x && a.y === p.y)) continue
      if (!agents) agents = new Map(built.frame.agents)
      agents.set(id, { ...a, x: p.x, y: p.y })
    }
    frameRef.current = agents ? { ...built.frame, agents } : built.frame
  }

  // When the oldest ghost is over, rebuild once so it leaves the frame (and the camera's fit).
  useEffect(() => {
    const end = presenceRef.current?.nextExpiry()
    if (end === null || end === undefined) return
    const timer = setTimeout(() => setGhostTick(n => n + 1), Math.max(end - fleetNow(), 0) + 30)
    return () => clearTimeout(timer)
  }, [built])

  // Glide the resources to their targets, frame by frame, until they are there. The canvas reads
  // frameRef every frame (and animatedView reads positions from it), so mutating it here is all the
  // drawing needs; a node the user dragged is held. Ghosts are not in resourceTargets: they stay put.
  useEffect(() => {
    if (!visible || typeof requestAnimationFrame === 'undefined') return
    let raf = 0
    let last = performance.now()
    const tickFrame = (t: number) => {
      const dt = t - last
      last = t
      const frame = frameRef.current
      const r = glideAll(frame.agents, scene.resourceTargets, dt, movedRef.current)
      if (r.nodes !== frame.agents) frameRef.current = { ...frame, agents: r.nodes as typeof frame.agents }
      if (!r.settled) raf = requestAnimationFrame(tickFrame)
    }
    raf = requestAnimationFrame(tickFrame)
    return () => cancelAnimationFrame(raf)
  }, [visible, scene])

  /** Drag: the node and its satellites follow the pointer at once; the position survives rebuilds. */
  const moveNode = useCallback((id: string, x: number, y: number) => {
    const prev = frameRef.current
    const agent = prev.agents.get(id)
    if (!agent) return
    movedRef.current.set(id, { x, y })
    const agents = new Map(prev.agents)
    agents.set(id, { ...agent, x, y })
    const toolCalls = new Map(prev.toolCalls)
    for (const [tid, tc] of prev.toolCalls) {
      if (tc.agentId === id) toolCalls.set(tid, { ...tc, x: x + (tc.offX ?? tc.x - agent.x), y: y + (tc.offY ?? tc.y - agent.y) })
    }
    frameRef.current = { ...prev, agents, toolCalls }
  }, [])

  return { scene, frameRef, moveNode }
}

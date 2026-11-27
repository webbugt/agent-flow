/**
 * Entry and exit of the Fleet map's nodes and clouds, applied to a scene (see lib/fleet/fleet-presence
 * for the timing).
 *
 *   - {@link withGhosts} runs at scene build: whatever left since the last build is added back from
 *     its snapshot (node, its satellites, its links, its place in the cloud, the cloud itself when
 *     it was the last member), and the state carries the presence stamps.
 *   - {@link animatedView} runs every frame: from the stamps and the clock it returns what to draw
 *     now: opacity and scale of nodes (Agent.opacity / Agent.scale), satellites that grow out of
 *     and shrink into their node, faded links, and the level of each cloud.
 *
 * The scene itself (positions, bounds) is NOT changed by an animation, so the camera's auto-fit sees
 * the final layout from the first frame of an entry and keeps ghosts in view until they are removed.
 * Pure: no clock, no DOM.
 */
import type { Agent, Edge, ToolCallNode } from '@/lib/agent-types'
import type { CloudView } from '@/lib/fleet/fleet-cloud-geometry'
import type { Point } from '@/lib/fleet/fleet-placement'
import {
  CLOUD_DURATIONS, NODE_DURATIONS, NODE_SCALE_MIN, PresenceTracker, levelOf, scaleOf,
  type PresenceStamp,
} from '@/lib/fleet/fleet-presence'
import type { SimulationState } from './types'

/** What is kept of a node to draw it again after it left. */
export interface NodeSnapshot {
  kind: 'node'
  agent: Agent
  toolCalls: ToolCallNode[]
  /** Links that start or end at the node or at one of its satellites. */
  edges: Edge[]
  /** The cloud the node was a member of, and its pad in it. */
  member?: { cloudId: string; pad: number }
  /** Where the cloud's centre was when this was taken, so the ghost can follow the cloud when it moves. */
  cloudAt?: Point
}

/** A cloud, and the links that start at it (to resources), which fade with it. */
export interface CloudSnapshot { kind: 'cloud'; view: CloudView; edges: Edge[] }

export type PresenceSnapshot = NodeSnapshot | CloudSnapshot

/** Clouds use the slower, longer curves; everything else is a node. */
export function newFleetPresenceTracker(): PresenceTracker<PresenceSnapshot> {
  return new PresenceTracker<PresenceSnapshot>(id => (id.startsWith('cloud:') ? CLOUD_DURATIONS : NODE_DURATIONS))
}

/** Snapshot of everything on the map, keyed by scene id (agents, resources, cloud ids). */
function snapshotOf(state: SimulationState, centres?: ReadonlyMap<string, Point>): Map<string, PresenceSnapshot> {
  const out = new Map<string, PresenceSnapshot>()
  const memberOf = new Map<string, { cloudId: string; pad: number }>()
  for (const c of state.clouds ?? []) {
    out.set(c.id, { kind: 'cloud', view: c, edges: state.edges.filter(e => e.from === c.id) })
    for (const m of c.members) memberOf.set(m.id, { cloudId: c.id, pad: m.pad })
  }
  const toolsOf = new Map<string, ToolCallNode[]>()
  for (const tc of state.toolCalls.values()) {
    const list = toolsOf.get(tc.agentId)
    if (list) list.push(tc)
    else toolsOf.set(tc.agentId, [tc])
  }
  const edgesOf = new Map<string, Edge[]>()
  const push = (id: string, e: Edge) => {
    const list = edgesOf.get(id)
    if (list) list.push(e)
    else edgesOf.set(id, [e])
  }
  for (const e of state.edges) {
    // A link belongs to the node it starts at (a satellite link) and to the one it ends at (a resource link).
    if (state.agents.has(e.from)) push(e.from, e)
    if (state.agents.has(e.to)) push(e.to, e)
  }
  for (const [id, agent] of state.agents) {
    const member = memberOf.get(id)
    const cloudAt = member ? centres?.get(member.cloudId) : undefined
    out.set(id, {
      kind: 'node', agent, toolCalls: toolsOf.get(id) ?? [], edges: edgesOf.get(id) ?? [], member,
      ...(cloudAt ? { cloudAt: { x: cloudAt.x, y: cloudAt.y } } : {}),
    })
  }
  return out
}

/**
 * The state with ghosts added and the stamps attached. Call once per scene build, with the build time.
 * Returns `state` itself when nothing is entering, exiting or tracked as a ghost.
 *
 * `centres` (cloud id to the cloud's centre in this scene) lets a ghost follow its cloud: a member that
 * left a cloud that still exists is placed where it was, moved by the amount the cloud's centre moved,
 * so it keeps its place in the cloud while the cloud glides to its new place. A ghost whose cloud is
 * gone too stays where it was.
 */
export function withGhosts(
  state: SimulationState, tracker: PresenceTracker<PresenceSnapshot>, now: number, centres?: ReadonlyMap<string, Point>,
): SimulationState {
  const ghosts = tracker.update(snapshotOf(state, centres), now)
  const stamps = new Map(tracker.stamps)
  if (ghosts.size === 0) return { ...state, presence: stamps }

  const agents = new Map(state.agents)
  const toolCalls = new Map(state.toolCalls)
  const edges = [...state.edges]
  const edgeIds = new Set(edges.map(e => e.id))
  let clouds = [...(state.clouds ?? [])]
  const cloudIndex = new Map(clouds.map((c, i) => [c.id, i]))

  // Clouds first: a ghost cloud must be there before its ghost members look for it.
  for (const [id, snap] of ghosts) {
    if (snap.kind !== 'cloud' || cloudIndex.has(id)) continue
    cloudIndex.set(id, clouds.length)
    clouds.push(snap.view)
    for (const e of snap.edges) if (!edgeIds.has(e.id)) { edgeIds.add(e.id); edges.push(e) }
  }
  for (const [id, snap] of ghosts) {
    if (snap.kind !== 'node') continue
    const centreNow = snap.member ? centres?.get(snap.member.cloudId) : undefined
    const dx = centreNow && snap.cloudAt ? centreNow.x - snap.cloudAt.x : 0
    const dy = centreNow && snap.cloudAt ? centreNow.y - snap.cloudAt.y : 0
    const follows = dx !== 0 || dy !== 0
    agents.set(id, follows ? { ...snap.agent, x: snap.agent.x + dx, y: snap.agent.y + dy } : snap.agent)
    for (const tc of snap.toolCalls) toolCalls.set(tc.id, follows ? { ...tc, x: tc.x + dx, y: tc.y + dy } : tc)
    for (const e of snap.edges) if (!edgeIds.has(e.id)) { edgeIds.add(e.id); edges.push(e) }
    const m = snap.member
    const at = m ? cloudIndex.get(m.cloudId) : undefined
    if (m && at !== undefined && !clouds[at].members.some(x => x.id === id)) {
      // The halo keeps its size until the ghost is gone, so it does not jump at the start of the exit.
      clouds = clouds.slice()
      clouds[at] = { ...clouds[at], members: [...clouds[at].members, { id, pad: m.pad }] }
    }
  }
  // A link needs both of its ends; one whose other end is gone for good is not kept.
  const hasEnd = (id: string) => agents.has(id) || toolCalls.has(id) || cloudIndex.has(id)
  const kept = edges.filter(e => hasEnd(e.from) && hasEnd(e.to))
  return { ...state, agents, toolCalls, edges: kept, clouds, presence: stamps }
}

/** What the canvas draws at one instant. `fade` is the level of everything that is not at 1. */
export interface AnimatedView {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  edges: Edge[]
  clouds: CloudView[]
  /** Level 0..1 by scene id (nodes, satellites' nodes, clouds), only for things in transition. */
  fade: ReadonlyMap<string, number>
  /** True when anything is in transition (the maps above are then copies). */
  animating: boolean
}

/**
 * Per-frame view of a scene with presence stamps. When nothing is in transition it hands back the
 * scene's own maps (no copies per frame).
 */
export function animatedView(state: SimulationState, now: number): AnimatedView {
  const stamps = state.presence
  const clouds = state.clouds ?? []
  const none: AnimatedView = { agents: state.agents, toolCalls: state.toolCalls, edges: state.edges, clouds, fade: new Map(), animating: false }
  if (!stamps || stamps.size === 0) return none

  const fade = new Map<string, number>()
  const gone = new Set<string>()
  for (const [id, stamp] of stamps as ReadonlyMap<string, PresenceStamp>) {
    const level = levelOf(stamp, now)
    if (level === null) gone.add(id)
    else if (level < 1) fade.set(id, level)
  }
  if (fade.size === 0 && gone.size === 0) return none

  const nodeScale = (id: string) => scaleOf(fade.get(id) ?? 1, NODE_SCALE_MIN)

  const agents = new Map<string, Agent>()
  for (const [id, a] of state.agents) {
    if (gone.has(id)) continue
    const level = fade.get(id)
    agents.set(id, level === undefined ? a : { ...a, opacity: a.opacity * level, scale: a.scale * nodeScale(id) })
  }
  const toolCalls = new Map<string, ToolCallNode>()
  for (const [id, tc] of state.toolCalls) {
    const owner = state.agents.get(tc.agentId)
    if (gone.has(tc.agentId) || !owner) continue
    const level = fade.get(tc.agentId)
    if (level === undefined) { toolCalls.set(id, tc); continue }
    // Satellites grow out of the node and shrink back into it.
    const k = nodeScale(tc.agentId)
    toolCalls.set(id, { ...tc, opacity: tc.opacity * level, x: owner.x + (tc.x - owner.x) * k, y: owner.y + (tc.y - owner.y) * k })
  }
  const levelOfEnd = (id: string): number => {
    if (gone.has(id)) return 0
    const direct = fade.get(id)
    if (direct !== undefined) return direct
    const tc = state.toolCalls.get(id)
    return tc ? fade.get(tc.agentId) ?? 1 : 1
  }
  const edges: Edge[] = []
  for (const e of state.edges) {
    const level = Math.min(levelOfEnd(e.from), levelOfEnd(e.to))
    if (level <= 0) continue
    edges.push(level >= 1 ? e : { ...e, opacity: e.opacity * level })
  }
  const visibleClouds = clouds.filter(c => !gone.has(c.id))
  return { agents, toolCalls, edges, clouds: visibleClouds, fade, animating: true }
}

/**
 * Ids of what is on its way out (ghosts; expired ones that a rebuild has not dropped yet included).
 * They are drawn, but they are not things the user can point at: no hover, no click, no drag.
 */
export function ghostIdsOf(state: Pick<SimulationState, 'presence'>): ReadonlySet<string> {
  const out = new Set<string>()
  if (state.presence) for (const [id, stamp] of state.presence) if (stamp.dir === 'out') out.add(id)
  return out
}

/** The agents a pointer can hit: the map itself when there are no ghosts, else a copy without them. */
export function solidAgents(agents: Map<string, Agent>, ghosts: ReadonlySet<string>): Map<string, Agent> {
  if (ghosts.size === 0) return agents
  const out = new Map<string, Agent>()
  for (const [id, a] of agents) if (!ghosts.has(id)) out.set(id, a)
  return out
}

/** The satellites a pointer can hit: those of a ghost are not. */
export function solidToolCalls(toolCalls: Map<string, ToolCallNode>, ghosts: ReadonlySet<string>): Map<string, ToolCallNode> {
  if (ghosts.size === 0) return toolCalls
  const out = new Map<string, ToolCallNode>()
  for (const [id, tc] of toolCalls) if (!ghosts.has(tc.agentId)) out.set(id, tc)
  return out
}

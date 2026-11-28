/**
 * Fleet scene: the Fleet node map drawn by the SAME canvas renderer as the single-session view.
 *
 * Every Hermes profile (bridge session) is replayed through the normal simulation handlers
 * (processEvent), so its agent nodes get the same hexagon/glow/label, and the tool calls,
 * messages and sub-agents of each node orbit it as the same satellites, placed by the same
 * slot finder.
 *
 * Layout (all deterministic, see lib/fleet/fleet-placement.ts):
 *   - There is no central profile node. Each session (agent node) is its own node. The sessions
 *     of one profile form a cloud: a stable, seeded blob around the profile centroid, drawn
 *     with a soft halo and the profile name as caption. Sessions of one profile are not linked.
 *   - Clouds are shelf-packed into a block of the viewport's aspect (lib/fleet/fleet-cloud-pack.ts). Each Kanban board and Supermemory namespace goes near the weighted
 *     centroid of the clouds it links to (weight = event count); unlinked ones go to a rim.
 *
 * Pure data code (no React, no DOM), so it is unit-testable:
 *   - {@link FleetReplay} keeps one settled simulation state per session and only processes
 *     the events that arrived since the last call (the buffers are append-only).
 *   - {@link buildFleetScene} filters by the fleet selection, lays the clouds out and returns
 *     a SimulationState the canvas draws.
 *
 * Content privacy: the relay anonymizes per profile BEFORE events reach the browser (see
 * lib/content-privacy.ts), and /api/fleet does the same for Kanban task titles. The scene
 * shows exactly what those sources deliver, so an anonymized profile's satellites carry
 * structure only (command name and size, file path and line counts, ...) while another
 * profile's carry full content.
 *
 * Selection only hides: the replay of a deselected node keeps running, so it comes back with
 * its state (active, idle) and its own action history.
 */
import {
  emptyContextBreakdown,
  type Agent, type Edge, type SimulationEvent, type ToolCallNode,
} from '@/lib/agent-types'
import { TOOL_CARD_H, TOOL_CARD_W, MODEL_FAMILY_CONTEXT, DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE } from '@/lib/canvas-constants'
import { BASH_COLOR, KANBAN_COLOR, SUBSYSTEM_COLOR, SUPERMEMORY_COLOR } from '@/lib/fleet/fleet-colors'
import {
  groupColor, identityFromLabel, nodeInstanceId,
  type FleetInstance, type FleetSelectionView, type SessionLike,
} from '@/lib/fleet/fleet-model'
import { cloudIdOf, type FleetGraph } from '@/lib/fleet/fleet-graph'
import { HALO_PAD, type CloudView } from '@/lib/fleet/fleet-cloud-geometry'
import { packClouds } from '@/lib/fleet/fleet-cloud-pack'
import { placeBlob, placeResources, type BlobUnit, type PlacementResource } from '@/lib/fleet/fleet-placement'
import {
  buildRelations, coUseWeights, explicitLinkPairs, fitAnchorsToAspect, layoutWeights, placeAnchorSessions, placeAnchors, profileColor,
  type AnchorSession, type UseItem,
} from '@/lib/fleet/anchor-mode'
import { DEFAULT_PROFILE_PALETTE } from '@/lib/fleet/options-registry'
import type { FleetPulse } from '@/lib/fleet/fleet-pulses'
import { createEmptyState, type SimulationState } from './types'
import { processEvent, type ProcessEventContext } from './process-event'
import { findToolSlot } from './tool-slot'
import { pruneRestingTools } from './animate'
import { snapVisualState } from './snap-visual-state'

/** Gap between clouds on the grid, world units (on top of the halo). */
export const CLOUD_GAP_X = 40
export const CLOUD_GAP_Y = 36
/** Room under a halo for the profile caption. */
const CAPTION_ROOM = 26

function contextWindowSize(modelId?: string): number {
  if (!modelId) return FALLBACK_CONTEXT_SIZE
  const id = modelId.toLowerCase()
  for (const { pattern, size } of MODEL_FAMILY_CONTEXT) if (pattern.test(id)) return size
  return DEFAULT_CONTEXT_SIZE
}

// ─── Replay ─────────────────────────────────────────────────────────────────

interface Replayed {
  state: SimulationState
  /** Events of the buffer already applied. */
  count: number
}

/** Namespaced id of a node of a session: the same as the fleet instance id (`<session>::<node>`). */
export const sceneId = nodeInstanceId

/**
 * One settled simulation per session, advanced incrementally. History and live events are
 * applied alike (as a snapshot): each keeps its own time, nothing flies or fades in.
 */
export class FleetReplay {
  private readonly sessions = new Map<string, Replayed>()
  private readonly blockIdCounter = { current: 0 }
  private readonly ctx: ProcessEventContext = {
    syncForceSimulation: () => {},
    findToolSlot,
    getContextWindowSize: contextWindowSize,
    blockIdCounter: this.blockIdCounter,
    skipForceSync: true,
    keepFinished: true,
  }

  /** Bring one session up to date with its event buffer and return its settled state. */
  advance(sessionId: string, events: readonly SimulationEvent[]): SimulationState {
    let rep = this.sessions.get(sessionId)
    // A shorter buffer means it was reset (relay restart, panel reopened): start over.
    if (!rep || events.length < rep.count) {
      rep = { state: createEmptyState({ keepFinished: true, isPlaying: false }), count: 0 }
    }
    if (events.length === rep.count) {
      this.sessions.set(sessionId, rep)
      return rep.state
    }
    let state = rep.state
    let t = Math.max(state.currentTime, 0)
    for (let i = rep.count; i < events.length; i++) {
      const raw = events[i]
      // Keep time monotonic: a stray earlier time is placed at the running time.
      t = Math.max(t, raw.time || 0)
      const timed: SimulationEvent = { ...raw, time: t }
      state = { ...processEvent(timed, { ...state, currentTime: t }, this.ctx), currentTime: t }
      // A busy node can have thousands of tool calls: keep the working set small while replaying.
      if (state.toolCalls.size > 64 || i === events.length - 1) {
        const pruned = pruneRestingTools(state.toolCalls, state.edges)
        state = { ...state, toolCalls: pruned.toolCalls, edges: pruned.edges, particles: [], discoveries: [] }
      }
    }
    // Settled values for what is drawn (opacity, scale, bubbles); the raw state keeps replaying.
    const settled = snapVisualState(state, t)
    rep = { state: { ...settled, keepFinished: true, currentTime: t, maxTimeReached: t }, count: events.length }
    this.sessions.set(sessionId, rep)
    return rep.state
  }

  /** Forget sessions that are gone. */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const id of this.sessions.keys()) if (!sessionIds.has(id)) this.sessions.delete(id)
  }
}

// ─── Scene ──────────────────────────────────────────────────────────────────

export interface FleetSceneInput {
  sessions: readonly SessionLike[]
  /** Settled state of a session, usually `replay.advance(id, getSessionEvents(id))`. */
  stateOf: (sessionId: string) => SimulationState
  /** Fleet instances (one per agent node), for the selection and the order of sessions in a cloud. */
  instances: readonly FleetInstance[]
  selection: FleetSelectionView
  /** Resources and their links to clouds, from buildFleetGraph. */
  graph: FleetGraph
  /**
   * Shape of the free viewport area (width / height). The clouds (cloud layout) and the anchors (anchor layout) are
   * flowed into a block of this shape. Default 1 (square-ish).
   */
  aspect?: number
  /** Nodes the user dragged: their satellites move with them. Applied over the layout. */
  moved?: ReadonlyMap<string, { x: number; y: number }>
  /** Dots to draw along the links (from a FleetPulseTracker). */
  pulses?: readonly FleetPulse[]
  /**
   * `cloud` (default): one cloud per profile on a grid, resources near the clouds they link to.
   * `anchor` (resource-anchor mode): resources are the anchors, laid out by co-use; sessions sit beside the resource
   * they use now; no halo, no grouping; profile colour from the palette.
   */
  layout?: 'cloud' | 'anchor'
  /** Anchor mode: profile palette (hex codes) and per-profile overrides (lower-case name to hex). */
  palette?: readonly string[]
  profileColors?: Readonly<Record<string, string>>
  /** Anchor mode: epoch ms of "now", to tell which resource a session is using now. Default: the wall clock. */
  now?: number
}

export interface FleetScene {
  state: SimulationState
  /** agent id (namespaced) to its session id; resources are not in the map. */
  sessionOfAgent: ReadonlyMap<string, string>
  /** Cloud centres by cloud id, world coordinates (the profile centroid), with the profile name. */
  clusters: ReadonlyMap<string, { x: number; y: number; r: number; identity: string }>
  /** Where each resource node belongs (weighted by its interactions). The scene draws it there; the frame loop glides to it. */
  resourceTargets: ReadonlyMap<string, { x: number; y: number }>
}

/** A session node with its satellites: the unit a blob is made of. */
interface Unit {
  sid: string
  agent: Agent
  toolCalls: ToolCallNode[]
  /** Start of the node, epoch ms, for a stable order inside the cloud. */
  start: number
  /** Distance from the node to the farthest corner of its satellites and bubbles (what the halo must cover). */
  reach: number
  /** What the blob packs on: {@link AGENT_PAD} plus {@link SATELLITE_PACK_SHARE} of the reach beyond it. */
  radius: number
}

interface Cluster {
  session: SessionLike
  identity: string
  agents: Agent[]
  toolCalls: ToolCallNode[]
  edges: Edge[]
}

const AGENT_PAD = 70
/**
 * Share of a node's satellite reach (the part beyond {@link AGENT_PAD}) that the blob packing counts, 0..1.
 * Tool cards and bubbles are small on the fleet map and only show in full when zoomed in, so neighbours
 * pack on the node plus this share of the reach and their cards may touch when zoomed in; the halo still
 * covers the full reach. 1 = the old behaviour (nodes never closer than twice the full reach).
 */
export const SATELLITE_PACK_SHARE = 0.35
/** Reach of a node's message bubbles for the blob packing, world units. */
const BUBBLE_REACH = 130

function visibleIn(
  s: SessionLike, own: readonly FleetInstance[], selection: FleetSelectionView, agent: Agent,
): boolean {
  if (own.length === 0) return true
  if (!agent.isMain) {
    const byName = own.find(i => i.id === nodeInstanceId(s.id, agent.name))
    if (byName) return selection.isSelected(byName.id)
  }
  // The main node, and nodes with no instance of their own (sub-agents, nodes without a start time):
  // visible while any node of the session is selected.
  return own.some(i => selection.isSelected(i.id))
}

function buildCluster(
  s: SessionLike, state: SimulationState, own: readonly FleetInstance[], selection: FleetSelectionView,
): Cluster | null {
  const visible = [...state.agents.values()].filter(a => visibleIn(s, own, selection, a))
  // No hub: the profile's main node is not drawn when the profile has session nodes of its own.
  // A profile that has only its main node so far still shows as one node (named after the profile).
  const sessionsOnly = visible.filter(a => !a.isMain)
  const agents = (sessionsOnly.length > 0 ? sessionsOnly : visible)
    .map(a => (a.isMain && a.name !== a.id ? { ...a, name: a.id } : a))
  if (agents.length === 0) return null
  const ids = new Set(agents.map(a => a.id))
  const toolCalls = [...state.toolCalls.values()].filter(tc => ids.has(tc.agentId))
  const toolIds = new Set(toolCalls.map(tc => tc.id))
  // Edges between a node and its own satellites only; the links to the (removed) main node go with it.
  const edges = state.edges.filter(e => ids.has(e.from) && (ids.has(e.to) || toolIds.has(e.to)))
  return { session: s, identity: identityFromLabel(s.label), agents, toolCalls, edges }
}

/** Distance from the node to the farthest corner of its satellites (and a fixed share for bubbles). */
export function unitReach(agent: Agent, toolCalls: readonly ToolCallNode[]): number {
  let r = AGENT_PAD
  // Message bubbles hang off the node to the right, but only show when the camera is zoomed in: they
  // get a fixed share of the blob (not a share per bubble), or one chatty session would blow up its cloud.
  if (agent.messageBubbles.length > 0) r = Math.max(r, BUBBLE_REACH)
  for (const tc of toolCalls) {
    r = Math.max(r, Math.hypot(tc.x - agent.x, tc.y - agent.y) + Math.hypot(TOOL_CARD_W, TOOL_CARD_H) / 2)
  }
  return r
}

/** The radius the blob packs a node on: the node itself plus a share of the reach beyond it. */
export function packRadius(reach: number): number {
  return AGENT_PAD + SATELLITE_PACK_SHARE * Math.max(0, reach - AGENT_PAD)
}

function resourceAgent(node: FleetGraph['nodes'][number], x: number, y: number): Agent {
  return {
    id: node.id, name: node.label, state: node.status === 'active' ? 'tool_calling' : 'idle',
    parentId: null, tokensUsed: 0, tokensMax: 1, contextBreakdown: emptyContextBreakdown(),
    toolCalls: 0, timeAlive: 0, x, y, vx: 0, vy: 0, pinned: true, isMain: false,
    task: node.sublabel, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    resourceKind: node.kind === 'kanban' ? 'kanban' : node.kind === 'bash' ? 'bash' : node.kind === 'subsystem' ? 'subsystem' : 'supermemory',
    ...(node.life ? { block: node.life } : {}),
    ...(node.badge ? { badge: node.badge } : {}),
  }
}

export function buildFleetScene(input: FleetSceneInput): FleetScene {
  const { sessions, selection, graph } = input
  const startOf = new Map(input.instances.map(i => [i.id, i.startTime]))

  // 1. One cluster per session that has something visible; their nodes become units of the profile's cloud.
  const byIdentity = new Map<string, { clusters: Cluster[]; units: Unit[] }>()
  for (const s of sessions) {
    const own = input.instances.filter(i => i.id === s.id || i.id.startsWith(`${s.id}::`))
    const c = buildCluster(s, input.stateOf(s.id), own, selection)
    if (!c) continue
    let group = byIdentity.get(c.identity)
    if (!group) byIdentity.set(c.identity, (group = { clusters: [], units: [] }))
    group.clusters.push(c)
    for (const agent of c.agents) {
      const toolCalls = c.toolCalls.filter(tc => tc.agentId === agent.id)
      const reach = unitReach(agent, toolCalls)
      group.units.push({
        sid: s.id, agent, toolCalls, start: startOf.get(nodeInstanceId(s.id, agent.id)) ?? 0,
        reach, radius: packRadius(reach),
      })
    }
  }
  if (input.layout === 'anchor') return buildAnchorScene(input, byIdentity)
  // Clouds in profile-name order; units in start order, so a new session joins the rim of its blob.
  const identities = [...byIdentity.keys()].sort((a, b) => a.localeCompare(b))
  const cloudInfo = identities.map(identity => {
    const group = byIdentity.get(identity)!
    group.units.sort((a, b) => a.start - b.start || nodeInstanceId(a.sid, a.agent.id).localeCompare(nodeInstanceId(b.sid, b.agent.id)))
    const blobUnits: BlobUnit[] = group.units.map(u => ({ id: nodeInstanceId(u.sid, u.agent.id), radius: u.radius }))
    const blob = placeBlob(blobUnits, identity)
    // The halo covers every node with its full reach (not just the packing radius), as cloudGeometry does.
    let cover = 0
    for (const u of group.units) {
      const at = blob.positions.get(nodeInstanceId(u.sid, u.agent.id))!
      cover = Math.max(cover, Math.hypot(at.x, at.y) + u.reach)
    }
    return { identity, group, blob, halo: cover + HALO_PAD }
  })

  // 2. Clouds shelf-packed (biggest halo first) into a block of the free viewport area's shape; cells are sized to their
  // own halo (plus the caption), so one big profile does not blow up the space of the small ones.
  const packed = packClouds(
    cloudInfo.map(c => ({ id: c.identity, halo: c.halo })), input.aspect ?? 1,
    { gapX: CLOUD_GAP_X, gapY: CLOUD_GAP_Y, captionRoom: CAPTION_ROOM },
  )

  const agents = new Map<string, Agent>()
  const toolCalls = new Map<string, ToolCallNode>()
  const edges: Edge[] = []
  const sessionOfAgent = new Map<string, string>()
  const centers = new Map<string, { x: number; y: number; r: number; identity: string }>()
  const cloudViews: CloudView[] = []
  /** Session nodes of each cloud with their laid-out positions: what the resources' session weights point at. */
  const cloudNodes = new Map<string, Array<{ id: string; x: number; y: number }>>()
  const graphCloud = new Map(graph.clouds.map(c => [c.id, c]))
  const ns = (sid: string, id: string) => sceneId(sid, id)

  cloudInfo.forEach(({ identity, group, blob, halo }) => {
    // The cloud's centroid, from the packing (the room kept under the halo for the caption is already in it).
    const { x: cx, y: cy } = packed.positions.get(identity)!
    const cloudId = cloudIdOf(identity)
    centers.set(cloudId, { x: cx, y: cy, r: halo, identity })
    const members: CloudView['members'] = []
    const nodePositions: Array<{ id: string; x: number; y: number }> = []
    cloudNodes.set(cloudId, nodePositions)
    for (const u of group.units) {
      const id = ns(u.sid, u.agent.id)
      const at = blob.positions.get(id)!
      const x = cx + at.x
      const y = cy + at.y
      const dx = x - u.agent.x
      const dy = y - u.agent.y
      const cluster = group.clusters.find(c => c.session.id === u.sid)!
      agents.set(id, {
        ...u.agent, id,
        parentId: u.agent.parentId && cluster.agents.some(p => p.id === u.agent.parentId) ? ns(u.sid, u.agent.parentId) : null,
        x, y, sessionId: u.sid, pinned: true,
      })
      sessionOfAgent.set(id, u.sid)
      nodePositions.push({ id, x, y })
      for (const tc of u.toolCalls) {
        const tid = ns(u.sid, tc.id)
        toolCalls.set(tid, { ...tc, id: tid, agentId: id, x: tc.x + dx, y: tc.y + dy })
      }
      members.push({ id, pad: u.reach })
    }
    // Edges inside a session node (to its satellites, or sub-agent spawns) keep their shape; none join two sessions.
    for (const c of group.clusters) {
      for (const e of c.edges) edges.push({ ...e, id: ns(c.session.id, e.id), from: ns(c.session.id, e.from), to: ns(c.session.id, e.to) })
    }
    const gc = graphCloud.get(cloudId)
    cloudViews.push({ id: cloudId, label: identity, color: gc?.color ?? groupColor(identity), status: gc?.status ?? 'idle', members })
  })

  // 3. Resources near the weighted centroid of the clouds they link to; unlinked ones on the rim.
  // Placed from the layout, before drags, so a dragged node does not move the map around it.
  const resources = graph.nodes.filter(nd => nd.kind === 'kanban' || nd.kind === 'supermemory' || nd.kind === 'bash' || nd.kind === 'subsystem')
  // A link pulls the resource towards the session nodes that used it (not the cloud as a whole).
  const linksOf = new Map<string, PlacementResource['links'][number][]>()
  for (const e of graph.edges) {
    if (!centers.has(e.from)) continue
    const list = linksOf.get(e.to) ?? []
    list.push({ cloudId: e.from, weight: e.weight, sessions: e.sessions.map(s => ({ id: s.sessionId, weight: s.weight })) })
    linksOf.set(e.to, list)
  }
  const spots = placeResources(
    [...centers].map(([id, c]) => ({ id, x: c.x, y: c.y, r: c.r, nodes: cloudNodes.get(id) })),
    resources.map(r => ({ id: r.id, links: linksOf.get(r.id) ?? [] })),
  )
  /** Where each resource belongs (also where a dragged one was dropped): the scene draws them there, the hook glides to it. */
  const resourceTargets = new Map<string, { x: number; y: number }>()
  for (const node of resources) {
    const p = input.moved?.get(node.id) ?? spots.get(node.id)!
    resourceTargets.set(node.id, { x: p.x, y: p.y })
    agents.set(node.id, resourceAgent(node, p.x, p.y))
  }
  for (const e of graph.edges) {
    if (!centers.has(e.from) || !agents.has(e.to)) continue
    edges.push({
      id: e.id, from: e.from, to: e.to, type: 'resource', opacity: 1, fromCloud: true, lastUsedAt: e.lastUsedAt,
      ...(e.life ? { lingerMs: e.life.lingerMs, fadeMs: e.life.fadeMs } : {}),
      color: e.kind === 'kanban' ? KANBAN_COLOR : e.kind === 'bash' ? BASH_COLOR : e.kind === 'subsystem' ? SUBSYSTEM_COLOR : SUPERMEMORY_COLOR,
    })
  }

  // Dragged nodes keep their place; their satellites keep orbiting them (offset kept at placement).
  for (const [id, pos] of input.moved ?? []) {
    const a = agents.get(id)
    if (!a) continue
    const ddx = pos.x - a.x
    const ddy = pos.y - a.y
    agents.set(id, { ...a, x: pos.x, y: pos.y })
    for (const [tid, tc] of toolCalls) if (tc.agentId === id) toolCalls.set(tid, { ...tc, x: tc.x + ddx, y: tc.y + ddy })
  }

  let currentTime = 0
  for (const s of sessions) currentTime = Math.max(currentTime, input.stateOf(s.id).currentTime)
  const state = createEmptyState({
    agents, toolCalls, edges, keepFinished: true, isPlaying: false, currentTime, maxTimeReached: currentTime,
    clouds: cloudViews, pulses: input.pulses ? [...input.pulses] : [],
  })
  return { state, sessionOfAgent, clusters: centers, resourceTargets }
}

/**
 * Resource-anchor layout (see lib/fleet/anchor-mode.ts). The same units (session nodes with their satellites) as the
 * cloud layout, but placed by what they use:
 *   - resources are the anchors, laid out by co-use of session nodes plus explicit links (a board and the memory of its project);
 *   - a session node sits beside the resource it uses now, else among the ones it used before;
 *   - no halo and no grouping: a cloud stays in the data (links, ghosts) with `anchor: true` and is not drawn;
 *   - the profile shows as the colour of its nodes (palette[hash(name) mod length], or the override).
 * Which node used a resource comes from the link's `sessions` (the attribution by time of fleet-graph); a link without
 * one is attributed to the profile's newest session node, so the resource still has a user.
 */
function buildAnchorScene(
  input: FleetSceneInput, byIdentity: Map<string, { clusters: Cluster[]; units: Unit[] }>,
): FleetScene {
  const { sessions, graph } = input
  const now = input.now ?? Date.now()
  const palette = input.palette ?? DEFAULT_PROFILE_PALETTE
  const ns = (sid: string, id: string) => sceneId(sid, id)
  const identities = [...byIdentity.keys()].sort((a, b) => a.localeCompare(b))
  const graphCloud = new Map(graph.clouds.map(c => [c.id, c]))

  // Session nodes of each profile, newest first (the fallback user of a resource), and the units by scene id.
  interface AnchorUnit { id: string; unit: Unit; identity: string }
  const unitsById = new Map<string, AnchorUnit>()
  const nodesOfCloud = new Map<string, string[]>()
  for (const identity of identities) {
    const group = byIdentity.get(identity)!
    group.units.sort((a, b) => b.start - a.start || nodeInstanceId(b.sid, b.agent.id).localeCompare(nodeInstanceId(a.sid, a.agent.id)))
    const ids: string[] = []
    for (const unit of group.units) {
      const id = ns(unit.sid, unit.agent.id)
      unitsById.set(id, { id, unit, identity })
      ids.push(id)
    }
    nodesOfCloud.set(cloudIdOf(identity), ids)
  }

  // 1. Who used what: per session node and resource, how often and when last.
  const resources = graph.nodes.filter(nd => nd.kind === 'kanban' || nd.kind === 'supermemory' || nd.kind === 'bash' || nd.kind === 'subsystem')
  const resourceIds = new Set(resources.map(r => r.id))
  const uses: UseItem[] = []
  const usage = new Map<string, Map<string, { weight: number; lastAt: number }>>()
  const sourcesOfEdge = new Map<string, string[]>()
  const note = (unit: string, resource: string, weight: number, at: number) => {
    uses.push({ unit, resource, weight })
    const m = usage.get(unit) ?? new Map<string, { weight: number; lastAt: number }>()
    const prev = m.get(resource)
    m.set(resource, { weight: (prev?.weight ?? 0) + weight, lastAt: Math.max(prev?.lastAt ?? 0, at) })
    usage.set(unit, m)
  }
  for (const e of graph.edges) {
    const nodes = nodesOfCloud.get(e.from)
    if (!nodes || !resourceIds.has(e.to)) continue
    const known = e.sessions.filter(s => unitsById.has(s.sessionId))
    if (known.length > 0) {
      sourcesOfEdge.set(e.id, known.map(s => s.sessionId))
      for (const s of known) {
        const at = e.events.reduce((m, ev) => (ev.sessionId === s.sessionId ? Math.max(m, ev.at) : m), 0)
        note(s.sessionId, e.to, s.weight, at || e.lastUsedAt)
      }
    } else {
      sourcesOfEdge.set(e.id, [nodes[0]])
      note(nodes[0], e.to, Math.max(e.weight, 1), e.lastUsedAt)
    }
  }

  // 2. Anchors by co-use and explicit links; session nodes beside the resource they use.
  const weights = layoutWeights(coUseWeights(uses), explicitLinkPairs(resources.map(r => ({ id: r.id, kind: r.kind, label: r.label }))))
  // Spread to the shape of the viewport (only ever apart, so the least separation holds).
  const anchors = fitAnchorsToAspect(placeAnchors(resources.map(r => r.id), weights), input.aspect ?? 1)
  const anchorSessions: AnchorSession[] = [...unitsById.values()].map(u => ({
    id: u.id, radius: u.unit.radius,
    usage: [...(usage.get(u.id) ?? [])].map(([resource, v]) => ({ resource, weight: v.weight, lastAt: v.lastAt })),
  }))
  const spots = placeAnchorSessions(anchorSessions, anchors, { now })

  // 3. The scene: session nodes (tinted by profile), their satellites, the resource nodes.
  const agents = new Map<string, Agent>()
  const toolCalls = new Map<string, ToolCallNode>()
  const edges: Edge[] = []
  const sessionOfAgent = new Map<string, string>()
  const centers = new Map<string, { x: number; y: number; r: number; identity: string }>()
  const cloudViews: CloudView[] = []
  for (const identity of identities) {
    const group = byIdentity.get(identity)!
    const cloudId = cloudIdOf(identity)
    const color = profileColor(identity, palette, input.profileColors)
    const members: CloudView['members'] = []
    const pts: Array<{ x: number; y: number; pad: number }> = []
    for (const unit of group.units) {
      const id = ns(unit.sid, unit.agent.id)
      const at = spots.get(id)!
      const dx = at.x - unit.agent.x
      const dy = at.y - unit.agent.y
      const cluster = group.clusters.find(c => c.session.id === unit.sid)!
      agents.set(id, {
        ...unit.agent, id,
        parentId: unit.agent.parentId && cluster.agents.some(p => p.id === unit.agent.parentId) ? ns(unit.sid, unit.agent.parentId) : null,
        x: at.x, y: at.y, sessionId: unit.sid, pinned: true, tint: color,
      })
      sessionOfAgent.set(id, unit.sid)
      for (const tc of unit.toolCalls) {
        const tid = ns(unit.sid, tc.id)
        toolCalls.set(tid, { ...tc, id: tid, agentId: id, x: tc.x + dx, y: tc.y + dy })
      }
      members.push({ id, pad: unit.reach })
      pts.push({ x: at.x, y: at.y, pad: unit.reach })
    }
    for (const c of group.clusters) {
      for (const e of c.edges) edges.push({ ...e, id: ns(c.session.id, e.id), from: ns(c.session.id, e.from), to: ns(c.session.id, e.to) })
    }
    if (pts.length > 0) {
      const x = pts.reduce((s, p) => s + p.x, 0) / pts.length
      const y = pts.reduce((s, p) => s + p.y, 0) / pts.length
      centers.set(cloudId, { x, y, r: pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - x, p.y - y) + p.pad), 0) + HALO_PAD, identity })
    }
    const gc = graphCloud.get(cloudId)
    cloudViews.push({ id: cloudId, label: identity, color, status: gc?.status ?? 'idle', members, anchor: true })
  }

  const resourceTargets = new Map<string, { x: number; y: number }>()
  for (const node of resources) {
    const p = input.moved?.get(node.id) ?? anchors.get(node.id)!
    resourceTargets.set(node.id, { x: p.x, y: p.y })
    agents.set(node.id, resourceAgent(node, p.x, p.y))
  }
  for (const e of graph.edges) {
    if (!centers.has(e.from) || !agents.has(e.to)) continue
    edges.push({
      id: e.id, from: e.from, to: e.to, type: 'resource', opacity: 1, fromCloud: true, lastUsedAt: e.lastUsedAt,
      ...(e.life ? { lingerMs: e.life.lingerMs, fadeMs: e.life.fadeMs } : {}),
      color: e.kind === 'kanban' ? KANBAN_COLOR : e.kind === 'bash' ? BASH_COLOR : e.kind === 'subsystem' ? SUBSYSTEM_COLOR : SUPERMEMORY_COLOR,
      sourceIds: sourcesOfEdge.get(e.id) ?? [],
    })
  }

  // Dragged nodes keep their place; their satellites keep orbiting them.
  for (const [id, pos] of input.moved ?? []) {
    const a = agents.get(id)
    if (!a) continue
    const ddx = pos.x - a.x
    const ddy = pos.y - a.y
    agents.set(id, { ...a, x: pos.x, y: pos.y })
    for (const [tid, tc] of toolCalls) if (tc.agentId === id) toolCalls.set(tid, { ...tc, x: tc.x + ddx, y: tc.y + ddy })
  }

  let currentTime = 0
  for (const s of sessions) currentTime = Math.max(currentTime, input.stateOf(s.id).currentTime)
  const relations = buildRelations({ uses, nodesOf: new Map(), weights })
  // A sub-agent hangs on its parent node (as in the single view): hovering either keeps the other at full opacity.
  for (const a of agents.values()) {
    if (a.resourceKind || !a.parentId || !agents.has(a.parentId)) continue
    ;(relations.get(a.id) ?? relations.set(a.id, new Set()).get(a.id) as Set<string>).add(a.parentId)
    ;(relations.get(a.parentId) ?? relations.set(a.parentId, new Set()).get(a.parentId) as Set<string>).add(a.id)
  }
  // Resources without any use still get an (empty) entry, so a hover on them finds nothing related instead of nothing known.
  for (const r of resources) if (!relations.has(r.id)) relations.set(r.id, new Set())
  const state = createEmptyState({
    agents, toolCalls, edges, keepFinished: true, isPlaying: false, currentTime, maxTimeReached: currentTime,
    clouds: cloudViews, pulses: input.pulses ? [...input.pulses] : [], relations,
  })
  return { state, sessionOfAgent, clusters: centers, resourceTargets }
}

/**
 * What a click on a node of the scene opens: the session detail of that agent. Resources open nothing
 * here (the map shows their inspector). `instanceId` is the node that is selected on the map.
 * `openId` is what the detail panel opens: the node itself, or, for a profile whose only node is
 * its main node (it has no conversation of its own), the plain session id, so the panel shows
 * that profile's most recently active session node.
 */
export function openTargetOf(scene: FleetScene, nodeId: string | null): { sessionId: string; instanceId: string; openId: string } | null {
  if (!nodeId) return null
  const agent = scene.state.agents.get(nodeId)
  const toolAgent = scene.state.toolCalls.get(nodeId)?.agentId
  const id = agent ? agent.id : toolAgent
  if (!id) return null
  const sessionId = scene.sessionOfAgent.get(id)
  if (!sessionId) return null
  const isMain = scene.state.agents.get(id)?.isMain === true
  return { sessionId, instanceId: id, openId: isMain ? sessionId : id }
}

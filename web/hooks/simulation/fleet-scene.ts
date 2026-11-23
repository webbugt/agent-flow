/**
 * Fleet scene: the Fleet node map drawn by the SAME canvas renderer as the single-session view.
 *
 * Every Hermes profile (bridge session) is replayed through the normal simulation handlers
 * (processEvent), so its agent nodes get the same hexagon/glow/label, and the tool calls,
 * messages and sub-agents of each node orbit it as the same satellites, placed by the same
 * slot finder. The replays of all sessions are laid out as clusters on one canvas, with the
 * Kanban boards and Supermemory namespaces around them, linked to the profiles that use them.
 *
 * Pure data code (no React, no DOM), so it is unit-testable:
 *   - {@link FleetReplay} keeps one settled simulation state per session and only processes
 *     the events that arrived since the last call (the buffers are append-only).
 *   - {@link buildFleetScene} filters by the fleet selection, lays the clusters out and returns
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
import { KANBAN_COLOR, SUPERMEMORY_COLOR } from '@/lib/fleet/fleet-colors'
import {
  identityFromLabel, nodeInstanceId, splitInstanceId,
  type FleetInstance, type FleetSelectionView, type SessionLike,
} from '@/lib/fleet/fleet-model'
import type { FleetGraph } from '@/lib/fleet/fleet-graph'
import { profileKey } from '@/lib/fleet/fleet-graph'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import { createEmptyState, edgeId, type SimulationState } from './types'
import { processEvent, type ProcessEventContext } from './process-event'
import { findToolSlot } from './tool-slot'
import { pruneRestingTools } from './animate'
import { snapVisualState } from './snap-visual-state'

/** Kanban events shown as satellites of a profile's main node (the newest). */
export const KANBAN_SATELLITES_PER_PROFILE = 3
/** Gap between clusters / between a cluster grid and the resource columns, world units. */
const CLUSTER_GAP_X = 60
const CLUSTER_GAP_Y = 50
const RESOURCE_GAP = 150
const RESOURCE_PITCH = 110

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
  /** Fleet instances (one per agent node), for the selection. */
  instances: readonly FleetInstance[]
  selection: FleetSelectionView
  /** Resources and their links to profiles, from buildFleetGraph. */
  graph: FleetGraph
  kanban?: readonly PublicKanbanBoardNode[]
  /** Wide: resources in columns left and right. Narrow (phone): rows above and below. */
  narrow?: boolean
  /** Clusters per row (default: by the square-ish root). */
  columns?: number
  /** Nodes the user dragged: their satellites move with them. Applied over the layout. */
  moved?: ReadonlyMap<string, { x: number; y: number }>
}

export interface FleetScene {
  state: SimulationState
  /** agent id (namespaced) to its session id; resources are not in the map. */
  sessionOfAgent: ReadonlyMap<string, string>
  /** Cluster centres by session id, world coordinates. */
  clusters: ReadonlyMap<string, { x: number; y: number; identity: string }>
}

interface Cluster {
  session: SessionLike
  identity: string
  agents: Agent[]
  toolCalls: ToolCallNode[]
  edges: Edge[]
  /** Bounding box in the session's own coordinates. */
  box: { x1: number; y1: number; x2: number; y2: number }
  mainId: string | null
}

const AGENT_PAD = 70

function extend(box: Cluster['box'], x1: number, y1: number, x2: number, y2: number): void {
  box.x1 = Math.min(box.x1, x1); box.y1 = Math.min(box.y1, y1)
  box.x2 = Math.max(box.x2, x2); box.y2 = Math.max(box.y2, y2)
}

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
  // The main node reads as its profile (its own name), not as the first user message the single view renames it to.
  const agents = [...state.agents.values()].filter(a => visibleIn(s, own, selection, a))
    .map(a => (a.isMain && a.name !== a.id ? { ...a, name: a.id } : a))
  if (agents.length === 0) return null
  const ids = new Set(agents.map(a => a.id))
  const toolCalls = [...state.toolCalls.values()].filter(tc => ids.has(tc.agentId))
  const toolIds = new Set(toolCalls.map(tc => tc.id))
  const edges = state.edges.filter(e => ids.has(e.from) && (ids.has(e.to) || toolIds.has(e.to)))
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  for (const a of agents) {
    extend(box, a.x - AGENT_PAD, a.y - AGENT_PAD, a.x + AGENT_PAD, a.y + AGENT_PAD)
    if (a.messageBubbles.length > 0) extend(box, a.x, a.y - 30, a.x + 300, a.y - 20 + a.messageBubbles.length * 60 + 20)
  }
  for (const tc of toolCalls) extend(box, tc.x - TOOL_CARD_W / 2, tc.y - TOOL_CARD_H / 2, tc.x + TOOL_CARD_W / 2, tc.y + TOOL_CARD_H / 2)
  const main = agents.find(a => a.isMain) ?? agents.find(a => !a.parentId || !ids.has(a.parentId)) ?? agents[0]
  return { session: s, identity: identityFromLabel(s.label), agents, toolCalls, edges, box, mainId: main.id }
}

/** Kanban events of a profile's boards as satellites of its main node (newest first, capped). */
function addKanbanSatellites(
  cluster: Cluster, kanban: readonly PublicKanbanBoardNode[], shownBoards: ReadonlySet<string>,
): void {
  if (!cluster.mainId) return
  const main = cluster.agents.find(a => a.id === cluster.mainId)
  if (!main) return
  const key = profileKey(cluster.identity)
  const events: Array<{ board: PublicKanbanBoardNode; e: PublicKanbanBoardNode['recentEvents'][number] }> = []
  for (const board of kanban) {
    if (!shownBoards.has(board.id)) continue
    for (const e of board.recentEvents) if (e.assignee && profileKey(e.assignee) === key) events.push({ board, e })
  }
  events.sort((a, b) => b.e.at - a.e.at)
  const agents = new Map(cluster.agents.map(a => [a.id, a]))
  const cards = new Map(cluster.toolCalls.map(tc => [tc.id, tc]))
  for (const { board, e } of events.slice(0, KANBAN_SATELLITES_PER_PROFILE).reverse()) {
    const id = `kanban:${board.slug}:${e.id}`
    const pos = findToolSlot(main, agents, cards, 0)
    const card: ToolCallNode = {
      id, agentId: main.id, toolName: `kanban · ${e.kind}`, state: 'complete',
      args: e.taskTitle ?? e.taskId,
      inputData: { board: board.name || board.slug, task: e.taskId, event: e.kind },
      x: pos.x, y: pos.y, offX: pos.x - main.x, offY: pos.y - main.y,
      startTime: 0, completeTime: 0, opacity: 0.7,
    }
    cards.set(id, card)
    cluster.toolCalls.push(card)
    cluster.edges.push({ id: edgeId(main.id, id), from: main.id, to: id, type: 'tool', opacity: 1 })
    extend(cluster.box, pos.x - TOOL_CARD_W / 2, pos.y - TOOL_CARD_H / 2, pos.x + TOOL_CARD_W / 2, pos.y + TOOL_CARD_H / 2)
  }
}

function resourceAgent(node: FleetGraph['nodes'][number], x: number, y: number): Agent {
  return {
    id: node.id, name: node.label, state: node.status === 'active' ? 'tool_calling' : 'idle',
    parentId: null, tokensUsed: 0, tokensMax: 1, contextBreakdown: emptyContextBreakdown(),
    toolCalls: 0, timeAlive: 0, x, y, vx: 0, vy: 0, pinned: true, isMain: false,
    task: node.sublabel, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    resourceKind: node.kind === 'kanban' ? 'kanban' : 'supermemory',
  }
}

export function buildFleetScene(input: FleetSceneInput): FleetScene {
  const { sessions, selection, graph } = input
  const shownBoards = new Set(graph.nodes.filter(n => n.kind === 'kanban').map(n => n.id))

  // 1. One cluster per session that has something visible. Order: profile name, then session id.
  const clusters: Cluster[] = []
  for (const s of sessions) {
    const own = input.instances.filter(i => i.id === s.id || i.id.startsWith(`${s.id}::`))
    const c = buildCluster(s, input.stateOf(s.id), own, selection)
    if (c) clusters.push(c)
  }
  clusters.sort((a, b) => a.identity.localeCompare(b.identity) || a.session.id.localeCompare(b.session.id))
  for (const c of clusters) if (input.kanban) addKanbanSatellites(c, input.kanban, shownBoards)

  // 2. Grid of clusters, cells sized to the biggest cluster.
  const n = clusters.length
  const cols = Math.max(1, Math.min(n || 1, input.columns ?? Math.ceil(Math.sqrt(n))))
  const rows = Math.max(1, Math.ceil(n / cols))
  // Column widths and row heights follow their own clusters, so one big profile does not
  // blow up the space of the small ones. cxs/cys are cell centres, the first at 0.
  const colW = Array.from({ length: cols }, () => 0)
  const rowH = Array.from({ length: rows }, () => 0)
  clusters.forEach((c, i) => {
    colW[i % cols] = Math.max(colW[i % cols], c.box.x2 - c.box.x1)
    rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], c.box.y2 - c.box.y1)
  })
  const centres = (sizes: number[], gap: number) => {
    const out: number[] = []
    let edge = 0
    sizes.forEach((s, k) => { out.push(k === 0 ? 0 : edge + gap + s / 2); edge = out[k] + s / 2 })
    return out
  }
  const cxs = centres(colW, CLUSTER_GAP_X)
  const cys = centres(rowH, CLUSTER_GAP_Y)

  const agents = new Map<string, Agent>()
  const toolCalls = new Map<string, ToolCallNode>()
  const edges: Edge[] = []
  const sessionOfAgent = new Map<string, string>()
  const centers = new Map<string, { x: number; y: number; identity: string }>()
  const mainOfSession = new Map<string, string>()
  const ns = (sid: string, id: string) => sceneId(sid, id)

  clusters.forEach((c, i) => {
    const cx = cxs[i % cols]
    const cy = cys[Math.floor(i / cols)]
    // Move the cluster's box centre onto the cell centre.
    const dx = cx - (c.box.x1 + c.box.x2) / 2
    const dy = cy - (c.box.y1 + c.box.y2) / 2
    const sid = c.session.id
    centers.set(sid, { x: cx, y: cy, identity: c.identity })
    for (const a of c.agents) {
      const id = ns(sid, a.id)
      agents.set(id, {
        ...a, id, parentId: a.parentId && c.agents.some(p => p.id === a.parentId) ? ns(sid, a.parentId) : null,
        x: a.x + dx, y: a.y + dy, sessionId: sid, pinned: true,
      })
      sessionOfAgent.set(id, sid)
    }
    for (const tc of c.toolCalls) {
      const id = ns(sid, tc.id)
      toolCalls.set(id, { ...tc, id, agentId: ns(sid, tc.agentId), x: tc.x + dx, y: tc.y + dy })
    }
    for (const e of c.edges) edges.push({ ...e, id: ns(sid, e.id), from: ns(sid, e.from), to: ns(sid, e.to) })
    if (c.mainId) mainOfSession.set(sid, ns(sid, c.mainId))
  })

  // Dragged nodes keep their place; their satellites keep orbiting them (offset kept at placement).
  for (const [id, pos] of input.moved ?? []) {
    const a = agents.get(id)
    if (!a) continue
    const ddx = pos.x - a.x
    const ddy = pos.y - a.y
    agents.set(id, { ...a, x: pos.x, y: pos.y })
    for (const [tid, tc] of toolCalls) if (tc.agentId === id) toolCalls.set(tid, { ...tc, x: tc.x + ddx, y: tc.y + ddy })
  }

  // 3. Resources around the grid, linked to the profiles that use them.
  const gridW = cxs[cols - 1]
  const gridH = cys[rows - 1]
  const left = -colW[0] / 2 - RESOURCE_GAP / 2
  const right = gridW + colW[cols - 1] / 2 + RESOURCE_GAP / 2
  const top = -rowH[0] / 2 - RESOURCE_GAP / 2
  const bottom = gridH + rowH[rows - 1] / 2 + RESOURCE_GAP / 2
  const place = (nodes: FleetGraph['nodes'], side: 'left' | 'right') => {
    nodes.forEach((node, i) => {
      const k = i - (nodes.length - 1) / 2
      const x = input.narrow ? gridW / 2 + k * RESOURCE_PITCH : side === 'left' ? left : right
      const y = input.narrow ? (side === 'left' ? top : bottom) : gridH / 2 + k * RESOURCE_PITCH
      agents.set(node.id, resourceAgent(node, x, y))
    })
  }
  place(graph.nodes.filter(nd => nd.kind === 'kanban'), 'left')
  place(graph.nodes.filter(nd => nd.kind === 'supermemory'), 'right')

  for (const e of graph.edges) {
    if (e.kind === 'session') continue
    const resource = agents.get(e.to)
    const profile = graph.nodes.find(nd => nd.id === e.from)
    if (!resource || !profile?.openId) continue
    const main = mainOfSession.get(splitInstanceId(profile.openId).sessionId)
    if (!main) continue
    edges.push({ id: `res:${main}>${e.to}`, from: main, to: e.to, type: 'resource', opacity: 1, active: e.active, color: e.kind === 'kanban' ? KANBAN_COLOR : SUPERMEMORY_COLOR })
  }

  let currentTime = 0
  for (const s of sessions) currentTime = Math.max(currentTime, input.stateOf(s.id).currentTime)
  const state = createEmptyState({
    agents, toolCalls, edges, keepFinished: true, isPlaying: false, currentTime, maxTimeReached: currentTime,
  })
  return { state, sessionOfAgent, clusters: centers }
}

/** What a click on a node of the scene opens: the session detail of that agent. Resources open nothing. */
export function openTargetOf(scene: FleetScene, nodeId: string | null): { sessionId: string; instanceId: string } | null {
  if (!nodeId) return null
  const agent = scene.state.agents.get(nodeId)
  const toolAgent = scene.state.toolCalls.get(nodeId)?.agentId
  const id = agent ? agent.id : toolAgent
  if (!id) return null
  const sessionId = scene.sessionOfAgent.get(id)
  return sessionId ? { sessionId, instanceId: id } : null
}

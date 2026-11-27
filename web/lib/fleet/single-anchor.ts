/**
 * Resource-anchor mode in the SINGLE view (one open session). Pure functions, no React, no clock, no DOM.
 *
 * The single view draws the session's own agent tree (main agent, sub-agents, tool calls) from the live simulation.
 * In anchor mode the resources that session used (the blocks of single-blocks.ts) become anchor NODES on the same
 * canvas, and the whole tree sits beside the resource it uses now:
 *
 *   - {@link layoutSingleAnchor}: anchors by co-use (uses close together in time, see proximityWeights) plus explicit
 *     links (a board and the memory of its project); the tree's spot next to the resource of the newest use, or on a
 *     ring around the map when it has used none.
 *   - {@link composeSingleFrame}: the frame to draw: the source state with the tree moved so its main agent is at
 *     `rootAt` (the caller glides it there, so the tree drifts instead of jumping), the profile colour on every
 *     node of the tree, the resource nodes, one link per used resource, and the hover relations.
 */
import { emptyContextBreakdown, type Agent, type Edge, type ToolCallNode } from '@/lib/agent-types'
import type { SimulationState } from '@/hooks/simulation/types'
import { BASH_COLOR, KANBAN_COLOR, SUBSYSTEM_COLOR, SUPERMEMORY_COLOR } from './fleet-colors'
import type { CloudView } from './fleet-cloud-geometry'
import type { Point } from './fleet-placement'
import type { ResourceKind } from './options-registry'
import {
  buildRelations, explicitLinkPairs, layoutWeights, placeAnchorSessions, placeAnchors, proximityWeights, type PairWeights,
} from './anchor-mode'

export const SINGLE_CLOUD_ID = 'anchor:single'
/** Uses closer together than this count as used together, ms. */
export const SINGLE_PROXIMITY_MS = 45_000
/** Largest radius the tree is given when its spot is searched, world units (a big tree may overlap a far anchor). */
export const MAX_TREE_RADIUS = 220

export interface SingleAnchorBlock {
  /** Block id `kind:key`. */
  id: string
  kind: ResourceKind
  label: string
  sublabel: string
  /** 0..1, the block's own fade (a pinned block is 1). */
  alpha: number
  lingerMs?: number
  fadeMs?: number
}

export interface SingleUseEvent {
  /** Block id of the resource. */
  resource: string
  /** Epoch ms. */
  at: number
}

export interface SingleAnchorLayout {
  anchors: Map<string, Point>
  weights: PairWeights
  /** Where the main agent goes. */
  rootAt: Point
  /** The resource the tree is next to because it uses it now, or null. */
  at: string | null
  /** Resource id to the newest use (epoch ms) and the number of uses. */
  usage: Map<string, { count: number; lastAt: number }>
}

/** The main agent of a state: the one marked main, else the first without a parent, else the first. */
export function rootOf(agents: ReadonlyMap<string, Agent>): Agent | null {
  let first: Agent | null = null
  let top: Agent | null = null
  for (const a of agents.values()) {
    if (a.resourceKind) continue
    if (a.isMain) return a
    if (!first) first = a
    if (!top && !a.parentId) top = a
  }
  return top ?? first
}

/** Radius of the tree around its main agent (agents and tool calls), capped. */
export function treeRadius(agents: ReadonlyMap<string, Agent>, toolCalls: ReadonlyMap<string, ToolCallNode>, root: Agent): number {
  let r = 70
  for (const a of agents.values()) if (!a.resourceKind) r = Math.max(r, Math.hypot(a.x - root.x, a.y - root.y) + 50)
  for (const tc of toolCalls.values()) r = Math.max(r, Math.hypot(tc.x - root.x, tc.y - root.y) + 50)
  return Math.min(r, MAX_TREE_RADIUS)
}

export function layoutSingleAnchor(
  blocks: readonly SingleAnchorBlock[], events: readonly SingleUseEvent[], treeR: number, now: number,
): SingleAnchorLayout {
  const ids = blocks.map(b => b.id)
  const known = new Set(ids)
  const usage = new Map<string, { count: number; lastAt: number }>()
  for (const e of events) {
    if (!known.has(e.resource)) continue
    const u = usage.get(e.resource)
    usage.set(e.resource, { count: (u?.count ?? 0) + 1, lastAt: Math.max(u?.lastAt ?? 0, e.at) })
  }
  const coUse = proximityWeights(events.filter(e => known.has(e.resource)), SINGLE_PROXIMITY_MS)
  const weights = layoutWeights(coUse, explicitLinkPairs(blocks.map(b => ({ id: b.id, kind: b.kind === 'memory' ? 'supermemory' : b.kind, label: b.label }))))
  const anchors = placeAnchors(ids, weights)
  const spot = placeAnchorSessions([{
    id: 'tree', radius: treeR,
    usage: [...usage].map(([resource, u]) => ({ resource, weight: u.count, lastAt: u.lastAt })),
  }], anchors, { now }).get('tree') ?? { x: 0, y: 0, at: null }
  return { anchors, weights, rootAt: { x: spot.x, y: spot.y }, at: spot.at, usage }
}

const KIND_COLOR: Record<ResourceKind, string> = {
  kanban: KANBAN_COLOR, memory: SUPERMEMORY_COLOR, bash: BASH_COLOR, subsystem: SUBSYSTEM_COLOR,
}

function resourceNode(b: SingleAnchorBlock, at: Point): Agent {
  return {
    id: b.id, name: b.label, state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 1, contextBreakdown: emptyContextBreakdown(),
    toolCalls: 0, timeAlive: 0, x: at.x, y: at.y, vx: 0, vy: 0, pinned: true, isMain: false,
    task: b.sublabel, spawnTime: 0, opacity: Math.max(0, Math.min(1, b.alpha)), scale: 1, messageBubbles: [],
    resourceKind: b.kind === 'memory' ? 'supermemory' : b.kind,
  }
}

export interface ComposeInput {
  source: SimulationState
  blocks: readonly SingleAnchorBlock[]
  layout: SingleAnchorLayout
  /** Where the main agent is drawn now (glided towards `layout.rootAt` by the caller). */
  rootAt: Point
  /** Profile colour of the session (hex), put on every node of the tree. */
  tint: string
  /** Profile name, the label of the (undrawn) cloud. */
  profile: string
}

/** The frame to draw. A source without a main agent is returned as it is. */
export function composeSingleFrame(input: ComposeInput): SimulationState {
  const { source, blocks, layout, tint } = input
  const root = rootOf(source.agents)
  if (!root) return source
  const dx = input.rootAt.x - root.x
  const dy = input.rootAt.y - root.y

  const agents = new Map<string, Agent>()
  for (const [id, a] of source.agents) {
    if (a.resourceKind) continue
    agents.set(id, { ...a, x: a.x + dx, y: a.y + dy, tint })
  }
  const toolCalls = new Map<string, ToolCallNode>()
  for (const [id, tc] of source.toolCalls) toolCalls.set(id, { ...tc, x: tc.x + dx, y: tc.y + dy })

  const edges: Edge[] = [...source.edges]
  const used: Array<{ resource: string; weight: number }> = []
  for (const b of blocks) {
    const at = layout.anchors.get(b.id)
    if (!at) continue
    agents.set(b.id, resourceNode(b, at))
    const u = layout.usage.get(b.id)
    if (!u) continue
    used.push({ resource: b.id, weight: u.count })
    edges.push({
      id: `${SINGLE_CLOUD_ID}>${b.id}`, from: SINGLE_CLOUD_ID, to: b.id, type: 'resource', opacity: 1, fromCloud: true,
      lastUsedAt: u.lastAt, color: KIND_COLOR[b.kind], sourceIds: [root.id],
      ...(b.lingerMs !== undefined ? { lingerMs: b.lingerMs } : {}), ...(b.fadeMs !== undefined ? { fadeMs: b.fadeMs } : {}),
    })
  }

  const relations = buildRelations({
    uses: used.map(u => ({ unit: root.id, resource: u.resource, weight: u.weight })),
    nodesOf: new Map(), weights: layout.weights,
  })
  // The tree hangs together: an agent relates to its parent (and so to its sub-agents).
  const link = (a: string, b: string) => {
    ;(relations.get(a) ?? relations.set(a, new Set()).get(a) as Set<string>).add(b)
    ;(relations.get(b) ?? relations.set(b, new Set()).get(b) as Set<string>).add(a)
  }
  for (const a of agents.values()) if (!a.resourceKind && a.parentId && agents.has(a.parentId)) link(a.id, a.parentId)
  for (const b of blocks) if (!relations.has(b.id)) relations.set(b.id, new Set())

  const cloud: CloudView = {
    id: SINGLE_CLOUD_ID, label: input.profile, color: tint, status: root.state === 'idle' ? 'idle' : 'active',
    members: [...agents.values()].filter(a => !a.resourceKind).map(a => ({ id: a.id, pad: 60 })), anchor: true,
  }
  return { ...source, agents, toolCalls, edges, clouds: [cloud], relations }
}

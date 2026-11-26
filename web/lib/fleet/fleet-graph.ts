/**
 * Fleet graph: what the Fleet map draws, as data.
 *
 * Pure data code (no React, no DOM): builds the graph from the same inputs as the timeline
 * (instances, Kanban boards, Supermemory namespaces, the fleet selection), so it is unit-testable.
 * Placement lives in fleet-placement.ts, the canvas scene in hooks/simulation/fleet-scene.ts.
 *
 *   - Agent clouds: one cloud per Hermes profile (every profile with sessions, live or idle).
 *     A cloud is NOT a node: it only groups its session nodes (soft halo and caption on the map).
 *     There is no hub node and no link between sessions of one profile.
 *   - Sessions: one node per session (agent node) of a profile. Nothing is capped.
 *   - Resources are resource blocks (resource-block.ts): each appears when an agent touches it, lives for the linger
 *     of its kind in the options, then fades; a pin keeps it.
 *       Kanban: one per board with a task event (kanban-blocks.ts), `kanban` linger.
 *       Memory: one per Supermemory namespace with a call (memory-blocks.ts), `memory` linger. Tag and counts only.
 *       Bash: one per command head with a call by a shown profile (bash-blocks.ts), `bash` linger. Head only.
 *   - Links: cloud -> Kanban board when the board's recent events name the profile as assignee;
 *     cloud -> Supermemory namespace when the namespace has events by that profile;
 *     cloud -> Bash command head when that profile ran it. Every link
 *     stores `lastUsedAt` (see fleet-edge-life.ts for when it is drawn).
 *
 * Nothing here depends on which tab is open: the graph is built from ALL profiles.
 */
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'
import {
  groupInstances, latestInstance, splitInstanceId,
  type FleetInstance, type FleetInstanceStatus, type FleetSelectionView,
} from './fleet-model'
import { BASH_COLOR, KANBAN_COLOR, SUPERMEMORY_COLOR } from './fleet-colors'
import { defaultOptions, type AgentFlowOptions } from './options-registry'
import { EMPTY_PINS, isBlockShown, lifeViewOf, resolveLife, type BlockLife, type PinSet } from './resource-block'
import {
  buildKanbanBlocks, isKanbanBoardShown, kanbanBlockId, kanbanBlockInfo, kanbanCountsLine, kanbanLifeView,
  type KanbanBlockInfo,
} from './kanban-blocks'
import type { BlockLifeView } from './block-alpha'
import { bashBlockId, bashCountsLine, buildBashBlocks, type BashHeadNode } from './bash-blocks'
import { buildMemoryBlocks, memoryBlockId } from './memory-blocks'
export { BASH_COLOR, KANBAN_COLOR, SUPERMEMORY_COLOR }

export type FleetNodeKind = 'session' | 'kanban' | 'supermemory' | 'bash'

export interface FleetGraphNode {
  id: string
  kind: FleetNodeKind
  label: string
  sublabel?: string
  color: string
  /** Sessions: status of the session. Resources: `active` while work runs / was recent. */
  status: FleetInstanceStatus
  /** Instance id to open in the session detail. */
  openId?: string
  /** Session nodes: id of the cloud (profile) they belong to. */
  cloudId?: string
  /** Kanban nodes (resource blocks): board slug, counts and event kinds only. */
  block?: KanbanBlockInfo
  /** Resource blocks (Kanban, memory, bash): the block's life (last use, linger, fade, pin), so the draw loop fades it on the wall clock. */
  life?: BlockLifeView
}

/** The sessions of one profile, drawn as a blob with a halo and the profile name. Not a node. */
export interface FleetCloud {
  /** `cloud:<identity>`. */
  id: string
  /** Profile name, the caption. */
  profile: string
  color: string
  /** Worst-case status of its sessions. */
  status: FleetInstanceStatus
  /** Ids of its session nodes (instance ids). */
  sessionIds: string[]
  /** Instance id of its latest session (what the detail panel opens for the profile). */
  openId?: string
}

export type FleetEdgeKind = 'kanban' | 'memory' | 'bash'

/** One interaction behind a link; `key` is unique and stable, so a pulse fires only once per event. */
export interface FleetEdgeEvent {
  key: string
  /** Epoch ms. */
  at: number
  kind: FleetEdgeKind
  /** Kanban event kind, the Supermemory action, or `run` for a Bash call. */
  label: string
}

export interface FleetGraphEdge {
  id: string
  /** Cloud id. */
  from: string
  /** Resource node id. */
  to: string
  kind: FleetEdgeKind
  /** Epoch ms of the newest interaction over the link. */
  lastUsedAt: number
  /** Number of events behind the link; the weight of the cloud in the resource's placement. */
  weight: number
  /** The latest interactions behind the link, newest first (what a pulse is made of). */
  events: FleetEdgeEvent[]
  /** Links of a resource block follow the linger and fade of the block's kind (options). Without it: the fixed edge window. */
  life?: BlockLife
}

export interface FleetGraph {
  nodes: FleetGraphNode[]
  clouds: FleetCloud[]
  edges: FleetGraphEdge[]
}

export const EMPTY_GRAPH: FleetGraph = { nodes: [], clouds: [], edges: [] }

/** A resource counts as active (in use) when its newest event is this recent, ms. */
const RECENT_USE_MS = 30 * 60_000

/** Profile names compare without case, dashes or spaces: "omh-coder" = "OMH Coder" = "omh coder". Hermes' default profile is shown as "Hermes". */
export function profileKey(name: string): string {
  const k = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return k === 'default' ? 'hermes' : k
}

const STATUS_RANK: Record<FleetInstanceStatus, number> = { completed: 0, idle: 1, active: 2, error: 3 }

function worst(statuses: readonly FleetInstanceStatus[]): FleetInstanceStatus {
  let out: FleetInstanceStatus = 'completed'
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[out]) out = s
  return out
}

function sessionLabel(inst: FleetInstance): string {
  const name = splitInstanceId(inst.id).agentName ?? ''
  const at = name.indexOf('·')
  return (at === -1 ? name : name.slice(at + 1)).trim() || inst.runtime
}

export function cloudIdOf(identity: string): string {
  return `cloud:${identity}`
}

export interface FleetGraphInput {
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
  /** Bash command heads from the BashUseTracker (bash-blocks.ts). */
  bash?: readonly BashHeadNode[]
  selection: FleetSelectionView
  /** Epoch ms, to judge whether a resource is in use. */
  now: number
  /** Linger, fade and show/hide per block kind. Default: the registry defaults. */
  options?: AgentFlowOptions
  /** Ids of pinned blocks (`kanban:<slug>`, `memory:<tag>`, `bash:<head>`); a pinned block stays visible. Default: none. */
  pins?: PinSet
}

function newestFirst(a: FleetEdgeEvent, b: FleetEdgeEvent): number {
  return b.at - a.at || a.key.localeCompare(b.key)
}

export function buildFleetGraph(input: FleetGraphInput): FleetGraph {
  const { selection: sel, now } = input
  const options = input.options ?? defaultOptions()
  const pins = input.pins ?? EMPTY_PINS
  const kanbanLife = resolveLife('kanban', options)
  const blocks = buildKanbanBlocks(input.kanban)
  const memoryBlocks = buildMemoryBlocks(input.supermemory)
  const memoryLife = resolveLife('memory', options)
  const bashLife = resolveLife('bash', options)
  const nodes: FleetGraphNode[] = []
  const clouds: FleetCloud[] = []
  const edges = new Map<string, FleetGraphEdge>()
  /** profileKey -> cloud, for the resource links. */
  const cloudByKey = new Map<string, FleetCloud>()

  /** One link per (cloud, resource); uses by several names of the same profile merge into it. */
  const addUse = (cloud: FleetCloud, to: string, kind: FleetEdgeKind, weight: number, lastUsedAt: number, events: FleetEdgeEvent[], life?: BlockLife) => {
    const id = `${cloud.id}>${to}`
    const prev = edges.get(id)
    if (prev) {
      prev.weight += weight
      prev.lastUsedAt = Math.max(prev.lastUsedAt, lastUsedAt)
      prev.events = [...prev.events, ...events].sort(newestFirst)
    } else {
      edges.set(id, { id, from: cloud.id, to, kind, lastUsedAt, weight, events: [...events].sort(newestFirst), ...(life ? { life } : {}) })
    }
  }

  for (const group of groupInstances(input.instances)) {
    const shown = group.instances.filter(i => sel.isSelected(i.id))
    if (shown.length === 0) continue
    const cloud: FleetCloud = {
      id: cloudIdOf(group.identity), profile: group.identity, color: group.color,
      status: worst(shown.map(i => i.status)), sessionIds: [], openId: latestInstance(shown)?.id,
    }
    // Running first, then the most recently started. Every session is drawn: nothing is capped.
    const order = [...shown].sort((a, b) =>
      Number(b.endTime === undefined) - Number(a.endTime === undefined) || b.startTime - a.startTime || a.id.localeCompare(b.id))
    for (const inst of order) {
      nodes.push({
        id: inst.id, kind: 'session', label: sessionLabel(inst), sublabel: inst.runtime,
        color: group.color, status: inst.status, openId: inst.id, cloudId: cloud.id,
      })
      cloud.sessionIds.push(inst.id)
    }
    clouds.push(cloud)
    cloudByKey.set(profileKey(group.identity), cloud)
  }

  for (const board of input.kanban ?? []) {
    if (!sel.isSelected(board.id)) continue
    // Archived boards are noise on the map (the timeline panel still lists them).
    if (board.archived) continue
    // A board is a resource block: drawn only while it is in use (a task event within linger + fade of the
    // kanban kind), unless pinned, and only while the kanban kind is switched on for the fleet view.
    if (!isKanbanBoardShown(board, blocks, now, options, pins)) continue
    const running = board.taskCounts.running ?? 0
    const info = kanbanBlockInfo(board)
    const block = blocks.get(kanbanBlockId(board.slug))!
    nodes.push({
      id: board.id, kind: 'kanban', label: board.slug, sublabel: kanbanCountsLine(info),
      color: KANBAN_COLOR, status: running > 0 ? 'active' : 'idle',
      block: info, life: kanbanLifeView(block, options, pins),
    })
    // Who uses the board: assignees of its recent events.
    const used = new Map<string, FleetEdgeEvent[]>()
    for (const e of board.recentEvents) {
      if (!e.assignee) continue
      const key = profileKey(e.assignee)
      const list = used.get(key) ?? []
      list.push({ key: `${board.id}#${e.id}`, at: e.at, kind: 'kanban', label: e.kind })
      used.set(key, list)
    }
    for (const [key, events] of used) {
      const cloud = cloudByKey.get(key)
      if (!cloud) continue
      addUse(cloud, board.id, 'kanban', events.length, Math.max(...events.map(e => e.at)), events, kanbanLife)
    }
  }

  for (const space of input.supermemory ?? []) {
    if (!sel.isSelected(space.id)) continue
    // A namespace is a resource block: drawn only while an agent used it within linger + fade of the memory kind
    // (or pinned), and only while the memory kind is switched on for the fleet view.
    const block = memoryBlocks.get(memoryBlockId(space.containerTag))
    if (!block || !isBlockShown(block, now, 'fleet', options, pins)) continue
    nodes.push({
      id: space.id, kind: 'supermemory', label: space.containerTag,
      sublabel: `${space.counts.store}s ${space.counts.search}q ${space.counts.forget}f`,
      color: SUPERMEMORY_COLOR,
      status: space.lastEventAt !== null && now - space.lastEventAt <= RECENT_USE_MS ? 'active' : 'idle',
      life: lifeViewOf(block, options, pins),
    })
    const recent = space.recent ?? []
    for (const [name, counts] of Object.entries(space.byProfile)) {
      const cloud = cloudByKey.get(profileKey(name))
      if (!cloud) continue
      const events: FleetEdgeEvent[] = recent
        .filter(r => r.profile === name)
        .map(r => ({ key: `${space.id}#${r.profile}:${r.action}:${r.at}`, at: r.at, kind: 'memory' as const, label: r.action }))
      // `lastByProfile` is not capped like `recent`, so it is the better source for the use time.
      const last = space.lastByProfile?.[name] ?? events[0]?.at ?? space.lastEventAt ?? 0
      addUse(cloud, space.id, 'memory', counts.store + counts.search + counts.forget, last, events, memoryLife)
    }
  }

  // Bash command heads: a block per head, counted for the profiles whose cloud is on the map.
  const bashBlocks = buildBashBlocks(input.bash, profile => cloudByKey.has(profileKey(profile)))
  for (const head of input.bash ?? []) {
    const block = bashBlocks.get(bashBlockId(head.head))
    if (!block || !isBlockShown(block, now, 'fleet', options, pins)) continue
    nodes.push({
      id: head.id, kind: 'bash', label: head.head, sublabel: bashCountsLine(block.useCount),
      color: BASH_COLOR, status: now - block.lastUsedAt <= bashLife.lingerMs ? 'active' : 'idle',
      life: lifeViewOf(block, options, pins),
    })
    for (const [profile, use] of Object.entries(head.byProfile)) {
      const cloud = cloudByKey.get(profileKey(profile))
      if (!cloud) continue
      const events: FleetEdgeEvent[] = head.recent
        .filter(r => r.profile === profile)
        .map(r => ({ key: `${head.id}#${r.profile}:${r.at}:${r.command.length}`, at: r.at, kind: 'bash' as const, label: 'run' }))
      addUse(cloud, head.id, 'bash', use.count, use.lastUsedAt, events, bashLife)
    }
  }

  return { nodes, clouds, edges: [...edges.values()] }
}

/** Counts per node kind (and clouds), e.g. for a legend or a test. */
export function countByKind(graph: FleetGraph): Record<FleetNodeKind | 'cloud', number> {
  const out: Record<FleetNodeKind | 'cloud', number> = { cloud: graph.clouds.length, session: 0, kanban: 0, supermemory: 0, bash: 0 }
  for (const n of graph.nodes) out[n.kind]++
  return out
}

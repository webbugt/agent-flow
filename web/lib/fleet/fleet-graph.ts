/**
 * Fleet node map: the big canvas of the Fleet view.
 *
 * Pure data code (no React, no DOM): builds the graph from the same inputs as the
 * timeline (instances, Kanban boards, Supermemory namespaces, the fleet selection)
 * and lays it out for a given viewport, so both are unit-testable.
 *
 *   - Agents: one node per Hermes profile (every profile with sessions, live or idle),
 *     with one satellite node per session (agent node) of that profile.
 *   - Resources: one node per Kanban board and one per Supermemory namespace.
 *   - Links: profile -> its sessions; profile -> a Kanban board when the board's
 *     recent events name the profile as assignee; profile -> a Supermemory
 *     namespace when the namespace has events by that profile.
 *
 * Nothing here depends on which tab is open: the graph is built from ALL profiles.
 */
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'
import {
  groupInstances, latestInstance, splitInstanceId,
  type FleetInstance, type FleetInstanceStatus, type FleetSelectionView,
} from './fleet-model'

export type FleetNodeKind = 'profile' | 'session' | 'kanban' | 'supermemory'

export interface FleetGraphNode {
  id: string
  kind: FleetNodeKind
  label: string
  sublabel?: string
  color: string
  /** Profiles and sessions: worst-case status of what they stand for. Resources: `active` while work runs. */
  status: FleetInstanceStatus
  /** Instance id to open in the session detail (profile: its latest session). */
  openId?: string
  /** Session nodes: id of the profile node they hang off. */
  profileId?: string
  /** Profile nodes: sessions of the profile not drawn (cap), so the map stays readable. */
  hiddenSessions?: number
}

export type FleetEdgeKind = 'session' | 'kanban' | 'memory'

export interface FleetGraphEdge {
  id: string
  from: string
  to: string
  kind: FleetEdgeKind
  /** The profile is running and the link saw recent use: drawn animated. */
  active: boolean
  /** Number of events behind the link (1 for structural links). */
  weight: number
}

export interface FleetGraph {
  nodes: FleetGraphNode[]
  edges: FleetGraphEdge[]
}

/** Sessions drawn per profile (newest and running first); the rest is counted on the profile node. */
export const MAX_SESSIONS_PER_PROFILE = 8
/** A board link counts as in use when its event is this recent, ms. */
const RECENT_USE_MS = 30 * 60_000

export const KANBAN_COLOR = '#ffbb44'
export const SUPERMEMORY_COLOR = '#cc88ff'

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

export interface FleetGraphInput {
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
  selection: FleetSelectionView
  /** Epoch ms, to judge "recent" board use. */
  now: number
}

export function buildFleetGraph(input: FleetGraphInput): FleetGraph {
  const { selection: sel, now } = input
  const nodes: FleetGraphNode[] = []
  const edges: FleetGraphEdge[] = []
  /** profileKey -> profile node, for the resource links. */
  const profileByKey = new Map<string, FleetGraphNode>()

  for (const group of groupInstances(input.instances)) {
    const shown = group.instances.filter(i => sel.isSelected(i.id))
    if (shown.length === 0) continue
    const status = worst(shown.map(i => i.status))
    const latest = latestInstance(shown)
    const profile: FleetGraphNode = {
      id: `profile:${group.identity}`, kind: 'profile', label: group.identity,
      sublabel: `${shown.length} session${shown.length === 1 ? '' : 's'}${status === 'idle' ? ' · idle' : status === 'active' ? ' · active' : ''}`,
      color: group.color, status, openId: latest?.id,
    }
    nodes.push(profile)
    profileByKey.set(profileKey(group.identity), profile)

    // Running first, then the most recently started; the cap keeps a busy profile readable.
    const order = [...shown].sort((a, b) =>
      Number(b.endTime === undefined) - Number(a.endTime === undefined) || b.startTime - a.startTime || a.id.localeCompare(b.id))
    const drawn = order.slice(0, MAX_SESSIONS_PER_PROFILE)
    if (order.length > drawn.length) profile.hiddenSessions = order.length - drawn.length
    for (const inst of drawn) {
      const node: FleetGraphNode = {
        id: inst.id, kind: 'session', label: sessionLabel(inst), sublabel: inst.runtime,
        color: group.color, status: inst.status, openId: inst.id, profileId: profile.id,
      }
      nodes.push(node)
      edges.push({ id: `${profile.id}>${inst.id}`, from: profile.id, to: inst.id, kind: 'session', active: inst.status === 'active', weight: 1 })
    }
  }

  for (const board of input.kanban ?? []) {
    if (!sel.isSelected(board.id)) continue
    // Archived or never-used boards are noise on the map (the timeline panel still lists them).
    if (board.archived || (board.totalTasks === 0 && board.recentEvents.length === 0)) continue
    const running = board.taskCounts.running ?? 0
    const blocked = board.taskCounts.blocked ?? 0
    const node: FleetGraphNode = {
      id: board.id, kind: 'kanban', label: board.name || board.slug,
      sublabel: `${board.totalTasks} tasks${running ? ` · ${running} run` : ''}${blocked ? ` · ${blocked} blk` : ''}`,
      color: KANBAN_COLOR, status: running > 0 ? 'active' : 'idle',
    }
    nodes.push(node)
    // Who uses the board: assignees of its recent events.
    const used = new Map<string, { count: number; last: number }>()
    for (const e of board.recentEvents) {
      if (!e.assignee) continue
      const key = profileKey(e.assignee)
      const u = used.get(key) ?? { count: 0, last: 0 }
      u.count++
      u.last = Math.max(u.last, e.at)
      used.set(key, u)
    }
    for (const [key, u] of used) {
      const profile = profileByKey.get(key)
      if (!profile) continue
      edges.push({
        id: `${profile.id}>${node.id}`, from: profile.id, to: node.id, kind: 'kanban',
        active: profile.status === 'active' && now - u.last <= RECENT_USE_MS, weight: u.count,
      })
    }
  }

  for (const space of input.supermemory ?? []) {
    if (!sel.isSelected(space.id)) continue
    const node: FleetGraphNode = {
      id: space.id, kind: 'supermemory', label: space.containerTag,
      sublabel: `${space.counts.store}s ${space.counts.search}q ${space.counts.forget}f`,
      color: SUPERMEMORY_COLOR,
      status: space.lastEventAt !== null && now - space.lastEventAt <= RECENT_USE_MS ? 'active' : 'idle',
    }
    nodes.push(node)
    for (const [name, counts] of Object.entries(space.byProfile)) {
      const profile = profileByKey.get(profileKey(name))
      if (!profile) continue
      const weight = counts.store + counts.search + counts.forget
      edges.push({
        id: `${profile.id}>${node.id}`, from: profile.id, to: node.id, kind: 'memory',
        active: profile.status === 'active' && space.lastEventAt !== null && now - space.lastEventAt <= RECENT_USE_MS, weight,
      })
    }
  }

  return capResources({ nodes, edges })
}

/** Resource nodes drawn per kind; the rest stays in the timeline panel. */
export const MAX_RESOURCES_PER_KIND = 8

/** Keep the busiest resources: linked to the most profiles, then the heaviest links. Edges of dropped nodes go too. */
function capResources(graph: FleetGraph): FleetGraph {
  const drop = new Set<string>()
  for (const kind of ['kanban', 'supermemory'] as const) {
    const rank = new Map<string, [number, number]>()
    for (const n of graph.nodes) if (n.kind === kind) rank.set(n.id, [0, 0])
    for (const e of graph.edges) {
      const r = rank.get(e.to)
      if (r) { r[0]++; r[1] += e.weight }
    }
    const ordered = [...rank.entries()].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || a[0].localeCompare(b[0]))
    for (const [id] of ordered.slice(MAX_RESOURCES_PER_KIND)) drop.add(id)
  }
  if (drop.size === 0) return graph
  return {
    nodes: graph.nodes.filter(n => !drop.has(n.id)),
    edges: graph.edges.filter(e => !drop.has(e.from) && !drop.has(e.to)),
  }
}

/** Counts per node kind, e.g. for a legend or a test. */
export function countByKind(graph: FleetGraph): Record<FleetNodeKind, number> {
  const out: Record<FleetNodeKind, number> = { profile: 0, session: 0, kanban: 0, supermemory: 0 }
  for (const n of graph.nodes) out[n.kind]++
  return out
}

// ─── Layout ─────────────────────────────────────────────────────────────────

export interface FleetLayoutOptions {
  width: number
  height: number
  /** Space kept free at the top (top bar) and bottom (timeline panel), and right (session detail). */
  insetTop?: number
  insetBottom?: number
  insetRight?: number
}

export interface PlacedNode extends FleetGraphNode {
  /** Horizontal room for the label, px (resources); undefined = no limit. */
  labelWidth?: number
  x: number
  y: number
  radius: number
}

export interface FleetLayout {
  nodes: PlacedNode[]
  /** Drawing scale (1 = full size); labels on crowded maps are skipped below ~0.6. */
  scale: number
}

const PAD = 16
const NARROW_WIDTH = 720

/**
 * Place the graph in the free area. Wide: Kanban boards in a column on the left,
 * Supermemory namespaces in a column on the right, profiles in a grid between them,
 * each with its sessions on a ring. Narrow (phone): boards in a row on top, profiles
 * in the middle, namespaces in a row at the bottom. Deterministic: same input, same map.
 */
export function layoutFleetGraph(graph: FleetGraph, opts: FleetLayoutOptions): FleetLayout {
  const top = opts.insetTop ?? 0
  const bottom = opts.insetBottom ?? 0
  const right = opts.insetRight ?? 0
  const area = { x: PAD, y: top + PAD, w: Math.max(opts.width - right - 2 * PAD, 40), h: Math.max(opts.height - top - bottom - 2 * PAD, 40) }
  const narrow = opts.width < NARROW_WIDTH

  const profiles = graph.nodes.filter(n => n.kind === 'profile')
  const boards = graph.nodes.filter(n => n.kind === 'kanban')
  const spaces = graph.nodes.filter(n => n.kind === 'supermemory')
  const sessionsOf = new Map<string, FleetGraphNode[]>()
  for (const n of graph.nodes) {
    if (n.kind !== 'session' || !n.profileId) continue
    const list = sessionsOf.get(n.profileId)
    if (list) list.push(n)
    else sessionsOf.set(n.profileId, [n])
  }

  // Zones for profiles, boards, namespaces.
  const RES_BAND = narrow ? 104 : 150 // thickness of a resource column (wide) or row (narrow)
  const hasBoards = boards.length > 0
  const hasSpaces = spaces.length > 0
  let profileZone = { ...area }
  let boardZone: typeof area | null = null
  let spaceZone: typeof area | null = null
  if (narrow) {
    if (hasBoards) { boardZone = { x: area.x, y: area.y, w: area.w, h: RES_BAND }; profileZone.y += RES_BAND; profileZone.h -= RES_BAND }
    if (hasSpaces) { spaceZone = { x: area.x, y: area.y + area.h - RES_BAND, w: area.w, h: RES_BAND }; profileZone.h -= RES_BAND }
  } else {
    if (hasBoards) { boardZone = { x: area.x, y: area.y, w: RES_BAND, h: area.h }; profileZone.x += RES_BAND; profileZone.w -= RES_BAND }
    if (hasSpaces) { spaceZone = { x: area.x + area.w - RES_BAND, y: area.y, w: RES_BAND, h: area.h }; profileZone.w -= RES_BAND }
  }
  profileZone.w = Math.max(profileZone.w, 40)
  profileZone.h = Math.max(profileZone.h, 40)

  const placed: PlacedNode[] = []

  // Profiles: grid, as square cells as the zone allows.
  const n = profiles.length
  let cols = 1
  let rows = 1
  if (n > 0) {
    let bestSize = -1
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c)
      const size = Math.min(profileZone.w / c, profileZone.h / r)
      if (size > bestSize + 1e-9) { bestSize = size; cols = c; rows = r }
    }
  }
  const cellW = profileZone.w / cols
  const cellH = profileZone.h / rows
  const half = Math.min(cellW, cellH) / 2

  // One drawing scale for the whole map, so sizes stay comparable. Needed outer radius at scale 1:
  const PROFILE_R = 16
  const SESSION_R = 7
  const maxSessions = Math.max(1, ...profiles.map(p => sessionsOf.get(p.id)?.length ?? 0))
  const ringAt1 = Math.max(PROFILE_R + SESSION_R + 8, SESSION_R / Math.sin(Math.PI / Math.max(maxSessions, 2)) + 3)
  const outerAt1 = ringAt1 + SESSION_R + 4
  const scale = Math.max(0.3, Math.min(1, half / outerAt1))

  profiles.forEach((p, i) => {
    const cx = profileZone.x + (i % cols + 0.5) * cellW
    const cy = profileZone.y + (Math.floor(i / cols) + 0.5) * cellH
    placed.push({ ...p, x: cx, y: cy, radius: PROFILE_R * scale, labelWidth: cellW })
    const own = sessionsOf.get(p.id) ?? []
    const ring = ringAt1 * scale
    own.forEach((s, k) => {
      // Start at the top, clockwise.
      const a = -Math.PI / 2 + (2 * Math.PI * k) / own.length
      placed.push({ ...s, x: cx + ring * Math.cos(a), y: cy + ring * Math.sin(a), radius: SESSION_R * scale })
    })
  })

  const RES_R = 12 * Math.max(scale, 0.7)
  // Resources: one column (wide) or up to two rows (narrow); labels get the cell width.
  const line = (items: FleetGraphNode[], zone: typeof area, horizontal: boolean) => {
    const rowsN = horizontal && items.length > 4 ? 2 : horizontal ? 1 : items.length
    const perRow = horizontal ? Math.ceil(items.length / rowsN) : 1
    const cw = zone.w / perRow
    items.forEach((node, i) => {
      const col = horizontal ? i % perRow : 0
      const row = horizontal ? Math.floor(i / perRow) : i
      placed.push({
        ...node,
        x: zone.x + (col + 0.5) * cw,
        y: zone.y + (row + 0.5) * (zone.h / rowsN),
        radius: RES_R,
        labelWidth: cw,
      })
    })
  }
  if (boardZone) line(boards, boardZone, narrow)
  if (spaceZone) line(spaces, spaceZone, narrow)

  return { nodes: placed, scale }
}

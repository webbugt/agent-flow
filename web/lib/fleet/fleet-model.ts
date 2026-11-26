/**
 * Fleet model: agent instances grouped by identity, plus Kanban board and
 * Supermemory namespace lanes, all on ONE shared time axis.
 *
 * Pure data code (no React, no DOM, no sqlite at runtime) so it is unit-testable
 * and safe to import from client components. The two source modules are imported
 * as types only: their readers use node:sqlite and must stay server-side.
 */
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'

export const DAY_MS = 86_400_000

// ─── Instances & groups ─────────────────────────────────────────────────────

/** `idle`: nothing running right now (restored from history, or quiet), but active within the idle window. */
export type FleetInstanceStatus = 'active' | 'idle' | 'completed' | 'error'

export interface FleetMarker {
  id: string
  /** Epoch ms. */
  at: number
  kind: 'tool_call' | 'created' | 'started' | 'blocked' | 'completed'
  label: string
}

/** One record per agent instance (a session). Times are epoch milliseconds. */
export interface FleetInstance {
  id: string
  /** Agent identity (role or profile name, e.g. "taxis"). Grouping key. */
  identity: string
  runtime: string
  parentId?: string
  startTime: number
  /** Undefined while the instance is still running. */
  endTime?: number
  status: FleetInstanceStatus
  markers: FleetMarker[]
  /**
   * Epoch ms of the newest event seen for this instance (tool call, message, spawn, completion).
   * Absent: derive it from startTime, endTime and markers (see fleet-activity-filter).
   */
  lastEventAt?: number
}

export interface FleetGroup {
  identity: string
  /** Group selection id, `group:<identity>`. */
  id: string
  color: string
  instances: FleetInstance[]
}

/** Lane colours: one per group, shared by all copies in the group. */
export const GROUP_PALETTE = [
  '#66ccff', '#ffbb44', '#66ffaa', '#cc88ff', '#ff7788', '#88ddcc', '#ddcc66', '#7799ff',
] as const

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Preferred palette slot for an identity (hash). groupInstances resolves collisions between groups. */
export function groupColor(identity: string): string {
  return GROUP_PALETTE[hashString(identity) % GROUP_PALETTE.length]
}

export function groupSelectionId(identity: string): string {
  return `group:${identity}`
}

/**
 * Derive an agent identity from a session label such as "taxis · fix login"
 * or "sophia: weekly review". Falls back to "unknown".
 */
export function identityFromLabel(label: string | undefined | null): string {
  const first = (label ?? '').trim().split(/\s*(?:·|—|–|\||:|\s-\s)\s*/)[0]?.trim().toLowerCase() ?? ''
  return first && first.length <= 40 ? first : 'unknown'
}

/** Group by identity. Groups ordered by first start; copies ordered by start. */
export function groupInstances(instances: readonly FleetInstance[]): FleetGroup[] {
  const byIdentity = new Map<string, FleetInstance[]>()
  for (const inst of instances) {
    const list = byIdentity.get(inst.identity)
    if (list) list.push(inst)
    else byIdentity.set(inst.identity, [inst])
  }
  // Colours: hash slot per identity, probing forward past slots already taken so two
  // groups never share a lane colour (until there are more groups than palette slots).
  // Identities are assigned in alphabetical order, so the result does not depend on start times.
  const taken = new Set<string>()
  const colorOf = new Map<string, string>()
  for (const identity of [...byIdentity.keys()].sort()) {
    const base = hashString(identity) % GROUP_PALETTE.length
    let pick: string = GROUP_PALETTE[base]
    for (let i = 0; i < GROUP_PALETTE.length; i++) {
      const candidate = GROUP_PALETTE[(base + i) % GROUP_PALETTE.length]
      if (!taken.has(candidate)) { pick = candidate; break }
    }
    taken.add(pick)
    colorOf.set(identity, pick)
    if (taken.size === GROUP_PALETTE.length) taken.clear()
  }
  const groups: FleetGroup[] = []
  for (const [identity, list] of byIdentity) {
    const sorted = [...list].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
    groups.push({ identity, id: groupSelectionId(identity), color: colorOf.get(identity) as string, instances: sorted })
  }
  return groups.sort((a, b) => a.instances[0].startTime - b.instances[0].startTime || a.identity.localeCompare(b.identity))
}

/** Minimal shape of a bridge session (see lib/bridge-types SessionInfo). */
export interface SessionLike {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** Listed from history only: nothing live, shown idle. */
  idle?: boolean
}

/** Live adapter: one instance per bridge session. No tool-call markers (the bridge does not carry them per session). */
export function instancesFromSessions(sessions: readonly SessionLike[]): FleetInstance[] {
  return sessions.map(s => ({
    id: s.id,
    identity: identityFromLabel(s.label),
    runtime: 'session',
    startTime: s.startTime,
    endTime: s.status === 'completed' ? s.lastActivityTime : undefined,
    status: s.idle ? 'idle' : s.status,
    markers: [],
    lastEventAt: s.lastActivityTime,
  }))
}

/** Minimal shape of a buffered bridge event (see lib/agent-types SimulationEvent). */
export interface SessionEventLike {
  /** Seconds since the node's own time base (`startedAt` of its spawn event). */
  time: number
  type: string
  payload: Record<string, unknown>
}

/** Cap on tool-call markers per node, newest kept: a busy node can have thousands. */
const MAX_MARKERS_PER_INSTANCE = 300

/** Selection id of one agent node inside a session (a profile has one session and many nodes). */
export function nodeInstanceId(sessionId: string, agentName: string): string {
  return `${sessionId}::${agentName}`
}

/** Inverse of nodeInstanceId. A plain session id (no node) gives no agent name. */
export function splitInstanceId(id: string): { sessionId: string; agentName?: string } {
  const at = id.indexOf('::')
  return at === -1 ? { sessionId: id } : { sessionId: id.slice(0, at), agentName: id.slice(at + 2) }
}

interface NodeDraft {
  name: string
  /** Epoch ms that event times of this node count from. */
  base: number
  start: number
  end?: number
  /** Quiet (`agent_idle`) or restored from history (`agent_complete` with `idle`). Cleared by new activity. */
  idle?: boolean
  model?: string
  markers: FleetMarker[]
  /** Epoch ms of the newest event that names this node (not `agent_idle`: that is the absence of activity). */
  lastEventAt?: number
}

/** Events that count as activity of a node, for the latest-activity filter. */
const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent_spawn', 'agent_complete', 'tool_call_start', 'tool_call_end', 'message', 'permission_requested',
])

/** Agent nodes of one session, rebuilt from its buffered events. Only nodes with an epoch time base (`startedAt`) can be placed. */
function nodesFromEvents(sessionId: string, events: readonly SessionEventLike[]): NodeDraft[] {
  const nodes = new Map<string, NodeDraft>()
  /** Record the event as the node's newest activity (the node's time base is set by its spawn). */
  const touch = (node: NodeDraft | undefined, e: SessionEventLike) => {
    if (!node || !ACTIVITY_EVENT_TYPES.has(e.type) || typeof e.time !== 'number') return
    const at = node.base + e.time * 1000
    if (Number.isFinite(at) && (node.lastEventAt === undefined || at > node.lastEventAt)) node.lastEventAt = at
  }
  for (const e of events) {
    const p = e.payload ?? {}
    if (e.type !== 'agent_spawn') {
      const ref = typeof p.agent === 'string' ? p.agent : typeof p.name === 'string' ? p.name : undefined
      touch(ref === undefined ? undefined : nodes.get(ref), e)
    }
    if (e.type === 'agent_spawn') {
      if (p.isMain === true || typeof p.name !== 'string' || typeof p.startedAt !== 'number') continue
      let node = nodes.get(p.name)
      if (node) {
        // Same node active again (a new run): new time base, running again.
        node.base = p.startedAt
        node.end = undefined
        node.idle = false
      } else {
        node = { name: p.name, base: p.startedAt, start: p.startedAt, markers: [] }
        nodes.set(p.name, node)
      }
      if (typeof p.model === 'string') node.model = p.model
      touch(node, e)
    } else if (e.type === 'agent_complete') {
      const node = typeof p.name === 'string' ? nodes.get(p.name) : undefined
      if (node) {
        node.end = Math.max(node.start, node.base + e.time * 1000)
        node.idle = p.idle === true
      }
    } else if (e.type === 'agent_idle') {
      const node = typeof p.name === 'string' ? nodes.get(p.name) : undefined
      if (node && node.end === undefined) node.idle = true
    } else if (e.type === 'tool_call_start') {
      const node = typeof p.agent === 'string' ? nodes.get(p.agent) : undefined
      if (!node) continue
      node.idle = false
      node.markers.push({
        id: `${nodeInstanceId(sessionId, node.name)}:t${node.markers.length}`,
        at: node.base + e.time * 1000,
        kind: 'tool_call',
        label: typeof p.tool === 'string' ? p.tool : 'tool',
      })
    } else if (e.type === 'model_detected') {
      const node = typeof p.agent === 'string' ? nodes.get(p.agent) : undefined
      if (node && typeof p.model === 'string') node.model = p.model
    }
  }
  return [...nodes.values()]
}

/**
 * Live adapter for the whole system: EVERY bridge session (one per Hermes profile),
 * not only the open tab. Each agent node of a session becomes an instance of the
 * session's identity, so a profile with several nodes shows as one group with an
 * `xN` badge. A session with no placeable node yet (not started, or a runtime that
 * sends no `startedAt`) still appears as one instance of its own.
 */
export function instancesFromSessionEvents(
  sessions: readonly SessionLike[],
  eventsOf: (sessionId: string) => readonly SessionEventLike[],
): FleetInstance[] {
  const out: FleetInstance[] = []
  for (const s of sessions) {
    const nodes = nodesFromEvents(s.id, eventsOf(s.id))
    if (nodes.length === 0) {
      out.push(...instancesFromSessions([s]))
      continue
    }
    const identity = identityFromLabel(s.label)
    for (const n of nodes) {
      out.push({
        id: nodeInstanceId(s.id, n.name),
        identity,
        runtime: n.model ?? 'session',
        startTime: n.start,
        endTime: n.end,
        status: n.idle ? 'idle' : n.end === undefined ? 'active' : 'completed',
        markers: n.markers.slice(-MAX_MARKERS_PER_INSTANCE),
        lastEventAt: n.lastEventAt,
      })
    }
  }
  return out
}

/**
 * Sessions the fleet canvas is built from: every session the relay lists (live and
 * idle) plus the tabs the user closed. It never looks at the open tab, so two
 * profiles that are active at once (say Taxis and OMH Coder) are both on the canvas
 * whichever tab is selected.
 */
export function fleetSessions<S extends { id: string }>(open: readonly S[], dismissed: readonly S[]): S[] {
  const ids = new Set(open.map(s => s.id))
  return [...open, ...dismissed.filter(s => !ids.has(s.id))]
}

/**
 * Tab strip of the single-profile view. Only while the Fleet view is on may the fleet
 * selection hide a tab (all of its session's nodes deselected). With Fleet off every
 * tab shows, as before the Fleet view existed. The open tab always shows. Selection
 * never closes a session.
 */
export function tabSessions<S extends { id: string; idle?: boolean }>(
  sessions: readonly S[],
  selectedSessionId: string | null,
  showFleet: boolean,
  instances: readonly FleetInstance[],
  selection: FleetSelectionView,
): S[] {
  // Idle profiles (listed from history only) belong to the fleet view, not the tab strip:
  // with Fleet off the strip holds the same tabs as before. Opening one from the fleet selects it.
  const tabs = sessions.filter(s => !s.idle || s.id === selectedSessionId)
  if (!showFleet) return tabs
  return tabs.filter(s => {
    if (s.id === selectedSessionId) return true
    const own = instances.filter(i => i.id === s.id || i.id.startsWith(`${s.id}::`))
    // No fleet data for a session: keep its tab. Otherwise it shows while any of its nodes is selected.
    return own.length === 0 || own.some(i => selection.isSelected(i.id))
  })
}

// ─── Selection ids for lanes ────────────────────────────────────────────────

export const KANBAN_SECTION_ID = 'section:kanban'
export const SUPERMEMORY_SECTION_ID = 'section:supermemory'

// ─── Rows ───────────────────────────────────────────────────────────────────

export interface FleetSpan {
  start: number
  /** Undefined = still running (drawn up to `now`). */
  end?: number
  status?: FleetInstanceStatus
  /** 0..1 fill strength, for count-weighted lanes (Supermemory days). */
  intensity?: number
  label?: string
}

export type FleetRowKind = 'group' | 'instance' | 'section' | 'lane'

export interface FleetRow {
  key: string
  kind: FleetRowKind
  label: string
  /** Small secondary text (runtime, counts). */
  sublabel?: string
  color: string
  depth: 0 | 1
  /** Selection ids this row's checkbox toggles (the row's own id, or all ids under a group/section). */
  selectionIds: string[]
  checked: boolean
  indeterminate: boolean
  /** `x3` style badge, only when the group has more than one copy. */
  badge?: string
  expandable: boolean
  expanded: boolean
  /** Drawn greyed out with no data (deselected). The row stays so it can be re-selected. */
  hidden: boolean
  spans: FleetSpan[]
  markers: FleetMarker[]
  /**
   * The session this row opens in the session detail view (clicking the row).
   * An instance row opens its own session; a group row opens its most recently
   * active copy. Kanban and Supermemory rows have none.
   */
  openSessionId?: string
}

/** The copy a group row opens: a running one first, then the one that started last. */
export function latestInstance(instances: readonly FleetInstance[]): FleetInstance | undefined {
  let best: FleetInstance | undefined
  for (const inst of instances) {
    if (!best) { best = inst; continue }
    const running = inst.endTime === undefined
    const bestRunning = best.endTime === undefined
    if (running !== bestRunning ? running : inst.startTime > best.startTime) best = inst
  }
  return best
}

export interface FleetSelectionView {
  /** True if the id is currently selected (visible). */
  isSelected(id: string): boolean
}

function checkState(ids: readonly string[], sel: FleetSelectionView): { checked: boolean; indeterminate: boolean } {
  let on = 0
  for (const id of ids) if (sel.isSelected(id)) on++
  return { checked: ids.length > 0 && on === ids.length, indeterminate: on > 0 && on < ids.length }
}

function instanceSpan(inst: FleetInstance): FleetSpan {
  return { start: inst.startTime, end: inst.endTime, status: inst.status }
}

/** Failure must stay visible when copies are merged: error > active > completed. */
const STATUS_RANK: Record<FleetInstanceStatus, number> = { completed: 0, idle: 1, active: 2, error: 3 }

function worseStatus(a: FleetInstanceStatus | undefined, b: FleetInstanceStatus | undefined): FleetInstanceStatus | undefined {
  if (!a) return b
  if (!b) return a
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a
}

/**
 * Merge overlapping spans so a group lane draws the union of its copies once.
 * The merged span keeps the most severe status of its parts, so a copy that
 * errored still shows red when it overlaps a healthy copy.
 */
export function mergeSpans(spans: readonly FleetSpan[], now: number): FleetSpan[] {
  const sorted = spans.map(s => ({ ...s, end: s.end ?? now })).sort((a, b) => a.start - b.start)
  const out: FleetSpan[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= (last.end as number)) {
      last.end = Math.max(last.end as number, s.end as number)
      last.status = worseStatus(last.status, s.status)
    } else {
      out.push({ start: s.start, end: s.end, status: s.status })
    }
  }
  return out
}

/** Map a raw Hermes kanban event kind onto the lane's four event kinds; null = not shown. */
export function kanbanMarkerKind(kind: string): FleetMarker['kind'] | null {
  switch (kind) {
    case 'created': return 'created'
    case 'claimed':
    case 'spawned': return 'started'
    case 'blocked': return 'blocked'
    case 'completed': return 'completed'
    default: return null
  }
}

function kanbanLaneRow(node: PublicKanbanBoardNode, sel: FleetSelectionView): FleetRow {
  const id = node.id
  const visible = sel.isSelected(id)
  const markers: FleetMarker[] = []
  for (const e of node.recentEvents) {
    const kind = kanbanMarkerKind(e.kind)
    if (!kind) continue
    markers.push({ id: `${id}:${e.id}`, at: e.at, kind, label: `${kind}: ${e.taskTitle ?? e.taskId}` })
  }
  markers.sort((a, b) => a.at - b.at)
  const running = node.taskCounts.running ?? 0
  const blocked = node.taskCounts.blocked ?? 0
  return {
    key: id, kind: 'lane', label: node.name || node.slug,
    sublabel: `${node.totalTasks} tasks${running ? ` · ${running} run` : ''}${blocked ? ` · ${blocked} blk` : ''}`,
    color: '#ffbb44', depth: 1, selectionIds: [id], checked: visible, indeterminate: false,
    expandable: false, expanded: false, hidden: !visible, spans: [],
    markers: visible ? markers : [],
  }
}

function supermemoryLaneRow(node: SupermemoryNamespaceNode, sel: FleetSelectionView): FleetRow {
  const id = node.id
  const visible = sel.isSelected(id)
  const max = Math.max(1, ...node.daily.map(d => d.store + d.search + d.forget))
  const spans: FleetSpan[] = node.daily.map(d => {
    const total = d.store + d.search + d.forget
    const start = Date.parse(`${d.day}T00:00:00Z`)
    return {
      start, end: start + DAY_MS, intensity: total / max,
      label: `${d.day}: ${d.store} store, ${d.search} search, ${d.forget} forget`,
    }
  })
  return {
    key: id, kind: 'lane', label: node.containerTag,
    sublabel: `${node.counts.store}s ${node.counts.search}q ${node.counts.forget}f`,
    color: '#cc88ff', depth: 1, selectionIds: [id], checked: visible, indeterminate: false,
    expandable: false, expanded: false, hidden: !visible, spans: visible ? spans : [], markers: [],
  }
}

export interface BuildRowsInput {
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
  selection: FleetSelectionView
  /** Group identities that are expanded into their copies. */
  expanded: ReadonlySet<string>
  /** Epoch ms used for still-running spans. */
  now: number
}

/**
 * Flatten the fleet into display rows. Deselected items keep a (dimmed) row so
 * they can be re-selected, but carry no spans or markers, so they draw nothing
 * and do not stretch the time axis. Every group row only ever aggregates its
 * own copies.
 */
export function buildFleetRows(input: BuildRowsInput): FleetRow[] {
  const { selection: sel, expanded, now } = input
  const rows: FleetRow[] = []

  for (const group of groupInstances(input.instances)) {
    const ids = group.instances.map(i => i.id)
    const state = checkState(ids, sel)
    const shown = group.instances.filter(i => sel.isSelected(i.id))
    const multi = group.instances.length > 1
    // Every copy quiet or restored from history: the whole profile reads idle.
    const allIdle = group.instances.every(i => i.status === 'idle')
    const isOpen = multi && expanded.has(group.identity)
    rows.push({
      key: group.id, kind: 'group', label: group.identity,
      sublabel: allIdle ? (multi ? 'idle' : `${group.instances[0].runtime} · idle`) : multi ? undefined : group.instances[0].runtime,
      color: group.color, depth: 0, selectionIds: ids,
      checked: state.checked, indeterminate: state.indeterminate,
      badge: multi ? `x${group.instances.length}` : undefined,
      expandable: multi, expanded: isOpen, hidden: shown.length === 0,
      spans: mergeSpans(shown.map(instanceSpan), now),
      markers: shown.flatMap(i => i.markers).sort((a, b) => a.at - b.at),
      openSessionId: latestInstance(group.instances)?.id,
    })
    if (!isOpen) continue
    group.instances.forEach((inst, idx) => {
      const on = sel.isSelected(inst.id)
      rows.push({
        key: inst.id, kind: 'instance', label: `#${idx + 1}`,
        sublabel: `${inst.runtime}${inst.parentId ? ' · sub' : ''}${inst.status === 'idle' ? ' · idle' : ''}`,
        color: group.color, depth: 1, selectionIds: [inst.id],
        checked: on, indeterminate: false, expandable: false, expanded: false, hidden: !on,
        spans: on ? [instanceSpan(inst)] : [], markers: on ? inst.markers : [],
        openSessionId: inst.id,
      })
    })
  }

  const boards = [...(input.kanban ?? [])].sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0) || a.slug.localeCompare(b.slug))
  if (boards.length) rows.push(sectionRow(KANBAN_SECTION_ID, 'Kanban', '#ffbb44', boards.map(b => b.id), sel))
  for (const b of boards) rows.push(kanbanLaneRow(b, sel))

  const spaces = [...(input.supermemory ?? [])].sort((a, b) => a.containerTag.localeCompare(b.containerTag))
  if (spaces.length) rows.push(sectionRow(SUPERMEMORY_SECTION_ID, 'Supermemory', '#cc88ff', spaces.map(s => s.id), sel))
  for (const s of spaces) rows.push(supermemoryLaneRow(s, sel))

  return rows
}

function sectionRow(id: string, label: string, color: string, childIds: string[], sel: FleetSelectionView): FleetRow {
  const state = checkState(childIds, sel)
  return {
    key: id, kind: 'section', label, sublabel: `${childIds.length}`, color, depth: 0,
    selectionIds: childIds, checked: state.checked, indeterminate: state.indeterminate,
    expandable: false, expanded: false, hidden: !state.checked && !state.indeterminate, spans: [], markers: [],
  }
}

/** Every selection id in the fleet (instances, boards, namespaces) for All/None. */
export function allSelectionIds(input: Pick<BuildRowsInput, 'instances' | 'kanban' | 'supermemory'>): string[] {
  return [
    ...input.instances.map(i => i.id),
    ...(input.kanban ?? []).map(b => b.id),
    ...(input.supermemory ?? []).map(s => s.id),
  ]
}

// ─── Shared time axis ───────────────────────────────────────────────────────

export interface FleetAxis {
  min: number
  max: number
  ticks: number[]
  /** Step between ticks, ms. */
  step: number
}

const NICE_STEPS_MS = [
  1_000, 5_000, 10_000, 30_000, 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000,
  3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, DAY_MS, 2 * DAY_MS,
]

export function niceTicks(min: number, max: number, target = 6): { ticks: number[]; step: number } {
  const span = Math.max(max - min, 1)
  const step = NICE_STEPS_MS.find(s => span / s <= target) ?? NICE_STEPS_MS[NICE_STEPS_MS.length - 1]
  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t)
  return { ticks, step }
}

/**
 * One axis for every visible row. Only rows that actually carry data count, so
 * deselecting an agent shrinks the axis. Returns null when nothing is visible.
 */
export function computeAxis(rows: readonly FleetRow[], now: number): FleetAxis | null {
  let min = Infinity
  let max = -Infinity
  for (const row of rows) {
    for (const s of row.spans) {
      min = Math.min(min, s.start)
      max = Math.max(max, s.end ?? now)
    }
    for (const m of row.markers) {
      min = Math.min(min, m.at)
      max = Math.max(max, m.at)
    }
  }
  if (!Number.isFinite(min)) return null
  if (max <= min) max = min + 1_000
  return { min, max, ...niceTicks(min, max) }
}

/** Tick label: time of day for short spans, date for multi-day. */
export function formatTick(t: number, step: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (step >= DAY_MS) return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  if (step < 60_000) return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// ─── Fixture (3 groups, 5 instances) ────────────────────────────────────────

/** Demo/fixture fleet: taxis x2, sophia x2, hestia x1. */
export function createFleetFixture(now: number): FleetInstance[] {
  const m = 60_000
  const mk = (id: string, identity: string, startMin: number, endMin: number | undefined, tools: number[]): FleetInstance => ({
    id, identity, runtime: identity === 'hestia' ? 'codex' : 'claude',
    startTime: now - startMin * m, endTime: endMin === undefined ? undefined : now - endMin * m,
    status: endMin === undefined ? 'active' : 'completed',
    markers: tools.map((t, i) => ({ id: `${id}:t${i}`, at: now - t * m, kind: 'tool_call' as const, label: `tool call ${i + 1}` })),
  })
  return [
    mk('taxis-1', 'taxis', 50, 20, [48, 40, 31]),
    mk('taxis-2', 'taxis', 35, undefined, [33, 20, 8, 2]),
    mk('sophia-1', 'sophia', 45, 30, [44, 38]),
    mk('sophia-2', 'sophia', 28, 12, [26, 18]),
    mk('hestia-1', 'hestia', 15, undefined, [14, 6]),
  ]
}

/**
 * Fleet model: agent instances grouped by identity, plus Kanban board and
 * Supermemory namespace lanes, all on ONE shared time axis.
 *
 * Pure data code (no React, no DOM, no sqlite at runtime) so it is unit-testable
 * and safe to import from client components. The two source modules are imported
 * as types only: their readers use node:sqlite and must stay server-side.
 */
import type { KanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'

export const DAY_MS = 86_400_000

// ─── Instances & groups ─────────────────────────────────────────────────────

export type FleetInstanceStatus = 'active' | 'completed' | 'error'

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
}

/** Live adapter: one instance per bridge session. No tool-call markers (the bridge does not carry them per session). */
export function instancesFromSessions(sessions: readonly SessionLike[]): FleetInstance[] {
  return sessions.map(s => ({
    id: s.id,
    identity: identityFromLabel(s.label),
    runtime: 'session',
    startTime: s.startTime,
    endTime: s.status === 'completed' ? s.lastActivityTime : undefined,
    status: s.status,
    markers: [],
  }))
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

/** Merge overlapping spans so a group lane draws the union of its copies once. */
export function mergeSpans(spans: readonly FleetSpan[], now: number): FleetSpan[] {
  const sorted = spans.map(s => ({ ...s, end: s.end ?? now })).sort((a, b) => a.start - b.start)
  const out: FleetSpan[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= (last.end as number)) {
      last.end = Math.max(last.end as number, s.end as number)
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

function kanbanLaneRow(node: KanbanBoardNode, sel: FleetSelectionView): FleetRow {
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
  kanban?: readonly KanbanBoardNode[]
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
    const isOpen = multi && expanded.has(group.identity)
    rows.push({
      key: group.id, kind: 'group', label: group.identity,
      sublabel: multi ? undefined : group.instances[0].runtime,
      color: group.color, depth: 0, selectionIds: ids,
      checked: state.checked, indeterminate: state.indeterminate,
      badge: multi ? `x${group.instances.length}` : undefined,
      expandable: multi, expanded: isOpen, hidden: shown.length === 0,
      spans: mergeSpans(shown.map(instanceSpan), now),
      markers: shown.flatMap(i => i.markers).sort((a, b) => a.at - b.at),
    })
    if (!isOpen) continue
    group.instances.forEach((inst, idx) => {
      const on = sel.isSelected(inst.id)
      rows.push({
        key: inst.id, kind: 'instance', label: `#${idx + 1}`,
        sublabel: `${inst.runtime}${inst.parentId ? ' · sub' : ''}`,
        color: group.color, depth: 1, selectionIds: [inst.id],
        checked: on, indeterminate: false, expandable: false, expanded: false, hidden: !on,
        spans: on ? [instanceSpan(inst)] : [], markers: on ? inst.markers : [],
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

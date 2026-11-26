/**
 * Fleet filter by latest activity: "All", "Active last 5 min" (default), "30 min", "2 h".
 *
 * A profile, session (agent node) or resource (Kanban board, Supermemory namespace) with no event
 * inside the window is hidden from the fleet views. Hidden is NOT stopped: nothing here talks to
 * a process, relay or session, and the user's own selection (fleet-selection.ts) is left alone.
 * The choice is kept in localStorage.
 *
 * Pure functions on injected data and an injected Storage, so they are testable without a DOM.
 */
import type { StorageLike } from './fleet-selection'
import type { FleetInstance, FleetSelectionView } from './fleet-model'
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'

export type ActivityWindowId = 'all' | '5m' | '30m' | '2h'

export interface ActivityWindowOption {
  id: ActivityWindowId
  label: string
  /** Window length in ms; null = no limit. */
  ms: number | null
}

export const ACTIVITY_WINDOWS: readonly ActivityWindowOption[] = [
  { id: 'all', label: 'All', ms: null },
  { id: '5m', label: 'Active last 5 min', ms: 5 * 60_000 },
  { id: '30m', label: 'Active last 30 min', ms: 30 * 60_000 },
  { id: '2h', label: 'Active last 2 h', ms: 2 * 3_600_000 },
]

export const DEFAULT_ACTIVITY_WINDOW: ActivityWindowId = '5m'
export const FLEET_ACTIVITY_FILTER_KEY = 'agent-flow:fleet-activity-filter:v1'

export function isActivityWindowId(v: unknown): v is ActivityWindowId {
  return typeof v === 'string' && ACTIVITY_WINDOWS.some(w => w.id === v)
}

export function windowMs(id: ActivityWindowId): number | null {
  return ACTIVITY_WINDOWS.find(w => w.id === id)?.ms ?? null
}

/** A missing or garbled stored value gives the default. */
export function parseActivityWindow(raw: string | null | undefined): ActivityWindowId {
  return isActivityWindowId(raw) ? raw : DEFAULT_ACTIVITY_WINDOW
}

export function loadActivityWindow(storage: StorageLike | null | undefined, key = FLEET_ACTIVITY_FILTER_KEY): ActivityWindowId {
  if (!storage) return DEFAULT_ACTIVITY_WINDOW
  try {
    return parseActivityWindow(storage.getItem(key))
  } catch {
    return DEFAULT_ACTIVITY_WINDOW
  }
}

/** Returns false when the write failed (quota, private mode); the choice still works in memory. */
export function saveActivityWindow(storage: StorageLike | null | undefined, id: ActivityWindowId, key = FLEET_ACTIVITY_FILTER_KEY): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, id)
    return true
  } catch {
    return false
  }
}

// ─── Latest activity per node kind ──────────────────────────────────────────

/** Newest of the given epoch-ms values; undefined when none is a finite number. */
function newest(values: ReadonlyArray<number | null | undefined>): number | undefined {
  let out: number | undefined
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && (out === undefined || v > out)) out = v
  }
  return out
}

/** Epoch ms of the instance's newest event: its recorded last event, its start, its end, its newest tool call. */
export function instanceLastActivity(inst: FleetInstance): number | undefined {
  return newest([inst.lastEventAt, inst.startTime, inst.endTime, ...inst.markers.map(m => m.at)])
}

export function kanbanLastActivity(board: PublicKanbanBoardNode): number | undefined {
  return newest([board.lastEventAt, ...board.recentEvents.map(e => e.at)])
}

export function supermemoryLastActivity(space: SupermemoryNamespaceNode): number | undefined {
  return newest([space.lastEventAt, ...Object.values(space.lastByProfile ?? {}), ...(space.recent ?? []).map(r => r.at)])
}

/** In the window: it had an event no more than `ms` before `now`. No event at all = not in the window. */
export function inWindow(lastAt: number | undefined, now: number, ms: number | null): boolean {
  if (ms === null) return true
  return lastAt !== undefined && now - lastAt <= ms
}

// ─── The filter ─────────────────────────────────────────────────────────────

export interface ActivityFilterInput {
  window: ActivityWindowId
  /** Epoch ms. */
  now: number
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
}

/** Ids of the instances (sessions / agent nodes), Kanban boards and Supermemory namespaces outside the window. Empty for "All". */
export function hiddenByActivity(input: ActivityFilterInput): Set<string> {
  const ms = windowMs(input.window)
  const hidden = new Set<string>()
  if (ms === null) return hidden
  for (const inst of input.instances) {
    if (!inWindow(instanceLastActivity(inst), input.now, ms)) hidden.add(inst.id)
  }
  for (const board of input.kanban ?? []) {
    if (!inWindow(kanbanLastActivity(board), input.now, ms)) hidden.add(board.id)
  }
  for (const space of input.supermemory ?? []) {
    if (!inWindow(supermemoryLastActivity(space), input.now, ms)) hidden.add(space.id)
  }
  return hidden
}

/** True when both sets hold the same ids (keeps a rebuild from happening when a clock tick changed nothing). */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/** The user's selection with the activity filter applied on top: visible = selected AND inside the window. */
export function withActivityFilter(selection: FleetSelectionView, hidden: ReadonlySet<string>): FleetSelectionView {
  if (hidden.size === 0) return selection
  return { isSelected: id => selection.isSelected(id) && !hidden.has(id) }
}

/** The same lists minus what the filter hides (for panels that take arrays, not a selection). */
export function applyActivityFilter<L extends readonly { id: string }[]>(items: L, hidden: ReadonlySet<string>): L {
  return hidden.size === 0 ? items : (items.filter(i => !hidden.has(i.id)) as unknown as L)
}

export interface HiddenSummary {
  /** Profiles (identities) with every one of their nodes hidden. */
  profiles: number
  /** Agent nodes / sessions hidden. */
  sessions: number
  /** Kanban boards and Supermemory namespaces hidden. */
  resources: number
}

/** The map never draws archived or never-used boards (see fleet-graph), so they are not "hidden by the filter". */
function boardOnMap(b: PublicKanbanBoardNode): boolean {
  return !(b.archived || (b.totalTasks === 0 && b.recentEvents.length === 0))
}

/**
 * Counts for the control's "N hidden" hint: only what the filter alone takes away, i.e. things the user
 * has not deselected and the map would otherwise draw. A profile counts as hidden only when all its
 * (selected) nodes are.
 */
export function summarizeHidden(
  instances: readonly FleetInstance[],
  kanban: readonly PublicKanbanBoardNode[] | undefined,
  supermemory: readonly SupermemoryNamespaceNode[] | undefined,
  hidden: ReadonlySet<string>,
  selection: FleetSelectionView = { isSelected: () => true },
): HiddenSummary {
  const byProfile = new Map<string, { all: number; hidden: number }>()
  let sessions = 0
  for (const inst of instances) {
    if (!selection.isSelected(inst.id)) continue
    const c = byProfile.get(inst.identity) ?? { all: 0, hidden: 0 }
    c.all++
    if (hidden.has(inst.id)) { c.hidden++; sessions++ }
    byProfile.set(inst.identity, c)
  }
  let profiles = 0
  for (const c of byProfile.values()) if (c.all > 0 && c.hidden === c.all) profiles++
  let resources = 0
  for (const b of kanban ?? []) if (hidden.has(b.id) && selection.isSelected(b.id) && boardOnMap(b)) resources++
  for (const s of supermemory ?? []) if (hidden.has(s.id) && selection.isSelected(s.id)) resources++
  return { profiles, sessions, resources }
}

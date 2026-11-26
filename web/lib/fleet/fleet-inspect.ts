/**
 * Node inspector of the Fleet map: the latest interactions of a Kanban board or a Supermemory
 * namespace, newest first. Read-only; built from what /api/fleet already delivers (a board's
 * `recentEvents`, a namespace's `recent`). No task bodies, no memory content.
 */
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'
import { kanbanBlockInfo, type KanbanBlockInfo } from './kanban-blocks'

/** Rows shown in the inspector. */
export const INSPECT_LIMIT = 20

export interface FleetInteraction {
  /** Epoch ms. */
  at: number
  /** Profile that did it (the task's assignee for Kanban); null when the source has none. */
  profile: string | null
  /** Kanban event kind (claimed, completed, ...) or Supermemory action (store, search, forget). */
  action: string
  /** Kanban: the task title (or id), when there is one. */
  detail?: string
}

export interface FleetInspection {
  id: string
  kind: 'kanban' | 'supermemory'
  title: string
  /** All interactions the source holds (before the display limit). */
  total: number
  /** The newest `limit` of them, newest first. */
  items: FleetInteraction[]
  /** Interactions beyond the limit, for a "+N more" line. */
  more: number
  /** Kanban only: the block's allowed fields (board slug, status counts, event kinds). */
  block?: KanbanBlockInfo
}

/** Latest interactions of the resource `id`, or null when it is neither a known board nor namespace. */
export function inspectResource(
  id: string,
  kanban: readonly PublicKanbanBoardNode[] | undefined,
  supermemory: readonly SupermemoryNamespaceNode[] | undefined,
  limit = INSPECT_LIMIT,
): FleetInspection | null {
  const board = kanban?.find(b => b.id === id)
  if (board) {
    const all: FleetInteraction[] = board.recentEvents
      .map(e => ({ at: e.at, profile: e.assignee, action: e.kind, detail: e.taskTitle ?? e.taskId, order: e.id }))
      // Newest first; the event id breaks ties (it only grows).
      .sort((a, b) => b.at - a.at || b.order - a.order)
      .map(({ order: _order, ...rest }) => rest)
    return { id, kind: 'kanban', title: board.slug, total: all.length, items: all.slice(0, limit), more: Math.max(all.length - limit, 0), block: kanbanBlockInfo(board) }
  }
  const space = supermemory?.find(s => s.id === id)
  if (space) {
    const all: FleetInteraction[] = [...(space.recent ?? [])]
      .sort((a, b) => b.at - a.at || a.profile.localeCompare(b.profile) || a.action.localeCompare(b.action))
      .map(e => ({ at: e.at, profile: e.profile, action: e.action }))
    return { id, kind: 'supermemory', title: space.containerTag, total: all.length, items: all.slice(0, limit), more: Math.max(all.length - limit, 0) }
  }
  return null
}

/** "12s ago", "3 min ago", "2 h ago", "4 d ago". */
export function ageLabel(at: number, now: number): string {
  const s = Math.max(Math.round((now - at) / 1000), 0)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86_400)} d ago`
}

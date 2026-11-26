/**
 * Node inspector of the Fleet map: the latest interactions of a Kanban board, a Supermemory namespace or a Bash
 * command head, newest first. Read-only; built from what /api/fleet already delivers (a board's `recentEvents`, a
 * namespace's `recent`) and from the BashUseTracker (a head's `recent`). No task bodies, no memory content.
 * A Bash row shows the FULL command, as the tracker holds it: already masked (secret-mask.ts), so this module
 * never sees an unmasked command.
 */
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'
import { kanbanBlockInfo, type KanbanBlockInfo } from './kanban-blocks'
import type { BashHeadNode } from './bash-blocks'
import { bashCountsLine } from './bash-blocks'
import { memoryBlockId, memoryBlockInfo, memoryCountsLine } from './memory-blocks'

/** Rows shown in the inspector. */
export const INSPECT_LIMIT = 20

export interface FleetInteraction {
  /** Epoch ms. */
  at: number
  /** Profile that did it (the task's assignee for Kanban); null when the source has none. */
  profile: string | null
  /** Kanban event kind (claimed, completed, ...), Supermemory action (store, search, forget) or `run` (a Bash call). */
  action: string
  /** Kanban: the task title (or id), when there is one. Bash: the full command, masked. */
  detail?: string
}

export interface FleetInspection {
  id: string
  /** The id the block is pinned by (`kanban:<slug>`, `memory:<tag>`, `bash:<head>`). */
  pinId: string
  kind: 'kanban' | 'supermemory' | 'bash'
  title: string
  /** Memory and Bash: the block's counts line ("3 search · 1 store", "4 calls"). No content. */
  summary?: string
  /** All interactions the source holds (before the display limit). */
  total: number
  /** The newest `limit` of them, newest first. */
  items: FleetInteraction[]
  /** Interactions beyond the limit, for a "+N more" line. */
  more: number
  /** Kanban only: the block's allowed fields (board slug, status counts, event kinds). */
  block?: KanbanBlockInfo
}

/** Latest interactions of the resource `id`, or null when it is neither a known board, namespace nor command head. */
export function inspectResource(
  id: string,
  kanban: readonly PublicKanbanBoardNode[] | undefined,
  supermemory: readonly SupermemoryNamespaceNode[] | undefined,
  limit = INSPECT_LIMIT,
  bash?: readonly BashHeadNode[],
): FleetInspection | null {
  const board = kanban?.find(b => b.id === id)
  if (board) {
    const all: FleetInteraction[] = board.recentEvents
      .map(e => ({ at: e.at, profile: e.assignee, action: e.kind, detail: e.taskTitle ?? e.taskId, order: e.id }))
      // Newest first; the event id breaks ties (it only grows).
      .sort((a, b) => b.at - a.at || b.order - a.order)
      .map(({ order: _order, ...rest }) => rest)
    return { id, pinId: id, kind: 'kanban', title: board.slug, total: all.length, items: all.slice(0, limit), more: Math.max(all.length - limit, 0), block: kanbanBlockInfo(board) }
  }
  const space = supermemory?.find(s => s.id === id)
  if (space) {
    const all: FleetInteraction[] = [...(space.recent ?? [])]
      .sort((a, b) => b.at - a.at || a.profile.localeCompare(b.profile) || a.action.localeCompare(b.action))
      .map(e => ({ at: e.at, profile: e.profile, action: e.action }))
    return {
      id, pinId: memoryBlockId(space.containerTag), kind: 'supermemory', title: space.containerTag, summary: memoryCountsLine(memoryBlockInfo(space)),
      total: all.length, items: all.slice(0, limit), more: Math.max(all.length - limit, 0),
    }
  }
  const head = bash?.find(b => b.id === id)
  if (head) {
    const all: FleetInteraction[] = [...head.recent]
      .sort((a, b) => b.at - a.at || a.profile.localeCompare(b.profile))
      .map(r => ({ at: r.at, profile: r.profile, action: 'run', detail: r.command }))
    const profiles = Object.keys(head.byProfile).length
    return {
      id, pinId: head.id, kind: 'bash', title: head.head,
      summary: `${bashCountsLine(head.total)} · ${profiles} ${profiles === 1 ? 'profile' : 'profiles'}`,
      total: head.total, items: all.slice(0, limit), more: Math.max(head.total - Math.min(all.length, limit), 0),
    }
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

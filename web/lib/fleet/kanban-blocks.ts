/**
 * Kanban resource blocks of the Fleet map: ONE block per Kanban board.
 *
 * A board's block appears when the board has a task event (the events kanban-source.ts reads), stays fully
 * visible for the `kanban` linger of the options, then fades out over the fade seconds. A pinned block stays.
 * The block model, linger and fade rules are the generic ones from resource-block.ts; this module only turns
 * the board nodes of /api/fleet into blocks.
 *
 * CONTENT RULE (binding decision 5): a Kanban block carries the board slug, the task count per status and the
 * event kinds, nothing else. No task body, comment, result or event payload, and no task title or id: the
 * block types below have no field for them, and the tests check the serialised blocks.
 */
// Type-only: kanban-source.ts uses node:sqlite and must never be bundled into the browser.
import type { PublicKanbanBoardNode } from './kanban-source'
import { blockId, isBlockShown, recordUse, resolveLife, type BlockStore, type PinSet, type ResourceBlock } from './resource-block'
import type { AgentFlowOptions } from './options-registry'
import type { BlockLifeView } from './block-alpha'

/** Display order of the statuses Hermes uses (same list as kanban-source.KNOWN_TASK_STATUSES; unknown ones sort after). */
const STATUS_ORDER: readonly string[] = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'scheduled', 'done', 'archived']

/** The block of a board: the board node id is `kanban:<slug>`, which is also the block id (`kind:key`). */
export function kanbanBlockId(slug: string): string {
  return blockId('kanban', slug)
}

/**
 * One block per board that has events, as a fresh store. Pure and idempotent: the same polled boards always give
 * the same blocks, so it can be called on every poll. `lastUsedAt` is the newest event time, `useCount` the
 * number of events the poll holds, `agents` the distinct assignees. Boards without events have no block (the
 * board is not in use, so it is not on the map). Boards that failed to read have no events either.
 */
export function buildKanbanBlocks(boards: readonly PublicKanbanBoardNode[] | undefined): BlockStore {
  let store: BlockStore = new Map<string, ResourceBlock>()
  for (const board of boards ?? []) {
    // Oldest first, so the first-seen order of `agents` follows the history.
    const events = [...board.recentEvents].sort((a, b) => a.at - b.at || a.id - b.id)
    for (const e of events) {
      store = recordUse(store, { kind: 'kanban', key: board.slug, label: board.slug, at: e.at, agentId: e.assignee ?? undefined })
    }
  }
  return store
}

/** What a Kanban block may show: slug, status counts, event kinds. Nothing about single tasks. */
export interface KanbanBlockInfo {
  slug: string
  /** [status, count] with count > 0: the known statuses in their order, then unknown ones by name. */
  counts: Array<[string, number]>
  /** Distinct event kinds with how often each occurs among the board's recent events, most frequent first. */
  kinds: Array<[string, number]>
}

export function kanbanBlockInfo(board: PublicKanbanBoardNode): KanbanBlockInfo {
  const order = (s: string) => {
    const i = STATUS_ORDER.indexOf(s)
    return i === -1 ? STATUS_ORDER.length : i
  }
  const counts = Object.entries(board.taskCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
  const byKind = new Map<string, number>()
  for (const e of board.recentEvents) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  const kinds = [...byKind].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { slug: board.slug, counts, kinds }
}

/** Second line of the block: "1 running · 7 done". Empty board: "no tasks". */
export function kanbanCountsLine(info: KanbanBlockInfo): string {
  if (info.counts.length === 0) return 'no tasks'
  return info.counts.map(([s, n]) => `${n} ${s}`).join(' · ')
}

/**
 * Whether the board's block is drawn now in the fleet view: the board has a block, the `kanban` kind is switched
 * on for the fleet view, and the block is within linger + fade (or pinned).
 */
export function isKanbanBoardShown(
  board: PublicKanbanBoardNode, blocks: BlockStore, now: number, options: AgentFlowOptions, pins: PinSet,
): boolean {
  const block = blocks.get(kanbanBlockId(board.slug))
  return block !== undefined && isBlockShown(block, now, 'fleet', options, pins)
}

/** The block's own life for the draw loop (linger and fade of the kanban kind, the pin). */
export function kanbanLifeView(block: ResourceBlock, options: AgentFlowOptions, pins: PinSet): BlockLifeView {
  const life = resolveLife('kanban', options)
  return { lastUsedAt: block.lastUsedAt, lingerMs: life.lingerMs, fadeMs: life.fadeMs, pinned: pins.has(kanbanBlockId(block.key)) }
}

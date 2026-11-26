/**
 * Single-view resource blocks: the blocks attached to ONE session's canvas, showing that session's use only.
 *
 * Sources are the buffered events of the one open session (the trackers are given [session] and nothing else, so another
 * session's calls can never reach them): bash heads (BashUseTracker), and memory containers, Kanban boards named in a
 * tool call and Hermes subsystems (EventUseTracker). Linger, fade, pin and the single-view show/hide toggle are the
 * generic ones (resource-block.ts, options-registry.ts): the same rule as the Fleet map, with `show.single`.
 *
 * Content rules are those of the sources: bash head and masked command, memory container tag only (`personal-*` is never
 * shown here, see event-uses.ts), board slug and tool verb, subsystem name and verb. No fleet badge here: a single session
 * is one agent.
 */
import { BashUseTracker, bashBlockId, bashCountsLine, buildBashBlocks, type BashHeadNode, type BashEventLike } from './bash-blocks'
import {
  EventUseTracker, buildUseBlocks, buildUseNodes, useCountsLine,
  type EventUse, type UseEventLike, type UseNode,
} from './event-uses'
import { inspectResource, inspectUseNode, type FleetInspection } from './fleet-inspect'
import type { AgentFlowOptions, ResourceKind } from './options-registry'
import { EMPTY_PINS, visibleBlocks, type BlockStore, type PinSet, type ResourceBlock } from './resource-block'

export interface SingleSessionLike {
  id: string
  label: string
}

/** What the trackers hold for the open session. */
export interface SingleSources {
  bash: readonly BashHeadNode[]
  uses: readonly EventUse[]
}

/** The two trackers of the single view, fed from ONE session's event buffer. */
export class SingleSessionTracker {
  private readonly bash = new BashUseTracker()
  private readonly uses = new EventUseTracker()

  /** The session's blocks' sources, or nothing for no session. Incremental: only new events are read. */
  update(
    session: SingleSessionLike | null,
    eventsOf: (sessionId: string) => ReadonlyArray<BashEventLike & UseEventLike>,
    nowMs: number,
  ): SingleSources {
    const sessions = session ? [session] : []
    return { bash: this.bash.update(sessions, eventsOf, nowMs), uses: this.uses.update(sessions, eventsOf, nowMs) }
  }
}

export interface SingleBlockView {
  /** Block and pin id: `kind:key`. */
  id: string
  kind: ResourceKind
  label: string
  /** Second line: the counts ("3 calls", "2 search · 1 store"). No content. */
  sublabel: string
  /** 0..1 (a pinned block is 1). Always > 0 here. */
  alpha: number
  pinned: boolean
  inspection: FleetInspection
}

export interface SingleBlocksInput {
  sources: SingleSources
  now: number
  options: AgentFlowOptions
  pins?: PinSet
}

/** The blocks to draw now in the single view, oldest use first (a stable order; a new block joins the end). */
export function buildSingleBlocks(input: SingleBlocksInput): SingleBlockView[] {
  const { sources, now, options } = input
  const pins = input.pins ?? EMPTY_PINS
  const nodes = new Map<string, UseNode>()
  const store = new Map<string, ResourceBlock>()
  const merge = (s: BlockStore) => { for (const [id, b] of s) store.set(id, b) }
  merge(buildBashBlocks(sources.bash))
  for (const kind of ['memory', 'subsystem', 'kanban'] as const) {
    const list = buildUseNodes(sources.uses, kind)
    for (const n of list) nodes.set(n.id, n)
    merge(buildUseBlocks(list))
  }
  const bashById = new Map(sources.bash.map(b => [bashBlockId(b.head), b]))
  const out: SingleBlockView[] = []
  for (const v of visibleBlocks(store, now, 'single', options, pins)) {
    const node = nodes.get(v.id)
    const head = bashById.get(v.id)
    const inspection = node ? inspectUseNode(node) : head ? inspectResource(head.id, undefined, undefined, undefined, [head]) : null
    if (!inspection) continue
    out.push({
      id: v.id, kind: v.block.kind, label: v.block.label,
      sublabel: node ? useCountsLine(node) : bashCountsLine(v.block.useCount),
      alpha: v.alpha, pinned: v.pinned, inspection,
    })
  }
  return out
}

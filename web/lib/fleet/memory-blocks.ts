/**
 * Memory resource blocks of the Fleet map: one block per Supermemory container tag (`matrix_org`, `omh_family`,
 * `webbugt_video_memory`), lit while an agent calls supermemory_search / store / forget on it, then fading (the
 * `memory` linger of the options, default 60 s; a pin keeps it).
 *
 * CONTENT RULES (binding decision 4):
 *   - A memory block carries the container tag and the number of store / search / forget calls. Never memory
 *     content, a query, an id or a result: the namespace nodes of supermemory-source.ts hold none of them, and the
 *     block types below have no field for them.
 *   - `personal-*` containers are visible only to their owner. There is no login in Agent Flow, so the owner is
 *     named by the server setting AGENT_FLOW_MEMORY_OWNER (see `filterPersonalNamespaces`), and the filter runs on
 *     the server, in /api/fleet, before the data leaves the machine. The browser never receives a hidden tag, so
 *     neither the map, the inspector nor the timeline can show it. The builders below trust the payload they get.
 *
 * Source: the namespace nodes of /api/fleet (state.db tool calls, polled every 10 s by the page). The block's
 * `lastUsedAt` is the node's newest event; the agents are the profiles that have events on it.
 */
import { blockId, type BlockStore, type ResourceBlock } from './resource-block'
import type { SupermemoryNamespaceNode } from './supermemory-source'

/** The block id of a container tag. (The map node of the namespace is `supermemory:<tag>`; the block and pin id is `memory:<tag>`.) */
export function memoryBlockId(containerTag: string): string {
  return blockId('memory', containerTag)
}

/** One block per namespace that has an event. Pure and idempotent. A namespace without events has no block. */
export function buildMemoryBlocks(spaces: readonly SupermemoryNamespaceNode[] | undefined): BlockStore {
  const store = new Map<string, ResourceBlock>()
  for (const space of spaces ?? []) {
    if (space.lastEventAt === null || !Number.isFinite(space.lastEventAt)) continue
    store.set(memoryBlockId(space.containerTag), {
      kind: 'memory', key: space.containerTag, label: space.containerTag,
      lastUsedAt: space.lastEventAt,
      useCount: space.total,
      agents: Object.keys(space.byProfile),
    })
  }
  return store
}

/** What a memory block may show: the tag and the call counts. */
export interface MemoryBlockInfo {
  containerTag: string
  store: number
  search: number
  forget: number
}

export function memoryBlockInfo(space: SupermemoryNamespaceNode): MemoryBlockInfo {
  return { containerTag: space.containerTag, store: space.counts.store, search: space.counts.search, forget: space.counts.forget }
}

/** "3 store · 5 search · 1 forget" (zero counts left out; "no calls" when there are none). */
export function memoryCountsLine(info: MemoryBlockInfo): string {
  const parts = ([['store', info.store], ['search', info.search], ['forget', info.forget]] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
  return parts.length > 0 ? parts.join(' · ') : 'no calls'
}

// ─── personal-* containers ──────────────────────────────────────────────────

/** The server setting that names the owner of the `personal-*` containers. Unset = nobody sees them. */
export const MEMORY_OWNER_ENV = 'AGENT_FLOW_MEMORY_OWNER'

/** Container tags are compared lowercase with `-` as `_` (the same normalisation as supermemory-source.ts). */
function normaliseTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/-/g, '_')
}

/** `personal-anything`, `personal_anything`, `PERSONAL-x`. */
export function isPersonalTag(containerTag: string): boolean {
  // Fail closed: something that is not a string cannot be shown as a public tag.
  if (typeof containerTag !== 'string') return true
  return /^personal_/.test(normaliseTag(containerTag))
}

/**
 * Whether a viewer may see the container. Every tag that is not `personal-*` is visible. A `personal-<name>` tag is
 * visible only when `owner` is `<name>` (compared like tags: case and `-` / `_` do not matter). Without an owner
 * (the default) no `personal-*` tag is visible, to anyone.
 *
 * `owner` is a setting of the server, not an identity the browser proves: anyone who can reach /api/fleet gets what
 * the server's owner may see. /api/fleet is loopback-only unless AGENT_FLOW_FLEET_ALLOW_REMOTE=1 (fleet-api.ts).
 */
export function isMemoryTagVisible(containerTag: string, owner?: string | null): boolean {
  if (typeof containerTag !== 'string') return false
  if (!isPersonalTag(containerTag)) return true
  if (typeof owner !== 'string' || owner.trim() === '') return false
  return normaliseTag(containerTag) === `personal_${normaliseTag(owner)}`
}

/** The namespace nodes a viewer may see; the others are dropped whole (tag, counts, profiles, events). Returns new array. */
export function filterPersonalNamespaces<T extends { containerTag: string }>(nodes: readonly T[], owner?: string | null): T[] {
  return nodes.filter(n => isMemoryTagVisible(n.containerTag, owner))
}

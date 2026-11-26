/**
 * Resource block model: a Kanban board, a memory container, a bash command head or a Hermes subsystem that
 * an agent touched. A block is relevant while it was used recently: fully visible for the linger window of
 * its kind, then a linear fade (same rule as the edges, see fleet-edge-life.lifeAlpha). A pinned block stays.
 *
 * Pure functions on epoch milliseconds and immutable maps, so the draw loop and the tests share one rule.
 * This module holds NO content: a block is only { kind, key, label, lastUsedAt, useCount, agents }.
 * What may go into `key` and `label` (container tag only, command head only, board slug only) is the
 * caller's rule (the source of the event), and is not widened here.
 */
import { lifeAlpha } from './fleet-edge-life'
import type { BlockLifeView } from './block-alpha'
import {
  RESOURCE_KINDS, isResourceKind,
  type AgentFlowOptions, type BlockView, type ResourceKind,
} from './options-registry'

export { RESOURCE_KINDS }
export type { ResourceKind }

export interface ResourceBlock {
  kind: ResourceKind
  /** Board slug / container tag / command head / subsystem name. Trimmed, never empty. */
  key: string
  /** Text drawn on the block. Defaults to `key`. */
  label: string
  /** Epoch ms of the latest use. Never moves backwards. */
  lastUsedAt: number
  useCount: number
  /** Distinct agent ids that touched the block, in first-seen order (capped at MAX_BLOCK_AGENTS). */
  agents: string[]
}

export type BlockStore = ReadonlyMap<string, ResourceBlock>
export type PinSet = ReadonlySet<string>

export const EMPTY_PINS: PinSet = new Set<string>()
export const MAX_BLOCK_KEY_LENGTH = 200
export const MAX_BLOCK_LABEL_LENGTH = 200
export const MAX_BLOCK_AGENTS = 200

/** Stable id of a block: `kind:key`. */
export function blockId(kind: ResourceKind, key: string): string {
  return `${kind}:${key}`
}

export interface BlockUse {
  kind: ResourceKind
  key: string
  label?: string
  /** Epoch ms of the use (the event timestamp). */
  at: number
  agentId?: string
}

/**
 * Record one use. Returns a NEW store (the input is not mutated), or the same store when the use is
 * unusable (unknown kind, empty key, non-finite time): a bad event cannot create or change a block.
 */
export function recordUse(store: BlockStore, use: BlockUse): BlockStore {
  if (!isResourceKind(use.kind)) return store
  if (typeof use.key !== 'string' || !Number.isFinite(use.at)) return store
  const key = use.key.trim().slice(0, MAX_BLOCK_KEY_LENGTH)
  if (key === '') return store
  const id = blockId(use.kind, key)
  const prev = store.get(id)
  const label = typeof use.label === 'string' && use.label.trim() !== '' ? use.label.trim().slice(0, MAX_BLOCK_LABEL_LENGTH) : (prev?.label ?? key)
  const agentId = typeof use.agentId === 'string' && use.agentId !== '' ? use.agentId : null
  const agents = prev ? [...prev.agents] : []
  if (agentId !== null && !agents.includes(agentId) && agents.length < MAX_BLOCK_AGENTS) agents.push(agentId)
  const next: ResourceBlock = {
    kind: use.kind,
    key,
    label,
    lastUsedAt: prev ? Math.max(prev.lastUsedAt, use.at) : use.at,
    useCount: (prev?.useCount ?? 0) + 1,
    agents,
  }
  const out = new Map(store)
  out.set(id, next)
  return out
}

/** Linger and fade of one kind, in ms, from the options (which hold seconds). */
export interface BlockLife {
  lingerMs: number
  fadeMs: number
}

export function resolveLife(kind: ResourceKind, options: AgentFlowOptions): BlockLife {
  return { lingerMs: options.lingerSeconds[kind] * 1000, fadeMs: options.fadeSeconds * 1000 }
}

/** Total time a block of this kind can still be drawn after its last use (linger + fade), ms. 0 when linger is 0. */
export function visibleMs(life: BlockLife): number {
  return life.lingerMs > 0 ? life.lingerMs + Math.max(life.fadeMs, 0) : 0
}

/**
 * Opacity 0..1 of a block. Pinned -> 1 (a pin beats linger 0). Otherwise the shared linger/fade rule of
 * its kind. This does NOT look at the show/hide toggle; see `isBlockShown`.
 */
export function blockAlpha(block: ResourceBlock, now: number, options: AgentFlowOptions, pinned = false): number {
  if (pinned) return 1
  const life = resolveLife(block.kind, options)
  return lifeAlpha(block.lastUsedAt, now, life.lingerMs, life.fadeMs)
}

/** The block's own life for the draw loop (linger and fade of its kind, the pin): the draw loop fades it on the wall clock. */
export function lifeViewOf(block: ResourceBlock, options: AgentFlowOptions, pins: PinSet = EMPTY_PINS): BlockLifeView {
  const life = resolveLife(block.kind, options)
  return { lastUsedAt: block.lastUsedAt, lingerMs: life.lingerMs, fadeMs: life.fadeMs, pinned: pins.has(blockId(block.kind, block.key)) }
}

/** Whether blocks of this kind are switched on for the view. A switched-off kind hides even pinned blocks. */
export function isKindShown(kind: ResourceKind, view: BlockView, options: AgentFlowOptions): boolean {
  return options.show[view][kind] === true
}

export function isBlockShown(
  block: ResourceBlock, now: number, view: BlockView, options: AgentFlowOptions, pins: PinSet = EMPTY_PINS,
): boolean {
  return isKindShown(block.kind, view, options)
    && blockAlpha(block, now, options, pins.has(blockId(block.kind, block.key))) > 0
}

export interface VisibleBlock {
  block: ResourceBlock
  id: string
  alpha: number
  pinned: boolean
}

/** The blocks to draw now, with their opacity, oldest use first (a stable draw order). */
export function visibleBlocks(
  store: BlockStore, now: number, view: BlockView, options: AgentFlowOptions, pins: PinSet = EMPTY_PINS,
): VisibleBlock[] {
  const out: VisibleBlock[] = []
  for (const [id, block] of store) {
    if (!isKindShown(block.kind, view, options)) continue
    const pinned = pins.has(id)
    const alpha = blockAlpha(block, now, options, pinned)
    if (alpha > 0) out.push({ block, id, alpha, pinned })
  }
  return out.sort((a, b) => a.block.lastUsedAt - b.block.lastUsedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Drop blocks that are over for good (past linger + fade, not pinned), so the store stays bounded.
 * A block of a switched-off kind is kept (it still ages): switching the kind back on shows what is still
 * relevant. Uses the CURRENT options, so call it with the options in force. Returns the same store when
 * nothing was dropped.
 */
export function pruneBlocks(store: BlockStore, now: number, options: AgentFlowOptions, pins: PinSet = EMPTY_PINS): BlockStore {
  let out: Map<string, ResourceBlock> | null = null
  for (const [id, block] of store) {
    if (pins.has(id)) continue
    if (blockAlpha(block, now, options, false) > 0) continue
    if (!out) out = new Map(store)
    out.delete(id)
  }
  return out ?? store
}

/** Toggle a pin. Returns a new set. */
export function togglePin(pins: PinSet, id: string): Set<string> {
  const next = new Set(pins)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function setPinned(pins: PinSet, id: string, pinned: boolean): PinSet {
  if (pins.has(id) === pinned) return pins
  const next = new Set(pins)
  if (pinned) next.add(id)
  else next.delete(id)
  return next
}

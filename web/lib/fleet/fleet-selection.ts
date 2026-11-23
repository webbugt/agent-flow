/**
 * Persisted fleet selection. We store the DESELECTED ids, so anything new
 * (a freshly started instance, a new board) is visible by default.
 *
 * Deselecting only hides: nothing here talks to a process, relay or session.
 * Pure functions plus a storage wrapper that takes an injected Storage, so it
 * is testable without a DOM.
 */

export const FLEET_SELECTION_KEY = 'agent-flow:fleet-selection:v1'
export const MAX_STORED_IDS = 2000

export type OffSet = ReadonlySet<string>

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function isSelected(off: OffSet, id: string): boolean {
  return !off.has(id)
}

/** Select (on=true) or deselect the given ids. Returns the same set if nothing changed. */
export function setMany(off: OffSet, ids: readonly string[], on: boolean): OffSet {
  const next = new Set(off)
  for (const id of ids) {
    if (on) next.delete(id)
    else next.add(id)
  }
  return next.size === off.size && [...next].every(id => off.has(id)) ? off : next
}

/** Group/section checkbox: if every id is selected, deselect all; otherwise select all. */
export function toggleMany(off: OffSet, ids: readonly string[]): OffSet {
  if (ids.length === 0) return off
  const allOn = ids.every(id => !off.has(id))
  return setMany(off, ids, !allOn)
}

export function selectAll(off: OffSet): OffSet {
  return off.size === 0 ? off : new Set()
}

/** None = deselect every id currently known. Ids not known yet stay selected (new items appear). */
export function selectNone(off: OffSet, allIds: readonly string[]): OffSet {
  return setMany(off, allIds, false)
}

export function serializeSelection(off: OffSet): string {
  return JSON.stringify({ v: 1, off: [...off].slice(0, MAX_STORED_IDS) })
}

/** Tolerant parse: anything malformed yields an empty set (everything selected). */
export function parseSelection(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  try {
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object') return new Set()
    const off = (data as { off?: unknown }).off
    if (!Array.isArray(off)) return new Set()
    return new Set(off.filter((v): v is string => typeof v === 'string').slice(0, MAX_STORED_IDS))
  } catch {
    return new Set()
  }
}

export function loadSelection(storage: StorageLike | null | undefined, key = FLEET_SELECTION_KEY): Set<string> {
  if (!storage) return new Set()
  try {
    return parseSelection(storage.getItem(key))
  } catch {
    return new Set()
  }
}

/** Returns false when the write failed (quota, private mode); selection still works in memory. */
export function saveSelection(storage: StorageLike | null | undefined, off: OffSet, key = FLEET_SELECTION_KEY): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, serializeSelection(off))
    return true
  } catch {
    return false
  }
}

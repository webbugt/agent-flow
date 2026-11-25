/**
 * Client runtime of the costs config: turns each `costs-config` message from the host (VS Code extension or
 * relay) into the config the overlay prices with, and keeps the last resolution for the error banner.
 *
 * message -> resolveCostsLayers (validate + merge + last good) -> setActiveCosts (overlay) + resolution store (banner)
 *
 * Messages are applied in arrival order. There is no sequence guard on purpose: a restarted relay starts its
 * `seq` over, and every message carries the whole state, so the newest message wins.
 */
import { emptyResolution, resolveCostsLayers } from './costs/layers'
import type { CostsConfigPayload, CostsResolution } from './costs/layers'
import { setActiveCosts } from './costs/active'

let resolution: CostsResolution = emptyResolution()
let dismissedKey = ''
let configKey = ''
let snapshotCache: CostsStatus | null = null
const listeners = new Set<() => void>()

export interface CostsStatus {
  resolution: CostsResolution
  /** The banner was dismissed for the current set of errors. */
  dismissed: boolean
}

function errorKey(r: CostsResolution): string {
  return r.errors.map(e => `${e.layer}|${e.file}|${e.path}|${e.message}`).join('\n')
}

function notify(): void {
  snapshotCache = null
  for (const l of [...listeners]) l()
}

/** Apply one `costs-config` payload. Never throws: a bad payload leaves the previous config in place. */
export function applyCostsPayload(payload: CostsConfigPayload): void {
  try {
    let next = resolveCostsLayers(payload, resolution)
    // Same content as before (a no-op reload, or last good re-merged): keep the previous object, so nothing downstream churns.
    const key = next.config ? JSON.stringify(next.config) : ''
    if (next.config && resolution.config && key === configKey) next = { ...next, config: resolution.config }
    configKey = key
    resolution = next
    // A new set of errors un-dismisses the banner; the same errors stay dismissed.
    if (next.errors.length === 0) dismissedKey = ''
    setActiveCosts(next.config)
  } catch {
    // resolveCostsLayers does not throw by design; if it ever does, keep what we had.
    return
  }
  notify()
}

export function getCostsStatus(): CostsStatus {
  if (!snapshotCache) snapshotCache = { resolution, dismissed: resolution.errors.length > 0 && errorKey(resolution) === dismissedKey }
  return snapshotCache
}

export function dismissCostsErrors(): void {
  dismissedKey = errorKey(resolution)
  notify()
}

export function subscribeCostsStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Test helper: back to the initial state. */
export function resetCostsRuntime(): void {
  resolution = emptyResolution()
  dismissedKey = ''
  configKey = ''
  setActiveCosts(null)
  notify()
}

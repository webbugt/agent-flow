/**
 * Live store of the Agent Flow options (lib/fleet/options-registry.ts), the client side of the options panel.
 *
 * - One store holds the current options in memory; every change is validated (strict patch), saved under the
 *   single registry key, and announced to subscribers, so a change in the panel shows up at once without a reload.
 * - The first read on the client loads the options and runs the one-time migration of the old keys
 *   (options-migration.ts). Until then, and on the server, the defaults are used (so server and client render
 *   the same first frame; React switches to the stored values right after hydration).
 * - Other tabs: a `storage` event for the registry key reloads the options.
 *
 * `createOptionsStore` takes the storage as a function so it is testable without a DOM; `optionsStore` is the
 * app's singleton on window.localStorage. Plain functions at the bottom are the usual way to use it.
 */
import { migrateLegacySettings } from './fleet/options-migration'
import {
  OPTIONS_KEY, applyOptionsPatch, defaultOptions, loadOptions, saveOptions,
  type AgentFlowOptions, type OptionsPatch, type StorageLike,
} from './fleet/options-registry'

export type UpdateResult = { ok: true; options: AgentFlowOptions; saved: boolean } | { ok: false; errors: string[] }

export interface OptionsStore {
  /** Current options. Same object until something changes (safe as a useSyncExternalStore snapshot). */
  get(): AgentFlowOptions
  /** Defaults, for the server render. Same object every time. */
  getServer(): AgentFlowOptions
  /** Apply a strict patch. Nothing changes when any value is bad. */
  update(patch: OptionsPatch): UpdateResult
  /** Back to the defaults (the migration marker stays, so the old keys are not copied in again). */
  reset(): void
  subscribe(fn: () => void): () => void
  /** Counts every change; for consumers that need a number to compare. */
  version(): number
  /** Reload from storage (a change made by another tab). */
  reload(): void
}

export function createOptionsStore(getStorage: () => StorageLike | null): OptionsStore {
  const serverSnapshot = defaultOptions()
  let current: AgentFlowOptions = serverSnapshot
  let loaded = false
  let version = 0
  const listeners = new Set<() => void>()

  function emit(): void {
    version++
    for (const l of [...listeners]) l()
  }

  function ensureLoaded(): void {
    if (loaded) return
    const storage = getStorage()
    if (!storage) return // server, or storage not reachable yet: defaults, try again on the next read
    loaded = true
    try {
      current = migrateLegacySettings(storage).options
    } catch {
      current = loadOptions(storage)
    }
  }

  return {
    get() {
      ensureLoaded()
      return current
    },
    getServer: () => serverSnapshot,
    update(patch) {
      ensureLoaded()
      const r = applyOptionsPatch(current, patch)
      if (!r.ok) return r
      current = r.options
      const saved = saveOptions(getStorage(), current)
      emit()
      return { ok: true, options: current, saved }
    },
    reset() {
      ensureLoaded()
      current = { ...defaultOptions(), legacyMigrated: true }
      saveOptions(getStorage(), current)
      emit()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    version: () => version,
    reload() {
      const storage = getStorage()
      if (!storage) return
      loaded = true
      current = loadOptions(storage)
      emit()
    },
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // access denied (some embedded webviews)
  }
}

export const optionsStore = createOptionsStore(browserStorage)

let listeningToStorageEvents = false
function listenForOtherTabs(): void {
  if (listeningToStorageEvents || typeof window === 'undefined') return
  listeningToStorageEvents = true
  window.addEventListener('storage', e => {
    if (e.key === OPTIONS_KEY || e.key === null) optionsStore.reload()
  })
}

export function getOptions(): AgentFlowOptions { return optionsStore.get() }
export function updateOptions(patch: OptionsPatch): UpdateResult { return optionsStore.update(patch) }
export function resetOptions(): void { optionsStore.reset() }
export function optionsVersion(): number { return optionsStore.version() }
export function subscribeOptions(fn: () => void): () => void {
  listenForOtherTabs()
  return optionsStore.subscribe(fn)
}
export function getServerOptions(): AgentFlowOptions { return optionsStore.getServer() }

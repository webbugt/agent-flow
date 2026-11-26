import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FleetInstance, FleetSelectionView } from '@/lib/fleet/fleet-model'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'
import {
  DEFAULT_ACTIVITY_WINDOW, FLEET_ACTIVITY_FILTER_KEY, hiddenByActivity, loadActivityWindow, sameIds, saveActivityWindow,
  summarizeHidden, windowMs, type ActivityWindowId,
} from '@/lib/fleet/fleet-activity-filter'

/** How often the window is re-evaluated against the clock while the fleet is open, ms. */
const REEVALUATE_MS = 10_000

export interface UseFleetActivityFilterOptions {
  /** Only tick while the fleet view is open. */
  enabled: boolean
  instances: readonly FleetInstance[]
  kanban?: readonly PublicKanbanBoardNode[]
  supermemory?: readonly SupermemoryNamespaceNode[]
  /** The user's own selection: the "N hidden" hint counts only what the filter alone hides. */
  selection?: FleetSelectionView
  storageKey?: string
}

/**
 * Fleet "latest activity" filter state: the chosen window (kept in localStorage; read after mount so
 * server and client render the same first frame) and the ids it hides. Hiding is visual only.
 * The hidden set keeps its identity while its content is unchanged, so a clock tick that hides
 * nothing new does not rebuild the map.
 */
export function useFleetActivityFilter(opts: UseFleetActivityFilterOptions) {
  const { enabled, instances, kanban, supermemory, selection, storageKey = FLEET_ACTIVITY_FILTER_KEY } = opts
  const [window_, setWindowState] = useState<ActivityWindowId>(DEFAULT_ACTIVITY_WINDOW)
  const [hydrated, setHydrated] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setWindowState(loadActivityWindow(window.localStorage, storageKey))
    setHydrated(true)
  }, [storageKey])

  // Keep several open tabs/panels in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setWindowState(loadActivityWindow(window.localStorage, storageKey))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [storageKey])

  const setWindow = useCallback((id: ActivityWindowId) => {
    setWindowState(id)
    saveActivityWindow(window.localStorage, id, storageKey)
  }, [storageKey])

  // Re-evaluate against the clock: an instance leaves the window by time passing, with no new event.
  useEffect(() => {
    if (!enabled || windowMs(window_) === null) return
    const timer = setInterval(() => setTick(n => n + 1), REEVALUATE_MS)
    return () => clearInterval(timer)
  }, [enabled, window_])

  const computed = useMemo(
    () => hiddenByActivity({ window: window_, now: Date.now(), instances, kanban, supermemory }),
    // tick: the clock moves without any prop changing
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [window_, instances, kanban, supermemory, tick],
  )
  const stableRef = useRef<ReadonlySet<string>>(computed)
  if (!sameIds(stableRef.current, computed)) stableRef.current = computed
  const hidden = stableRef.current

  const summary = useMemo(
    () => summarizeHidden(instances, kanban, supermemory, hidden, selection),
    [instances, kanban, supermemory, hidden, selection],
  )

  return { window: window_, setWindow, hidden, summary, hydrated }
}

import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  FLEET_SELECTION_KEY, isSelected, loadSelection, saveSelection, selectAll, selectNone, setMany, toggleMany,
} from '@/lib/fleet/fleet-selection'

/**
 * Fleet selection (which agents/lanes are visible), persisted in localStorage.
 *
 * Deselecting only hides. Nothing here stops a process or closes a session.
 * State is the set of DESELECTED ids, so new instances show up by default.
 * Storage is read after mount (not in the initial state) so server and client
 * render the same first frame.
 */
export function useFleetSelection(storageKey: string = FLEET_SELECTION_KEY) {
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set())
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setOff(loadSelection(window.localStorage, storageKey))
    setHydrated(true)
  }, [storageKey])

  // Persist after the initial load only, so an empty first render can't wipe the saved selection.
  useEffect(() => {
    if (hydrated) saveSelection(window.localStorage, off, storageKey)
  }, [off, hydrated, storageKey])

  // Keep several open tabs/panels in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setOff(loadSelection(window.localStorage, storageKey))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [storageKey])

  const view = useMemo(() => ({ isSelected: (id: string) => isSelected(off, id) }), [off])

  /** Group/section checkbox: all on -> all off, otherwise all on. */
  const toggleIds = useCallback((ids: readonly string[]) => setOff(prev => toggleMany(prev, ids)), [])
  const setIds = useCallback((ids: readonly string[], on: boolean) => setOff(prev => setMany(prev, ids, on)), [])
  const selectAllIds = useCallback(() => setOff(prev => selectAll(prev)), [])
  const selectNoneIds = useCallback((allIds: readonly string[]) => setOff(prev => selectNone(prev, allIds)), [])

  return { off, view, hydrated, toggleIds, setIds, selectAll: selectAllIds, selectNone: selectNoneIds }
}

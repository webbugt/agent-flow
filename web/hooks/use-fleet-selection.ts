import { useCallback, useMemo } from 'react'
import {
  MAX_STORED_IDS, isSelected, selectAll, selectNone, setMany, toggleMany, type OffSet,
} from '@/lib/fleet/fleet-selection'
import { getOptions, updateOptions } from '@/lib/options-store'
import { useOptions } from '@/hooks/use-options'

/**
 * Fleet selection (which agents/lanes are visible), kept in the options registry (`fleetDeselected`), so the
 * options panel and the fleet timeline checkboxes edit the same value and stay in sync, also across tabs.
 *
 * Deselecting only hides. Nothing here stops a process or closes a session.
 * State is the set of DESELECTED ids, so new instances show up by default.
 * The options load after mount (not in the first render) so server and client render the same first frame.
 */
export function useFleetSelection() {
  const options = useOptions()
  const deselected = options.fleetDeselected
  // `deselected` keeps its identity until the list really changes (applyOptionsPatch), so this Set does too.
  const off = useMemo<OffSet>(() => new Set(deselected), [deselected])
  // The options store reads storage on its first client read; there is nothing left to wait for.
  const hydrated = true

  /** Apply `f` to the CURRENT stored set (not a stale render's), and write only if it changed. */
  const change = useCallback((f: (prev: OffSet) => OffSet) => {
    const prev: OffSet = new Set(getOptions().fleetDeselected)
    const next = f(prev)
    if (next !== prev) updateOptions({ fleetDeselected: [...next].slice(0, MAX_STORED_IDS) })
  }, [])

  const view = useMemo(() => ({ isSelected: (id: string) => isSelected(off, id) }), [off])

  /** Group/section checkbox: all on -> all off, otherwise all on. */
  const toggleIds = useCallback((ids: readonly string[]) => change(prev => toggleMany(prev, ids)), [change])
  const setIds = useCallback((ids: readonly string[], on: boolean) => change(prev => setMany(prev, ids, on)), [change])
  const selectAllIds = useCallback(() => change(prev => selectAll(prev)), [change])
  const selectNoneIds = useCallback((allIds: readonly string[]) => change(prev => selectNone(prev, allIds)), [change])

  return { off, view, hydrated, toggleIds, setIds, selectAll: selectAllIds, selectNone: selectNoneIds }
}

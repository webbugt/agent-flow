'use client'

import { useEffect } from 'react'
import { VIEW_URL_SPECS, type ViewState } from '@/lib/fleet/url-view'
import { replaceUrlState } from '@/lib/fleet/url-sync'

/**
 * Keeps `?fleet=`, `?screensaver=` and `?anchorMode=` in the address bar equal to the current view, using
 * replaceState (no new history entries, other query parameters kept; the generic rule is lib/fleet/url-sync.ts).
 * Each option saves itself to localStorage when it changes (app-state, screensaver-pref, the options store), so one
 * change reaches both the URL and storage. Runs only when `ready` is true, i.e. after the restore after mount
 * has applied the URL and the stored choices, so the first render never overwrites what the URL asked for.
 */
export function useViewUrlSync(view: ViewState, ready: boolean): void {
  const { fleet, screensaver, anchorMode } = view
  useEffect(() => {
    if (!ready) return
    // replaceUrlState keeps the state Next.js attaches to history entries; it changes only the address.
    replaceUrlState(window, { fleet, screensaver, anchorMode }, VIEW_URL_SPECS)
  }, [ready, fleet, screensaver, anchorMode])
}

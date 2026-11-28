'use client'

import { useEffect } from 'react'
import { buildViewSearch, type ViewState } from '@/lib/fleet/url-view'

/**
 * Keeps `?fleet=` and `?screensaver=` in the address bar equal to the current view, using replaceState (no new
 * history entries, other query parameters kept). Runs only when `ready` is true, i.e. after the restore after mount
 * has applied the URL and the stored choices, so the first render never overwrites what the URL asked for.
 */
export function useViewUrlSync(view: ViewState, ready: boolean): void {
  const { fleet, screensaver } = view
  useEffect(() => {
    if (!ready) return
    const current = window.location.search
    const next = buildViewSearch(current, { fleet, screensaver })
    if (next === (current || '')) return
    const url = `${window.location.pathname}${next}${window.location.hash}`
    // Keep the state Next.js attaches to history entries (first argument), change only the address.
    window.history.replaceState(window.history.state, '', url)
  }, [ready, fleet, screensaver])
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { loadAppState, saveAppState, serializeAppState, type AppState } from '@/lib/fleet/app-state'

/**
 * Keeps the latest app state in localStorage (one versioned key, see lib/fleet/app-state.ts).
 *
 * Restore happens after mount, the same SSR-safe way use-screensaver.ts does it: the server and the first
 * client frame render the defaults, then `onRestore` receives what was stored. Saving waits until that has
 * happened (otherwise the first render would overwrite the stored state with the defaults), and then runs on
 * every change.
 *
 * The open tab (`selectedSessionId`) is restored by the session bridge when the session list arrives (it
 * knows which tabs exist). Until a tab is open the stored id is kept, so a reload that happens before the
 * list arrives does not forget it.
 */
export function useAppStatePersistence(state: AppState, onRestore: (stored: AppState) => void): void {
  const [hydrated, setHydrated] = useState(false)
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore
  const lastSessionRef = useRef<string | null>(null)

  useEffect(() => {
    const stored = loadAppState(window.localStorage)
    lastSessionRef.current = stored.selectedSessionId
    onRestoreRef.current(stored)
    setHydrated(true)
  }, [])

  if (state.selectedSessionId) lastSessionRef.current = state.selectedSessionId
  const merged: AppState = { ...state, selectedSessionId: state.selectedSessionId ?? lastSessionRef.current }
  const mergedRef = useRef(merged)
  mergedRef.current = merged
  // The serialized form is the change key: the effect runs when a field changed, not on every render.
  const serialized = serializeAppState(merged)

  useEffect(() => {
    if (!hydrated) return
    saveAppState(window.localStorage, mergedRef.current)
  }, [hydrated, serialized])
}

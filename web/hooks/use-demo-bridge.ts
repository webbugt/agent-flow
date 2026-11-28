'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { SimulationEvent } from '@/lib/agent-types'
import type { SessionInfo } from '@/lib/bridge-types'
import {
  applyDemoAction, createDemoState, demoSessionList, demoSources,
  type DemoAction, type DemoState,
} from '@/lib/demo/demo-state'
import type { DemoFeed } from '@/lib/demo/demo-feed'
import type { BridgeHookResult } from './bridge-hook-result'

export interface DemoHandle {
  state: DemoState
  /** Fire one synthetic action. A no-op action (nothing to do) changes nothing. */
  dispatch: (action: DemoAction) => void
  /** What the visualiser view needs besides the bridge. */
  feed: DemoFeed
}

const NO_EVENTS: readonly SimulationEvent[] = []

/**
 * The /demo route's event source: the same shape as `useVSCodeBridge` (sessions, per-session event buffers, the
 * open tab and the events pending for it), fed by the synthetic reducer in lib/demo/demo-state.ts instead of the
 * relay. It opens no connection, listens to no window message and reads no endpoint (isolation guard:
 * lib/demo/demo-isolation.test.ts).
 *
 * Delivery follows the live bridge: every event is buffered by session; the open tab's events are also queued as
 * pending (live, animated); selecting a tab queues that session's buffer as history once the view has swapped state.
 */
export function useDemoBridge(): { bridge: BridgeHookResult; demo: DemoHandle } {
  const stateRef = useRef<DemoState>(createDemoState())
  const [state, setState] = useState<DemoState>(stateRef.current)
  const [version, setVersion] = useState(0)
  const [resetCount, setResetCount] = useState(0)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  /** True between a tab switch and the view's state swap: events must not be applied to the wrong simulation. */
  const switchPendingRef = useRef(false)
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())
  const dismissedRef = useRef<Map<string, SessionInfo>>(new Map())
  /** Sessions the user closed, kept out of the tab list (a new event brings them back, as in the live bridge). */
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())

  const dispatch = useCallback((action: DemoAction) => {
    const prev = stateRef.current
    const next = applyDemoAction(prev, action, Date.now())
    if (next === prev) return
    stateRef.current = next

    if (action.type === 'reset') {
      pendingEventsRef.current.length = 0
      switchPendingRef.current = false
      selectedSessionIdRef.current = null
      dismissedRef.current.clear()
      setSelectedSessionId(null)
      setSessionsWithActivity(new Set())
      setClosed(new Set())
      setResetCount(n => n + 1)
    } else {
      // A new profile session opens its tab, as a started session does in the live bridge.
      const before = new Set(prev.sessions.map(s => s.id))
      const fresh = next.sessions.find(s => !before.has(s.id))
      if (fresh && selectedSessionIdRef.current !== fresh.id) {
        switchPendingRef.current = true
        pendingEventsRef.current.length = 0
        selectedSessionIdRef.current = fresh.id
        setSelectedSessionId(fresh.id)
      }
      const selected = selectedSessionIdRef.current
      const bumped: string[] = []
      const revived: string[] = []
      for (const s of next.sessions) {
        const had = prev.events[s.id]?.length ?? 0
        const added = (next.events[s.id] ?? NO_EVENTS).slice(had)
        if (added.length === 0) continue
        // A closed tab comes back when its session does something (as in the live bridge).
        if (dismissedRef.current.delete(s.id)) revived.push(s.id)
        if (s.id === selected) {
          // Live events (not history): the simulation animates them. Skipped while a tab switch is pending:
          // the view flushes the whole buffer after it has swapped state.
          if (!switchPendingRef.current) pendingEventsRef.current.push(...added)
        } else {
          bumped.push(s.id)
        }
      }
      if (bumped.length > 0) {
        setSessionsWithActivity(cur => {
          const merged = new Set(cur)
          for (const id of bumped) merged.add(id)
          return merged.size === cur.size ? cur : merged
        })
      }
      if (revived.length > 0) {
        setClosed(cur => {
          const rest = new Set(cur)
          for (const id of revived) rest.delete(id)
          return rest
        })
      }
    }
    setState(next)
    setVersion(v => v + 1)
  }, [])

  const consumeEvents = useCallback(() => { pendingEventsRef.current.length = 0 }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    switchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId) {
      setSessionsWithActivity(cur => {
        if (!cur.has(sessionId)) return cur
        const rest = new Set(cur)
        rest.delete(sessionId)
        return rest
      })
    }
  }, [])

  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    switchPendingRef.current = false
    const buffered = stateRef.current.events[sessionId] ?? NO_EVENTS
    pendingEventsRef.current.length = 0
    // Everything in the buffer already happened: applied as a snapshot, not as live animation.
    pendingEventsRef.current.push(...buffered.slice(fromIndex).map(e => ({ ...e, history: true })))
    setVersion(v => v + 1)
  }, [])

  const getSessionEventCount = useCallback((sessionId: string) => stateRef.current.events[sessionId]?.length ?? 0, [])
  const getSessionEvents = useCallback((sessionId: string): readonly SimulationEvent[] => stateRef.current.events[sessionId] ?? NO_EVENTS, [])

  const removeSession = useCallback((sessionId: string) => {
    const info = demoSessionList(stateRef.current).find(s => s.id === sessionId)
    if (info) dismissedRef.current.set(sessionId, info)
    setClosed(cur => new Set(cur).add(sessionId))
    setSessionsWithActivity(cur => {
      if (!cur.has(sessionId)) return cur
      const rest = new Set(cur)
      rest.delete(sessionId)
      return rest
    })
  }, [])

  const getDismissedSessions = useCallback((): SessionInfo[] => [...dismissedRef.current.values()], [])
  const bridgeOpenFile = useCallback(() => {}, [])

  const sessions = useMemo(() => demoSessionList(state).filter(s => !closed.has(s.id)), [state, closed])

  const bridge: BridgeHookResult = {
    isVSCode: false,
    connectionStatus: 'disconnected',
    // No stream, so no freshness stamps: the visualiser hides the LIVE / STALE marker in the demo (showFreshness).
    lastEventAt: null,
    lastActivityAt: null,
    connectedAt: null,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    // False on purpose: the built-in mock scenario is not the demo; the demo's own events drive every view.
    useMockData: false,
    disable1MContext: false,
    bridgeOpenFile,
    sessions,
    selectedSessionId,
    selectedSessionIdRef,
    selectSession,
    flushSessionEvents,
    getSessionEventCount,
    sessionsWithActivity,
    removeSession,
    getSessionEvents,
    getDismissedSessions,
  }
  // rightInset is set by the entry (it knows the panel and the viewport).
  const feed: DemoFeed = { sources: useMemo(() => demoSources(state), [state]), version, resetCount, rightInset: 0 }
  return { bridge, demo: { state, dispatch, feed } }
}

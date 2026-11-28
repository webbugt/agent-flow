'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo } from '@/lib/vscode-bridge'
import { SimulationEvent } from '@/lib/agent-types'
import { countsAsActivity } from '@/lib/fleet/fleet-model'
import { showsLiveActivity, stampStreamMessage, type StreamStamps } from '@/lib/data-freshness'
import { loadAppState, pickInitialSession } from '@/lib/fleet/app-state'
import { handleServerVersion } from '@/lib/auto-reload'
import type { BridgeHookResult } from './bridge-hook-result'

export type { BridgeHookResult }

/**
 * Connects the VS Code bridge to the React app.
 * When running standalone, returns useMockData=true and no events.
 * When inside VS Code, receives events and forwards control commands.
 *
 * Supports multi-session: events are buffered per-session so switching
 * sessions replays the correct event history.
 */
export function useVSCodeBridge(): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [stamps, setStamps] = useState<StreamStamps>({ lastEventAt: null, lastActivityAt: null })
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const stampsRef = useRef<StreamStamps>(stamps)
  const [useMockData, setUseMockData] = useState(
    process.env.NEXT_PUBLIC_DEMO !== '0'
  )
  const [disable1MContext, setDisable1MContext] = useState(false)
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const [, setEventVersion] = useState(0) // trigger re-render on new events

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())
  /** True while a session switch is pending (between auto-select and useLayoutEffect).
   *  Prevents the animation frame from processing events in the wrong simulation context. */
  const sessionSwitchPendingRef = useRef(false)
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())

  // Connect to standalone dev relay server via SSE when not in VS Code
  useEffect(() => {
    if (typeof window === 'undefined') return
    const bridge = vscodeBridge
    if (!bridge) return

    // Skip in VS Code — extension handles events via postMessage
    if (bridge.isVSCode) return

    // Connect to relay in dev mode or standalone CLI mode
    const isStandalone = process.env.AGENT_FLOW_STANDALONE === '1'
    if (!isStandalone && (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DEMO !== '0')) return

    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const es = new EventSource(relayPort ? `http://127.0.0.1:${relayPort}/events` : '/events')

    es.onopen = () => {
      setConnectionStatus('connected')
      setConnectedAt(Date.now())
      setUseMockData(false)
    }
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        // The relay announces its build commit; a different one than this bundle's reloads the page once.
        if (data?.type === 'server-version') { handleServerVersion(data); return }
        window.postMessage(data, '*')
      } catch {}
    }
    es.onerror = () => {
      setConnectionStatus('disconnected')
    }

    return () => {
      es.close()
    }
  }, [])

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) { return }

    // Listen for bridge initialization (event-driven, no polling)
    const unsubInit = bridge.onInit(() => {
      setIsVSCode(true)
      setUseMockData(false)
    })

    // Listen for events — buffer by session, deliver to pending if session matches.
    // selectedSessionIdRef is updated synchronously (not via React state) so it's
    // always current even before React re-renders.
    const unsubEvent = bridge.onEvent((event: AgentEvent) => {
      const simEvent: SimulationEvent = {
        time: event.time,
        type: event.type as SimulationEvent['type'],
        payload: event.payload,
        sessionId: event.sessionId,
        ...(event.history ? { history: true } : {}),
      }

      // Freshness for the top bar. ANY message of the stream shows that the relay is alive and sending (context_update,
      // model_detected, the relay's agent_idle ticks, history replays), so it moves the liveness stamp (LIVE / STALE).
      // The visible age is the age of the last REAL activity: only a live message that showsLiveActivity moves that stamp
      // (the fleet activity filter's rule plus context_update, which the relay sends only after a model call), so agent_idle ticks (one per quiet session per second) and the
      // quiet-timeout completion never reset it (every inactivity completion of the relay, the VS Code extension, the Codex
      // watcher and the Hermes log watcher carries `reason: 'quiet'`). One state update a second is plenty for a 60 s threshold.
      const nextStamps = stampStreamMessage(stampsRef.current, Date.now(), showsLiveActivity(event.type, event.payload, event.history))
      if (nextStamps !== stampsRef.current) {
        stampsRef.current = nextStamps
        setStamps(nextStamps)
      }

      // Always buffer by session (for replay on session switch)
      if (event.sessionId) {
        const buf = sessionEventsRef.current.get(event.sessionId) || []
        buf.push(simEvent)
        sessionEventsRef.current.set(event.sessionId, buf)
        // Keep lastActivityTime roughly current (throttled: one state update per 5s per session)
        // agent_idle and the quiet-timeout completion mark the absence of activity: they do not bump it
        // (the fleet activity filter reads it for sessions without nodes).
        const now = Date.now()
        if (countsAsActivity(event.type, event.payload)) setSessions(prev => {
          const s = prev.find(x => x.id === event.sessionId)
          if (!s || now - s.lastActivityTime < 5000) return prev
          return prev.map(x => x.id === event.sessionId ? { ...x, lastActivityTime: now } : x)
        })
      }

      // Deliver to pending if session matches (ref is always current).
      // Skip if a session switch is pending — useLayoutEffect will flush
      // from the session buffer once the simulation state is swapped.
      const selected = selectedSessionIdRef.current
      if (selected && event.sessionId === selected && !sessionSwitchPendingRef.current) {
        pendingEventsRef.current.push(simEvent)
        setEventVersion(v => v + 1)
      } else if (event.sessionId && event.sessionId !== selected) {
        // Track background activity for unselected sessions
        setSessionsWithActivity(prev => {
          if (prev.has(event.sessionId!)) return prev
          const next = new Set(prev)
          next.add(event.sessionId!)
          return next
        })
      }

      // Re-add dismissed sessions when new events arrive
      if (event.sessionId && dismissedSessionsRef.current.has(event.sessionId)) {
        const saved = dismissedSessionsRef.current.get(event.sessionId)
        dismissedSessionsRef.current.delete(event.sessionId)
        if (saved) {
          setSessions(prev => {
            if (prev.find(s => s.id === saved.id)) return prev
            return [...prev, { ...saved, status: 'active' as const, lastActivityTime: Date.now(), idle: undefined }]
          })
        }
      }
    })

    const unsubStatus = bridge.onStatus((status) => {
      setConnectionStatus(status)
    })

    const unsubConfig = bridge.onConfig((config) => {
      if (config.showMockData !== undefined) { setUseMockData(config.showMockData) }
      if (config.disable1MContext !== undefined) { setDisable1MContext(config.disable1MContext) }
    })

    // Session lifecycle tracking
    // Note: these handlers only update session list + selection state.
    // Event flushing is handled by the consumer (index.tsx effect) to avoid
    // races between auto-flush here and save/restore logic there.
    const unsubSession = bridge.onSession((type, data) => {
      if (type === 'reset') {
        // Panel was reopened — clear all stale state
        setSessions([])
        setSelectedSessionId(null)
        selectedSessionIdRef.current = null
        pendingEventsRef.current.length = 0
        sessionEventsRef.current.clear()
        setSessionsWithActivity(new Set())
        dismissedSessionsRef.current.clear()
        setEventVersion(v => v + 1)
        return
      }
      if (type === 'list') {
        const sessionList = data as SessionInfo[]
        setSessions(sessionList)
        // Auto-select: the tab the user left (app-state), else prefer active sessions, then most recently active.
        // Only set selection — useLayoutEffect handles flushing events.
        // Idle sessions (history only) are fleet-only: never auto-selected, so the
        // single-profile view opens exactly as it did before they were listed.
        const autoId = selectedSessionIdRef.current
          ? null
          : pickInitialSession(sessionList, loadAppState(typeof window !== 'undefined' ? window.localStorage : null).selectedSessionId)
        if (autoId) {
          sessionSwitchPendingRef.current = true
          pendingEventsRef.current.length = 0
          selectedSessionIdRef.current = autoId
          setSelectedSessionId(autoId)
        }
      } else if (type === 'started') {
        const session = data as SessionInfo
        // Resume after inactivity re-sends 'started' for a session we may already
        // be showing. Re-arming the switch for the same id would set
        // sessionSwitchPendingRef without anything ever clearing it (the layout
        // effect only runs when the selection changes), freezing event delivery.
        const alreadySelected = session.id === selectedSessionIdRef.current
        setSessions(prev => {
          const existing = prev.find(s => s.id === session.id)
          if (existing) {
            // Session resumed after inactivity — mark active again
            return prev.map(s => s.id === session.id
              ? { ...s, status: 'active' as const, lastActivityTime: Date.now(), idle: undefined }
              : s)
          }
          return [...prev, session]
        })
        if (alreadySelected) return
        // Auto-select newly started session.
        // Set switch-pending flag to prevent the animation frame from processing
        // events in the wrong simulation state before useLayoutEffect swaps it.
        sessionSwitchPendingRef.current = true
        pendingEventsRef.current.length = 0
        selectedSessionIdRef.current = session.id
        setSelectedSessionId(session.id)
      } else if (type === 'updated') {
        const { sessionId, label } = data as { sessionId: string; label: string }
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, label } : s
        ))
      } else if (type === 'ended') {
        const sessionId = data as string
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, status: 'completed' as const } : s
        ))
      }
    })

    return () => {
      unsubInit()
      unsubEvent()
      unsubStatus()
      unsubConfig()
      unsubSession()
    }
  }, [])

  const consumeEvents = useCallback(() => {
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  /** Switch session selection. Does NOT flush events — call flushSessionEvents
   *  from useLayoutEffect after the simulation state has been saved/swapped. */
  const selectSession = useCallback((sessionId: string | null) => {
    // Block event delivery to pending until the simulation state is swapped
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId) {
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  /** Flush buffered events for the selected session into pending.
   *  Must be called from useLayoutEffect AFTER simulation state is saved/swapped. */
  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    sessionSwitchPendingRef.current = false
    const buffered = sessionEventsRef.current.get(sessionId) || []
    pendingEventsRef.current.length = 0
    // Everything in the buffer already happened: apply it as a snapshot, not as live animation.
    pendingEventsRef.current.push(...buffered.slice(fromIndex).map(e => e.history ? e : { ...e, history: true }))
    setEventVersion(v => v + 1)
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    return sessionEventsRef.current.get(sessionId)?.length ?? 0
  }, [])

  const dismissedSessionsRef = useRef<Map<string, SessionInfo>>(new Map())

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const session = prev.find(s => s.id === sessionId)
      if (session) { dismissedSessionsRef.current.set(sessionId, session) }
      return prev.filter(s => s.id !== sessionId)
    })
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const getSessionEvents = useCallback(
    (sessionId: string): readonly SimulationEvent[] => sessionEventsRef.current.get(sessionId) ?? [],
    [],
  )

  const getDismissedSessions = useCallback((): SessionInfo[] => [...dismissedSessionsRef.current.values()], [])

  const bridgeOpenFile = useCallback((filePath: string, line?: number) => {
    vscodeBridge?.openFile(filePath, line)
  }, [])

  return {
    isVSCode,
    connectionStatus,
    lastEventAt: stamps.lastEventAt,
    lastActivityAt: stamps.lastActivityAt,
    connectedAt,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    disable1MContext,
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
}

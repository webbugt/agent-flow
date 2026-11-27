"use client"

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { useAgentSimulation } from "@/hooks/use-agent-simulation"
import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { useSelectionState } from "@/hooks/use-selection-state"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { useScreensaver } from "@/hooks/use-screensaver"
import { useViewUrlSync } from "@/hooks/use-view-url"
import { parseViewParams } from "@/lib/fleet/url-view"
import { AgentCanvas, type CanvasControls } from "./canvas"
import { SingleZoomControls } from "./single-zoom-controls"
import { agentCostOf } from "./canvas/draw-cost"
import { effectiveCosts } from "@/lib/costs/active"
import { buildTopBarCost, describeSources } from "@/lib/costs/overlay"
import { getOverlayUnit, overlayUnitVersion, subscribeOverlayUnit } from "@/lib/cost-overlay-store"
import { CostsSettingsDrawer } from "./costs-settings-drawer"
import { ControlBar } from "./control-bar"
import { AgentDetailCard } from "./agent-detail-card"
import { GlassContextMenu } from "./glass-context-menu"
import { ToolDetailPopup } from "./tool-detail-popup"
import { DiscoveryDetailPopup } from "./discovery-detail-popup"
import { FileAttentionPanel } from "./file-attention-panel"
import { TimelinePanel } from "./timeline-panel"
import { FleetTimelinePanel } from "./fleet-timeline-panel"
import { FleetMap } from "./fleet-map"
import { SingleBlocks } from "./single-blocks"
import { createDemoResources, addDemoEvent, addDemoNodes, type DemoEventKind } from "@/lib/fleet/fleet-demo-resources"
import { mapInsetBottom } from "@/lib/fleet/fleet-timeline-pref"
import { getOptions, updateOptions } from "@/lib/options-store"
import { useOptions } from "@/hooks/use-options"
import { useSingleAnchor } from "@/hooks/use-single-anchor"
import { OptionsPanel } from "./options-panel"
import { useFleetSelection } from "@/hooks/use-fleet-selection"
import { useFleetActivityFilter } from "@/hooks/use-fleet-activity-filter"
import { applyActivityFilter, withActivityFilter } from "@/lib/fleet/fleet-activity-filter"
import { useFleetSources } from "@/hooks/use-fleet-sources"
import { createFleetFixtureSessions } from "@/lib/fleet/fleet-fixture-events"
import { createFleetFixture, fleetSessions, instancesFromSessionEvents, splitInstanceId, tabSessions } from "@/lib/fleet/fleet-model"
import { AgentChatPanel } from "./chat-panel"
import { SessionTranscriptPanel } from "./session-transcript-panel"
import { SessionDetailPanel } from "./session-detail-panel"
import { OpenFileProvider } from "./tool-content-renderer"
import { stopPropagationHandlers } from "./shared-ui"
import { CARD, TimelineEvent, TIMING } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { registerShotHook, markShotReady } from "@/lib/shot-mode"

import { MOCK_DURATION } from "@/lib/mock-scenario"
import { MessageFeedPanel } from "./message-feed-panel"
import { TopBar } from "./top-bar"
import { CostsConfigBanner } from "./costs-config-banner"
import { LimitsPanelHost } from "./limits-panel"
import { useCostsConfig } from "@/hooks/use-costs-config"
import { useLimitsFeed } from "@/hooks/use-limits"
import { useAudioEffects } from "@/hooks/use-audio-effects"
import { useViewportWidth } from "@/hooks/use-viewport-width"
import { useAppStatePersistence } from "@/hooks/use-app-state"
import type { AppState } from "@/lib/fleet/app-state"
import { detailInset } from "@/lib/session-detail"
import { FleetReplay } from "@/hooks/simulation/fleet-scene"

export function AgentVisualizer() {
  const bridge = useVSCodeBridge()

  const {
    frameRef,
    agents,
    toolCalls,
    particles,
    edges,
    discoveries,
    fileAttention,
    timelineEntries,
    currentTime,
    isPlaying,
    speed,
    maxTimeReached,
    conversations,
    play,
    pause,
    restart,
    setSpeed,
    seekToTime,
    updateAgentPosition,
    saveSnapshot,
    restoreSnapshot,
  } = useAgentSimulation({
    useMockData: bridge.useMockData,
    externalEvents: bridge.pendingEvents,
    onExternalEventsConsumed: bridge.consumeEvents,
    sessionFilter: bridge.selectedSessionId,
    // Pass the ref that's updated synchronously in session-started handler,
    // so the animation frame never uses a stale filter value.
    sessionFilterRef: bridge.selectedSessionIdRef,
    disable1MContext: bridge.disable1MContext,
  })

  const selection = useSelectionState({ agents, toolCalls, discoveries })

  // Screensaver mode: hides every piece of UI around the map; the map and its activity animation stay.
  const screensaver = useScreensaver()
  const sv = screensaver.on
  const clearAllSelections = selection.clearAllSelections
  // Entering drops what was selected, so no highlight or tether line is left on the bare map.
  useEffect(() => { if (sv) clearAllSelections() }, [sv, clearAllSelections])

  const [showStats, setShowStats] = useState(false)
  const [showHexGrid, setShowHexGrid] = useState(true)
  const [showCostOverlay, setShowCostOverlay] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [showFleet, setShowFleet] = useState(false)
  // Options panel (linger/fade/show per block kind, and the other client settings), see options-panel.tsx.
  const [showOptions, setShowOptions] = useState(false)
  // Fleet timeline panel: shown by default; the choice is kept in the options registry (read after mount, so SSR
  // matches), so the options panel and this toggle edit the same value.
  const fleetTimelineVisible = useOptions().fleetTimelineVisible
  // Resource-anchor mode: kept in the options registry too (persisted per browser), so the header toggle and the options panel edit one value.
  const anchorMode = useOptions().anchorMode
  const toggleAnchorMode = useCallback(() => {
    updateOptions({ anchorMode: !getOptions().anchorMode })
  }, [])
  const toggleFleetTimeline = useCallback(() => {
    updateOptions({ fleetTimelineVisible: !getOptions().fleetTimelineVisible })
  }, [])
  const [showFileAttention, setShowFileAttention] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  // Session detail: the whole conversation + tool calls of ONE Hermes session (agent node)
  const [showSessionDetail, setShowSessionDetail] = useState(false)
  // LIMITS panel fold state: folded by default; kept with the rest of the app state below.
  const [limitsCollapsed, setLimitsCollapsed] = useState(true)
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null)
  // Set when the detail was opened from the Fleet: it then reads that profile's fleet replay
  // (finished and idle nodes keep their history there), not the single-view simulation.
  const [detailFleetSessionId, setDetailFleetSessionId] = useState<string | null>(null)
  const fleetReplayRef = useRef<FleetReplay | null>(null)
  /** On-screen zoom buttons of the single-session graph (the canvas fills it). */
  const singleCanvasControlsRef = useRef<CanvasControls | null>(null)
  if (!fleetReplayRef.current) fleetReplayRef.current = new FleetReplay()
  const viewportWidth = useViewportWidth(1280)

  // The latest app state (open tab, mode, panels, LIMITS fold) is kept in localStorage and restored after mount,
  // so the server and the first client frame render the same. Screensaver mode, the options, the fleet timeline
  // visibility, the activity window and the fleet selection have their own keys. The open tab is restored by the
  // session bridge when the session list arrives; the session detail panel is not restored (it needs a node id).
  useAppStatePersistence(
    { showFleet, showTimeline, showStats, showHexGrid, showCostOverlay, showFileAttention, showTranscript, limitsCollapsed, selectedSessionId: bridge.selectedSessionId },
    useCallback((s: AppState) => {
      // `?fleet=1|0` in the URL wins over the stored Fleet choice; without it the stored choice applies.
      setShowFleet(parseViewParams(window.location.search).fleet ?? s.showFleet)
      setShowTimeline(s.showTimeline)
      setShowStats(s.showStats)
      setShowHexGrid(s.showHexGrid)
      setShowCostOverlay(s.showCostOverlay)
      setShowFileAttention(s.showFileAttention)
      setShowTranscript(s.showTranscript)
      setLimitsCollapsed(s.limitsCollapsed)
    }, []),
  )

  // The Fleet view and screensaver mode are kept in the URL (`?fleet=`, `?screensaver=`, see lib/fleet/url-view.ts).
  // Written only after the restore above has run (same mount pass), so the URL is read before it is rewritten.
  const [viewUrlReady, setViewUrlReady] = useState(false)
  useEffect(() => { setViewUrlReady(true) }, [])
  useViewUrlSync({ fleet: showFleet, screensaver: sv }, viewUrlReady)

  // Fleet view: agent instances grouped by identity + Kanban/Supermemory lanes.
  // Selection only hides things from the views; it never stops a session.
  const fleetSelection = useFleetSelection()
  const fleetSources = useFleetSources(showFleet && !bridge.useMockData)
  const fleetFixture = useMemo(() => createFleetFixture(Date.now()), [])
  // Demo: invented boards and namespaces, plus a new event now and then, so the map shows placement, link linger and pulses.
  const [demoSources, setDemoSources] = useState(() => createDemoResources(Date.now()))
  const demoSeqRef = useRef(0)
  useEffect(() => {
    if (!bridge.useMockData || !showFleet) return
    // The sequence number is taken outside the state updater: React may run an updater twice (Strict Mode).
    const emit = (kind: DemoEventKind) => {
      const seq = demoSeqRef.current++
      const at = Date.now()
      setDemoSources(prev => addDemoEvent(prev, kind, at, seq))
    }
    // A poll that brings new nodes (a new board and a new namespace): the user's zoom must survive it.
    const poll = () => {
      const seq = demoSeqRef.current++
      const at = Date.now()
      setDemoSources(prev => addDemoNodes(prev, at, seq))
    }
    // Handle for the demo only (screenshots, manual checks): `__fleetDemo.emit('kanban' | 'memory')`, `__fleetDemo.poll()`.
    const w = window as unknown as { __fleetDemo?: { emit: (kind: DemoEventKind) => void; poll: () => void } }
    w.__fleetDemo = { emit, poll }
    const timer = setInterval(() => emit(demoSeqRef.current % 2 ? 'kanban' : 'memory'), 20_000)
    return () => { clearInterval(timer); delete w.__fleetDemo }
  }, [bridge.useMockData, showFleet])
  const fleetKanban = bridge.useMockData ? demoSources.kanban : fleetSources.kanban
  const fleetMemory = bridge.useMockData ? demoSources.supermemory : fleetSources.supermemory
  // The fleet reads EVERY session of every profile (also closed tabs) and each agent node
  // inside them, never just the open tab. Their events are buffered in refs, so a slow tick
  // refreshes the instances while the panel is open.
  const [fleetTick, setFleetTick] = useState(0)
  useEffect(() => {
    if (!showFleet || bridge.useMockData) return
    const timer = setInterval(() => setFleetTick(n => n + 1), 2000)
    return () => clearInterval(timer)
  }, [showFleet, bridge.useMockData])
  const { sessions: bridgeSessions, getSessionEvents, getDismissedSessions } = bridge
  const fleetInstances = useMemo(() => {
    if (bridge.useMockData) return fleetFixture
    if (!showFleet) return []
    return instancesFromSessionEvents(fleetSessions(bridgeSessions, getDismissedSessions()), getSessionEvents)
    // fleetTick: the event buffers are refs, so React does not see new events by itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.useMockData, showFleet, bridgeSessions, getSessionEvents, getDismissedSessions, fleetFixture, fleetTick])
  // The Fleet map draws every session (profile) with the single-session renderer: live, idle and
  // closed tabs, fed from the same per-session event buffers. The demo feeds it through the same path.
  const fleetDemo = useMemo(() => createFleetFixtureSessions(Date.now()), [])
  const mapSessions = useMemo(() => {
    if (bridge.useMockData) return fleetDemo.sessions
    if (!showFleet) return []
    return fleetSessions(bridgeSessions, getDismissedSessions())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.useMockData, showFleet, bridgeSessions, getDismissedSessions, fleetDemo, fleetTick])
  const mapEventsOf = bridge.useMockData ? fleetDemo.eventsOf : getSessionEvents
  // Latest-activity filter: profiles, sessions and resources with no event in the window are hidden from
  // the map and the timeline panel. Visual only: nothing is stopped, and the user's selection is untouched
  // (so the tab strip below keeps following the selection alone).
  const activityFilter = useFleetActivityFilter({
    enabled: showFleet, instances: fleetInstances, kanban: fleetKanban, supermemory: fleetMemory, selection: fleetSelection.view,
  })
  const mapSelection = useMemo(
    () => withActivityFilter(fleetSelection.view, activityFilter.hidden),
    [fleetSelection.view, activityFilter.hidden],
  )
  const panelInstances = useMemo(() => applyActivityFilter(fleetInstances, activityFilter.hidden), [fleetInstances, activityFilter.hidden])
  const panelKanban = useMemo(() => fleetKanban && applyActivityFilter(fleetKanban, activityFilter.hidden), [fleetKanban, activityFilter.hidden])
  const panelMemory = useMemo(() => fleetMemory && applyActivityFilter(fleetMemory, activityFilter.hidden), [fleetMemory, activityFilter.hidden])

  // Single view: the open session as the resource blocks see it (id and label only). Its own events, nobody else's.
  const openBlockSession = useMemo(() => {
    const s = bridgeSessions.find(x => x.id === bridge.selectedSessionId)
    return s ? { id: s.id, label: s.label } : null
  }, [bridgeSessions, bridge.selectedSessionId])
  // Resource-anchor mode in the single view (the fleet map has its own scene): the frame the canvas draws.
  // Live sessions only: the demo (mock) scenario has no resource events.
  const singleAnchorOn = anchorMode && !showFleet && !bridge.useMockData
  const singleAnchor = useSingleAnchor({
    enabled: singleAnchorOn, session: openBlockSession, eventsOf: getSessionEvents, sourceRef: frameRef, updateAgentPosition,
  })
  // Fleet on: nodes deselected in the fleet drop out of the tab strip (the open tab always stays).
  // Fleet off: the single-profile tab strip is unchanged.
  const visibleSessions = useMemo(
    () => tabSessions(bridgeSessions, bridge.selectedSessionId, showFleet, fleetInstances, fleetSelection.view),
    [bridgeSessions, bridge.selectedSessionId, showFleet, fleetInstances, fleetSelection.view],
  )

  // Mutually exclusive panel toggling — opening one closes the others
  const toggleExclusivePanel = useCallback((panel: 'files' | 'transcript' | 'cost' | 'session') => {
    setShowFileAttention(prev => panel === 'files' ? !prev : false)
    setShowTranscript(prev => panel === 'transcript' ? !prev : false)
    setShowCostOverlay(prev => panel === 'cost' ? !prev : false)
    setShowSessionDetail(prev => panel === 'session' ? !prev : false)
    if (panel === 'session') setDetailFleetSessionId(null)
  }, [])

  /** Open the session detail (it closes the other right-hand panels). `agentId` null = the most recently active session node. */
  const openSessionDetail = useCallback((agentId: string | null, fleetSession: string | null = null) => {
    setDetailAgentId(agentId)
    setDetailFleetSessionId(fleetSession)
    setShowFileAttention(false)
    setShowTranscript(false)
    setShowCostOverlay(false)
    setShowSessionDetail(true)
  }, [])
  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0)

  const [isReviewing, setIsReviewing] = useState(false)
  const { isMuted, seekingRef, handleToggleMute } = useAudioEffects(agents, toolCalls, isReviewing)

  // Screenshot harness (?shot=1 only, see lib/shot-mode.ts): freeze the simulation, open a panel by name
  useEffect(() => {
    const offFreeze = registerShotHook('freeze', () => { pause(); markShotReady() })
    const offPanel = registerShotHook('setPanel', (name: string) => {
      setShowFileAttention(name === 'files')
      setShowTranscript(name === 'transcript')
      setShowCostOverlay(name === 'cost')
      setShowSessionDetail(name === 'session')
    })
    const offSeek = registerShotHook('seekEnd', () => {
      // The last message event (else the last event), not maxTimeReached, which also counts the wall time
      // the page has been playing: speech bubbles expire 12 s after their event, so this keeps them shown
      const log = frameRef.current.eventLog
      const last = [...log].reverse().find(e => e.type === 'message') ?? log[log.length - 1]
      pause(); seekToTime(last ? last.time : 0)
    })
    return () => { offFreeze(); offPanel(); offSeek() }
  }, [pause, seekToTime, frameRef])

  // Auto-play on mount
  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  // Per-session state cache: save/restore simulation state on tab switch
  // so sessions stay up to date and switching is instant.
  // useLayoutEffect ensures restart happens synchronously before any animation
  // frame can consume and discard events from pendingEventsRef.
  const sessionCacheRef = useRef<Map<string, { snapshot: ReturnType<typeof saveSnapshot>; eventCount: number }>>(new Map())
  const prevSelectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (bridge.selectedSessionId === null && prevSelectedRef.current !== null) {
      // Bridge reset (panel reopened / relay restarted): cached snapshots are stale
      sessionCacheRef.current.clear()
      prevSelectedRef.current = null
      return
    }
    if (bridge.selectedSessionId && bridge.selectedSessionId !== prevSelectedRef.current) {
      // Review/scrub state is per-component, not per-session: the incoming tab is restored live
      setIsReviewing(false)
      // Save outgoing session state (if any)
      if (prevSelectedRef.current !== null) {
        sessionCacheRef.current.set(prevSelectedRef.current, {
          snapshot: saveSnapshot(),
          eventCount: bridge.getSessionEventCount(prevSelectedRef.current),
        })
      }

      // Restore or cold-start the incoming session, then flush events.
      // Flushing happens HERE (after state swap) to prevent the animation
      // frame from processing events in the wrong simulation context.
      const cached = sessionCacheRef.current.get(bridge.selectedSessionId)
      if (cached) {
        restoreSnapshot(cached.snapshot)
        bridge.flushSessionEvents(bridge.selectedSessionId, cached.eventCount)
      } else {
        restart()
        bridge.flushSessionEvents(bridge.selectedSessionId)
      }

      prevSelectedRef.current = bridge.selectedSessionId
    }
  }, [bridge.selectedSessionId, restart, bridge.flushSessionEvents, saveSnapshot, restoreSnapshot, bridge.getSessionEventCount])

  // Timeline events — incremental: only processes new conversation messages
  const timelineCacheRef = useRef<{
    counts: Map<string, number>
    events: TimelineEvent[]
    idCounter: number
  }>({ counts: new Map(), events: [], idCounter: 0 })

  const timelineEvents = useMemo((): TimelineEvent[] => {
    const cache = timelineCacheRef.current
    let appended = false
    for (const [agentId, msgs] of conversations) {
      const prevLen = cache.counts.get(agentId) ?? 0
      if (msgs.length > prevLen) {
        for (let i = prevLen; i < msgs.length; i++) {
          const msg = msgs[i]
          cache.events.push({
            id: `event-${cache.idCounter++}`,
            type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
            label: msg.content,
            timestamp: msg.timestamp,
            nodeId: agentId,
          })
        }
        cache.counts.set(agentId, msgs.length)
        appended = true
      }
    }
    if (appended) cache.events.sort((a, b) => a.timestamp - b.timestamp)
    return cache.events
  }, [conversations])

  // Review mode: when in live mode and user pauses to scrub through history

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause()
      setIsReviewing(true)
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const handleEnterReview = useCallback(() => {
    pause()
    setIsReviewing(true)
  }, [pause])

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleResumeLive = useCallback(() => {
    setIsReviewing(false)
    seekToTime(maxTimeReached)
    setZoomToFitTrigger(n => n + 1)
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; play() }, TIMING.resumeLiveDelayMs)
  }, [seekToTime, maxTimeReached, play])
  useEffect(() => () => { if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current) }, [])

  const handleRestart = useCallback(() => {
    setIsReviewing(false)
    restart(true)
  }, [restart])

  // Keyboard shortcuts
  const keyboardActions = useMemo(() => ({
    togglePlayPause: handlePlayPause,
    toggleFilePanel: () => toggleExclusivePanel('files'),
    toggleTranscript: () => toggleExclusivePanel('transcript'),
    toggleTimeline: () => { setShowTimeline(prev => !prev) },
    toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
    toggleStats: () => { setShowStats(prev => !prev) },
    toggleScreensaver: screensaver.toggle,
    screensaverActive: sv,
    toggleCostOverlay: () => toggleExclusivePanel('cost'),
    zoomToFit: () => { setZoomToFitTrigger(n => n + 1) },
    clearSelection: () => { selection.clearAllSelections() },
    deselectAgent: () => { selection.clearAgent() },
    closeTranscript: () => { setShowTranscript(false); setShowSessionDetail(false) },
    toggleMute: handleToggleMute,
    setSpeed,
    selectedAgentId: selection.selectedAgentId,
  }), [handlePlayPause, selection.clearAllSelections, selection.clearAgent, selection.selectedAgentId, setSpeed, handleToggleMute, toggleExclusivePanel, screensaver.toggle, sv])

  useKeyboardShortcuts(keyboardActions)

  const totalTokens = useMemo(() => {
    let sum = 0
    for (const a of agents.values()) sum += a.tokensUsed
    return sum
  }, [agents])

  const costsStatus = useCostsConfig()
  useLimitsFeed()
  const [showCostSettings, setShowCostSettings] = useState(false)
  const costUnit = useSyncExternalStore(subscribeOverlayUnit, overlayUnitVersion, overlayUnitVersion)
  // Top bar cost: split by billing kind (billed / list-equiv / estimated), in the unit in effect. Follows a config change.
  const costText = useMemo(() => {
    const items = Array.from(agents.values()).filter(a => a.tokensUsed > 0 || a.spend).map(a => ({ name: a.name, cost: agentCostOf(a), tokens: a.tokensUsed }))
    return buildTopBarCost(items, getOverlayUnit(), effectiveCosts())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, costsStatus.resolution, costUnit])
  const costSources = useMemo(() => describeSources(costsStatus.sources), [costsStatus.sources])
  // The plan limits are one meter for the whole account: the LIMITS panel reads the ledger of EVERY session, not only the open tab.
  const limitSessionIds = useMemo(
    () => (bridge.useMockData ? [] : fleetSessions(bridgeSessions, getDismissedSessions()).map(s => s.id)),
    [bridge.useMockData, bridgeSessions, getDismissedSessions],
  )
  const seenProviders = useMemo(() => {
    const out = new Set<string>()
    for (const a of agents.values()) if (a.spend?.provider) out.add(a.spend.provider)
    return Array.from(out)
  }, [agents])

  /** A panel that sits on the bottom stack is open: a small screen folds the LIMITS panel to its one line meanwhile. */
  const otherBottomPanelOpen = showFleet ? fleetTimelineVisible : showTimeline
  const selectedAgent = selection.selectedAgentId ? agents.get(selection.selectedAgentId) : null
  const selectedConversation = selection.selectedAgentId ? (conversations.get(selection.selectedAgentId) || []) : []

  // Session runtime — drives the assistant label (CLAUDE vs CODEX) in transcript panels
  const sessionRuntime = useMemo(() => {
    for (const a of agents.values()) {
      if (a.runtime === 'codex') return 'codex' as const
    }
    return 'claude' as const
  }, [agents])

  // Session-wide conversation (all agents merged chronologically)
  // Only compute when the transcript panel is visible to avoid O(n log n) sort every frame
  const sessionConversation = useMemo(() => {
    if (!showTranscript) return []
    const all = Array.from(conversations.values()).flat()
    return all.sort((a, b) => a.timestamp - b.timestamp)
  }, [conversations, showTranscript])

  // Context menu items
  const contextMenuItems = selection.contextMenu ? (
    selection.contextMenu.agentId ? [
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
    ] : [
      { label: '🔍  Zoom to Fit', onClick: () => setZoomToFitTrigger(n => n + 1) },
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
      { label: '⬡  Toggle Grid', onClick: () => setShowHexGrid(prev => !prev) },
      { label: '', onClick: () => {}, separator: true },
      { label: '⟲  Restart', onClick: restart },
    ]
  ) : []

  // Fleet tab row click: switch to that Hermes profile's session, then open its detail.
  // A fixture row (demo data) has no live session behind it, so it opens nothing.
  // The row id is a node id (`<session>::<node name>`) or a plain session id.
  // Only rows of sessions that still have a tab are clickable: a closed (dismissed) tab has
  // no live session to switch to, so its row stays plain text instead of a button that does nothing.
  const canOpenFleetSession = useCallback((instanceId: string) => {
    const { sessionId } = splitInstanceId(instanceId)
    return bridge.sessions.some(s => s.id === sessionId)
  }, [bridge.sessions])

  const handleFleetOpenSession = useCallback((instanceId: string) => {
    const { sessionId, agentName } = splitInstanceId(instanceId)
    // A live tab is switched to (as before). A closed tab has no live session, but its history is in
    // the fleet replay, which feeds the panel, so it still opens.
    if (canOpenFleetSession(instanceId) && bridge.selectedSessionId !== sessionId) bridge.selectSession(sessionId)
    openSessionDetail(agentName ?? null, showFleet && !bridge.useMockData ? sessionId : null)
  }, [bridge, canOpenFleetSession, openSessionDetail, showFleet])

  // What the session detail panel shows. Opened from the Fleet: the settled replay of that profile,
  // which keeps finished and idle nodes with their whole conversation. Otherwise the single view's state.
  const fleetDetail = useMemo(() => {
    if (!showFleet || !detailFleetSessionId || bridge.useMockData) return null
    const replay = fleetReplayRef.current as FleetReplay
    return replay.advance(detailFleetSessionId, getSessionEvents(detailFleetSessionId))
    // fleetTick: the event buffers are refs, so React does not see new events by itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFleet, detailFleetSessionId, bridge.useMockData, getSessionEvents, fleetTick])

  const currentSessionLabel = useMemo(
    () => bridge.sessions.find(s => s.id === bridge.selectedSessionId)?.label,
    [bridge.sessions, bridge.selectedSessionId],
  )
  const detailSessionLabel = useMemo(() => {
    if (!fleetDetail || !detailFleetSessionId) return currentSessionLabel
    return mapSessions.find(s => s.id === detailFleetSessionId)?.label ?? currentSessionLabel
  }, [fleetDetail, detailFleetSessionId, mapSessions, currentSessionLabel])

  const handleCloseSession = useCallback((id: string) => {
    bridge.removeSession(id)
    sessionCacheRef.current.delete(id)
    if (bridge.selectedSessionId === id) {
      const remaining = bridge.sessions.filter(s => s.id !== id)
      if (remaining.length > 0) {
        bridge.selectSession(remaining[remaining.length - 1].id)
      }
    }
  }, [bridge])

  const openFile = useCallback((filePath: string, line?: number) => {
    bridge.bridgeOpenFile(filePath, line)
  }, [bridge])

  const isEmpty = agents.size === 0 && !bridge.useMockData

  return (
    <OpenFileProvider value={bridge.isVSCode ? openFile : null}>
    <div className="h-screen w-screen relative overflow-hidden" style={{ background: COLORS.void }}>
      {/* Empty state when no demo and no live data */}
      {isEmpty && !sv && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center" style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
            <div className="text-sm" style={{ color: '#66ccff80' }}>WAITING FOR AGENT SESSION</div>
            <div className="mt-2 text-xs" style={{ color: '#66ccff40' }}>Start a Claude Code session to see activity</div>
          </div>
        </div>
      )}

      {/* Canvas fills everything */}
      <AgentCanvas
        simulationRef={singleAnchor.frameRef}
        selectedAgentId={selection.selectedAgentId}
        hoveredAgentId={selection.hoveredAgentId}
        showStats={showStats && !sv}
        showHexGrid={showHexGrid}
        zoomToFitTrigger={zoomToFitTrigger}
        pauseAutoFit={selection.contextMenu !== null}
        onAgentClick={selection.handleAgentClick}
        onAgentHover={selection.setHoveredAgentId}
        onAgentDrag={singleAnchor.onAgentDrag}
        onContextMenu={selection.handleContextMenu}
        onToolCallClick={selection.handleToolCallClick}
        selectedToolCallId={selection.selectedToolCallId}
        onDiscoveryClick={selection.handleDiscoveryClick}
        selectedDiscoveryId={selection.selectedDiscoveryId}
        showCostOverlay={showCostOverlay && !sv}
        screensaver={sv}
        controlsRef={singleCanvasControlsRef}
      />
      <SingleZoomControls controlsRef={singleCanvasControlsRef} visible={!sv && !showFleet} />

      {/* Message feed panel (top-left) */}
      {!sv && (
        <MessageFeedPanel
          conversations={conversations}
          agents={agents}
          onAgentClick={selection.handleAgentClick}
          selectedAgentId={selection.selectedAgentId}
        />
      )}

      {/* Agent detail card (floating, tethered to node) */}
      {!sv && selectedAgent && selection.selectedAgentWorldPos && (
        <div {...stopPropagationHandlers}>
          <AgentDetailCard
            agent={selectedAgent}
            onClose={selection.clearAgent}
          />
        </div>
      )}

      {/* Tool call detail popup */}
      {!sv && selection.selectedToolData && selection.selectedToolScreenPos && (
        <div {...stopPropagationHandlers}>
          <ToolDetailPopup
            tool={selection.selectedToolData}
            position={selection.selectedToolScreenPos}
            onClose={selection.clearTool}
          />
        </div>
      )}

      {/* Discovery detail popup */}
      {!sv && selection.selectedDiscoveryData && selection.selectedDiscoveryScreenPos && (
        <div {...stopPropagationHandlers}>
          <DiscoveryDetailPopup
            discovery={selection.selectedDiscoveryData}
            position={selection.selectedDiscoveryScreenPos}
            onClose={selection.clearDiscovery}
          />
        </div>
      )}

      {/* Chat panel (bottom-right, shown when agent selected) */}
      <AgentChatPanel
        visible={!!selectedAgent && !sv}
        agentName={selectedAgent?.name ?? ''}
        agentState={selectedAgent?.state ?? 'idle'}
        conversation={selectedConversation}
        runtime={selectedAgent?.runtime ?? sessionRuntime}
        onOpenDetail={() => openSessionDetail(selection.selectedAgentId)}
        onClose={selection.clearAgent}
      />

      {/* Context menu */}
      {!sv && selection.contextMenu && (
        <GlassContextMenu
          position={selection.contextMenu}
          items={contextMenuItems}
          onClose={() => selection.setContextMenu(null)}
        />
      )}

      {/* Floating control strip */}
      {!sv && <ControlBar
        isPlaying={isPlaying}
        speed={speed}
        currentTime={currentTime}
        totalDuration={bridge.useMockData
          ? (isReviewing ? Math.max(maxTimeReached, currentTime) : MOCK_DURATION)
          : Math.max(maxTimeReached, currentTime)
        }
        onPlayPause={handlePlayPause}
        onRestart={handleRestart}
        onSpeedChange={setSpeed}
        onSeek={(time) => {
          seekingRef.current = true
          pause()
          seekToTime(time)
          setZoomToFitTrigger(n => n + 1)
          if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; seekingRef.current = false }, TIMING.seekCompleteDelayMs)
        }}
        timelineEvents={timelineEvents}
        isReviewing={isReviewing}
        eventCount={timelineEvents.length}
        onEnterReview={handleEnterReview}
        onResumeLive={handleResumeLive}
      />}

      {/* File attention panel (slide-in from right) */}
      <FileAttentionPanel
        visible={showFileAttention && !sv}
        fileAttention={fileAttention}
        onClose={() => setShowFileAttention(false)}
        onOpenFile={bridge.isVSCode ? openFile : undefined}
      />

      {/* Session transcript panel (slide-in from right) */}
      <SessionTranscriptPanel
        visible={showTranscript && !sv}
        conversation={sessionConversation}
        runtime={sessionRuntime}
        onClose={() => setShowTranscript(false)}
      />

      {/* Session detail: whole conversation, tool calls (copyable), model and cost of one session */}
      <SessionDetailPanel
        visible={showSessionDetail && !sv}
        agents={fleetDetail ? fleetDetail.agents : agents}
        conversations={fleetDetail ? fleetDetail.conversations : conversations}
        agentId={detailAgentId}
        sessionLabel={detailSessionLabel}
        onSelectAgent={setDetailAgentId}
        onClose={() => setShowSessionDetail(false)}
      />

      {/* Timeline panel (slide-in from bottom) */}
      <TimelinePanel
        visible={showTimeline && !sv}
        timelineEntries={timelineEntries}
        currentTime={currentTime}
        onClose={() => setShowTimeline(false)}
      />

      {/* Fleet node map: all profiles + sessions, Kanban boards and Supermemory namespaces around them.
          Covers the single-session canvas while Fleet is on; independent of the open tab. */}
      <FleetMap
        visible={showFleet}
        sessions={mapSessions}
        eventsOf={mapEventsOf}
        tick={fleetTick}
        instances={fleetInstances}
        kanban={fleetKanban}
        supermemory={fleetMemory}
        selection={mapSelection}
        activityWindow={activityFilter.window}
        onActivityWindowChange={activityFilter.setWindow}
        hiddenSummary={activityFilter.summary}
        onOpenSession={bridge.useMockData ? undefined : handleFleetOpenSession}
        replay={fleetReplayRef.current}
        insetTop={48}
        insetBottom={mapInsetBottom(fleetTimelineVisible)}
        timelineVisible={fleetTimelineVisible}
        onToggleTimeline={toggleFleetTimeline}
        insetRight={detailInset(showSessionDetail, viewportWidth, CARD.sessionDetail.width)}
        screensaver={sv}
      />

      {/* Single view: the resource blocks (Kanban, memory, bash, subsystem) the open session used lately. */}
      <SingleBlocks session={openBlockSession} eventsOf={getSessionEvents} visible={!showFleet && !bridge.useMockData} />

      {/* Fleet timeline panel (grouped agents + Kanban/Supermemory lanes) */}
      <FleetTimelinePanel
        visible={showFleet && fleetTimelineVisible && !sv}
        instances={panelInstances}
        kanban={panelKanban}
        supermemory={panelMemory}
        selection={fleetSelection}
        onOpenSession={bridge.useMockData ? undefined : handleFleetOpenSession}
        canOpenSession={canOpenFleetSession}
        rightInset={detailInset(showSessionDetail, viewportWidth, CARD.sessionDetail.width)}
        onClose={() => setShowFleet(false)}
      />

      {/* Top bar: session tabs + info/controls */}
      {!sv && <TopBar
        sessions={visibleSessions}
        selectedSessionId={bridge.selectedSessionId}
        sessionsWithActivity={bridge.sessionsWithActivity}
        onSelectSession={bridge.selectSession}
        onCloseSession={handleCloseSession}
        isVSCode={bridge.isVSCode}
        connectionStatus={bridge.connectionStatus}
        agentCount={agents.size}
        totalTokens={totalTokens}
        costText={costText}
        projectOverride={costSources.projectOverrides}
        projectOverrideTitle={costSources.text}
        onOpenCostSettings={() => { setShowOptions(false); setShowCostSettings(true) }}
        showOptions={showOptions}
        onToggleOptions={() => { setShowCostSettings(false); setShowOptions(prev => !prev) }}
        showFileAttention={showFileAttention}
        showTranscript={showTranscript}
        showCostOverlay={showCostOverlay}
        showSessionDetail={showSessionDetail}
        showTimeline={showTimeline}
        showFleet={showFleet}
        anchorMode={anchorMode}
        onToggleAnchorMode={toggleAnchorMode}
        isMuted={isMuted}
        onTogglePanel={toggleExclusivePanel}
        onToggleTimeline={() => { setShowTimeline(prev => !prev); setShowFleet(false) }}
        onToggleFleet={() => { setShowFleet(prev => !prev); setShowTimeline(false) }}
        onToggleMute={handleToggleMute}
        onToggleScreensaver={screensaver.toggle}
      />}

      {/* Costs config error banner (invalid ~/.agent-flow/costs.json etc.) */}
      {!sv && <CostsConfigBanner status={costsStatus} />}

      {/* LIMITS panel: observed 5h / weekly, estimates with tags, and the Fable estimate when Fable was used this week */}
      {!sv && <LimitsPanelHost sessionIds={limitSessionIds} eventsOf={getSessionEvents} collapsed={limitsCollapsed} onCollapsedChange={setLimitsCollapsed} otherBottomPanelOpen={otherBottomPanelOpen} />}

      {/* Options panel: linger/fade/show per resource kind, sound, timeline, cost unit, hidden fleet agents (browser only, no server config) */}
      {showOptions && <OptionsPanel selection={fleetSelection} profiles={[...new Set(fleetInstances.map(i => i.identity))].sort()} onClose={() => setShowOptions(false)} />}

      {/* Cost settings drawer: prices per provider/model, currency and FX (writes the user costs.json) */}
      {!sv && showCostSettings && (
        <CostsSettingsDrawer
          key={costsStatus.resolution.seq === 0 ? 'initial' : 'open'}
          status={costsStatus}
          seenProviders={seenProviders}
          onClose={() => setShowCostSettings(false)}
        />
      )}
    </div>
    </OpenFileProvider>
  )
}

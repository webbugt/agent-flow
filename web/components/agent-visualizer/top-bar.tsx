"use client"

import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { Z } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { formatTokens } from "@/lib/utils"
import { effectiveCosts } from "@/lib/costs/active"
import { costToggleLabel, unitName } from "@/lib/costs/overlay"
import { cycleOverlayUnit, getOverlayUnit, overlayUnitVersion, subscribeOverlayUnit } from "@/lib/cost-overlay-store"
import { useActiveCostsVersion } from "@/hooks/use-costs-config"
import { LimitsChip } from "./claude-limits"
import { useViewportWidth } from "@/hooks/use-viewport-width"
import { SessionTabs } from "./session-tabs"
import type { SessionInfo, ConnectionStatus } from "@/lib/bridge-types"
import { dataFreshness } from "@/lib/data-freshness"

// ─── Mute/Unmute SVG Icons ───────────────────────────────────────────────────

function MutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  )
}

function UnmutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ active, onClick, children, style, activeColor, testId }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  style?: React.CSSProperties
  activeColor?: { bg: string; text: string }
  testId?: string
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="af-tap af-tap-fine af-focus px-1.5 py-0.5 rounded transition-all"
      aria-pressed={active}
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : COLORS.toggleInactive,
        border: `1px solid ${COLORS.toggleBorder}`,
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// ─── Connection Status Indicator ────────────────────────────────────────────

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const color = status === 'watching' ? COLORS.complete
    : status === 'connected' ? COLORS.idle : COLORS.error
  const label = status === 'watching' ? 'LIVE'
    : status === 'connected' ? 'CONNECTED' : 'OFFLINE'

  return (
    <span className="flex items-center gap-1.5">
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      />
      {label}
    </span>
  )
}

// ─── Data freshness (browser build) ─────────────────────────────────────────

const AMBER = "#ffcc66"

/**
 * LIVE / STALE / OFFLINE plus "last event Ns ago" for the browser build, which has no editor status bar to show it.
 * The counts next to it say nothing about whether data still arrives: a relay that went quiet looked like a calm session.
 * It ticks once a second on its own, so the rest of the bar does not re-render.
 */
function FreshnessIndicator({ status, lastEventAt, connectedAt, narrow }: {
  status: ConnectionStatus; lastEventAt: number | null; connectedAt: number | null; narrow: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const f = dataFreshness({ now, connected: status !== "disconnected", lastEventAt, connectedAt })
  const color = f.level === "live" ? COLORS.complete : f.level === "stale" ? AMBER : COLORS.error
  const text = f.level === "live" && narrow ? f.label : `${f.label} \u00b7 ${f.detail}`
  return (
    <span
      data-testid="data-freshness"
      data-level={f.level}
      role="status"
      title={f.detail}
      className="flex items-center gap-1.5"
      style={{ color: f.level === "live" ? undefined : color }}
    >
      <span
        aria-hidden
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      />
      {f.level === "stale" && <span aria-hidden>{"\u26a0"}</span>}
      {text}
    </span>
  )
}

// ─── Top Bar ────────────────────────────────────────────────────────────────

export interface TopBarProps {
  // Session tabs
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  // Connection
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Browser build with a live stream (not VS Code, not the demo): show how fresh the data is. */
  showFreshness?: boolean
  /** Arrival time of the last live event (ms), null before the first. */
  lastEventAt?: number | null
  /** When the event stream connected (ms), null if it never did. */
  connectedAt?: number | null
  // Stats
  agentCount: number
  totalTokens: number
  /** Cost totals split by billing kind, in the unit in effect (`buildTopBarCost`); '' = nothing to show. */
  costText: string
  /** A project .agent-flow/costs.json is in use on top of the user file. */
  projectOverride: boolean
  projectOverrideTitle: string
  onOpenCostSettings: () => void
  showOptions: boolean
  onToggleOptions: () => void
  // Panel toggles
  showFileAttention: boolean
  showTranscript: boolean
  showCostOverlay: boolean
  showSessionDetail: boolean
  showTimeline: boolean
  showFleet: boolean
  /** Resource-anchor mode (options.anchorMode) and its toggle; works in the single and the fleet view. */
  anchorMode: boolean
  onToggleAnchorMode: () => void
  isMuted: boolean
  onTogglePanel: (panel: 'files' | 'transcript' | 'cost' | 'session') => void
  onToggleTimeline: () => void
  onToggleFleet: () => void
  onToggleMute: () => void
  /** Screensaver mode: hide all UI (key `s`). Any key or click brings it back. */
  onToggleScreensaver: () => void
}

export const TopBar = memo(function TopBar({
  sessions, selectedSessionId, sessionsWithActivity,
  onSelectSession, onCloseSession,
  isVSCode, connectionStatus, showFreshness = false, lastEventAt = null, connectedAt = null,
  agentCount, totalTokens, costText, projectOverride, projectOverrideTitle, onOpenCostSettings, showOptions, onToggleOptions,
  showFileAttention, showTranscript, showCostOverlay, showSessionDetail, showTimeline, showFleet, anchorMode, isMuted,
  onTogglePanel, onToggleTimeline, onToggleFleet, onToggleAnchorMode, onToggleMute, onToggleScreensaver,
}: TopBarProps) {
  // Re-render when the unit toggle or the loaded config (currency symbol) changes
  useSyncExternalStore(subscribeOverlayUnit, overlayUnitVersion, overlayUnitVersion)
  useActiveCostsVersion()
  const cfg = effectiveCosts()
  const unit = getOverlayUnit()
  const narrow = useViewportWidth(1280) < 640
  // Publish the bar's bottom edge so panels below it (message card) never sit under a wrapped bar
  const barRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const publish = () => document.documentElement.style.setProperty('--af-top-bar-bottom', `${Math.ceil(el.getBoundingClientRect().bottom)}px`)
    publish()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    // flex-wrap: on a narrow screen (phone, 390px) the controls drop to a second row instead
    // of running off the right edge, so Timeline / Fleet / mute stay reachable.
    <div
      data-testid="top-bar"
      ref={barRef}
      className="absolute top-3 left-3 right-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px]"
      style={{ zIndex: Z.info }}
    >
      {/* Session tabs — scrollable, never wider than the bar */}
      {sessions.length > 1 && (
        <div className="min-w-0 max-w-full flex-shrink overflow-x-auto scrollbar-hide">
          <SessionTabs
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionsWithActivity={sessionsWithActivity}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        </div>
      )}

      {/* Right-side info/controls: ml-auto pushes them right; they wrap when the bar is narrow */}
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1.5 sm:gap-x-4" style={{ color: COLORS.textMuted }}>
        {isVSCode && <ConnectionIndicator status={connectionStatus} />}
        {!isVSCode && showFreshness && <FreshnessIndicator status={connectionStatus} lastEventAt={lastEventAt} connectedAt={connectedAt} narrow={narrow} />}
        <span>{agentCount} agents</span>
        <span>
          {formatTokens(totalTokens)} tokens
          {costText && (
            <span data-testid="top-bar-cost" style={{ color: COLORS.complete + 'a5', marginLeft: 4 }}>{costText}</span>
          )}
        </span>

        {/* Mutually exclusive panel group. It wraps (and may not exceed the bar) so a wide limits chip drops to a second
            line instead of pushing Files / Chat off the left edge at phone width. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1 px-1 py-0.5 rounded" style={{
          background: COLORS.holoBg03,
          border: `1px solid ${COLORS.holoBorder06}`,
        }}>
          <ToggleButton active={showFileAttention} onClick={() => onTogglePanel('files')} style={{ background: showFileAttention ? undefined : 'transparent', border: 'none' }}>Files</ToggleButton>
          <ToggleButton active={showTranscript} onClick={() => onTogglePanel('transcript')} style={{ background: showTranscript ? undefined : 'transparent', border: 'none' }}>Chat</ToggleButton>
          <ToggleButton active={showSessionDetail} onClick={() => onTogglePanel('session')} style={{ background: showSessionDetail ? undefined : 'transparent', border: 'none' }}>Session</ToggleButton>
          <ToggleButton
            active={showCostOverlay}
            onClick={() => onTogglePanel('cost')}
            activeColor={{ bg: COLORS.costActiveBg, text: COLORS.complete }}
            style={{ background: showCostOverlay ? undefined : 'transparent', border: 'none' }}
            testId="cost-toggle"
          >
            {costToggleLabel(unit, cfg)}
          </ToggleButton>
          {showCostOverlay && (
            <>
              <ToggleButton
                active={false}
                onClick={cycleOverlayUnit}
                style={{ background: 'transparent', border: 'none', color: COLORS.complete, whiteSpace: 'nowrap' }}
                testId="cost-unit-toggle"
              >
                <span title="Switch the cost unit: money, kWh, tokens">{narrow ? unitName(unit) : `unit: ${unitName(unit)}`}</span>
              </ToggleButton>
              <ToggleButton active={false} onClick={onOpenCostSettings} style={{ background: 'transparent', border: 'none', whiteSpace: 'nowrap' }} testId="cost-settings-open">
                <span title="Cost settings: prices, currency, exchange rate" aria-label="Cost settings">{narrow ? '⚙' : '⚙ prices'}</span>
              </ToggleButton>
              <LimitsChip onOpen={onOpenCostSettings} />
              {projectOverride && (
                <span data-testid="cost-project-badge" title={projectOverrideTitle} style={{ color: '#ffcc66', border: '1px solid #ffcc6666', borderRadius: 4, padding: '0 4px', fontSize: 11 }}>
                  project
                </span>
              )}
            </>
          )}
        </div>

        {/* Independent toggles */}
        <ToggleButton active={showTimeline} onClick={onToggleTimeline}>Timeline</ToggleButton>
        <ToggleButton active={showFleet} onClick={onToggleFleet} testId="fleet-toggle">Fleet</ToggleButton>
        <ToggleButton active={anchorMode} onClick={onToggleAnchorMode} testId="anchor-toggle">
          <span title="Resource-anchor mode: resources are the anchors, sessions drift to the resource they use (no profile halo)" aria-label="Resource-anchor mode">Anchors</span>
        </ToggleButton>
        {/* The bar is only shown while the screensaver is off, so this button only ever turns it on. */}
        <ToggleButton active={false} onClick={onToggleScreensaver} testId="screensaver-toggle">
          <span title="Hide all UI (S). Any key or click brings it back." aria-label="Screensaver">Screensaver</span>
        </ToggleButton>
        <ToggleButton active={!isMuted} onClick={onToggleMute} style={{ border: `1px solid ${COLORS.toggleBorder}` }}>
          {isMuted ? <MutedIcon /> : <UnmutedIcon />}
        </ToggleButton>
        <ToggleButton active={showOptions} onClick={onToggleOptions} testId="options-toggle">
          <span title="Options: resource block linger and fade, sound, timeline, cost unit, hidden agents" aria-label="Options">⚙ Options</span>
        </ToggleButton>
      </div>
    </div>
  )
})

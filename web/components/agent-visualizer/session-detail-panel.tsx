'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CARD, Z, type Agent } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatModelName, formatTokens } from '@/lib/utils'
import { agentSpend } from './canvas/draw-cost'
import { formatDisplayMoney } from '@/lib/costs/active'
import { useActiveCostsVersion } from '@/hooks/use-costs-config'
import { TranscriptMessage } from './transcript-message'
import { ToolCallDetail } from './tool-call-detail'
import { CloseButton, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { BELOW_TOP_BAR } from '@/lib/bottom-stack'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useViewportWidth } from '@/hooks/use-viewport-width'
import type { ConversationMessage } from '@/hooks/simulation/types'
import {
  buildSessionItems, pickDefaultAgentId, sessionDetailWidth, formatClock, formatOrigin,
  type SessionItem,
} from '@/lib/session-detail'

type ToolItem = Extract<SessionItem, { kind: 'tool' }>

interface SessionDetailPanelProps {
  visible: boolean
  agents: ReadonlyMap<string, Agent>
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>
  /** Requested session node; falls back to the most recently active one when absent or gone */
  agentId: string | null
  /** Name of the visualizer session (the profile), used as the assistant label */
  sessionLabel?: string
  onSelectAgent: (agentId: string) => void
  onClose: () => void
}

// ─── Small pieces ───────────────────────────────────────────────────────────

function Stat({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <div className="flex flex-col min-w-0" title={title}>
      <span className="text-[8px] tracking-widest" style={{ color: COLORS.panelLabelDim }}>{label}</span>
      <span className="text-[10px] truncate" style={{ color: color ?? COLORS.textPrimary }}>{value}</span>
    </div>
  )
}

function itemMatches(item: SessionItem, q: string): boolean {
  if (item.kind === 'message') return item.message.content.toLowerCase().includes(q)
  return (
    item.toolName.toLowerCase().includes(q)
    || (item.call?.args ?? item.call?.content ?? '').toLowerCase().includes(q)
    || (item.result?.result ?? item.result?.content ?? '').toLowerCase().includes(q)
  )
}

/** One tool call: a one-line summary that opens into the whole command/edit and result. */
function ToolRow({ item, open, onToggle }: { item: ToolItem; open: boolean; onToggle: () => void }) {
  const state: 'running' | 'complete' | 'error' = !item.result ? 'running' : item.result.isError ? 'error' : 'complete'
  const color = state === 'error' ? COLORS.error : state === 'running' ? COLORS.tool_calling : COLORS.complete
  const args = item.call?.args ?? (item.call?.content ?? '').replace(/^> \S+ ?/, '')
  const summary = args.replace(/\s+/g, ' ').trim()
  const result = item.result?.result ?? (item.result?.content ?? '').replace(/^< /, '')
  const at = item.call?.at ?? item.result?.at

  return (
    <div
      className="rounded"
      data-testid="tool-row"
      data-state={state}
      style={{ background: COLORS.toolCallBg, border: `1px solid ${state === 'error' ? 'rgba(255, 85, 102, 0.3)' : COLORS.toolCallBorder}` }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        <span className="text-[9px]" style={{ color }}>{state === 'running' ? '⚙' : state === 'error' ? '✕' : '✓'}</span>
        <span className="text-[9px] font-mono font-semibold flex-shrink-0" style={{ color: COLORS.tool_calling }}>{item.toolName}</span>
        <span className="text-[9px] font-mono truncate flex-1 min-w-0" style={{ color: COLORS.textDim }}>{summary}</span>
        {at !== undefined && <span className="text-[8px] font-mono flex-shrink-0" style={{ color: COLORS.textMuted }}>{formatClock(at)}</span>}
        <span className="text-[9px] flex-shrink-0" style={{ color: COLORS.textMuted }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2">
          <ToolCallDetail
            toolName={item.toolName}
            state={state}
            args={args}
            inputData={item.call?.inputData}
            result={item.result ? result : undefined}
            at={at}
            resultMaxHeight={320}
          />
        </div>
      )}
    </div>
  )
}

// ─── Panel ──────────────────────────────────────────────────────────────────

/**
 * Detail of ONE Hermes session (one node): its whole conversation, scrollable,
 * with who wrote each message and on which platform, every tool call with its
 * full arguments and result (copyable), and the model and cost of the session.
 *
 * Opened from the Fleet tab, the agent card and the agent's chat panel. It
 * reuses the transcript look (TranscriptMessage, the sliding side panel) and
 * the canvas's own state, so what it shows is what the canvas is animating.
 */
export function SessionDetailPanel({ visible, agents, conversations, agentId, sessionLabel, onSelectAgent, onClose }: SessionDetailPanelProps) {
  const viewportWidth = useViewportWidth(CARD.sessionDetail.width)
  useActiveCostsVersion() // re-render when the costs config changes (money is formatted below)
  const [query, setQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [openAll, setOpenAll] = useState(false)
  // Tool rows whose state differs from `openAll`
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)

  const resolvedId = useMemo(() => {
    if (agentId && agents.has(agentId)) return agentId
    return pickDefaultAgentId(agents, conversations)
  }, [agentId, agents, conversations])
  const agent = resolvedId ? agents.get(resolvedId) : undefined
  const conversation = useMemo(() => (resolvedId ? conversations.get(resolvedId) ?? [] : []), [resolvedId, conversations])
  const items = useMemo(() => (visible ? buildSessionItems(conversation) : []), [visible, conversation])
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => (q ? items.filter(i => itemMatches(i, q)) : items), [items, q])

  const { ref: scrollRef, handleScroll, scrollToBottom, isAutoScrolling } = useAutoScroll(shown.length, visible)
  const [pinned, setPinned] = useState(true)

  // A different session starts at its newest message, with its own tool rows closed
  useEffect(() => {
    setToggled(new Set())
    setQuery('')
    scrollToBottom()
  }, [resolvedId, scrollToBottom])
  useEffect(() => { if (showSearch) searchRef.current?.focus() }, [showSearch])

  if (!visible) return null

  const spend = agent ? agentSpend(agent) : undefined
  const stateColor = agent ? getStateColor(agent.state) : COLORS.textMuted
  const lastUser = [...conversation].reverse().find(m => m.type === 'user' && (m.sender || m.platform))
  const origin = formatOrigin(lastUser?.sender, lastUser?.platform)

  // Profile total: every session node of this visualizer session
  let profileUsd = 0
  let profileNodes = 0
  for (const a of agents.values()) {
    if (a.isMain) continue
    profileUsd += agentSpend(a).amount
    profileNodes++
  }
  const profileEstimate = [...agents.values()].some(a => !a.isMain && agentSpend(a).estimate)

  const isOpen = (id: string) => openAll !== toggled.has(id)
  const toggle = (id: string) => setToggled(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const assistantLabel = (sessionLabel ?? 'ASSISTANT').toUpperCase()
  const agentOptions = [...agents.values()].filter(a => (conversations.get(a.id)?.length ?? 0) > 0 || a.id === resolvedId)

  return (
    <SlidingPanel
      visible={visible}
      // Starts below the top bar and its tab rows (they publish where they end), so the tabs and the Chat / Session
      // buttons stay tappable and a second tap on the same tab closes the sheet.
      position={{ right: 0, bottom: 0, top: BELOW_TOP_BAR }}
      zIndex={Z.transcriptPanel + 5}
      width={sessionDetailWidth(viewportWidth, CARD.sessionDetail.width)}
      {...stopPropagationHandlers}
    >
      <div
        className="h-full flex flex-col"
        data-testid="session-detail-panel"
        style={{ background: COLORS.panelBg, backdropFilter: 'blur(24px)', borderLeft: `1px solid ${COLORS.holoBorder10}` }}
      >
        {/* Header: title, picker, close */}
        <div className="px-4 pt-2.5 pb-2 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder08}` }}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <div className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{ background: stateColor, boxShadow: `0 0 8px ${stateColor}` }} />
              <div className="min-w-0">
                <div className="text-[9px] font-mono tracking-widest font-semibold" style={{ color: COLORS.panelLabel }}>
                  SESSION{sessionLabel ? <span className="ml-1.5 font-normal opacity-70">{sessionLabel}</span> : null}
                </div>
                <div className="text-xs font-mono break-words max-h-16 overflow-y-auto" style={{ color: COLORS.textPrimary }} data-testid="session-title">
                  {agent ? agent.name : 'No session selected'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => setOpenAll(o => { setToggled(new Set()); return !o })}
                className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{ border: `1px solid ${COLORS.holoBorder12}`, color: openAll ? COLORS.assistantText : COLORS.textDim, background: openAll ? COLORS.toggleActive : 'transparent' }}
                title="Open or close the arguments and result of every tool call"
              >
                {openAll ? 'close tools' : 'open tools'}
              </button>
              <button
                type="button"
                onClick={() => { setShowSearch(s => !s); if (showSearch) setQuery('') }}
                className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: showSearch ? COLORS.toggleActive : 'transparent', color: showSearch ? COLORS.assistantText : COLORS.textMuted }}
                title="Filter messages and tool calls"
              >
                /
              </button>
              <CloseButton onClick={onClose} className="px-1" />
            </div>
          </div>

          {agentOptions.length > 1 && (
            <select
              value={resolvedId ?? ''}
              onChange={(e) => onSelectAgent(e.target.value)}
              aria-label="Session"
              className="mt-1.5 w-full text-[10px] font-mono rounded px-1.5 py-1 outline-none"
              style={{ background: COLORS.holoBg05, border: `1px solid ${COLORS.holoBorder12}`, color: COLORS.assistantText }}
            >
              {agentOptions.map(a => (
                <option key={a.id} value={a.id} style={{ background: '#0a0e1a' }}>
                  {a.isMain ? '● ' : ''}{a.name.length > 70 ? `${a.name.slice(0, 70)}…` : a.name}
                </option>
              ))}
            </select>
          )}

          {agent && (
            <div className="mt-2 grid grid-cols-4 gap-x-3 gap-y-1.5 font-mono" data-testid="session-stats">
              <Stat label="MODEL" value={agent.model ? formatModelName(agent.model) : 'unknown'} title={agent.model} color={agent.model ? undefined : COLORS.textMuted} />
              <Stat
                label={spend?.estimate ? 'COST (EST.)' : 'COST'}
                value={spend ? formatDisplayMoney(spend.amount, spend.estimate) : '—'}
                title={spend?.estimate ? 'Estimate from context size: this session has no billed usage yet' : 'From the billed token usage of this session'}
              />
              <Stat label="CONTEXT" value={`${formatTokens(agent.tokensUsed)} / ${formatTokens(agent.tokensMax)}`} />
              <Stat label="STATE" value={agent.state} color={stateColor} />
              <Stat label="TOOLS" value={String(agent.toolCalls)} />
              <Stat
                label="TOKENS IN/OUT"
                value={agent.spend ? `${formatTokens(agent.spend.inputTokens + agent.spend.cacheReadTokens + agent.spend.cacheWrite5mTokens + agent.spend.cacheWrite1hTokens)} / ${formatTokens(agent.spend.outputTokens)}` : '—'}
                title="Billed input (with cache) and output tokens"
              />
              <Stat label="FROM" value={origin || '—'} title="Sender and platform of the latest user message" />
              <Stat label="PROFILE TOTAL" value={profileNodes > 0 ? `${formatDisplayMoney(profileUsd, profileEstimate)} · ${profileNodes}` : '—'} title="All sessions of this profile in view" />
            </div>
          )}
        </div>

        {showSearch && (
          <div className="px-3 py-1.5 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setShowSearch(false); setQuery('') }
                e.stopPropagation()
              }}
              placeholder="Filter messages, commands, results..."
              className="w-full px-2 py-1 rounded text-[10px] font-mono outline-none"
              style={{ background: COLORS.holoBg05, border: `1px solid ${COLORS.holoBorder12}`, color: COLORS.assistantText }}
            />
          </div>
        )}

        {/* Whole conversation, scrollable */}
        <div
          ref={scrollRef}
          onScroll={() => { handleScroll(); setPinned(isAutoScrolling.current) }}
          className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
          data-testid="session-conversation"
          style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
        >
          {!agent ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-[10px] font-mono" style={{ color: COLORS.textMuted }}>No Hermes session yet. Waiting for activity...</p>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-[10px] font-mono" style={{ color: COLORS.textMuted }}>
                {q ? 'No matching messages' : 'This session has no messages yet...'}
              </p>
            </div>
          ) : (
            shown.map(item => item.kind === 'message'
              ? <TranscriptMessage key={item.id} message={item.message} searchQuery={q} assistantLabel={assistantLabel} />
              : <ToolRow key={item.id} item={item} open={isOpen(item.id)} onToggle={() => toggle(item.id)} />)
          )}
        </div>

        {/* Footer: count + jump to newest */}
        <div className="flex items-center justify-between px-3 py-1 flex-shrink-0" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
          <span className="text-[9px] font-mono" style={{ color: COLORS.panelLabelDim }}>
            {q ? `${shown.length}/${items.length}` : items.length} items · {conversation.length} messages
          </span>
          {!pinned && shown.length > 0 && (
            <button
              type="button"
              onClick={() => { scrollToBottom(); setPinned(true) }}
              className="text-[9px] font-mono px-3 py-0.5 rounded-full"
              style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.glassBorder}`, color: COLORS.scrollBtnText }}
            >
              ↓ newest
            </button>
          )}
        </div>
      </div>
    </SlidingPanel>
  )
}

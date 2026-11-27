'use client'

import { useEffect, useRef, useCallback } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
}

export function SessionTabs({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
}: SessionTabsProps) {
  // The refs point at the CHIP (tab + close), not at the tab button: scrolling the button alone leaves the close, which
  // sits right of it, outside the scroll area on a 390 px phone.
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const setChipRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) chipRefs.current.set(id, el)
    else chipRefs.current.delete(id)
  }, [])

  // Scroll the selected chip (its close included) into view whenever it changes
  useEffect(() => {
    if (!selectedSessionId) return
    const el = chipRefs.current.get(selectedSessionId)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedSessionId])

  return (
    <div className="flex gap-1" role="group" aria-label="Sessions">
      {sessions.map(session => {
        const isSelected = session.id === selectedSessionId
        const isActive = session.status === 'active'
        const hasActivity = sessionsWithActivity.has(session.id)
        // Green dot: session is active, OR has unseen background activity
        const showGreen = isActive || hasActivity
        // The chip is a wrapper around TWO buttons (a button inside a button is invalid and the inner one is not
        // reachable by keyboard): the tab selects the session, the close button closes it.
        return (
          <div
            key={session.id}
            ref={(el) => setChipRef(session.id, el)}
            className="af-chip rounded transition-all flex items-center"
            data-testid="session-chip"
            data-selected={isSelected ? 'true' : 'false'}
            style={{
              flexShrink: 0,
              whiteSpace: 'nowrap',
              background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
              border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
              color: isSelected ? COLORS.holoBright : COLORS.textMuted,
            }}
          >
            <button
              type="button"
              aria-current={isSelected ? "true" : undefined}
              onClick={() => onSelectSession(session.id)}
              className="af-tap af-focus pl-1.5 py-0.5 flex items-center gap-1 rounded"
              style={{ color: 'inherit' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                aria-hidden
                style={{
                  background: showGreen ? COLORS.complete : COLORS.idle + '40',
                  boxShadow: showGreen ? `0 0 4px ${COLORS.complete}` : 'none',
                  animation: hasActivity && !isSelected ? 'pulse 1.5s infinite' : 'none',
                }}
              />
              {session.label}
            </button>
            <button
              type="button"
              data-testid="session-chip-close"
              aria-label={`Close session ${session.label}`}
              title={`Close session ${session.label}`}
              onClick={() => onCloseSession(session.id)}
              // 24 px wide and as tall as the chip: the whole padded area is the button, not a 6 px glyph.
              className="af-chip-close af-focus af-tap af-tap-fine flex items-center justify-center rounded self-stretch"
              style={{ color: COLORS.tabClose, minWidth: 24, fontSize: 11, lineHeight: '14px' }}
            >
              <span aria-hidden>✕</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

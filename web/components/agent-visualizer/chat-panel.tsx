'use client'

import { CARD, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { PanelHeader, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { STACK_BOTTOM, STACK_PANEL_MAX_HEIGHT } from '@/lib/bottom-stack'
import { useAutoScroll } from '@/hooks/use-auto-scroll'

interface ChatPanelProps {
  visible: boolean
  agentName: string
  agentState: AgentState
  conversation: ConversationMessage[]
  runtime?: 'claude' | 'codex'
  /** Open the whole session (every message, tool call, model and cost) in the session detail */
  onOpenDetail?: () => void
  onClose: () => void
}

export function AgentChatPanel({
  visible,
  agentName,
  agentState,
  conversation,
  runtime,
  onOpenDetail,
  onClose,
}: ChatPanelProps) {
  const { ref: logRef } = useAutoScroll(conversation.length, visible)

  const stateColor = getStateColor(agentState)

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: STACK_BOTTOM, right: 12 }}
      zIndex={Z.chatPanel}
      width={`min(${CARD.chat.width}px, calc(100vw - 24px))`}
      {...stopPropagationHandlers}
    >
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', maxHeight: `min(${CARD.chat.maxHeight}px, ${STACK_PANEL_MAX_HEIGHT})` }}>
        <PanelHeader
          onClose={onClose}
          className="mb-2 flex-shrink-0"
          actions={onOpenDetail ? (
            <button
              type="button"
              onClick={onOpenDetail}
              className="mr-2 text-[11px] font-mono px-1.5 py-0.5 rounded"
              style={{ border: `1px solid ${COLORS.holoBorder12}`, color: COLORS.textPrimary }}
              title="Whole conversation, tool calls, model and cost"
              data-testid="open-session-detail"
            >
              details ↗
            </button>
          ) : undefined}
        >
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}` }}
          />
          <span className="text-[11px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            {agentName.toUpperCase()}
          </span>
          <span className="text-[11px] font-mono capitalize" style={{ color: stateColor + '90' }}>
            {agentState}
          </span>
        </PanelHeader>

        {/* Messages */}
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto space-y-1.5 mb-2"
          style={{ minHeight: CARD.chat.messagesMinHeight, maxHeight: CARD.chat.messagesMaxHeight }}
        >
          {conversation.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
                No messages yet...
              </p>
            </div>
          ) : (
            conversation.map((msg) => (
              <TranscriptMessage key={msg.id} message={msg} assistantLabel={runtime === 'codex' ? 'CODEX' : 'CLAUDE'} />
            ))
          )}
        </div>

      </div>
    </SlidingPanel>
  )
}

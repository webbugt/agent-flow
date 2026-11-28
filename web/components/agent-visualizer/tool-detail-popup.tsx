'use client'

import { POPUP } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { ToolCallDetail } from './tool-call-detail'
import { PanelHeader, DetailPopup } from './shared-ui'

interface ToolDetailPopupProps {
  tool: {
    id: string
    toolName: string
    state: 'running' | 'complete' | 'error'
    args: string
    result?: string
    tokenCost?: number
    inputData?: Record<string, unknown>
  }
  position: { x: number; y: number }
  onClose: () => void
}

export function ToolDetailPopup({ tool, position, onClose }: ToolDetailPopupProps) {
  const stateColor = tool.state === 'error' ? COLORS.error : tool.state === 'running' ? COLORS.tool_calling : COLORS.complete

  return (
    <DetailPopup position={position} width={POPUP.tool.width} estimatedHeight={POPUP.tool.estimatedHeight} onClose={onClose}>
      <PanelHeader onClose={onClose}>
        <span className="text-[11px]" style={{ color: stateColor }}>
          {tool.state === 'running' ? '⚙' : tool.state === 'error' ? '✕' : '✓'}
        </span>
        <span className="text-[11px] font-mono font-semibold" style={{ color: COLORS.tool_calling }}>
          {tool.toolName}
        </span>
        <span className="text-[11px] font-mono capitalize" style={{ color: stateColor + '90' }}>
          {tool.state}
        </span>
      </PanelHeader>

      {/* Arguments and result in full, each with a copy button; long text scrolls inside the popup */}
      <div className="overflow-y-auto pr-0.5" style={{ maxHeight: POPUP.tool.maxHeight }}>
        <ToolCallDetail
          toolName={tool.toolName}
          state={tool.state}
          args={tool.args}
          inputData={tool.inputData}
          result={tool.result}
          tokenCost={tool.tokenCost}
        />
      </div>
    </DetailPopup>
  )
}

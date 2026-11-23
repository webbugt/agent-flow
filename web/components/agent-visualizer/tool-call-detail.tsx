'use client'

import { useState } from 'react'
import { COLORS } from '@/lib/colors'
import { ToolContentRenderer } from './tool-content-renderer'
import { CopyButton } from './copy-button'
import { hasRichInput, toolCopyAll, toolCopyText, toolInputJson, formatClock } from '@/lib/session-detail'

export interface ToolCallDetailProps {
  toolName: string
  state: 'running' | 'complete' | 'error'
  /** One-line summary of the arguments, as the data source gave it */
  args: string
  /** Structured arguments (command, old/new text, path ...), when the source has them */
  inputData?: Record<string, unknown>
  /** Result text, whole. Undefined while the call is running. */
  result?: string
  tokenCost?: number
  /** Epoch ms of the call, when known */
  at?: number
  /** Max height of the result box before it scrolls */
  resultMaxHeight?: number
}

const SECTION_LABEL = 'text-[8px] font-mono tracking-widest font-semibold'

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

/**
 * Full detail of one tool call: the arguments (the whole bash command, the
 * old/new text of an edit, the content of a write ...) and the whole result,
 * each with a copy button. Used by the canvas popup and by the session detail.
 *
 * An empty section says so instead of drawing an empty box: empty values mean
 * the data source did not pass them through.
 */
export function ToolCallDetail({ toolName, state, args, inputData, result, tokenCost, at, resultMaxHeight = 224 }: ToolCallDetailProps) {
  const [showRaw, setShowRaw] = useState(false)
  const rich = hasRichInput(toolName, inputData)
  const json = toolInputJson(inputData)
  const argsText = rich ? '' : (args.trim() ? args : json)
  const noArgs = !rich && argsText === ''
  const copyArgs = toolCopyText(toolName, inputData, args)
  const stateColor = state === 'error' ? COLORS.error : state === 'running' ? COLORS.tool_calling : COLORS.complete
  const resultText = result ?? ''
  const clock = formatClock(at)

  const argsLabel = toolName === 'Bash' ? 'Copy command' : toolName === 'Edit' ? 'Copy diff' : toolName === 'Write' ? 'Copy content' : 'Copy args'

  return (
    <div data-testid="tool-call-detail" className="font-mono">
      {/* Arguments */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className={SECTION_LABEL} style={{ color: COLORS.panelLabel }}>
          ARGUMENTS{clock ? <span className="ml-1.5 opacity-60 font-normal tracking-normal">{clock}</span> : null}
        </span>
        <span className="flex items-center gap-1">
          {json && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowRaw(r => !r) }}
              className="text-[9px] px-1.5 py-px rounded"
              style={{ border: `1px solid ${COLORS.holoBorder12}`, color: showRaw ? COLORS.assistantText : COLORS.textDim, background: showRaw ? COLORS.toggleActive : 'transparent' }}
              title="Show the arguments as JSON"
            >
              json
            </button>
          )}
          <CopyButton text={copyArgs} label={argsLabel} disabled={copyArgs === ''} />
        </span>
      </div>

      {showRaw && json ? (
        <pre
          className="rounded px-1.5 py-1 text-[9px] whitespace-pre-wrap break-all overflow-y-auto"
          style={{ background: COLORS.codeBlockBg, color: COLORS.assistantText, maxHeight: 240, margin: 0 }}
        >
          {json}
        </pre>
      ) : rich ? (
        <ToolContentRenderer toolName={toolName} inputData={inputData} args={args} compact={false} />
      ) : noArgs ? (
        <div className="text-[9px] italic" style={{ color: COLORS.textMuted }}>
          No arguments recorded: the data source did not pass them through.
        </div>
      ) : (
        <pre
          className="rounded px-1.5 py-1 text-[9px] whitespace-pre-wrap break-all overflow-y-auto"
          style={{ background: COLORS.codeBlockBg, color: COLORS.assistantText, maxHeight: 240, margin: 0 }}
        >
          {argsText}
        </pre>
      )}

      {/* Result */}
      <div className="flex items-center justify-between gap-2 mt-2.5 mb-1">
        <span className={SECTION_LABEL} style={{ color: stateColor + 'b0' }}>
          RESULT
          {state !== 'running' && resultText !== '' && (
            <span className="ml-1.5 opacity-60 font-normal tracking-normal" style={{ color: COLORS.textMuted }}>
              {resultText.length.toLocaleString()} chars · {countLines(resultText).toLocaleString()} lines
            </span>
          )}
        </span>
        <CopyButton text={resultText} label="Copy result" disabled={resultText === ''} />
      </div>
      {state === 'running' && resultText === '' ? (
        <div className="text-[9px] italic" style={{ color: COLORS.tool_calling + 'b0' }}>Waiting for the result…</div>
      ) : resultText === '' ? (
        <div className="text-[9px] italic" style={{ color: COLORS.textMuted }}>
          Empty result{state === 'error' ? ' (the call failed)' : ''}.
        </div>
      ) : (
        <pre
          data-testid="tool-result"
          className="rounded px-1.5 py-1 text-[9px] leading-snug whitespace-pre-wrap break-words overflow-y-auto"
          style={{
            background: state === 'error' ? 'rgba(255, 85, 102, 0.06)' : COLORS.resultBg,
            border: `1px solid ${state === 'error' ? 'rgba(255, 85, 102, 0.25)' : COLORS.resultBorder}`,
            color: state === 'error' ? COLORS.error : COLORS.assistantText,
            maxHeight: resultMaxHeight,
            margin: 0,
          }}
        >
          {resultText}
        </pre>
      )}

      {/* Footer: tokens and copy-all */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-[9px]" style={{ color: COLORS.textMuted }}>
          {tokenCost != null && tokenCost > 0 ? `${tokenCost} tokens` : ''}
        </span>
        <CopyButton text={() => toolCopyAll(toolName, inputData, args, resultText)} label="Copy all" />
      </div>
    </div>
  )
}

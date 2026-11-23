'use client'

import { useEffect, useRef, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { copyText } from '@/lib/copy-text'

interface CopyButtonProps {
  /** Text to copy, or a function that builds it when the button is pressed. */
  text: string | (() => string)
  label?: string
  /** Shown instead of the label when there is nothing to copy. */
  disabled?: boolean
  title?: string
}

/** Small "copy" button in the panel style. Shows "copied" or "failed" for a moment. */
export function CopyButton({ text, label = 'copy', disabled = false, title }: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await copyText(typeof text === 'function' ? text() : text)
    setStatus(ok ? 'copied' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setStatus('idle'), 1500)
  }

  const color = status === 'copied' ? COLORS.complete : status === 'failed' ? COLORS.error : COLORS.textDim
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? 'Copy to clipboard'}
      data-copy-button
      className="text-[9px] font-mono px-1.5 py-px rounded transition-all flex-shrink-0"
      style={{
        border: `1px solid ${COLORS.holoBorder12}`,
        background: status === 'idle' ? 'transparent' : COLORS.holoBg05,
        color: disabled ? COLORS.textMuted : color,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {status === 'copied' ? '✓ copied' : status === 'failed' ? 'copy failed' : label}
    </button>
  )
}

'use client'

import { useState } from 'react'
import { COLORS } from '@/lib/colors'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { useLimits, useMinuteTick } from '@/hooks/use-limits'
import { buildObservedLimitsView, type LocalClock, type ObservedLimitsView } from '@/lib/costs/observed-limits'
import type { LimitsUpdatePayload } from '@/lib/costs/observed-types'

/** The viewer's local time, `HH:MM` (24 h). */
export const LOCAL_CLOCK: LocalClock = {
  hm: ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
  dayHm: ms => `${new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`,
  sameDay: (a, b) => new Date(a).toDateString() === new Date(b).toDateString(),
}

const TAG: Record<'obs' | 'stale' | 'ended', { text: string; color: string }> = {
  obs: { text: 'obs', color: COLORS.complete },
  stale: { text: 'stale', color: '#ffcc66' },
  ended: { text: 'ended', color: COLORS.textMuted },
}
const TONE = { ok: COLORS.complete, stale: '#ffcc66', info: COLORS.textMuted } as const

/** Current view of the observed limits, re-evaluated every minute (resets, fresh -> stale). */
export function useObservedLimitsView(now?: number, payloadOverride?: LimitsUpdatePayload | null): ObservedLimitsView {
  const payload = useLimits()
  useMinuteTick()
  return buildObservedLimitsView(payloadOverride === undefined ? payload : payloadOverride, now ?? Date.now(), LOCAL_CLOCK)
}

/** Top-bar chip: observed 5h / weekly values, or the one-line state when there are none. Click opens the details. */
export function LimitsChip({ onOpen }: { onOpen: () => void }) {
  const view = useObservedLimitsView()
  if (!view.chip) return null
  const color = TONE[view.chip.tone]
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="limits-chip"
      data-mode={view.mode}
      title={view.chip.title}
      aria-label={view.chip.title}
      style={{ color, border: `1px solid ${color}55`, borderRadius: 4, padding: '0 5px', fontSize: 9, whiteSpace: 'nowrap', background: 'transparent' }}
    >
      {view.chip.text}
    </button>
  )
}

const buttonStyle: React.CSSProperties = { color: COLORS.complete, border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, padding: '2px 8px' }

/** Section of the cost settings drawer: opt-in prompt, observed values with "as of", wrapper state. */
export function ClaudeLimitsSection({ view: given }: { view?: ObservedLimitsView }) {
  const live = useObservedLimitsView()
  const view = given ?? live
  const [busy, setBusy] = useState<'install' | 'uninstall' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const run = async (action: 'install' | 'uninstall') => {
    if (!vscodeBridge || busy) return
    setBusy(action)
    setResult(null)
    try { setResult(await vscodeBridge.requestStatusLineAction(action)) } finally { setBusy(null) }
  }

  return (
    <section data-testid="claude-limits" data-mode={view.mode} style={{ borderTop: `1px solid ${COLORS.glassBorder}`, padding: '10px 0' }}>
      <h3 style={{ margin: '0 0 6px', color: COLORS.textMuted, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>Claude usage limits</h3>
      <p data-testid="limits-headline" style={{ margin: '0 0 6px', fontSize: 11, lineHeight: 1.4 }}>{view.headline}</p>

      {view.rows.map(r => {
        const tag = TAG[r.tag]
        return (
          <div key={r.key} data-testid={`limit-${r.key}`} data-tag={r.tag} title={r.title} style={{ marginBottom: 6 }}>
            <div className="flex items-baseline gap-2">
              <span style={{ color: COLORS.textMuted, width: 52, flexShrink: 0 }}>{r.label}</span>
              <strong data-testid={`limit-${r.key}-value`} style={{ fontSize: 13 }}>{r.valueText}</strong>
              <span data-testid={`limit-${r.key}-tag`} style={{ color: tag.color, border: `1px solid ${tag.color}66`, borderRadius: 4, padding: '0 4px', fontSize: 9 }}>{tag.text}</span>
              {view.asOfText && r.tag !== 'ended' && <span data-testid={`limit-${r.key}-asof`} style={{ color: '#ffcc66', fontSize: 10 }}>{view.asOfText}</span>}
              <span style={{ color: COLORS.textMuted, fontSize: 10, marginLeft: 'auto', textAlign: 'right' }}>{r.resetText}</span>
            </div>
            <div aria-hidden style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', marginTop: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, (r.fraction ?? 0) * 100)}%`, height: '100%', background: r.tag === 'obs' ? tag.color : r.tag === 'stale' ? '#ffcc6699' : 'transparent' }} />
            </div>
          </div>
        )
      })}

      {view.mode === 'observed' && (
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 10, lineHeight: 1.4 }}>
          <span data-testid="limits-provider">Claude Code</span> · observed, not estimated · whole account, not just this machine.
        </p>
      )}

      {view.mode === 'prompt' && (
        <div data-testid="limits-optin" style={{ margin: '4px 0', padding: '8px 10px', borderRadius: 6, border: `1px solid ${COLORS.glassBorder}`, background: 'rgba(255,255,255,0.03)', fontSize: 10, lineHeight: 1.5 }}>
          <p style={{ margin: '0 0 4px' }}>Until then the 5-hour and weekly values are estimated from this machine only, which is a lower bound.</p>
          <p style={{ margin: '0 0 4px' }}>
            Agent Flow can read the usage percentages Claude Code already computes. It chains your status line command (yours keeps running unchanged) and
            saves only the usage percentages and reset times of each limit window (5-hour, weekly and any other the meter reports), the session id, the model id and a timestamp to <code>~/.agent-flow/limits/claude.json</code>, plus a short history of those readings in <code>claude-history.json</code> next to it (private files).
            No prompts or transcripts.
          </p>
          <p style={{ margin: '0 0 6px', color: COLORS.textMuted }}>You can remove it at any time and your original status line comes back (same content) and both files are deleted. If it cannot chain your status line safely it does nothing.</p>
          {view.canInstall && (
            <button type="button" data-testid="limits-install" disabled={busy !== null} onClick={() => run('install')} style={{ ...buttonStyle, opacity: busy ? 0.5 : 1 }}>
              {busy === 'install' ? 'Waiting for confirmation…' : 'Install wrapper…'}
            </button>
          )}
        </div>
      )}

      {view.installHint && view.mode !== 'unavailable' && (
        <p data-testid="limits-hint" style={{ margin: '4px 0', color: COLORS.textMuted, fontSize: 10, lineHeight: 1.4 }}>{view.installHint}</p>
      )}

      {view.canRemove && (
        <button type="button" data-testid="limits-remove" disabled={busy !== null} onClick={() => run('uninstall')} style={{ ...buttonStyle, marginTop: 4, color: COLORS.textMuted, opacity: busy ? 0.5 : 1 }}>
          {busy === 'uninstall' ? 'Waiting for confirmation…' : 'Remove wrapper…'}
        </button>
      )}

      {view.notes.map((n, i) => (
        <p key={i} data-testid="limits-note" style={{ margin: '6px 0 0', color: '#ffd98a', fontSize: 10, lineHeight: 1.4 }}>{n}</p>
      ))}
      {result && (
        <p role="status" data-testid="limits-action-result" style={{ margin: '6px 0 0', color: result.ok ? COLORS.complete : '#ff8896', fontSize: 10, lineHeight: 1.4 }}>{result.message}</p>
      )}
    </section>
  )
}

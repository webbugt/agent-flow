'use client'

import { useEffect, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { clearOverlayUnit, getOverlayOverride, setOverlayUnit } from '@/lib/cost-overlay-store'
import { OVERLAY_UNITS, unitName, type OverlayUnit } from '@/lib/costs/overlay'
import {
  KIND_LABELS, fadeHint, hiddenAgentsText, lingerHint, parseFadeInput, parseLingerInput, resourceBlockDefaultsPatch,
  type SecondsInput,
} from '@/lib/fleet/options-panel-model'
import {
  BLOCK_VIEWS, DEFAULT_PROFILE_PALETTE, MAX_PALETTE_COLORS, RESOURCE_KINDS, type BlockView, type OptionsPatch,
} from '@/lib/fleet/options-registry'
import { profileColor, profileNameKey } from '@/lib/fleet/anchor-mode'
import { resetOptions, updateOptions } from '@/lib/options-store'
import { useOptions } from '@/hooks/use-options'
import type { useFleetSelection } from '@/hooks/use-fleet-selection'

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, color: COLORS.textPrimary,
  padding: '3px 6px', width: 64, fontFamily: 'inherit', fontSize: 11, textAlign: 'right',
}
const badStyle: React.CSSProperties = { borderColor: '#ff6677' }
const smallButton: React.CSSProperties = { color: COLORS.complete, border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, padding: '2px 8px' }
const hintStyle: React.CSSProperties = { color: COLORS.textMuted, fontSize: 9 }

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: `1px solid ${COLORS.glassBorder}`, padding: '10px 0' }}>
      <h3 style={{ margin: '0 0 6px', color: COLORS.textMuted, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>{title}</h3>
      {note && <p style={{ ...hintStyle, margin: '0 0 6px' }}>{note}</p>}
      {children}
    </section>
  )
}

function Check({ checked, onChange, label, testId, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2" style={{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} data-testid={testId} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/**
 * A seconds field. Every valid edit is applied at once (no Save button, no reload); an invalid one shows why and
 * leaves the stored value alone. On blur the field shows the stored value again.
 */
function SecondsField({ value, parse, onCommit, label, testId }: {
  value: number
  parse: (text: string) => SecondsInput
  onCommit: (seconds: number) => string | null
  label: string
  testId: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const change = (text: string) => {
    setDraft(text)
    const r = parse(text)
    if (!r.ok) { setError(r.error); return }
    setError(onCommit(r.value))
  }
  return (
    <span className="inline-flex flex-col items-end">
      <input
        type="text" inputMode="decimal" aria-label={label} data-testid={testId}
        aria-invalid={error !== null}
        value={draft ?? String(value)}
        onChange={e => change(e.target.value)}
        onBlur={() => { setDraft(null); setError(null) }}
        style={{ ...inputStyle, ...(error ? badStyle : null) }}
      />
      {error && <span role="alert" style={{ color: '#ff8896', fontSize: 9, textAlign: 'right', lineHeight: 1.25 }}>{error}</span>}
    </span>
  )
}

/** Apply a patch; the message of the first problem, or null. */
function apply(patch: OptionsPatch): string | null {
  const r = updateOptions(patch)
  return r.ok ? null : r.errors[0] ?? 'Not accepted.'
}

export interface OptionsPanelProps {
  /** The fleet selection (same value the fleet timeline checkboxes edit). */
  selection: ReturnType<typeof useFleetSelection>
  onClose: () => void
  /** Profile names known to the fleet (resource-anchor mode lists them to set a colour per profile). */
  profiles?: readonly string[]
}

/**
 * The options panel: one place for the client-side settings of Agent Flow. They live in the browser only
 * (localStorage key agentflow.options.v1); no server config file, no restart. Changes apply at once.
 */
export function OptionsPanel({ selection, onClose, profiles = [] }: OptionsPanelProps) {
  const options = useOptions()
  const unitChoice: OverlayUnit | '' = getOverlayOverride() ?? ''

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      data-testid="options-panel"
      role="dialog"
      aria-label="Options"
      className="font-mono text-[11px]"
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(400px, 100vw)', zIndex: Z.detailCard + 10, overflowY: 'auto',
        background: '#080c18', borderLeft: `1px solid ${COLORS.glassBorder}`, boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
        color: COLORS.textPrimary, padding: '12px 14px 80px',
      }}
    >
      <div className="flex items-center" style={{ marginBottom: 4 }}>
        <strong style={{ fontSize: 13 }}>Options</strong>
        <button type="button" onClick={onClose} aria-label="Close options" data-testid="options-close" className="ml-auto" style={{ color: COLORS.textMuted, fontSize: 14 }}>✕</button>
      </div>
      <p style={{ ...hintStyle, margin: '0 0 4px' }}>
        Kept in this browser only. Changes apply at once; no server setting is touched and nothing restarts.
      </p>

      <Section
        title="Resource blocks"
        note="How long a block stays on screen after an agent last used it. 0 hides it immediately; a pinned block stays. The blocks themselves arrive kind by kind in the next steps; the values are saved now and are read live once a kind is drawn."
      >
        {/* Fixed layout: the columns keep their width when a field shows an error message. */}
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col />
            <col style={{ width: 92 }} />
            {BLOCK_VIEWS.map(v => <col key={v} style={{ width: 52 }} />)}
          </colgroup>
          <thead>
            <tr style={{ color: COLORS.textMuted, fontSize: 9, textAlign: 'left' }}>
              <th style={{ fontWeight: 'normal', paddingBottom: 4 }}>Kind</th>
              <th style={{ fontWeight: 'normal', textAlign: 'right', paddingRight: 2 }}>Linger (s)</th>
              {BLOCK_VIEWS.map(v => <th key={v} style={{ fontWeight: 'normal', textAlign: 'center' }}>{viewLabel(v)}</th>)}
            </tr>
          </thead>
          <tbody>
            {RESOURCE_KINDS.map(kind => (
              <tr key={kind} data-testid={`options-row-${kind}`}>
                <td style={{ padding: '4px 0' }}>
                  {KIND_LABELS[kind]}
                  <div style={hintStyle}>{lingerHint(options.lingerSeconds[kind])}</div>
                </td>
                <td style={{ textAlign: 'right', verticalAlign: 'top', paddingTop: 4 }}>
                  <SecondsField
                    value={options.lingerSeconds[kind]}
                    parse={parseLingerInput}
                    onCommit={s => apply({ lingerSeconds: { [kind]: s } })}
                    label={`${KIND_LABELS[kind]} linger seconds`}
                    testId={`options-linger-${kind}`}
                  />
                </td>
                {BLOCK_VIEWS.map(view => (
                  <td key={view} style={{ textAlign: 'center', verticalAlign: 'top', paddingTop: 6 }}>
                    <input
                      type="checkbox" aria-label={`Show ${KIND_LABELS[kind]} in the ${viewLabel(view)} view`}
                      data-testid={`options-show-${view}-${kind}`}
                      checked={options.show[view][kind]}
                      onChange={e => apply({ show: { [view]: { [kind]: e.target.checked } } })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-start gap-2" style={{ marginTop: 8 }}>
          <span style={{ paddingTop: 4 }}>
            Fade (s)
            <div style={hintStyle}>{fadeHint(options.fadeSeconds)}</div>
          </span>
          <span className="ml-auto">
            <SecondsField
              value={options.fadeSeconds}
              parse={parseFadeInput}
              onCommit={s => apply({ fadeSeconds: s })}
              label="Fade seconds"
              testId="options-fade"
            />
          </span>
        </div>
        <button type="button" onClick={() => apply(resourceBlockDefaultsPatch())} data-testid="options-reset-blocks" style={{ ...smallButton, marginTop: 8 }}>
          Reset resource blocks to defaults
        </button>
      </Section>

      <Section title="Fleet">
        <Check
          checked={options.fleetTimelineVisible}
          onChange={v => apply({ fleetTimelineVisible: v })}
          label="Show the fleet timeline panel"
          testId="options-timeline"
        />
        <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
          <span data-testid="options-hidden-text" style={hintStyle}>{hiddenAgentsText(selection.off.size)}</span>
          <button
            type="button" onClick={selection.selectAll} disabled={selection.off.size === 0}
            data-testid="options-show-all-agents" className="ml-auto"
            style={{ ...smallButton, opacity: selection.off.size === 0 ? 0.5 : 1 }}
          >
            Show all
          </button>
        </div>
      </Section>

      <Section
        title="Resource-anchor mode"
        note="Resources are the anchors of the map: those used together sit close, and a session drifts to the resource it uses. Profiles show as the colour of their session nodes. Off keeps the cloud layout."
      >
        <Check
          checked={options.anchorMode}
          onChange={v => apply({ anchorMode: v })}
          label="Resource-anchor mode"
          testId="options-anchor-mode"
        />
        <div style={{ ...hintStyle, margin: '10px 0 4px' }}>
          Profile colour = palette[hash(profile name) mod palette size]. Two profiles can share a colour; set one below to tell them apart.
        </div>
        <div className="flex flex-wrap items-center gap-2" data-testid="options-palette">
          {options.profilePalette.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <input
                type="color" value={c} aria-label={`Palette colour ${i + 1}`} data-testid={`options-palette-${i}`}
                onChange={e => apply({ profilePalette: options.profilePalette.map((x, j) => (j === i ? e.target.value : x)) })}
                style={{ width: 24, height: 20, padding: 0, background: 'none', border: `1px solid ${COLORS.glassBorder}`, borderRadius: 3 }}
              />
              <button
                type="button" aria-label={`Remove palette colour ${i + 1}`} data-testid={`options-palette-remove-${i}`}
                disabled={options.profilePalette.length <= 1}
                onClick={() => apply({ profilePalette: options.profilePalette.filter((_, j) => j !== i) })}
                style={{ color: COLORS.textMuted, fontSize: 10, opacity: options.profilePalette.length <= 1 ? 0.4 : 1 }}
              >✕</button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2" style={{ marginTop: 6 }}>
          <button
            type="button" data-testid="options-palette-add" style={smallButton}
            disabled={options.profilePalette.length >= MAX_PALETTE_COLORS}
            onClick={() => apply({ profilePalette: [...options.profilePalette, '#ffffff'] })}
          >Add colour</button>
          <button
            type="button" data-testid="options-palette-reset" style={smallButton}
            onClick={() => apply({ profilePalette: [...DEFAULT_PROFILE_PALETTE], profileColors: {} })}
          >Reset palette</button>
        </div>
        {profiles.length > 0 && (
          <div style={{ marginTop: 10 }} data-testid="options-profile-colors">
            <div style={{ ...hintStyle, marginBottom: 4 }}>Profiles (a picked colour overrides the palette):</div>
            {profiles.map(name => {
              const key = profileNameKey(name)
              const own = options.profileColors[key]
              const colour = profileColor(name, options.profilePalette, options.profileColors)
              return (
                <div key={name} className="flex items-center gap-2" style={{ padding: '2px 0' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: colour, display: 'inline-block' }} />
                  <span>{name}</span>
                  <span className="ml-auto inline-flex items-center gap-1">
                    <input
                      type="color" value={colour} aria-label={`Colour of ${name}`} data-testid={`options-profile-color-${key}`}
                      onChange={e => apply({ profileColors: { ...options.profileColors, [key]: e.target.value } })}
                      style={{ width: 24, height: 20, padding: 0, background: 'none', border: `1px solid ${COLORS.glassBorder}`, borderRadius: 3 }}
                    />
                    <button
                      type="button" disabled={!own} data-testid={`options-profile-color-clear-${key}`} style={{ ...smallButton, opacity: own ? 1 : 0.4 }}
                      onClick={() => { const next = { ...options.profileColors }; delete next[key]; apply({ profileColors: next }) }}
                    >auto</button>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section title="Sound">
        <Check checked={options.soundOn} onChange={v => apply({ soundOn: v })} label="Sound effects" testId="options-sound" />
      </Section>

      <Section title="Costs" note="The unit of the cost overlay in the header. The prices and the default unit are in the cost settings.">
        <label className="flex items-center gap-2">
          <span>Header cost unit</span>
          <select
            data-testid="options-cost-unit" value={unitChoice} className="ml-auto"
            onChange={e => { const v = e.target.value; if (v === '') clearOverlayUnit(); else setOverlayUnit(v as OverlayUnit) }}
            style={{ ...inputStyle, width: 'auto', textAlign: 'left' }}
          >
            <option value="">follow the cost settings</option>
            {OVERLAY_UNITS.map(u => <option key={u} value={u}>{unitName(u)}</option>)}
          </select>
        </label>
      </Section>

      <Section title="Reset">
        <button type="button" onClick={resetOptions} data-testid="options-reset-all" style={smallButton}>Reset all options</button>
        <div style={{ ...hintStyle, marginTop: 4 }}>Defaults for everything above, sound off, and every hidden agent shown again.</div>
      </Section>
    </aside>
  )
}

function viewLabel(v: BlockView): string {
  return v === 'single' ? 'Single' : 'Fleet'
}

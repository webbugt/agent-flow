'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { saveCostsConfig } from '@/lib/costs-write'
import { clearOverlayUnit, getOverlayOverride, overlayUnitVersion, subscribeOverlayUnit } from '@/lib/cost-overlay-store'
import { editBase, isBaseChanged, type EditBase } from '@/lib/costs/edit-base'
import {
  FIELD, applyDraft, checkDoc, draftFromDoc, issuesAt, newRule, otherIssues, providerIds,
  type Draft, type RuleDraft,
} from '@/lib/costs/settings-edit'
import { unitName } from '@/lib/costs/overlay'
import { BILLING_MODES } from '@/lib/costs/types'
import type { DisplayUnit } from '@/lib/costs/types'
import type { CostsStatus } from '@/lib/costs-runtime'
import { vscodeBridge } from '@/lib/vscode-bridge'

type Obj = Record<string, unknown>

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, color: COLORS.textPrimary,
  padding: '3px 6px', minWidth: 0, width: '100%', fontFamily: 'inherit', fontSize: 11,
}
const badStyle: React.CSSProperties = { borderColor: '#ff6677' }

function Err({ issues }: { issues: { path: string; message: string }[] }) {
  if (issues.length === 0) return null
  return (
    <ul role="alert" style={{ margin: '2px 0 0', padding: 0, listStyle: 'none', color: '#ff8896', fontSize: 9 }}>
      {issues.map((i, n) => <li key={n}>{i.message}</li>)}
    </ul>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: `1px solid ${COLORS.glassBorder}`, padding: '10px 0' }}>
      <h3 style={{ margin: '0 0 6px', color: COLORS.textMuted, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>{title}</h3>
      {children}
    </section>
  )
}

const BILLING_HELP: Record<string, string> = {
  api: 'api: pay per token (billed)',
  subscription: 'subscription: list-equivalent value',
  credits: 'credits: AI credits (Copilot)',
  local: 'local: electricity only',
  free: 'free',
  unknown: 'unknown',
}

export interface CostsSettingsDrawerProps {
  status: CostsStatus
  /** Providers seen in the session, so a price can be set for one that is not in the file yet. */
  seenProviders: readonly string[]
  onClose: () => void
}

/** The version of the user's file the draft was made from, and the versions that count as ours (see isBaseChanged). */
interface Seed { doc: Obj | undefined; known: string[]; epoch: number }

const noteStyle: React.CSSProperties = { margin: '6px 0', padding: '6px 8px', borderRadius: 6, fontSize: 10, lineHeight: 1.4 }
const smallButton: React.CSSProperties = { color: COLORS.complete, border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, padding: '2px 8px', marginTop: 4 }

/**
 * Settings drawer (PLAN v2 section 7.2): edit prices per provider/model and the display currency / FX. It edits the
 * user's costs.json: the draft is validated with the loader's own validator on every change (errors appear next to
 * the field with the same wording as the banner) and Save is disabled while any error remains. Saving sends the
 * whole document to the host, which writes the file; the overlay then follows the file watcher like after any edit.
 *
 * Because a save replaces the whole file, the draft is made only from the file's current, valid content
 * (lib/costs/edit-base.ts). If the file is broken or invalid, the drawer says so and does not offer Save. If the
 * file changes after the drawer opened, Save is off until the person reloads. The host checks the same thing again
 * (a fingerprint of the version that was edited) and refuses a write over a newer file.
 */
export function CostsSettingsDrawer({ status, seenProviders, onClose }: CostsSettingsDrawerProps) {
  const userSource = status.sources.find(s => s.id === 'user')
  const current = useMemo<EditBase>(
    () => editBase(userSource, status.resolution.errors.filter(e => e.layer === 'user'), status.resolution.goodLayers.user as Obj | undefined),
    [userSource, status.resolution.errors, status.resolution.goodLayers.user],
  )
  const [seed, setSeed] = useState<Seed | null>(() => (current.ok ? { doc: current.doc, known: [current.fingerprint], epoch: 0 } : null))
  // The file was unusable when the drawer opened and has been fixed since: start from it now (nothing was edited yet).
  useEffect(() => { if (seed === null && current.ok) setSeed({ doc: current.doc, known: [current.fingerprint], epoch: 1 }) }, [seed, current])

  const changed = seed !== null && isBaseChanged(current, seed.known)
  const reload = () => { if (current.ok) setSeed(s => ({ doc: current.doc, known: [current.fingerprint], epoch: (s?.epoch ?? 0) + 1 })) }
  const openFile = vscodeBridge?.isVSCode ? () => vscodeBridge?.openCostsConfig() : null

  return (
    <aside
      data-testid="costs-settings-drawer"
      role="dialog"
      aria-label="Cost settings"
      className="font-mono text-[11px]"
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(420px, 100vw)', zIndex: Z.detailCard + 10, overflowY: 'auto',
        background: '#080c18', borderLeft: `1px solid ${COLORS.glassBorder}`, boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
        color: COLORS.textPrimary, padding: '12px 14px 80px',
      }}
    >
      <div className="flex items-center" style={{ marginBottom: 4 }}>
        <strong style={{ fontSize: 13 }}>Cost settings</strong>
        <button type="button" onClick={onClose} aria-label="Close cost settings" data-testid="costs-settings-close" className="ml-auto" style={{ color: COLORS.textMuted, fontSize: 14 }}>✕</button>
      </div>
      <p style={{ margin: '0 0 4px', color: COLORS.textMuted, fontSize: 10 }}>
        Writes <code>{userSource?.path ?? '~/.agent-flow/costs.json'}</code>
        {userSource?.status === 'missing' ? ' (created on save)' : ''}.
      </p>
      {seed === null ? (
        <div data-testid="costs-edit-blocked" role="alert" style={{ ...noteStyle, border: '1px solid #ff6677', color: '#ff8896', background: 'rgba(255,102,119,0.08)' }}>
          <strong>The settings cannot be edited yet.</strong>
          <p style={{ margin: '4px 0 0' }}>{current.ok ? 'Loading the file…' : current.reason}</p>
          {openFile && <button type="button" onClick={openFile} data-testid="costs-open-file" style={smallButton}>Open the file</button>}
        </div>
      ) : (
        <DrawerForm
          key={seed.epoch}
          status={status}
          seenProviders={seenProviders}
          base={seed.doc}
          baseFingerprint={seed.known[0]}
          block={!current.ok ? { kind: 'blocked', text: current.reason } : changed ? { kind: 'changed', text: 'The costs file changed on disk after this panel opened. Save is off so it cannot roll those changes back. Reload to start from the file as it is now (your unsaved edits here are discarded).' } : null}
          onReload={current.ok ? reload : null}
          onOpenFile={openFile}
          onClose={onClose}
          onSaved={(doc, fingerprint) => setSeed(s => (s ? { ...s, doc, known: fingerprint ? [fingerprint, s.known[0]] : s.known } : s))}
        />
      )}
    </aside>
  )
}

interface DrawerFormProps {
  status: CostsStatus
  seenProviders: readonly string[]
  /** The valid content of the file the draft starts from (undefined: no file yet). */
  base: Obj | undefined
  /** Version of the file `base` is, sent with Save. */
  baseFingerprint: string
  /** Why Save is off, from the file's state (not from validation). */
  block: { kind: 'blocked' | 'changed'; text: string } | null
  onReload: (() => void) | null
  onOpenFile: (() => void) | null
  onSaved: (doc: Obj, fingerprint: string | undefined) => void
  onClose: () => void
}

function DrawerForm({ status, seenProviders, base, baseFingerprint, block, onReload, onOpenFile, onSaved, onClose }: DrawerFormProps) {
  const ids = useMemo(() => providerIds(base, seenProviders), [base, seenProviders])
  const [draft, setDraft] = useState<Draft>(() => draftFromDoc(base, ids))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<{ text: string; conflict: boolean } | null>(null)
  const [saved, setSaved] = useState(false)

  const doc = useMemo(() => applyDraft(base, draft), [base, draft])
  const check = useMemo(() => checkDoc(doc), [doc])
  const projectSource = status.sources.find(s => s.id === 'project')
  const projectActive = !!projectSource && projectSource.status !== 'missing' && projectSource.inUse
  const canSave = check.ok && !saving && block === null

  // The header toggle is a per-device override of "Default unit"; say so while it is in force.
  useSyncExternalStore(subscribeOverlayUnit, overlayUnitVersion, overlayUnitVersion)
  const toggled = getOverlayOverride()

  const edit = (fn: (d: Draft) => Draft) => { setSaved(false); setSaveError(null); setDraft(fn) }
  const setRule = (i: number, patch: Partial<RuleDraft>) => edit(d => ({ ...d, rules: d.rules.map((r, n) => (n === i ? { ...r, ...patch } : r)) }))
  const code = draft.currency.trim().toUpperCase()
  const isUsd = code === '' || code === 'USD'
  const rest = otherIssues(check.errors, draft)

  async function save() {
    if (!canSave) return
    setSaving(true); setSaveError(null)
    const r = await saveCostsConfig('user', doc, baseFingerprint)
    setSaving(false)
    if (r.ok) { setSaved(true); onSaved(doc, r.fingerprint) } else setSaveError({ text: r.error, conflict: r.conflict === true })
  }

  return (
    <>
      {block && (
        <div data-testid={block.kind === 'changed' ? 'costs-edit-changed' : 'costs-edit-blocked'} role="alert" style={{ ...noteStyle, border: '1px solid #ffcc66', color: '#ffd98a', background: 'rgba(255,204,102,0.08)' }}>
          <strong>{block.kind === 'changed' ? 'The file changed.' : 'Save is off.'}</strong>
          <p style={{ margin: '4px 0 0' }}>{block.text}</p>
          {block.kind === 'changed' && onReload && <button type="button" onClick={onReload} data-testid="costs-reload" style={smallButton}>Reload from file</button>}
          {block.kind === 'blocked' && onOpenFile && <button type="button" onClick={onOpenFile} data-testid="costs-open-file" style={smallButton}>Open the file</button>}
        </div>
      )}
      {projectActive && (
        <p data-testid="costs-project-override" style={{ margin: '0 0 4px', color: '#ffcc66', fontSize: 10 }}>
          A project file ({projectSource?.path}) overrides these values where it sets them.
        </p>
      )}

      <Section title="Currency">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label>Display currency
            <input aria-label="Display currency" data-testid="field-currency" value={draft.currency} maxLength={3} placeholder="USD"
              onChange={e => edit(d => ({ ...d, currency: e.target.value }))}
              style={{ ...inputStyle, ...(issuesAt(check.errors, FIELD.currency).length ? badStyle : {}), textTransform: 'uppercase' }} />
          </label>
          <label>{isUsd ? 'FX (not needed for USD)' : `1 USD = ? ${code}`}
            <input aria-label="Exchange rate" data-testid="field-fx" inputMode="decimal" value={draft.fx} disabled={isUsd} placeholder="e.g. 0.92"
              onChange={e => edit(d => ({ ...d, fx: e.target.value }))}
              style={{ ...inputStyle, ...(issuesAt(check.errors, FIELD.fx(code)).length ? badStyle : {}) }} />
          </label>
        </div>
        <Err issues={[...issuesAt(check.errors, FIELD.currency), ...issuesAt(check.errors, '/currency/fx')]} />
        <label style={{ display: 'block', marginTop: 6 }}>Rate as of (YYYY-MM-DD, optional)
          <input aria-label="Rate date" value={draft.fxAsOf} placeholder="e.g. 2026-11-25" onChange={e => edit(d => ({ ...d, fxAsOf: e.target.value }))} style={inputStyle} />
        </label>
        <Err issues={issuesAt(check.errors, FIELD.fxAsOf)} />
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 9 }}>Rates are entered by hand; nothing is fetched. They are shown next to every converted figure.</p>
      </Section>

      <Section title="Display">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label>Default unit
            <select aria-label="Default unit" data-testid="field-unit" value={draft.unit} onChange={e => edit(d => ({ ...d, unit: e.target.value as DisplayUnit }))} style={inputStyle}>
              <option value="auto">auto (money)</option>
              <option value="money">money</option>
              <option value="kwh">kWh</option>
              <option value="tokens">tokens</option>
            </select>
          </label>
          <label>Subscription value
            <select aria-label="Subscription value" data-testid="field-subvalue" value={draft.subscriptionValue}
              onChange={e => edit(d => ({ ...d, subscriptionValue: e.target.value === 'hide' ? 'hide' : 'show' }))} style={inputStyle}>
              <option value="show">show list-equiv figure</option>
              <option value="hide">hide</option>
            </select>
          </label>
        </div>
        {toggled && (
          <p data-testid="unit-override-note" style={{ margin: '6px 0 0', color: '#ffd98a', fontSize: 10 }}>
            The header toggle is set to <strong>{unitName(toggled)}</strong> on this device and overrides the default until you change the default.{' '}
            <button type="button" onClick={clearOverlayUnit} data-testid="unit-override-clear" style={{ ...smallButton, marginTop: 0 }}>Use the default</button>
          </p>
        )}
      </Section>

      <Section title="Providers">
        {ids.map(id => {
          const p = draft.providers[id] ?? { billing: '' as const, implicitCacheWrite: null }
          return (
            <div key={id} data-testid={`provider-${id}`} style={{ marginBottom: 6 }}>
              <div style={{ color: COLORS.textPrimary, marginBottom: 2, wordBreak: 'break-all' }}>{id}</div>
              <select aria-label={`Billing of ${id}`} value={p.billing} style={{ ...inputStyle, ...(issuesAt(check.errors, FIELD.provider(id, 'billing')).length ? badStyle : {}) }}
                onChange={e => edit(d => ({ ...d, providers: { ...d.providers, [id]: { ...p, billing: e.target.value as typeof p.billing } } }))}>
                <option value="">built-in</option>
                {BILLING_MODES.map(m => <option key={m} value={m}>{BILLING_HELP[m] ?? m}</option>)}
              </select>
              <Err issues={issuesAt(check.errors, `/pricing/providers/${id}`)} />
            </div>
          )
        })}
      </Section>

      <Section title="Model prices (per 1M tokens)">
        {draft.rules.length === 0 && <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 10 }}>No custom prices: the built-in catalog applies.</p>}
        {draft.rules.map((r, i) => {
          const at = (f: Parameters<typeof FIELD.ruleField>[1]) => issuesAt(check.errors, FIELD.ruleField(i, f))
          const bad = (f: Parameters<typeof FIELD.ruleField>[1]) => (at(f).length ? badStyle : {})
          return (
            <div key={i} data-testid={`rule-${i}`} style={{ border: `1px solid ${COLORS.glassBorder}`, borderRadius: 6, padding: 8, marginBottom: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <label>Provider
                  <input aria-label={`Rule ${i + 1} provider`} list="costs-providers" value={r.provider} placeholder="any" onChange={e => setRule(i, { provider: e.target.value })} style={{ ...inputStyle, ...bad('provider') }} />
                </label>
                <label>Model (name or prefix)
                  <input aria-label={`Rule ${i + 1} model`} value={r.model} placeholder="claude-sonnet-5" onChange={e => setRule(i, { model: e.target.value })} style={{ ...inputStyle, ...bad('model') }} />
                </label>
              </div>
              {r.locked ? (
                <p style={{ margin: '6px 0 0', color: COLORS.textMuted, fontSize: 9 }}>This rule uses price tiers or its own currency: edit it in the file. Provider and model above can still change.</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, marginTop: 6 }}>
                  {([['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write']] as const).map(([f, label]) => (
                    <label key={f} style={{ fontSize: 9 }}>{label}
                      <input aria-label={`Rule ${i + 1} ${label}`} inputMode="decimal" value={r[f]} placeholder={f === 'cacheRead' || f === 'cacheWrite' ? 'auto' : '0'}
                        onChange={e => setRule(i, { [f]: e.target.value } as Partial<RuleDraft>)} style={{ ...inputStyle, ...bad(f) }} />
                    </label>
                  ))}
                </div>
              )}
              <Err issues={issuesAt(check.errors, FIELD.rule(i))} />
              <button type="button" onClick={() => edit(d => ({ ...d, rules: d.rules.filter((_, n) => n !== i) }))} style={{ marginTop: 6, color: '#ff8896', fontSize: 10 }}>Remove price</button>
            </div>
          )
        })}
        <datalist id="costs-providers">{ids.map(id => <option key={id} value={id} />)}</datalist>
        <button type="button" data-testid="add-rule" onClick={() => edit(d => ({ ...d, rules: [...d.rules, newRule(seenProviders[0] ?? '', '')] }))}
          style={{ color: COLORS.complete, border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, padding: '3px 8px' }}>+ Add price</button>
      </Section>

      {rest.length > 0 && (
        <Section title="Other problems">
          <Err issues={rest} />
        </Section>
      )}

      <div style={{ position: 'sticky', bottom: -80, marginTop: 8, padding: '10px 0', background: '#080c18', borderTop: `1px solid ${COLORS.glassBorder}` }}>
        {saveError && (
          <p role="alert" data-testid="costs-save-error" style={{ margin: '0 0 6px', color: '#ff8896', fontSize: 10 }}>
            {saveError.conflict ? 'Nothing was written: ' : 'Could not save: '}{saveError.text}
            {saveError.conflict && onReload && <> <button type="button" onClick={onReload} data-testid="costs-reload-after-conflict" style={{ ...smallButton, marginTop: 0 }}>Reload from file</button></>}
          </p>
        )}
        {saved && <p data-testid="costs-saved" style={{ margin: '0 0 6px', color: COLORS.complete, fontSize: 10 }}>Saved. The overlay now uses these values.</p>}
        {!check.ok && <p style={{ margin: '0 0 6px', color: '#ff8896', fontSize: 10 }}>{check.errors.length} problem{check.errors.length === 1 ? '' : 's'} to fix before saving.</p>}
        {block && <p data-testid="costs-save-blocked" style={{ margin: '0 0 6px', color: '#ffd98a', fontSize: 10 }}>{block.kind === 'changed' ? 'Save is off until you reload from the file.' : 'Save is off: the file cannot be edited from here (see above).'}</p>}
        <div className="flex gap-2">
          <button type="button" data-testid="costs-save" disabled={!canSave} onClick={save}
            style={{ background: canSave ? COLORS.costActiveBg : 'transparent', color: canSave ? COLORS.complete : COLORS.textMuted, border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, padding: '4px 14px', opacity: canSave ? 1 : 0.5 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onClose} style={{ color: COLORS.textMuted, padding: '4px 10px' }}>Close</button>
        </div>
      </div>
    </>
  )
}

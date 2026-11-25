'use client'

import { useMemo, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { saveCostsConfig } from '@/lib/costs-write'
import {
  FIELD, applyDraft, checkDoc, draftFromDoc, issuesAt, newRule, otherIssues, providerIds,
  type Draft, type RuleDraft,
} from '@/lib/costs/settings-edit'
import { BILLING_MODES } from '@/lib/costs/types'
import type { DisplayUnit } from '@/lib/costs/types'
import type { CostsStatus } from '@/lib/costs-runtime'

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

/**
 * Settings drawer (PLAN v2 section 7.2): edit prices per provider/model and the display currency / FX. It edits the
 * user's costs.json: the draft is validated with the loader's own validator on every change (errors appear next to
 * the field with the same wording as the banner) and Save is disabled while any error remains. Saving sends the
 * whole document to the host, which writes the file; the overlay then follows the file watcher like after any edit.
 */
export function CostsSettingsDrawer({ status, seenProviders, onClose }: CostsSettingsDrawerProps) {
  const base = useMemo(() => (status.resolution.goodLayers.user ?? undefined) as Obj | undefined, [status.resolution.goodLayers.user])
  const ids = useMemo(() => providerIds(base, seenProviders), [base, seenProviders])
  const [draft, setDraft] = useState<Draft>(() => draftFromDoc(base, ids))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const doc = useMemo(() => applyDraft(base, draft), [base, draft])
  const check = useMemo(() => checkDoc(doc), [doc])
  const userSource = status.sources.find(s => s.id === 'user')
  const projectSource = status.sources.find(s => s.id === 'project')
  const projectActive = !!projectSource && projectSource.status !== 'missing' && projectSource.inUse

  const edit = (fn: (d: Draft) => Draft) => { setSaved(false); setSaveError(null); setDraft(fn) }
  const setRule = (i: number, patch: Partial<RuleDraft>) => edit(d => ({ ...d, rules: d.rules.map((r, n) => (n === i ? { ...r, ...patch } : r)) }))
  const code = draft.currency.trim().toUpperCase()
  const isUsd = code === '' || code === 'USD'
  const rest = otherIssues(check.errors, draft)

  async function save() {
    setSaving(true); setSaveError(null)
    const r = await saveCostsConfig('user', doc)
    setSaving(false)
    if (r.ok) setSaved(true); else setSaveError(r.error)
  }

  return (
    <aside
      data-testid="costs-settings-drawer"
      role="dialog"
      aria-label="Cost settings"
      className="font-mono text-[11px]"
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(420px, 100vw)', zIndex: Z.detailCard + 10, overflowY: 'auto',
        background: 'rgba(8, 12, 24, 0.97)', borderLeft: `1px solid ${COLORS.glassBorder}`, boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
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
            <input aria-label="Exchange rate" data-testid="field-fx" inputMode="decimal" value={draft.fx} disabled={isUsd} placeholder="0.92"
              onChange={e => edit(d => ({ ...d, fx: e.target.value }))}
              style={{ ...inputStyle, ...(issuesAt(check.errors, FIELD.fx(code)).length ? badStyle : {}) }} />
          </label>
        </div>
        <Err issues={[...issuesAt(check.errors, FIELD.currency), ...issuesAt(check.errors, '/currency/fx')]} />
        <label style={{ display: 'block', marginTop: 6 }}>Rate as of (YYYY-MM-DD, optional)
          <input aria-label="Rate date" value={draft.fxAsOf} placeholder="2026-11-25" onChange={e => edit(d => ({ ...d, fxAsOf: e.target.value }))} style={inputStyle} />
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

      <div style={{ position: 'sticky', bottom: -80, marginTop: 8, padding: '10px 0', background: 'rgba(8, 12, 24, 0.97)', borderTop: `1px solid ${COLORS.glassBorder}` }}>
        {saveError && <p role="alert" data-testid="costs-save-error" style={{ margin: '0 0 6px', color: '#ff8896', fontSize: 10 }}>Could not save: {saveError}</p>}
        {saved && <p data-testid="costs-saved" style={{ margin: '0 0 6px', color: COLORS.complete, fontSize: 10 }}>Saved. The overlay now uses these values.</p>}
        {!check.ok && <p style={{ margin: '0 0 6px', color: '#ff8896', fontSize: 10 }}>{check.errors.length} problem{check.errors.length === 1 ? '' : 's'} to fix before saving.</p>}
        <div className="flex gap-2">
          <button type="button" data-testid="costs-save" disabled={!check.ok || saving} onClick={save}
            style={{ background: check.ok ? COLORS.costActiveBg : 'transparent', color: check.ok ? COLORS.complete : COLORS.textMuted, border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, padding: '4px 14px', opacity: check.ok && !saving ? 1 : 0.5 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onClose} style={{ color: COLORS.textMuted, padding: '4px 10px' }}>Close</button>
        </div>
      </div>
    </aside>
  )
}

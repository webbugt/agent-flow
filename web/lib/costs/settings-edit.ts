/**
 * Settings drawer logic (PLAN v2 section 7.2): turn the user's costs.json into an editable draft, the draft
 * back into a document, and check that document with the SAME validator the loader uses, so the drawer shows
 * exactly the errors the banner would show, each with its JSON pointer. Pure, no I/O.
 *
 * The draft covers what the drawer edits (display currency + fx, unit, subscription value, provider billing,
 * model price rules). `applyDraft` writes only those keys into a copy of the existing document: everything else
 * in the file (energy, limits, `$schema`, rule fields the drawer cannot show) survives byte-for-byte in meaning.
 *
 * Nothing here sends the document anywhere. The caller posts it to the host, which writes the file.
 */
import { BUILTIN_PROVIDERS } from './resolve'
import { validateConfig } from './validate'
import { BILLING_MODES } from './types'
import type { BillingMode, DisplayUnit, SubscriptionValue, ValidationIssue } from './types'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

export interface RuleDraft {
  provider: string
  model: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  /** The rule has price tiers or an own currency: the drawer shows it read-only (rate fields locked). */
  locked: boolean
  /** The original rule object, merged back on apply (billing, modifiers, energyProfile, tiers, ...). */
  base: Obj
}

export interface ProviderDraft {
  /** '' = not set in the file (the built-in value applies). */
  billing: BillingMode | ''
  /** null = not set in the file. */
  implicitCacheWrite: boolean | null
}

export interface Draft {
  currency: string
  /** Units of `currency` per 1 USD, as typed. */
  fx: string
  fxAsOf: string
  unit: DisplayUnit
  subscriptionValue: SubscriptionValue
  providers: Record<string, ProviderDraft>
  rules: RuleDraft[]
}

export const EMPTY_RULE: Omit<RuleDraft, 'base'> = { provider: '', model: '', input: '', output: '', cacheRead: '', cacheWrite: '', locked: false }

const numText = (v: unknown): string => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '')

export function newRule(provider = '', model = ''): RuleDraft {
  return { ...EMPTY_RULE, provider, model, base: {} }
}

/** Providers the drawer lists: the built-in ones, the ones in the file, and any seen in the session. */
export function providerIds(doc: Obj | undefined, seen: readonly string[] = []): string[] {
  const out: string[] = []
  const add = (id: string) => { if (id && !FORBIDDEN.has(id) && !out.includes(id)) out.push(id) }
  for (const id of ['anthropic', 'claude-subscription-directsdk-experimental', 'copilot']) add(id)
  const fileProviders = isObj(doc?.pricing) && isObj((doc!.pricing as Obj).providers) ? Object.keys((doc!.pricing as Obj).providers as Obj) : []
  for (const id of fileProviders) add(id)
  for (const id of seen) add(id)
  for (const id of Object.keys(BUILTIN_PROVIDERS)) add(id)
  return out
}

export function draftFromDoc(doc: Obj | undefined, providers: readonly string[] = providerIds(doc)): Draft {
  const cur = isObj(doc?.currency) ? (doc!.currency as Obj) : {}
  const dsp = isObj(doc?.display) ? (doc!.display as Obj) : {}
  const pr = isObj(doc?.pricing) ? (doc!.pricing as Obj) : {}
  const fileProviders = isObj(pr.providers) ? (pr.providers as Obj) : {}
  const display = typeof cur.display === 'string' ? cur.display : 'USD'
  const fxMap = isObj(cur.fx) ? (cur.fx as Obj) : {}

  const draftProviders: Record<string, ProviderDraft> = {}
  for (const id of providers) {
    const p = isObj(fileProviders[id]) ? (fileProviders[id] as Obj) : {}
    draftProviders[id] = {
      billing: typeof p.billing === 'string' && (BILLING_MODES as readonly string[]).includes(p.billing) ? (p.billing as BillingMode) : '',
      implicitCacheWrite: typeof p.implicitCacheWrite === 'boolean' ? p.implicitCacheWrite : null,
    }
  }

  const rules: RuleDraft[] = (Array.isArray(pr.models) ? pr.models : []).filter(isObj).map(r => {
    const m = isObj(r.match) ? (r.match as Obj) : {}
    const rate = isObj(r.rate) ? (r.rate as Obj) : {}
    return {
      provider: typeof m.provider === 'string' ? m.provider : '',
      model: typeof m.model === 'string' ? m.model : '',
      input: numText(rate.input), output: numText(rate.output), cacheRead: numText(rate.cacheRead), cacheWrite: numText(rate.cacheWrite5m),
      locked: r.tiers !== undefined || typeof r.currency === 'string',
      base: r,
    }
  })

  return {
    currency: display,
    fx: display === 'USD' ? '' : numText(fxMap[display]),
    fxAsOf: typeof cur.fxAsOf === 'string' ? cur.fxAsOf : '',
    unit: ['auto', 'money', 'kwh', 'tokens'].includes(dsp.unit as string) ? (dsp.unit as DisplayUnit) : 'auto',
    subscriptionValue: dsp.subscriptionValue === 'hide' ? 'hide' : 'show',
    providers: draftProviders,
    rules,
  }
}

/** A typed number stays a number; anything else is passed on as text so the validator reports it with a pointer. */
function parsed(s: string): number | string {
  const t = s.trim()
  if (t !== '' && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t)
  return t
}

function clean(o: Obj): Obj | undefined {
  return Object.keys(o).length === 0 ? undefined : o
}

/** The document with the draft applied. `base` is never mutated. */
export function applyDraft(base: Obj | undefined, d: Draft): Obj {
  const doc: Obj = { ...(base ?? {}) }
  if (doc.schemaVersion === undefined) doc.schemaVersion = 1

  // currency
  const cur: Obj = isObj(doc.currency) ? { ...(doc.currency as Obj) } : {}
  const code = d.currency.trim().toUpperCase()
  if (code === '' || code === 'USD') delete cur.display
  else cur.display = code
  if (code !== '' && code !== 'USD') {
    const fx: Obj = isObj(cur.fx) ? { ...(cur.fx as Obj) } : {}
    if (d.fx.trim() === '') delete fx[code]; else fx[code] = parsed(d.fx)
    if (Object.keys(fx).length > 0) cur.fx = fx; else delete cur.fx
  }
  if (d.fxAsOf.trim() === '') delete cur.fxAsOf; else cur.fxAsOf = d.fxAsOf.trim()
  const curOut = clean(cur)
  if (curOut) doc.currency = curOut; else delete doc.currency

  // display
  const dsp: Obj = isObj(doc.display) ? { ...(doc.display as Obj) } : {}
  if (d.unit === 'auto') delete dsp.unit; else dsp.unit = d.unit
  if (d.subscriptionValue === 'show') delete dsp.subscriptionValue; else dsp.subscriptionValue = d.subscriptionValue
  const dspOut = clean(dsp)
  if (dspOut) doc.display = dspOut; else delete doc.display

  // pricing
  const pr: Obj = isObj(doc.pricing) ? { ...(doc.pricing as Obj) } : {}
  const providers: Obj = isObj(pr.providers) ? { ...(pr.providers as Obj) } : {}
  for (const [id, pd] of Object.entries(d.providers)) {
    if (FORBIDDEN.has(id)) continue
    const p: Obj = isObj(providers[id]) ? { ...(providers[id] as Obj) } : {}
    if (pd.billing === '') delete p.billing; else p.billing = pd.billing
    if (pd.implicitCacheWrite === null) delete p.implicitCacheWrite; else p.implicitCacheWrite = pd.implicitCacheWrite
    const out = clean(p)
    if (out) providers[id] = out; else delete providers[id]
  }
  if (Object.keys(providers).length > 0) pr.providers = providers; else delete pr.providers

  if (d.rules.length > 0 || Array.isArray(pr.models)) {
    pr.models = d.rules.map(r => {
      const match: Obj = isObj(r.base.match) ? { ...(r.base.match as Obj) } : {}
      if (r.provider.trim() === '') delete match.provider; else match.provider = r.provider.trim()
      if (r.model.trim() === '') delete match.model; else match.model = r.model.trim()
      const rule: Obj = { ...r.base, match }
      if (!r.locked) {
        const rate: Obj = {}
        rate.input = parsed(r.input)
        rate.output = parsed(r.output)
        if (r.cacheRead.trim() !== '') rate.cacheRead = parsed(r.cacheRead)
        if (r.cacheWrite.trim() !== '') rate.cacheWrite5m = parsed(r.cacheWrite)
        rule.rate = rate
      }
      return rule
    })
    if ((pr.models as unknown[]).length === 0) delete pr.models
  }
  const prOut = clean(pr)
  if (prOut) doc.pricing = prOut; else delete doc.pricing
  return doc
}

export interface DraftCheck {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** The validator's verdict on a document (the one the loader will apply after the write). */
export function checkDoc(doc: unknown): DraftCheck {
  const r = validateConfig(doc)
  return { ok: r.ok, errors: r.errors, warnings: r.warnings }
}

/** Escape one JSON pointer segment (RFC 6901). */
const seg = (s: string | number) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')

/** Pointers of the drawer's fields, so an issue can be shown next to the field that caused it. */
export const FIELD = {
  currency: '/currency/display',
  fx: (code: string) => `/currency/fx/${seg(code)}`,
  fxAsOf: '/currency/fxAsOf',
  unit: '/display/unit',
  subscriptionValue: '/display/subscriptionValue',
  provider: (id: string, key: 'billing' | 'implicitCacheWrite') => `/pricing/providers/${seg(id)}/${key}`,
  rule: (i: number) => `/pricing/models/${i}`,
  ruleField: (i: number, f: 'provider' | 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite') =>
    f === 'provider' ? `/pricing/models/${i}/match/provider`
      : f === 'model' ? `/pricing/models/${i}/match/model`
        : `/pricing/models/${i}/rate/${f === 'cacheWrite' ? 'cacheWrite5m' : f}`,
} as const

/** Issues at `pointer` or below it. */
export function issuesAt(issues: readonly ValidationIssue[], pointer: string): ValidationIssue[] {
  return issues.filter(i => i.path === pointer || i.path.startsWith(pointer + '/'))
}

/** Issues that no drawer field accounts for (cross-field or in keys the drawer does not edit). */
export function otherIssues(issues: readonly ValidationIssue[], d: Draft): ValidationIssue[] {
  const owned: string[] = [FIELD.currency, FIELD.fxAsOf, FIELD.unit, FIELD.subscriptionValue, `/currency/fx`]
  for (const id of Object.keys(d.providers)) owned.push(FIELD.provider(id, 'billing'), FIELD.provider(id, 'implicitCacheWrite'))
  d.rules.forEach((_, i) => owned.push(FIELD.rule(i)))
  return issues.filter(i => !owned.some(p => i.path === p || i.path.startsWith(p + '/')))
}
